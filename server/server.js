// Authoritative game server: serves dist/ and runs any number of rooms over WebSocket.
// Clients only send intent (settings, purchases, ready, input); every rule is
// decided here by the same game-core.js the single-player client uses.
// Each Room is self-contained (no shared mutable state), so rooms could later be
// spread over several processes or machines without changing the room code.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { WebSocketServer } = require('ws');
const { ARENA_CONFIG: config, WEAPONS: weapons, ITEMS: items } = require('../dist/config.js');
const { createCore } = require('../dist/game-core.js');

const core = createCore({ config, weapons, items });
const PORT = +process.env.PORT || 3000, DIST = path.join(__dirname, '..', 'dist');
const PROTOCOL = 2, MAX_CRAFTS = 8, TICK_HZ = 60, TICK = 1 / TICK_HZ, SNAPSHOT_EVERY = 2, PING_MS = 25000;
// How many rooms may exist at once, and how long the shop / result screens wait before moving on without stragglers.
const MAX_ROOMS = +process.env.MAX_ROOMS || 30, SHOP_SECONDS = +process.env.SHOP_SECONDS || 30, RESULT_SECONDS = +process.env.RESULT_SECONDS || 20;
const WEAPON_KEYS = Object.keys(weapons);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const r1 = v => Math.round(v * 10) / 10;
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const oneOf = (v, list, fallback) => list.includes(v) ? v : fallback;
// Names end up in other players' pages, so only letters, digits and a few separators survive.
const cleanText = (v, max) => String(v ?? '').replace(/[^\p{L}\p{N}_\- ]/gu, '').trim().slice(0, max);

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

// ---- rooms ----

const DEFAULT_SETTINGS = { ai: 2, mode: 'ffa', teams: 2, maxHp: 3, difficulty: 'normal', rounds: '5' };
const rooms = new Map();
// Every open connection; those not in a room are looking at the room list.
const clients = new Set();
let nextCid = 1;

function newRoomId() {
  let id;
  do id = Math.random().toString(36).slice(2, 6).toUpperCase(); while (id.length < 4 || rooms.has(id));
  return id;
}

function broadcastRooms() {
  const list = [...rooms.values()].map(r => r.summary());
  for (const c of clients) if (!c.room) send(c.ws, { t: 'rooms', rooms: list, max: MAX_ROOMS });
}

class Room {
  constructor(id, name) {
    Object.assign(this, { id, name, phase: 'lobby', players: [], settings: { ...DEFAULT_SETTINGS }, run: null, battle: null, result: null, tick: 0, events: [], timer: null, countdown: null, deadline: 0 });
  }

  // What the room list shows. Once a run has started, newcomers can only take over an AI-controlled craft.
  summary() {
    const aiSeats = this.run ? this.run.pilots.filter(p => !p.human).length : 0;
    return { id: this.id, name: this.name, host: this.players[0]?.name ?? '', phase: this.phase, round: this.run?.round ?? 0, maxRounds: this.run && !this.run.infinite ? this.run.maxRounds : null,
      humans: this.players.length, crafts: this.run ? this.run.pilots.length : this.players.length + this.settings.ai,
      aiSeats, joinable: this.run ? aiSeats > 0 : this.players.length < MAX_CRAFTS };
  }

  cleanSettings(s) {
    const humans = Math.max(1, this.players.length);
    const ai = Math.max(Math.max(0, 2 - humans), Math.min(MAX_CRAFTS - humans, Math.trunc(+s.ai) || 0));
    const teams = +s.teams === 4 && humans + ai >= 4 ? 4 : 2;
    return { ai, mode: oneOf(s.mode, ['ffa', 'team'], 'ffa'), teams, maxHp: +s.maxHp === 1 ? 1 : 3, difficulty: oneOf(s.difficulty, Object.keys(config.difficulty), 'normal'), rounds: oneOf(String(s.rounds), ['3', '5', '10', 'infinite'], '5') };
  }

