// ============================================================
// centi — client. Renders the world that sim.js simulates (solo) or that the
// server owns (online). Nothing in here decides who dies; it only shows it.
// ============================================================
const { C, PRESETS, lookFrom, randUnit, tangentAt } = CentiSim;
// Multiplayer server. Empty string = solo only (the Online button hides).
const SERVER_URL = 'wss://centi-server.fly.dev';
let net = null, online = false;
const R = C.R, SEG = C.SEG, MAX_SEG = C.MAX_SEG;
const FOOD_COLORS = [0xd95f00, 0xc95400, 0xe86a00].map(c => new THREE.Color(c));   // dark orange, slight variation
const BOOST_COLOR = new THREE.Color(0xcdf3ff);   // cold white-blue so boost pellets read apart from the orange food

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050810);
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.5, 6000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 3));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x3a2a14, 0.55));
const sun = new THREE.DirectionalLight(0xfff2dc, 1.15);
const fill = new THREE.DirectionalLight(0x6f8fff, 0.35);
scene.add(fill); scene.add(sun);

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
const store = {
  get(k) { try { const v = localStorage.getItem('centi.' + k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem('centi.' + k, JSON.stringify(v)); } catch (e) {} },
};

// ---------- world ----------
const world = new CentiSim.World();

// stars
{
  const n = 2200, arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const v = randUnit(); arr.set([v.x * 3000, v.y * 3000, v.z * 3000], i * 3); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xbfc7d6, size: 4, sizeAttenuation: true })));
}
// globe: smooth-shaded, blended sea / shallows / land / highland / ice with gentle relief, plus an atmosphere rim
{
  const geo = new THREE.SphereGeometry(R, 400, 260);
  const pos = geo.attributes.position, col = [];
  const sea = new THREE.Color(0x173f7a), shallow = new THREE.Color(0x2a7fc0), sand = new THREE.Color(0xc9b787), land = new THREE.Color(0x3f8a44), forest = new THREE.Color(0x2c6b33), high = new THREE.Color(0x8f7e52), ice = new THREE.Color(0xe8f0f4);
  const c = new THREE.Color(), v = new THREE.Vector3();
  const smooth = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = Math.sin(x * .032) * Math.cos(z * .028) + Math.sin(y * .02 + x * .012) * .8 + Math.sin((x + z) * .07) * .35 + Math.cos(y * .05 - z * .018) * .4
            + Math.sin(x * .11 + z * .09) * .12 + Math.cos(y * .13 - x * .07) * .1;
    if (n < -0.1) c.copy(sea).lerp(shallow, smooth(-0.9, -0.1, n));
    else if (n < 0.05) c.copy(shallow).lerp(sand, smooth(-0.1, 0.05, n));
    else if (n < 0.5) c.copy(sand).lerp(land, smooth(0.05, 0.3, n));
    else if (n < 0.95) c.copy(land).lerp(forest, smooth(0.5, 0.95, n));
    else c.copy(forest).lerp(high, smooth(0.95, 1.5, n));
    const polar = smooth(R * 0.9, R * 0.95, Math.abs(y)); c.lerp(ice, polar);
    col.push(c.r, c.g, c.b);
    const relief = n < -0.1 ? -0.9 : n < 0.05 ? -0.9 + smooth(-0.1, 0.05, n) * 0.9 : Math.min(0.5, (n - 0.05) * 0.5);
    v.set(x, y, z).normalize().multiplyScalar(R + relief);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  scene.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .9, metalness: 0 })));
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(R * 1.035, 96, 64), new THREE.ShaderMaterial({
    vertexShader: 'varying vec3 vN; varying vec3 vP; void main(){ vN = normalize(normalMatrix * normal); vP = (modelViewMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * vec4(vP, 1.0); }',
    fragmentShader: 'varying vec3 vN; varying vec3 vP; void main(){ float f = 1.0 - abs(dot(normalize(-vP), vN)); float a = pow(f, 4.0) * 0.85; gl_FragColor = vec4(0.45, 0.72, 1.0, a); }',
    transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending })));
}

// ---------- portal views ----------
const PORTAL_GREEN = new THREE.Color(0x39ff6a), PORTAL_AMBER = new THREE.Color(0xffb02e), PORTAL_RED = new THREE.Color(0xff3b3b);
const portalRings = C.PORTALS.map(n => {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(C.PORTAL_R, 1.4, 20, 96), new THREE.MeshStandardMaterial({ color: 0x39ff6a, emissive: 0x39ff6a, emissiveIntensity: 1.2, roughness: .3 }));
  const disc = new THREE.Mesh(new THREE.CircleGeometry(C.PORTAL_R - .8, 48), new THREE.MeshBasicMaterial({ color: 0x39ff6a, transparent: true, opacity: .22, side: THREE.DoubleSide }));
  const grp = new THREE.Group(); grp.add(ring); grp.add(disc);
  grp.position.copy(n).multiplyScalar(R + 1.5); grp.lookAt(n.clone().multiplyScalar(R * 2));
  scene.add(grp); return grp;
});
function drawPortals(t, dt) {
  portalRings.forEach((g, i) => {
    const st = world.portalState[i], left = st.left;
    const pc = !st.open || left < 1 ? PORTAL_RED : left < 5 ? PORTAL_AMBER : PORTAL_GREEN;
    g.visible = st.open;
    g.rotation.z += dt * (i ? -1 : 1) * (left < 5 ? 3 : .8);
    g.children[0].material.color.copy(pc); g.children[0].material.emissive.copy(pc); g.children[1].material.color.copy(pc);
    g.children[0].material.emissiveIntensity = left < 1 ? 1.5 + Math.sin(t * 40) * .8 : 1.2 + Math.sin(t * 4) * .3;
  });
}

