// centi — authoritative game server.
// Owns the world. Clients send steering; the server decides everything and broadcasts snapshots.
// One Room = one globe. Bots fill empty slots so a lone player still has a world to play in.
const http = require('http');
const { WebSocketServer } = require('ws');
const { World, C, PRESETS, lookFrom, BOT_DEFS } = require('./sim.js');

const PORT = process.env.PORT || 8080;
const TICK = 1 / 20;                 // 20 simulation steps a second
const SNAP_HZ = 20;                  // snapshots to clients per second
const ROOM_CAP = 40;                 // humans per globe
const MIN_POP = 10;                  // keep this many centipedes alive in total, bots making up the difference
const IDLE_MS = 60000;               // close an empty room after a minute

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sanitizeName = n => String(n || '').replace(/[<>&"']/g, '').trim().slice(0, 14);
const HEX = /^#[0-9a-fA-F]{6}$/;
const sanitizeLook = l => {
  const d = lookFrom(PRESETS[Math.floor(Math.random() * PRESETS.length)]);
  if (!l || typeof l !== 'object') return d;
  const pick = (v, f) => (typeof v === 'string' && HEX.test(v) ? v : f);
  return {
    a: pick(l.a, d.a), b: pick(l.b, d.b), head: pick(l.head, d.head), legs: pick(l.legs, d.legs),
    pattern: ['solid', 'stripes', 'gradient'].includes(l.pattern) ? l.pattern : d.pattern,
  };
};
const r3 = v => [Math.round(v.x * 1e4) / 1e4, Math.round(v.y * 1e4) / 1e4, Math.round(v.z * 1e4) / 1e4];

let roomSeq = 1;
class Room {
  constructor() {
    this.id = 'r' + roomSeq++;
    this.world = new World();
    this.clients = new Map();          // ws -> snake
    this.t = 0;
    this.emptySince = Date.now();
    this.world.resetHazards(0);
    this.topUpBots();
  }
  get humanCount() { return this.clients.size; }
  topUpBots() {
    const w = this.world;
    const bots = w.snakes.filter(s => s.isBot);
    const want = clamp(MIN_POP - this.humanCount, 3, BOT_DEFS.length);
    while (bots.length < want) {
      const def = BOT_DEFS[bots.length % BOT_DEFS.length];
      const b = w.addSnake(Object.assign({}, def, { name: def.name }));
      b.spawn(w.spawnAway(this.t, null), this.t);
      bots.push(b);
    }
    // too many bots (a room filled up with humans): retire the extras
    while (bots.length > want) { const b = bots.pop(); w.removeSnake(b.id); }
  }
  join(ws, name, look) {
    const w = this.world;
    const from = (w.humans()[0] || {}).p;
    const sn = w.addSnake({ name: sanitizeName(name) || 'centi', look: sanitizeLook(look) });
    sn.spawn(w.spawnAway(this.t, from), this.t);
    this.clients.set(ws, sn);
    this.topUpBots();
    return sn;
  }
  leave(ws) {
    const sn = this.clients.get(ws);
    if (!sn) return;
    this.clients.delete(ws);
    this.world.removeSnake(sn.id);
    if (!this.clients.size) this.emptySince = Date.now();
    this.topUpBots();
  }
  // full picture, sent once on join
  fullState() {
    const w = this.world;
    return {
      type: 'full', t: this.t, room: this.id,
      food: w.food.map(f => ({ p: r3(f.p), b: f.boost, c: f.colorIdx, r: f.respawnAt })),
      jelly: w.jelly.map(j => ({ id: j.id, p: r3(j.p), c: j.color, ph: j.ph })),
      holes: w.holes.map(h => ({ n: r3(h.n), s: h.state, t0: h.t0 })),
      storms: w.storms.map(s => ({ p: r3(s.p) })),
      snakes: w.snakes.filter(s => s.alive).map(s => this.snakeFull(s)),
    };
  }
  snakeFull(s) {
    return { id: s.id, name: s.name, look: s.look, bot: s.isBot, ai: s.ai, len: Math.round(s.curLen * 10) / 10,
             p: r3(s.p), h: r3(s.h), trail: s.trail.map(r3), kills: s.kills };
  }
  // per-tick delta: heads, headings and lengths
  snapshot() {
    const w = this.world;
    return {
      type: 'snap', t: this.t,
      storms: w.storms.map(s => r3(s.p)),
      snakes: w.snakes.filter(s => s.alive).map(s => [s.id, r3(s.p), r3(s.h), Math.round(s.curLen * 10) / 10]),
    };
  }
  step(dt) {
    this.t += dt;
    const events = this.world.step(dt, this.t);
    if (events.length) this.broadcast({ type: 'ev', t: this.t, events: events.map(e => this.packEvent(e)) });
  }
  packEvent(e) {
    if (e.type === 'jellyAdd') return { type: 'jellyAdd', items: e.items.map(j => ({ id: j.id, p: r3(j.p), c: j.color, ph: j.ph })) };
    if (e.type === 'hole') return { type: 'hole', i: e.i, state: e.state, t0: e.t0, n: e.n ? r3(e.n) : undefined };
    if (e.type === 'food') return { type: 'food', i: e.i, p: r3(e.p), r: e.respawnAt };
    if (e.type === 'spawn') { const s = this.world.snakes.find(x => x.id === e.id); return { type: 'spawn', id: e.id, snake: s ? this.snakeFull(s) : null }; }
    return e;
  }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.clients.keys()) if (ws.readyState === 1) ws.send(s);
  }
}

