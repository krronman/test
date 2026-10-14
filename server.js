// Multi-user arena. No dependencies: only Node.js 16+ built-ins.
// Files needed in the same folder: server.js and the images arena, sprites, inventory, bag, shop, shop-panel,
// sky, sky-walk, coin-bar, exit-btn, crate-wood, crate-steel (all .png)
// Run:  node server.js   ->  open http://localhost:3000
// Real-time updates use Server-Sent Events (server -> clients) + POST (client -> server).
// Accounts, gold and other progress are saved in ./data/accounts.json (created automatically).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const GRACE_MS = 4000; // keeps a user alive across page refreshes
const TICK_MS = 50;    // position broadcast rate (20 per second)
const COLORS = ['#2f6f5e', '#b4532a', '#3b5bdb', '#9c36b5', '#c2255c', '#e67700', '#0b7285', '#5c7cfa'];
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'accounts.json');

// Walkable floor of the arena image (1536x1024), an ellipse in image pixels.
const FLOOR = { cx: 768, cy: 500, rx: 575, ry: 345 };
const STATIC = {
  '/arena.png': 'arena.png', '/sprites.png': 'sprites.png',
  '/inventory.png': 'inventory.png', '/bag.png': 'bag.png',
  '/shop.png': 'shop.png', '/shop-panel.png': 'shop-panel.png',
  '/sky.png': 'sky.png', '/sky-walk.png': 'sky-walk.png',
  '/coin-bar.png': 'coin-bar.png', '/exit-btn.png': 'exit-btn.png',
  '/crate-wood.png': 'crate-wood.png', '/crate-steel.png': 'crate-steel.png',
  '/crate-gold.png': 'crate-gold.png', '/crate-diamond.png': 'crate-diamond.png',
};
const STAR_REWARD = 10; // gold for reaching the star island
// Things sold in the shop. Prices are checked here on the server, never on the client.
const SHOP = {
  wood:  { name: '나무 상자', price: 100 },
  steel: { name: '강철 상자', price: 250 },
  gold:    { name: '황금 상자', price: 500 },
  diamond: { name: '다이아몬드 상자', price: 1000 },
};
const CHAT_MAX = 120, CHAT_KEEP = 50, CHAT_GAP_MS = 600;

// ---------------------------------------------------------------- accounts (saved to disk)
/** loginId (lower case) -> { id, name, color, salt, hash, gold, items, opened, created, lastLogin } */
let accounts = {};
/** sha256(token) -> loginId (lower case); kept on disk too so a server restart does not log everyone out */
let sessions = {};

try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  accounts = saved.accounts || {};
  sessions = saved.sessions || {};
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('Could not read ' + DATA_FILE + ': ' + e.message);
}

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ accounts, sessions }));
    fs.renameSync(tmp, DATA_FILE); // write + rename: a crash never leaves half a file
  } catch (e) { console.error('Could not save progress: ' + e.message); }
}
function save() { if (!saveTimer) saveTimer = setTimeout(saveNow, 300); } // batches bursts of changes
['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => { saveNow(); process.exit(0); }));

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(pw, salt, 64, (err, key) => (err ? reject(err) : resolve(key.toString('hex')))));

// ---------------------------------------------------------------- online presence
/** loginId -> { key, pid, token, joinedAt, x, y, z, dir, moving, sp, lastReward, lastChat, conns:Set<res>, timer } */
const users = new Map();
let dirty = false;
const chatLog = [];

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
      id: u.pid, nickname: accounts[u.key].name, color: accounts[u.key].color, joinedAt: u.joinedAt,
      x: Math.round(u.x), y: Math.round(u.y), z: Math.round(u.z), dir: u.dir, moving: u.moving,
      sp: u.sp, // true while that player is in the single-player course (hidden from the lobby)
    }));

function sendAll(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const u of users.values()) for (const res of u.conns) res.write(msg);
}
const broadcast = () => sendAll('users', onlineUsers());

// Global chat. kind 'system' = notification written by the server, 'user' = typed by a player.
const CHAT_TTL_MS = 60 * 60 * 1000; // messages older than 1 hour are deleted
function pruneChat() {
  const cutoff = Date.now() - CHAT_TTL_MS;
  while (chatLog.length && (chatLog.length > CHAT_KEEP || chatLog[0].t < cutoff)) chatLog.shift();
}
setInterval(pruneChat, 60000);

function pushChat(kind, text, name) {
  const m = { kind, text, t: Date.now() }; // t = send time, shown when hovering a message
  if (name) m.name = name;
  chatLog.push(m);
  pruneChat();
  sendAll('chat', m);
}

setInterval(() => {
  if (dirty) { dirty = false; broadcast(); }
}, TICK_MS);

function scheduleRemoval(user) {
  clearTimeout(user.timer);
  user.timer = setTimeout(() => {
    if (user.conns.size === 0 && users.get(user.key) === user) {
      users.delete(user.key);
      dirty = true;
      pushChat('system', accounts[user.key].name + ' 님이 퇴장했습니다.');
    }
  }, GRACE_MS);
}

// The player appears in the arena. A refresh within the grace period keeps the old presence (no new "joined" line).
function enterArena(key) {
  let user = users.get(key);
  if (user) return user;
  const angle = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * 0.6; // spawn somewhere near the middle
  user = {
    key, pid: crypto.randomBytes(8).toString('hex'), token: null, joinedAt: Date.now(),
    x: FLOOR.cx + Math.cos(angle) * FLOOR.rx * r,
    y: FLOOR.cy + Math.sin(angle) * FLOOR.ry * r,
    z: 0,   // height above the ground while jumping
    dir: 0, // 0 = facing the viewer
    moving: false, sp: false, lastReward: 0, lastChat: 0,
    conns: new Set(), timer: null,
  };
  users.set(key, user);
  pushChat('system', accounts[key].name + ' 님이 입장했습니다.');
  return user;
}

// What the browser may know about its own account (never the password data).
function profileOf(user) {
  const a = accounts[user.key];
  return {
    token: user.token, id: user.pid, loginId: a.id, nickname: a.name, color: a.color, joinedAt: user.joinedAt,
    x: Math.round(user.x), y: Math.round(user.y), dir: user.dir,
    gold: a.gold, items: a.items, opened: a.opened,
  };
}

