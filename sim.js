// centi — simulation module.
// Everything about how the game *works* lives here: movement on the sphere, bots, food, jelly, portals,
// sinkholes, storms, collisions. Nothing about how it *looks*. The same file runs in the browser
// (window.CentiSim) and in Node (module.exports), which is what lets the server own the world.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('three'));
  else root.CentiSim = factory(root.THREE);
})(typeof self !== 'undefined' ? self : this, function (THREE) {
  'use strict';

  // ---------- constants (the tuning knobs) ----------
  const C = {
    R: 340,                     // globe radius
    SEG: 2.1,                   // arc length between body segments (~1000 segments to wrap once)
    MAX_SEG: 1600,
    FOOD_N: 250,                // 240 ordinary pellets + 10 boost pellets
    BOOST_N: 10,
    FOOD_RESPAWN: [9, 18],      // seconds before an eaten pellet reappears somewhere else
    BOOST_RESPAWN: [30, 50],
    MAX_JELLY: 900,
    JELLY_LIFE: 35,
    BASE_SPEED: 48, TURN: 4.0,  // turn radius = speed / TURN ≈ 12 units
    STEER_EASE: 7,              // how quickly steering ramps in/out (lower = smoother)
    HIT_R: 3.1,                 // head-to-body distance that counts as a hit
    PORTAL_R: 12,
    PORTAL_CYCLES: [{ open: 20, closed: 8, phase: 0 }, { open: 18, closed: 10, phase: 13 }],   // each pole runs its own clock
    HOLE_N: 10, HOLE_R: 9,
    STORM_N: 2, STORM_R: 22, STORM_H: 44,
    GRACE_LEN: 30, GRACE_SECS: 20,   // nobody hunts a newcomer
  };
  C.HOLE_PULL_R = C.HOLE_R * 2.4; C.HOLE_PULL_MAX = C.BASE_SPEED * 1.1;
  C.STORM_SPEED = C.BASE_SPEED / 8; C.PULL_R = C.STORM_R * 3.6; C.PULL_MAX = C.BASE_SPEED * 1.25;
  C.PORTALS = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0)];

  const AI = {
    easy:   { look: 14, react: .45, hunt: 0,   noise: .6,  boostDist: 0 },
    medium: { look: 22, react: .85, hunt: 0,   noise: .25, boostDist: 0 },
    hard:   { look: 34, react: 1,   hunt: 150, noise: .08, boostDist: 45 },
  };

  const PRESETS = [
    ['Ember',    '#d9542b', '#f2a33a', '#e8632f', '#0e0c0c', 'stripes'],
    ['Jade',     '#2ea86a', '#7ee787', '#37c27a', '#0a1a10', 'solid'],
    ['Midnight', '#24305e', '#5b6fd6', '#3a4bbf', '#000000', 'gradient'],
    ['Coral',    '#ff6b8a', '#ffd1dc', '#ff4d73', '#3a1020', 'stripes'],
    ['Wasp',     '#f5c518', '#1b1b1b', '#f5c518', '#000000', 'stripes'],
    ['Glacier',  '#bfe9ff', '#ffffff', '#9fd8ff', '#223344', 'gradient'],
    ['Magma',    '#ff3d00', '#3a0a00', '#ff5722', '#000000', 'gradient'],
    ['Toxic',    '#9dff00', '#2b7a00', '#b6ff3a', '#0a1a00', 'stripes'],
    ['Amethyst', '#8e5cff', '#d8c3ff', '#a06bff', '#201040', 'gradient'],
    ['Rust',     '#8a4b2a', '#c98c5a', '#a0563a', '#2b1a10', 'solid'],
    ['Ghost',    '#e8e8f0', '#b8b8c8', '#ffffff', '#555566', 'solid'],
    ['Bumble',   '#ff9f1c', '#ffffff', '#ff9f1c', '#000000', 'stripes'],
  ];
  const lookFrom = pr => ({ a: pr[1], b: pr[2], head: pr[3], legs: pr[4], pattern: pr[5] });

  const BOT_DEFS = [
    { name: 'Intern',   look: lookFrom(PRESETS[1]),  speed: .9,  turn: .9,   ai: 'easy' },
    { name: 'Gopher',   look: lookFrom(PRESETS[9]),  speed: .88, turn: .9,   ai: 'easy' },
    { name: 'Rookie',   look: lookFrom(PRESETS[11]), speed: .92, turn: .95,  ai: 'easy' },
    { name: 'Henchman', look: lookFrom(PRESETS[8]),  speed: .97, turn: 1,    ai: 'medium' },
    { name: 'Enforcer', look: lookFrom(PRESETS[2]),  speed: .96, turn: 1.05, ai: 'medium' },
    { name: 'Bouncer',  look: lookFrom(PRESETS[4]),  speed: .98, turn: 1,    ai: 'medium' },
    { name: 'Boss',     look: lookFrom(PRESETS[6]),  speed: 1.02, turn: 1.12, ai: 'hard' },
    { name: 'Warden',   look: lookFrom(PRESETS[7]),  speed: 1.0,  turn: 1.1,  ai: 'hard', hunt: 110 },
    { name: 'Assassin', look: lookFrom(PRESETS[10]), speed: 1.03, turn: 1.15, ai: 'hard', hunt: 130 },
  ];

  // ---------- helpers ----------
  const R = C.R, SEG = C.SEG;
  const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), axis = new THREE.Vector3();
  function randUnit() { let v; do { v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1); } while (v.lengthSq() > 1 || v.lengthSq() < .01); return v.normalize(); }
  function tangentAt(p) { const v = randUnit(); v.sub(tmpV.copy(p).multiplyScalar(v.dot(p))); return v.lengthSq() < .01 ? tangentAt(p) : v.normalize(); }
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ---------- snake (state + rules; no meshes) ----------
  let nextId = 1;
  class Snake {
    constructor(def) {
      this.id = def.id || ('s' + nextId++);
      this.name = def.name || 'You'; this.look = def.look;
      this.isBot = !!def.ai; this.ai = def.ai || null; this.huntRange = def.hunt;
      this.speedMul = def.speed || 1; this.turnMul = def.turn || 1;
      this.p = new THREE.Vector3(); this.h = new THREE.Vector3();
      this.trail = []; this.targetLen = 10; this.curLen = 10; this.steer = 0; this.boost = false;
      this.alive = false; this.ghost = false; this.respawnAt = 0; this.kills = 0; this.portalCooldown = 0;
      this.cutPoint = null; this.pendingCut = false; this.cutPortal = -1;
      this.inPull = false; this.pullK = 0; this.spawnedAt = 0; this.aiState = null;
      this.input = { steer: 0, boost: false };
    }
    girth() { return 1 + Math.min(1, (this.curLen - 10) / 250); }     // doubles in width by ~260 segments
    spawn(pos, t) {
      this.p.copy(pos); this.h.copy(tangentAt(this.p));
      this.trail.length = 0; this.trail.push(this.p.clone());
      this.targetLen = this.curLen = 10; this.steer = 0; this.boost = false; this.boostDebt = 0;
      this.alive = true; this.portalCooldown = 0; this.spawnedAt = t;
      this.cutPoint = null; this.pendingCut = false; this.cutPortal = -1; this.aiState = null;
    }
    // the portal closed while the tail was still on the far side: everything behind the cut is lost as jelly
    sever(t, world) {
      if (!this.cutPoint) return 0;
      const idx = this.trail.indexOf(this.cutPoint);
      this.cutPoint = null;
      if (idx <= 0) return 0;
      world.dropJellyPoints(this.trail.slice(0, idx), this.look.a, t);
      this.trail.splice(0, idx);
      const remaining = this.trail.length - 1;
      this.targetLen = Math.max(10, remaining); this.curLen = Math.max(10, Math.min(this.curLen, remaining));
      return idx;
    }
    die(t, world) { this.alive = false; world.dropJellyPoints(this.trail, this.look.a, t); this.respawnAt = t + 4 + Math.random() * 3; }
    // Integrate in slices no longer than a 60 Hz frame. The server ticks at 20 Hz and the client predicts
    // per frame; with one Euler step per call the two traced slightly different arcs in every turn
    // (~1.2 units/s apart), which the client then had to keep correcting — seen as a side-to-side sway.
    move(dt, steerIn, boostIn, world) {
      const n = Math.max(1, Math.ceil(dt * 60 - 1e-6)), h = dt / n;
      let jumped = false;
      for (let i = 0; i < n; i++) if (this.moveStep(h, steerIn, boostIn, world)) jumped = true;
      return jumped;
    }
    moveStep(dt, steerIn, boostIn, world) {
      this.steer += (steerIn - this.steer) * Math.min(1, dt * C.STEER_EASE);
      const canBoost = boostIn && this.targetLen > 10;
      this.boost = canBoost;
      const speed = C.BASE_SPEED * this.speedMul * (canBoost ? 1.9 : 1);
      // Boost costs 4% of your length a second (2.2 segments minimum) and the loss is dropped as jelly behind
      // the tail in world.step, so a chaser gets fed. A flat 2.2 was 4x cheaper than slither.io at 200 and fed nobody.
      if (canBoost) { const cost = dt * Math.max(2.2, this.targetLen * .04); this.targetLen -= cost; this.boostDebt = (this.boostDebt || 0) + cost; }
      const p = this.p, h = this.h;
      axis.crossVectors(p, h).normalize();
      p.applyAxisAngle(axis, speed * dt / R);
      h.applyAxisAngle(axis, speed * dt / R);
      h.applyAxisAngle(p, -this.steer * C.TURN * this.turnMul * dt);
      p.normalize();
      h.sub(tmpV.copy(p).multiplyScalar(h.dot(p))).normalize();
      this.pullK = world.applyPull(p, dt); this.inPull = this.pullK > 0;
      // portal
      this.portalCooldown -= dt;
      let jumped = false;
      if (this.portalCooldown <= 0) {
        C.PORTALS.forEach((n, i) => {
          if (!jumped && world.portalState[i].open && p.angleTo(n) * R < C.PORTAL_R) {
            p.negate(); this.portalCooldown = 2.5; jumped = true;
            this.pendingCut = true; this.cutPortal = i;         // body is still streaming through portal i
          }
        });
      }
      this.curLen += (this.targetLen - this.curLen) * Math.min(1, dt * 3);
      if (this.curLen < 10) this.curLen = this.targetLen = 10;
      this.record();
      return jumped;
    }
    record() {
      const p = this.p, trail = this.trail;
      let last = trail[trail.length - 1];
      let d = last.angleTo(p) * R;
      if (d > SEG * 6) { const np = p.clone(); trail.push(np); if (this.pendingCut) { this.cutPoint = np; this.pendingCut = false; } }   // portal jump: leave a cut in the trail
      else while (d >= SEG) {
        const np = new THREE.Vector3().lerpVectors(last, p, SEG / d).normalize();
        trail.push(np); last = np; d = last.angleTo(p) * R;
      }
      while (trail.length > Math.ceil(this.curLen) + 3) trail.shift();
    }
  }

  // ---------- world ----------
  const pullDir = new THREE.Vector3(), pullAxis = new THREE.Vector3();
  const probe = new THREE.Vector3(), toT = new THREE.Vector3(), pax = new THREE.Vector3();

  class World {
    constructor() {
      this.snakes = [];
      this.food = [];
      for (let i = 0; i < C.FOOD_N; i++) this.food.push({ p: randUnit(), ph: Math.random() * 6.28, respawnAt: 0, boost: i < C.BOOST_N, colorIdx: Math.floor(Math.random() * 3) });
      this.jelly = [];
      this.holes = [];
      for (let i = 0; i < C.HOLE_N; i++) this.holes.push({ n: new THREE.Vector3(0, 1, 0), state: 'closed', t0: 0, until: 0, nextAt: 4 + i * 2.5 + Math.random() * 6 });
      this.storms = [];
      for (let i = 0; i < C.STORM_N; i++) { const p = randUnit(); this.storms.push({ p, h: tangentAt(p), seed: Math.random() * 100 }); }
      this.portalState = [{ open: true, left: 20 }, { open: true, left: 18 }];
      this.events = [];          // what happened this step, for the client to react to (sounds, feed, killcam)
      this.t = 0; this.nextJelly = 1;
    }
    // --- population ---
    addSnake(def) { const s = new Snake(def); this.snakes.push(s); return s; }
    removeSnake(id) { const i = this.snakes.findIndex(s => s.id === id); if (i >= 0) this.snakes.splice(i, 1); }
    addBots() { return BOT_DEFS.map(d => this.addSnake(Object.assign({}, d))); }
    humans() { return this.snakes.filter(s => !s.isBot); }
    setInput(id, steer, boost) { const s = this.snakes.find(x => x.id === id); if (s) { s.input.steer = steer; s.input.boost = boost; } }
    spawnAway(t, from) { let pos; do { pos = randUnit(); } while ((from && pos.angleTo(from) * R < 90) || this.inHole(pos) || this.inStorm(pos)); return pos; }
    resetHazards(t) {
      this.holes.forEach((hole, i) => { hole.state = 'closed'; hole.nextAt = t + 4 + i * 2.5 + Math.random() * 5; });
      const from = this.humans()[0];
      for (const st of this.storms) { let pos; do { pos = randUnit(); } while ((from && pos.angleTo(from.p) * R < 170) || this.storms.some(o => o !== st && o.p.angleTo(pos) * R < C.PULL_R * 2.5)); st.p = pos; st.h = tangentAt(pos); }
    }
    // --- hazards ---
    inHole(p) { return this.holes.some(h => h.state === 'open' && p.angleTo(h.n) * R < C.HOLE_R); }
    inStorm(p) { return this.storms.some(st => p.angleTo(st.p) * R < C.STORM_R * .8); }
    pullToward(p, centre, dist, innerR, outerR, maxPull, dt) {
      const k = Math.max(0, 1 - (dist - innerR) / (outerR - innerR));   // 0 at the outer ring, 1 at the hazard edge
      if (k <= 0) return 0;
      pullDir.copy(centre).sub(tmpV.copy(p).multiplyScalar(centre.dot(p)));
      if (pullDir.lengthSq() < 1e-8) return k;
      pullDir.normalize();
      pullAxis.crossVectors(p, pullDir).normalize();
      p.applyAxisAngle(pullAxis, maxPull * Math.pow(k, 1.4) * dt / R);
      return k;
    }
    applyPull(p, dt) {          // suction from storms and open sinkholes; returns strength 0..1
      let k = 0;
      for (const st of this.storms) { const d = p.angleTo(st.p) * R; if (d < C.PULL_R) k = Math.max(k, this.pullToward(p, st.p, d, C.STORM_R * .8, C.PULL_R, C.PULL_MAX, dt)); }
      for (const hole of this.holes) { if (hole.state !== 'open') continue; const d = p.angleTo(hole.n) * R; if (d < C.HOLE_PULL_R) k = Math.max(k, this.pullToward(p, hole.n, d, C.HOLE_R, C.HOLE_PULL_R, C.HOLE_PULL_MAX, dt)); }
      return k;
    }
    updateHoles(t, dt) {
      const avoid = this.humans().map(s => s.p);
      for (const hole of this.holes) {
        if (hole.state === 'closed') {
          if (t >= hole.nextAt) {
            let n; do { n = randUnit(); } while (avoid.some(a => n.angleTo(a) * R < 45) || Math.abs(n.y) > .9);   // never under a player or on a pole
            hole.n = n; hole.state = 'opening'; hole.t0 = t;
            this.events.push({ type: 'hole', i: this.holes.indexOf(hole), state: 'opening', n, t0: t });
          }
          continue;
        }
        const before = hole.state;
        if (hole.state === 'opening') { if (t - hole.t0 >= 1.5) { hole.state = 'open'; hole.until = t + 14 + Math.random() * 14; } }
        else if (hole.state === 'open') { if (t >= hole.until) { hole.state = 'closing'; hole.t0 = t; } }
        else if (t - hole.t0 >= .8) { hole.state = 'closed'; hole.nextAt = t + 2 + Math.random() * 5; }
        if (hole.state !== before) this.events.push({ type: 'hole', i: this.holes.indexOf(hole), state: hole.state, t0: hole.t0 });
      }
    }
    updateStorms(t, dt) {
      for (const st of this.storms) {
        // wander: slow drift of heading; steer off the poles so it never parks on a portal, and off the other storm
        let turn = Math.sin(t * .31 + st.seed) * .35 + Math.sin(t * .11 + st.seed * 2) * .25;
        if (Math.abs(st.p.y) > .72) turn += (st.h.y * st.p.y > 0 ? 1 : -1) * .7;
        for (const o of this.storms) if (o !== st && o.p.angleTo(st.p) * R < C.PULL_R * 2.2) turn += .5;
        st.h.applyAxisAngle(st.p, turn * dt);
        axis.crossVectors(st.p, st.h).normalize();
        st.p.applyAxisAngle(axis, C.STORM_SPEED * dt / R);
        st.h.applyAxisAngle(axis, C.STORM_SPEED * dt / R);
        st.p.normalize(); st.h.sub(tmpV.copy(st.p).multiplyScalar(st.h.dot(st.p))).normalize();
      }
    }
    updatePortals(t) {
      C.PORTAL_CYCLES.forEach((cy, i) => {
        const st = this.portalState[i];
        const cycle = (t + cy.phase) % (cy.open + cy.closed);
        const open = cycle < cy.open, left = cy.open - cycle;
        if (st.open && !open) for (const sn of this.snakes) if (sn.alive && sn.cutPoint) { const lost = sn.sever(t, this); if (lost) this.events.push({ type: 'sever', id: sn.id, lost }); }
        st.open = open; st.left = left;
      });
      for (const sn of this.snakes) if (sn.cutPoint && sn.trail.indexOf(sn.cutPoint) <= 0) { sn.cutPoint = null; sn.cutPortal = -1; }
    }
    // --- jelly ---
    dropJellyPoints(points, hex, t) {
      const added = [];
      for (let i = 0; i < points.length; i += 2) {
        if (this.jelly.length >= C.MAX_JELLY) this.jelly.shift();
        const off = tangentAt(points[i]).multiplyScalar(rnd(0, 2.2) / R);
        const j = { id: this.nextJelly++, p: points[i].clone().add(off).normalize(), until: t + C.JELLY_LIFE, ph: Math.random() * 6.28, color: hex };
        this.jelly.push(j); added.push(j);
      }
      if (added.length) this.events.push({ type: 'jellyAdd', items: added });
    }
    // --- bot AI ---
    steerToward(s, target) {
      toT.copy(target).sub(tmpV2.copy(s.p).multiplyScalar(target.dot(s.p)));
      if (toT.lengthSq() < 1e-8) return 0;
      toT.normalize();
      const side = pax.crossVectors(s.h, toT).dot(s.p);       // >0 target is to the left
      const ang = Math.acos(Math.min(1, Math.max(-1, s.h.dot(toT))));
      return -Math.sign(side) * Math.min(1, ang * 1.6);
    }
    dangerAt(s, pt) {           // smallest clearance around a probe point
      let best = 99;
      for (const o of this.snakes) {
        if (!o.alive || o === s) continue;
        const tr = o.trail;
        const dh = pt.distanceTo(o.p) * R; if (dh < best) best = dh;
        if (dh > tr.length * SEG + 12) continue;          // too far for any part of that body to matter
        for (let i = 0; i < tr.length; i++) { const d = pt.distanceTo(tr[i]) * R; if (d < best) best = d; }
      }
      for (const hole of this.holes) if (hole.state !== 'closed') { const d = pt.distanceTo(hole.n) * R - C.HOLE_R; if (d < best) best = d; }
      for (const st of this.storms) { const d = pt.distanceTo(st.p) * R - C.STORM_R * 1.3; if (d < best) best = d; }
      return best;
    }
    probeAt(s, angle, dist) {
      tmpV.copy(s.h).applyAxisAngle(s.p, angle);
      pax.crossVectors(s.p, tmpV).normalize();
      return probe.copy(s.p).applyAxisAngle(pax, dist / R);
    }
    botThink(s, t) {
      const cfg = AI[s.ai];
      if (!s.aiState) s.aiState = { retarget: 0, target: null, seed: Math.random() * 100, steer: 0, hunting: false, prey: null };
      const st = s.aiState;
      if (t > st.retarget) {
        st.retarget = t + rnd(1.2, 3);
        st.target = null; st.hunting = false; st.prey = null; let bestD = 1e9;
        const huntR = s.huntRange || cfg.hunt;
        if (huntR) {   // hunt the nearest human who isn't a newcomer
          for (const hmn of this.humans()) {
            if (!hmn.alive || hmn.ghost || hmn.curLen < C.GRACE_LEN || t - hmn.spawnedAt < C.GRACE_SECS) continue;
            const d = hmn.p.angleTo(s.p) * R;
            if (d < huntR && d < bestD) { bestD = d; st.prey = hmn; }
          }
        }
        if (st.prey) { st.target = tmpV.copy(st.prey.p).addScaledVector(st.prey.h, 16 / R).normalize().clone(); st.hunting = true; }   // cut across their path
        else {
          for (const j of this.jelly) { const d = j.p.angleTo(s.p) * R; if (d < bestD) { bestD = d; st.target = j.p; } }
          for (const f of this.food) { if (f.respawnAt > t) continue; const d = f.p.angleTo(s.p) * R * (f.boost ? .6 : 1); if (d < bestD) { bestD = d; st.target = f.p; } }
        }
      }
      let want = st.target ? this.steerToward(s, st.target) : 0;
      let fleeing = false;
      for (const sm of this.storms) { const d = sm.p.angleTo(s.p) * R; if (d < C.PULL_R + 10) { want = this.steerToward(s, tmpV2.copy(s.p).multiplyScalar(2).sub(sm.p)); fleeing = true; break; } }
      if (!fleeing) for (const hole of this.holes) { if (hole.state !== 'open') continue; const d = hole.n.angleTo(s.p) * R; if (d < C.HOLE_PULL_R + 6) { want = this.steerToward(s, tmpV2.copy(s.p).multiplyScalar(2).sub(hole.n)); fleeing = true; break; } }
      want += Math.sin(t * .9 + st.seed) * cfg.noise;
      if (Math.random() < cfg.react) {
        const L = cfg.look + (s.boost ? 10 : 0);
        const f0 = this.dangerAt(s, this.probeAt(s, 0, L));
        if (f0 < 9) {
          const fl = this.dangerAt(s, this.probeAt(s, .8, L * .8));
          const fr = this.dangerAt(s, this.probeAt(s, -.8, L * .8));
          want = fl > fr ? -1 : 1;
        }
        st.steer = want;
      }
      const prey = st.prey && st.prey.alive ? st.prey : null;
      const boost = (fleeing && s.targetLen > 11 && s.inPull) || (cfg.boostDist > 0 && st.hunting && prey && prey.p.angleTo(s.p) * R < cfg.boostDist && s.targetLen > 16);
      return { steer: Math.max(-1, Math.min(1, st.steer)), boost };
    }
    // --- one tick ---
    step(dt, t) {
      this.t = t;
      this.events.length = 0;
      this.updatePortals(t);
      for (const sn of this.snakes) {
        if (!sn.alive) { if (sn.isBot && t >= sn.respawnAt) { sn.spawn(this.spawnAway(t, (this.humans()[0] || {}).p), t); this.events.push({ type: 'spawn', id: sn.id }); } continue; }
        if (sn.ghost) continue;
        const cmd = sn.isBot ? this.botThink(sn, t) : sn.input;
        if (sn.move(dt, cmd.steer, cmd.boost, this)) this.events.push({ type: 'portal', id: sn.id });
        if (sn.boostDebt >= 2) { sn.boostDebt -= 2; this.dropJellyPoints([sn.trail[0]], sn.look.a, t); }   // one jelly (worth 2) per 2 length boosted away
      }
      this.updateHoles(t, dt);
      this.updateStorms(t, dt);
      // eating
      for (const sn of this.snakes) {
        if (!sn.alive) continue;
        for (const f of this.food) {
          if (f.respawnAt <= t && sn.p.angleTo(f.p) * R < (f.boost ? 7 : 4) + (sn.isBot ? 0 : (this.eatSlack || 0))) {
            sn.targetLen += f.boost ? Math.max(4, sn.targetLen * .25) : 1;
            this.events.push({ type: 'eat', id: sn.id, boost: f.boost });
            const rs = f.boost ? C.BOOST_RESPAWN : C.FOOD_RESPAWN;
            f.p = randUnit(); f.respawnAt = t + rs[0] + Math.random() * (rs[1] - rs[0]);
            this.events.push({ type: 'food', i: this.food.indexOf(f), p: f.p, respawnAt: f.respawnAt });
          }
        }
        for (let i = this.jelly.length - 1; i >= 0; i--) if (sn.p.angleTo(this.jelly[i].p) * R < 3.6) { sn.targetLen += 2; const j = this.jelly.splice(i, 1)[0]; this.events.push({ type: 'jelly', id: sn.id, jid: j.id }); }
      }
      for (let i = this.jelly.length - 1; i >= 0; i--) if (this.jelly[i].until < t) { const j = this.jelly.splice(i, 1)[0]; this.events.push({ type: 'jellyGone', jid: j.id }); }
      // collisions: head into any other body, head-to-head, sinkholes, storms
      const dead = [];
      for (const sn of this.snakes) {
        if (!sn.alive || sn.ghost) continue;
        if (this.inHole(sn.p)) { dead.push([sn, 'sinkhole', null]); continue; }
        if (this.inStorm(sn.p)) { dead.push([sn, 'storm', null]); continue; }
        for (const o of this.snakes) {
          if (o === sn || !o.alive) continue;
          const dh = sn.p.distanceTo(o.p) * R;
          const hr = C.HIT_R * (.55 + .45 * o.girth());                       // fatter bodies are easier to hit
          if (dh < hr * 1.2 && !o.ghost) { dead.push([sn, 'headon', o]); break; }
          if (dh > o.trail.length * SEG + hr + 2) continue;
          let hit = false;
          for (let i = 0; i < o.trail.length; i++) if (sn.p.distanceTo(o.trail[i]) * R < hr) { hit = true; break; }
          if (hit) { dead.push([sn, 'eaten', o]); break; }
        }
      }
      const seen = new Set();
      for (const [sn, why, killer] of dead) {
        if (!sn.alive || seen.has(sn.id)) continue;
        seen.add(sn.id);
        if (killer && killer.alive) killer.kills++;
        sn.die(t, this);
        this.events.push({ type: 'death', id: sn.id, why, killer: killer ? killer.id : null });
      }
      return this.events;
    }
  }

  return { C, AI, PRESETS, BOT_DEFS, lookFrom, randUnit, tangentAt, Snake, World };
});