// ---------- sinkhole views ----------
const holeViews = world.holes.map(() => {
  const grp = new THREE.Group();
  const DEPTH = 16;   // the shaft is below the surface: drawn without depth testing, after the globe, only when facing the camera
  const shaftGeo = new THREE.CylinderGeometry(C.HOLE_R, C.HOLE_R * .35, DEPTH, 40, 6, true);
  { const pos = shaftGeo.attributes.position, col = [], top = new THREE.Color(0x4a3524), bot = new THREE.Color(0x030202), c = new THREE.Color();
    for (let k = 0; k < pos.count; k++) { const y = (pos.getY(k) + DEPTH / 2) / DEPTH; c.copy(bot).lerp(top, Math.pow(y, 1.6)); col.push(c.r, c.g, c.b); }
    shaftGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); }
  const shaft = new THREE.Mesh(shaftGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthTest: false }));
  shaft.rotation.x = Math.PI / 2; shaft.position.z = -DEPTH / 2; shaft.renderOrder = 5; grp.add(shaft);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(C.HOLE_R * .35, 32), new THREE.MeshBasicMaterial({ color: 0x000000, depthTest: false }));
  floor.position.z = -DEPTH; floor.renderOrder = 4; grp.add(floor);
  const swirl = new THREE.Mesh(new THREE.RingGeometry(C.HOLE_R * .4, C.HOLE_R * .9, 40, 1, 0, Math.PI * 1.3), new THREE.MeshBasicMaterial({ color: 0x5a4130, transparent: true, opacity: .55, side: THREE.DoubleSide, depthTest: false }));
  swirl.position.z = -DEPTH * .35; swirl.renderOrder = 6; grp.add(swirl);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(C.HOLE_R, 1.3, 10, 64), new THREE.MeshStandardMaterial({ color: 0x2b1d14, roughness: 1 }));
  rim.renderOrder = 7; grp.add(rim);
  const pullRing = new THREE.Mesh(new THREE.RingGeometry(C.HOLE_PULL_R * .9, C.HOLE_PULL_R, 56, 1, 0, Math.PI * 1.5), new THREE.MeshBasicMaterial({ color: 0x8a7150, transparent: true, opacity: .22, side: THREE.DoubleSide, depthWrite: false }));
  pullRing.position.z = .8; grp.add(pullRing);
  grp.visible = false; scene.add(grp);
  return { grp, swirl, pullRing };
});
function drawHoles(t, dt) {
  const horizon = R / camera.position.length() + .14;      // a hole past the horizon must not draw through the globe
  const camDir = tmpV2.copy(camera.position).normalize();
  world.holes.forEach((hole, i) => {
    const v = holeViews[i];
    if (hole.state === 'closed') { v.grp.visible = false; return; }
    const k = hole.state === 'opening' ? Math.min(1, (t - hole.t0) / 1.5) : hole.state === 'closing' ? Math.max(.001, 1 - (t - hole.t0) / .8) : 1;
    v.grp.position.copy(hole.n).multiplyScalar(R + .6); v.grp.lookAt(tmpV.copy(hole.n).multiplyScalar(R * 2));
    v.grp.scale.setScalar(k);
    v.swirl.rotation.z -= dt * 1.6; v.pullRing.rotation.z -= dt * .9;
    v.grp.visible = hole.n.dot(camDir) > horizon;
  });
}

// ---------- storm views ----------
const stormViews = world.storms.map(() => {
  const g = new THREE.Group(), v = { grp: g, rings: [] };
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(C.STORM_R * 1.15, C.STORM_R * .22, C.STORM_H, 48, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xc9cdd6, transparent: true, opacity: .3, side: THREE.DoubleSide, roughness: 1, depthWrite: false }));
  cone.rotation.x = Math.PI / 2; cone.position.z = C.STORM_H / 2; g.add(cone);
  for (let k = 0; k < 8; k++) {
    const f = k / 7, r = C.STORM_R * (.25 + f * .95);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, .6 + f * .8, 8, 56), new THREE.MeshBasicMaterial({ color: 0xe6e9ef, transparent: true, opacity: .55 - f * .3, depthWrite: false }));
    ring.position.z = 1 + f * (C.STORM_H - 2); ring.rotation.x = (Math.random() - .5) * .25; g.add(ring); v.rings.push(ring);
  }
  v.base = new THREE.Mesh(new THREE.RingGeometry(C.STORM_R * .2, C.STORM_R * 1.05, 56), new THREE.MeshBasicMaterial({ color: 0x6b5a48, transparent: true, opacity: .35, side: THREE.DoubleSide, depthWrite: false }));
  v.base.position.z = .4; g.add(v.base);
  v.pull = new THREE.Mesh(new THREE.RingGeometry(C.PULL_R * .93, C.PULL_R, 72, 1, 0, Math.PI * 1.6), new THREE.MeshBasicMaterial({ color: 0xbfae94, transparent: true, opacity: .18, side: THREE.DoubleSide, depthWrite: false }));
  v.pull.position.z = .6; g.add(v.pull);
  const n = 160, arr = new Float32Array(n * 3); v.seeds = [];
  for (let k = 0; k < n; k++) v.seeds.push({ a: Math.random() * 6.28, z: Math.random(), r: .4 + Math.random() * .8, w: 2 + Math.random() * 3 });
  const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  v.debris = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0x3a2e24, size: 2, sizeAttenuation: true })); g.add(v.debris);
  scene.add(g); return v;
});
function drawStorms(t, dt) {
  world.storms.forEach((st, i) => {
    const v = stormViews[i];
    v.grp.position.copy(st.p).multiplyScalar(R + .4); v.grp.lookAt(tmpV.copy(st.p).multiplyScalar(R * 2));
    v.base.rotation.z -= dt * 2.5; v.pull.rotation.z -= dt * .6;
    v.rings.forEach((r, k) => { r.rotation.z += dt * (5 - k * .5); r.position.x = Math.sin(t * 2.2 + k) * 1.2; r.position.y = Math.cos(t * 1.9 + k) * 1.2; });
    const arr = v.debris.geometry.attributes.position.array;
    v.seeds.forEach((sd, k) => {
      sd.a += dt * sd.w; sd.z = (sd.z + dt * .25) % 1;
      const rr = C.STORM_R * (.25 + sd.z * .95) * sd.r;
      arr[k * 3] = Math.cos(sd.a) * rr; arr[k * 3 + 1] = Math.sin(sd.a) * rr; arr[k * 3 + 2] = 1 + sd.z * (C.STORM_H - 2);
    });
    v.debris.geometry.attributes.position.needsUpdate = true;
  });
}

// ---------- food & jelly views ----------
const foodMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.7, 3), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xb84a00, emissiveIntensity: .45, roughness: .5 }), C.FOOD_N);
world.food.forEach((f, i) => foodMesh.setColorAt(i, f.boost ? BOOST_COLOR : FOOD_COLORS[f.colorIdx]));
foodMesh.instanceColor.needsUpdate = true; scene.add(foodMesh);
function drawFood(t) {
  world.food.forEach((f, i) => {
    if (f.respawnAt > t) { tmpM.makeScale(0, 0, 0); foodMesh.setMatrixAt(i, tmpM); return; }
    const s = f.boost ? 2.3 + Math.sin(t * 6 + f.ph) * .5 : 1 + Math.sin(t * 3 + f.ph) * .18;
    tmpV.copy(f.p).multiplyScalar(R + 1.6 * s);
    tmpM.compose(tmpV, tmpQ, tmpS.set(s, s, s)); foodMesh.setMatrixAt(i, tmpM);
  });
  foodMesh.instanceMatrix.needsUpdate = true;
}
const jellyMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.5, 3), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: .45, roughness: .2, transparent: true, opacity: .92 }), C.MAX_JELLY);
for (let i = 0; i < C.MAX_JELLY; i++) jellyMesh.setColorAt(i, BOOST_COLOR);   // create the colour buffer before first render or the shader ignores it
jellyMesh.instanceColor.needsUpdate = true; scene.add(jellyMesh);
const colorCache = new Map(); const colorOf = hex => { let c = colorCache.get(hex); if (!c) { c = new THREE.Color(hex); colorCache.set(hex, c); } return c; };
function drawJelly(t) {
  const J = world.jelly;
  for (let i = 0; i < J.length && i < C.MAX_JELLY; i++) {
    const j = J[i], s = 1 + Math.sin(t * 4 + j.ph) * .15;
    tmpV.copy(j.p).multiplyScalar(R + 1.4 * s);
    tmpM.compose(tmpV, tmpQ, tmpS.set(s, s, s));
    jellyMesh.setMatrixAt(i, tmpM); jellyMesh.setColorAt(i, colorOf(j.color));
  }
  jellyMesh.count = Math.min(J.length, C.MAX_JELLY); jellyMesh.instanceMatrix.needsUpdate = true; jellyMesh.instanceColor.needsUpdate = true;
}

