const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'TogetherWatch' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
  if (type === 'file') {
    const raw = typeof p.mediaUrl === 'string' ? p.mediaUrl.slice(0, 2048) : '';
    try {
      const u = new URL(raw);
      if (!['http:', 'https:'].includes(u.protocol) || !/\.(mp4|webm)$/i.test(u.pathname)) return null;
      return { mediaType: 'file', mediaId: raw, mediaUrl: raw, videoId: null };
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
  if (!r && create) { r = { id, hostId: socket.id, members: new Map(), state: emptyState() }; rooms.set(id, r); }
  if (!r) return error(socket, 'Xona topilmadi. Kodni tekshiring.');
  if (r.members.size >= 20) return error(socket, 'Xona to‘la (maksimal 20 kishi).');
  if (Array.from(r.members.values()).some(m => m.name.toLowerCase() === name.toLowerCase())) return error(socket, 'Bu ism allaqachon ishlatilmoqda.');
  if (!r.hostId || !r.members.has(r.hostId)) r.hostId = socket.id;
  r.emptyAt = null;
  socket.join(id);
  socket.data.roomId = id;
  socket.data.name = name;
  r.members.set(socket.id, { id: socket.id, name });
  socket.emit('room:joined', { roomId: id, isHost: r.hostId === socket.id, state: r.state });
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
    if (r && r.members.has(socket.id)) socket.to(id).emit('rtc:ready', { from: socket.id, ready: Boolean(p && p.ready) });
  });
  socket.on('screen:stop', () => {
    const id = socket.data.roomId, r = rooms.get(id);
    if (r && r.members.has(socket.id)) socket.to(id).emit('screen:stop', { from: socket.id });
  });

  socket.on('disconnect', () => leave(socket));
});
server.listen(PORT, '0.0.0.0', () => console.log('TogetherWatch listening on ' + PORT));