// New login: one session per account. An older tab of the same account is signed out.
function startSession(key) {
  const user = enterArena(key);
  if (user.token) {
    delete sessions[sha(user.token)];
    for (const c of user.conns) { c.write('event: kicked\ndata: {}\n\n'); c.end(); }
    user.conns.clear();
  }
  for (const h of Object.keys(sessions)) if (sessions[h] === key) delete sessions[h];
  user.token = crypto.randomBytes(24).toString('hex');
  sessions[sha(user.token)] = key;
  user.sp = false; // logging in always starts in the lobby
  accounts[key].lastLogin = Date.now();
  save();
  scheduleRemoval(user); // removed unless an event stream connects soon
  dirty = true;
  return user;
}

// token -> online presence (created again if the grace period ran out, e.g. after a long network drop)
function userByToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const key = sessions[sha(token)];
  if (!key || !accounts[key]) return null;
  const user = users.get(key);
  return user && user.token === token ? user : null;
}

// ---------------------------------------------------------------- http helpers
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

// ---------------------------------------------------------------- accounts: sign up, log in, resume, log out
const failures = new Map(); // ip -> { n, until }: slows down password guessing
function tooManyTries(ip) {
  const f = failures.get(ip);
  return !!f && f.until > Date.now();
}
function noteFailure(ip) {
  const f = failures.get(ip) || { n: 0, until: 0 };
  if (f.until && f.until <= Date.now()) { f.n = 0; f.until = 0; }
  f.n++;
  if (f.n >= 8) { f.until = Date.now() + 30000; f.n = 0; } // 8 wrong tries -> 30 s pause
  failures.set(ip, f);
}

