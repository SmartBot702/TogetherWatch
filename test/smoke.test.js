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