// ---------- snake views ----------
const segGeo = new THREE.SphereGeometry(1, 28, 20), legGeo = new THREE.CylinderGeometry(1, .7, 1, 10), headGeo = new THREE.SphereGeometry(2.1, 36, 26);
const eyeGeo = new THREE.SphereGeometry(.48, 10, 8), eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
const antGeo = new THREE.CylinderGeometry(.09, .16, 4, 5), antMat = new THREE.MeshStandardMaterial({ color: 0x3a1f12 });
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const colA = new THREE.Color(), colB = new THREE.Color(), colMix = new THREE.Color();
const dirSide = new THREE.Vector3(), fwd = new THREE.Vector3(), base = new THREE.Vector3(), tip = new THREE.Vector3();
const legQ = new THREE.Quaternion(), legDir = new THREE.Vector3(), legMid = new THREE.Vector3();
const ptA = new THREE.Vector3(), ptB = new THREE.Vector3(), pt = new THREE.Vector3();
class SnakeView {
  constructor(snake) {
    this.snake = snake;
    this.bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .55 });
    this.body = new THREE.InstancedMesh(segGeo, this.bodyMat, MAX_SEG);
    this.legMat = new THREE.MeshStandardMaterial({ color: 0x0e0c0c, roughness: .8 });
    this.legs = new THREE.InstancedMesh(legGeo, this.legMat, MAX_SEG * 2);
    this.headMat = new THREE.MeshStandardMaterial({ color: 0xe8632f, roughness: .5 });
    this.head = new THREE.Group(); this.head.add(new THREE.Mesh(headGeo, this.headMat));
    [-1, 1].forEach(s => {
      const eye = new THREE.Mesh(eyeGeo, eyeMat); eye.position.set(s * .95, .85, 1.55); this.head.add(eye);
      const ant = new THREE.Mesh(antGeo, antMat); ant.position.set(s * .8, 1.5, 1.4); ant.rotation.set(-0.9, 0, s * 0.6); this.head.add(ant);
    });
    scene.add(this.body); scene.add(this.legs); scene.add(this.head);
    this.applyLook();
  }
  applyLook() {
    const L = this.snake.look;
    this.headMat.color.set(L.head); this.legMat.color.set(L.legs);
    colA.set(L.a); colB.set(L.b);
    for (let i = 0; i < MAX_SEG; i++) {
      if (L.pattern === 'solid') colMix.copy(colA);
      else if (L.pattern === 'stripes') colMix.copy(i % 6 < 3 ? colA : colB);
      else colMix.copy(colA).lerp(colB, Math.min(1, i / 220));
      this.body.setColorAt(i, colMix);
    }
    this.body.instanceColor.needsUpdate = true;
  }
  draw(t) {
    const sn = this.snake, vis = sn.alive;
    this.body.visible = this.legs.visible = this.head.visible = vis;
    if (!vis) return;
    const p = sn.p, h = sn.h, trail = sn.trail;
    const girth = sn.girth(), hs = .7 + .3 * girth;
    this.head.scale.setScalar(hs);
    this.head.position.copy(p).multiplyScalar(R + 2 * hs);
    this.head.up.copy(p);
    this.head.lookAt(tmpV.copy(p).addScaledVector(h, .1).multiplyScalar(R + 2));
    // A snake that just joined has only its head recorded; draw the head and wait for the body.
    if (trail.length < 2) { this.body.count = 0; this.legs.count = 0; this.body.instanceMatrix.needsUpdate = true; this.legs.instanceMatrix.needsUpdate = true; return; }
    // Segment i sits exactly (i+1)*SEG behind the head, interpolated between recorded trail points, so it glides.
    const n = trail.length;
    const headDist = trail[n - 1].angleTo(p) * R;
    const u = Math.min(1, Math.max(0, (SEG - headDist) / SEG));
    const count = Math.max(0, Math.min(Math.ceil(sn.curLen), n - 2, MAX_SEG));
    const frac = sn.curLen - Math.floor(sn.curLen);
    let li = 0;
    for (let i = 0; i < count; i++) {
      ptA.copy(trail[n - 1 - i]); ptB.copy(trail[n - 2 - i]);
      const cut = ptA.angleTo(ptB) * R > SEG * 3;
      if (cut) pt.copy(ptA); else pt.lerpVectors(ptA, ptB, u).normalize();
      let scale = (1.7 - (i / Math.max(count, 1)) * .8) * girth;
      if (i === count - 1 && frac > 0) scale *= .35 + .65 * frac;
      tmpV.copy(pt).multiplyScalar(R + scale);
      tmpM.compose(tmpV, tmpQ, tmpS.set(scale, scale, scale)); this.body.setMatrixAt(i, tmpM);
      if (cut) fwd.subVectors(i === 0 ? p : trail[n - i], ptA); else fwd.subVectors(ptA, ptB);
      fwd.normalize(); dirSide.crossVectors(pt, fwd).normalize();
      const sway = Math.sin(t * 13 - i * .75);
      for (const sd of [-1, 1]) {
        base.copy(pt).multiplyScalar(R + scale * .55);
        tip.copy(pt).addScaledVector(dirSide, sd * (scale * 2.0) / R).addScaledVector(fwd, sd * sway * scale * .5 / R).normalize().multiplyScalar(R + .4);
        legDir.subVectors(tip, base); const len = legDir.length(); legDir.divideScalar(len);
        legQ.setFromUnitVectors(Y_AXIS, legDir); legMid.addVectors(base, tip).multiplyScalar(.5);
        const th = scale * .26;
        tmpM.compose(legMid, legQ, tmpS.set(th, len, th)); this.legs.setMatrixAt(li++, tmpM);
      }
    }
    this.body.count = count; this.body.instanceMatrix.needsUpdate = true;
    this.legs.count = li; this.legs.instanceMatrix.needsUpdate = true;
  }
  dispose() { scene.remove(this.body); scene.remove(this.legs); scene.remove(this.head); this.body.dispose(); this.legs.dispose(); }
}

// ---------- population ----------
const look = Object.assign({ name: '' }, lookFrom(PRESETS[0]));
let player = world.addSnake({ name: 'You', look });
let bots = world.addBots();
const views = new Map();
function syncViews() {
  // A view is stale if its id has gone, OR if that id now belongs to a different snake object.
  // The local and server worlds both number their snakes s1, s2, ... so the id alone is not enough:
  // without the object check, joining a server leaves your view bound to a deleted local snake and
  // your centipede never appears.
  for (const [id, v] of [...views]) {
    const s = world.snakes.find(x => x.id === id);
    if (!s || s !== v.snake) { v.dispose(); views.delete(id); }
  }
  for (const s of world.snakes) if (!views.has(s.id)) views.set(s.id, new SnakeView(s));
}
syncViews();
const byId = id => world.snakes.find(s => s.id === id);
const me = () => (online && net && net.id ? byId(net.id) : player) || player;

