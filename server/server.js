// Authoritative game server: serves dist/ and runs one room over WebSocket.
// Clients only send intent (settings, purchases, ready, input); every rule is
// decided here by the same game-core.js the single-player client uses.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { WebSocketServer } = require('ws');
const { ARENA_CONFIG: config, WEAPONS: weapons, ITEMS: items } = require('../dist/config.js');
const { createCore } = require('../dist/game-core.js');

const core = createCore({ config, weapons, items });
const PORT = +process.env.PORT || 3000, DIST = path.join(__dirname, '..', 'dist');
const PROTOCOL = 1, MAX_CRAFTS = 8, TICK_HZ = 60, TICK = 1 / TICK_HZ, SNAPSHOT_EVERY = 2, PING_MS = 25000;
const WEAPON_KEYS = Object.keys(weapons);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const r1 = v => Math.round(v * 10) / 10;

// ---- static files ----

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x').pathname;
  if (url === '/api/status') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok: true, protocol: PROTOCOL, lan: /^(localhost|127.0.0.1|[::1])(:|$)/.test(req.headers.host || '') ? lanUrls() : [] })); return; }
  let rel; try { rel = decodeURIComponent(url === '/' ? '/index.html' : url); } catch { res.writeHead(400); res.end(); return; }
  const file = path.join(DIST, path.normalize(rel));
  if (!file.startsWith(DIST + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(data);
  });
});

// Addresses other machines on the same network can reach this server at. Only handed to a browser running on
// this machine, which cannot share its own localhost address with anyone.
function lanUrls() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const n of list) if (n.family === 'IPv4' && !n.internal) found.push({ url: `http://${n.address}:${PORT}`, virtual: /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker/i.test(name) });
  // Virtual adapters (WSL, VM hosts) are not reachable by friends; list them only when nothing else exists.
  const real = found.filter(f => !f.virtual);
  return (real.length ? real : found).map(f => f.url);
}

// ---- room ----

const DEFAULT_SETTINGS = { ai: 2, mode: 'ffa', teams: 2, maxHp: 3, difficulty: 'normal', rounds: '5' };
const room = { phase: 'lobby', players: [], settings: { ...DEFAULT_SETTINGS }, run: null, battle: null, result: null, tick: 0, events: [], timer: null };
let nextCid = 1;

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const oneOf = (v, list, fallback) => list.includes(v) ? v : fallback;

function cleanSettings(s) {
  const humans = Math.max(1, room.players.length);
  const ai = Math.max(Math.max(0, 2 - humans), Math.min(MAX_CRAFTS - humans, Math.trunc(+s.ai) || 0));
  const teams = +s.teams === 4 && humans + ai >= 4 ? 4 : 2;
  return { ai, mode: oneOf(s.mode, ['ffa', 'team'], 'ffa'), teams, maxHp: +s.maxHp === 1 ? 1 : 3, difficulty: oneOf(s.difficulty, Object.keys(config.difficulty), 'normal'), rounds: oneOf(String(s.rounds), ['3', '5', '10', 'infinite'], '5') };
}

function publicRun() {
  const run = room.run; if (!run) return null;
  return { round: run.round, maxRounds: run.infinite ? null : run.maxRounds, infinite: run.infinite, settings: run.settings,
    pilots: run.pilots.map(p => ({ id: p.id, name: p.name, human: p.human, team: p.team, money: p.money, weapon: p.weapon, weaponLevel: p.weaponLevel, item: p.item, itemCharges: p.itemCharges, wins: p.wins, totalKills: p.totalKills })) };
}

function broadcastRoom() {
  const base = { t: 'room', hz: TICK_HZ, phase: room.phase, hostId: room.players[0]?.cid ?? null, settings: room.settings, run: publicRun(), result: room.result,
    players: room.players.map(p => ({ cid: p.cid, name: p.name, ready: p.ready, pilotId: p.pilotId })) };
  for (const p of room.players) send(p.ws, { ...base, you: p.cid, pilotId: p.pilotId });
}