  publicRun() {
    const run = this.run; if (!run) return null;
    return { round: run.round, maxRounds: run.infinite ? null : run.maxRounds, infinite: run.infinite, settings: run.settings,
      pilots: run.pilots.map(p => ({ id: p.id, name: p.name, human: p.human, team: p.team, money: p.money, weapon: p.weapon, weaponLevel: p.weaponLevel, item: p.item, itemCharges: p.itemCharges, wins: p.wins, totalKills: p.totalKills })) };
  }

  broadcast() {
    const left = this.countdown ? Math.max(0, this.deadline - Date.now()) : null;
    const base = { t: 'room', hz: TICK_HZ, id: this.id, name: this.name, phase: this.phase, hostId: this.players[0]?.cid ?? null, settings: this.settings, run: this.publicRun(), result: this.result, left,
      players: this.players.map(p => ({ cid: p.cid, name: p.name, ready: p.ready, pilotId: p.pilotId })) };
    for (const p of this.players) send(p.ws, { ...base, you: p.cid, pilotId: p.pilotId });
    broadcastRooms();
  }

  // ---- membership ----

  addPlayer(client, pilotId = null) {
    const player = { client, ws: client.ws, cid: client.cid, name: client.name, ready: false, pilotId, cmd: { angle: null, move: false, fire: false }, useItem: false, seq: 0, applied: 0 };
    this.players.push(player); client.room = this; client.player = player;
    if (!this.run) this.settings = this.cleanSettings(this.settings);
    console.log(`[${this.id} ${this.name}] ${player.name} 加入（${this.players.length} 人）`);
    this.broadcast();
  }

  // Joining a run already under way: take over the poorest AI-controlled craft with everything it owns.
  takeOver(client) {
    const seat = this.run.pilots.filter(p => !p.human).sort((a, z) => a.money - z.money || a.id - z.id)[0];
    if (!seat) return '這一間沒有可以接手的位置了。';
    seat.human = true; seat.name = client.name;
    this.addPlayer(client, seat.id);
    return null;
  }

  removePlayer(player) {
    this.players = this.players.filter(p => p !== player);
    player.client.room = null; player.client.player = null;
    console.log(`[${this.id} ${this.name}] ${player.name} 離開（剩 ${this.players.length} 人）`);
    if (!this.players.length) { this.close(); return; }
    // Mid-run the craft stays in the fight and the AI takes it over, until someone else takes it back.
    if (this.run) this.run.pilots[player.pilotId].human = false;
    else this.settings = this.cleanSettings(this.settings);
    this.broadcast();
    this.everyoneReady();
  }

  close(reason = null) {
    clearInterval(this.timer); this.timer = null; this.stopCountdown();
    rooms.delete(this.id);
    for (const p of this.players) { p.client.room = null; p.client.player = null; if (reason) send(p.ws, { t: 'error', msg: reason }); }
    this.players = [];
    console.log(`[${this.id} ${this.name}] 房間關閉${reason ? '：' + reason : ''}`);
    broadcastRooms();
  }

  // A bug in one room must not take the whole server (and every other room) down with it.
  guard(what, fn) {
    try { fn(); } catch (err) { console.error(`[${this.id} ${this.name}] ${what} 發生錯誤`, err); this.close('這個房間發生錯誤，已經關閉。'); }
  }

  // ---- flow ----

  startCountdown(seconds) {
    this.stopCountdown();
    this.deadline = Date.now() + seconds * 1000;
    this.countdown = setTimeout(() => this.guard('倒數', () => { this.countdown = null; for (const p of this.players) p.ready = true; this.everyoneReady(); }), seconds * 1000);
  }

  stopCountdown() { clearTimeout(this.countdown); this.countdown = null; }

  resetToLobby() {
    clearInterval(this.timer); this.timer = null; this.stopCountdown();
    this.phase = 'lobby'; this.run = this.battle = this.result = null;
    for (const p of this.players) { p.ready = false; p.pilotId = null; }
    this.settings = this.cleanSettings(this.settings);
  }

  startRun() {
    const s = this.settings = this.cleanSettings(this.settings), humans = this.players.length;
    this.run = core.createRun({ count: humans + s.ai, mode: s.mode, teams: s.teams, maxHp: s.maxHp, difficulty: s.difficulty, rounds: s.rounds, humans });
    this.players.forEach((p, i) => { p.pilotId = i; this.run.pilots[i].name = p.name; });
    this.enterShop();
  }

