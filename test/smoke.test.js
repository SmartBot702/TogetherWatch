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

test('VK Video and OK links are parsed into platform embed players', () => {
  const app = read('public/app.js');
  const server = read('server.js');
  assert.match(app, /mediaType:'vk',mediaId,mediaUrl:'https:\/\/vk\.com\/video_ext\.php/);
  assert.match(app, /mediaType:'ok',mediaId:match\[1\],mediaUrl:'https:\/\/ok\.ru\/videoembed\//);
  assert.match(app, /next\.mediaType==='vk'\|\|next\.mediaType==='ok'\|\|next\.mediaType==='rutube'/);
  assert.match(app, /frame\.title=next\.mediaType==='vk'\?'VK Video':next\.mediaType==='ok'\?'OK video':'Rutube video'/);
  assert.match(server, /if \(type === 'vk'\)/);
  assert.match(server, /if \(type === 'ok'\)/);
});

test('large movie upload uses acknowledged chunks and byte-range streaming', () => {
  const server = read('server.js');
  const app = read('public/app.js');
  const html = read('public/index.html');
  const auth = read('auth.js');
  assert.match(server, /socket\.on\('video:upload:start'/);
  assert.match(server, /socket\.on\('video:upload:chunk'/);
  assert.match(server, /socket\.on\('video:upload:end'/);
  assert.match(server, /'Accept-Ranges': 'bytes'/);
  assert.match(server, /res\.writeHead\(206, headers\)/);
  assert.match(server, /MAX_VIDEO_UPLOAD_BYTES/);
  assert.match(app, /file\.slice\(offset,Math\.min\(file\.size,offset\+chunkSize\)\)\.arrayBuffer\(\)/);
  assert.match(app, /mediaType:'uploaded'/);
  assert.match(html, /id="movieFileInput"/);
  assert.match(html, /id="sharedVideosList"/);
  assert.match(auth, /videos: Array\.isArray\(room\.videos\)/);
});

test('Rutube video links are parsed into a trusted embed player', () => {
  const app = read('public/app.js');
  const server = read('server.js');
  const html = read('public/index.html');
  assert.match(app, /mediaType:'rutube',mediaId:match\[1\],mediaUrl:'https:\/\/rutube\.ru\/play\/embed\//);
  assert.match(app, /next\.mediaType==='vk'\|\|next\.mediaType==='ok'\|\|next\.mediaType==='rutube'/);
  assert.match(app, /'Rutube video'/);
  assert.match(server, /if \(type === 'rutube'\)/);
  assert.match(server, /https:\/\/rutube\.ru\/play\/embed\//);
  assert.match(html, /<option value="rutube">Rutube<\/option>/);
});

test('all supported video players advance the queue at most once per ended media item', () => {
  const app = read('public/app.js');
  assert.match(app, /function advanceQueueOnEnded\(\)/);
  assert.match(app, /if\(!isHost\|\|!roomId\|\|!media\)return/);
  assert.match(app, /if\(endedQueueAdvanceKey===key\)return/);
  assert.match(app, /onStateChange:e=>\{if\(remote\|\|Date\.now\(\)<remoteUntil\)return;if\(e\.data===YT\.PlayerState\.ENDED\)\{advanceQueueOnEnded\(\);return\}/);
  assert.match(app, /player\.on\('ended',advanceQueueOnEnded\)/);
  assert.match(app, /video\.addEventListener\('ended',advanceQueueOnEnded\)/);
});

test('WebRTC client bounds pending ICE candidates before remote description', () => {
  const app = read('public/app.js');
  assert.match(app, /if\(q\.length>=128\)q\.shift\(\)/);
  assert.match(app, /candidate\.candidate\.length>4096/);
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
    host.emit('room:create', { name: 'HostTest', title: 'Realtime test room', isPublic: true });
    const hostRoom = await hostJoinedPromise;
    assert.match(hostRoom.roomId, /^[A-Z0-9]{6}$/);
    const publicRoomsResponse = await fetch(url + '/api/rooms/public');
    const publicRooms = await publicRoomsResponse.json();
    assert.ok(publicRooms.rooms.some(room => room.id === hostRoom.roomId), 'public room should appear in discovery');

    const guestJoinedPromise = waitForEvent(guest, 'room:joined');
    guest.emit('room:join', { roomId: hostRoom.roomId, name: 'GuestTest' });
    const guestRoom = await guestJoinedPromise;
    assert.equal(guestRoom.roomId, hostRoom.roomId);

    // Upload a video in binary chunks, then verify the shared file supports HTTP byte ranges.
    const sampleVideo = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const startUpload = await new Promise(resolve => host.emit('video:upload:start', { name: 'sample.mp4', size: sampleVideo.length, mime: 'video/mp4' }, resolve));
    assert.equal(startUpload.ok, true, startUpload.error);
    const chunkAck = await new Promise(resolve => host.emit('video:upload:chunk', { uploadId: startUpload.uploadId, index: 0, data: sampleVideo }, resolve));
    assert.equal(chunkAck.ok, true, chunkAck.error);
    const uploadedPromise = waitForEvent(guest, 'video:uploaded');
    const finishUpload = await new Promise(resolve => host.emit('video:upload:end', { uploadId: startUpload.uploadId }, resolve));
    assert.equal(finishUpload.ok, true, finishUpload.error);
    const sharedMovie = await uploadedPromise;
    assert.equal(sharedMovie.id, finishUpload.file.id);
    const rangedMovie = await fetch(url + sharedMovie.url, { headers: { Range: 'bytes=2-5' } });
    assert.equal(rangedMovie.status, 206, 'uploaded movies must support seeking through HTTP byte ranges');
    assert.deepEqual(Buffer.from(await rangedMovie.arrayBuffer()), Buffer.from([2, 3, 4, 5]));
    const loadedMoviePromise = waitForEvent(guest, 'video:loaded');
    host.emit('video:load', { mediaType: 'uploaded', mediaId: sharedMovie.id, ext: sharedMovie.ext });
    const loadedMovie = await loadedMoviePromise;
    assert.equal(loadedMovie.mediaType, 'file');
    assert.equal(loadedMovie.mediaUrl, sharedMovie.url);

    // Malformed WebRTC signaling packets should be ignored, not crash the server.
    host.emit('rtc:offer', null);
    host.emit('rtc:answer', null);
    host.emit('rtc:ice', null);
    host.emit('rtc:offer', { to: guest.id, offer: { type: 'offer', sdp: 'x'.repeat(200001) } });
    const healthAfterBadRtc = await fetch(url + '/health');
    assert.equal(healthAfterBadRtc.status, 200, 'server should remain healthy after malformed RTC packets');

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

    observer = connect(url, { transports: ['websocket'], reconnection: false, timeout: 5000 });
    await waitForEvent(observer, 'connect');
    const observerJoinedPromise = waitForEvent(observer, 'room:joined');
    observer.emit('room:join', { roomId: hostRoom.roomId, name: 'ObserverTest' });
    const observerRoom = await observerJoinedPromise;
    assert.equal(observerRoom.activeActivity, 'board', 'new members should receive the room’s current shared section');

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

    // Do not broadcast media URLs that target loopback/private services.
    const privateMediaError = waitForEvent(host, 'room:error');
    host.emit('video:load', { mediaType: 'file', mediaUrl: 'http://127.0.0.1:8080/private.mp4' });
    assert.match(await privateMediaError, /ochiq internet manzili/);
    const privateQueueError = waitForEvent(guest, 'room:error');
    guest.emit('queue:add', { mediaType: 'file', mediaUrl: 'http://localhost/private.mp4' });
    assert.match(await privateQueueError, /ochiq internet manzili/);

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

    const driveLoadedPromise = waitForEvent(guest, 'video:loaded');
    host.emit('video:load', { mediaType: 'gdrive', mediaId: '1AbCdEfGhIjKlmNopQrStUv' });
    const driveVideo = await driveLoadedPromise;
    assert.equal(driveVideo.mediaType, 'gdrive');
    assert.equal(driveVideo.mediaUrl, 'https://drive.google.com/file/d/1AbCdEfGhIjKlmNopQrStUv/preview');

    // Reject string booleans and string timestamps instead of coercing them.
    let malformedPlaybackCount = 0;
    const countMalformedPlayback = () => { malformedPlaybackCount++; };
    host.on('video:state', countMalformedPlayback);
    guest.emit('video:state', {
      mediaType: 'youtube', mediaId: 'dQw4w9WgXcQ',
      isPlaying: 'false', currentTime: '42'
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    host.off('video:state', countMalformedPlayback);
    assert.equal(malformedPlaybackCount, 0, 'malformed playback state must not be broadcast');

    // A burst of chat messages is capped per participant to prevent room spam.
    let burstMessages = 0;
    const countBurst = message => { if (message.text.startsWith('burst-check-')) burstMessages++; };
    guest.on('chat:message', countBurst);
    const rateErrorPromise = waitForEvent(observer, 'room:error');
    for (let i = 0; i < 9; i++) observer.emit('chat:send', { text: 'burst-check-' + i });
    const rateError = await rateErrorPromise;
    assert.match(rateError, /tez-tez xabar/);
    await new Promise(resolve => setTimeout(resolve, 150));
    guest.off('chat:message', countBurst);
    assert.equal(burstMessages, 8, 'only eight chat messages should pass in a five-second window');

    // Only the host may advance the shared queue; after host handoff the new host can.
    const queueOnePromise = waitForEvent(guest, 'queue:updated');
    host.emit('queue:add', { mediaType: 'youtube', mediaId: 'M7lc1UVf-VE' });
    const queueOne = await queueOnePromise;
    assert.equal(queueOne.length, 1);
    const queueTwoPromise = waitForEvent(guest, 'queue:updated');
    host.emit('queue:add', { mediaType: 'youtube', mediaId: 'dQw4w9WgXcQ' });
    const queueTwo = await queueTwoPromise;
    assert.equal(queueTwo.length, 2);

    let loadedAfterUnauthorizedNext = false;
    const unauthorizedLoadListener = () => { loadedAfterUnauthorizedNext = true; };
    guest.on('video:loaded', unauthorizedLoadListener);
    guest.emit('queue:next');
    await new Promise(resolve => setTimeout(resolve, 100));
    guest.off('video:loaded', unauthorizedLoadListener);
    assert.equal(loadedAfterUnauthorizedNext, false, 'non-host cannot advance the queue');

    const promotedPromise = waitForEvent(guest, 'room:role');
    host.disconnect();
    const promoted = await promotedPromise;
    assert.equal(promoted.isHost, true, 'the remaining member should become host when the host disconnects');

    const nextVideoPromise = waitForEvent(guest, 'video:loaded');
    guest.emit('queue:next');
    const nextVideo = await nextVideoPromise;
    assert.equal(nextVideo.mediaType, 'youtube');
    assert.equal(nextVideo.mediaId, 'M7lc1UVf-VE', 'new host should be able to advance the persisted queue');
  } finally {
    if (host) host.disconnect();
    if (guest) guest.disconnect();
    if (observer) observer.disconnect();
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
