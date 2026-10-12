// Multi-user arena. No dependencies: only Node.js 16+ built-ins.
// Files needed in the same folder: server.js, arena.png, sprites.png, inventory.png, bag.png, shop.png, shop-panel.png
// Run:  node server.js   ->  open http://localhost:3000
// Real-time updates use Server-Sent Events (server -> clients) + POST (client -> server).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const GRACE_MS = 4000; // keeps a user alive across page refreshes
const TICK_MS = 50;    // position broadcast rate (20 per second)
const COLORS = ['#2f6f5e', '#b4532a', '#3b5bdb', '#9c36b5', '#c2255c', '#e67700', '#0b7285', '#5c7cfa'];

// Walkable floor of the arena image (1536x1024), an ellipse in image pixels.
const FLOOR = { cx: 768, cy: 500, rx: 575, ry: 345 };
const STATIC = {
  '/arena.png': 'arena.png', '/sprites.png': 'sprites.png',
  '/inventory.png': 'inventory.png', '/bag.png': 'bag.png',
  '/shop.png': 'shop.png', '/shop-panel.png': 'shop-panel.png',
};

/** id -> { id, nickname, color, joinedAt, x, y, z, dir, moving, conns:Set<res>, timer } */
const users = new Map();
let dirty = false;

function clampToFloor(x, y) {
  const nx = (x - FLOOR.cx) / FLOOR.rx;
  const ny = (y - FLOOR.cy) / FLOOR.ry;
  const d = Math.hypot(nx, ny);
  if (d <= 1) return { x, y };
  return { x: FLOOR.cx + (nx / d) * FLOOR.rx, y: FLOOR.cy + (ny / d) * FLOOR.ry };
}

const onlineUsers = () =>
  [...users.values()]
    .filter((u) => u.conns.size > 0)
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((u) => ({
      id: u.id, nickname: u.nickname, color: u.color, joinedAt: u.joinedAt,
      x: Math.round(u.x), y: Math.round(u.y), z: Math.round(u.z), dir: u.dir, moving: u.moving,
    }));

function broadcast() {
  const msg = `event: users\ndata: ${JSON.stringify(onlineUsers())}\n\n`;
  for (const u of users.values()) for (const res of u.conns) res.write(msg);
}

setInterval(() => {
  if (dirty) { dirty = false; broadcast(); }
}, TICK_MS);

function scheduleRemoval(user) {
  clearTimeout(user.timer);
  user.timer = setTimeout(() => {
    if (user.conns.size === 0) {
      users.delete(user.id);
      dirty = true;
    }
  }, GRACE_MS);
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4096) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({}); }
    });
  });
}

async function handleJoin(req, res) {
  const { nickname, id } = await readJson(req);
  const nick = String(nickname || '').trim();
  if (nick.length < 2 || nick.length > 16 || !/^[\p{L}\p{N}_\- ]+$/u.test(nick)) {
    return json(res, 400, { error: 'Use 2–16 letters, numbers, spaces, - or _.' });
  }
  const taken = [...users.values()].some(
    (u) => u.id !== id && u.nickname.toLowerCase() === nick.toLowerCase()
  );
  if (taken) return json(res, 409, { error: 'That nickname is already in use. Pick another.' });

  let user = id && users.get(id);
  if (user) {
    user.nickname = nick;
  } else {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 0.6; // spawn somewhere near the middle
    user = {
      id: crypto.randomBytes(16).toString('hex'),
      nickname: nick,
      color: COLORS[users.size % COLORS.length],
      joinedAt: Date.now(),
      x: FLOOR.cx + Math.cos(angle) * FLOOR.rx * r,
      y: FLOOR.cy + Math.sin(angle) * FLOOR.ry * r,
      z: 0,   // height above the ground while jumping
      dir: 0, // 0 = facing the viewer
      moving: false,
      conns: new Set(),
      timer: null,
    };
    users.set(user.id, user);
  }
  scheduleRemoval(user); // removed unless an event stream connects soon
  const { conns, timer, ...profile } = user;
  json(res, 200, profile);
  dirty = true;
}