// ---------- sound: everything is synthesised, no audio files ----------
const Sound = (() => {
  let ctx = null, master, musicBus, sfxBus, boostNoise, rumble, rumbleGain, boostGain, muted = false;
  const vol = { music: .55, sfx: .8 };
  const BPM = 128, BEAT = 60 / BPM, EIGHTH = BEAT / 2;
  const mid = m => 440 * Math.pow(2, (m - 69) / 12);
  const CH = { C: [48, 55, 60, 64, 67], F: [41, 48, 60, 65, 69], G: [43, 50, 59, 62, 67], Bb: [46, 53, 58, 62, 65] };
  const songA = { beats: 2, bars: ['C','F','C','G','C','F','G','C', 'C','F','C','G','C','F','G','C'],
    mel: [[72,76,79,76],[77,77,76,74],[76,79,76,72],[74,0,71,0],[72,76,79,84],[81,81,79,76],[77,79,81,79],[72,0,0,0],
          [79,79,76,79],[81,79,77,76],[79,81,79,76],[74,76,74,71],[72,76,79,84],[81,84,81,79],[77,79,81,83],[84,0,0,0]] };
  const songA2 = { beats: 2, bars: songA.bars,
    mel: [[79,0,76,0],[77,76,74,72],[76,79,84,79],[81,79,76,0],[72,0,76,0],[79,0,84,0],[83,81,79,77],[76,0,0,0],
          [84,83,81,79],[81,79,77,76],[79,77,76,74],[76,74,72,71],[72,76,79,84],[81,84,81,79],[77,79,81,83],[84,0,0,0]] };
  const songB = { beats: 3, bars: ['F','F','Bb','C','F','F','C','F', 'Bb','Bb','F','F','C','C','F','F'],
    mel: [[72,0,77,0,81,0],[79,0,77,0,81,0],[74,0,77,0,82,0],[79,0,76,0,79,0],[72,0,77,0,81,0],[84,0,81,0,77,0],[79,0,76,0,74,0],[77,0,0,0,0,0],
          [74,77,82,0,81,0],[82,0,84,0,86,0],[84,0,81,0,77,0],[81,0,84,0,81,0],[79,0,83,0,86,0],[84,83,81,79,76,0],[77,79,81,0,84,0],[84,0,0,0,0,0]] };
  const setlist = [songA, songB, songA2, songB];
  function noiseBuffer() {
    const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = b.getChannelData(0);
    let last = 0; for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; last = (last + .02 * w) / 1.02; d[i] = last * 3.5; }
    return b;
  }
  function env(g, t, a, d, peak, sus, r, end) { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(Math.max(sus, .0001), t + a + d); g.gain.setValueAtTime(Math.max(sus, .0001), end - r); g.gain.exponentialRampToValueAtTime(.0001, end); }
  function tone(bus, type, freq, t, dur, peak, opts = {}) {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (opts.glide) o.frequency.exponentialRampToValueAtTime(opts.glide, t + dur);
    let node = o;
    if (opts.lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = opts.lp; o.connect(f); node = f; }
    if (opts.vib) { const l = ctx.createOscillator(), lg = ctx.createGain(); l.frequency.value = 5.5; lg.gain.value = opts.vib; l.connect(lg); lg.connect(o.detune); l.start(t); l.stop(t + dur + .1); }
    node.connect(g); g.connect(bus);
    env(g, t, opts.a || .01, opts.d || .05, peak, opts.sus !== undefined ? opts.sus : peak * .6, opts.r || .05, t + dur);
    o.start(t); o.stop(t + dur + .05);
  }
  let nextBar = 0, songIdx = 0, barIdx = 0;
  function scheduleBar(t, song, i) {
    const ch = CH[song.bars[i]], nb = song.beats, last = i === song.bars.length - 1;
    tone(musicBus, 'triangle', mid(ch[0]), t, BEAT * .45, .55, { lp: 500, a: .01, d: .1, sus: .25, r: .08 });
    if (nb === 2) tone(musicBus, 'triangle', mid(ch[1]), t + BEAT, BEAT * .45, .5, { lp: 500, a: .01, d: .1, sus: .22, r: .08 });
    const pahs = nb === 2 ? [EIGHTH, BEAT + EIGHTH] : [BEAT, BEAT * 2];
    for (const off of pahs) for (const n of ch.slice(2)) tone(musicBus, 'sawtooth', mid(n), t + off, EIGHTH * .8, .09, { lp: 1800, a: .005, d: .06, sus: .04, r: .04 });
    song.mel[i].forEach((n, k) => { if (n) { const held = song.mel[i][k + 1] === 0 ? 2 : 1; tone(musicBus, 'square', mid(n), t + k * EIGHTH, EIGHTH * held * .92, .13, { lp: 2400, vib: 9, a: .015, d: .08, sus: .09, r: .05 }); } });
    if (i % 8 === 7 && !last) tone(musicBus, 'sine', 900, t + EIGHTH, BEAT * 1.3, .16, { glide: 1900, a: .02, d: .3, sus: .12, r: .2 });
    if (last) tone(musicBus, 'sine', 700, t + BEAT * (nb - .8), BEAT * .7, .18, { glide: 240, a: .01, d: .2, sus: .1, r: .1 });
  }
  function pump() {
    while (nextBar < ctx.currentTime + .6) {
      const song = setlist[songIdx % setlist.length];
      scheduleBar(nextBar, song, barIdx);
      nextBar += BEAT * song.beats;
      if (++barIdx >= song.bars.length) { barIdx = 0; songIdx++; }
    }
  }
  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.connect(master); sfxBus = ctx.createGain(); sfxBus.connect(master);
    applyVol();
    const nb = noiseBuffer();
    rumble = ctx.createBufferSource(); rumble.buffer = nb; rumble.loop = true;
    const rf = ctx.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 180;
    rumbleGain = ctx.createGain(); rumbleGain.gain.value = 0; rumble.connect(rf); rf.connect(rumbleGain); rumbleGain.connect(sfxBus); rumble.start();
    boostNoise = ctx.createBufferSource(); boostNoise.buffer = nb; boostNoise.loop = true;
    const bf = ctx.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = 1600; bf.Q.value = .8;
    boostGain = ctx.createGain(); boostGain.gain.value = 0; boostNoise.connect(bf); bf.connect(boostGain); boostGain.connect(sfxBus); boostNoise.start();
    nextBar = ctx.currentTime + .1; songIdx = 0; barIdx = 0; pump(); setInterval(pump, 200);
  }
  function applyVol() { if (!ctx) return; musicBus.gain.value = muted ? 0 : vol.music * vol.music; sfxBus.gain.value = muted ? 0 : vol.sfx; }
  const now = () => ctx.currentTime;
  return {
    init, vol, applyVol,
    setMuted(m) { muted = m; applyVol(); }, get muted() { return muted; },
    eat(boost) { if (!ctx) return; const t = now(); if (boost) { [523, 659, 784, 1047].forEach((f, k) => tone(sfxBus, 'sine', f, t + k * .06, .18, .25, { a: .005, d: .05, sus: .15, r: .08 })); } else tone(sfxBus, 'sine', 620 + Math.random() * 120, t, .09, .22, { glide: 980, a: .004, d: .03, sus: .1, r: .04 }); },
    jelly() { if (!ctx) return; tone(sfxBus, 'triangle', 360 + Math.random() * 80, now(), .1, .22, { glide: 240, a: .004, d: .03, sus: .1, r: .04 }); },
    kill() { if (!ctx) return; const t = now(); tone(sfxBus, 'sawtooth', 180, t, .18, .35, { glide: 60, lp: 900, a: .005, d: .08, sus: .15, r: .05 }); const n = ctx.createBufferSource(); n.buffer = noiseBuffer(); const g = ctx.createGain(); n.connect(g); g.connect(sfxBus); env(g, t, .005, .12, .35, .05, .05, t + .25); n.start(t); n.stop(t + .3); },
    death() { if (!ctx) return; const t = now(); tone(sfxBus, 'sawtooth', 420, t, .7, .3, { glide: 70, lp: 1200, a: .01, d: .2, sus: .15, r: .2 }); tone(sfxBus, 'square', 300, t + .1, .6, .12, { glide: 60, lp: 800, a: .01, d: .2, sus: .08, r: .2 }); },
    portal() { if (!ctx) return; const t = now(); const n = ctx.createBufferSource(); n.buffer = noiseBuffer(); const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2; f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(3200, t + .45); const g = ctx.createGain(); n.connect(f); f.connect(g); g.connect(sfxBus); env(g, t, .02, .15, .5, .3, .15, t + .5); n.start(t); n.stop(t + .55); tone(sfxBus, 'sine', 500, t, .4, .12, { glide: 1500, a: .02, d: .1, sus: .08, r: .1 }); },
    snip() { if (!ctx) return; const t = now(); tone(sfxBus, 'square', 1400, t, .06, .2, { a: .002, d: .02, sus: .1, r: .02 }); tone(sfxBus, 'square', 900, t + .07, .08, .2, { a: .002, d: .02, sus: .1, r: .02 }); },
    setBoost(on) { if (!ctx) return; boostGain.gain.setTargetAtTime(on ? .18 : 0, now(), .05); },
    setRumble(k) { if (!ctx) return; rumbleGain.gain.setTargetAtTime(Math.pow(k, 1.5) * .9, now(), .1); },
  };
})();
const volMusic = document.getElementById('volMusic'), volSfx = document.getElementById('volSfx'), muteBtn = document.getElementById('mute');
volMusic.addEventListener('input', () => { Sound.vol.music = volMusic.value / 100; Sound.applyVol(); });
volSfx.addEventListener('input', () => { Sound.vol.sfx = volSfx.value / 100; Sound.applyVol(); });
muteBtn.addEventListener('click', () => { Sound.setMuted(!Sound.muted); muteBtn.textContent = Sound.muted ? '🔇' : '🔊'; });
muteBtn.addEventListener('pointerdown', e => e.stopPropagation());
[volMusic, volSfx].forEach(el => el.addEventListener('pointerdown', e => e.stopPropagation()));

