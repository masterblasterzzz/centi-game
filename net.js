// centi — network layer. Mirrors the server's world into the same CentiSim objects the
// renderer already knows how to draw, and smooths between the 20-per-second snapshots.
// If the socket drops, the caller falls back to the local simulation.
(function (root) {
  'use strict';
  const THREE = root.THREE, CentiSim = root.CentiSim;
  const v3 = a => new THREE.Vector3(a[0], a[1], a[2]);
  const IDENT = new THREE.Quaternion();

  class Net {
    constructor(url, world, opts) {
      this.url = url; this.world = world; this.opts = opts || {};
      this.ws = null; this.id = null; this.ready = false; this.cancelled = false;
      this.timeoutMs = this.opts.timeoutMs || 9000;   // the machine may be asleep; wait, but not forever
      this.timer = null;
      this.lag = 0.11;                 // others are drawn this far behind the server, so there is always a pair of samples to blend between
      this.serverT = 0; this.renderT = 0;
      this.buffer = new Map();         // snake id -> [{t, p, h, len}] recent server positions
      this.lastInput = { steer: 0, boost: false };
      this.seq = 0;                    // every input is numbered; the server tells us the last one it applied
      this.hist = [];                  // my predicted head after each numbered input: [{q, p, h}]
      this.selfSample = null;          // newest server truth for MY snake
      this.reconciledQ = -1;           // the input number we last reconciled against
      this.pred = null;                // my predicted centipede (a CentiSim.Snake run from my inputs)
      this.vis = new THREE.Quaternion();     // visual offset between the prediction and what is drawn; fades after a correction
      this.holdSince = 0;
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
      this.seq++;
      this.send({ type: 'in', s: Math.round(steer * 100) / 100, b: !!boost, q: this.seq });
    }
    respawn() { this.send({ type: 'respawn' }); }
    resetSelf() { this.selfSample = null; this.hist.length = 0; this.reconciledQ = -1; this.holdSince = 0; this.pred = null; this.vis.identity(); }

    handle(m) {
      const w = this.world;
      if (m.type === 'welcome') { this.id = m.id; return; }
      // The server's clock counts from when its room was made; the browser's from page load. Every
      // timestamp the server sends is converted to browser time here, or food shows as "not respawned
      // yet" for ever and sinkholes animate from the wrong moment.
      const local = st => performance.now() / 1000 + (st - m.t);
      if (m.type === 'full') {
        this.serverT = m.t; this.renderT = m.t - this.lag;
        m.food.forEach((f, i) => { const dst = w.food[i]; if (!dst) return; dst.p.copy(v3(f.p)); dst.boost = f.b; dst.colorIdx = f.c; dst.respawnAt = local(f.r); });
        w.jelly.length = 0;
        for (const j of m.jelly) w.jelly.push({ id: j.id, p: v3(j.p), until: 1e9, ph: j.ph, color: j.c });
        m.holes.forEach((h, i) => { const dst = w.holes[i]; if (!dst) return; dst.n.copy(v3(h.n)); dst.state = h.s; dst.t0 = local(h.t0); });
        m.storms.forEach((s, i) => { if (w.storms[i]) w.storms[i].p.copy(v3(s.p)); });
        for (const s of w.snakes.slice()) w.removeSnake(s.id);
        this.buffer.clear();
        for (const s of m.snakes) this.addSnake(s);
        this.resetSelf();
        this.ready = true; this.clearTimer(); this.onOpen(this.id);
        return;
      }
      if (m.type === 'snap') {
        this.serverT = m.t;
        m.storms.forEach((p, i) => { if (w.storms[i]) w.storms[i].p.copy(v3(p)); });
        const live = new Set();
        for (const [id, p, h, len, q] of m.snakes) {
          live.add(id);
          let buf = this.buffer.get(id);
          if (!buf) { buf = []; this.buffer.set(id, buf); }
          buf.push({ t: m.t, p: v3(p), h: v3(h), len });
          while (buf.length > 8) buf.shift();
          const sn = w.snakes.find(x => x.id === id);
          if (sn) sn.serverLen = len;
          if (id === this.id) this.selfSample = { p: v3(p), h: v3(h), q: q || 0, t: m.t, at: performance.now() / 1000 };
        }
        for (const sn of w.snakes) if (sn.alive && !live.has(sn.id)) sn.alive = false;   // died between events
        return;
      }
      if (m.type === 'ev') {
        for (const e of m.events) { if (e.type === 'hole') e.t0 = local(e.t0); if (e.type === 'food') e.r = local(e.r); }
        const evs = m.events.filter(e => !(e.type === 'portal' && e.id === this.id));   // my own portal is announced when my position actually snaps (see predictSelf)
        this.applyEvents(evs); this.onEvents(evs); return;
      }
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
          if (e.id === this.id) this.resetSelf();
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
      this.world.updatePortals(this.serverT);      // portals run on the server's clock; nothing else steps the world online
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
    // The server stays in charge, but it is checked like for like: every input is numbered and the
    // server reports the last number it applied. Its position is compared with where *we* were after
    // that same input; if they differ, the prediction restarts from the server's state and replays the
    // inputs sent since, so the corrected head is where the server will put it — and the display eases
    // onto it through a purely visual offset that fades over a few frames, never a jump.
    // Comparing against the server extrapolated to "now" (the old way) always disagreed in a turn — the
    // server runs ~140 ms behind your hand — so it tugged the head to the outside of every circle and
    // put deaths where you never saw yourself go.
    predictSelf(sn, dtReal) {
      const C = CentiSim.C, w = this.world;
      const nowS = performance.now() / 1000;
      let pred = this.pred;
      if (!pred || pred.snake !== sn) {                                   // fresh centipede (join or respawn): prediction starts from what the server sent
        pred = this.pred = new CentiSim.Snake({ id: 'pred' });
        pred.snake = sn; pred.p.copy(sn.p); pred.h.copy(sn.h); pred.trail = [sn.p.clone()];
        pred.alive = true; pred.portalCooldown = sn.portalCooldown; pred.speedMul = sn.speedMul; pred.turnMul = sn.turnMul;
        this.vis.identity();
      }
      // Portal jumps are the server's call. If we jumped locally, the next server sample would still
      // show us at the near pole and the correction would drag us back, then across again. Instead,
      // hold at the mouth until the server puts us through, then snap out the far side in one move.
      // Hold only once the server's copy is certain to have entered too (a touch inside the ring), and
      // never for long: if the server's copy grazed the edge and missed, waiting here is what made the
      // head go sticky near a pole.
      const atPortal = pred.portalCooldown <= 0 && C.PORTALS.some((n, i) => w.portalState[i].open && pred.p.angleTo(n) * C.R < C.PORTAL_R - 1.5);
      if (atPortal && !this.holdSince) this.holdSince = nowS;
      const held = atPortal && nowS - this.holdSince < .35;
      if (held) pred.steer = 0;
      else { if (atPortal) pred.portalCooldown = .6; this.holdSince = 0; pred.move(dtReal, this.lastInput.steer, this.lastInput.boost, w); }
      if (pred.portalCooldown > 0) pred.portalCooldown -= dtReal;
      pred.targetLen = sn.serverLen !== undefined ? sn.serverLen : sn.curLen;   // boost is allowed only while the server says there is length to burn
      // remember this input and where it left us, so the server's report for it can be checked later
      this.hist.push({ q: this.seq, steer: this.lastInput.steer, boost: this.lastInput.boost, dt: held ? 0 : dtReal, p: pred.p.clone(), h: pred.h.clone(), st: pred.steer });
      if (this.hist.length > 240) this.hist.shift();                     // ~4 s at 60 fps; far more than the round trip
      this.reconcile(sn, pred);
      // what is drawn: the prediction, plus a visual offset that fades out (~120 ms) after each correction
      const vis = this.vis;
      if (vis.w < .9999999) vis.slerp(IDENT, Math.min(1, dtReal * 8));
      sn.p.copy(pred.p).applyQuaternion(vis).normalize();
      sn.h.copy(pred.h).applyQuaternion(vis);
      sn.h.sub(new THREE.Vector3().copy(sn.p).multiplyScalar(sn.h.dot(sn.p)));
      if (sn.h.lengthSq() < 1e-8) sn.h.copy(pred.h); else sn.h.normalize();
      sn.steer = pred.steer; sn.boost = pred.boost; sn.inPull = pred.inPull; sn.pullK = pred.pullK; sn.portalCooldown = pred.portalCooldown;
      // Eat pellets the moment *my* head touches them. The server decides for real ~100 ms later; hide
      // the pellet now, and if no confirmation arrives it simply comes back. Waiting for the server made
      // pellets vanish from under your body, or not at all when its copy of you passed a whisker wide.
      for (const f of w.food) {
        if (f.respawnAt > nowS) continue;
        if (sn.p.angleTo(f.p) * C.R < (f.boost ? 7 : 4.5)) f.respawnAt = nowS + .7;
      }
      sn.curLen += ((sn.serverLen !== undefined ? sn.serverLen : sn.curLen) - sn.curLen) * Math.min(1, dtReal * 6);
      sn.targetLen = sn.curLen;
      sn.record();
    }
    reconcile(sn, pred) {
      const C = CentiSim.C, w = this.world, s = this.selfSample;
      if (!s || s.q === this.reconciledQ || !s.q) return;             // nothing new from the server, or it hasn't applied an input yet
      this.reconciledQ = s.q;
      const hi = this.hist.findIndex(x => x.q === s.q);
      if (hi < 0) return;                                                // older than our history (or from before a respawn)
      const was = this.hist[hi];
      this.hist.splice(0, hi);                                           // everything before that input is settled
      const err = was.p.angleTo(s.p) * C.R;
      if (err < .3) return;                                              // prediction and server agree; leave it alone
      // (a low bar on purpose: in a hard turn the two sims disagree by ~1 unit a second just from their
      // different step sizes, and letting that build up before fixing it is what makes a saw-tooth)
      const before = pred.p.clone();
      const portal = err > 60 && was.p.angleTo(s.p) > 2.6;               // near-antipodal = a portal jump, not a lag spike
      pred.p.copy(s.p); pred.h.copy(s.h); pred.steer = was.st;
      was.p.copy(s.p); was.h.copy(s.h);
      pred.trail = [pred.p.clone()];
      const cd = pred.portalCooldown; pred.portalCooldown = 99;           // never jump a portal during a replay
      for (let i = 1; i < this.hist.length; i++) {                       // replay every input sent since, from the server's state
        const x = this.hist[i];
        if (x.dt > 0) pred.move(x.dt, x.steer, x.boost, w);
        x.p.copy(pred.p); x.h.copy(pred.h); x.st = pred.steer;
      }
      pred.portalCooldown = cd;
      if (portal) {                                                      // take it in one move: snap the camera and play the sound now, not 100 ms early
        this.vis.identity(); pred.portalCooldown = 2.5; this.holdSince = 0;
        sn.p.copy(pred.p); sn.h.copy(pred.h); sn.record();
        this.onEvents([{ type: 'portal', id: this.id }]);
        return;
      }
      // keep what is on screen where it is this frame; the offset fades over the next few
      this.vis.multiply(new THREE.Quaternion().setFromUnitVectors(pred.p, before));
    }
  }

  root.CentiNet = Net;
})(typeof self !== 'undefined' ? self : this);
