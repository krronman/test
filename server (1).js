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
const STATIC = {
  '/arena.png': 'arena.png', '/sprites.png': 'sprites.png',
  '/items.png': 'items.png', '/inventory.png': 'inventory.png', '/bag.png': 'bag.png',
};

/** id -> { id, nickname, color, joinedAt, x, y, dir, moving, conns:Set<res>, timer } */
const users = new Map();
let dirty = false;

// ---- combat settings ----
const MAX_HP = 100;
const SWORD_DAMAGE = 15;
const ATTACK_COOLDOWN = 400; // ms between swings
const ATTACK_RANGE = 105;    // reach, measured on the floor plane
const VERT = 0.62;           // the floor is drawn at an angle: vertical screen distance is compressed by this
// Facing vector of each of the 8 sprite frames, in floor-plane units (x right, y toward the viewer).
const FACE = [[0, 1], [0.707, 0.707], [1, 0], [0.707, -0.707], [0, -1], [-0.707, -0.707], [-1, 0], [-0.707, 0.707]];

// A random point just inside the edge of the arena floor.
function edgePoint() {
  const a = Math.random() * Math.PI * 2;
  return { x: FLOOR.cx + Math.cos(a) * FLOOR.rx * 0.96, y: FLOOR.cy + Math.sin(a) * FLOOR.ry * 0.96 };
}

function respawn(u) {
  const p = edgePoint();
  u.x = p.x; u.y = p.y;
  u.hp = MAX_HP;
  u.rs += 1;      // lets clients tell "teleported by the server" apart from normal movement
  u.dir = 0; u.moving = false; u.z = 0;
}

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
      x: Math.round(u.x), y: Math.round(u.y), dir: u.dir, moving: u.moving,
      equip: u.bag.eq.slice(0, 2), // [main weapon, sub weapon] so everyone can draw them
      hp: u.hp, z: Math.round(u.z), rs: u.rs,
    }));

function broadcast() {
  const msg = `event: users\ndata: ${JSON.stringify(onlineUsers())}\n\n`;
  for (const u of users.values()) for (const res of u.conns) res.write(msg);
}

setInterval(() => {
  if (dirty) { dirty = false; broadcast(); }
}, TICK_MS);

function sendAll(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const u of users.values()) for (const res of u.conns) res.write(msg);
}

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

// ---- inventory: the server owns it, so items can't be duplicated by a modified client
const ITEM_IDS = new Set(['sword', 'shield']);
const newBag = () => ({
  inv: ['sword', 'shield', ...Array(18).fill(null)], // 5 x 4 grid
  hot: Array(9).fill(null),                          // hotbar
  eq: [null, null, null, null],                      // 0 main weapon, 1 sub weapon, 2-3 locked
});

function slotRef(user, key) {
  const m = /^(inv|hot|eq):(\d+)$/.exec(String(key));
  if (!m) return null;
  const arr = user.bag[m[1]], i = Number(m[2]);
  if (i >= arr.length || (m[1] === 'eq' && i > 1)) return null;
  return [arr, i];
}