const rooms = [];
function pickRoom() {
  // join the fullest room that still has space, so games feel populated
  let best = null;
  for (const r of rooms) if (r.humanCount < ROOM_CAP && (!best || r.humanCount > best.humanCount)) best = r;
  if (!best) { best = new Room(); rooms.push(best); }
  return best;
}

// ---------- http + ws ----------
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.length, players: rooms.reduce((n, r) => n + r.humanCount, 0) }));
    return;
  }
  res.writeHead(404); res.end('centi server');
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', ws => {
  let room = null, snake = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.type === 'join') {
      if (room) return;
      room = pickRoom();
      snake = room.join(ws, m.name, m.look);
      ws.send(JSON.stringify({ type: 'welcome', id: snake.id, tick: TICK, C: { R: C.R, SEG: C.SEG } }));
      ws.send(JSON.stringify(room.fullState()));
      room.broadcast({ type: 'ev', t: room.t, events: [{ type: 'spawn', id: snake.id, snake: room.snakeFull(snake) }] });
    } else if (m.type === 'in' && snake) {
      snake.input.steer = clamp(+m.s || 0, -1, 1);
      snake.input.boost = !!m.b;
    } else if (m.type === 'respawn' && room && snake && !snake.alive) {
      snake.spawn(room.world.spawnAway(room.t, (room.world.humans().find(h => h !== snake) || {}).p), room.t);
      room.broadcast({ type: 'ev', t: room.t, events: [{ type: 'spawn', id: snake.id, snake: room.snakeFull(snake) }] });
    }
  });
  ws.on('close', () => { if (room) room.leave(ws); });
  ws.on('error', () => { try { ws.close(); } catch (e) {} });
});

// drop connections that stopped answering
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { try { ws.terminate(); } catch (e) {} continue; }
    ws.isAlive = false; try { ws.ping(); } catch (e) {}
  }
}, 15000);

// ---------- loops ----------
let last = Date.now();
setInterval(() => {
  const nowMs = Date.now();
  const dt = Math.min((nowMs - last) / 1000, 0.25); last = nowMs;
  for (const r of rooms) r.step(dt);
}, TICK * 1000);

setInterval(() => {
  for (const r of rooms) if (r.humanCount) r.broadcast(r.snapshot());
}, 1000 / SNAP_HZ);

setInterval(() => {                       // tidy up empty rooms
  for (let i = rooms.length - 1; i >= 0; i--) {
    const r = rooms[i];
    if (!r.humanCount && Date.now() - r.emptySince > IDLE_MS && rooms.length > 1) rooms.splice(i, 1);
  }
}, 30000);

server.listen(PORT, () => console.log('centi server listening on ' + PORT));