function resetToLobby() {
  clearInterval(room.timer); room.timer = null;
  room.phase = 'lobby'; room.run = room.battle = room.result = null;
  for (const p of room.players) { p.ready = false; p.pilotId = null; }
  room.settings = cleanSettings(room.settings);
}

function startRun() {
  const s = room.settings = cleanSettings(room.settings), humans = room.players.length;
  room.run = core.createRun({ count: humans + s.ai, mode: s.mode, teams: s.teams, maxHp: s.maxHp, difficulty: s.difficulty, rounds: s.rounds, humans });
  room.players.forEach((p, i) => { p.pilotId = i; room.run.pilots[i].name = p.name; });
  enterShop();
}

function enterShop() {
  core.autoBuy(room.run);
  room.phase = 'shop'; room.result = null;
  for (const p of room.players) p.ready = false;
  broadcastRoom();
}

function startBattle() {
  room.battle = core.startBattle(room.run); room.phase = 'battle'; room.tick = 0; room.events = [];
  for (const p of room.players) { p.ready = false; p.cmd = { angle: null, move: false, fire: false }; p.useItem = false; p.seq = 0; p.applied = 0; }
  broadcastRoom();
  // setInterval is too coarse to trust for pacing, so real elapsed time is fed through an accumulator.
  let last = performance.now(), acc = 0;
  room.timer = setInterval(() => {
    const now = performance.now(); acc += Math.min(.25, (now - last) / 1000); last = now;
    while (acc >= TICK && room.phase === 'battle') { acc -= TICK; tick(); }
  }, 8);
}

function tick() {
  const battle = room.battle, commands = {};
  for (const p of room.players) { commands[p.pilotId] = { ...p.cmd, useItem: p.useItem }; p.useItem = false; }
  const fought = core.step(battle, TICK, commands);
  // Lets each client work out how much of its latest input this state already contains (see sendSnapshots).
  if (fought) for (const p of room.players) if (battle.crafts[p.pilotId].alive) p.applied++;
  room.events.push(...battle.events); battle.events.length = 0; room.tick++;
  if (battle.ended || room.tick % SNAPSHOT_EVERY === 0) sendSnapshots();
  if (battle.ended) finishBattle();
}

// Each player gets their own view: enemy mines and cloaked enemies are left out
// so that hidden information never reaches a client that should not see it.
function sendSnapshots() {
  const b = room.battle;
  const base = { t: 's', n: room.tick, tm: Math.round(b.time * 1000) / 1000, tl: r1(b.timeLeft), cd: r1(b.countdown), st: b.started, en: b.ended, bo: [...b.bountyIds], ev: room.events,
    // Bullet: x, y, vx, vy, weapon index, radius, wall bounces so far, flags (1 = explodes, 2 = wraps round the edges).
    b: b.bullets.map(x => [r1(x.x), r1(x.y), r1(x.vx), r1(x.vy), WEAPON_KEYS.indexOf(x.type), x.r, x.bounced, (x.blast ? 1 : 0) | (x.wrap ? 2 : 0)]),
    l: b.lasers.map(l => [r1(l.x), r1(l.y), l.angle, l.active ? 1 : 0, l.w, l.full ? 1 : 0]) };
  for (const p of room.players) {
    const me = room.run.pilots[p.pilotId];
    send(p.ws, { ...base,
      me: [me.money, me.weapon, me.item, me.itemCharges, me.weaponLevel],
      // Newest input received from this player, and how many ticks it has been simulated for.
      k: [p.seq, p.applied],
      c: b.crafts.map(c => !c.alive ? { al: 0 } : c.cloak > 0 && c.pilot.team !== me.team ? { al: 1, ck: 1, hid: 1 } : { al: 1, x: r1(c.x), y: r1(c.y), vx: r1(c.vx), vy: r1(c.vy), a: c.angle, hp: c.hp, sh: c.shield, ck: c.cloak > 0 ? 1 : 0, kn: c.knockT > 0 ? 1 : 0, le: c.satellites.filter(t => t <= 0).length }),
      m: b.mines.filter(m => m.team === me.team).map(m => [r1(m.x), r1(m.y)]) });
  }
  room.events = [];
}

