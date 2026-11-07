// scene3d.js — the rescue, in real time. A ridge splits two valleys: a person
// is stranded in the flooded one, base camp sits in the other. Drone A finds
// them, its radio is blocked by the ridge, drone B climbs to the crest and
// relays the report. Scroll position (0..1) is the timeline; idle motion
// (rotors, lights, water, mist) runs on the clock.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const C = { sos: 0xff6a2b, ok: 0x4fe3a8, link: 0x6fdcff, bad: 0xff3b30 };
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (t) => t * t * (3 - 2 * t);
const span = (t, a, b) => smooth(clamp((t - a) / (b - a)));

// ───────── noise ─────────
function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, o = 5) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < o; i++) { s += a * (vnoise(x * f, y * f) * 2 - 1); a *= 0.5; f *= 2.02; } return s; }
function ridged(x, y, o = 5) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < o; i++) { const n = 1 - Math.abs(vnoise(x * f, y * f) * 2 - 1); s += a * n * n; a *= 0.5; f *= 2.1; } return s; }

// ───────── terrain ─────────
const PERSON = new THREE.Vector3(-68, 0, 14);
const BASE = new THREE.Vector3(74, 0, 30);
const WATER = 3.4;
const ridgeX = (z) => 8 * Math.sin(z * 0.018) + 4 * Math.sin(z * 0.05 + 1);
function height(x, z) {
  const dx = x - ridgeX(z);
  let h = 4;
  const crest = 0.78 + 0.32 * fbm(z * 0.014 + 3, 1.7, 3);
  const reach = smooth(clamp((95 - z) / 55));          // the ridge ends before the foreground
  const core = Math.exp(-(dx * dx) / (2 * 23 * 23)) * reach;
  h += 64 * crest * core;
  h += 18 * ridged(x * 0.028, z * 0.028) * Math.exp(-(dx * dx) / (2 * 34 * 34)) * reach;
  const ax = Math.abs(x);
  if (ax > 104) h += Math.pow(ax - 104, 1.28) * (0.75 + 0.5 * fbm(x * 0.02, z * 0.02, 3)) + ridged(x * 0.03, z * 0.03) * 22 * clamp((ax - 104) / 40);
  const back = smooth(clamp((-z - 70) / 120));
  h += back * (70 + 150 * ridged(x * 0.011 + 4, z * 0.011 + 7, 6));
  h += fbm(x * 0.05, z * 0.05, 4) * 3.2 + fbm(x * 0.17, z * 0.17, 3) * 0.9;
  // eroded rock detail: gullies and spurs, stronger the higher the ground
  const rough = clamp((h - 12) / 50);
  h += rough * (7 * ridged(x * 0.065 + 11, z * 0.065 - 5, 4) + 2.2 * ridged(x * 0.19, z * 0.19, 3) - 4);
  // a bank above the water where the person waits, and a flat pad for base
  h += 4.6 * Math.exp(-((x - PERSON.x) ** 2 + (z - PERSON.z) ** 2) / (2 * 7 * 7));
  const bd = Math.hypot(x - BASE.x, z - BASE.z);
  if (bd < 22) h = h + (7.5 - h) * smooth(clamp((22 - bd) / 10));
  return h;
}

