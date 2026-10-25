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

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'TogetherWatch' }));

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
    const value = decodeHtml(raw.trim()).replace(/\\\//g, '/');
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
    if (!room.members.size && room.emptyAt && Date.now() - room.emptyAt > 6 * 60 * 60 * 1000) rooms.delete(id);
  }
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from(crypto.randomBytes(6), b => chars[b % chars.length]).join(''); } while (rooms.has(code));
  return code;
}
function cleanName(v) { return typeof v === 'string' ? v.replace(/[<>]/g, '').trim().slice(0, 24) : ''; }
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
  if (!r.members.size) rooms.delete(id);
  else broadcastPeople(id);
}
function enter(socket, id, name, create) {
  if (!name) return error(socket, 'Ismingizni kiriting.');
  let r = rooms.get(id);
  if (!r && create) { r = { id, hostId: socket.id, members: new Map(), callReady: new Set(), state: emptyState(), siteUrl: null, siteExpanded: false, screenOwner: null }; rooms.set(id, r); }
  if (!r) return error(socket, 'Xona topilmadi. Kodni tekshiring.');
  if (r.members.size >= 20) return error(socket, 'Xona to‘la (maksimal 20 kishi).');
  if (Array.from(r.members.values()).some(m => m.name.toLowerCase() === name.toLowerCase())) return error(socket, 'Bu ism allaqachon ishlatilmoqda.');
  if (!r.hostId || !r.members.has(r.hostId)) r.hostId = socket.id;
  r.emptyAt = null;
  socket.join(id);
  socket.data.roomId = id;
  socket.data.name = name;
  r.members.set(socket.id, { id: socket.id, name });
  socket.emit('room:joined', { roomId: id, isHost: r.hostId === socket.id, state: r.state, siteUrl: r.siteUrl, siteExpanded: r.siteExpanded, screenOwner: r.screenOwner });
  for (const memberId of (r.callReady || [])) if (memberId !== socket.id) socket.emit('rtc:ready', { from: memberId, ready: true });
  socket.to(id).emit('room:system', name + ' xonaga qo‘shildi.');
  broadcastPeople(id);
}
io.on('connection', socket => {
  socket.on('room:create', p => {
    leave(socket);
    const n = cleanName(p && p.name);
    if (!n) return error(socket, 'Ismingizni kiriting.');
    let id;
    do { id = makeCode(); } while (rooms.has(id));
    enter(socket, id, n, true);
  });
  socket.on('room:join', p => {
    leave(socket);
    const id = String(p && p.roomId || '').toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(id)) return error(socket, 'Xona kodi noto‘g‘ri.');
    enter(socket, id, cleanName(p && p.name), false);
  });
  socket.on('room:leave', () => leave(socket));
  socket.on('chat:send', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    const text = typeof (p && p.text) === 'string' ? p.text.trim().slice(0, 500) : '';
    if (r && text) io.to(id).emit('chat:message', { name: socket.data.name, text, at: Date.now() });
  });
  socket.on('video:load', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || r.hostId !== socket.id) return error(socket, 'Videoni faqat xona egasi almashtira oladi.');
    const media = normalizeMedia(p);
    if (!media) return error(socket, 'YouTube, Vimeo yoki to‘g‘ridan-to‘g‘ri MP4/WebM havolasini kiriting.');
    r.state = { ...media, isPlaying: false, currentTime: 0, updatedAt: Date.now() };
    io.to(id).emit('video:loaded', r.state);
  });
  function playback(p) {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || r.hostId !== socket.id || !r.state.mediaType || !p) return;
    const type = p.mediaType || (p.videoId ? 'youtube' : '');
    const idValue = p.mediaId || p.videoId || p.mediaUrl;
    const expected = r.state.mediaId || r.state.mediaUrl;
    if (type !== r.state.mediaType || idValue !== expected) return;
    const t = Number(p.currentTime);
    if (!Number.isFinite(t) || t < 0 || t > 86400) return;
    r.state = { ...r.state, isPlaying: Boolean(p.isPlaying), currentTime: t, updatedAt: Date.now() };
    socket.to(id).emit('video:state', r.state);
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
    } catch (_) { error(socket, 'Sayt havolasi noto‘g‘ri.'); }
  });
  socket.on('site:expand', p => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || !r.members.has(socket.id) || !r.siteUrl) return;
    r.siteExpanded = Boolean(p && p.expanded);
    io.to(id).emit('site:shared', { url: r.siteUrl, expanded: r.siteExpanded, by: socket.data.name });
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
auth.attach(app).then(() => {
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  server.listen(PORT, '0.0.0.0', () => console.log('TogetherWatch listening on ' + PORT));
}).catch(err => { console.error('Account API initialization failed:', err); process.exit(1); });