  enterShop() {
    core.autoBuy(this.run);
    this.phase = 'shop'; this.result = null;
    for (const p of this.players) p.ready = false;
    this.startCountdown(SHOP_SECONDS);
    this.broadcast();
  }

  startBattle() {
    this.stopCountdown();
    this.battle = core.startBattle(this.run); this.phase = 'battle'; this.tick = 0; this.events = [];
    for (const p of this.players) { p.ready = false; p.cmd = { angle: null, move: false, fire: false }; p.useItem = false; p.seq = 0; p.applied = 0; }
    this.broadcast();
    // setInterval is too coarse to trust for pacing, so real elapsed time is fed through an accumulator.
    let last = performance.now(), acc = 0;
    this.timer = setInterval(() => this.guard('戰鬥運算', () => {
      const now = performance.now(); acc += Math.min(.25, (now - last) / 1000); last = now;
      while (acc >= TICK && this.phase === 'battle') { acc -= TICK; this.step(); }
    }), 8);
  }

  step() {
    const battle = this.battle, commands = {};
    for (const p of this.players) { commands[p.pilotId] = { ...p.cmd, useItem: p.useItem }; p.useItem = false; }
    const fought = core.step(battle, TICK, commands);
    // Lets each client work out how much of its latest input this state already contains (see sendSnapshots).
    if (fought) for (const p of this.players) if (battle.crafts[p.pilotId].alive) p.applied++;
    this.events.push(...battle.events); battle.events.length = 0; this.tick++;
    if (battle.ended || this.tick % SNAPSHOT_EVERY === 0) this.sendSnapshots();
    if (battle.ended) this.finishBattle();
  }

  // Each player gets their own view: enemy mines and cloaked enemies are left out
  // so that hidden information never reaches a client that should not see it.
  sendSnapshots() {
    const b = this.battle;
    const base = { t: 's', n: this.tick, tm: Math.round(b.time * 1000) / 1000, tl: r1(b.timeLeft), cd: r1(b.countdown), st: b.started, en: b.ended, bo: [...b.bountyIds], ev: this.events,
      // Bullet: x, y, vx, vy, weapon index, radius, wall bounces so far, flags (1 = explodes, 2 = wraps round the edges).
      b: b.bullets.map(x => [r1(x.x), r1(x.y), r1(x.vx), r1(x.vy), WEAPON_KEYS.indexOf(x.type), x.r, x.bounced, (x.blast ? 1 : 0) | (x.wrap ? 2 : 0)]),
      l: b.lasers.map(l => [r1(l.x), r1(l.y), l.angle, l.active ? 1 : 0, l.w, l.full ? 1 : 0]) };
    for (const p of this.players) {
      const me = this.run.pilots[p.pilotId];
      send(p.ws, { ...base,
        me: [me.money, me.weapon, me.item, me.itemCharges, me.weaponLevel],
        // Newest input received from this player, and how many ticks it has been simulated for.
        k: [p.seq, p.applied],
        c: b.crafts.map(c => !c.alive ? { al: 0 } : c.cloak > 0 && c.pilot.team !== me.team ? { al: 1, ck: 1, hid: 1 } : { al: 1, x: r1(c.x), y: r1(c.y), vx: r1(c.vx), vy: r1(c.vy), a: c.angle, hp: c.hp, sh: c.shield, ck: c.cloak > 0 ? 1 : 0, kn: c.knockT > 0 ? 1 : 0, le: c.satellites.filter(t => t <= 0).length }),
        m: b.mines.filter(m => m.team === me.team).map(m => [r1(m.x), r1(m.y)]) });
    }
    this.events = [];
  }

  finishBattle() {
    clearInterval(this.timer); this.timer = null;
    const b = this.battle;
    this.result = { winnerIds: b.winnerIds, rows: b.resultRows.map(r => ({ id: r.c.pilot.id, win: r.win, kills: r.c.kills, survival: r.c.survival, killPay: r.killPay, survivePay: r.survivePay, outcome: r.outcome, total: r.total })) };
    this.phase = 'result';
    for (const p of this.players) p.ready = false;
    this.startCountdown(RESULT_SECONDS);
    this.broadcast();
  }