// ---------- customiser ----------
const cA = document.getElementById('cA'), cB = document.getElementById('cB'), cH = document.getElementById('cH'), cL = document.getElementById('cL');
const presetsEl = document.getElementById('presets'), patternEl = document.getElementById('pattern'), nameEl = document.getElementById('name');
function applyLook() { const v = views.get(me().id); if (v) { v.snake.look = look; v.applyLook(); } document.getElementById('sub').textContent = look.name ? look.name : 'segments'; }
function syncInputs() { cA.value = look.a; cB.value = look.b; cH.value = look.head; cL.value = look.legs;
  [...patternEl.children].forEach(b => b.classList.toggle('sel', b.dataset.p === look.pattern)); }
PRESETS.forEach(pr => {
  const b = document.createElement('button');
  b.innerHTML = '<i style="background:linear-gradient(135deg,' + pr[1] + ' 50%,' + pr[2] + ' 50%)"></i>' + pr[0];
  b.addEventListener('click', () => { Object.assign(look, lookFrom(pr)); [...presetsEl.children].forEach(x => x.classList.remove('sel')); b.classList.add('sel'); syncInputs(); applyLook(); });
  presetsEl.appendChild(b);
});
presetsEl.children[0].classList.add('sel');
const clearPreset = () => [...presetsEl.children].forEach(x => x.classList.remove('sel'));
cA.addEventListener('input', () => { look.a = cA.value; clearPreset(); applyLook(); });
cB.addEventListener('input', () => { look.b = cB.value; clearPreset(); applyLook(); });
cH.addEventListener('input', () => { look.head = cH.value; clearPreset(); applyLook(); });
cL.addEventListener('input', () => { look.legs = cL.value; clearPreset(); applyLook(); });
[...patternEl.children].forEach(b => b.addEventListener('click', () => { look.pattern = b.dataset.p; clearPreset(); syncInputs(); applyLook(); }));
nameEl.addEventListener('input', () => { look.name = nameEl.value.trim(); player.name = look.name || 'You'; applyLook(); });
{ const saved = store.get('look'); if (saved) { Object.assign(look, saved); player.name = look.name || 'You'; nameEl.value = look.name || ''; presetsEl.children[0].classList.remove('sel'); const m = PRESETS.findIndex(pr => pr[1] === look.a && pr[2] === look.b && pr[3] === look.head && pr[4] === look.legs && pr[5] === look.pattern); if (m >= 0) presetsEl.children[m].classList.add('sel'); } }
syncInputs(); applyLook();

// ---------- game state / UI ----------
let paused = true, gameOverFlag = false, planetView = true, snapCam = true, cinematic = false, killcam = null, attract = false;
const feedEl = document.getElementById('feed'), feed = [];
function feedMsg(text) { feed.push({ text, until: performance.now() / 1000 + 8 }); if (feed.length > 5) feed.shift(); renderFeed(); }
function renderFeed() { feedEl.innerHTML = feed.map(f => '<div>' + f.text + '</div>').join(''); }
const esc = str => String(str).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const who = sn => sn === me() ? '<b>' + esc(me().name === 'You' ? 'You' : me().name) + '</b>' : esc(sn ? sn.name : '?');
let best = store.get('best') || { len: 0, kills: 0, secs: 0 };
const fmtTime = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
function renderBest() { document.getElementById('best').textContent = best.len ? 'Your best: ' + best.len + ' segments · ' + best.kills + (best.kills === 1 ? ' kill · ' : ' kills · ') + fmtTime(best.secs) : ''; }
const startEl = document.getElementById('start'), overEl = document.getElementById('over'), flash = document.getElementById('flash');
const lenEl = document.getElementById('len'), boardEl = document.getElementById('board');
const now = () => performance.now() / 1000;
const START_POS = new THREE.Vector3(0.3, 0.2, 1).normalize();
let runStart = 0, runPortals = 0;
const deathTitle = (why, killer) => why === 'sinkhole' ? 'Swallowed by a sinkhole' : why === 'storm' ? 'Swept away by the storm' : why === 'headon' ? 'Head-on with ' + (killer ? killer.name : '?') : 'Eaten by ' + (killer ? killer.name : '?');
const flashOn = () => { flash.classList.add('on'); requestAnimationFrame(() => flash.classList.remove('on')); };

