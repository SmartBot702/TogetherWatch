const express = require('express');
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
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
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '.data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const MAX_VIDEO_UPLOAD_BYTES = Math.max(1, Number(process.env.MAX_VIDEO_UPLOAD_MB) || 4096) * 1024 * 1024;
const MAX_ROOM_VIDEO_BYTES = Math.max(1, Number(process.env.MAX_ROOM_VIDEO_GB) || 12) * 1024 * 1024 * 1024;
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4v': 'video/mp4', '.ogv': 'video/ogg' };
const VIDEO_CHUNK_BYTES = 256 * 1024;
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
app.get('/media/:filename', async (req, res) => {
  const filename = String(req.params.filename || '');
  if (!/^[a-f0-9]{32}\\.(?:mp4|webm|m4v|ogv)$/.test(filename)) return res.sendStatus(404);
  const filePath = path.join(UPLOADS_DIR, filename);
  let stat;
  try { stat = await fsp.stat(filePath); } catch (_) { return res.sendStatus(404); }
  if (!stat.isFile()) return res.sendStatus(404);
  const ext = path.extname(filename).toLowerCase();
  const headers = {
    'Content-Type': VIDEO_TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff'
  };
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\\d*)-(\\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return res.status(416).set('Content-Range', 'bytes */' + stat.size).end();
    let start, end;
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return res.status(416).set('Content-Range', 'bytes */' + stat.size).end();
      start = Math.max(0, stat.size - suffix); end = stat.size - 1;
    } else {
      start = Number(match[1]); end = match[2] ? Number(match[2]) : stat.size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= stat.size || end < start) {
      return res.status(416).set('Content-Range', 'bytes */' + stat.size).end();
    }
    end = Math.min(end, stat.size - 1);
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
    fs.createReadStream(filePath, { start, end }).on('error', () => res.destroy()).pipe(res);
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
});

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
async function validateMediaSource(p) {
  if (!p || typeof p !== 'object') return;
  const type = p.mediaType || (p.videoId ? 'youtube' : '');
  if (type === 'uploaded') return;
  if (type !== 'file' && type !== 'hls') return;
  const raw = typeof p.mediaUrl === 'string' ? p.mediaUrl.slice(0, 2048) : '';
  // Shared media URLs are fetched by every viewer's browser, so refuse loopback,
  // private-network and DNS names resolving to non-public addresses.
  await safePublicUrl(raw);
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
    let mediaUrl = 'https://player.vimeo.com/video/' + id;
    try { const source = new URL(p.mediaUrl); const hash = source.searchParams.get('h') || ''; if (source.hostname === 'player.vimeo.com' && source.pathname === '/video/' + id && /^[A-Za-z0-9]{1,64}$/.test(hash)) mediaUrl += '?h=' + encodeURIComponent(hash); } catch (_) {}
    return { mediaType: 'vimeo', mediaId: id, mediaUrl, videoId: null };
  }
  if (type === 'vk') {
    const id = String(p.mediaId || '');
    const match = id.match(/^(-?\d{1,15})_(\d{1,20})$/);
    if (!match) return null;
    let hash = '';
    try { const source = new URL(p.mediaUrl); hash = source.searchParams.get('hash') || ''; } catch (_) {}
    if (hash && !/^[A-Za-z0-9_-]{1,128}$/.test(hash)) hash = '';
    const mediaUrl = 'https://vk.com/video_ext.php?oid=' + encodeURIComponent(match[1]) + '&id=' + encodeURIComponent(match[2]) + (hash ? '&hash=' + encodeURIComponent(hash) : '');
    return { mediaType: 'vk', mediaId: id, mediaUrl, videoId: null };
  }
  if (type === 'ok') {
    const id = String(p.mediaId || '');
    if (!/^\d{1,24}$/.test(id)) return null;
    return { mediaType: 'ok', mediaId: id, mediaUrl: 'https://ok.ru/videoembed/' + id, videoId: null };
  }
  if (type === 'rutube') {
    const id = String(p.mediaId || '');
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return null;
    return { mediaType: 'rutube', mediaId: id, mediaUrl: 'https://rutube.ru/play/embed/' + id, videoId: null };
  }
  if (type === 'uploaded') {
    const id = String(p.mediaId || '');
    const ext = String(p.ext || '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(id) || !['mp4','webm','m4v','ogv'].includes(ext)) return null;
    const url = '/media/' + id + '.' + ext;
    return { mediaType: 'file', mediaId: url, mediaUrl: url, videoId: null };
  }
  if (type === 'local') {
    const id = String(p.mediaId || '');
    if (!/^local-[a-f0-9]{16}$/.test(id)) return null;
    return { mediaType: 'local', mediaId: id, mediaUrl: 'local://' + id, videoId: null };
  }
  if (type === 'file' || type === 'hls') {
    const raw = typeof p.mediaUrl === 'string' ? p.mediaUrl.slice(0, 2048) : '';
    try {
      const u = new URL(raw);
      const okPath = type === 'hls' ? /\.m3u8$/i.test(u.pathname) : true;
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
  if (socket.data.movieUpload) {
    const upload = socket.data.movieUpload; socket.data.movieUpload = null;
    Promise.resolve(upload.handle.close()).catch(() => {}).then(() => fsp.unlink(upload.filePath).catch(() => {}));
  }
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
  if (!r.members.size) { r.emptyAt = Date.now(); closeSharedBrowser(r).catch(() => {}); persistRoom(r, true); }
  else { broadcastPeople(id); persistRoom(r); }
}
function enter(socket, id, name, create, options = {}) {
  if (!name) return error(socket, 'Ismingizni kiriting.');
  let r = rooms.get(id);
  if (r && !r.members.size && r.emptyAt && Date.now() - r.emptyAt > 6 * 60 * 60 * 1000) { discardRoom(id); r = null; }
  if (!r && create) { r = { id, hostId: socket.id, members: new Map(), callReady: new Set(), state: emptyState(), queue: [], messages: [], siteUrl: null, siteExpanded: false, screenOwner: null, browserSession: null, activeActivity: 'video', title: cleanRoomTitle(options.title) || 'Tomosha xonasi', theme: cleanRoomTheme(options.theme), isPublic: Boolean(options.isPublic), game: { board: Array(9).fill(null), turn: 'X', winner: null, moves: 0 }, activeGame: 'tictactoe', connectFour: { board: Array.from({length:6},()=>Array(7).fill(null)), turn: 'R', winner: null, moves: 0 }, boardStrokes: [] }; rooms.set(id, r); }
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
  socket.emit('room:joined', { roomId: id, isHost: r.hostId === socket.id, title: r.title, theme: r.theme, state: r.state, queue: r.queue || [], chatHistory: r.messages.slice(-100), videos: Array.isArray(r.videos) ? r.videos : [], siteUrl: r.siteUrl, siteExpanded: r.siteExpanded, screenOwner: r.screenOwner, isPublic: Boolean(r.isPublic), activeActivity: r.activeActivity || 'video', activeGame: r.activeGame || 'tictactoe', game: r.game || { board: Array(9).fill(null), turn: 'X', winner: null, moves: 0 }, connectFour: r.connectFour || { board: Array.from({length:6},()=>Array(7).fill(null)), turn: 'R', winner: null, moves: 0 } });
  for (const file of (r.files || [])) socket.emit('file:shared', file);
  for (const link of (r.links || [])) socket.emit('link:shared', link);
  socket.emit('board:history', Array.isArray(r.boardStrokes) ? r.boardStrokes.slice(-2000) : []);
  if (r.browserSession) { socket.emit('browser:started', { url: r.browserSession.page.url() }); captureSharedBrowser(r, r.browserSession).catch(() => {}); }
  for (const memberId of (r.callReady || [])) if (memberId !== socket.id) socket.emit('rtc:ready', { from: memberId, ready: true });
  socket.to(id).emit('room:system', name + ' xonaga qo‘shildi.');
  broadcastPeople(id);
  persistRoom(r);
}

const { chromium } = require('playwright-core');
const BROWSER_VIEWPORT = { width: 1280, height: 800 };
async function closeSharedBrowser(room) {
  const session = room && room.browserSession;
  if (!session) return;
  room.browserSession = null;
  if (session.timer) clearInterval(session.timer);
  try { await session.context.close(); } catch (_) {}
  try { await session.browser.close(); } catch (_) {}
  if (room.members && room.members.size) io.to(room.id).emit('browser:closed');
}
async function captureSharedBrowser(room, session) {
  if (!room || room.browserSession !== session || session.capturing || session.page.isClosed()) return;
  session.capturing = true;
  try {
    const image = await session.page.screenshot({ type: 'jpeg', quality: 48, animations: 'disabled', timeout: 5000 });
    if (room.browserSession === session && room.members.size) io.to(room.id).emit('browser:frame', { data: 'data:image/jpeg;base64,' + image.toString('base64'), url: session.page.url(), at: Date.now() });
  } catch (err) {
    if (room.browserSession === session) io.to(room.id).emit('browser:error', { message: 'Brauzer tasvirini olishda xatolik yuz berdi.' });
  } finally { session.capturing = false; }
}
async function openSharedBrowser(room, rawUrl) {
  const endpoint = process.env.BROWSER_WS_ENDPOINT;
  if (!endpoint) throw new Error('Umumiy brauzer xizmati sozlanmagan. BROWSER_WS_ENDPOINT ni kiriting va browser-service ni ishga tushiring.');
  const url = await safePublicUrl(rawUrl);
  if (!room.browserSession) {
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
    try {
      const context = await browser.newContext({ viewport: BROWSER_VIEWPORT, deviceScaleFactor: 1, acceptDownloads: false, ignoreHTTPSErrors: false });
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(25000);
      page.setDefaultTimeout(10000);
      await page.route('**/*', async route => {
        const requestUrl = route.request().url();
        if (/^(about:|data:|blob:|chrome:)/i.test(requestUrl)) return route.continue();
        try {
          const parsed = new URL(requestUrl);
          if (!['http:', 'https:'].includes(parsed.protocol)) return route.abort();
          await safePublicUrl(parsed.href);
          return route.continue();
        } catch (_) { return route.abort('blockedbyclient'); }
      });
      const session = { browser, context, page, timer: null, capturing: false, lastInputAt: 0, inputChain: Promise.resolve() };
      room.browserSession = session;
      page.on('close', () => { if (room.browserSession === session) closeSharedBrowser(room).catch(() => {}); });
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame() && room.browserSession === session) {
          io.to(room.id).emit('browser:navigated', { url: frame.url() });
        }
      });
      session.timer = setInterval(() => captureSharedBrowser(room, session), 1000);
      if (session.timer.unref) session.timer.unref();
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await captureSharedBrowser(room, session);
      io.to(room.id).emit('browser:started', { url: page.url() });
      return session;
    } catch (err) {
      try { await browser.close(); } catch (_) {}
      room.browserSession = null;
      throw err;
    }
  }
  const session = room.browserSession;
  await session.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await captureSharedBrowser(room, session);
  io.to(room.id).emit('browser:started', { url: session.page.url() });
  return session;
}
function browserInput(room, socket, payload) {
  const session = room && room.browserSession;
  if (!session || !room.members.has(socket.id) || !payload || typeof payload.type !== 'string') return;
  const now = Date.now();
  if (now - (socket.data.lastBrowserInputAt || 0) < 12) return;
  socket.data.lastBrowserInputAt = now;
  const p = payload;
  session.inputChain = session.inputChain.then(async () => {
    if (room.browserSession !== session || session.page.isClosed()) return;
    if (p.type === 'move' || p.type === 'down' || p.type === 'up' || p.type === 'click') {
      const x = Number(p.x), y = Number(p.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > BROWSER_VIEWPORT.width || y > BROWSER_VIEWPORT.height) return;
      if (p.type === 'move') await session.page.mouse.move(x, y);
      else if (p.type === 'down') { await session.page.mouse.move(x, y); await session.page.mouse.down({ button: p.button === 'right' ? 'right' : 'left' }); }
      else if (p.type === 'up') { await session.page.mouse.move(x, y); await session.page.mouse.up({ button: p.button === 'right' ? 'right' : 'left' }); }
      else await session.page.mouse.click(x, y, { button: p.button === 'right' ? 'right' : 'left' });
    } else if (p.type === 'wheel') {
      const dx = Number(p.dx), dy = Number(p.dy);
      if (Number.isFinite(dx) && Number.isFinite(dy)) await session.page.mouse.wheel(Math.max(-900, Math.min(900, dx)), Math.max(-1200, Math.min(1200, dy)));
    } else if (p.type === 'key') {
      const key = typeof p.key === 'string' ? p.key.slice(0, 32) : '';
      if (!key) return;
      if (key.length === 1 && !p.ctrl && !p.alt && !p.meta) await session.page.keyboard.insertText(key);
      else if (['Backspace','Enter','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Delete','Home','End','PageUp','PageDown',' ','Shift','Control','Alt','Meta'].includes(key)) await session.page.keyboard.press(key);
      else if (key.length === 1) {
        for (const [flag, modifier] of [['ctrl','Control'],['alt','Alt'],['shift','Shift'],['meta','Meta']]) if (p[flag]) await session.page.keyboard.down(modifier);
        await session.page.keyboard.press(key);
        for (const [flag, modifier] of [['meta','Meta'],['shift','Shift'],['alt','Alt'],['ctrl','Control']]) if (p[flag]) await session.page.keyboard.up(modifier);
      }
    } else if (p.type === 'text') {
      const value = typeof p.text === 'string' ? p.text.slice(0, 2000) : '';
      if (value) await session.page.keyboard.insertText(value);
    } else if (p.type === 'navigate' && typeof p.url === 'string') {
      const url = await safePublicUrl(p.url.slice(0, 2048));
      await session.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } else if (p.type === 'back') await session.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    else if (p.type === 'forward') await session.page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    else if (p.type === 'reload') await session.page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    if (p.type !== 'move') await captureSharedBrowser(room, session);
  }).catch(err => {
    if (room.browserSession === session) socket.emit('browser:error', { message: err && /timeout/i.test(err.message) ? 'Sahifa javob bermadi yoki yuklanish vaqti tugadi.' : 'Umumiy brauzer amali bajarilmadi.' });
  });
}