async function handleMove(req, res) {
  const { id, x, y, z, dir, moving } = await readJson(req);
  const user = users.get(id);
  if (user && Number.isFinite(x) && Number.isFinite(y)) {
    const p = clampToFloor(x, y); // never trust the client
    user.x = p.x;
    user.y = p.y;
    user.z = Number.isFinite(z) ? Math.min(150, Math.max(0, z)) : 0;
    if (Number.isInteger(dir) && dir >= 0 && dir <= 7) user.dir = dir;
    user.moving = !!moving;
    dirty = true;
  }
  res.writeHead(204);
  res.end();
}

function handleEvents(req, res, url) {
  const user = users.get(url.searchParams.get('id'));
  if (!user) return json(res, 404, { error: 'Unknown user' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  clearTimeout(user.timer);
  user.conns.add(res);
  res.write(`event: users\ndata: ${JSON.stringify(onlineUsers())}\n\n`);
  dirty = true;

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    user.conns.delete(res);
    if (user.conns.size === 0) scheduleRemoval(user);
  });
}

async function handleLeave(req, res) {
  const { id } = await readJson(req);
  const user = users.get(id);
  if (user) {
    for (const c of user.conns) c.end();
    users.delete(id);
    dirty = true;
  }
  json(res, 200, { ok: true });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (req.method === 'GET' && STATIC[url.pathname]) {
    return fs.readFile(path.join(__dirname, STATIC[url.pathname]), (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Missing file next to server.js: ' + STATIC[url.pathname]);
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/join') return handleJoin(req, res);
  if (req.method === 'POST' && url.pathname === '/api/move') return handleMove(req, res);
  if (req.method === 'POST' && url.pathname === '/api/leave') return handleLeave(req, res);
  if (req.method === 'GET' && url.pathname === '/api/events') return handleEvents(req, res, url);
  json(res, 404, { error: 'Not found' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Close the other server (Ctrl+C in its terminal) or use another port:`);
    console.error('  Windows PowerShell:  $env:PORT=3001; node server.js');
    console.error('  Mac / Linux:         PORT=3001 node server.js');
  } else {
    console.error(err);
  }
  process.exit(1);
});

for (const file of Object.values(STATIC)) {
  if (!fs.existsSync(path.join(__dirname, file))) console.warn('Warning: missing file next to server.js: ' + file);
}
server.listen(PORT, () => console.log(`Server running: http://localhost:${PORT}`));

// ---------------------------------------------------------------- client page
const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Marble Arena</title>
<style>
  :root {
    --ivory: #fbf7ec; --ink: #2b2417; --muted: #7b705b; --gold: #b8892b; --line: #e2d6b8; --danger: #a8281f;
    --serif: "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif;
    --sans: "Avenir Next", "Segoe UI", "Malgun Gothic", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #c9d7ee; color: var(--ink); font: 16px/1.5 var(--sans); overflow: hidden; }
  [hidden] { display: none !important; }
  #game { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: contain; }

  #join { position: fixed; inset: 0; display: grid; place-items: center; padding: 20px;
    background: linear-gradient(rgba(251,247,236,.55), rgba(251,247,236,.55)), url(/arena.png) center / cover; }
  .card { width: min(420px, 100%); background: var(--ivory); border: 1px solid var(--gold); border-radius: 6px;
    padding: 28px; box-shadow: 0 0 0 4px rgba(251,247,236,.7), 0 18px 40px rgba(60,45,10,.25); }
  h1 { font: 600 1.8rem/1.2 var(--serif); margin: 0 0 6px; }
  .sub { margin: 0 0 20px; color: var(--muted); }
  form { display: flex; gap: 10px; flex-wrap: wrap; }
  input { flex: 1 1 180px; padding: 12px 14px; font: inherit; color: var(--ink); background: #fff;
    border: 1px solid var(--line); border-radius: 4px; }
  button { padding: 12px 20px; font: inherit; font-weight: 600; color: #fff; background: var(--gold);
    border: 0; border-radius: 4px; cursor: pointer; }
  button.ghost { background: none; color: var(--muted); border: 1px solid var(--line); padding: 6px 12px; font-weight: 500; font-size: .85rem; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .error { color: var(--danger); min-height: 1.5em; margin: 10px 0 0; font-size: .92rem; }

  #hud { position: fixed; top: 14px; left: 14px; width: 240px; max-height: calc(100% - 28px); overflow: auto;
    background: rgba(251,247,236,.94); border: 1px solid var(--gold); border-radius: 6px; padding: 14px; }
  .me { display: flex; align-items: center; gap: 12px; }
  .badge { flex: none; width: 40px; height: 40px; border-radius: 50%; color: #fff; font-weight: 700;
    display: grid; place-items: center; font-size: 1.05rem; }
  .me .name { font: 600 1.1rem/1.2 var(--serif); word-break: break-all; }
  .meta { color: var(--muted); font-size: .8rem; }
  .row { display: flex; align-items: center; justify-content: flex-end; margin-top: 12px; }
  h2 { font: 600 .95rem var(--serif); margin: 14px 0 6px; padding-top: 12px; border-top: 1px solid var(--line); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: .92rem; word-break: break-all; }
  li i { flex: none; width: 10px; height: 10px; border-radius: 50%; }
  .empty { color: var(--muted); font-size: .85rem; word-break: normal; }
  #hint { position: fixed; bottom: 112px; left: 50%; transform: translateX(-50%); padding: 8px 16px;
    background: rgba(43,36,23,.82); color: #fff; border-radius: 20px; font-size: .92rem; transition: opacity .6s; white-space: nowrap; }
  #hint.gone { opacity: 0; pointer-events: none; }
  @media (max-width: 560px) { #hud { width: 180px; padding: 10px; } #hint { white-space: normal; width: 90%; text-align: center; } }

  #bagBtn { position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%); width: 96px; height: 72px; padding: 0;
    border: 0; background: none; cursor: pointer; transition: transform .12s; }
  #bagBtn:hover { transform: translateX(-50%) translateY(-3px) scale(1.06); }
  #bagBtn:active { transform: translateX(-50%) scale(.96); }
  #bagBtn img { display: block; width: 100%; height: 100%; object-fit: contain; pointer-events: none;
    filter: drop-shadow(0 4px 6px rgba(40,25,5,.45)); }
  #bagBtn .key, #shopBtn .key { position: absolute; right: 2px; bottom: 2px; min-width: 21px; height: 21px; padding: 0 5px; display: grid;
    place-items: center; background: rgba(43,36,23,.92); color: #fff; border: 1px solid var(--gold); border-radius: 5px;
    font: 700 .78rem/1 var(--sans); }

  #invWrap { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(20,14,4,.5); }
  #inv { width: min(94vw, calc(94vh * 1.606), 960px); aspect-ratio: 1349 / 840;
    background: url(/inventory.png) center / 100% 100% no-repeat; }

  #shopBtn { position: fixed; right: 18px; top: 50%; transform: translateY(-50%); width: 80px; height: 80px; padding: 0;
    border: 0; background: none; cursor: pointer; transition: transform .12s; }
  #shopBtn:hover { transform: translateY(-50%) scale(1.08); }
  #shopBtn:active { transform: translateY(-50%) scale(.96); }
  #shopBtn img { display: block; width: 100%; height: 100%; object-fit: contain; pointer-events: none;
    filter: drop-shadow(0 4px 6px rgba(40,25,5,.45)); }

  #shopWrap { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(20,14,4,.5); }
  #shop { position: relative; width: min(94vw, calc(94vh * 1.5682), 1000px); aspect-ratio: 1391 / 887;
    background: url(/shop-panel.png) center / 100% 100% no-repeat; }
  /* invisible button laid over the X drawn in the panel image */
  #shopClose { position: absolute; left: 89.36%; top: 6.54%; width: 5.9%; height: 9.02%; padding: 0; border: 0;
    border-radius: 6px; background: transparent; cursor: pointer; }
  #shopClose:hover { background: rgba(255,240,200,.25); }
  #shopClose:focus-visible { outline: 2px solid #fff; }
