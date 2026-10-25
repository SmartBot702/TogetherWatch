const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('installable app shell files are present and valid', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(fs.existsSync(path.join(root, 'public', 'icon.svg')));
  assert.ok(fs.existsSync(path.join(root, 'public', 'sw.js')));
  assert.match(read('public/index.html'), /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(read('public/index.html'), /register\('\/sw\.js'\)/);
});

test('service worker does not cache API or realtime traffic', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /pathname\.startsWith\('\/api\/'\)/);
  assert.match(sw, /pathname\.startsWith\('\/socket\.io\/'\)/);
  assert.match(sw, /req\.method !== 'GET'/);
});

test('watch-party core controls and client handlers exist', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  for (const id of ['createRoom', 'joinRoom', 'activityHub', 'sharedActivityGrid', 'chatForm', 'video', 'whiteboardCanvas', 'screenShare', 'startCall']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'missing UI element: ' + id);
  }
  for (const event of ['room:joined', 'room:state', 'activity:launched', 'chat:message', 'video:state']) {
    assert.ok(app.includes("socket.on('" + event + "'"), 'missing client event handler: ' + event);
  }
});

test('server exposes health, public rooms, RTC config, and shared activities', () => {
  const server = read('server.js');
  for (const route of ["app.get('/health'", "app.get('/api/rooms/public'", "app.get('/api/rtc-config'"]) {
    assert.ok(server.includes(route), 'missing route: ' + route);
  }
  assert.ok(server.includes("socket.on('activity:launch'"), 'missing shared activity event');
});


test('two clients share a room, activity selection, and chat in realtime', async () => {
  const os = require('node:os');
  const net = require('node:net');
  const { spawn } = require('node:child_process');
  const { io: connect } = require('socket.io-client');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'togetherwatch-test-'));
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const chosen = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(chosen));
    });
  });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: tempDir, DATABASE_URL: '', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  let host;
  let guest;

  const waitForEvent = (socket, event, timeout = 6000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error('Timed out waiting for ' + event + '. Server output: ' + output.slice(-1500)));
    }, timeout);
    const onEvent = data => { clearTimeout(timer); resolve(data); };
    socket.once(event, onEvent);
  });

  try {
    const deadline = Date.now() + 10000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Server exited early: ' + output);
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/health');
        if (response.ok) { healthy = true; break; }
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(healthy, 'server did not become healthy: ' + output.slice(-1500));

    const url = 'http://127.0.0.1:' + port;
    for (const asset of ['/manifest.webmanifest', '/sw.js', '/icon.svg', '/app.js']) {
      const response = await fetch(url + asset);
      assert.equal(response.status, 200, 'asset not served: ' + asset);
    }

    const registration = await fetch(url + '/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'smoke_user', displayName: 'Smoke User', password: 'test-password-123' })
    });
    assert.equal(registration.status, 201, 'account registration should succeed');
    const setCookie = registration.headers.get('set-cookie') || '';
    const sessionCookie = setCookie.split(';')[0];
    assert.match(sessionCookie, /^tw_session=/);
    const meResponse = await fetch(url + '/api/auth/me', { headers: { cookie: sessionCookie } });
    const me = await meResponse.json();
    assert.equal(me.user.username, 'smoke_user');

    const invalidProfile = await fetch(url + '/api/auth/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ displayName: 'Should Not Persist', bio: 'temporary', avatar: 'javascript:alert(1)' })
    });
    assert.equal(invalidProfile.status, 400, 'invalid avatar URL should be rejected');
    const unchangedProfile = await (await fetch(url + '/api/auth/me', { headers: { cookie: sessionCookie } })).json();
    assert.equal(unchangedProfile.user.displayName, 'Smoke User', 'invalid profile patch must not partially mutate the account');

    host = connect(url, { transports: ['websocket'], reconnection: false, timeout: 5000 });
    guest = connect(url, { transports: ['websocket'], reconnection: false, timeout: 5000 });
    await Promise.all([waitForEvent(host, 'connect'), waitForEvent(guest, 'connect')]);

    const hostJoinedPromise = waitForEvent(host, 'room:joined');
    host.emit('room:create', { name: 'HostTest', title: 'Realtime test room' });
    const hostRoom = await hostJoinedPromise;
    assert.match(hostRoom.roomId, /^[A-Z0-9]{6}$/);

    const guestJoinedPromise = waitForEvent(guest, 'room:joined');
    guest.emit('room:join', { roomId: hostRoom.roomId, name: 'GuestTest' });
    const guestRoom = await guestJoinedPromise;
    assert.equal(guestRoom.roomId, hostRoom.roomId);

    // A failed room switch must not silently remove the guest from the active room.
    const failedJoinPromise = waitForEvent(guest, 'room:error');
    guest.emit('room:join', { roomId: 'ZZZZZZ', name: 'GuestTest' });
    await failedJoinPromise;
    const stillInRoomPromise = waitForEvent(host, 'chat:message');
    guest.emit('chat:send', { text: 'still-in-room-check' });
    const stillInRoom = await stillInRoomPromise;
    assert.equal(stillInRoom.text, 'still-in-room-check');

    const activityPromise = waitForEvent(guest, 'activity:launched');
    host.emit('activity:launch', { activity: 'board' });
    const activity = await activityPromise;
    assert.equal(activity.activity, 'board');

    const chatPromise = waitForEvent(guest, 'chat:message');
    host.emit('chat:send', { text: 'integration-test-message' });
    const message = await chatPromise;
    assert.equal(message.text, 'integration-test-message');
    assert.equal(message.name, 'HostTest');

    const sharedFilePromise = waitForEvent(guest, 'file:shared');
    host.emit('file:share', { name: 'note.txt', data: 'data:text/plain;base64,aGVsbG8=' });
    const sharedFile = await sharedFilePromise;
    assert.equal(sharedFile.name, 'note.txt');
    assert.equal(sharedFile.mime, 'text/plain');

    const videoLoadedPromise = waitForEvent(guest, 'video:loaded');
    host.emit('video:load', { videoId: 'dQw4w9WgXcQ' });
    const loaded = await videoLoadedPromise;
    assert.equal(loaded.mediaType, 'youtube');
    assert.equal(loaded.mediaId, 'dQw4w9WgXcQ');

    const playbackPromise = waitForEvent(guest, 'video:state');
    host.emit('video:state', {
      mediaType: 'youtube',
      mediaId: 'dQw4w9WgXcQ',
      videoId: 'dQw4w9WgXcQ',
      isPlaying: true,
      currentTime: 12
    });
    const playback = await playbackPromise;
    assert.equal(playback.isPlaying, true);
    assert.equal(playback.currentTime, 12);
  } finally {
    if (host) host.disconnect();
    if (guest) guest.disconnect();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
