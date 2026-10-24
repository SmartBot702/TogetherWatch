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
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from(crypto.randomBytes(6), b => chars[b % chars.length]).join(''); } while (rooms.has(code));
  return code;
}
function cleanName(v) { return typeof v === 'string' ? v.replace(/[<>]/g, '').trim().slice(0, 24) : ''; }
function validVideoId(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v); }
function error(socket, message) { socket.emit('room:error', message); }
function people(room) { return Array.from(room.members.values()).map(m => ({ id: m.id, name: m.name, isHost: m.id === room.hostId })); }
function broadcastPeople(id) { const r = rooms.get(id); if (r) io.to(id).emit('room:people', people(r)); }
function leave(socket) {
  const id = socket.data.roomId;
  if (!id) return;
  const r = rooms.get(id); socket.leave(id); socket.data.roomId = null;
  if (!r) return;
  const m = r.members.get(socket.id); r.members.delete(socket.id);
  if (m) io.to(id).emit('room:system', m.name + ' xonadan chiqdi.');
  if (r.hostId === socket.id) {
    const next = r.members.keys().next();
    if (!next.done) { r.hostId = next.value; const host = r.members.get(r.hostId); io.to(id).emit('room:system', host.name + ' endi xona egasi.'); const s = io.sockets.sockets.get(r.hostId); if (s) s.emit('room:role', { isHost: true }); }
  }
  if (!r.members.size) rooms.delete(id); else broadcastPeople(id);
}
function enter(socket, id, name, create) {
  if (!name) return error(socket, 'Ismingizni kiriting.');
  let r = rooms.get(id);
  if (!r && create) { r = { id, hostId: socket.id, members: new Map(), state: { videoId: null, isPlaying: false, currentTime: 0, updatedAt: Date.now() } }; rooms.set(id, r); }
  if (!r) return error(socket, 'Xona topilmadi. Kodni tekshiring.');
  if (r.members.size >= 20) return error(socket, 'Xona to‘la (maksimal 20 kishi).');
  if (Array.from(r.members.values()).some(m => m.name.toLowerCase() === name.toLowerCase())) return error(socket, 'Bu ism allaqachon ishlatilmoqda.');
  socket.join(id); socket.data.roomId = id; socket.data.name = name; r.members.set(socket.id, { id: socket.id, name });
  socket.emit('room:joined', { roomId: id, isHost: r.hostId === socket.id, state: r.state });
  socket.to(id).emit('room:system', name + ' xonaga qo‘shildi.'); broadcastPeople(id);
  if (r.state.videoId) socket.emit('room:state', r.state);
}
io.on('connection', socket => {
  socket.on('room:create', p => { leave(socket); const n = cleanName(p && p.name); if (!n) return error(socket, 'Ismingizni kiriting.'); let id; do { id = makeCode(); } while (rooms.has(id)); enter(socket, id, n, true); });
  socket.on('room:join', p => { leave(socket); const id = String(p && p.roomId || '').toUpperCase(); if (!/^[A-Z0-9]{6}$/.test(id)) return error(socket, 'Xona kodi noto‘g‘ri.'); enter(socket, id, cleanName(p && p.name), false); });
  socket.on('room:leave', () => leave(socket));
  socket.on('chat:send', p => { const id = socket.data.roomId, r = rooms.get(id); const text = typeof (p && p.text) === 'string' ? p.text.trim().slice(0, 500) : ''; if (r && text) io.to(id).emit('chat:message', { name: socket.data.name, text, at: Date.now() }); });
  socket.on('video:load', p => { const id = socket.data.roomId, r = rooms.get(id); if (!r || r.hostId !== socket.id) return error(socket, 'Videoni faqat xona egasi almashtira oladi.'); if (!validVideoId(p && p.videoId)) return error(socket, 'YouTube video ID noto‘g‘ri.'); r.state = { videoId: p.videoId, isPlaying: false, currentTime: 0, updatedAt: Date.now() }; io.to(id).emit('video:loaded', r.state); });
  function playback(p) {
    const id = socket.data.roomId, r = rooms.get(id);
    if (!r || r.hostId !== socket.id || !r.state.videoId || !p || p.videoId !== r.state.videoId) return;
    const t = Number(p.currentTime); if (!Number.isFinite(t) || t < 0 || t > 86400) return;
    r.state = { videoId: r.state.videoId, isPlaying: Boolean(p.isPlaying), currentTime: t, updatedAt: Date.now() };
    socket.to(id).emit('video:state', r.state);
  }
  socket.on('video:state', playback); socket.on('video:heartbeat', playback);
  socket.on('disconnect', () => leave(socket));
});
server.listen(PORT, '0.0.0.0', () => console.log('TogetherWatch listening on ' + PORT));