</style>
</head>
<body>
<section id="join" hidden>
  <div class="card">
    <h1>Enter the arena</h1>
    <p class="sub">Pick a nickname. Everyone in the arena will see it.</p>
    <form id="joinForm">
      <input id="nick" maxlength="16" autocomplete="off" placeholder="Your nickname" aria-label="Nickname" required>
      <button type="submit">Enter</button>
    </form>
    <p class="error" id="err" role="alert"></p>
  </div>
</section>

<canvas id="game" width="1536" height="1024" hidden></canvas>

<aside id="hud" hidden>
  <div class="me">
    <div class="badge" id="meBadge"></div>
    <div>
      <div class="name" id="meName"></div>
      <div class="meta" id="meMeta"></div>
    </div>
  </div>
  <div class="row"><button class="ghost" id="leave">Leave</button></div>
  <h2 id="othersTitle">Others in the arena</h2>
  <ul id="others"></ul>
</aside>

<button id="bagBtn" type="button" tabindex="-1" aria-label="Open inventory (X)" hidden><img src="/bag.png" alt=""><span class="key">X</span></button>
<button id="shopBtn" type="button" tabindex="-1" aria-label="Open shop (Z)" hidden><img src="/shop.png" alt=""><span class="key">Z</span></button>
<div id="hint" hidden>W A S D move &middot; Space jump &middot; X inventory &middot; Z shop</div>
<div id="invWrap" hidden><div id="inv"></div></div>
<div id="shopWrap" hidden>
  <div id="shop" role="dialog" aria-label="Shop">
    <button id="shopClose" type="button" aria-label="Close shop"></button>
  </div>
