// centi — network layer. Mirrors the server's world into the same CentiSim objects the
// renderer already knows how to draw, and smooths between the 10-per-second snapshots.
// If the socket drops, the caller falls back to the local simulation.
(function (root) {
  'use strict';
  const THREE = root.THREE, CentiSim = root.CentiSim;
  const v3 = a => new THREE.Vector3(a[0], a[1], a[2]);

  class Net {
    constructor(url, world, opts) {
      this.url = url; this.world = world; this.opts = opts || {};
      this.ws = null; this.id = null; this.ready = false;
      this.lag = 0.12;                 // render this far behind the server so gaps are covered
      this.serverT = 0; this.renderT = 0;
      this.buffer = new Map();         // snake id -> [{t, p, h, len}] recent server positions
      this.onEvents = this.opts.onEvents || (() => {});
      this.onOpen = this.opts.onOpen || (() => {});
      this.onClose = this.opts.onClose || (() => {});
    }
    connect(name, look) {
      this.name = name; this.look = look;
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { this.onClose('bad url'); return; }
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name: this.name, look: this.look }));
      ws.onclose = () => { this.ready = false; this.onClose('closed'); };
      ws.onerror = () => { try { ws.close(); } catch (e) {} };
      ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } this.handle(m); };
    }
    disconnect() { this.ready = false; if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch (e) {} this.ws = null; } }
    send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
    input(steer, boost) { this.send({ type: 'in', s: Math.round(steer * 100) / 100, b: !!boost }); }
    respawn() { this.send({ type: 'respawn' }); }

    handle(m) {
      const w = this.world;
      if (m.type === 'welcome') { this.id = m.id; return; }
      if (m.type === 'full') {
        this.serverT = m.t; this.renderT = m.t - this.lag;
        m.food.forEach((f, i) => { const dst = w.food[i]; if (!dst) return; dst.p.copy(v3(f.p)); dst.boost = f.b; dst.colorIdx = f.c; dst.respawnAt = f.r; });
        w.jelly.length = 0;
        for (const j of m.jelly) w.jelly.push({ id: j.id, p: v3(j.p), until: 1e9, ph: j.ph, color: j.c });
        m.holes.forEach((h, i) => { const dst = w.holes[i]; if (!dst) return; dst.n.copy(v3(h.n)); dst.state = h.s; dst.t0 = h.t0; });
        m.storms.forEach((s, i) => { if (w.storms[i]) w.storms[i].p.copy(v3(s.p)); });
        for (const s of w.snakes.slice()) w.removeSnake(s.id);
        this.buffer.clear();
        for (const s of m.snakes) this.addSnake(s);
        this.ready = true; this.onOpen(this.id);
        return;
      }
      if (m.type === 'snap') {
        this.serverT = m.t;
        m.storms.forEach((p, i) => { if (w.storms[i]) w.storms[i].p.copy(v3(p)); });
        const live = new Set();
        for (const [id, p, h, len] of m.snakes) {
          live.add(id);
          let buf = this.buffer.get(id);
          if (!buf) { buf = []; this.buffer.set(id, buf); }
          buf.push({ t: m.t, p: v3(p), h: v3(h), len });
          while (buf.length > 8) buf.shift();
          const sn = w.snakes.find(x => x.id === id);
          if (sn) sn.serverLen = len;
        }
        for (const sn of w.snakes) if (sn.alive && !live.has(sn.id)) sn.alive = false;   // died between events
        return;
      }
      if (m.type === 'ev') { this.applyEvents(m.events); this.onEvents(m.events); return; }
    }
    addSnake(s) {
      const w = this.world;
      const sn = w.addSnake({ id: s.id, name: s.name, look: s.look, ai: s.bot ? s.ai : null });
      sn.isBot = !!s.bot; sn.ai = s.ai || null;
      sn.p.copy(v3(s.p)); sn.h.copy(v3(s.h));
      sn.trail = (s.trail || []).map(v3);
      if (!sn.trail.length) sn.trail = [sn.p.clone()];
      sn.curLen = sn.targetLen = sn.serverLen = s.len; sn.kills = s.kills || 0; sn.alive = true;
      this.buffer.set(s.id, [{ t: this.serverT, p: sn.p.clone(), h: sn.h.clone(), len: s.len }]);
      if (this.opts.onSnake) this.opts.onSnake(sn);
      return sn;
    }
    applyEvents(events) {
      const w = this.world;
      for (const e of events) {
        if (e.type === 'jellyAdd') { for (const j of e.items) w.jelly.push({ id: j.id, p: v3(j.p), until: 1e9, ph: j.ph, color: j.c }); }
        else if (e.type === 'jelly' || e.type === 'jellyGone') { const i = w.jelly.findIndex(j => j.id === e.jid); if (i >= 0) w.jelly.splice(i, 1); }
        else if (e.type === 'hole') { const h = w.holes[e.i]; if (h) { if (e.n) h.n.copy(v3(e.n)); h.state = e.state; h.t0 = e.t0; } }
        else if (e.type === 'food') { const f = w.food[e.i]; if (f) { f.p.copy(v3(e.p)); f.respawnAt = e.r; } }
        else if (e.type === 'spawn') {
          const existing = w.snakes.find(x => x.id === e.id);
          if (existing) w.removeSnake(e.id);
          if (e.snake) this.addSnake(e.snake);
        }
        else if (e.type === 'death') { const sn = w.snakes.find(x => x.id === e.id); if (sn) sn.alive = false; }
      }
    }
    // called every frame: move each snake along its buffered server positions and rebuild its trail
    interpolate(dtReal) {
      if (!this.ready) return;
      this.renderT = Math.min(this.renderT + dtReal, this.serverT);      // never render ahead of the server
      if (this.serverT - this.renderT > this.lag * 3) this.renderT = this.serverT - this.lag;   // fell behind: catch up
      for (const sn of this.world.snakes) {
        if (!sn.alive) continue;
        const buf = this.buffer.get(sn.id);
        if (!buf || !buf.length) continue;
        let a = buf[0], b = buf[buf.length - 1];
        for (let i = 0; i < buf.length - 1; i++) if (buf[i].t <= this.renderT && buf[i + 1].t >= this.renderT) { a = buf[i]; b = buf[i + 1]; break; }
        const span = b.t - a.t;
        const u = span > 1e-6 ? Math.min(1, Math.max(0, (this.renderT - a.t) / span)) : 1;
        sn.p.copy(a.p).lerp(b.p, u).normalize();
        sn.h.copy(a.h).lerp(b.h, u);
        sn.h.sub(sn.p.clone().multiplyScalar(sn.h.dot(sn.p)));
        if (sn.h.lengthSq() < 1e-8) sn.h.copy(b.h); else sn.h.normalize();
        sn.curLen += ((sn.serverLen !== undefined ? sn.serverLen : sn.curLen) - sn.curLen) * Math.min(1, dtReal * 6);
        sn.targetLen = sn.curLen;
        sn.record();                              // the body follows the head exactly as it does locally
      }
    }
  }

  root.CentiNet = Net;
})(typeof self !== 'undefined' ? self : this);
