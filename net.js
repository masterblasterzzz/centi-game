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
      this.ws = null; this.id = null; this.ready = false; this.cancelled = false;
      this.timeoutMs = this.opts.timeoutMs || 9000;   // the machine may be asleep; wait, but not forever
      this.timer = null;
      this.lag = 0.18;                 // others are drawn this far behind the server, so there is always a pair of samples to blend between
      this.serverT = 0; this.renderT = 0;
      this.buffer = new Map();         // snake id -> [{t, p, h, len}] recent server positions
      this.lastInput = { steer: 0, boost: false };
      this.selfSample = null;          // newest server truth for MY snake, with the wall-clock time it landed
      this.onEvents = this.opts.onEvents || (() => {});
      this.onOpen = this.opts.onOpen || (() => {});
      this.onClose = this.opts.onClose || (() => {});
    }
    connect(name, look) {
      this.name = name; this.look = look;
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { this.fail('bad-url'); return; }
      this.ws = ws;
      // the machine may be asleep and take a moment to wake; don't hang on it forever
      this.timer = setTimeout(() => { if (!this.ready) this.fail('timeout'); }, this.timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name: this.name, look: this.look }));
      ws.onclose = () => { if (!this.cancelled) this.fail(this.ready ? 'closed' : 'refused'); };
      ws.onerror = () => { try { ws.close(); } catch (e) {} };
      ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } this.handle(m); };
    }
    fail(reason) { if (this.cancelled) return; this.cancelled = true; this.clearTimer(); this.ready = false; this.onClose(reason); }
    clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
    cancel() { this.cancelled = true; this.clearTimer(); this.disconnect(); }
    disconnect() { this.cancelled = true; this.clearTimer(); this.ready = false; if (this.ws) { try { this.ws.onclose = null; this.ws.onmessage = null; this.ws.close(); } catch (e) {} this.ws = null; } }
    send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
    input(steer, boost) {
      this.lastInput.steer = steer; this.lastInput.boost = !!boost;    // kept so the local prediction steers the same way
      this.send({ type: 'in', s: Math.round(steer * 100) / 100, b: !!boost });
    }
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
        this.selfSample = null;
        this.ready = true; this.clearTimer(); this.onOpen(this.id);
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
          if (id === this.id) this.selfSample = { p: v3(p), h: v3(h), at: performance.now() / 1000 };
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
      // Keep the render clock about `lag` behind the server. Clamping it to serverT instead pins us to
      // the newest snapshot, which means no interpolation at all: heads then jump ten times a second
      // and every centipede appears to wobble from side to side.
      const target = this.serverT - this.lag;
      const drift = target - this.renderT;
      if (Math.abs(drift) > this.lag * 3) this.renderT = target;                                  // way out of step: resync
      else this.renderT += dtReal * (1 + Math.max(-.2, Math.min(.2, drift * 1.5)));               // else run slightly fast or slow
      for (const sn of this.world.snakes) {
        if (!sn.alive) continue;
        if (sn.id === this.id) { this.predictSelf(sn, dtReal); continue; }   // my own steering must feel instant
        const buf = this.buffer.get(sn.id);
        if (!buf || !buf.length) continue;
        let a = buf[0], b = buf[buf.length - 1];
        for (let i = 0; i < buf.length - 1; i++) if (buf[i].t <= this.renderT && buf[i + 1].t >= this.renderT) { a = buf[i]; b = buf[i + 1]; break; }
        if (this.renderT <= buf[0].t) { a = buf[0]; b = buf[Math.min(1, buf.length - 1)]; }        // just joined: hold at the oldest sample
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
    // My centipede runs the real rules locally from my own input, so steering responds on the frame
    // I move the mouse rather than a fifth of a second later. Waiting for the server instead makes
    // every correction overshoot, which is what saw-tooths you down the track.
    // The server stays in charge: its position is extrapolated to now and the prediction is eased
    // onto it, hard if we have drifted badly.
    predictSelf(sn, dtReal) {
      const C = CentiSim.C;
      sn.move(dtReal, this.lastInput.steer, this.lastInput.boost, this.world);
      sn.curLen += ((sn.serverLen !== undefined ? sn.serverLen : sn.curLen) - sn.curLen) * Math.min(1, dtReal * 6);
      sn.targetLen = sn.curLen;
      const s = this.selfSample;
      if (!s) return;
      // where the server's last word puts me *now*, carried forward along its heading
      const age = Math.min(.6, performance.now() / 1000 - s.at);
      const axis = new THREE.Vector3().crossVectors(s.p, s.h).normalize();
      const target = s.p.clone().applyAxisAngle(axis, C.BASE_SPEED * age / C.R).normalize();
      const err = sn.p.angleTo(target) * C.R;
      if (err > 55) sn.p.copy(target);                                   // badly out of step: take the server's word
      else if (err > 1) sn.p.lerp(target, Math.min(1, dtReal * 2)).normalize();   // otherwise drift onto it gently
      sn.h.sub(new THREE.Vector3().copy(sn.p).multiplyScalar(sn.h.dot(sn.p)));
      if (sn.h.lengthSq() < 1e-8) sn.h.copy(s.h); else sn.h.normalize();
    }
  }

  root.CentiNet = Net;
})(typeof self !== 'undefined' ? self : this);