function buildTerrain() {
  const size = 460, seg = 300;
  const g = new THREE.PlaneGeometry(size, size, seg, seg);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, height(pos.getX(i), pos.getZ(i)));
  g.computeVertexNormals();
  const nrm = g.attributes.normal, col = new Float32Array(pos.count * 3);
  const snow = new THREE.Color(0xeef3f8), rock = new THREE.Color(0x5b5753), rockDark = new THREE.Color(0x34322f),
    forest = new THREE.Color(0x24301f), scrub = new THREE.Color(0x4c4a34), mud = new THREE.Color(0x5e4e3c), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), ny = nrm.getY(i);
    const n = fbm(x * 0.08, z * 0.08, 3);
    // low: mud on the flood line, forest and scrub on gentle slopes
    c.copy(y < WATER + 2.2 ? mud : forest).lerp(scrub, clamp((y - 10) / 22 + n * 0.3));
    // steep ground is bare rock
    const steep = clamp((0.86 - ny) / 0.22);
    c.lerp(rock.clone().lerp(rockDark, clamp(0.5 + n)), clamp(steep + (y - 30) / 40));
    // snow above a ragged line, holding only where it's not too steep
    const line = 47 + n * 12;
    const s = clamp((y - line) / 8) * clamp((ny - 0.5) / 0.16);
    c.lerp(snow, clamp(s + clamp((y - 120) / 40)));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // fine grain and bump so slopes read as rock and wind-packed snow up close
  const detail = noiseTexture(512, 48, 0.72); detail.repeat.set(36, 36); detail.colorSpace = THREE.SRGBColorSpace;
  const bump = noiseTexture(512, 90); bump.repeat.set(30, 30);
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, bumpMap: bump, bumpScale: 1.6, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true; mesh.castShadow = true;
  return mesh;
}

// Periodic noise, so a repeated texture has no seams.
function tileNoise(x, y, p) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const w = (k) => ((k % p) + p) % p;
  const a = hash(w(xi), w(yi)), b = hash(w(xi + 1), w(yi)), c = hash(w(xi), w(yi + 1)), d = hash(w(xi + 1), w(yi + 1));
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function tileFbm(x, y, p) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < 4; i++) { s += a * (tileNoise(x * f, y * f, p * f) * 2 - 1); a *= 0.5; f *= 2; } return s; }

function noiseTexture(sz = 256, scale = 8, floor = 0) {
  const cv = document.createElement('canvas'); cv.width = cv.height = sz;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(sz, sz);
  for (let y = 0; y < sz; y++) for (let x = 0; x < sz; x++) {
    const n = clamp(tileFbm((x / sz) * scale, (y / sz) * scale, scale) * 0.5 + 0.5);
    const v = (floor + (1 - floor) * n) * 255;
    const o = (y * sz + x) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}

function glowTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const ctx = cv.getContext('2d'), g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
}
function mistTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const d = Math.hypot(x - 128, y - 128) / 128;
    const a = clamp(1 - d) ** 1.6 * (0.55 + 0.45 * fbm(x / 40, y / 40, 4));
    const o = (y * 256 + x) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = 235; img.data[o + 3] = a * 255;
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(cv);
}

// ───────── models ─────────
function makeDrone() {
  const g = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0xe9edf0, roughness: 0.35, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1d2228, roughness: 0.6, metalness: 0.4 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 1.5, 6, 14), shell); body.rotation.z = Math.PI / 2; body.scale.set(1, 1, 0.7);
  g.add(body);
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.18, 0.7), dark); top.position.y = 0.42; g.add(top);
  const gimbal = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), dark); gimbal.position.set(0.85, -0.45, 0); g.add(gimbal);
  const rotors = [];
  const blurMat = new THREE.MeshBasicMaterial({ color: 0xcfd6dd, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 0.16), dark);
    arm.position.set(sx * 0.75, 0.15, sz * 0.75); arm.rotation.y = sx * sz > 0 ? -Math.PI / 4 : Math.PI / 4; g.add(arm);
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.32, 14), dark);
    motor.position.set(sx * 1.45, 0.3, sz * 1.45); g.add(motor);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.95, 28), blurMat); disc.rotation.x = -Math.PI / 2;
    disc.position.set(sx * 1.45, 0.5, sz * 1.45); g.add(disc);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.03, 0.12), dark); blade.position.copy(disc.position); g.add(blade);
    rotors.push(blade);
  }
  // navigation lights: red port, green starboard, white strobe
  const led = (c, x, z) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), new THREE.MeshBasicMaterial({ color: c })); m.position.set(x, 0.3, z); g.add(m); return m; };
  led(0xff2a2a, -1.45, 1.45); led(0x2aff6a, -1.45, -1.45);
  const strobe = led(0xffffff, 0, 0); strobe.position.y = 0.56;
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.scale.setScalar(2.1);
  g.userData = { rotors, strobe };
  return g;
}

