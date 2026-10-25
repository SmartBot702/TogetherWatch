const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { Server } = require('socket.io');
const auth = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const roomSaveTimers = new Map();
function persistRoom(room, immediate = false) {
  if (!room || typeof auth.saveRoomSnapshot !== 'function') return;
  const id = room.id;
  const pending = roomSaveTimers.get(id);
  if (pending) {
    if (!immediate) return;
    clearTimeout(pending);
    roomSaveTimers.delete(id);
  }
  const timer = setTimeout(() => {
    roomSaveTimers.delete(id);
    const current = rooms.get(id);
    if (current) auth.saveRoomSnapshot(current).catch(err => console.error('Room save failed:', err.message));
  }, immediate ? 0 : 3000);
  if (timer.unref) timer.unref();
  roomSaveTimers.set(id, timer);
}
function discardRoom(id) {
  const pending = roomSaveTimers.get(id);
  if (pending) clearTimeout(pending);
  roomSaveTimers.delete(id);
  rooms.delete(id);
  if (typeof auth.deleteRoomSnapshot === 'function') auth.deleteRoomSnapshot(id).catch(err => console.error('Room cleanup failed:', err.message));
}
const roomPersistenceHeartbeat = setInterval(() => {
  for (const room of rooms.values()) if (room.members.size) persistRoom(room);
}, 60 * 1000);
if (roomPersistenceHeartbeat.unref) roomPersistenceHeartbeat.unref();

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'TogetherWatch' }));
app.get('/api/rooms/public', (_req, res) => {
  const publicRooms = Array.from(rooms.values())
    .filter(room => room.isPublic && room.members && room.members.size > 0)
    .map(room => ({ id: room.id, title: room.title || 'Tomosha xonasi', theme: room.theme || 'violet', count: room.members.size, capacity: 20 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);
  res.set('Cache-Control', 'no-store').json({ ok: true, rooms: publicRooms });
});
app.get('/api/rtc-config', (_req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];
  const turnUrls = String(process.env.TURN_URLS || '').split(/[;,\s]+/).filter(url => /^turns?:/i.test(url));
  const username = process.env.TURN_USERNAME || '';
  const credential = process.env.TURN_CREDENTIAL || '';
  if (turnUrls.length && username && credential) iceServers.push({ urls: turnUrls, username, credential });
  res.set('Cache-Control', 'no-store').json({ iceServers, turnConfigured: iceServers.length > 2 });
});

function publicIp(address) {
  if (net.isIP(address) === 4) {
    const p = address.split('.').map(Number), a = p[0], b = p[1];
    if (a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
        (a === 198 && (b === 18 || b === 19))) return false;
    return true;
  }
  if (net.isIP(address) === 6) {
    const ip = address.toLowerCase();
    if (ip.startsWith('::ffff:')) return publicIp(ip.slice(7));
    return ip !== '::' && ip !== '::1' && !/^f[cd]/.test(ip) &&
      !/^fe[89ab]/.test(ip) && !ip.startsWith('ff');
  }
  return false;
}
async function safePublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error('URL noto‘g‘ri.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Faqat ochiq HTTP/HTTPS saytlar qabul qilinadi.');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Mahalliy manzil ruxsat etilmagan.');
  const literal = net.isIP(host);
  const addresses = literal ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(x => !publicIp(x.address))) throw new Error('Bu saytning manzili xavfsiz tekshiruvdan o‘tmadi.');
  return u;
}
async function fetchPageHtml(raw) {
  let current = await safePublicUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(current.href, {
      redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'TogetherWatch-LinkInspector/1.0', accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' }
    });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Sayt qayta yo‘naltirish manzilini bermadi.');
      current = await safePublicUrl(new URL(location, current).href); continue;
    }
    if (!response.ok) throw new Error('Sayt sahifasini o‘qib bo‘lmadi (HTTP ' + response.status + ').');
    const type = response.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) throw new Error('Bu manzil HTML sahifasi emas.');
    const reader = response.body.getReader(), chunks = []; let total = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Sahifa hajmi juda katta.'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { html: new TextDecoder().decode(bytes), pageUrl: current.href };
  }
  throw new Error('Sayt juda ko‘p marta qayta yo‘naltirdi.');
}
function decodeHtml(value) {
  return String(value || '').replace(/&amp;/gi, '&').replace(/&#x2f;/gi, '/').replace(/&#47;/g, '/').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}
function mediaCandidates(html, pageUrl) {
  const found = [];
  const add = raw => {
    if (!raw || typeof raw !== 'string') return;
    const value = decodeHtml(raw.trim()).replace(/\\//g, '/');
    try {
      const u = new URL(value, pageUrl);
      if (['http:', 'https:'].includes(u.protocol) && /\.(mp4|webm|m3u8)$/i.test(u.pathname)) found.push(u.href);
    } catch (_) {}
  };
  const tags = html.match(/<(?:video|source)\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const m = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (m) add(m[1] || m[2] || m[3]);
  }
  const meta = html.match(/<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:video(?::url)?|twitter:player:stream|contentUrl)["'][^>]*>/gi) || [];
  for (const tag of meta) {
    const m = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (m) add(m[1] || m[2] || m[3]);
  }
  const jsonUrls = html.match(/"(?:contentUrl|content_url|videoUrl|video_url)"\s*:\s*"[^"]{1,2048}"/gi) || [];
  for (const item of jsonUrls) { const m = item.match(/:\s*"([^"]+)"/); if (m) add(m[1]); }
  return [...new Set(found)].sort((a,b) => (/\.m3u8$/i.test(b) ? 1 : 0) - (/\.m3u8$/i.test(a) ? 1 : 0));
}
app.get('/api/extract', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const raw = typeof req.query.url === 'string' ? req.query.url.slice(0, 2048) : '';
  if (!raw) return res.status(400).json({ ok: false, error: 'Sayt havolasi kerak.' });
  try {
    const { html, pageUrl } = await fetchPageHtml(raw), candidates = mediaCandidates(html, pageUrl);
    return res.json({ ok: true, pageUrl, mediaUrl: candidates[0] || null, mediaType: candidates[0] && /\.m3u8$/i.test(new URL(candidates[0]).pathname) ? 'hls' : 'file', candidates: candidates.length });
  } catch (err) {
    return res.status(422).json({ ok: false, error: err && err.message ? err.message : 'Sahifadan video havolasini topib bo‘lmadi.' });
  }
});


function makeCode() {
  for (const [id, room] of rooms) {
    if (!room.members.size && room.emptyAt && Date.now() - room.emptyAt > 6 * 60 * 60 * 1000) discardRoom(id);
  }
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from(crypto.randomBytes(6), b => chars[b % chars.length]).join(''); } while (rooms.has(code));
  return code;
}
function cleanName(v) { return typeof v === 'string' ? v.replace(/[<>]/g, '').trim().slice(0, 24) : ''; }
function cleanRoomTitle(v) { return typeof v === 'string' ? v.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) : ''; }
function cleanRoomTheme(v) { return ['violet','ocean','sunset','emerald'].includes(v) ? v : 'violet'; }
function validVideoId(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v); }
function emptyState() {
  return { mediaType: null, mediaId: null, mediaUrl: null, videoId: null, isPlaying: false, currentTime: 0, updatedAt: Date.now() };
}
function normalizeMedia(p) {
  if (!p || typeof p !== 'object') return null;
  const type = p.mediaType || (p.videoId ? 'youtube' : '');
  if (type === 'youtube') {
    const id = p.mediaId || p.videoId;
    if (!validVideoId(id)) return null;
    return { mediaType: 'youtube', mediaId: id, mediaUrl: 'https://www.youtube.com/watch?v=' + id, videoId: id };
  }
  if (type === 'vimeo') {
    const id = String(p.mediaId || '');
    if (!/^\d{1,15}$/.test(id)) return null;
    return { mediaType: 'vimeo', mediaId: id, mediaUrl: 'https://player.vimeo.com/video/' + id, videoId: null };
  }
  if (type === 'file' || type === 'hls') {
    const raw = typeof p.mediaUrl === 'string' ? p.mediaUrl.slice(0, 2048) : '';
    try {
      const u = new URL(raw);
      const okPath = type === 'hls' ? /\.m3u8$/i.test(u.pathname) : /\.(mp4|webm)$/i.test(u.pathname);
      if (!['http:', 'https:'].includes(u.protocol) || !okPath) return null;
      return { mediaType: type, mediaId: raw, mediaUrl: raw, videoId: null };
    } catch (_) { return null; }
  }
  return null;
}
function error(socket, message) { socket.emit('room:error', message); }
function people(room) { return Array.from(room.members.values()).map(m => ({ id: m.id, name: m.name, isHost: m.id === room.hostId })); }
function broadcastPeople(id) { const r = rooms.get(id); if (r) io.to(id).emit('room:people', people(r)); }
function leave(socket) {
  const id = socket.data.roomId;
  if (!id) return;
  const r = rooms.get(id);
  socket.leave(id);
  socket.data.roomId = null;
  if (!r) return;
  const m = r.members.get(socket.id);
  io.to(id).emit('rtc:ready', { from: socket.id, ready: false });
  if (r.callReady) r.callReady.delete(socket.id);
  if (r.screenOwner === socket.id) { r.screenOwner = null; io.to(id).emit('screen:stop', { from: socket.id }); }
  r.members.delete(socket.id);
  if (m) io.to(id).emit('room:system', m.name + ' xonadan chiqdi.');
  if (r.hostId === socket.id) {
    const next = r.members.keys().next();
    if (!next.done) {
      r.hostId = next.value;
      const host = r.members.get(r.hostId);
      io.to(id).emit('room:system', host.name + ' endi xona egasi.');
      const s = io.sockets.sockets.get(r.hostId);
      if (s) s.emit('room:role', { isHost: true });
    }
  }
  if (!r.members.size) { r.emptyAt = Date.now(); persistRoom(r, true); }
  else { broadcastPeople(id); persistRoom(r); }
}
function enter(socket, id, name, create, options = {}) {
  if (!name) return error(socket, 'Ismingizni kiriting.');
  let r = rooms.get(id);
  if (r && !r.members.size && r.emptyAt && Date.now() - r.emptyAt > 6 * 60 * 60 * 1000) { discardRoom(id); r = null; }
  if (!r && create) { r = { id, hostId: socket.id, members: new Map(), callReady: new Set(), state: emptyState(), queue: [], messages: [], siteUrl: null, siteExpanded: false, screenOwner: null, title: cleanRoomTitle(options.title) || 'Tomosha xonasi', theme: cleanRoomTheme(options.theme), isPublic: Boolean(options.isPublic), game: { board: Array(9).fill(null), turn: 'X', winner: null, moves: 0 } }; rooms.set(id, r); }
  if (!r.title) r.title = 'Tomosha xonasi';
  if (!r.theme) r.theme = 'violet';
  if (r && !Array.isArray(r.messages)) r.messages = [];
  if (!r) return error(socket, 'Xona topilmadi. Kodni tekshiring.');
  if (r.members.size >= 20) return error(socket, 'Xona to‘la (maksimal 20 kishi).');
  if (Array.from(r.members.values()).some(m => m.name.toLowerCase() === name.toLowerCase())) return error(socket, 'Bu ism allaqachon ishlatilmoqda.');
  if (!r.hostId || !r.members.has(r.hostId)) r.hostId = socket.id;
  r.emptyAt = null;
  socket.join(id);
  socket.data.roomId = id;
  socket.data.name = name;
  r.members.set(socket.id, { id: socket.id, name });
  socket.emit('room:joined', { roomId: id, isHost: r.hostId === socket.id, title: r.title, theme: r.theme, state: r.state, queue: r.queue || [], chatHistory: r.messages.slice(-100), siteUrl: r.siteUrl, siteExpanded: r.siteExpanded, screenOwner: r.screenOwner, isPublic: Boolean(r.isPublic), game: r.game || { board: Array(9).fill(null), turn: 'X', winner: null, moves: 0 } });
  for (const file of (r.files || [])) socket.emit('file:shared', file);
  for (const link of (r.links || [])) socket.emit('link:shared', link);
  for (const memberId of (r.callReady || [])) if (memberId !== socket.id) socket.emit('rtc:ready', { from: memberId, ready: true });
  socket.to(id).emit('room:system', name + ' xonaga qo‘shildi.');
  broadcastPeople(id);
  persistRoom(r);
}
io.on('connection', socket => {
  socket.on('room:create', p => {
    leave(socket);
    const n = cleanName(p && p.name);
    if (!n) return error(socket, 'Ismingizni kiriting.');
    let id;
    do { id = makeCode(); } while (rooms.has(id));
    enter(socket, id, n, true, { title: cleanRoomTitle(p && p.title), theme: cleanRoomTheme(p && p.theme), isPublic: Boolean(p && p.isPublic) });
  });
  socket.on('room:join', p => {
    leave(socket);
    const id = String(p && p.roomId || '').toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(id)) return error(socket, 'Xona kodi noto‘g‘ri.');
    enter(socket, id, cleanName(p && p.name), false);
  });
  socket.on('room:settings', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id) || r.hostId !== socket.id) return error(socket, 'Xona sozlamalarini faqat xona egasi o‘zgartira oladi.');
    const title = cleanRoomTitle(p && p.title);
    if (!title) return error(socket, 'Xona nomi bo‘sh bo‘lmasligi kerak.');
    r.title = title;
    r.theme = cleanRoomTheme(p && p.theme);
    if (typeof (p && p.isPublic) === 'boolean') r.isPublic = p.isPublic;
    io.to(id).emit('room:settings', { title: r.title, theme: r.theme, isPublic: Boolean(r.isPublic), by: socket.data.name });
    persistRoom(r, true);
  });

  socket.on('game:move', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id) || !p || !Number.isInteger(p.index) || p.index < 0 || p.index > 8) return;
    if (!r.game) r.game = { board: Array(9).fill(null), turn: 'X', winner: null, moves: 0 };
    const g = r.game;
    if (g.winner || g.board[p.index] || g.moves >= 9) return socket.emit('game:error', 'Bu yurish mumkin emas.');
    const mark = g.turn;
    g.board[p.index] = mark; g.moves++;
    const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    if (wins.some(line => line.every(i => g.board[i] === mark))) g.winner = mark;
    else if (g.moves === 9) g.winner = 'draw';
    else g.turn = mark === 'X' ? 'O' : 'X';
    io.to(id).emit('game:state', g);
    persistRoom(r);
  });
  socket.on('game:reset', () => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id)) return;
    r.game = { board: Array(9).fill(null), turn: 'X', winner: null, moves: 0 };
    io.to(id).emit('game:state', r.game);
    persistRoom(r);
  });



  socket.on('link:add', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id) || !p || typeof p.url !== 'string') return;
    let url;
    try {
      url = new URL(p.url.slice(0, 2048));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid');
    } catch (_) { return error(socket, 'Havola to‘liq http:// yoki https:// manzil bo‘lishi kerak.'); }
    if (!Array.isArray(r.links)) r.links = [];
    if (r.links.length >= 30) return error(socket, 'Xonada ko‘pi bilan 30 ta havola saqlanadi.');
    if (r.links.some(link => link.url === url.href)) return error(socket, 'Bu havola allaqachon ro‘yxatda bor.');
    const title = typeof p.title === 'string' ? p.title.replace(/[<>]/g, '').replace(/\\s+/g, ' ').trim().slice(0, 80) : '';
    const link = { id: crypto.randomBytes(10).toString('hex'), title: title || url.hostname, url: url.href, by: socket.data.name, at: Date.now() };
    r.links.push(link);
    io.to(id).emit('link:shared', link);
    persistRoom(r);
  });
  socket.on('link:remove', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id) || !p || typeof p.id !== 'string') return;
    const link = (r.links || []).find(item => item.id === p.id);
    if (!link) return;
    if (r.hostId !== socket.id && link.by !== socket.data.name) return error(socket, 'Faqat havolani yuborgan odam yoki xona egasi o‘chira oladi.');
    r.links = r.links.filter(item => item.id !== p.id);
    io.to(id).emit('link:removed', { id: p.id });
    persistRoom(r);
  });

  socket.on('file:share', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id) || !p || typeof p.name !== 'string' || typeof p.data !== 'string') return;
    const name = path.basename(p.name).replace(/[^\p{L}\p{N}._ -]/gu, '').trim().slice(0, 100);
    const ext = path.extname(name).toLowerCase();
    const mimeByExt = { '.pdf':'application/pdf', '.txt':'text/plain', '.md':'text/markdown', '.csv':'text/csv', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.mp3':'audio/mpeg', '.mp4':'video/mp4', '.webm':'video/webm' };
    if (!name || !mimeByExt[ext]) return error(socket, 'Bu fayl turi qo‘llab-quvvatlanmaydi. PDF, TXT, MD, CSV, rasm, MP3, MP4 yoki WebM yuboring.');
    const match = p.data.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
    if (!match || match[2].length > 620000) return error(socket, 'Fayl 450 KB dan kichik bo‘lishi va to‘g‘ri formatda bo‘lishi kerak.');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 450 * 1024) return error(socket, 'Fayl hajmi 450 KB dan oshmasin.');
    const mime = mimeByExt[ext];
    if (match[1].toLowerCase() !== mime && !(ext === '.md' && match[1].toLowerCase() === 'text/plain')) return error(socket, 'Fayl turi va kengaytmasi mos kelmaydi.');
    if (!Array.isArray(r.files)) r.files = [];
    const total = r.files.reduce((sum, f) => sum + f.size, 0);
    if (r.files.length >= 5 || total + bytes.length > 1300 * 1024) return error(socket, 'Xonada 5 ta fayl yoki jami 1.3 MB limitiga yetildi.');
    const file = { id: crypto.randomBytes(10).toString('hex'), name, mime, size: bytes.length, data: p.data, by: socket.data.name, at: Date.now() };
    r.files.push(file);
    io.to(id).emit('file:shared', file);
  });

  socket.on('room:leave', () => leave(socket));
  socket.on('chat:typing', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id)) return;
    socket.to(id).emit('chat:typing', { from: socket.id, name: socket.data.name, typing: Boolean(p && p.typing) });
  });
  socket.on('chat:send', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    const text = typeof (p && p.text) === 'string' ? p.text.trim().slice(0, 500) : '';
    if (r && r.members.has(socket.id) && text) {
      const message = { name: socket.data.name, text, at: Date.now() };
      if (!Array.isArray(r.messages)) r.messages = [];
      r.messages.push(message);
      if (r.messages.length > 100) r.messages.splice(0, r.messages.length - 100);
      io.to(id).emit('chat:message', message);
      persistRoom(r);
    }
  });
  socket.on('queue:add', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id)) return error(socket, 'Avval tomosha xonasiga kiring.');
    const media = normalizeMedia(p);
    if (!media) return error(socket, 'Navbatga YouTube, Vimeo, MP4/WebM yoki HLS havolasini qo‘shing.');
    r.queue = r.queue || [];
    if (r.queue.length >= 50) return error(socket, 'Video navbati 50 ta bilan cheklangan.');
    r.queue.push({ ...media, queueId: crypto.randomBytes(8).toString('hex'), addedBy: socket.data.name });
    io.to(id).emit('queue:updated', r.queue);
    persistRoom(r);
  });
  socket.on('queue:remove', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id) || !p || typeof p.queueId !== 'string') return;
    r.queue = (r.queue || []).filter(item => item.queueId !== p.queueId);
    io.to(id).emit('queue:updated', r.queue);
    persistRoom(r);
  });
  socket.on('queue:next', () => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || r.hostId !== socket.id || !r.queue || !r.queue.length) return;
    const item = r.queue.shift();
    const { queueId, addedBy, ...media } = item;
    r.state = { ...media, isPlaying: false, currentTime: 0, updatedAt: Date.now() };
    io.to(id).emit('video:loaded', r.state);
    io.to(id).emit('queue:updated', r.queue);
    persistRoom(r);
  });
  socket.on('queue:play', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id) || !p || typeof p.queueId !== 'string') return;
    const item = (r.queue || []).find(entry => entry.queueId === p.queueId);
    if (!item) return;
    r.queue = r.queue.filter(entry => entry.queueId !== p.queueId);
    const { queueId, addedBy, ...media } = item;
    r.state = { ...media, isPlaying: false, currentTime: 0, updatedAt: Date.now() };
    io.to(id).emit('video:loaded', r.state);
    io.to(id).emit('queue:updated', r.queue);
    persistRoom(r);
  });
  socket.on('video:load', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id)) return error(socket, 'Avval tomosha xonasiga kiring.');
    const media = normalizeMedia(p);
    if (!media) return error(socket, 'YouTube, Vimeo yoki to‘g‘ridan-to‘g‘ri MP4/WebM havolasini kiriting.');
    r.state = { ...media, isPlaying: false, currentTime: 0, updatedAt: Date.now() };
    io.to(id).emit('video:loaded', r.state);
    persistRoom(r);
  });
  function playback(p) {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id) || !r.state.mediaType || !p) return;
    const type = p.mediaType || (p.videoId ? 'youtube' : '');
    const idValue = p.mediaId || p.videoId || p.mediaUrl;
    const expected = r.state.mediaId || r.state.mediaUrl;
    if (type !== r.state.mediaType || idValue !== expected) return;
    const t = Number(p.currentTime);
    if (!Number.isFinite(t) || t < 0 || t > 86400) return;
    r.state = { ...r.state, isPlaying: Boolean(p.isPlaying), currentTime: t, updatedAt: Date.now() };
    socket.to(id).emit('video:state', r.state);
    persistRoom(r);
  }
  socket.on('video:state', playback);
  socket.on('video:heartbeat', playback);

  socket.on('site:share', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id) || !p || typeof p.url !== 'string') return;
    try {
      const u = new URL(p.url.slice(0, 2048));
      if (!['http:', 'https:'].includes(u.protocol)) return error(socket, 'Faqat http yoki https sayt havolasi mumkin.');
      r.siteUrl = u.href; r.siteExpanded = false;
      io.to(id).emit('site:shared', { url: r.siteUrl, expanded: false, by: socket.data.name });
      persistRoom(r);
    } catch (_) { error(socket, 'Sayt havolasi noto‘g‘ri.'); }
  });
  socket.on('site:expand', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id) || !r.siteUrl) return;
    r.siteExpanded = Boolean(p && p.expanded);
    io.to(id).emit('site:shared', { url: r.siteUrl, expanded: r.siteExpanded, by: socket.data.name });
    persistRoom(r);
  });
  socket.on('screen:started', () => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id)) return;
    if (r.screenOwner && r.screenOwner !== socket.id) return socket.emit('screen:error', 'Boshqa ishtirokchi hozir ekran ulashyapti.');
    r.screenOwner = socket.id;
    io.to(id).emit('screen:started', { from: socket.id, name: socket.data.name });
  });
  socket.on('rtc:offer', p => {
    const id = socket.data.roomId, r = rooms.get(id), to = p && p.to;
    if (!r || !r.members.has(socket.id) || !r.members.has(to) || !p.offer) return;
    io.to(to).emit('rtc:offer', { from: socket.id, kind: p.kind === 'call' ? 'call' : 'screen', offer: p.offer });
  });
  socket.on('rtc:answer', p => {
    const id = socket.data.roomId, r = rooms.get(id), to = p && p.to;
    if (!r || !r.members.has(socket.id) || !r.members.has(to) || !p.answer) return;
    io.to(to).emit('rtc:answer', { from: socket.id, kind: p.kind === 'call' ? 'call' : 'screen', answer: p.answer });
  });
  socket.on('rtc:ice', p => {
    const id = socket.data.roomId, r = rooms.get(id), to = p && p.to;
    if (!r || !r.members.has(socket.id) || !r.members.has(to) || !p.candidate) return;
    io.to(to).emit('rtc:ice', { from: socket.id, kind: p.kind === 'call' ? 'call' : 'screen', candidate: p.candidate });
  });
  socket.on('rtc:ready', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (r && r.members.has(socket.id)) {
      if (!r.callReady) r.callReady = new Set();
      if (p && p.ready) r.callReady.add(socket.id); else r.callReady.delete(socket.id);
      socket.to(id).emit('rtc:ready', { from: socket.id, ready: Boolean(p && p.ready) });
    }
  });
  socket.on('screen:stop', () => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (r && r.members.has(socket.id) && r.screenOwner === socket.id) {
      r.screenOwner = null;
      socket.to(id).emit('screen:stop', { from: socket.id });
    }
  });

  socket.on('disconnect', () => leave(socket));
});
auth.attach(app, io).then(async () => {
  const savedRooms = await auth.loadRoomSnapshots();
  for (const saved of savedRooms) {
    const payload = saved.payload || {};
    const room = {
      id: saved.id, hostId: null, members: new Map(), callReady: new Set(),
      state: payload.state || emptyState(), queue: Array.isArray(payload.queue) ? payload.queue : [],
      messages: Array.isArray(payload.messages) ? payload.messages.slice(-100) : [],
      siteUrl: payload.siteUrl || null, siteExpanded: Boolean(payload.siteExpanded),
      title: typeof payload.title === 'string' ? payload.title : 'Tomosha xonasi', theme: cleanRoomTheme(payload.theme),
      screenOwner: null, files: [], links: Array.isArray(payload.links) ? payload.links.slice(0, 30) : [], isPublic: Boolean(payload.isPublic), emptyAt: saved.emptyAt || Date.now()
    };
    rooms.set(room.id, room);
    persistRoom(room, true);
  }
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  server.listen(PORT, '0.0.0.0', () => console.log('TogetherWatch listening on ' + PORT + ' (restored ' + savedRooms.length + ' rooms)'));
}).catch(err => { console.error('Account API initialization failed:', err); process.exit(1); });
