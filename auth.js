const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const { Pool } = require('pg');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '.data');
const dataFile = path.join(dataDir, 'accounts.json');
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false }
}) : null;
let state = { users: [], sessions: {}, friendRequests: [], friends: [], messages: [] };
let writeQueue = Promise.resolve();
function normalizeStore(parsed) {
  return {
    users: Array.isArray(parsed && parsed.users) ? parsed.users : [],
    sessions: parsed && parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    friendRequests: Array.isArray(parsed && parsed.friendRequests) ? parsed.friendRequests : [],
    friends: Array.isArray(parsed && parsed.friends) ? parsed.friends : [],
    messages: Array.isArray(parsed && parsed.messages) ? parsed.messages : []
  };
}

async function load() {
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS togetherwatch_app_state (id smallint PRIMARY KEY CHECK (id = 1), payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    const result = await pool.query('SELECT payload FROM togetherwatch_app_state WHERE id = 1');
    if (result.rows[0]) {
      state = normalizeStore(result.rows[0].payload);
      return;
    }
    // One-time migration from the JSON store when PostgreSQL is first connected.
    try { state = normalizeStore(JSON.parse(await fs.promises.readFile(dataFile, 'utf8'))); }
    catch (e) {
      if (e.code !== 'ENOENT') console.error('Account store migration read failed:', e.message);
      state = normalizeStore({});
    }
    await pool.query('INSERT INTO togetherwatch_app_state (id, payload) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING', [JSON.stringify(state)]);
    return;
  }
  try {
    state = normalizeStore(JSON.parse(await fs.promises.readFile(dataFile, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Account store read failed:', e.message);
    state = normalizeStore({});
    await save();
  }
}
async function save() {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    if (pool) {
      await pool.query('INSERT INTO togetherwatch_app_state (id, payload, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()', [JSON.stringify(state)]);
      return;
    }
    await fs.promises.mkdir(dataDir, { recursive: true });
    const temp = dataFile + '.tmp';
    await fs.promises.writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await fs.promises.rename(temp, dataFile);
  });
  return writeQueue;
}
function clean(v, max = 80) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.displayName, bio: user.bio || '', avatar: user.avatar || '', createdAt: user.createdAt };
}
function cookie(req, name) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', 'tw_session=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'tw_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
}
function currentUser(req) {
  const token = cookie(req, 'tw_session');
  const session = state.sessions[token];
  if (!session || session.expiresAt < Date.now()) return null;
  return state.users.find(u => u.id === session.userId) || null;
}
function fail(res, status, error) { return res.status(status).json({ ok: false, error }); }

async function loadRoomSnapshots() {
  if (!pool) return [];
  await pool.query('CREATE TABLE IF NOT EXISTS togetherwatch_rooms (room_id varchar(6) PRIMARY KEY, payload jsonb NOT NULL, empty_at bigint, updated_at timestamptz NOT NULL DEFAULT now())');
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  await pool.query("DELETE FROM togetherwatch_rooms WHERE (empty_at IS NOT NULL AND empty_at <= $1) OR (empty_at IS NULL AND updated_at <= now() - interval '6 hours')", [cutoff]);
  const result = await pool.query("SELECT room_id, payload, empty_at FROM togetherwatch_rooms WHERE (empty_at IS NULL AND updated_at > now() - interval '6 hours') OR empty_at > $1 ORDER BY updated_at DESC", [cutoff]);
  return result.rows.map(row => ({ id: row.room_id, payload: row.payload, emptyAt: row.empty_at == null ? null : Number(row.empty_at) }));
}
async function saveRoomSnapshot(room) {
  if (!pool || !room || !/^[A-Z0-9]{6}$/.test(room.id)) return;
  const payload = {
    state: room.state || {}, queue: Array.isArray(room.queue) ? room.queue.slice(0, 50) : [],
    messages: Array.isArray(room.messages) ? room.messages.slice(-100) : [],
    siteUrl: typeof room.siteUrl === 'string' ? room.siteUrl : null,
    siteExpanded: Boolean(room.siteExpanded),
    title: typeof room.title === 'string' ? room.title.slice(0, 60) : 'Tomosha xonasi',
    theme: ['violet','ocean','sunset','emerald'].includes(room.theme) ? room.theme : 'violet',
    isPublic: Boolean(room.isPublic),
    links: Array.isArray(room.links) ? room.links.slice(0, 30) : [],
    boardStrokes: Array.isArray(room.boardStrokes) ? room.boardStrokes.slice(-2000) : []
  };
  await pool.query('INSERT INTO togetherwatch_rooms (room_id, payload, empty_at, updated_at) VALUES ($1, $2::jsonb, $3, now()) ON CONFLICT (room_id) DO UPDATE SET payload = EXCLUDED.payload, empty_at = EXCLUDED.empty_at, updated_at = now()', [room.id, JSON.stringify(payload), room.emptyAt || null]);
}
async function deleteRoomSnapshot(roomId) {
  if (pool && /^[A-Z0-9]{6}$/.test(roomId || '')) await pool.query('DELETE FROM togetherwatch_rooms WHERE room_id = $1', [roomId]);
}