function makePerson() {
  // A trekker in a high-vis shell with a pack, both arms up and waving: shoulder pivots so the arms swing from the shoulder.
  const g = new THREE.Group();
  const jacket = new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.6, emissive: 0x2a0800 });
  const pants = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.9 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc28a6c, roughness: 0.8 });
  const packMat = new THREE.MeshStandardMaterial({ color: 0x2f4a6b, roughness: 0.85 });
  const hatMat = new THREE.MeshStandardMaterial({ color: 0x1b2430, roughness: 0.9 });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  add(new THREE.CapsuleGeometry(0.34, 0.62, 6, 12), jacket, 0, 1.38, 0).scale.set(1, 1, 0.78);
  add(new THREE.SphereGeometry(0.23, 16, 12), skin, 0, 2.06, 0.02);
  add(new THREE.SphereGeometry(0.245, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), hatMat, 0, 2.1, 0);
  add(new THREE.BoxGeometry(0.52, 0.72, 0.34), packMat, 0, 1.42, -0.34);
  add(new THREE.CapsuleGeometry(0.15, 0.24, 4, 8), packMat, 0, 1.86, -0.34).rotation.z = Math.PI / 2;
  for (const sx of [-1, 1]) {
    const leg = add(new THREE.CapsuleGeometry(0.135, 0.72, 4, 8), pants, sx * 0.16, 0.5, 0); leg.rotation.z = sx * 0.06;
    add(new THREE.BoxGeometry(0.2, 0.14, 0.34), hatMat, sx * 0.18, 0.07, 0.05);
  }
  const arms = [];
  for (const sx of [-1, 1]) {
    const shoulder = new THREE.Group(); shoulder.position.set(sx * 0.4, 1.74, 0); g.add(shoulder);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.62, 4, 8), jacket); arm.position.y = 0.4; shoulder.add(arm);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), skin); hand.position.y = 0.8; shoulder.add(hand);
    shoulder.userData.side = sx; arms.push(shoulder);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.scale.setScalar(2.3);
  g.userData = { arms };
  return g;
}

// Boulders for the bank the person is stranded on.
function makeRocks(rng) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x5f5952, roughness: 0.95, flatShading: true });
  for (let i = 0; i < 9; i++) {
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const p = geo.attributes.position;
    for (let k = 0; k < p.count; k++) { const f = 0.75 + hash(i * 7 + k, 3) * 0.5; p.setXYZ(k, p.getX(k) * f, p.getY(k) * f * 0.7, p.getZ(k) * f); }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    const a = (i / 9) * Math.PI * 2 + hash(i, 9), r = 3.2 + hash(i, 4) * 3.5;
    m.position.set(Math.cos(a) * r, -0.3, Math.sin(a) * r);
    m.scale.setScalar(0.9 + hash(i, 5) * 1.6);
    m.rotation.set(hash(i, 6) * 3, hash(i, 7) * 3, 0);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

function makeBase() {
  const g = new THREE.Group();
  const tentA = new THREE.MeshStandardMaterial({ color: 0xe5a03a, roughness: 0.8 });
  const tentB = new THREE.MeshStandardMaterial({ color: 0xdfe5ea, roughness: 0.8 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa3ab, roughness: 0.4, metalness: 0.7 });
  const tent = (m, x, z, r) => { const t = new THREE.Mesh(new THREE.ConeGeometry(2.6, 2.8, 4), m); t.position.set(x, 1.4, z); t.rotation.y = r; t.castShadow = true; g.add(t); };
  tent(tentA, -5, 3, 0.3); tent(tentB, 4, 5, 0.9); tent(tentA, 1, -5, 0.1);
  for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1, 1), new THREE.MeshStandardMaterial({ color: 0x3d4a3c, roughness: 0.85 })); b.position.set(-1 + i * 1.5, 0.5, 2); b.castShadow = true; g.add(b); }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.22, 16, 8), steel); mast.position.set(-1, 8, -1); mast.castShadow = true; g.add(mast);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.6), steel); dish.position.set(-1, 14.5, -1); dish.rotation.z = Math.PI / 2.3; dish.rotation.y = Math.PI; g.add(dish);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), new THREE.MeshBasicMaterial({ color: C.link })); beacon.position.set(-1, 16.3, -1); g.add(beacon);
  g.userData = { beacon, top: new THREE.Vector3(-1, 16.3, -1) };
  return g;
}