async function handleRegister(req, res) {
  const { id, name, password } = await readJson(req);
  const loginId = String(id || '').trim();
  const nick = String(name || '').trim();
  const pw = typeof password === 'string' ? password : '';
  if (!/^[A-Za-z0-9_]{3,16}$/.test(loginId)) return json(res, 400, { error: 'ID: 3–16 letters, numbers or _.' });
  if (nick.length < 2 || nick.length > 16 || !/^[\p{L}\p{N}_\- ]+$/u.test(nick)) {
    return json(res, 400, { error: 'Display name: 2–16 letters, numbers, spaces, - or _.' });
  }
  if (pw.length < 4 || pw.length > 64) return json(res, 400, { error: 'Password: 4–64 characters.' });
  const key = loginId.toLowerCase();
  if (accounts[key]) return json(res, 409, { error: 'That ID is already taken.' });
  if (Object.values(accounts).some((a) => a.name.toLowerCase() === nick.toLowerCase())) {
    return json(res, 409, { error: 'That display name is already taken.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPw(pw, salt);
  if (accounts[key]) return json(res, 409, { error: 'That ID is already taken.' }); // someone else won the race while hashing
  accounts[key] = {
    id: loginId, name: nick, color: COLORS[Object.keys(accounts).length % COLORS.length],
    salt, hash, gold: 0, items: {}, opened: {}, created: Date.now(), lastLogin: Date.now(),
  };
  save();
  json(res, 200, profileOf(startSession(key)));
}

async function handleLogin(req, res) {
  const { id, password } = await readJson(req);
  const ip = req.socket.remoteAddress;
  if (tooManyTries(ip)) return json(res, 429, { error: 'Too many wrong attempts. Wait a little and try again.' });
  const key = String(id || '').trim().toLowerCase();
  const acct = accounts[key];
  const pw = typeof password === 'string' ? password.slice(0, 64) : '';
  // always hash, so a wrong ID and a wrong password take the same time
  const hash = await hashPw(pw, acct ? acct.salt : 'x');
  const ok = acct && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(acct.hash, 'hex'));
  if (!ok) { noteFailure(ip); return json(res, 401, { error: 'Wrong ID or password.' }); }
  json(res, 200, profileOf(startSession(key)));
}

// A refresh (or a reconnect after a drop) signs in again with the saved token.
async function handleResume(req, res) {
  const { token } = await readJson(req);
  const key = typeof token === 'string' && sessions[sha(token)];
  if (!key || !accounts[key]) return json(res, 401, { error: 'Session expired. Please log in again.' });
  const user = enterArena(key);
  if (user.token !== token) { // the presence was recreated after a long drop: adopt this token again
    user.token = token;
  }
  user.sp = false;
  scheduleRemoval(user);
  dirty = true;
  json(res, 200, profileOf(user));
}

async function handleLogout(req, res) {
  const { token } = await readJson(req);
  const user = userByToken(token);
  if (user) {
    delete sessions[sha(token)];
    user.token = null;
    for (const c of user.conns) c.end();
    clearTimeout(user.timer);
    users.delete(user.key);
    pushChat('system', accounts[user.key].name + ' 님이 퇴장했습니다.');
    dirty = true;
    save();
  }
  json(res, 200, { ok: true });
}

// ---------------------------------------------------------------- game actions
async function handleMove(req, res) {
  const { token, x, y, z, dir, moving } = await readJson(req);
  const user = userByToken(token);
  if (!user) return json(res, 401, { error: 'Not logged in' });
  if (!user.sp && Number.isFinite(x) && Number.isFinite(y)) {
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

// The player enters (sp = true) or leaves (sp = false) the single-player course.
async function handleScene(req, res) {
  const { token, sp, x, y, dir } = await readJson(req);
  const user = userByToken(token);
  if (!user) return json(res, 401, { error: 'Not logged in' });
  user.sp = !!sp;
  if (!user.sp && Number.isFinite(x) && Number.isFinite(y)) { // back in the lobby at a new spot
    const p = clampToFloor(x, y);
    user.x = p.x; user.y = p.y; user.z = 0; user.moving = false;
    if (Number.isInteger(dir) && dir >= 0 && dir <= 7) user.dir = dir;
  }
  dirty = true;
  res.writeHead(204);
  res.end();
}

// The player reached the star island: add gold (only while in the course, and not more than once every 1.5 s).
async function handleReward(req, res) {
  const { token } = await readJson(req);
  const user = userByToken(token), now = Date.now();
  if (!user) return json(res, 401, { error: 'Not logged in' });
  const acct = accounts[user.key];
  if (!user.sp || now - user.lastReward < 1500) return json(res, 400, { error: 'No reward', gold: acct.gold });
  user.lastReward = now;
  acct.gold += STAR_REWARD;
  save();
  json(res, 200, { gold: acct.gold });
}

// Buying (= opening) a chest: the price is taken here, then everyone sees the announcement in the global chat.
async function handleBuy(req, res) {
  const { token, item } = await readJson(req);
  const user = userByToken(token);
  if (!user) return json(res, 401, { error: 'Not logged in' });
  const def = Object.prototype.hasOwnProperty.call(SHOP, item) ? SHOP[item] : null;
  if (!def) return json(res, 400, { error: 'Unknown item' });
  const acct = accounts[user.key];
  if (acct.gold < def.price) return json(res, 402, { error: '골드가 부족합니다.', gold: acct.gold });
  acct.gold -= def.price;
  acct.opened[item] = (acct.opened[item] || 0) + 1; // progress record; what a chest contains comes later
  save();
  pushChat('system', acct.name + ' 님이 ' + def.name + ' 를 열었습니다!');
  json(res, 200, { gold: acct.gold, item });
}

async function handleChat(req, res) {
  const { token, text } = await readJson(req);
  const user = userByToken(token);
  if (!user) return json(res, 401, { error: 'Not logged in' });
  // strip control characters, collapse whitespace, cap the length
  const clean = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
  const now = Date.now();
  if (!clean || now - user.lastChat < CHAT_GAP_MS) { res.writeHead(204); return res.end(); }
  user.lastChat = now;
  pushChat('user', clean, accounts[user.key].name);
  res.writeHead(204);
  res.end();
}

function handleEvents(req, res, url) {
  const user = userByToken(url.searchParams.get('token'));
  if (!user) return json(res, 401, { error: 'Not logged in' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  clearTimeout(user.timer);
  user.conns.add(res);
  res.write(`event: chathistory\ndata: ${JSON.stringify(chatLog)}\n\n`);
  res.write(`event: users\ndata: ${JSON.stringify(onlineUsers())}\n\n`);
  dirty = true;

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    user.conns.delete(res);
    if (user.conns.size === 0 && users.get(user.key) === user) scheduleRemoval(user);
  });
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
  const post = {
    '/api/register': handleRegister, '/api/login': handleLogin, '/api/resume': handleResume, '/api/logout': handleLogout,
    '/api/move': handleMove, '/api/scene': handleScene, '/api/reward': handleReward,
    '/api/buy': handleBuy, '/api/chat': handleChat,
  };
  if (req.method === 'POST' && post[url.pathname]) {
    return post[url.pathname](req, res).catch((e) => { console.error(e); if (!res.headersSent) json(res, 500, { error: 'Server error' }); });
  }
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
server.listen(PORT, () => console.log(`Server running: http://localhost:${PORT}  (accounts: ${Object.keys(accounts).length}, saved in ${DATA_FILE})`));

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
  form { display: flex; flex-direction: column; gap: 12px; }
  label { display: grid; gap: 4px; font-size: .85rem; color: var(--muted); }
  .tabs { display: flex; margin: 0 0 18px; border-bottom: 1px solid var(--line); }
  .tab { flex: 1; padding: 8px; background: none; color: var(--muted); border-radius: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab.on { color: var(--ink); border-bottom-color: var(--gold); }
  .small { font-size: .82rem; margin: 12px 0 0; }
  input { flex: 1 1 180px; padding: 12px 14px; font: inherit; color: var(--ink); background: #fff;
    border: 1px solid var(--line); border-radius: 4px; }
  button { padding: 12px 20px; font: inherit; font-weight: 600; color: #fff; background: var(--gold);
    border: 0; border-radius: 4px; cursor: pointer; }
  button.ghost { background: none; color: var(--muted); border: 1px solid var(--line); padding: 6px 12px; font-weight: 500; font-size: .85rem; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .error { color: var(--danger); min-height: 1.5em; margin: 10px 0 0; font-size: .92rem; }

  #hud { position: fixed; top: 14px; left: 14px; width: 240px; max-height: calc(100% - 250px); overflow: auto;
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
    background: url(/inventory.png) center / 100% 100% no-repeat; container-type: inline-size; position: relative; }
  /* labels laid over the two big slots at the left of the inventory image (measured from the picture, in percent) */
  #inv .slotLabel { position: absolute; left: 6.52%; width: 16.16%; height: 25%; display: grid; place-content: center;
    gap: .3em; text-align: center; pointer-events: none; font: 700 2.1cqw/1.1 var(--serif); letter-spacing: .06em;
    color: rgba(251,247,236,.78); text-shadow: 0 1px 2px rgba(20,12,2,.8); }
  #inv .slotLabel small { font: 600 1.5cqw/1 var(--sans); letter-spacing: .12em; text-transform: uppercase; color: rgba(226,214,184,.7); }
  #inv .slotSword { top: 13.3%; }
  #inv .slotGun { top: 47.1%; }

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

  #coins { position: fixed; top: 14px; right: 16px; width: 210px; aspect-ratio: 1809 / 400; pointer-events: none;
    background: url(/coin-bar.png) center / 100% 100% no-repeat; filter: drop-shadow(0 3px 5px rgba(40,25,5,.35)); }
  #coins span { position: absolute; left: 24%; right: 6.5%; top: 27%; bottom: 23%; display: flex; align-items: center;
    justify-content: flex-end; font: 800 20px/1 "Courier New", "Malgun Gothic", monospace; color: #4b2a08;
    text-shadow: 0 1px 0 rgba(255,236,190,.55); }
  #coins.pop { animation: coinpop .4s; }
  @keyframes coinpop { 40% { transform: scale(1.14); } }

  #exitBtn { position: fixed; top: 14px; left: 16px; width: 168px; aspect-ratio: 1233 / 397; padding: 0; border: 0;
    background: url(/exit-btn.png) center / 100% 100% no-repeat; cursor: pointer; transition: transform .12s;
    filter: drop-shadow(0 3px 5px rgba(40,25,5,.4)); }
  #exitBtn:hover { transform: scale(1.06); }
  #exitBtn:active { transform: scale(.96); }

  /* global chat, bottom left */
  #chat { position: fixed; left: 14px; bottom: 14px; width: min(340px, calc(50vw - 70px)); display: flex; flex-direction: column; gap: 6px; }
  #chatLog { height: 170px; overflow-y: auto; margin: 0; padding: 8px 10px; background: rgba(20,14,4,.5);
    border: 1px solid rgba(184,137,43,.55); border-radius: 6px; font-size: .86rem; line-height: 1.4; color: #fff;
    text-shadow: 0 1px 2px rgba(0,0,0,.7); scrollbar-width: thin; }
  #chatLog li { display: block; padding: 1px 0; word-break: break-word; }
  #chatLog li.sys { color: #ffd98a; }
  #chatLog b { color: #ffe3a1; margin-right: .4em; }
  #chatLog li.mine b { color: #9ee0c0; }
  #chatInput { flex: none; width: 100%; padding: 8px 10px; font-size: .88rem; background: rgba(251,247,236,.88); }
  #chatInput:focus { background: #fff; }
  #chatToggle, #miniBtn { align-self: flex-start; padding: 4px 12px; font-size: .8rem; border-radius: 14px; background: rgba(43,36,23,.78); color: #fff; }
  #chatToggle.on, #miniBtn.on { background: rgba(184,137,43,.95); }
  #chat.off #chatLog, #chat.off #chatInput { display: none; }
  #chatTip { position: fixed; padding: 3px 8px; border-radius: 4px; background: rgba(20,14,4,.92); color: #fff;
    font-size: .78rem; white-space: nowrap; pointer-events: none; }
  /* minimap, top right under the coin bar */
  #miniBtn { position: fixed; top: 70px; right: 16px; }
  #mini { position: fixed; top: 106px; right: 16px; width: min(240px, 28vw); border: 2px solid rgba(184,137,43,.85);
    border-radius: 8px; overflow: hidden; background: #000; box-shadow: 0 6px 18px rgba(20,12,2,.4); pointer-events: none; }
  #mini canvas { display: block; width: 100%; height: auto; }

  /* shop items: transparent buttons laid over the cards of the panel image (percent of the panel) */
  #shop { container-type: inline-size; }
  .shopItem { position: absolute; left: 10.28%; width: 11.65%; height: 19.17%; padding: 0; border: 0; border-radius: 8px;
    background: transparent; cursor: pointer; transition: background .12s, transform .12s; }
  .shopItem:hover { background: rgba(255,240,200,.22); }
  .shopItem:active { transform: scale(.97); }
  .shopItem img { position: absolute; left: 6.8%; top: 6.5%; width: 86.4%; height: 62.4%; object-fit: contain;
    pointer-events: none; filter: drop-shadow(0 3px 3px rgba(20,12,2,.5)); }
  /* the number sits on a patch the colour of the price strip, which hides the printed dash */
  .shopItem .price { position: absolute; left: 38.3%; top: 74%; width: 35%; height: 21%; display: flex; align-items: center;
    padding-left: .5cqw; color: #4b2a08; color: #4b2a08; font: 800 1.9cqw/1 "Courier New", "Malgun Gothic", monospace; pointer-events: none; }
  .shopItem.nogold .price { color: var(--danger); animation: nogold .4s; }
  @keyframes nogold { 20%, 60% { transform: translateX(-3px); } 40%, 80% { transform: translateX(3px); } }

  #fade { position: fixed; inset: 0; background: #000; opacity: 0; pointer-events: none; transition: opacity .3s ease; z-index: 100; }
</style>
</head>
<body>
<section id="join" hidden>
  <div class="card">
    <h1>Marble Arena</h1>
    <div class="tabs"><button type="button" class="tab on" id="tabLogin">Log in</button><button type="button" class="tab" id="tabSignup">Sign up</button></div>
    <form id="authForm">
      <label>ID<input id="fId" maxlength="16" autocomplete="username" autocapitalize="off" spellcheck="false" required></label>
      <label id="rowName" hidden>Display name<input id="fName" maxlength="16" autocomplete="off"></label>
      <label>Password<input id="fPw" type="password" maxlength="64" autocomplete="current-password" required></label>
      <button type="submit" id="authGo">Log in</button>
    </form>
    <p class="error" id="err" role="alert"></p>
    <p class="meta small" id="authHelp" hidden>ID: 3–16 letters, numbers or _ (used to log in). Display name: 2–16 characters, shown to everyone. Password: 4 or more characters. Your progress is saved to this account.</p>
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
  <div class="row"><button class="ghost" id="leave">Log out</button></div>
  <h2 id="othersTitle">Others in the arena</h2>
  <ul id="others"></ul>
</aside>

<button id="bagBtn" type="button" tabindex="-1" aria-label="Open inventory (X)" hidden><img src="/bag.png" alt=""><span class="key">X</span></button>
<button id="shopBtn" type="button" tabindex="-1" aria-label="Open shop (Z)" hidden><img src="/shop.png" alt=""><span class="key">Z</span></button>
<div id="hint" hidden>W A S D move &middot; Space jump &middot; X inventory &middot; Z shop &middot; Enter chat</div>
<div id="coins" hidden><span id="coinText">0</span></div>
<button id="exitBtn" type="button" tabindex="-1" aria-label="Exit" hidden></button>
<div id="chat" hidden>
  <button id="chatToggle" type="button" tabindex="-1"></button>
  <ul id="chatLog" aria-live="polite"></ul>
  <input id="chatInput" maxlength="120" autocomplete="off" placeholder="Press Enter to chat" aria-label="Chat message">
  <div id="chatTip" hidden></div>
</div>
<button id="miniBtn" type="button" tabindex="-1" hidden>Map (M)</button>
<div id="mini" hidden><canvas id="miniCv" width="480" height="320"></canvas></div>
<div id="invWrap" hidden><div id="inv"><div class="slotLabel slotSword">Sword<small>skin</small></div><div class="slotLabel slotGun">Gun<small>skin</small></div></div></div>
<div id="shopWrap" hidden>
  <div id="shop" role="dialog" aria-label="Shop">
    <button id="shopClose" type="button" aria-label="Close shop"></button>
    <button class="shopItem" type="button" tabindex="-1" data-item="wood" style="top: 27.06%" aria-label="나무 상자, 100 Gold"><img src="/crate-wood.png" alt=""><span class="price">100</span></button>
    <button class="shopItem" type="button" tabindex="-1" data-item="steel" style="top: 48.82%" aria-label="강철 상자, 250 Gold"><img src="/crate-steel.png" alt=""><span class="price">250</span></button>
    <button class="shopItem" type="button" tabindex="-1" data-item="gold" style="top: 70.57%" aria-label="황금 상자, 500 Gold"><img src="/crate-gold.png" alt=""><span class="price">500</span></button>
    <button class="shopItem" type="button" tabindex="-1" data-item="diamond" style="left: 23.36%; top: 27.06%" aria-label="다이아몬드 상자, 1000 Gold"><img src="/crate-diamond.png" alt=""><span class="price">1000</span></button>
  </div>
</div>

<script>
  var $ = function (id) { return document.getElementById(id); };

  // ---- constants (image pixels) ----
  var W = 1536, H = 1024;
  var FLOOR = { cx: 768, cy: 500, rx: 575, ry: 345 };
  var VERT = 0.62;            // vertical moves slower: the scenes are seen at an angle
  var FW = 144, FH = 208;     // sprite cell size
  // Sprite frames: 0 down, 1 down-right, 2 right, 3 up-right, 4 up, 5 up-left, 6 left, 7 down-left
  var DIR_TABLE = [[5, 4, 3], [6, -1, 2], [7, 0, 1]]; // [dy+1][dx+1]
  // Settings of the two scenes. The character is a little smaller in the sky course.
  var LOBBY = { speed: 270, scale: 0.6,  jumpV: 470, gravity: 1900 };
  var SKY   = { speed: 270, scale: 0.45, jumpV: 440, gravity: 1700, spawn: { x: 165, y: 778 } };
  // The barred gate at the top of the arena image, and the spot in front of it that counts as "reaching the door"
  var DOOR = { cx: 768, x0: 731, x1: 805, y0: 6, y1: 74 };
  var DOOR_ZONE = { maxY: 185, halfW: 60 };
  var LOBBY_RETURN = { x: 768, y: 270 }; // where you stand when coming back from the course
  var LOBBY_ZOOM = 1.8;       // the lobby is shown zoomed in on the player (1 = whole arena on screen)
  var cam = { x: 0, y: 0, ok: false }; // top-left corner of the visible part of the arena, in arena pixels
  var FADE_MS = 300;          // fade to black / back (matches the CSS transition)
  var FALL_MS = 900;
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
  var skyBg = new Image(); skyBg.src = '/sky.png';

  // Which pixels of the sky map are solid: red = grass (or bridge) plus anything standing on it (pads, fences, rocks), yellow = the star island. Everything else is air or cliff.
  var walkData = null;
  var skyWalk = new Image();
  skyWalk.onload = function () {
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var g = c.getContext('2d'); g.drawImage(skyWalk, 0, 0);
    walkData = g.getImageData(0, 0, W, H).data;
  };
  skyWalk.src = '/sky-walk.png';
  function groundPixel(ix, iy) { // exact lookup: 0 = nothing, 1 = grass or anything standing on it, 2 = the star island
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return 0;
    var i = (iy * W + ix) * 4;
    if (walkData[i + 1] > 127) return 2;
    return walkData[i] > 127 ? 1 : 0;
  }
  var EDGE_TOL = 4; // px: the feet may hang this far over the edge of an island before the player falls
  function groundAt(x, y) {
    if (!walkData) return 1;
    var ix = Math.round(x), iy = Math.round(y), g = groundPixel(ix, iy);
    if (g) return g;
    var o = [[EDGE_TOL, 0], [-EDGE_TOL, 0], [0, EDGE_TOL], [0, -EDGE_TOL]], k;
    for (k = 0; k < o.length; k++) { g = groundPixel(ix + o[k][0], iy + o[k][1]); if (g) return g; }
    return 0;
  }

  var me = null, es = null, others = {}, lastRoster = null;
  var scene = 'lobby', transitioning = false, fall = null, floaters = [], gold = 0;
  var keys = {}, playing = false, invOpen = false, shopOpen = false, hintShown = false, lastSent = null, lastSentAt = 0;
  var token = null; // proves who we are to the server; kept per tab, so a refresh stays logged in
  try { token = sessionStorage.getItem('token'); } catch (e) {}

  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        if (r.status === 401 && playing) forgetMe('Your session ended. Please log in again.'); // e.g. the account logged in elsewhere
        return r;
      });
  }

  // Shows the right pieces of interface for the current screen and scene.
  function show(mode) {
    var inGame = mode === 'game';
    $('join').hidden = mode !== 'join';
    $('game').hidden = !inGame;
    $('hud').hidden = !inGame || scene !== 'lobby';       // profile + player list belong to the lobby
    $('exitBtn').hidden = !inGame || scene !== 'sky';     // the way back from the course
    $('coins').hidden = !inGame;
    $('hint').hidden = !inGame;
    $('bagBtn').hidden = !inGame;
    $('shopBtn').hidden = !inGame;
    $('chat').hidden = !inGame;
    playing = inGame;
    if (mode === 'join') $('fId').focus();
  }

  // Back to the login screen. msg (a text or an Error) is shown under the form.
  function forgetMe(msg) {
    if (es) { es.close(); es = null; }
    toggleInv(false);
    toggleShop(false);
    chatInput.blur();
    scene = 'lobby'; fall = null; transitioning = false; floaters = []; keys = {};
    $('fade').style.opacity = '0'; $('fade').style.pointerEvents = 'none';
    me = null; token = null; sessionStorage.removeItem('token');
    chatLog.replaceChildren();
    $('fPw').value = '';
    $('err').textContent = typeof msg === 'string' ? msg : (msg && msg.message) || '';
    show('join');
  }

  // Sign-up and log-in share one form.
  var signupMode = false;
  function setAuthMode(signup) {
    signupMode = signup;
    $('tabLogin').classList.toggle('on', !signup);
    $('tabSignup').classList.toggle('on', signup);
    $('rowName').hidden = !signup; $('authHelp').hidden = !signup;
    $('fName').required = signup;
    $('fPw').autocomplete = signup ? 'new-password' : 'current-password';
    $('authGo').textContent = signup ? 'Create account' : 'Log in';
    $('err').textContent = '';
  }

  async function authenticate() {
    var body = { id: $('fId').value, password: $('fPw').value };
    if (signupMode) body.name = $('fName').value;
    var r = await post(signupMode ? '/api/register' : '/api/login', body);
    var data = await r.json();
    if (!r.ok) throw new Error(data.error);
    enter(data);
  }

  // The same token signs in again after a refresh (or after the connection dropped for a while).
  async function resume() {
    var r = await post('/api/resume', { token: token });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error);
    enter(data);
  }

  function enter(profile) {
    token = profile.token;
    sessionStorage.setItem('token', token);
    me = profile;
    $('meBadge').textContent = me.nickname.charAt(0).toUpperCase();
    $('meBadge').style.background = me.color;
    $('meName').textContent = me.nickname;
    $('meMeta').textContent = '@' + me.loginId + ' \u00b7 joined ' + new Date(me.joinedAt).toLocaleTimeString();
    me.moving = false; me.z = 0; me.vz = 0;
    scene = 'lobby'; fall = null;
    setGold(me.gold || 0, false);           // saved on the account, so it is the same on every login
    $('err').textContent = '';
    $('fPw').value = '';
    connect();
    show('game');
    if (!hintShown) { hintShown = true; $('hint').classList.remove('gone'); }
  }

  // ---- money ----
  function setGold(n, pop) {
    gold = n;
    $('coinText').textContent = String(n);
    if (pop) {
      var c = $('coins');
      c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop');
    }
  }

  // ---- networking ----
  function connect() {
    if (es) es.close();
    others = {}; lastRoster = null;
    es = new EventSource('/api/events?token=' + encodeURIComponent(token));
    es.addEventListener('users', function (e) { onUsers(JSON.parse(e.data)); });
    es.addEventListener('chathistory', function (e) {
      chatLog.replaceChildren();
      JSON.parse(e.data).forEach(function (m) { addChat(m); });
    });
    es.addEventListener('chat', function (e) { addChat(JSON.parse(e.data)); });
    es.addEventListener('kicked', function () { forgetMe('This account was logged in somewhere else.'); });
    es.onerror = function () {
      // The stream is closed for good (e.g. the server restarted): sign in again quietly with the token.
      if (es && es.readyState === EventSource.CLOSED) resume().catch(forgetMe);
    };
  }

  function onUsers(list) {
    var seen = {};
    list.forEach(function (u) {
      if (u.id === me.id) return;
      seen[u.id] = true;
      var o = others[u.id];
      if (!o) { o = others[u.id] = { x: u.x, y: u.y, z: u.z || 0 }; }
      o.id = u.id; o.nickname = u.nickname; o.color = u.color; o.sp = u.sp;
      o.tx = u.x; o.ty = u.y; o.tz = u.z; o.dir = u.dir; o.moving = u.moving;
    });
    Object.keys(others).forEach(function (id) { if (!seen[id]) delete others[id]; });
    renderRoster();
  }

  // Players who are in the single-player course are not in the lobby, so they are neither drawn nor listed.
  function lobbyOthers() {
    return Object.keys(others).filter(function (id) { return !others[id].sp; }).sort();
  }

  function renderRoster() {
    var ids = lobbyOthers();
    var roster = ids.map(function (id) { return id + others[id].nickname; }).join('|');
    if (roster === lastRoster) return;
    lastRoster = roster;
    var ul = $('others');
    ul.replaceChildren();
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
    post('/api/move', { token: token, x: Math.round(me.x), y: Math.round(me.y), z: Math.round(me.z),
                        dir: me.dir, moving: me.moving }).catch(function () {});
  }

  // ---- chat (bottom left): Enter opens the box, Enter sends, Esc closes it ----
  var chatLog = $('chatLog'), chatInput = $('chatInput');
  var CHAT_TTL = 60 * 60 * 1000; // messages older than 1 hour disappear
  var chatOn = true, unread = 0, chatBtn = $('chatToggle'), chatTip = $('chatTip');
  try { chatOn = localStorage.getItem('chatOn') !== '0'; } catch (e) {}
  function setChat(on) {
    chatOn = on; unread = 0;
    $('chat').classList.toggle('off', !on);
    chatBtn.classList.toggle('on', on);
    chatBtn.textContent = on ? 'Chat: ON' : 'Chat: OFF';
    if (!on) chatInput.blur(); else chatLog.scrollTop = chatLog.scrollHeight;
    try { localStorage.setItem('chatOn', on ? '1' : '0'); } catch (e) {}
  }
  chatBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
  chatBtn.addEventListener('click', function () { setChat(!chatOn); });
  // hovering a message shows when it was sent
  chatLog.addEventListener('mouseover', function (e) {
    var li = e.target.closest ? e.target.closest('li') : null;
    if (!li) return;
    var r = li.getBoundingClientRect();
    chatTip.textContent = new Date(+li.getAttribute('data-t')).toLocaleTimeString();
    chatTip.style.left = r.left + 'px'; chatTip.style.top = (r.top - 26) + 'px';
    chatTip.hidden = false;
  });
  chatLog.addEventListener('mouseout', function () { chatTip.hidden = true; });
  setInterval(function () { // delete messages older than 1 hour
    var cutoff = Date.now() - CHAT_TTL;
    while (chatLog.firstChild && +chatLog.firstChild.getAttribute('data-t') < cutoff) chatLog.removeChild(chatLog.firstChild);
  }, 30000);
  setChat(chatOn);

  function addChat(m) {
    var li = document.createElement('li');
    li.setAttribute('data-t', m.t || Date.now());
    if (m.kind === 'system') { li.className = 'sys'; li.textContent = m.text; }
    else {
      var b = document.createElement('b'); b.textContent = m.name;
      if (me && m.name === me.nickname) li.className = 'mine';
      li.append(b, document.createTextNode(m.text));
    }
    var stick = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40; // keep following only if already at the bottom
    chatLog.append(li);
    while (chatLog.children.length > 60) chatLog.removeChild(chatLog.firstChild);
    if (stick || m.kind === 'user' && me && m.name === me.nickname) chatLog.scrollTop = chatLog.scrollHeight;
    if (!chatOn) { unread++; chatBtn.textContent = 'Chat: OFF (' + unread + ')'; }
  }
  function sendChat() {
    var t = chatInput.value.trim();
    chatInput.value = ''; chatInput.blur();
    if (t) post('/api/chat', { token: token, text: t }).catch(function () {});
  }
  chatInput.addEventListener('focus', function () { keys = {}; $('hint').classList.add('gone'); });

  // ---- input (event.code ignores the keyboard language, so it works with Korean IME too) ----
  var KEYMAP = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
                 KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
  window.addEventListener('keydown', function (e) {
    if (e.target === chatInput) { // typing a message: no game keys; Enter sends (not while a Korean IME is still composing)
      if (e.code === 'Enter' || e.code === 'NumpadEnter') { if (!e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendChat(); } }
      else if (e.code === 'Escape') chatInput.blur();
      return;
    }
    if (!playing) return;
    if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !shopOpen && !invOpen) { e.preventDefault(); if (!e.repeat) { setChat(true); chatInput.focus(); } return; }
    if (e.code === 'Escape') { if (shopOpen) toggleShop(false); else if (invOpen) toggleInv(false); return; }
    if (e.code === 'KeyZ') { if (!e.repeat) toggleShop(); e.preventDefault(); return; }
    if (e.code === 'KeyM') { if (!e.repeat) setMini(!miniOn); e.preventDefault(); return; }
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

  // ---- scene changes: fade quickly to black, switch while the screen is black, fade back in ----
  function transition(switchScene) {
    if (transitioning) return;
    transitioning = true; keys = {};
    var f = $('fade');
    f.style.pointerEvents = 'auto';
    f.style.opacity = '1';
    setTimeout(function () {
      switchScene();
      setTimeout(function () {
        f.style.opacity = '0';
        setTimeout(function () { f.style.pointerEvents = 'none'; transitioning = false; }, FADE_MS);
      }, 120);
    }, FADE_MS);
  }

  function toSpawn() {
    me.x = SKY.spawn.x; me.y = SKY.spawn.y; me.z = 0; me.vz = 0; me.dir = 0; me.moving = false;
    fall = null;
  }

  function enterSky() {
    transition(function () {
      scene = 'sky'; floaters = [];
      toSpawn();
      show('game');
      post('/api/scene', { token: token, sp: true }).catch(function () {});
    });
  }

  function exitSky() {
    transition(function () {
      scene = 'lobby'; floaters = []; fall = null;
      me.x = LOBBY_RETURN.x; me.y = LOBBY_RETURN.y; me.z = 0; me.vz = 0; me.dir = 0; me.moving = false;
      lastSent = null;
      show('game');
      post('/api/scene', { token: token, sp: false, x: me.x, y: me.y, dir: me.dir }).catch(function () {});
    });
  }

  // reached the star island: +10 gold, then back to the start of the course
  function reachStar() {
    floaters.push({ x: me.x, y: me.y - FH * SKY.scale - 34, text: '+10', color: '#ffd24a', t0: performance.now() });
    post('/api/reward', { token: token })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (typeof d.gold !== 'number') return;
        setGold(d.gold, true);
        addChat({ kind: 'system', text: '별에 도착했습니다! +10 골드' }); // only you see this line
      })
      .catch(function () {});
    transition(toSpawn);
  }

  // ---- game loop ----
  function update(dt) {
    var P = scene === 'sky' ? SKY : LOBBY;
    var free = !transitioning && !fall;
    var dx = free ? (keys.right ? 1 : 0) - (keys.left ? 1 : 0) : 0;
    var dy = free ? (keys.down ? 1 : 0) - (keys.up ? 1 : 0) : 0;
    me.moving = dx !== 0 || dy !== 0;
    if (me.moving) {
      var len = Math.hypot(dx, dy);
      me.x += (dx / len) * P.speed * dt;
      me.y += (dy / len) * P.speed * VERT * dt;
      me.dir = DIR_TABLE[dy + 1][dx + 1];
      if (scene === 'lobby') { // stay inside the elliptical floor (slides along the edge)
        var nx = (me.x - FLOOR.cx) / FLOOR.rx, ny = (me.y - FLOOR.cy) / FLOOR.ry, d = Math.hypot(nx, ny);
        if (d > 1) { me.x = FLOOR.cx + (nx / d) * FLOOR.rx; me.y = FLOOR.cy + (ny / d) * FLOOR.ry; }
      } else {
        me.x = Math.min(W - 4, Math.max(4, me.x)); me.y = Math.min(H - 4, Math.max(4, me.y));
      }
      if (!$('hint').classList.contains('gone')) $('hint').classList.add('gone');
    }
    // jump: Space launches the character into the air, gravity brings it back down
    if (free && keys.jump && me.z <= 0) { me.vz = P.jumpV; me.z = 0.01; }
    if (me.z > 0) {
      me.vz -= P.gravity * dt; me.z += me.vz * dt;
      if (me.z <= 0) { me.z = 0; me.vz = 0; }
    }

    if (scene === 'lobby') {
      // walking up to the gate with "싱글 플레이" on it starts the single-player course
      if (!transitioning && me.y <= DOOR_ZONE.maxY && Math.abs(me.x - DOOR.cx) <= DOOR_ZONE.halfW) enterSky();
    } else if (fall) {
      if (performance.now() - fall.t0 > FALL_MS) toSpawn(); // after the fall, back to the start
    } else if (free && me.z <= 0) {
      // the character only counts as standing somewhere when it is on the ground (not while jumping)
      var g = groundAt(me.x, me.y);
      if (g === 0) { fall = { t0: performance.now() }; keys.jump = false; me.moving = false; } // air or brown cliff: fall
      else if (g === 2) reachStar();
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

  function drawPlayer(p, t, isMe, sc) {
    var lift = p.z || 0;
    var bob = (p.moving && lift < 1) ? Math.abs(Math.sin(t / 85)) * 5 : 0;
    var raise = bob + lift, y = p.y, k = 1, alpha = 1;
    if (isMe && fall) { // falling off the island: drop down the screen, shrinking and fading out
      var ft = (t - fall.t0) / 1000;
      y += 0.5 * 1500 * ft * ft; k = Math.max(0.5, 1 - 0.5 * ft / (FALL_MS / 1000)); alpha = Math.max(0, 1 - ft / (FALL_MS / 1000));
    }
    var w = FW * sc * k, h = FH * sc * k;
    ctx.globalAlpha = alpha;
    if (!(isMe && fall)) {
      var sh = 1 - Math.min(0.45, lift / 140); // the shadow shrinks while the character is in the air
      ctx.fillStyle = 'rgba(40,30,10,' + (0.22 * sh).toFixed(3) + ')';
      ctx.beginPath(); ctx.ellipse(p.x, y - 2, 24 * sh * sc / 0.6, 8 * sh * sc / 0.6, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.drawImage(sprites, p.dir * FW, 0, FW, FH, p.x - w / 2, y - h - raise, w, h);

    ctx.font = '600 17px "Malgun Gothic", "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var tw = ctx.measureText(p.nickname).width + 22, ty = y - h - 14 - raise;
    ctx.fillStyle = isMe ? 'rgba(184,137,43,0.95)' : 'rgba(43,36,23,0.78)';
    ctx.beginPath(); ctx.roundRect(p.x - tw / 2, ty - 13, tw, 26, 13); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(p.nickname, p.x, ty + 1);
    ctx.globalAlpha = 1;
  }

  function drawFloaters(t) {
    floaters = floaters.filter(function (f) { return t - f.t0 < 1100; });
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.font = '800 30px "Malgun Gothic", "Segoe UI", system-ui, sans-serif';
    floaters.forEach(function (f) {
      var a = (t - f.t0) / 1100, y = f.y - a * 46;
      ctx.globalAlpha = 1 - a * a;
      ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(40,24,4,0.9)';
      ctx.strokeText(f.text, f.x, y);
      ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, y);
    });
    ctx.globalAlpha = 1;
  }

  // ---- minimap (top right): the arena with a dot for every player in the lobby. M or the Map button toggles it ----
  var miniOn = true, miniCv = $('miniCv'), mctx = miniCv.getContext('2d');
  try { miniOn = localStorage.getItem('miniOn') !== '0'; } catch (e) {}
  function setMini(on) {
    miniOn = on;
    try { localStorage.setItem('miniOn', on ? '1' : '0'); } catch (e) {}
    syncMini();
  }
  function syncMini() { // only in the lobby; the course is single-player
    var inLobby = playing && scene === 'lobby';
    $('miniBtn').hidden = !inLobby;
    $('miniBtn').classList.toggle('on', miniOn);
    $('mini').hidden = !(inLobby && miniOn);
  }
  $('miniBtn').addEventListener('mousedown', function (e) { e.preventDefault(); });
  $('miniBtn').addEventListener('click', function () { setMini(!miniOn); });
  function miniDot(x, y, r, fill, line) {
    mctx.beginPath(); mctx.arc(x, y, r, 0, Math.PI * 2);
    mctx.fillStyle = fill; mctx.fill(); mctx.lineWidth = 2; mctx.strokeStyle = line; mctx.stroke();
  }
  function drawMini(now) {
    if (!miniOn) return;
    var cw = miniCv.width, ch = miniCv.height, sx = cw / W, sy = ch / H;
    mctx.clearRect(0, 0, cw, ch);
    mctx.drawImage(bg, 0, 0, cw, ch);
    mctx.fillStyle = 'rgba(20,14,4,0.22)'; mctx.fillRect(0, 0, cw, ch);
    mctx.strokeStyle = 'rgba(255,227,161,0.95)'; mctx.lineWidth = 2; // the part of the arena on screen now
    mctx.strokeRect(cam.x * sx, cam.y * sy, (W / LOBBY_ZOOM) * sx, (H / LOBBY_ZOOM) * sy);
    lobbyOthers().forEach(function (id) { var o = others[id]; miniDot(o.x * sx, o.y * sy, 6, o.color || '#888', '#fff'); });
    miniDot(me.x * sx, me.y * sy, 8 + Math.sin(now / 250), '#ffd24a', '#3a2a08'); // you: gold, pulsing a little
  }
  var prev = performance.now();
  function loop(now) {
    var dt = Math.min(0.05, (now - prev) / 1000); prev = now;
    syncMini();
    if (playing && bg.complete && sprites.complete && skyBg.complete) {
      update(dt);
      ctx.clearRect(0, 0, W, H);
      if (scene === 'lobby') {
        sendState(now);
        // camera: zoom in on the player, easing toward them, never showing anything outside the arena image
        var vw = W / LOBBY_ZOOM, vh = H / LOBBY_ZOOM;
        var tx = Math.max(0, Math.min(W - vw, me.x - vw / 2));
        var ty = Math.max(0, Math.min(H - vh, me.y - 50 - vh / 2));
        if (!cam.ok) { cam.x = tx; cam.y = ty; cam.ok = true; }
        else { var ck = 1 - Math.exp(-dt * 10); cam.x += (tx - cam.x) * ck; cam.y += (ty - cam.y) * ck; }
        ctx.save();
        ctx.setTransform(LOBBY_ZOOM, 0, 0, LOBBY_ZOOM, -cam.x * LOBBY_ZOOM, -cam.y * LOBBY_ZOOM);
        ctx.drawImage(bg, 0, 0, W, H);
        drawDoorSign();
        var all = lobbyOthers().map(function (id) { return others[id]; });
        all.push(me);
        all.sort(function (a, b) { return a.y - b.y; }); // players lower on screen are drawn in front
        all.forEach(function (p) { drawPlayer(p, now, p === me, LOBBY.scale); });
        ctx.restore();
        drawMini(now);
      } else {
        cam.ok = false; // the next visit to the lobby starts centred on the player
        ctx.drawImage(skyBg, 0, 0, W, H); // the course is single-player: nobody else is drawn here
        drawPlayer(me, now, true, SKY.scale);
      }
      drawFloaters(now);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---- inventory (an empty panel for now): X key, the bag button, Esc or a click outside closes it ----
  function toggleInv(open) {
    if (open === undefined) open = !invOpen;
    if (open && !playing) return;
    if (open) { toggleShop(false); chatInput.blur(); }
    invOpen = open; keys = {};
    $('invWrap').hidden = !open;
    if (open) $('hint').classList.add('gone');
  }

  // ---- shop pop-up: opened with the shop button or Z, closed with the X drawn in the panel, Z again, or Esc ----
  function toggleShop(open) {
    if (open === undefined) open = !shopOpen;
    if (open && !playing) return;
    if (open) { toggleInv(false); chatInput.blur(); }
    shopOpen = open; keys = {};
    $('shopWrap').hidden = !open;
    if (open) $('hint').classList.add('gone');
  }

  $('invWrap').addEventListener('mousedown', function (e) { if (e.target === this) toggleInv(false); });
  // never let these buttons take keyboard focus, otherwise pressing Space would also "click" them
  ['bagBtn', 'shopBtn', 'exitBtn'].forEach(function (id) {
    $(id).addEventListener('mousedown', function (e) { e.preventDefault(); });
  });
  $('bagBtn').addEventListener('click', function () { toggleInv(); });
  $('shopBtn').addEventListener('click', function () { toggleShop(); });
  $('shopClose').addEventListener('click', function () { toggleShop(false); });
  canvas.addEventListener('mousedown', function () { chatInput.blur(); });

  // Clicking a chest in the shop: the server takes the gold; then the shop closes and the chat announces it to everyone.
  var buying = false;
  function buy(btn) {
    if (buying || !token) return;
    buying = true;
    post('/api/buy', { token: token, item: btn.getAttribute('data-item') })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        buying = false;
        if (typeof x.d.gold === 'number') setGold(x.d.gold, x.ok);
        if (x.ok) toggleShop(false);
        else { btn.classList.add('nogold'); setTimeout(function () { btn.classList.remove('nogold'); }, 450); } // not enough gold: the price shakes red
      })
      .catch(function () { buying = false; });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.shopItem'), function (btn) {
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function () { buy(btn); });
  });
  $('exitBtn').addEventListener('click', function () { if (scene === 'sky' && !transitioning) exitSky(); });

  // ---- UI events ----
  $('tabLogin').addEventListener('click', function () { setAuthMode(false); $('fId').focus(); });
  $('tabSignup').addEventListener('click', function () { setAuthMode(true); $('fId').focus(); });
  $('authForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    $('err').textContent = '';
    $('authGo').disabled = true;
    try { await authenticate(); } catch (err) { $('err').textContent = err.message; }
    $('authGo').disabled = false;
  });

  $('leave').addEventListener('click', async function () {
    var t = token;
    await post('/api/logout', { token: t }).catch(function () {});
    forgetMe('');
  });

  // A refresh keeps you logged in (the token is stored per tab); a new tab shows the login form.
  if (token) resume().catch(forgetMe);
  else show('join');
</script>
<div id="fade"></div>
</body>
</html>`;