// ---------- online ----------
function goOnline() {
  const t = now();
  online = true; attract = false; document.body.classList.remove('menu');
  paused = false; gameOverFlag = false; snapCam = true; killcam = null;
  overEl.classList.remove('on'); startEl.classList.remove('on');
  feed.length = 0; renderFeed(); runStart = t; runPortals = 0;
  netStatus('Connecting…');
  net = new CentiNet(SERVER_URL, world, {
    onOpen: () => { netStatus(''); syncViews(); snapCam = true; runStart = now(); track('run_start', { mode: 'online', pattern: look.pattern, named: !!look.name, touch: matchMedia('(pointer: coarse)').matches }); },
    onClose: reason => {
      if (!online) return;
      const msg = reason === 'timeout' ? "The server didn't answer — try again in a moment"
        : reason === 'refused' || reason === 'bad-url' ? "Couldn't reach the server"
        : 'Lost the server';
      online = false; net = null;
      netStatus(msg);
      track('online_failed', { reason });
      setTimeout(() => { if (!online) { netStatus(''); showStart(); } }, 2800);
    },
    onEvents: evs => { syncViews(); handleEvents(evs, now()); },
    onSnake: () => syncViews(),
  });
  net.connect(look.name || 'centi', { a: look.a, b: look.b, head: look.head, legs: look.legs, pattern: look.pattern });
}
function goSolo() { if (net) { net.disconnect(); net = null; } online = false; rebuildLocalWorld(); }
function rebuildLocalWorld() {
  for (const s of world.snakes.slice()) world.removeSnake(s.id);
  views.forEach(v => v.dispose()); views.clear();
  world.jelly.length = 0;
  player = world.addSnake({ name: look.name || 'You', look });
  bots = world.addBots();
  syncViews();
}
function netStatus(msg) { const el = document.getElementById('netstatus'); el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }

function startRun() {
  const t = now();
  if (online) goSolo();
  attract = false; player.ghost = false; document.body.classList.remove('menu');
  player.spawn(START_POS, t);
  bots.forEach(b => b.spawn(world.spawnAway(t, player.p), t));
  world.jelly.length = 0; world.resetHazards(t);
  paused = false; gameOverFlag = false; snapCam = true; killcam = null;
  overEl.classList.remove('on');
  feed.length = 0; renderFeed();
  runStart = t; runPortals = 0;
  track('run_start', { mode: 'solo', preset: [...presetsEl.children].findIndex(b => b.classList.contains('sel')), pattern: look.pattern, named: !!look.name, touch: matchMedia('(pointer: coarse)').matches, view: planetView ? 'planet' : 'chase' });
}
function gameOver(title) {
  gameOverFlag = true;
  const secs = Math.round(now() - runStart), len = Math.floor(me().curLen);
  const isNew = len > best.len;
  if (isNew) { best = { len, kills: me().kills, secs }; store.set('best', best); renderBest(); }
  const ob = document.getElementById('overbest');
  ob.textContent = isNew ? 'New personal best!' : (best.len ? 'Best: ' + best.len + ' segments · ' + fmtTime(best.secs) : '');
  ob.classList.toggle('new', isNew);
  track('run_end', { mode: online ? 'online' : 'solo', reason: title.replace(/ with .*| by .*/, ''), killer: (title.match(/(?:with|by) (.*)$/) || [])[1] || null, length: len, kills: me().kills, seconds: secs, portals: runPortals });
  document.getElementById('overtitle').textContent = title;
  document.getElementById('overlen').textContent = 'You reached ' + len + ' segments' + (me().kills ? ' and ate ' + me().kills + (me().kills === 1 ? ' centipede.' : ' centipedes.') : '.');
  overEl.classList.add('on');
}
// the menu: your centipede parks at the spawn point under a fixed camera while the rest of the world carries on around it
function showStart() {
  stopWatching(); overEl.classList.remove('on'); startEl.classList.add('on'); document.body.classList.add('menu');
  if (online) goSolo();
  const t = now();
  attract = true; paused = false; gameOverFlag = false; killcam = null;
  player.spawn(START_POS, t); player.ghost = true;
  bots.forEach(b => { if (!b.alive) b.spawn(world.spawnAway(t, player.p), t); });
  if (!world.holes.some(h => h.state !== 'closed')) world.resetHazards(t);
  snapCam = true;
}
// spectating
let spectating = false, followIdx = -1, specFree = false, drag = null;
const specEl = document.getElementById('spec'), hintEl = document.getElementById('hint');
const specDir = new THREE.Vector3(), specUp = new THREE.Vector3(), specRight = new THREE.Vector3();
function enterFree() {
  specFree = true; snapCam = true;
  specDir.copy(camera.position).normalize();
  specUp.copy(camera.up).sub(tmpV.copy(specDir).multiplyScalar(camera.up.dot(specDir))).normalize();
  document.getElementById('specwho').textContent = 'Free look — drag to spin';
}
function orbit(dx, dy) {
  const k = .0045;
  specRight.crossVectors(specUp, specDir).normalize();
  specDir.applyAxisAngle(specUp, -dx * k);
  specDir.applyAxisAngle(specRight, -dy * k); specUp.applyAxisAngle(specRight, -dy * k);
  specDir.normalize(); specUp.sub(tmpV.copy(specDir).multiplyScalar(specUp.dot(specDir))).normalize();
}
const others = () => world.snakes.filter(s => s.alive && s !== me());
function setFollow(i) {
  const list = others();
  followIdx = i >= list.length ? -1 : i; snapCam = true; specFree = false;
  const cur = followIdx >= 0 ? list[followIdx] : null;
  const nxt = list[followIdx + 1];
  document.getElementById('specwho').textContent = cur ? 'Following ' + cur.name : 'Watching your remains';
  document.getElementById('follow').textContent = nxt ? 'Follow ' + nxt.name : 'Watch remains';
}
function startWatching() { spectating = true; overEl.classList.remove('on'); specEl.classList.add('on'); hintEl.classList.add('hide'); setFollow(-1); }
function stopWatching() { spectating = false; specEl.classList.remove('on'); hintEl.classList.remove('hide'); }
[startEl, overEl, specEl].forEach(el => el.addEventListener('pointerdown', e => e.stopPropagation()));
document.getElementById('play').addEventListener('click', () => { Sound.init(); store.set('look', look); startEl.classList.remove('on'); startRun(); });
document.getElementById('playonline').addEventListener('click', () => { Sound.init(); store.set('look', look); goOnline(); });
document.getElementById('again').addEventListener('click', () => {
  if (online && net) { overEl.classList.remove('on'); gameOverFlag = false; killcam = null; snapCam = true; runStart = now(); net.respawn(); return; }
  player.kills = 0; startRun();
});
document.getElementById('again2').addEventListener('click', () => {
  stopWatching();
  if (online && net) { gameOverFlag = false; killcam = null; snapCam = true; runStart = now(); net.respawn(); return; }
  player.kills = 0; startRun();
});
document.getElementById('watch').addEventListener('click', () => { track('watch'); startWatching(); });
document.getElementById('follow').addEventListener('click', () => setFollow(followIdx + 1 >= others().length ? -1 : followIdx + 1));
document.getElementById('relook').addEventListener('click', showStart);
document.getElementById('relook2').addEventListener('click', () => { stopWatching(); showStart(); });
document.getElementById('share').addEventListener('click', async () => {
  const secs = Math.round(now() - runStart), text = 'I survived ' + fmtTime(secs) + ' and ate ' + me().kills + (me().kills === 1 ? ' centipede' : ' centipedes') + ' on centi. Beat that:';
  const url = location.href.split('#')[0];
  track('share', { length: Math.floor(me().curLen) });
  try {
    if (navigator.share) await navigator.share({ title: 'centi', text, url });
    else { await navigator.clipboard.writeText(text + ' ' + url); const b = document.getElementById('share'); b.textContent = 'Copied!'; setTimeout(() => b.textContent = 'Share', 1800); }
  } catch (e) {}
});
const cineBtn = document.getElementById('cine');
function toggleCine() { cinematic = !cinematic; document.body.classList.toggle('cine', cinematic); camera.fov = cinematic ? 50 : 62; camera.updateProjectionMatrix(); snapCam = true; }
cineBtn.addEventListener('click', toggleCine); cineBtn.addEventListener('pointerdown', e => e.stopPropagation());
renderBest();
if (!SERVER_URL) document.getElementById('playonline').style.display = 'none';
showStart();