</div>

<script>
  var $ = function (id) { return document.getElementById(id); };

  // ---- constants (image pixels) ----
  var W = 1536, H = 1024;
  var FLOOR = { cx: 768, cy: 500, rx: 575, ry: 345 };
  var SPEED = 270;            // pixels per second horizontally
  var VERT = 0.62;            // vertical moves slower: the floor is seen at an angle
  var JUMP_V = 470, GRAVITY = 1900;
  var FW = 144, FH = 208, SCALE = 0.6; // sprite cell size and draw scale
  // Sprite frames: 0 down, 1 down-right, 2 right, 3 up-right, 4 up, 5 up-left, 6 left, 7 down-left
  var DIR_TABLE = [[5, 4, 3], [6, -1, 2], [7, 0, 1]]; // [dy+1][dx+1]
  // The barred gate at the top of the arena image
  var DOOR = { cx: 768, x0: 731, x1: 805, y0: 6, y1: 74 };
  var KO_FONT = '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans CJK KR", "Noto Sans KR", sans-serif';

  var canvas = $('game'), ctx = canvas.getContext('2d');
  if (!ctx.roundRect) { // older browsers
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      this.moveTo(x + r, y);
      this.arcTo(x + w, y, x + w, y + h, r); this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r); this.arcTo(x, y, x + w, y, r);
      this.closePath();
    };
  }
  ctx.imageSmoothingQuality = 'high';
  var bg = new Image(); bg.src = '/arena.png';
  var sprites = new Image(); sprites.src = '/sprites.png';

  var me = null, es = null, others = {}, lastRoster = null;
  var keys = {}, playing = false, invOpen = false, shopOpen = false, hintShown = false, lastSent = null, lastSentAt = 0;
  try { me = JSON.parse(sessionStorage.getItem('profile')); } catch (e) {}

  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  function show(mode) {
    $('join').hidden = mode !== 'join';
    $('game').hidden = mode !== 'game';
    $('hud').hidden = mode !== 'game';
    $('hint').hidden = mode !== 'game';
    $('bagBtn').hidden = mode !== 'game';
    $('shopBtn').hidden = mode !== 'game';
    playing = mode === 'game';
    if (mode === 'join') $('nick').focus();
  }

  function forgetMe() {
    toggleInv(false);
    toggleShop(false);
    me = null; sessionStorage.removeItem('profile');
    show('join');
  }

  async function join(nickname) {
    var r = await post('/api/join', { nickname: nickname, id: me && me.id });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error);
    var keep = me && me.id === data.id && isFinite(me.x) ? me : null; // keep local position when re-joining
    me = data;
    if (keep) { me.x = keep.x; me.y = keep.y; me.dir = keep.dir; }
    sessionStorage.setItem('profile', JSON.stringify({ id: me.id, nickname: me.nickname, color: me.color, joinedAt: me.joinedAt }));
    $('meBadge').textContent = me.nickname.charAt(0).toUpperCase();
    $('meBadge').style.background = me.color;
    $('meName').textContent = me.nickname;
    $('meMeta').textContent = 'Joined at ' + new Date(me.joinedAt).toLocaleTimeString();
    me.moving = false; me.z = 0; me.vz = 0;
    connect();
    show('game');
    if (!hintShown) { hintShown = true; $('hint').classList.remove('gone'); }
  }

  // ---- networking ----
  function connect() {
    if (es) es.close();
    others = {}; lastRoster = null;
    es = new EventSource('/api/events?id=' + encodeURIComponent(me.id));
    es.addEventListener('users', function (e) { onUsers(JSON.parse(e.data)); });
    es.onerror = function () {
      // Server forgot us (e.g. it restarted): the stream is closed, so join again quietly.
      if (es.readyState === EventSource.CLOSED) join(me.nickname).catch(forgetMe);
    };
  }

  function onUsers(list) {
    var seen = {};
    list.forEach(function (u) {
      if (u.id === me.id) return;
      seen[u.id] = true;
      var o = others[u.id];
      if (!o) { o = others[u.id] = { x: u.x, y: u.y, z: u.z || 0 }; }
      o.id = u.id; o.nickname = u.nickname; o.color = u.color;
      o.tx = u.x; o.ty = u.y; o.tz = u.z; o.dir = u.dir; o.moving = u.moving;
    });
    Object.keys(others).forEach(function (id) { if (!seen[id]) delete others[id]; });

    var roster = Object.keys(others).sort().map(function (id) { return id + others[id].nickname; }).join('|');
    if (roster === lastRoster) return;
    lastRoster = roster;
    var ul = $('others');
    ul.replaceChildren();
    var ids = Object.keys(others);
    $('othersTitle').textContent = 'Others in the arena (' + ids.length + ')';
    if (!ids.length) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No one else yet. Open this page in another browser.';
      ul.append(li);
    }
    ids.forEach(function (id) {
      var li = document.createElement('li');
      var dot = document.createElement('i');
      dot.style.background = others[id].color;
      var name = document.createElement('span');
      name.textContent = others[id].nickname;
      li.append(dot, name);
      ul.append(li);
    });
  }

  function sendState(now) {
    var s = Math.round(me.x) + ',' + Math.round(me.y) + ',' + Math.round(me.z) + ',' + me.dir + ',' + me.moving;
    if (s === lastSent || now - lastSentAt < 50) return;
    lastSent = s; lastSentAt = now;
    post('/api/move', { id: me.id, x: Math.round(me.x), y: Math.round(me.y), z: Math.round(me.z),
                        dir: me.dir, moving: me.moving }).catch(function () {});
  }

  // ---- input (event.code ignores the keyboard language, so it works with Korean IME too) ----
  var KEYMAP = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
                 KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
  window.addEventListener('keydown', function (e) {
    if (!playing) return;
    if (e.code === 'Escape') { if (shopOpen) toggleShop(false); else if (invOpen) toggleInv(false); return; }
    if (e.code === 'KeyZ') { if (!e.repeat) toggleShop(); e.preventDefault(); return; }
    if (shopOpen) return; // the shop is open: no walking or other keys until it is closed
    if (e.code === 'KeyX') { if (!e.repeat) toggleInv(); e.preventDefault(); return; }
    if (invOpen) return;
    if (e.code === 'Space') { keys.jump = true; e.preventDefault(); return; }
    if (!KEYMAP[e.code]) return;
    keys[KEYMAP[e.code]] = true;
    e.preventDefault();
  });
  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space') keys.jump = false;
    if (KEYMAP[e.code]) keys[KEYMAP[e.code]] = false;
  });
  window.addEventListener('blur', function () { keys = {}; });

  // ---- game loop ----
  function update(dt) {
    var dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    var dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    me.moving = dx !== 0 || dy !== 0;
    if (me.moving) {
      var len = Math.hypot(dx, dy);
      me.x += (dx / len) * SPEED * dt;
      me.y += (dy / len) * SPEED * VERT * dt;
      me.dir = DIR_TABLE[dy + 1][dx + 1];
      // stay inside the elliptical floor (slides along the edge)
      var nx = (me.x - FLOOR.cx) / FLOOR.rx, ny = (me.y - FLOOR.cy) / FLOOR.ry, d = Math.hypot(nx, ny);
      if (d > 1) { me.x = FLOOR.cx + (nx / d) * FLOOR.rx; me.y = FLOOR.cy + (ny / d) * FLOOR.ry; }
      if (!$('hint').classList.contains('gone')) $('hint').classList.add('gone');
    }
    // jump: Space launches the character into the air, gravity brings it back down
    if (keys.jump && me.z <= 0) { me.vz = JUMP_V; me.z = 0.01; }
    if (me.z > 0) {
      me.vz -= GRAVITY * dt; me.z += me.vz * dt;
      if (me.z <= 0) { me.z = 0; me.vz = 0; }
    }
    var k = Math.min(1, dt * 14); // smooth other players toward their last known position
    Object.keys(others).forEach(function (id) {
      var o = others[id];
      o.x += (o.tx - o.x) * k;
      o.y += (o.ty - o.y) * k;
      o.z += ((o.tz || 0) - (o.z || 0)) * k;
    });
  }

  // "싱글 플레이" written on the barred gate at the top of the arena, sized to the width of the door
  var doorSize = 0;
  function drawDoorSign() {
    if (!doorSize) {
      ctx.font = '800 100px ' + KO_FONT;
      doorSize = 100 * (DOOR.x1 - DOOR.x0 - 10) / ctx.measureText('플레이').width;
    }
    ctx.save();
    ctx.fillStyle = 'rgba(14,12,26,0.55)'; // dark plate so the text reads against the gate bars
    ctx.beginPath(); ctx.roundRect(DOOR.x0, DOOR.y0, DOOR.x1 - DOOR.x0, DOOR.y1 - DOOR.y0, 10); ctx.fill();
    ctx.font = '800 ' + doorSize + 'px ' + KO_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(3, doorSize * 0.16);
    ctx.strokeStyle = 'rgba(20,12,2,0.9)'; ctx.fillStyle = '#ffe3a1';
    var cy = (DOOR.y0 + DOOR.y1) / 2 + 3, lh = doorSize * 1.08;
    [['싱글', cy - lh / 2], ['플레이', cy + lh / 2]].forEach(function (line) {
      ctx.strokeText(line[0], DOOR.cx, line[1]);
      ctx.fillText(line[0], DOOR.cx, line[1]);
    });
    ctx.restore();
  }

  function drawPlayer(p, t, isMe) {
    var lift = p.z || 0;
    var bob = (p.moving && lift < 1) ? Math.abs(Math.sin(t / 85)) * 5 : 0;
    var raise = bob + lift, w = FW * SCALE, h = FH * SCALE;
    var sh = 1 - Math.min(0.45, lift / 140); // the shadow shrinks while the character is in the air
    ctx.fillStyle = 'rgba(40,30,10,' + (0.22 * sh).toFixed(3) + ')';
    ctx.beginPath(); ctx.ellipse(p.x, p.y - 2, 24 * sh, 8 * sh, 0, 0, Math.PI * 2); ctx.fill();
    ctx.drawImage(sprites, p.dir * FW, 0, FW, FH, p.x - w / 2, p.y - h - raise, w, h);

    ctx.font = '600 17px "Malgun Gothic", "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var tw = ctx.measureText(p.nickname).width + 22, ty = p.y - h - 14 - raise;
    ctx.fillStyle = isMe ? 'rgba(184,137,43,0.95)' : 'rgba(43,36,23,0.78)';
    ctx.beginPath(); ctx.roundRect(p.x - tw / 2, ty - 13, tw, 26, 13); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(p.nickname, p.x, ty + 1);
  }

  var prev = performance.now();
  function loop(now) {
    var dt = Math.min(0.05, (now - prev) / 1000); prev = now;
    if (playing && bg.complete && sprites.complete) {
      update(dt);
      sendState(now);
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(bg, 0, 0, W, H);
      drawDoorSign();
      var all = Object.keys(others).map(function (id) { return others[id]; });
      all.push(me);
      all.sort(function (a, b) { return a.y - b.y; }); // players lower on screen are drawn in front
      all.forEach(function (p) { drawPlayer(p, now, p === me); });
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---- inventory (an empty panel for now): X key, the bag button, Esc or a click outside closes it ----
  function toggleInv(open) {
    if (open === undefined) open = !invOpen;
    if (open && !playing) return;
    if (open) toggleShop(false);
    invOpen = open; keys = {};
    $('invWrap').hidden = !open;
    if (open) $('hint').classList.add('gone');
  }

  // ---- shop pop-up: opened with the shop button, closed with the X drawn in the panel (or Esc) ----
  function toggleShop(open) {
    if (open === undefined) open = !shopOpen;
    if (open && !playing) return;
    if (open) toggleInv(false);
    shopOpen = open; keys = {};
    $('shopWrap').hidden = !open;
    if (open) $('hint').classList.add('gone');
  }
  $('invWrap').addEventListener('mousedown', function (e) { if (e.target === this) toggleInv(false); });
  // never let the button take keyboard focus, otherwise pressing Space would also "click" it
  $('bagBtn').addEventListener('mousedown', function (e) { e.preventDefault(); });
  $('bagBtn').addEventListener('click', function () { toggleInv(); });
  $('shopBtn').addEventListener('mousedown', function (e) { e.preventDefault(); });
  $('shopBtn').addEventListener('click', function () { toggleShop(); });
  $('shopClose').addEventListener('click', function () { toggleShop(false); });

  // ---- UI events ----
  $('joinForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    $('err').textContent = '';
    try { await join($('nick').value); } catch (err) { $('err').textContent = err.message; }
  });

  $('leave').addEventListener('click', async function () {
    if (es) es.close();
    await post('/api/leave', { id: me.id });
    keys = {};
    $('nick').value = '';
    forgetMe();
  });

  // A refresh keeps the profile (stored per tab); every new tab asks for its own nickname.
  if (me && me.nickname) join(me.nickname).catch(forgetMe);
  else show('join');
</script>
</body>
</html>`;