io.on('connection', socket => {
  socket.on('room:create', p => {
    const n = cleanName(p && p.name);
    if (!n) return error(socket, 'Ismingizni kiriting.');
    // Validate first so a malformed create request cannot eject a user from their current room.
    leave(socket);
    let id;
    do { id = makeCode(); } while (rooms.has(id));
    enter(socket, id, n, true, { title: cleanRoomTitle(p && p.title), theme: cleanRoomTheme(p && p.theme), isPublic: Boolean(p && p.isPublic) });
  });
  socket.on('room:join', p => {
    const id = String(p && p.roomId || '').toUpperCase();
    const n = cleanName(p && p.name);
    if (!/^[A-Z0-9]{6}$/.test(id)) return error(socket, 'Xona kodi noto‘g‘ri.');
    if (!n) return error(socket, 'Ismingizni kiriting.');
    let target = rooms.get(id);
    if (target && !target.members.size && target.emptyAt && Date.now() - target.emptyAt > 6 * 60 * 60 * 1000) {
      discardRoom(id);
      target = null;
    }
    // A failed room switch must leave the current room untouched.
    if (!target) return error(socket, 'Xona topilmadi. Kodni tekshiring.');
    const alreadyThere = target.members.has(socket.id);
    if (target.members.size - (alreadyThere ? 1 : 0) >= 20) return error(socket, 'Xona to‘la (maksimal 20 kishi).');
    if (Array.from(target.members.values()).some(m => m.id !== socket.id && m.name.toLowerCase() === n.toLowerCase())) {
      return error(socket, 'Bu ism allaqachon ishlatilmoqda.');
    }
    leave(socket);
    enter(socket, id, n, false);
  });

  socket.on('activity:launch', p => {
    const id = socket.data.roomId, room = rooms.get(id);
    const allowed = new Set(['video','site','games','board','files','screen','call','people']);
    const activity = p && typeof p.activity === 'string' ? p.activity : '';
    if (!room || !room.members.has(socket.id) || !allowed.has(activity)) return;
    room.activeActivity = activity;
    io.to(id).emit('activity:launched', { activity, by: socket.data.name });
    persistRoom(room);
  });

  socket.on('browser:start', async p => {
    const id = socket.data.roomId, room = rooms.get(id);
    if (!room || !room.members.has(socket.id)) return error(socket, 'Avval xonaga kiring.');
    const raw = typeof (p && p.url) === 'string' ? p.url.slice(0, 2048).trim() : '';
    if (!raw) return socket.emit('browser:error', { message: 'Sayt manzilini kiriting.' });
    if (room.browserStarting) return socket.emit('browser:error', { message: 'Umumiy brauzer ishga tushmoqda, biroz kuting.' });
    room.browserStarting = true;
    try {
      const session = await openSharedBrowser(room, raw);
      socket.emit('browser:started', { url: session.page.url() });
    } catch (err) {
      socket.emit('browser:error', { message: err && err.message ? err.message.slice(0, 240) : 'Umumiy brauzer ishga tushmadi.' });
    } finally { room.browserStarting = false; }
  });
  socket.on('browser:input', p => {
    const id = socket.data.roomId, room = rooms.get(id);
    if (room) browserInput(room, socket, p);
  });
  socket.on('browser:navigate', p => {
    const id = socket.data.roomId, room = rooms.get(id);
    if (!room || !room.members.has(socket.id)) return;
    browserInput(room, socket, { type: 'navigate', url: p && p.url });
  });
  socket.on('browser:back', () => { const id=socket.data.roomId, room=rooms.get(id); if(room&&room.members.has(socket.id)) browserInput(room,socket,{type:'back'}); });
  socket.on('browser:forward', () => { const id=socket.data.roomId, room=rooms.get(id); if(room&&room.members.has(socket.id)) browserInput(room,socket,{type:'forward'}); });
  socket.on('browser:reload', () => { const id=socket.data.roomId, room=rooms.get(id); if(room&&room.members.has(socket.id)) browserInput(room,socket,{type:'reload'}); });

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


  socket.on('board:stroke', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id) || !p || !['#ffffff','#c4b5fd','#f0abfc','#67d9ff','#6ee7b7','#fb923c','#f87171','#111827'].includes(p.color)) return;
    const values = [p.x0,p.y0,p.x1,p.y1,p.width].map(Number);
    if (!values.every(Number.isFinite) || values.slice(0,4).some(v => v < 0 || v > 1) || values[4] < 1 || values[4] > 16) return;
    const now = Date.now();
    if (now - (socket.data.lastBoardStrokeAt || 0) < 8) return;
    socket.data.lastBoardStrokeAt = now;
    if (!Array.isArray(r.boardStrokes)) r.boardStrokes = [];
    const stroke = { x0:values[0], y0:values[1], x1:values[2], y1:values[3], width:values[4], color:p.color, by:socket.data.name };
    r.boardStrokes.push(stroke);
    if (r.boardStrokes.length > 2000) r.boardStrokes.splice(0, r.boardStrokes.length - 2000);
    socket.to(id).emit('board:stroke', stroke);
    persistRoom(r);
  });
  socket.on('board:clear', () => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id)) return;
    r.boardStrokes = [];
    io.to(id).emit('board:clear');
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
  socket.on('game:select', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    const mode = p && p.mode === 'connect4' ? 'connect4' : p && p.mode === 'tictactoe' ? 'tictactoe' : null;
    if (!r || !r.members.has(socket.id) || !mode) return;
    r.activeGame = mode;
    io.to(id).emit('game:mode', { mode, by: socket.data.name });
    persistRoom(r);
  });
  socket.on('connect4:move', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id) || !p || !Number.isInteger(p.column) || p.column < 0 || p.column > 6) return;
    if (!r.connectFour) r.connectFour = { board: Array.from({length:6},()=>Array(7).fill(null)), turn: 'R', winner: null, moves: 0 };
    const g = r.connectFour;
    if (g.winner) return socket.emit('connect4:error', 'O‘yin tugagan. Qayta boshlang.');
    let row = -1;
    for (let y=5;y>=0;y--) if (g.board[y][p.column]===null) { row=y; break; }
    if (row<0) return socket.emit('connect4:error', 'Bu ustun to‘la.');
    const mark=g.turn;
    g.board[row][p.column]=mark;g.moves++;
    const directions=[[0,1],[1,0],[1,1],[1,-1]];
    let won=false;
    for(const [dy,dx] of directions){
      let count=1;
      for(const sign of [-1,1]){
        let y=row+dy*sign,x=p.column+dx*sign;
        while(y>=0&&y<6&&x>=0&&x<7&&g.board[y][x]===mark){count++;y+=dy*sign;x+=dx*sign;}
      }
      if(count>=4){won=true;break;}
    }
    if(won)g.winner=mark;else if(g.moves>=42)g.winner='draw';else g.turn=mark==='R'?'Y':'R';
    io.to(id).emit('connect4:state',g);persistRoom(r);
  });
  socket.on('connect4:reset', () => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id)) return;
    r.connectFour = { board: Array.from({length:6},()=>Array(7).fill(null)), turn: 'R', winner: null, moves: 0 };
    io.to(id).emit('connect4:state',r.connectFour);persistRoom(r);
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
    const title = typeof p.title === 'string' ? p.title.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
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


  async function abortMovieUpload() {
    const upload = socket.data.movieUpload;
    if (!upload) return;
    socket.data.movieUpload = null;
    try { await upload.handle.close(); } catch (_) {}
    try { await fsp.unlink(upload.filePath); } catch (_) {}
  }
  socket.on('video:upload:start', async (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const id = socket.data.roomId, room = rooms.get(id);
    if (!room || !room.members.has(socket.id)) return reply({ ok: false, error: 'Avval tomosha xonasiga kiring.' });
    if (socket.data.movieUpload) return reply({ ok: false, error: 'Avvalgi video yuklanishi hali tugamadi.' });
    const originalName = typeof (p && p.name) === 'string' ? path.basename(p.name).replace(/[^\\p{L}\\p{N}._ -]/gu, '').trim().slice(0, 120) : '';
    const ext = path.extname(originalName).toLowerCase();
    const size = Number(p && p.size);
    if (!originalName || !VIDEO_TYPES[ext]) return reply({ ok: false, error: 'Faqat MP4, WebM, M4V yoki OGV video fayllari qo‘llab-quvvatlanadi.' });
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_VIDEO_UPLOAD_BYTES) return reply({ ok: false, error: 'Video hajmi 1 baytdan ' + (MAX_VIDEO_UPLOAD_BYTES / 1024 / 1024 / 1024) + ' GB gacha bo‘lishi kerak.' });
    room.videos = Array.isArray(room.videos) ? room.videos : [];
    const roomBytes = room.videos.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    if (room.videos.length >= 20 || roomBytes + size > MAX_ROOM_VIDEO_BYTES) return reply({ ok: false, error: 'Xona video saqlash limitiga yetdi.' });
    const uploadId = crypto.randomBytes(16).toString('hex');
    const filePath = path.join(UPLOADS_DIR, uploadId + ext);
    try {
      await fsp.mkdir(UPLOADS_DIR, { recursive: true });
      const handle = await fsp.open(filePath, 'wx');
      socket.data.movieUpload = { uploadId, roomId: id, name: originalName, ext, mime: VIDEO_TYPES[ext], size, filePath, handle, received: 0, nextIndex: 0 };
      reply({ ok: true, uploadId, chunkSize: VIDEO_CHUNK_BYTES });
    } catch (err) {
      reply({ ok: false, error: 'Serverda video saqlash uchun joy yoki ruxsat yo‘q.' });
    }
  });
  socket.on('video:upload:chunk', async (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const upload = socket.data.movieUpload;
    const id = socket.data.roomId, room = rooms.get(id);
    if (!upload || !room || upload.roomId !== id || !room.members.has(socket.id)) return reply({ ok: false, error: 'Video yuklanishi topilmadi yoki xona o‘zgardi.' });
    if (!p || p.uploadId !== upload.uploadId || p.index !== upload.nextIndex) return reply({ ok: false, error: 'Video bo‘laklari tartibi noto‘g‘ri.' });
    let bytes;
    try {
      if (Buffer.isBuffer(p.data)) bytes = p.data;
      else if (p.data instanceof ArrayBuffer) bytes = Buffer.from(p.data);
      else if (ArrayBuffer.isView(p.data)) bytes = Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength);
      else return reply({ ok: false, error: 'Video bo‘lagi noto‘g‘ri formatda.' });
    } catch (_) { return reply({ ok: false, error: 'Video bo‘lagi o‘qilmadi.' }); }
    if (!bytes.length || bytes.length > VIDEO_CHUNK_BYTES || upload.received + bytes.length > upload.size) return reply({ ok: false, error: 'Video bo‘lagi hajmi noto‘g‘ri.' });
    try {
      const result = await upload.handle.write(bytes, 0, bytes.length, upload.received);
      if (result.bytesWritten !== bytes.length) throw new Error('Incomplete write');
      upload.received += bytes.length;
      upload.nextIndex += 1;
      reply({ ok: true, received: upload.received, size: upload.size });
    } catch (_) {
      await abortMovieUpload();
      reply({ ok: false, error: 'Videoni diskka yozib bo‘lmadi.' });
    }
  });
  socket.on('video:upload:end', async (p, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const upload = socket.data.movieUpload;
    const id = socket.data.roomId, room = rooms.get(id);
    if (!upload || !room || upload.roomId !== id || !room.members.has(socket.id) || !p || p.uploadId !== upload.uploadId) return reply({ ok: false, error: 'Video yuklanishi topilmadi.' });
    if (upload.received !== upload.size) {
      await abortMovieUpload();
      return reply({ ok: false, error: 'Video to‘liq yuklanmadi. Qaytadan urinib ko‘ring.' });
    }
    try { await upload.handle.close(); } catch (_) {}
    socket.data.movieUpload = null;
    const file = { id: upload.uploadId, name: upload.name, ext: upload.ext.slice(1), mime: upload.mime, size: upload.size, by: socket.data.name, at: Date.now(), url: '/media/' + upload.uploadId + upload.ext };
    room.videos = Array.isArray(room.videos) ? room.videos : [];
    room.videos.push(file);
    io.to(id).emit('video:uploaded', file);
    persistRoom(room);
    reply({ ok: true, file });
  });
  socket.on('video:upload:cancel', async p => {
    if (socket.data.movieUpload && (!p || !p.uploadId || p.uploadId === socket.data.movieUpload.uploadId)) await abortMovieUpload();
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
    persistRoom(r);
  });

  socket.on('room:leave', () => leave(socket));
  socket.on('chat:typing', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id)) return;
    socket.to(id).emit('chat:typing', { from: socket.id, name: socket.data.name, typing: Boolean(p && p.typing) });
  });
  socket.on('chat:send', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id)) return;
    const text = typeof (p && p.text) === 'string' ? p.text.trim().slice(0, 500) : '';
    if (!text) return;
    // Keep one participant from flooding the shared chat or growing room snapshots too quickly.
    const now = Date.now();
    let limit = socket.data.chatRate;
    if (!limit || now - limit.startedAt >= 5000) limit = socket.data.chatRate = { startedAt: now, count: 0 };
    if (limit.count >= 8) return error(socket, 'Juda tez-tez xabar yuboryapsiz. 5 soniya kutib qayta urinib ko‘ring.');
    limit.count++;
    {
      const message = { name: socket.data.name, text, at: now };
      if (!Array.isArray(r.messages)) r.messages = [];
      r.messages.push(message);
      if (r.messages.length > 100) r.messages.splice(0, r.messages.length - 100);
      io.to(id).emit('chat:message', message);
      persistRoom(r);
    }
  });
  socket.on('queue:add', async p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id)) return error(socket, 'Avval tomosha xonasiga kiring.');
    try { await validateMediaSource(p); }
    catch (_) { return error(socket, 'Video havolasi ochiq internet manzili bo‘lishi kerak. Mahalliy yoki ichki tarmoq manzillari taqiqlangan.'); }
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
  socket.on('video:load', async p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id)) return error(socket, 'Avval tomosha xonasiga kiring.');
    try { await validateMediaSource(p); }
    catch (_) { return error(socket, 'Video havolasi ochiq internet manzili bo‘lishi kerak. Mahalliy yoki ichki tarmoq manzillari taqiqlangan.'); }
    const media = normalizeMedia(p);
    if (!media) return error(socket, 'YouTube, Vimeo, MP4/WebM yoki HLS (.m3u8) video havolasini kiriting.');
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
    if (typeof p.isPlaying !== 'boolean' || typeof p.currentTime !== 'number') return;
    const t = p.currentTime;
    if (!Number.isFinite(t) || t < 0 || t > 86400) return;
    r.state = { ...r.state, isPlaying: p.isPlaying, currentTime: t, updatedAt: Date.now() };
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
    const offer = p && p.offer;
    if (!r || !r.members.has(socket.id) || !r.members.has(to) ||
        !offer || offer.type !== 'offer' || typeof offer.sdp !== 'string' ||
        offer.sdp.length > 200000) return;
    io.to(to).emit('rtc:offer', { from: socket.id, kind: p.kind === 'call' ? 'call' : 'screen', offer });
  });
  socket.on('rtc:answer', p => {
    const id = socket.data.roomId, r = rooms.get(id), to = p && p.to;
    const answer = p && p.answer;
    if (!r || !r.members.has(socket.id) || !r.members.has(to) ||
        !answer || answer.type !== 'answer' || typeof answer.sdp !== 'string' ||
        answer.sdp.length > 200000) return;
    io.to(to).emit('rtc:answer', { from: socket.id, kind: p.kind === 'call' ? 'call' : 'screen', answer });
  });
  socket.on('rtc:ice', p => {
    const id = socket.data.roomId, r = rooms.get(id), to = p && p.to;
    const candidate = p && p.candidate;
    if (!r || !r.members.has(socket.id) || !r.members.has(to) ||
        !candidate || typeof candidate !== 'object' ||
        typeof candidate.candidate !== 'string' || candidate.candidate.length > 4096) return;
    io.to(to).emit('rtc:ice', { from: socket.id, kind: p.kind === 'call' ? 'call' : 'screen', candidate });
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

  socket.on('disconnect', () => { abortMovieUpload().catch(() => {}); leave(socket); });
});
auth.attach(app, io).then(async () => {
  const savedRooms = await auth.loadRoomSnapshots();
  for (const saved of savedRooms) {
    const payload = saved.payload || {};
    const room = {
      id: saved.id, hostId: null, members: new Map(), callReady: new Set(),
      state: payload.state || emptyState(), queue: Array.isArray(payload.queue) ? payload.queue : [],
      game: payload.game && Array.isArray(payload.game.board) && payload.game.board.length === 9 ? payload.game : { board: Array(9).fill(null), turn: 'X', winner: null, moves: 0 },
      activeGame: payload.activeGame === 'connect4' ? 'connect4' : 'tictactoe',
      connectFour: payload.connectFour && Array.isArray(payload.connectFour.board) && payload.connectFour.board.length === 6 ? payload.connectFour : { board: Array.from({length:6},()=>Array(7).fill(null)), turn: 'R', winner: null, moves: 0 },
      messages: Array.isArray(payload.messages) ? payload.messages.slice(-100) : [],
      siteUrl: payload.siteUrl || null, siteExpanded: Boolean(payload.siteExpanded),
      title: typeof payload.title === 'string' ? payload.title : 'Tomosha xonasi', theme: cleanRoomTheme(payload.theme),
      screenOwner: null, files: Array.isArray(payload.files) ? payload.files.filter(file => file && typeof file.id === 'string' && typeof file.name === 'string' && typeof file.mime === 'string' && typeof file.data === 'string').slice(0, 5) : [], videos: Array.isArray(payload.videos) ? payload.videos.filter(file => file && /^[a-f0-9]{32}$/.test(file.id) && typeof file.name === 'string' && Number.isSafeInteger(file.size)).slice(0, 20) : [], links: Array.isArray(payload.links) ? payload.links.slice(0, 30) : [], boardStrokes: Array.isArray(payload.boardStrokes) ? payload.boardStrokes.slice(-2000) : [], isPublic: Boolean(payload.isPublic), activeActivity: ['video','site','games','board','files','screen','call','people'].includes(payload.activeActivity) ? payload.activeActivity : 'video', emptyAt: saved.emptyAt || Date.now()
    };
    rooms.set(room.id, room);
    persistRoom(room, true);
  }
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  server.listen(PORT, '0.0.0.0', () => console.log('TogetherWatch listening on ' + PORT + ' (restored ' + savedRooms.length + ' rooms)'));
}).catch(err => { console.error('Account API initialization failed:', err); process.exit(1); });