// ---------- input ----------
const keys = {};
const viewBtn = document.getElementById('view');
function toggleView() { planetView = !planetView; snapCam = true; viewBtn.textContent = planetView ? 'Chase view' : 'Planet view'; }
viewBtn.addEventListener('click', toggleView); viewBtn.addEventListener('pointerdown', e => e.stopPropagation());
const touches = new Map();
// Start wide enough to read the board: you can see the hazards around you before you commit to a direction.
let userZoom = store.get('zoom') || .95, pinchStart = 0, pinching = false;
const ZOOM_MIN = .3, ZOOM_MAX = 1.8;
let zoomSave = 0;
const clampZoom = () => {
  userZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, userZoom));
  clearTimeout(zoomSave); zoomSave = setTimeout(() => store.set('zoom', userZoom), 600);   // remember what the player prefers
};
const pinchDist = () => { const a = [...touches.values()]; return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); };
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'KeyC') toggleView();
  if (e.code === 'KeyV') toggleCine();
  if (e.code === 'Equal' || e.code === 'NumpadAdd') { userZoom *= .85; clampZoom(); }
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') { userZoom /= .85; clampZoom(); }
});
addEventListener('keyup', e => { keys[e.code] = false; });
// mouse: the centipede follows the cursor; hold the button to boost
const mouse = { x: 0, y: 0, active: false, down: false };
const scrHead = new THREE.Vector3(), scrAhead = new THREE.Vector3();
function mouseSteer() {
  const self = me();
  scrHead.copy(self.p).multiplyScalar(R + 2).project(camera);
  scrAhead.copy(self.p).addScaledVector(self.h, 6 / R).normalize().multiplyScalar(R + 2).project(camera);
  const hx = (scrHead.x + 1) / 2 * innerWidth, hy = (1 - scrHead.y) / 2 * innerHeight;
  const ax = (scrAhead.x + 1) / 2 * innerWidth, ay = (1 - scrAhead.y) / 2 * innerHeight;
  const shx = ax - hx, shy = ay - hy, scx = mouse.x - hx, scy = mouse.y - hy;
  const dc = Math.hypot(scx, scy), dh = Math.hypot(shx, shy);
  if (dc < 22 || dh < 1e-3) return 0;
  const cross = (shx * scy - shy * scx) / (dh * dc);
  const dot = (shx * scx + shy * scy) / (dh * dc);
  return Math.max(-1, Math.min(1, Math.atan2(cross, dot) / .35));
}
renderer.domElement.addEventListener('pointerdown', e => {
  if (spectating) drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
  if (e.pointerType === 'mouse') { mouse.down = true; mouse.active = true; return; }
  mouse.active = false;
  touches.set(e.pointerId, { side: e.clientX < innerWidth / 2 ? -1 : 1, x: e.clientX, y: e.clientY });
  if (touches.size === 2) { pinchStart = pinchDist(); pinching = false; }
});
renderer.domElement.addEventListener('pointermove', e => {
  if (spectating && drag && e.pointerId === drag.id && touches.size < 2) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!specFree && Math.hypot(dx, dy) > 6) enterFree();
    if (specFree) { orbit(dx, dy); drag.x = e.clientX; drag.y = e.clientY; }
  }
  if (e.pointerType === 'mouse') { mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true; return; }
  const tch = touches.get(e.pointerId); if (!tch) return;
  tch.x = e.clientX; tch.y = e.clientY;
  if (touches.size === 2) {
    const d = pinchDist();
    if (!pinching && Math.abs(d - pinchStart) > 18) pinching = true;
    if (pinching) { userZoom *= pinchStart / d; clampZoom(); pinchStart = d; }
  }
});
const endTouch = e => { if (drag && e.pointerId === drag.id) drag = null; if (e.pointerType === 'mouse') { mouse.down = false; return; } touches.delete(e.pointerId); if (touches.size < 2) pinching = false; };
addEventListener('pointerup', endTouch); addEventListener('pointercancel', endTouch);
addEventListener('wheel', e => { userZoom *= Math.exp(e.deltaY * .0012); clampZoom(); }, { passive: true });

// ---------- minimap: the far side of the globe ----------
const miniScene = new THREE.Scene(); miniScene.background = new THREE.Color(0x0a0e18);
const miniCam = new THREE.PerspectiveCamera(38, 1, 10, 5000);
miniScene.add(new THREE.Mesh(new THREE.SphereGeometry(R, 48, 32), new THREE.MeshBasicMaterial({ color: 0x1b2540 })));
miniScene.add(new THREE.Mesh(new THREE.SphereGeometry(R + 1, 24, 12), new THREE.MeshBasicMaterial({ color: 0x3a4a70, wireframe: true, transparent: true, opacity: .35 })));
const MINI_N = 64;
const miniDots = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), MINI_N);
for (let i = 0; i < MINI_N; i++) miniDots.setColorAt(i, BOOST_COLOR);
miniDots.instanceColor.needsUpdate = true; miniScene.add(miniDots);
const miniCol = new THREE.Color(), miniLabel = document.getElementById('minilabel');
function drawMini(p) {
  let k = 0;
  const put = (v, size, hex) => { if (k >= MINI_N) return; tmpV.copy(v).multiplyScalar(R + size * .6); tmpM.compose(tmpV, tmpQ, tmpS.set(size, size, size)); miniDots.setMatrixAt(k, tmpM); miniDots.setColorAt(k, miniCol.set(hex)); k++; };
  C.PORTALS.forEach((n, i) => put(n, 11, world.portalState[i].open ? (world.portalState[i].left < 5 ? 0xffb02e : 0x39ff6a) : 0xff3b3b));
  for (const st of world.storms) put(st.p, 16, 0xe6e9ef);
  for (const hole of world.holes) if (hole.state !== 'closed') put(hole.n, 8, 0x000000);
  const self = me();
  for (const sn of world.snakes) if (sn.alive) put(sn.p, 6 + Math.min(10, sn.curLen / 40), sn === self ? 0x39ff6a : !sn.isBot ? 0x9ff3ff : sn.ai === 'hard' ? 0xff3b3b : sn.ai === 'medium' ? 0xff9f1c : 0xffe066);
  miniDots.count = k; miniDots.instanceMatrix.needsUpdate = true; miniDots.instanceColor.needsUpdate = true;
  miniCam.position.copy(p).multiplyScalar(-R * 3.2); miniCam.up.copy(camUpRef); miniCam.lookAt(0, 0, 0);
  const size = Math.min(150, Math.floor(innerWidth * .3)), y = 48;
  renderer.setScissorTest(true); renderer.setViewport(12, y, size, size); renderer.setScissor(12, y, size, size);
  renderer.render(miniScene, miniCam);
  renderer.setScissorTest(false); renderer.setViewport(0, 0, innerWidth, innerHeight);
  miniLabel.style.bottom = (y + size + 2) + 'px';
}