async function handleInventoryMove(req, res) {
  const { id, from, to } = await readJson(req);
  const user = users.get(id);
  if (!user) return json(res, 404, { error: 'Unknown user' });
  const a = slotRef(user, from), b = slotRef(user, to);
  const item = a && a[0][a[1]];
  if (!a || !b || !ITEM_IDS.has(item)) return json(res, 400, { error: 'Cannot move that', bag: user.bag });
  if (a[0] !== b[0] || a[1] !== b[1]) {
    const other = b[0][b[1]];
    b[0][b[1]] = item; // an occupied target is swapped back into the source slot
    a[0][a[1]] = other;
    dirty = true;      // equipment changed: tell everyone
  }
  json(res, 200, { bag: user.bag });
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
      bag: newBag(),
      hp: MAX_HP, rs: 0, z: 0, lastAttack: 0,
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

async function handleAttack(req, res) {
  const { id } = await readJson(req);
  res.writeHead(204);
  res.end();
  const me = users.get(id), now = Date.now();
  if (!me || !me.bag.eq.slice(0, 2).includes('sword') || now - me.lastAttack < ATTACK_COOLDOWN) return;
  me.lastAttack = now;
  sendAll('swing', { id });

  const f = FACE[me.dir];
  for (const t of users.values()) {
    if (t === me || t.conns.size === 0) continue;
    const dx = t.x - me.x, dy = (t.y - me.y) / VERT; // distance on the floor plane
    const d = Math.hypot(dx, dy);
    if (d > ATTACK_RANGE) continue;
    if (d > 30 && (dx * f[0] + dy * f[1]) / d < 0.5) continue; // the target must be in front (120-degree arc)

    // Shield side: the half of the target's body on the side of the hand that holds the shield
    // (left hand = sub weapon slot, right hand = main weapon slot). An attacker standing on that side is blocked.
    const tf = FACE[t.dir];
    const left = [tf[1], -tf[0]], right = [-tf[1], tf[0]];
    const toMe = d > 0 ? [-dx / d, -dy / d] : [0, 0]; // from the target toward the attacker
    const dot = (v) => toMe[0] * v[0] + toMe[1] * v[1];
    const blocked = (t.bag.eq[1] === 'shield' && dot(left) > 0.05) || (t.bag.eq[0] === 'shield' && dot(right) > 0.05);

    sendAll('hit', { attacker: me.id, target: t.id, damage: blocked ? 0 : SWORD_DAMAGE, blocked });
    if (blocked) continue;
    t.hp -= SWORD_DAMAGE;
    if (t.hp <= 0) {
      respawn(t);
      sendAll('died', { id: t.id, name: t.nickname, by: me.nickname });
    }
  }
  dirty = true;
}

async function handleMove(req, res) {
  const { id, x, y, dir, moving, z, rs } = await readJson(req);
  const user = users.get(id);
  // a move sent before the client heard about its respawn (rs differs) is stale: ignore it
  if (user && rs === user.rs && Number.isFinite(x) && Number.isFinite(y)) {
    user.z = Number.isFinite(z) ? Math.min(150, Math.max(0, z)) : 0;
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
  if (req.method === 'POST' && url.pathname === '/api/attack') return handleAttack(req, res);
  if (req.method === 'POST' && url.pathname === '/api/inventory/move') return handleInventoryMove(req, res);
  if (req.method === 'POST' && url.pathname === '/api/leave') return handleLeave(req, res);
  if (req.method === 'GET' && url.pathname === '/api/events') return handleEvents(req, res, url);
  json(res, 404, { error: 'Not found' });
});

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
  .row { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
  h2 { font: 600 .95rem var(--serif); margin: 14px 0 6px; padding-top: 12px; border-top: 1px solid var(--line); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: .92rem; word-break: break-all; }
  li i { flex: none; width: 10px; height: 10px; border-radius: 50%; }
  .empty { color: var(--muted); font-size: .85rem; word-break: normal; }
  #hint { position: fixed; bottom: 112px; left: 50%; transform: translateX(-50%); padding: 8px 16px;
    background: rgba(43,36,23,.82); color: #fff; border-radius: 20px; font-size: .92rem; transition: opacity .6s; }
  #hint.gone { opacity: 0; pointer-events: none; }
  @media (max-width: 560px) { #hud { width: 180px; padding: 10px; } }

  #invWrap { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(20,14,4,.5); }
  #inv { position: relative; width: min(94vw, calc(94vh * 1.525), 920px); aspect-ratio: 1348 / 884;
    background: url(/inventory.png) center / 100% 100% no-repeat; --u: 0.6px; user-select: none; }
  .slot { position: absolute; }
  .slot canvas { display: block; width: 100%; height: 100%; cursor: grab; }
  .slot.over { outline: calc(var(--u) * 4) solid #e2b24a; background: rgba(255,230,150,.22); }
  .slot.locked { opacity: .5; }
  .eqico { position: absolute; }
  .lab { position: absolute; left: calc(var(--u) * 86); right: calc(var(--u) * 10); top: 0; bottom: 0;
    display: flex; flex-direction: column; justify-content: center; color: #3a2c1a; pointer-events: none; }
  .lab b { font: 700 calc(var(--u) * 19) / 1.2 var(--sans); text-transform: uppercase; letter-spacing: .06em; color: #6d5a38; }
  .lab span { font: 600 calc(var(--u) * 30) / 1.2 var(--serif); }
  #invHead { position: absolute; left: 13.7%; top: 7.9%; width: 23.4%; height: 9%; display: flex; flex-direction: column;
    justify-content: center; color: #3a2c1a; overflow: hidden; }
  #invHead b { font: 700 calc(var(--u) * 30) / 1.1 var(--serif); }
  #invNote { font: 500 calc(var(--u) * 17) / 1.2 var(--sans); color: #5b4a2c; }
  .hp { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  .hpbar { flex: 1; height: 13px; border: 1px solid #6b5a38; background: #e8dfc6; border-radius: 4px; overflow: hidden; }
  .hpbar i { display: block; height: 100%; width: 100%; background: #3f9b4f; transition: width .2s; }
  .hpbar i.mid { background: #e0a21a; }
  .hpbar i.low { background: #c8372d; }
  #hpText { font: 600 .8rem var(--sans); min-width: 64px; text-align: right; }
  #feed { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column;
    align-items: center; gap: 6px; pointer-events: none; }
  #feed div { background: rgba(43,36,23,.86); color: #fff; padding: 5px 14px; border-radius: 14px; font-size: .9rem; }
  #bagBtn { position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%); width: 96px; height: 72px; padding: 0;
    border: 0; background: none; cursor: pointer; transition: transform .12s; }
  #bagBtn:hover { transform: translateX(-50%) translateY(-3px) scale(1.06); }
  #bagBtn:active { transform: translateX(-50%) scale(.96); }
  #bagBtn img { display: block; width: 100%; height: 100%; object-fit: contain; pointer-events: none;
    filter: drop-shadow(0 4px 6px rgba(40,25,5,.45)); }
  #bagBtn .key { position: absolute; right: 2px; bottom: 2px; min-width: 21px; height: 21px; padding: 0 5px; display: grid;
    place-items: center; background: rgba(43,36,23,.92); color: #fff; border: 1px solid var(--gold); border-radius: 5px;
    font: 700 .78rem/1 var(--sans); }
  #preview { position: absolute; left: 3.34%; top: 69.2%; width: 25.6%; height: 28.3%; pointer-events: none; }
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
  <div class="hp"><div class="hpbar"><i id="hpFill"></i></div><span id="hpText">100 / 100</span></div>
  <div class="row" style="justify-content:flex-end"><button class="ghost" id="leave">Leave</button></div>
  <h2 id="othersTitle">Others in the arena</h2>
  <ul id="others"></ul>
</aside>
<div id="feed"></div>
<button id="bagBtn" type="button" tabindex="-1" aria-label="Open inventory (X)" hidden><img src="/bag.png" alt=""><span class="key">X</span></button>
<div id="hint" hidden>W A S D move &middot; Space jump &middot; F swing sword &middot; X inventory</div>
<div id="invWrap" hidden>
  <div id="inv">
    <div id="invHead"><b>Inventory</b><span id="invNote">Drag or double-click to equip</span></div>
    <canvas id="preview" width="345" height="250"></canvas>
  </div>
</div>

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
  var itemsImg = new Image(); itemsImg.src = '/items.png';
  var bag = null;

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
    $('bagBtn').hidden = mode !== 'game';
    playing = mode === 'game';
    if (mode === 'join') $('nick').focus();
  }

  function forgetMe() {
    toggleInv(false);
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
    bag = me.bag; syncEquip();
    me.z = 0; me.vz = 0; me.swingAt = -1e9; me.noSwordAt = -1e9;
    updateHp();
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
    es.addEventListener('swing', function (e) {
      var d = JSON.parse(e.data);
      if (d.id !== me.id && others[d.id]) others[d.id].swingAt = performance.now();
    });
    es.addEventListener('hit', function (e) {
      var d = JSON.parse(e.data), t = d.target === me.id ? me : others[d.target], now = performance.now();
      if (!t) return;
      floaters.push({ x: t.x, y: t.y - FH * SCALE - 34, text: d.blocked ? 'Blocked!' : '-' + d.damage,
                      color: d.blocked ? '#9fd4ff' : '#ff6b5e', t0: now });
      if (!d.blocked) t.hitAt = now;
    });
    es.addEventListener('died', function (e) {
      var d = JSON.parse(e.data);
      addFeed(d.by + ' defeated ' + d.name);
    });
    es.onerror = function () {
      // Server forgot us (e.g. it restarted): the stream is closed, so join again quietly.
      if (es.readyState === EventSource.CLOSED) join(me.nickname).catch(forgetMe);
    };
  }

  function onUsers(list) {
    var seen = {};
    list.forEach(function (u) {
      if (u.id === me.id) {
        if (u.rs !== me.rs) { me.rs = u.rs; me.x = u.x; me.y = u.y; me.dir = u.dir; me.z = 0; me.vz = 0; } // respawned
        if (u.hp !== me.hp) { me.hp = u.hp; updateHp(); }
        return;
      }
      seen[u.id] = true;
      var o = others[u.id];
      if (!o) { o = others[u.id] = { x: u.x, y: u.y, z: u.z || 0 }; }
      o.id = u.id; o.nickname = u.nickname; o.color = u.color;
      if (o.rs !== undefined && o.rs !== u.rs) { o.x = u.x; o.y = u.y; } // respawn: snap instead of gliding across the arena
      o.rs = u.rs; o.hp = u.hp; o.tz = u.z;
      o.tx = u.x; o.ty = u.y; o.dir = u.dir; o.moving = u.moving; o.equip = u.equip;
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
    var s = Math.round(me.x) + ',' + Math.round(me.y) + ',' + me.dir + ',' + me.moving + ',' + Math.round(me.z) + ',' + me.rs;
    if (s === lastSent || now - lastSentAt < 50) return;
    lastSent = s; lastSentAt = now;
    post('/api/move', { id: me.id, x: Math.round(me.x), y: Math.round(me.y), dir: me.dir, moving: me.moving,
                        z: Math.round(me.z), rs: me.rs }).catch(function () {});
  }

  // ---- input (event.code ignores the keyboard language, so it works with Korean IME too) ----
  var KEYMAP = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
                 KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
  window.addEventListener('keydown', function (e) {
    if (!playing) return;
    if (e.code === 'KeyX') { if (!e.repeat) toggleInv(); e.preventDefault(); return; }
    if (e.code === 'Escape' && invOpen) { toggleInv(false); return; }
    if (invOpen) return;
    if (e.code === 'Space') { keys.jump = true; e.preventDefault(); return; }
    if (e.code === 'KeyF') { attack(); e.preventDefault(); return; }
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


  // ---- equipment drawing ----
  // Per item: row in items.png, draw scale, anchor point inside its 160x210 cell, vertical offset from the hand.
  var ITEMDEF = {
    shield: { name: 'Cross Shield', row: 0, k: 0.40, ax: 80, ay: 105, dy: -14, crop: [21, 26, 118, 158] },
    sword:  { name: 'Iron Sword',   row: 1, k: 0.36, ax: 80, ay: 56,  dy: -8,  crop: [34, 3, 94, 194] }
  };
  // Hand positions in the 144x208 character cell for each facing frame: [x, y, visible-in-front].
  // R = right hand (main weapon), L = left hand (sub weapon). A hand hidden behind the body is drawn behind it.
  var HANDS = [
    { R: [27, 158, 1],  L: [118, 158, 1] },  // 0 down
    { R: [46, 161, 1],  L: [100, 150, 0] },  // 1 down-right
    { R: [63, 161, 1],  L: [80, 152, 0] },   // 2 right
    { R: [108, 152, 0], L: [34, 160, 1] },   // 3 up-right
    { R: [113, 160, 1], L: [29, 162, 1] },   // 4 up
    { R: [68, 152, 0],  L: [75, 163, 1] },   // 5 up-left
    { R: [66, 152, 0],  L: [82, 164, 1] },   // 6 left
    { R: [44, 152, 0],  L: [98, 163, 1] }    // 7 down-left
  ];

  var FWD = [0, 1, 1, 1, 0, -1, -1, -1]; // which way each frame faces horizontally (+1 = screen right)

  var MAX_HP = 100, JUMP_V = 470, GRAVITY = 1900, SWING_MS = 280, ATTACK_CD = 400;
  var SLASHV = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];

  // rot is only given while a sword is swinging: the sword turns around the hand that holds it
  function drawItem(c, id, dir, x, y, S, rot) {
    var d = ITEMDEF[id], s = S * d.k;
    if (rot === undefined) {
      c.drawImage(itemsImg, dir * 160, d.row * 210, 160, 210, x - d.ax * s, y - d.ay * s, 160 * s, 210 * s);
      return;
    }
    s *= 1.25;
    var f = (dir === 3 || dir === 4 || dir === 5) ? 4 : 0; // use the flat front / back art while swinging
    c.save(); c.translate(x, y); c.rotate(rot);
    c.drawImage(itemsImg, f * 160, d.row * 210, 160, 210, -d.ax * s, -d.ay * s, 160 * s, 210 * s);
    c.restore();
  }

  // Draws a character (feet at x,y) with its equipment layered according to the facing direction.
  // bob = height above the ground (walking bounce + jump), swing = 0..1 progress of a sword swing (or null).
  function drawChar(c, x, y, S, dir, equip, bob, swing) {
    var X = function (u) { return x + (u - 72) * S; };
    var Y = function (v) { return y - bob + (v - 208) * S; };
    var sw = (swing !== undefined && swing !== null && swing >= 0 && swing < 1) ? swing : null;
    var back = [], front = [], slash = false;
    [0, 1].forEach(function (i) {
      var id = equip && equip[i];
      if (!id || !ITEMDEF[id] || !itemsImg.complete) return;
      var h = i === 0 ? HANDS[dir].R : HANDS[dir].L;
      if (id === 'sword' && sw !== null) {
        // swing: the blade sweeps over the head and down in front, always drawn on top of the body
        var sgn = FWD[dir] || (h[0] < 72 ? 1 : -1), e = sw * sw * (3 - 2 * sw);
        front.push([id, X(h[0]), Y(h[1] + ITEMDEF[id].dy), sgn * e * 5.76]);
        slash = true;
        return;
      }
      // a shield is held out in front of the body, so when facing straight away it sits behind the character
      var inFront = h[2] === 1 && !(id === 'shield' && (dir === 3 || dir === 4));
      var side = h[0] - 72, dx;
      if (inFront) dx = id === 'shield' ? FWD[dir] * 8 : 0; // shield is held a little ahead of the body
      else {
        // hidden behind the body: shift sideways so it still peeks out
        // (a shield peeks out ahead of the body, a hanging sword behind it)
        var sg = Math.abs(side) > 16 ? (side < 0 ? -1 : 1) : ((id === 'shield' ? FWD[dir] : -FWD[dir]) || 1);
        dx = sg * (id === 'shield' ? 10 : 12);
      }
      (inFront ? front : back).push([id, X(h[0] + dx), Y(h[1] + ITEMDEF[id].dy)]);
    });
    back.forEach(function (it) { drawItem(c, it[0], dir, it[1], it[2], S, it[3]); });
    c.drawImage(sprites, dir * FW, 0, FW, FH, x - FW * S / 2, y - FH * S - bob, FW * S, FH * S);
    front.forEach(function (it) { drawItem(c, it[0], dir, it[1], it[2], S, it[3]); });
    if (slash && sw > 0.35) { // a fading slash mark in the direction the character faces
      var fv = SLASHV[dir], ang = Math.atan2(fv[1] * 0.75, fv[0]), q = S / 0.6;
      c.save();
      c.globalAlpha = 0.85 * (1 - (sw - 0.35) / 0.65);
      c.strokeStyle = '#fff6d5'; c.lineWidth = 7 * q; c.lineCap = 'round';
      c.beginPath(); c.ellipse(X(72), Y(118), 62 * q, 48 * q, 0, ang - 0.95, ang + 0.95); c.stroke();
      c.restore();
    }
  }

  function drawPlayer(p, t, isMe) {
    var lift = p.z || 0;
    var bob = (p.moving && lift < 1) ? Math.abs(Math.sin(t / 85)) * 5 : 0;
    var raise = bob + lift, h = FH * SCALE;
    var sh = 1 - Math.min(0.45, lift / 140); // the shadow shrinks while the character is in the air
    ctx.fillStyle = 'rgba(40,30,10,' + (0.22 * sh).toFixed(3) + ')';
    ctx.beginPath(); ctx.ellipse(p.x, p.y - 2, 24 * sh, 8 * sh, 0, 0, Math.PI * 2); ctx.fill();
    var shake = (p.hitAt && t - p.hitAt < 220) ? Math.sin((t - p.hitAt) / 18) * 4 : 0;
    var swing = (t - (p.swingAt || -1e9) < SWING_MS) ? (t - p.swingAt) / SWING_MS : null;
    drawChar(ctx, p.x + shake, p.y, SCALE, p.dir, p.equip, raise, swing);

    ctx.font = '600 17px "Malgun Gothic", "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var tw = ctx.measureText(p.nickname).width + 22, ty = p.y - h - 14 - raise;
    ctx.fillStyle = isMe ? 'rgba(184,137,43,0.95)' : 'rgba(43,36,23,0.78)';
    ctx.beginPath(); ctx.roundRect(p.x - tw / 2, ty - 13, tw, 26, 13); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(p.nickname, p.x, ty + 1);

    // health bar above the name tag
    var hp = Math.max(0, Math.min(MAX_HP, p.hp === undefined ? MAX_HP : p.hp)), bw = 58, bx = p.x - bw / 2, by = ty - 28;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath(); ctx.roundRect(bx - 1.5, by - 1.5, bw + 3, 10, 5); ctx.fill();
    if (hp > 0) {
      ctx.fillStyle = hp > 50 ? '#4caf50' : hp > 25 ? '#e8a317' : '#d9382b';
      ctx.beginPath(); ctx.roundRect(bx, by, Math.max(4, bw * hp / MAX_HP), 7, 3.5); ctx.fill();
    }
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
      drawFloaters(now);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);


  // ---- combat helpers ----
  var floaters = []; // floating "-15" / "Blocked!" texts
  function drawFloaters(t) {
    floaters = floaters.filter(function (f) { return t - f.t0 < 1000; });
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.font = '800 26px "Malgun Gothic", "Segoe UI", system-ui, sans-serif';
    floaters.forEach(function (f) {
      var a = (t - f.t0) / 1000, y = f.y - a * 44;
      ctx.globalAlpha = 1 - a * a;
      ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(30,20,5,0.85)';
      ctx.strokeText(f.text, f.x, y);
      ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, y);
    });
    ctx.globalAlpha = 1;
  }

  function addFeed(text) {
    var d = document.createElement('div');
    d.textContent = text;
    $('feed').append(d);
    setTimeout(function () { d.remove(); }, 4500);
  }

  function updateHp() {
    var hp = Math.max(0, Math.min(MAX_HP, me.hp === undefined ? MAX_HP : me.hp));
    $('hpFill').style.width = hp + '%';
    $('hpFill').className = hp > 50 ? '' : hp > 25 ? 'mid' : 'low';
    $('hpText').textContent = hp + ' / ' + MAX_HP;
  }

  // F: swing the sword. The animation starts at once; the server decides who gets hit.
  function attack() {
    if (!playing || invOpen || !me) return;
    var now = performance.now();
    if (!me.equip || me.equip.indexOf('sword') < 0) {
      if (now - me.noSwordAt > 1200) {
        me.noSwordAt = now;
        floaters.push({ x: me.x, y: me.y - FH * SCALE - 34, text: 'Equip a sword first', color: '#f3ead2', t0: now });
      }
      return;
    }
    if (now - me.swingAt < ATTACK_CD) return;
    me.swingAt = now;
    post('/api/attack', { id: me.id }).catch(function () {});
  }

  // ---- inventory panel (slots are laid over inventory.png, positions in its 1348x884 pixels) ----
  var PW = 1348, PH = 884;
  var invOpen = false, previewDir = 0, previewTimer = null, noteTimer = null, slotEls = {};
  var panel = $('inv'), pv = $('preview'), pctx = pv.getContext('2d');
  var pct = function (v, total) { return (v / total * 100) + '%'; };

  function syncEquip() { me.equip = bag.eq.slice(0, 2); }

  function mkSlot(key, x, y, w, h, cls) {
    var d = document.createElement('div');
    d.className = 'slot ' + cls; d.dataset.key = key;
    d.style.left = pct(x, PW); d.style.top = pct(y, PH); d.style.width = pct(w, PW); d.style.height = pct(h, PH);
    d.holder = d; d.iw = w; d.ih = h;
    panel.append(d); slotEls[key] = d;
    if (cls.indexOf('locked') < 0) {
      d.addEventListener('dragover', function (e) { e.preventDefault(); d.classList.add('over'); });
      d.addEventListener('dragleave', function () { d.classList.remove('over'); });
      d.addEventListener('drop', function (e) {
        e.preventDefault(); d.classList.remove('over');
        var from = e.dataTransfer.getData('text/plain');
        if (from) moveItem(from, key);
      });
      d.addEventListener('dblclick', function () { autoMove(key); });
    }
    return d;
  }

  var GX = [573, 722, 870, 1018, 1166], GY = [96, 246, 395, 544];
  for (var gr = 0; gr < 4; gr++) for (var gc = 0; gc < 5; gc++) mkSlot('inv:' + (gr * 5 + gc), GX[gc], GY[gr], 125, 125, 'cell');
  [433, 529, 626, 722, 819, 915, 1012, 1108, 1205].forEach(function (x, i) { mkSlot('hot:' + i, x, 735, 80, 80, 'cell'); });
  ['Main weapon', 'Sub weapon', 'Locked', 'Locked'].forEach(function (label, i) {
    var d = mkSlot('eq:' + i, 55, [214, 317, 419, 521][i] - 24, 450, 92, i > 1 ? 'eq locked' : 'eq');
    var ico = document.createElement('div');
    ico.className = 'eqico';
    ico.style.left = pct(26, 450); ico.style.top = pct(24, 92); ico.style.width = pct(44, 450); ico.style.height = pct(44, 92);
    var lab = document.createElement('div'); lab.className = 'lab';
    var t1 = document.createElement('b'); t1.textContent = label;
    d.name = document.createElement('span');
    lab.append(t1, d.name);
    d.append(ico, lab);
    d.holder = ico; d.iw = 44; d.ih = 44;
  });

  function makeIcon(id, w, h, key) {
    var cv = document.createElement('canvas'); cv.width = w * 2; cv.height = h * 2;
    var def = ITEMDEF[id], cr = def.crop, s = Math.min(cv.width / cr[2], cv.height / cr[3]) * 0.86;
    var g = cv.getContext('2d'); g.imageSmoothingQuality = 'high';
    function paint() {
      g.drawImage(itemsImg, cr[0], def.row * 210 + cr[1], cr[2], cr[3],
        (cv.width - cr[2] * s) / 2, (cv.height - cr[3] * s) / 2, cr[2] * s, cr[3] * s);
    }
    if (itemsImg.complete) paint(); else itemsImg.addEventListener('load', paint);
    cv.draggable = true; cv.title = def.name;
    cv.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData('text/plain', key); e.dataTransfer.effectAllowed = 'move';
    });
    return cv;
  }

  function renderInv() {
    if (!bag) return;
    Object.keys(slotEls).forEach(function (key) {
      var d = slotEls[key], parts = key.split(':'), item = bag[parts[0]][+parts[1]];
      d.holder.replaceChildren();
      if (item) d.holder.append(makeIcon(item, d.iw, d.ih, key));
      if (d.name) d.name.textContent = item ? ITEMDEF[item].name : (d.classList.contains('locked') ? '' : 'Empty');
    });
    drawPreview();
  }

  function drawPreview() {
    pctx.clearRect(0, 0, pv.width, pv.height);
    if (!sprites.complete || !bag) return;
    pctx.fillStyle = 'rgba(40,30,10,0.28)';
    pctx.beginPath(); pctx.ellipse(172, 237, 54, 14, 0, 0, Math.PI * 2); pctx.fill();
    drawChar(pctx, 172, 238, 1.05, previewDir, bag.eq, 0);
  }

  function note(msg) {
    $('invNote').textContent = msg;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { $('invNote').textContent = 'Drag or double-click to equip'; }, 2500);
  }

  async function moveItem(from, to) {
    if (from === to) return;
    try {
      var r = await post('/api/inventory/move', { id: me.id, from: from, to: to });
      var data = await r.json();
      if (data.bag) { bag = data.bag; syncEquip(); renderInv(); }
      if (!r.ok) note(data.error || 'Cannot move that');
    } catch (e) { note('Connection problem'); }
  }

  function itemAt(key) { var p = key.split(':'); return bag[p[0]][+p[1]]; }
  function firstEmpty(kind) {
    for (var i = 0; i < bag[kind].length; i++) if (!bag[kind][i]) return kind + ':' + i;
    return null;
  }

  // Double-click: bag -> equipment slot (sword prefers main, shield prefers sub); equipment -> bag.
  function autoMove(key) {
    var item = itemAt(key);
    if (!item) return;
    if (key.indexOf('eq:') === 0) {
      var dest = firstEmpty('inv') || firstEmpty('hot');
      return dest ? moveItem(key, dest) : note('Your bag is full');
    }
    var pref = item === 'sword' ? 0 : 1;
    var slot = bag.eq[pref] ? (bag.eq[1 - pref] ? pref : 1 - pref) : pref;
    moveItem(key, 'eq:' + slot);
  }

  function toggleInv(open) {
    if (open === undefined) open = !invOpen;
    if (open && !playing) return;
    invOpen = open; keys = {};
    $('invWrap').hidden = !open;
    clearInterval(previewTimer);
    if (open) {
      panel.style.setProperty('--u', panel.clientWidth / PW + 'px');
      renderInv();
      // the preview turns through all 8 directions so you can check how the gear looks from every side
      previewTimer = setInterval(function () { previewDir = (previewDir + 1) % 8; drawPreview(); }, 900);
      $('hint').classList.add('gone');
    }
  }
  window.addEventListener('resize', function () { if (invOpen) panel.style.setProperty('--u', panel.clientWidth / PW + 'px'); });
  $('invWrap').addEventListener('mousedown', function (e) { if (e.target === this) toggleInv(false); });
  // never let the button take keyboard focus, otherwise pressing Space would also "click" it
  $('bagBtn').addEventListener('mousedown', function (e) { e.preventDefault(); });
  $('bagBtn').addEventListener('click', function () { toggleInv(); });

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