  everyoneReady() {
    if (!this.players.length || !this.players.every(p => p.ready)) return;
    if (this.phase === 'shop') this.startBattle();
    else if (this.phase === 'result') {
      if (core.advanceRound(this.run)) this.enterShop();
      else { this.stopCountdown(); this.phase = 'final'; this.broadcast(); this.resetToLobby(); this.broadcast(); }
    }
  }

  // ---- messages from a player in this room ----

  handle(player, m) {
    const host = this.players[0] === player;
    switch (m.t) {
      case 'settings': if (host && this.phase === 'lobby' && m.settings && typeof m.settings === 'object') { this.settings = this.cleanSettings(m.settings); this.broadcast(); } break;
      case 'start': if (host && this.phase === 'lobby') this.startRun(); break;
      case 'buy': if (this.phase === 'shop' && core.buy(this.run, player.pilotId, m.kind, m.key)) this.broadcast(); break;
      case 'ready': if ((this.phase === 'shop' || this.phase === 'result') && !player.ready) { player.ready = true; this.broadcast(); this.everyoneReady(); } break;
      case 'input': if (this.phase === 'battle') { const d = Number.isInteger(m.d) && m.d >= 0 && m.d < 8 ? m.d : null; player.cmd = { angle: d === null ? null : d * Math.PI / 4, move: d !== null, fire: m.f === true }; if (Number.isInteger(m.s) && m.s > player.seq) { player.seq = m.s; player.applied = 0; } } break;
      case 'item': if (this.phase === 'battle') player.useItem = true; break;
    }
  }
}

// ---- connections ----

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });

wss.on('connection', ws => {
  const client = { ws, cid: nextCid++, name: '', room: null, player: null };
  clients.add(client);
  send(ws, { t: 'rooms', rooms: [...rooms.values()].map(r => r.summary()), max: MAX_ROOMS });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (client.room) {
      const room = client.room;
      if (m.t === 'leave') { room.guard('離開', () => room.removePlayer(client.player)); send(ws, { t: 'rooms', rooms: [...rooms.values()].map(r => r.summary()), max: MAX_ROOMS }); }
      else room.guard('處理訊息', () => room.handle(client.player, m));
      return;
    }
    const refuse = msg => send(ws, { t: 'error', msg });
    if (m.t !== 'create' && m.t !== 'join') return;
    client.name = cleanText(m.name, 10) || `玩家${client.cid}`;
    if (m.t === 'create') {
      if (rooms.size >= MAX_ROOMS) return refuse(`房間數已達上限（${MAX_ROOMS} 間），請先加入現有的房間。`);
      const room = new Room(newRoomId(), cleanText(m.roomName, 16) || client.name);
      rooms.set(room.id, room);
      console.log(`[${room.id} ${room.name}] 建立`);
      room.addPlayer(client);
      return;
    }
    const room = rooms.get(String(m.roomId));
    if (!room) return refuse('這個房間已經關閉了。');
    if (!room.run) { if (room.players.length >= MAX_CRAFTS) return refuse('房間已滿。'); room.addPlayer(client); return; }
    const problem = room.takeOver(client);
    if (problem) refuse(problem);
  });
  ws.on('close', () => { clients.delete(client); if (client.room) { const room = client.room; room.guard('斷線', () => room.removePlayer(client.player)); } });
  ws.on('error', () => {});
});
wss.on('error', () => {});

setInterval(() => { for (const ws of wss.clients) if (ws.readyState === 1) ws.ping(); }, PING_MS);

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n無法啟動：${PORT} port 已經被佔用，可能已經有一個伺服器在跑。`);
    console.error(`請先關掉原本的伺服器（在它的終端機按 Ctrl+C），或改用其他 port，例如 PowerShell 輸入：$env:PORT=3001; npm start\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`三角形競技場亂鬥 伺服器已啟動`);
  console.log(`  本機：        http://localhost:${PORT}`);
  for (const url of lanUrls()) console.log(`  區網其他電腦：${url}`);
});