// ---------- events from the simulation → sounds, feed, killcam, analytics ----------
function handleEvents(events, t) {
  for (const e of events) {
    const sn = byId(e.id), mine = sn === me() && !attract;
    if (e.type === 'eat') { if (mine) Sound.eat(e.boost); }
    else if (e.type === 'jelly') { if (mine) Sound.jelly(); }
    else if (e.type === 'portal') { if (mine) { runPortals++; snapCam = true; Sound.portal(); flashOn(); } }
    else if (e.type === 'sever') { feedMsg(who(sn) + ' lost ' + e.lost + ' segments to a portal'); if (mine) { Sound.snip(); flashOn(); } }
    else if (e.type === 'death') {
      const killer = e.killer ? byId(e.killer) : null;
      feedMsg(e.why === 'eaten' ? who(killer) + ' ate ' + who(sn) : e.why === 'headon' ? who(sn) + ' and ' + who(killer) + ' collided' : e.why === 'sinkhole' ? who(sn) + ' fell into a sinkhole' : who(sn) + (sn === me() ? ' were' : ' was') + ' swept away by a storm');
      if (killer === me() && !attract) { Sound.kill(); track('kill', { victim: sn ? sn.name : '?', tier: sn ? sn.ai : null, length: Math.floor(me().curLen) }); }
      if (sn === me() && !attract) { killcam = { start: t, until: t + 2.3, title: deathTitle(e.why, killer) }; Sound.death(); snapCam = true; }
    }
  }
}

// ---------- loop ----------
const camTarget = new THREE.Vector3(), camPos = new THREE.Vector3();
const camUpRef = new THREE.Vector3(0, 1, 0);               // parallel-transported "up" so planet view doesn't spin
let last = performance.now(), boardTimer = 0;

function frame(nowMs) {
  const dtReal = Math.min((nowMs - last) / 1000, .05); last = nowMs;
  const t = nowMs / 1000;
  const dt = killcam ? dtReal * .28 : dtReal;       // slow motion while the killcam plays

  if (!paused) {
    let steer = 0, boost = false;
    const self = me();
    if (self.alive && !attract) {
      if (keys.ArrowLeft || keys.KeyA) steer -= 1;
      if (keys.ArrowRight || keys.KeyD) steer += 1;
      if (steer === 0 && touches.size === 0 && mouse.active) steer = mouseSteer();
      if (touches.size === 1) steer = [...touches.values()][0].side;
      boost = !!keys.Space || !!keys.ShiftLeft || mouse.down || (touches.size >= 2 && !pinching);
    }
    if (online) {
      if (net) { net.input(steer, boost); net.interpolate(dtReal); }
    } else {
      if (self.alive && !attract) world.setInput(player.id, steer, boost);
      handleEvents(world.step(dt, t), t);
    }
    if (killcam && t >= killcam.until) { const title = killcam.title; killcam = null; gameOver(title); }
  }

  // draw
  drawPortals(t, dt); drawHoles(t, dt); drawStorms(t, dt); drawFood(t); drawJelly(t);
  for (const v of views.values()) v.draw(t);

  // camera
  const camSnake = spectating && followIdx >= 0 ? (others()[followIdx] || me()) : me();
  const p = camSnake.p, h = camSnake.h;
  camUpRef.sub(tmpV.copy(p).multiplyScalar(camUpRef.dot(p))).normalize();
  if (killcam || (cinematic && !spectating)) {
    const a = killcam ? (t - killcam.start) * .9 + .6 : .55;
    tmpV2.copy(killcam ? h : camUpRef).applyAxisAngle(p, a);
    camPos.copy(p).addScaledVector(tmpV2, -.26).normalize().multiplyScalar(R + (killcam ? 42 : 60 * userZoom));
    if (snapCam) { camera.position.copy(camPos); snapCam = false; } else camera.position.lerp(camPos, 1 - Math.pow(killcam ? .02 : .3, dtReal));
    camera.up.copy(killcam ? h : camUpRef);   // looking almost straight down: "up" must be a tangent, never the surface normal
    camera.lookAt(camTarget.copy(p).multiplyScalar(R + 3));
  } else if (spectating && specFree) {
    const vh = camera.fov * Math.PI / 360, hh = Math.atan(Math.tan(vh) * camera.aspect);
    const d = Math.max(R + 45, R / Math.sin(Math.min(vh, hh)) * 1.06 * userZoom);
    camPos.copy(specDir).multiplyScalar(d);
    if (snapCam) { camera.position.copy(camPos); snapCam = false; } else camera.position.lerp(camPos, 1 - Math.pow(.0005, dt));
    camera.up.copy(specUp); camera.lookAt(0, 0, 0);
  } else if (planetView) {
    const vh = camera.fov * Math.PI / 360, hh = Math.atan(Math.tan(vh) * camera.aspect);
    const zoom = 1 + Math.min(.7, (camSnake.curLen - 10) / 350);
    const d = Math.max(R + 45, R / Math.sin(Math.min(vh, hh)) * 1.06 * zoom * userZoom);
    camPos.copy(p).multiplyScalar(d);
    if (snapCam) { camera.position.copy(camPos); snapCam = false; } else camera.position.lerp(camPos, 1 - Math.pow(.01, dt));
    camera.up.copy(camUpRef); camera.lookAt(0, 0, 0);
  } else {
    camPos.copy(p).addScaledVector(h, -.30 * userZoom).normalize().multiplyScalar(R + 95 * userZoom);
    if (snapCam) { camera.position.copy(camPos); snapCam = false; } else camera.position.lerp(camPos, 1 - Math.pow(.002, dt));
    camera.up.copy(p);
    camera.lookAt(camTarget.copy(p).addScaledVector(h, .16).normalize().multiplyScalar(R + 6));
  }
  sun.position.copy(camera.position).normalize().multiplyScalar(R * 3).addScaledVector(camera.up, R * 1.5);
  fill.position.copy(sun.position).negate().addScaledVector(camera.position, 1.5);

  // HUD
  const self = me();
  lenEl.textContent = Math.floor(self.curLen);
  boardTimer -= dt;
  if (boardTimer <= 0) {
    boardTimer = .5;
    const all = world.snakes.filter(x => x.alive || x === self).sort((a, b) => b.curLen - a.curLen);
    const rows = all.slice(0, 10); if (all.indexOf(self) >= 10) rows.push(self);
    boardEl.innerHTML = rows.map(x => '<div' + (x === self ? ' class="me"' : '') + '>' + (all.indexOf(x) + 1) + '. ' + esc(x.name) + (x.isBot ? ' <span style="opacity:.55">(' + x.ai + ')</span>' : '') + ' <b>' + Math.floor(x.curLen) + '</b></div>').join('');
    let ch = false; for (let i = feed.length - 1; i >= 0; i--) if (feed[i].until < t) { feed.splice(i, 1); ch = true; } if (ch) renderFeed();
  }

  Sound.setBoost(self.alive && self.boost);
  Sound.setRumble(self.alive ? (self.pullK || 0) : 0);
  renderer.render(scene, camera);
  if (!cinematic && !paused && !attract) drawMini(p); else miniLabel.style.bottom = '-100px';
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