// A radio link: a glowing tube with travelling dashes. `reach` draws it from start to end.
function makeBeam(color) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uReach: { value: 0 }, uAlpha: { value: 0 }, uLen: { value: 10 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 uColor; uniform float uTime, uReach, uAlpha, uLen; varying vec2 vUv;
      void main(){ if (vUv.x > uReach) discard;
        float dash = step(0.45, fract(vUv.x * uLen / 3.0 - uTime * 1.6));
        float edge = 1.0 - smoothstep(uReach - 0.02, uReach, vUv.x) * 0.0;
        float rim = pow(abs(sin(vUv.y * 3.14159)), 0.6);
        gl_FragColor = vec4(uColor * (1.6 + dash * 1.4), uAlpha * (0.35 + 0.65 * dash) * rim * edge); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.frustumCulled = false;
  mesh.userData.set = (a, b, r = 0.22) => {
    mesh.geometry.dispose();
    mesh.geometry = new THREE.TubeGeometry(new THREE.LineCurve3(a.clone(), b.clone()), 1, r, 8, false);
    mat.uniforms.uLen.value = a.distanceTo(b);
  };
  return mesh;
}

// ───────── scene ─────────
export function createScene(canvas, hud) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const horizon = new THREE.Color(0x9fb6cf);
  scene.fog = new THREE.FogExp2(horizon, 0.0021);

  // sky dome: deep blue overhead to a pale, hazy horizon, with a warm glow towards the sun
  const SUN = new THREE.Vector3(-0.62, 0.38, 0.55).normalize();   // low morning sun from the front-left, so the ridge faces the camera lit
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uSun: { value: SUN } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 uSun; varying vec3 vDir;
      void main(){ float h = clamp(vDir.y, -0.1, 1.0);
        vec3 zen = vec3(0.10, 0.22, 0.42), hor = vec3(0.66, 0.75, 0.84);
        vec3 c = mix(hor, zen, pow(max(h, 0.0), 0.55));
        float s = max(dot(normalize(vDir), uSun), 0.0);
        c += vec3(1.0, 0.82, 0.62) * (pow(s, 12.0) * 0.35 + pow(s, 300.0) * 1.2);
        gl_FragColor = vec4(c, 1.0); }`,
  }));
  scene.add(sky);

  scene.add(new THREE.HemisphereLight(0xb4cbe6, 0x3a3328, 0.85));
  const sun = new THREE.DirectionalLight(0xffe7c8, 3.4);
  sun.position.copy(SUN).multiplyScalar(300);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -170, right: 170, top: 170, bottom: -170, near: 10, far: 800 });
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.6;
  scene.add(sun);

  scene.add(buildTerrain());

  // muddy floodwater, rippling
  const ripple = noiseTexture(256, 10); ripple.repeat.set(18, 18);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(460, 460), new THREE.MeshStandardMaterial({
    color: 0x6d5c47, roughness: 0.28, metalness: 0.05, bumpMap: ripple, bumpScale: 0.6, transparent: true, opacity: 0.94,
  }));
  water.rotation.x = -Math.PI / 2; water.position.y = WATER; water.receiveShadow = true;
  scene.add(water);

  // mist lying in the valleys
  const mistTex = mistTexture(), mists = [];
  for (let i = 0; i < 16; i++) {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: mistTex, transparent: true, opacity: 0.16, depthWrite: false, fog: true }));
    const side = i % 2 ? 1 : -1;
    m.position.set(side * (60 + hash(i, 1) * 50), 10 + hash(i, 2) * 16, -120 + hash(i, 3) * 220);
    m.scale.set(70 + hash(i, 4) * 60, 22 + hash(i, 5) * 14, 1);
    m.userData.v = (hash(i, 6) - 0.5) * 2;
    scene.add(m); mists.push(m);
  }

  // actors
  PERSON.y = height(PERSON.x, PERSON.z);
  BASE.y = height(BASE.x, BASE.z);
  const person = makePerson(); person.position.copy(PERSON); person.rotation.y = 0.5; scene.add(person);
  const rocks = makeRocks(); rocks.position.copy(PERSON); scene.add(rocks);
  const base = makeBase(); base.position.copy(BASE); base.rotation.y = -0.4; scene.add(base);
  base.updateMatrixWorld(true);
  const MAST = base.userData.top.clone().applyMatrix4(base.matrixWorld);
  const droneA = makeDrone(), droneB = makeDrone();
  // drone A's searchlight, aimed at the person while it scans
  const searchlight = new THREE.SpotLight(0xe8f4ff, 0, 90, 0.28, 0.7, 1.3);
  searchlight.target.position.copy(PERSON); scene.add(searchlight, searchlight.target);
  scene.add(droneA, droneB);

  // SOS beacon: rings that expand from the person
  const glow = glowTexture();
  const beaconMat = new THREE.SpriteMaterial({ map: glow, color: C.sos, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const beacon = new THREE.Sprite(beaconMat); beacon.scale.set(6, 6, 1); beacon.position.copy(PERSON).add(new THREE.Vector3(0, 3.6, 0)); scene.add(beacon);
  const ringMat = new THREE.MeshBasicMaterial({ color: C.sos, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 64), ringMat); ring.rotation.x = -Math.PI / 2; ring.position.copy(PERSON).add(new THREE.Vector3(0, 0.4, 0)); scene.add(ring);

  // scan cone under drone A
  const coneMat = new THREE.MeshBasicMaterial({ color: 0xbdeeff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const cone = new THREE.Mesh(new THREE.ConeGeometry(7, 1, 40, 1, true), coneMat); scene.add(cone);

  // radio links
  const beamBlocked = makeBeam(C.bad), beamAB = makeBeam(C.link), beamBC = makeBeam(C.link);
  scene.add(beamBlocked, beamAB, beamBC);
  const spark = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: C.bad, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })); scene.add(spark);
  const packet = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: C.sos, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })); packet.scale.set(7, 7, 1); scene.add(packet);
  const baseFlash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: C.ok, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })); baseFlash.position.copy(MAST); scene.add(baseFlash);

  // ───────── choreography ─────────
  const crestZ = 22, crestX = ridgeX(crestZ);
  const crestH = height(crestX, crestZ);
  const A_HOVER = new THREE.Vector3(PERSON.x + 8, PERSON.y + 17, PERSON.z + 4);
  const B_HOLD = new THREE.Vector3(crestX, crestH + 13, crestZ);
  const pathA = new THREE.CatmullRomCurve3([
    new THREE.Vector3(BASE.x - 4, BASE.y + 4, BASE.z - 4),
    new THREE.Vector3(BASE.x - 22, BASE.y + 40, BASE.z - 10),
    new THREE.Vector3(30, height(30, 18) + 22, 18),
    new THREE.Vector3(ridgeX(14), height(ridgeX(14), 14) + 14, 14),
    new THREE.Vector3(-36, 44, 12),
    A_HOVER,
  ]);
  const pathB = new THREE.CatmullRomCurve3([
    new THREE.Vector3(BASE.x + 3, BASE.y + 1.6, BASE.z + 3),
    new THREE.Vector3(BASE.x - 6, BASE.y + 20, BASE.z - 2),
    new THREE.Vector3(36, crestH - 6, crestZ + 4),
    B_HOLD,
  ]);
  // where A's straight line to the mast first hits the ground
  function firstHit(a, b) {
    const d = b.clone().sub(a), n = 400;
    for (let i = 1; i <= n; i++) { const p = a.clone().addScaledVector(d, i / n); if (height(p.x, p.z) > p.y) return p; }
    return null;
  }

  // camera: keyframed path over the whole timeline
  const shots = [
    [0.00, [84, 64, 200], [4, 34, -10]],
    [0.16, [78, 98, 104], [6, 66, 14]],
    [0.30, [-30, 30, 58], [-64, 12, 13]],
    [0.42, [-100, 44, 68], [8, 36, 20]],
    [0.52, [-46, 118, 150], [6, 34, 16]],
    [0.60, [96, 72, 124], [30, 46, 20]],
    [0.74, [34, 86, 160], [0, 38, 12]],
    [0.90, [-6, 106, 190], [0, 28, 8]],
    [1.00, [-10, 112, 198], [0, 28, 8]],
].map(([t, p, l]) => ({ t, p: new THREE.Vector3(...p), l: new THREE.Vector3(...l) }));
  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 2000);
  function cameraAt(t) {
    let i = 0; while (i < shots.length - 2 && t > shots[i + 1].t) i++;
    const a = shots[i], b = shots[i + 1], k = smooth(clamp((t - a.t) / (b.t - a.t)));
    camera.position.lerpVectors(a.p, b.p, k);
    const look = new THREE.Vector3().lerpVectors(a.l, b.l, k);
    if (camera.aspect < 1) camera.position.sub(look).multiplyScalar(1 + (1 - camera.aspect) * 1.3).add(look);   // portrait: pull back so both valleys fit
    camera.lookAt(look);
  }

  // HUD tags pinned to points in the scene
  const tags = {};
  const tag = (key, text, cls = '') => { const el = document.createElement('div'); el.className = `tag ${cls}`; el.textContent = text; hud.appendChild(el); tags[key] = el; return el; };
  tag('a', 'Drone A'); tag('b', 'Drone B', 'relay'); tag('base', 'Base · no contact', 'bad'); tag('p', 'SOS · 28.21°N 85.42°E', 'sos'); tag('hit', 'No line of sight', 'bad');
  const v = new THREE.Vector3();
  function pin(el, p, alpha) {
    v.copy(p).project(camera);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const vis = alpha > 0.01 && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
    el.style.opacity = vis ? alpha.toFixed(2) : 0;
    if (vis) el.style.transform = `translate(${((v.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * h).toFixed(1)}px) translate(-50%, calc(-100% - 26px))`;
  }

  const droneCam = new THREE.PerspectiveCamera(16, 1.6, 0.5, 900);
  const camEl = document.getElementById('cam'), camBox = document.getElementById('camBox');

  // post-processing: a little bloom so lights and links glow
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.6, 0.86);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false); composer.setSize(w, h); bloom.setSize(w, h);
    camera.aspect = w / h; camera.fov = w / h < 1 ? 52 : 38; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  let progress = 0, shown = 0, active = true;
  const clock = new THREE.Clock();

  function frame() {
    requestAnimationFrame(frame);
    if (!active) return;
    const dt = Math.min(0.05, clock.getDelta()), now = clock.elapsedTime;
    shown += (progress - shown) * Math.min(1, dt * 4);   // ease toward the scroll position
    const t = shown;

    cameraAt(t);

    // drone A: base → over the crest → hover by the person
    const ka = span(t, 0.02, 0.28);
    const pa = pathA.getPointAt(ka);
    pa.y += Math.sin(now * 1.7) * 0.4;
    droneA.position.copy(pa);
    const ta = pathA.getTangentAt(Math.min(0.999, ka + 0.001));
    droneA.rotation.set(ka < 1 ? -0.12 : 0, Math.atan2(-ta.z, ta.x), Math.sin(now * 1.3) * 0.03);

    // drone B: waits on the pad, then climbs to the crest
    const kb = span(t, 0.58, 0.74);
    const pb = pathB.getPointAt(kb);
    pb.y += Math.sin(now * 1.5 + 2) * 0.4;
    droneB.position.copy(pb);
    const tb = pathB.getTangentAt(Math.min(0.999, kb + 0.001));
    droneB.rotation.set(0, Math.atan2(-tb.z, tb.x), 0);

    for (const d of [droneA, droneB]) {
      d.userData.rotors.forEach((r, i) => { r.rotation.y = now * (38 + i * 3) * (i % 2 ? 1 : -1); });
      d.userData.strobe.visible = (now * 1.2) % 1 < 0.08;
    }

    // scan and find
    const scan = span(t, 0.24, 0.3) * (1 - span(t, 0.36, 0.4));
    const coneH = pa.y - PERSON.y;
    cone.scale.set(1, coneH, 1); cone.position.set(pa.x, PERSON.y + coneH / 2, pa.z);
    coneMat.opacity = scan * 0.045;
    const found = t > 0.29, reported = t > 0.9;
    const col = reported ? C.ok : C.sos;
    beaconMat.color.setHex(col); ringMat.color.setHex(col);
    const pulse = (now * 0.8) % 1;
    beaconMat.opacity = found ? 0.55 + 0.45 * Math.sin(now * 6) ** 2 : 0;
    ring.scale.setScalar(1 + pulse * 14); ringMat.opacity = found ? (1 - pulse) * 0.7 : 0;
    const wave = found ? 1 : 0.35;
    // arms raised above the head, swinging side to side: the universal 'here' signal
    person.userData.arms.forEach((sh) => { sh.rotation.z = -sh.userData.side * (0.5 + Math.sin(now * 6 + (sh.userData.side > 0 ? 0 : Math.PI)) * 0.38 * wave); });
    searchlight.position.copy(droneA.position).add(new THREE.Vector3(0, -1.5, 0));
    searchlight.intensity = span(t, 0.22, 0.27) * (1 - span(t, 0.44, 0.5)) * 900;

    // blocked attempt: A → mast hits the ridge
    const hit = firstHit(A_HOVER, MAST) || A_HOVER.clone().lerp(MAST, 0.5);
    const tryOn = span(t, 0.4, 0.44) * (1 - span(t, 0.6, 0.66));
    beamBlocked.userData.set(pa, hit, 0.2);
    beamBlocked.material.uniforms.uReach.value = span(t, 0.4, 0.46);
    beamBlocked.material.uniforms.uAlpha.value = tryOn * (0.75 + 0.25 * Math.sin(now * 40));
    spark.position.copy(hit);
    const sp = span(t, 0.45, 0.47) * (1 - span(t, 0.6, 0.66));
    spark.scale.setScalar(sp * (8 + Math.sin(now * 23) * 2.5)); spark.material.opacity = sp;

    // relay links
    const linkOn = span(t, 0.74, 0.78);
    beamAB.userData.set(pa, pb, 0.24); beamBC.userData.set(pb, MAST, 0.24);
    beamAB.material.uniforms.uReach.value = span(t, 0.74, 0.78);
    beamBC.material.uniforms.uReach.value = span(t, 0.76, 0.8);
    beamAB.material.uniforms.uAlpha.value = linkOn; beamBC.material.uniforms.uAlpha.value = linkOn;
    for (const b of [beamBlocked, beamAB, beamBC]) b.material.uniforms.uTime.value = now;

    // the report hops A → B → base
    const h1 = span(t, 0.8, 0.85), h2 = span(t, 0.85, 0.9);
    const pk = h2 > 0 ? pb.clone().lerp(MAST, h2) : pa.clone().lerp(pb, h1);
    packet.position.copy(pk);
    packet.material.opacity = t > 0.8 && t < 0.9 ? 1 : 0;
    packet.material.color.setHex(h2 > 0.6 ? C.ok : C.sos);
    const bf = span(t, 0.9, 0.93);
    baseFlash.scale.setScalar(bf * (10 + Math.sin(now * 4) * 2)); baseFlash.material.opacity = bf;
    base.userData.beacon.material.color.setHex(reported ? C.ok : C.link);

    // water and mist drift
    ripple.offset.set(now * 0.012, now * 0.02);
    mists.forEach((m) => { m.position.x += m.userData.v * dt * 1.5; if (Math.abs(m.position.x) > 170) m.userData.v *= -1; });

    // HUD
    tags.a.textContent = t > 0.4 && t < 0.78 ? 'Drone A · no route' : 'Drone A';
    tags.a.className = `tag ${t > 0.4 && t < 0.78 ? 'bad' : ''}`;
    pin(tags.a, droneA.position, span(t, 0.03, 0.06));
    pin(tags.b, droneB.position, span(t, 0.58, 0.62));
    tags.base.textContent = reported ? 'Base · report received' : 'Base · no contact';
    tags.base.className = `tag ${reported ? 'ok' : 'bad'}`;
    pin(tags.base, MAST, span(t, 0.42, 0.46));
    tags.p.textContent = reported ? 'Reported · team sent' : 'SOS · 28.21°N 85.42°E';
    tags.p.className = `tag ${reported ? 'ok' : 'sos'}`;
    pin(tags.p, PERSON.clone().add(new THREE.Vector3(0, 4, 0)), span(t, 0.29, 0.32));
    pin(tags.hit, hit, sp);

    composer.render();

    // drone A's own camera, in an inset, while it finds the person
    const camOn = t > 0.255 && t < 0.42;
    camEl.classList.toggle('on', camOn);
    camEl.classList.toggle('saved', t > 0.31);
    if (camOn) {
      const r = camEl.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
      const w = r.width, h = r.height, x = r.left - cr.left, y = cr.bottom - r.bottom;
      droneCam.aspect = w / h; droneCam.updateProjectionMatrix();
      droneCam.position.copy(droneA.position).add(new THREE.Vector3(0, -1.6, 0));
      droneCam.lookAt(PERSON.x, PERSON.y + 2.4, PERSON.z);
      renderer.setScissorTest(true);
      renderer.setViewport(x, y, w, h); renderer.setScissor(x, y, w, h);
      droneA.visible = false; cone.visible = false;
      renderer.render(scene, droneCam);
      droneA.visible = true; cone.visible = true;
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, cr.width, cr.height);
      // tracking box around the person, in inset pixels
      const top = new THREE.Vector3(PERSON.x, PERSON.y + 5.6, PERSON.z).project(droneCam);
      const bot = new THREE.Vector3(PERSON.x, PERSON.y - 0.2, PERSON.z).project(droneCam);
      const bh = Math.abs(top.y - bot.y) * 0.5 * h, bw = bh * 0.62;
      const cx = (top.x * 0.5 + 0.5) * w, cy = (-((top.y + bot.y) / 2) * 0.5 + 0.5) * h;
      camBox.style.width = `${bw.toFixed(0)}px`; camBox.style.height = `${bh.toFixed(0)}px`;
      camBox.style.left = `${(cx - bw / 2).toFixed(0)}px`; camBox.style.top = `${(cy - bh / 2).toFixed(0)}px`;
      camBox.style.opacity = t > 0.285 ? 1 : 0;
    }
  }
  requestAnimationFrame(frame);

  return {
    setProgress(p, visible) { progress = p; active = visible; if (visible) clock.getDelta(); },
  };
}