async function attach(app, io) {
  await load();
  if (io) {
    io.use((socket, next) => {
      const user = currentUser({ headers: { cookie: socket.handshake.headers.cookie || '' } });
      socket.data.accountUserId = user ? user.id : null;
      next();
    });
    io.on('connection', socket => {
      const accountId = socket.data.accountUserId;
      if (accountId) socket.join('account:' + accountId);
      socket.on('dm:send', async (p, acknowledge) => {
        const respond = typeof acknowledge === 'function' ? acknowledge : () => {};
        const sender = currentUser({ headers: { cookie: socket.handshake.headers.cookie || '' } });
        if (!sender || sender.id !== accountId) return respond({ ok: false, error: 'Shaxsiy xabar yuborish uchun qayta kiring.' });
        const otherId = clean(p && p.to, 64);
        const messageText = clean(p && p.text, 2000);
        if (!messageText) return respond({ ok: false, error: 'Xabar bo‘sh bo‘lmasin.' });
        if (!otherId || otherId === sender.id) return respond({ ok: false, error: 'Qabul qiluvchi noto‘g‘ri.' });
        if (!areFriends(sender.id, otherId)) return respond({ ok: false, error: 'Shaxsiy chat uchun avval do‘st bo‘ling.' });
        const message = { id: crypto.randomUUID(), from: sender.id, to: otherId, text: messageText, createdAt: Date.now() };
        state.messages.push(message);
        if (state.messages.length > 10000) state.messages = state.messages.slice(-10000);
        try { await save(); }
        catch (_) {
          state.messages = state.messages.filter(item => item.id !== message.id);
          return respond({ ok: false, error: 'Xabarni saqlab bo‘lmadi.' });
        }
        const outgoing = { ...message, sender: publicUser(sender) };
        io.to('account:' + otherId).emit('dm:message', outgoing);
        io.to('account:' + sender.id).emit('dm:message', outgoing);
        respond({ ok: true, message: outgoing });
      });
    });
  }
  app.use('/api/auth', require('express').json({ limit: '20kb' }));
  app.get('/api/auth/me', (req, res) => {
    const user = currentUser(req);
    res.json({ ok: true, user: user ? publicUser(user) : null });
  });
  app.post('/api/auth/register', async (req, res) => {
    const username = clean(req.body && req.body.username, 24).toLowerCase();
    const displayName = clean(req.body && req.body.displayName, 40) || username;
    const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
    if (!/^[a-z0-9_]{3,24}$/.test(username)) return fail(res, 400, 'Username 3–24 ta belgi: lotin harfi, raqam yoki _.');
    if (password.length < 8 || password.length > 128) return fail(res, 400, 'Parol 8–128 belgidan iborat bo‘lishi kerak.');
    if (state.users.some(u => u.username === username)) return fail(res, 409, 'Bu username band.');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await scrypt(password, salt, 64);
    const user = { id: crypto.randomUUID(), username, displayName, bio: '', avatar: '', salt, passwordHash: hash.toString('hex'), createdAt: Date.now() };
    state.users.push(user);
    const token = crypto.randomBytes(32).toString('hex');
    state.sessions[token] = { userId: user.id, expiresAt: Date.now() + 30 * 86400000 };
    try { await save(); } catch (_) { return fail(res, 500, 'Akkauntni saqlab bo‘lmadi.'); }
    setSessionCookie(res, token);
    return res.status(201).json({ ok: true, user: publicUser(user) });
  });
  app.post('/api/auth/login', async (req, res) => {
    const username = clean(req.body && req.body.username, 24).toLowerCase();
    const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
    const user = state.users.find(u => u.username === username);
    if (!user || !password || password.length > 128) return fail(res, 401, 'Username yoki parol noto‘g‘ri.');
    const candidate = await scrypt(password, user.salt, 64);
    const expected = Buffer.from(user.passwordHash, 'hex');
    if (expected.length !== candidate.length || !crypto.timingSafeEqual(expected, candidate)) return fail(res, 401, 'Username yoki parol noto‘g‘ri.');
    const token = crypto.randomBytes(32).toString('hex');
    state.sessions[token] = { userId: user.id, expiresAt: Date.now() + 30 * 86400000 };
    await save();
    setSessionCookie(res, token);
    return res.json({ ok: true, user: publicUser(user) });
  });
  app.post('/api/auth/logout', async (req, res) => {
    const token = cookie(req, 'tw_session');
    if (token) { delete state.sessions[token]; await save(); }
    clearSessionCookie(res);
    res.json({ ok: true });
  });
  app.patch('/api/auth/profile', async (req, res) => {
    const user = currentUser(req);
    if (!user) return fail(res, 401, 'Avval akkauntga kiring.');
    const displayName = clean(req.body && req.body.displayName, 40);
    const bio = clean(req.body && req.body.bio, 160);
    const avatar = clean(req.body && req.body.avatar, 500);
    if (displayName) user.displayName = displayName;
    user.bio = bio;
    if (avatar && !/^https:\/\/[^\s]+$/i.test(avatar)) return fail(res, 400, 'Avatar uchun HTTPS havola kerak.');
    user.avatar = avatar;
    await save();
    res.json({ ok: true, user: publicUser(user) });
  });
  app.get('/api/users/search', (req, res) => {
    const user = currentUser(req);
    if (!user) return fail(res, 401, 'Qidirish uchun akkauntga kiring.');
    const q = clean(req.query.q, 32).toLowerCase();
    if (q.length < 2) return res.json({ ok: true, users: [] });
    const users = state.users.filter(u => u.id !== user.id && (u.username.includes(q) || u.displayName.toLowerCase().includes(q))).slice(0, 20).map(publicUser);
    res.json({ ok: true, users });
  });
  app.get('/api/friends', (req, res) => {
    const user = currentUser(req);
    if (!user) return fail(res, 401, 'Avval akkauntga kiring.');
    const friends = state.friends.filter(r => r.users.includes(user.id)).map(r => state.users.find(u => u.id === r.users.find(id => id !== user.id))).filter(Boolean).map(publicUser);
    const incoming = state.friendRequests.filter(r => r.to === user.id && r.status === 'pending').map(r => ({ id: r.id, user: publicUser(state.users.find(u => u.id === r.from)) })).filter(r => r.user);
    res.json({ ok: true, friends, incoming: incoming.map(r => ({ id: r.id, user: r.user })) });
  });
  function areFriends(a, b) {
    return state.friends.some(r => r.users.includes(a) && r.users.includes(b));
  }
  app.get('/api/messages/:userId', (req, res) => {
    const user = currentUser(req);
    if (!user) return fail(res, 401, 'Avval akkauntga kiring.');
    const otherId = clean(req.params.userId, 64);
    if (!areFriends(user.id, otherId)) return fail(res, 403, 'Shaxsiy chat uchun avval do‘st bo‘ling.');
    const messages = state.messages.filter(m => (m.from === user.id && m.to === otherId) || (m.from === otherId && m.to === user.id)).slice(-100).map(m => ({
      id: m.id, from: m.from, to: m.to, text: m.text, createdAt: m.createdAt,
      sender: publicUser(state.users.find(u => u.id === m.from))
    }));
    res.json({ ok: true, messages });
  });
  app.post('/api/messages/:userId', async (req, res) => {
    const user = currentUser(req);
    if (!user) return fail(res, 401, 'Avval akkauntga kiring.');
    const otherId = clean(req.params.userId, 64);
    const messageText = clean(req.body && req.body.text, 2000);
    if (!areFriends(user.id, otherId)) return fail(res, 403, 'Shaxsiy chat uchun avval do‘st bo‘ling.');
    if (!messageText) return fail(res, 400, 'Xabar bo‘sh bo‘lmasin.');
    const message = { id: crypto.randomUUID(), from: user.id, to: otherId, text: messageText, createdAt: Date.now() };
    state.messages.push(message);
    if (state.messages.length > 10000) state.messages = state.messages.slice(-10000);
    try { await save(); } catch (_) { return fail(res, 500, 'Xabarni saqlab bo‘lmadi.'); }
    res.status(201).json({ ok: true, message });
  });
  app.post('/api/friends/request', async (req, res) => {
    const user = currentUser(req);
    if (!user) return fail(res, 401, 'Avval akkauntga kiring.');
    const username = clean(req.body && req.body.username, 24).toLowerCase();
    const target = state.users.find(u => u.username === username);
    if (!target || target.id === user.id) return fail(res, 404, 'Foydalanuvchi topilmadi.');
    if (state.friends.some(r => r.users.includes(user.id) && r.users.includes(target.id))) return fail(res, 409, 'Siz allaqachon do‘stsiz.');
    if (state.friendRequests.some(r => r.status === 'pending' && ((r.from === user.id && r.to === target.id) || (r.from === target.id && r.to === user.id)))) return fail(res, 409, 'Do‘stlik so‘rovi allaqachon mavjud.');
    state.friendRequests.push({ id: crypto.randomUUID(), from: user.id, to: target.id, status: 'pending', createdAt: Date.now() });
    await save();
    res.status(201).json({ ok: true });
  });
  app.post('/api/friends/respond', async (req, res) => {
    const user = currentUser(req);
    if (!user) return fail(res, 401, 'Avval akkauntga kiring.');
    const requestId = clean(req.body && req.body.requestId, 64);
    const accept = Boolean(req.body && req.body.accept);
    const request = state.friendRequests.find(r => r.id === requestId && r.to === user.id && r.status === 'pending');
    if (!request) return fail(res, 404, 'So‘rov topilmadi yoki avval javob berilgan.');
    request.status = accept ? 'accepted' : 'rejected';
    request.respondedAt = Date.now();
    if (accept && !state.friends.some(r => r.users.includes(user.id) && r.users.includes(request.from))) state.friends.push({ users: [user.id, request.from], createdAt: Date.now() });
    await save();
    res.json({ ok: true });
  });
}
module.exports = { attach, loadRoomSnapshots, saveRoomSnapshot, deleteRoomSnapshot };
