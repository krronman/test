// Multi-user arena. No dependencies: only Node.js 16+ built-ins.
// Files needed in the same folder: server.js, arena.png, sprites.png
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
const STATIC = { '/arena.png': 'arena.png', '/sprites.png': 'sprites.png' };

/** id -> { id, nickname, color, joinedAt, x, y, dir, moving, conns:Set<res>, timer } */
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
    .map(({ id, nickname, color, joinedAt, x, y, dir, moving }) => ({
      id, nickname, color, joinedAt, x: Math.round(x), y: Math.round(y), dir, moving,
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
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
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
      id: crypto.randomUUID(),
      nickname: nick,
      color: COLORS[users.size % COLORS.length],
      joinedAt: Date.now(),
      x: FLOOR.cx + Math.cos(angle) * FLOOR.rx * r,
      y: FLOOR.cy + Math.sin(angle) * FLOOR.ry * r,
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
  const { id, x, y, dir, moving } = await readJson(req);
  const user = users.get(id);
  if (user && Number.isFinite(x) && Number.isFinite(y)) {
    const p = clampToFloor(x, y); // never trust the client
    user.x = p.x;
    user.y = p.y;
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
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' });
      res.end(buf);
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/join') return handleJoin(req, res);
  if (req.method === 'POST' && url.pathname === '/api/move') return handleMove(req, res);
  if (req.method === 'POST' && url.pathname === '/api/leave') return handleLeave(req, res);
  if (req.method === 'GET' && url.pathname === '/api/events') return handleEvents(req, res, url);
  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

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
  canvas { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: contain; }

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
  .row { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
  h2 { font: 600 .95rem var(--serif); margin: 14px 0 6px; padding-top: 12px; border-top: 1px solid var(--line); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: .92rem; word-break: break-all; }
  li i { flex: none; width: 10px; height: 10px; border-radius: 50%; }
  .empty { color: var(--muted); font-size: .85rem; }
  #hint { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); padding: 8px 16px;
    background: rgba(43,36,23,.82); color: #fff; border-radius: 20px; font-size: .92rem; transition: opacity .6s; }
  #hint.gone { opacity: 0; pointer-events: none; }
  @media (max-width: 560px) { #hud { width: 180px; padding: 10px; } }
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
  <div class="row"><span class="meta">This is you</span><button class="ghost" id="leave">Leave</button></div>
  <h2 id="othersTitle">Others in the arena</h2>
  <ul id="others"></ul>
</aside>
<div id="hint" hidden>Move with W A S D or the arrow keys</div>

<script>
  var $ = function (id) { return document.getElementById(id); };

  // ---- constants (image pixels) ----
  var W = 1536, H = 1024;
  var FLOOR = { cx: 768, cy: 500, rx: 575, ry: 345 };
  var SPEED = 270;            // pixels per second horizontally
  var VERT = 0.62;            // vertical moves slower: the floor is seen at an angle
  var FW = 144, FH = 208, SCALE = 0.6; // sprite cell size and draw scale
  // Sprite frames: 0 down, 1 down-right, 2 right, 3 up-right, 4 up, 5 up-left, 6 left, 7 down-left
  var DIR_TABLE = [[5, 4, 3], [6, -1, 2], [7, 0, 1]]; // [dy+1][dx+1]

  var canvas = $('game'), ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  var bg = new Image(); bg.src = '/arena.png';
  var sprites = new Image(); sprites.src = '/sprites.png';

  var me = null, es = null, others = {}, lastRoster = null;
  var keys = {}, playing = false, hintShown = false, lastSent = null, lastSentAt = 0;
  try { me = JSON.parse(sessionStorage.getItem('profile')); } catch (e) {}

  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  function show(mode) {
    $('join').hidden = mode !== 'join';
    $('game').hidden = mode !== 'game';
    $('hud').hidden = mode !== 'game';
    $('hint').hidden = mode !== 'game';
    playing = mode === 'game';
    if (mode === 'join') $('nick').focus();
  }

  function forgetMe() {
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
    me.moving = false;
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
      if (!o) { o = others[u.id] = { x: u.x, y: u.y }; }
      o.id = u.id; o.nickname = u.nickname; o.color = u.color;
      o.tx = u.x; o.ty = u.y; o.dir = u.dir; o.moving = u.moving;
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
    var s = Math.round(me.x) + ',' + Math.round(me.y) + ',' + me.dir + ',' + me.moving;
    if (s === lastSent || now - lastSentAt < 50) return;
    lastSent = s; lastSentAt = now;
    post('/api/move', { id: me.id, x: Math.round(me.x), y: Math.round(me.y), dir: me.dir, moving: me.moving }).catch(function () {});
  }

  // ---- input (event.code ignores the keyboard language, so it works with Korean IME too) ----
  var KEYMAP = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
                 KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
  window.addEventListener('keydown', function (e) {
    if (!playing || !KEYMAP[e.code]) return;
    keys[KEYMAP[e.code]] = true;
    e.preventDefault();
  });
  window.addEventListener('keyup', function (e) {
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
    var k = Math.min(1, dt * 14); // smooth other players toward their last known position
    Object.keys(others).forEach(function (id) {
      var o = others[id];
      o.x += (o.tx - o.x) * k;
      o.y += (o.ty - o.y) * k;
    });
  }

  function drawPlayer(p, t, isMe) {
    var bob = p.moving ? Math.abs(Math.sin(t / 85)) * 5 : 0;
    var w = FW * SCALE, h = FH * SCALE;
    ctx.fillStyle = 'rgba(40,30,10,0.22)';
    ctx.beginPath(); ctx.ellipse(p.x, p.y - 2, 24, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.drawImage(sprites, p.dir * FW, 0, FW, FH, p.x - w / 2, p.y - h - bob, w, h);

    ctx.font = '600 17px "Malgun Gothic", "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var tw = ctx.measureText(p.nickname).width + 22, ty = p.y - h - 14 - bob;
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
      var all = Object.keys(others).map(function (id) { return others[id]; });
      all.push(me);
      all.sort(function (a, b) { return a.y - b.y; }); // players lower on screen are drawn in front
      all.forEach(function (p) { drawPlayer(p, now, p === me); });
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

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