function finishBattle() {
  clearInterval(room.timer); room.timer = null;
  const b = room.battle;
  room.result = { winnerIds: b.winnerIds, rows: b.resultRows.map(r => ({ id: r.c.pilot.id, win: r.win, kills: r.c.kills, survival: r.c.survival, killPay: r.killPay, survivePay: r.survivePay, outcome: r.outcome, total: r.total })) };
  room.phase = 'result';
  for (const p of room.players) p.ready = false;
  broadcastRoom();
}

function everyoneReady() {
  if (!room.players.length || !room.players.every(p => p.ready)) return;
  if (room.phase === 'shop') startBattle();
  else if (room.phase === 'result') {
    if (core.advanceRound(room.run)) enterShop();
    else { room.phase = 'final'; broadcastRoom(); resetToLobby(); broadcastRoom(); }
  }
}

// ---- connections ----

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });

wss.on('connection', ws => {
  let player = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (!player) { if (m.t === 'join') player = join(ws, m); return; }
    const host = room.players[0] === player;
    switch (m.t) {
      case 'settings': if (host && room.phase === 'lobby' && m.settings && typeof m.settings === 'object') { room.settings = cleanSettings(m.settings); broadcastRoom(); } break;
      case 'start': if (host && room.phase === 'lobby') startRun(); break;
      case 'buy': if (room.phase === 'shop' && core.buy(room.run, player.pilotId, m.kind, m.key)) broadcastRoom(); break;
      case 'ready': if ((room.phase === 'shop' || room.phase === 'result') && !player.ready) { player.ready = true; broadcastRoom(); everyoneReady(); } break;
      case 'input': if (room.phase === 'battle') { const d = Number.isInteger(m.d) && m.d >= 0 && m.d < 8 ? m.d : null; player.cmd = { angle: d === null ? null : d * Math.PI / 4, move: d !== null, fire: m.f === true }; if (Number.isInteger(m.s) && m.s > player.seq) { player.seq = m.s; player.applied = 0; } } break;
      case 'item': if (room.phase === 'battle') player.useItem = true; break;
    }
  });
  ws.on('close', () => { if (player) leave(player); });
  ws.on('error', () => {});
});

function join(ws, m) {
  const refuse = msg => { send(ws, { t: 'error', msg }); ws.close(); return null; };
  if (room.phase !== 'lobby') return refuse('對戰進行中，請等這一輪結束後再加入。');
  if (room.players.length >= MAX_CRAFTS) return refuse('房間已滿。');
  const cid = nextCid++;
  // Names end up in other players' pages, so only letters, digits and a few separators survive.
  const name = String(m.name ?? '').replace(/[^\p{L}\p{N}_\- ]/gu, '').trim().slice(0, 10) || `玩家${cid}`;
  const player = { ws, cid, name, ready: false, pilotId: null, cmd: { angle: null, move: false, fire: false }, useItem: false, seq: 0, applied: 0 };
  room.players.push(player);
  room.settings = cleanSettings(room.settings);
  console.log(`[room] ${name} 加入（${room.players.length} 人）`);
  broadcastRoom();
  return player;
}

function leave(player) {
  room.players = room.players.filter(p => p !== player);
  console.log(`[room] ${player.name} 離開（剩 ${room.players.length} 人）`);
  if (!room.players.length) { resetToLobby(); room.settings = { ...DEFAULT_SETTINGS }; return; }
  // Mid-run the craft stays in the fight and the AI takes it over for good.
  if (room.run) room.run.pilots[player.pilotId].human = false;
  else room.settings = cleanSettings(room.settings);
  broadcastRoom();
  everyoneReady();
}

setInterval(() => { for (const ws of wss.clients) if (ws.readyState === 1) ws.ping(); }, PING_MS);

server.listen(PORT, () => {
  console.log(`三角形競技場亂鬥 伺服器已啟動`);
  console.log(`  本機：        http://localhost:${PORT}`);
  for (const url of lanUrls()) console.log(`  區網其他電腦：${url}`);
});
