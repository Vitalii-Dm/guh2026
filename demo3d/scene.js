// scene.js — the 3D view of the swarm. It reads the same simulation the 2D
// demo runs (../demo/sim.js) and draws it with Three.js. Ground markings
// (fog, sensor rings, blackouts, home strips) come in as a canvas texture
// draped over the terrain, so they follow the slopes; drones, people, links
// and messages are real 3D objects.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import * as R from '../recovery/swarm-recovery.js';

const HS = 150;              // terrain height scale: height 1.0 = 150 px up
const FLY = 20;              // drones fly this far above the ground, px
const MAST = 22;             // base antenna height
const WATER = 0.17;
const KIND = { report: 0xff7a59, delivered: 0x3fb950, hub: 0xf2c14e, map: 0x6ed7ff };
const MODE_GLOW = { hub: 0x7fe6dc, neighbours: 0xffc07a, alone: 0xff7a70 };   // searchlight colour by what a drone can hear
const SENSE = 17;

export function createScene3D(container, { W, H, BASE }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));   // sharp enough, and much cheaper than 2x
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;   // redrawn a few times a second, see render()
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.domElement.className = 'labels';
  container.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  // sky: a vertical gradient, with haze of the same colour at the horizon
  const sky = document.createElement('canvas'); sky.width = 2; sky.height = 256;
  const sg = sky.getContext('2d').createLinearGradient(0, 0, 0, 256);
  sg.addColorStop(0, '#24364a'); sg.addColorStop(0.55, '#6f8798'); sg.addColorStop(1, '#a9b6bb');
  sky.getContext('2d').fillStyle = sg; sky.getContext('2d').fillRect(0, 0, 2, 256);
  scene.background = new THREE.CanvasTexture(sky);
  scene.background.colorSpace = THREE.SRGBColorSpace;
  scene.fog = new THREE.Fog(0x93a3ab, 1100, 2600);
  const camera = new THREE.PerspectiveCamera(42, 1, 2, 6000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = 1.42;
  controls.minDistance = 120;
  controls.maxDistance = 1800;
  function resetView() {
    camera.position.set(0, 620, 700);
    controls.target.set(0, 10, 40);
    controls.update();
  }
  resetView();

  scene.add(new THREE.HemisphereLight(0xeef3ff, 0x3a4036, 2.4));
  const sun = new THREE.DirectionalLight(0xfff1dc, 3);
  sun.position.set(-500, 650, -380);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);       // one shadow map, kept small
  Object.assign(sun.shadow.camera, { left: -560, right: 560, top: 420, bottom: -420, near: 100, far: 1800 });
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 1.5;
  scene.add(sun);

  // sim (x, y) + height above the sea -> world position
  const at = (x, y, up) => new THREE.Vector3(x - W / 2, up, y - H / 2);
  let terrain = null;
  const ground = (x, y) => (terrain ? terrain.height(x, y) * HS : 0);

  // ------------------------------------------------------------ terrain
  const groundCanvas = document.createElement('canvas');
  groundCanvas.width = W; groundCanvas.height = H;
  const groundTex = new THREE.CanvasTexture(groundCanvas);
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  let land = null, water = null, skirt = null;
  const shade = new THREE.Color();

  /**
   * Darken trees the same way the ground is darkened. brightness(x, y) gives
   * 0..1 for a point; call it whenever the ground markings change.
   */
  function shadeTrees(brightness) {
    for (const { mesh, spots, colours } of veg) {
      if (!spots.length) continue;
      for (let i = 0; i < spots.length; i++) mesh.setColorAt(i, shade.copy(colours[i]).multiplyScalar(brightness(spots[i][0], spots[i][1])));
      mesh.instanceColor.needsUpdate = true;
    }
  }

  // Forest and rocks. Conifers on the slopes, broadleaf trees low down in the
  // valleys, boulders on cliffs and high ground. Each kind is one instanced
  // mesh, so thousands of them cost one draw call each.
  const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
  function merged(parts) {           // [[geometry, [r,g,b]], ...] -> one vertex-coloured geometry
    const pos = [], nor = [], col = [];
    for (const [g, rgb] of parts) {
      const ng = g.index ? g.toNonIndexed() : g;
      pos.push(...ng.attributes.position.array); nor.push(...ng.attributes.normal.array);
      for (let i = 0; i < ng.attributes.position.count; i++) col.push(...rgb);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return geo;
  }
  const bark = [0.42, 0.3, 0.22];
  const CONIFER = merged([
    [new THREE.CylinderGeometry(0.35, 0.55, 3, 5).translate(0, 1.5, 0), bark],
    [new THREE.ConeGeometry(3.0, 5.2, 7).translate(0, 4.6, 0), [0.85, 0.9, 0.85]],
    [new THREE.ConeGeometry(2.3, 4.4, 7).translate(0, 7.0, 0), [0.95, 1, 0.95]],
    [new THREE.ConeGeometry(1.5, 3.6, 7).translate(0, 9.3, 0), [1.05, 1.1, 1.05]],
  ]);
  const BROADLEAF = merged([
    [new THREE.CylinderGeometry(0.4, 0.6, 3.6, 5).translate(0, 1.8, 0), bark],
    [new THREE.IcosahedronGeometry(2.8, 0).scale(1, 0.85, 1).translate(0, 5.6, 0), [1, 1, 1]],
    [new THREE.IcosahedronGeometry(1.9, 0).translate(1.6, 4.6, 0.6), [0.9, 0.95, 0.9]],
    [new THREE.IcosahedronGeometry(1.7, 0).translate(-1.4, 4.9, -0.9), [0.95, 1, 0.95]],
  ]);
  const ROCK = new THREE.DodecahedronGeometry(1, 0);
  let veg = [];                       // [{ mesh, spots: [[x, y]], colours: [Color] }]

  function plantTrees(avoid) {
    let seed = (terrain.seed * 9301 + 49297) >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const slopeAt = (x, y) => Math.abs(terrain.height(x + 4, y) - terrain.height(x - 4, y)) + Math.abs(terrain.height(x, y + 4) - terrain.height(x, y - 4));
    const clear = (x, y) => !avoid.some((p) => Math.hypot(p.x - x, p.y - y) < (p.r || 14));
    const kinds = { conifer: [], broadleaf: [], rock: [] };
    for (let i = 0; i < 12000; i++) {
      const x = 4 + rnd() * (W - 8), y = 4 + rnd() * (H - 8), h = terrain.height(x, y), slope = slopeAt(x, y);
      if (h <= WATER + 0.02 || !clear(x, y)) continue;
      if ((h > 0.62 || slope > 0.09) && h < 0.86 && rnd() < 0.25 && kinds.rock.length < 320) { kinds.rock.push([x, y, h]); continue; }
      if (h < 0.21 || h > 0.64 || slope > 0.06) continue;
      if (rnd() > 1 - Math.abs(h - 0.4) / 0.24) continue;      // thickest mid-slope
      const low = h < 0.3 && rnd() < (0.3 - h) / 0.09;
      if (low && kinds.broadleaf.length < 700) kinds.broadleaf.push([x, y, h]);
      else if (!low && kinds.conifer.length < 2200) kinds.conifer.push([x, y, h]);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color(), up = v3(0, 1, 0);
    const build = (geo, spots, material, place) => {
      const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, spots.length));
      mesh.count = spots.length;
      const colours = [];
      spots.forEach((sp, i) => { place(sp, m, c); mesh.setMatrixAt(i, m); colours.push(c.clone()); mesh.setColorAt(i, c); });
      mesh.castShadow = true; mesh.receiveShadow = true;
      scene.add(mesh);
      veg.push({ mesh, spots, colours });
    };
    const leafy = new THREE.MeshLambertMaterial({ vertexColors: true });
    build(CONIFER, kinds.conifer, leafy, ([x, y, h], m, c) => {
      const k = 0.65 + rnd() * 0.6 - (h - 0.4) * 0.8;
      m.compose(at(x, y, h * HS - 0.6), q.setFromAxisAngle(up, rnd() * 6), v3(k, k * (0.85 + rnd() * 0.4), k));
      c.setHSL(0.31 + rnd() * 0.04, 0.32 + rnd() * 0.15, 0.17 + rnd() * 0.07);
    });
    build(BROADLEAF, kinds.broadleaf, leafy, ([x, y, h], m, c) => {
      const k = 0.7 + rnd() * 0.5;
      m.compose(at(x, y, h * HS - 0.6), q.setFromAxisAngle(up, rnd() * 6), v3(k, k, k));
      c.setHSL(0.2 + rnd() * 0.07, 0.4 + rnd() * 0.2, 0.26 + rnd() * 0.08);
    });
    build(ROCK, kinds.rock, new THREE.MeshLambertMaterial({ flatShading: true }), ([x, y, h], m, c) => {
      const k = 1 + rnd() * 2;
      m.compose(at(x, y, h * HS + k * 0.2), q.setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3)), v3(k, k * (0.5 + rnd() * 0.4), k * (0.8 + rnd() * 0.4)));
      const g0 = 0.26 + rnd() * 0.1; c.setRGB(g0, g0 * 0.96, g0 * 0.9);
    });
  }

  function setTerrain(t, avoid = []) {
    terrain = t;
    for (const m of [land, water, skirt]) if (m) { scene.remove(m); m.geometry.dispose(); }
    for (const { mesh } of veg) { scene.remove(mesh); mesh.dispose(); }
    veg = [];
    const geo = new THREE.PlaneGeometry(W, H, W / 4, H / 4);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, ground(p.getX(i) + W / 2, p.getZ(i) + H / 2));
    geo.computeVertexNormals();
    // Tint baked into the mesh once: bare rock on steep faces, a little extra
    // snow glare on high flat ground. Vertex colours multiply the ground
    // texture, so this costs nothing per frame.
    const nrm = geo.attributes.normal, tint = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const h = p.getY(i) / HS, up = nrm.getY(i);
      const steep = THREE.MathUtils.smoothstep(0.92, 0.7, up) * THREE.MathUtils.smoothstep(WATER + 0.02, WATER + 0.1, h);
      const snow = THREE.MathUtils.smoothstep(0.78, 0.9, h) * THREE.MathUtils.smoothstep(0.8, 0.95, up);
      const c = [1 - steep * 0.38, 1 - steep * 0.42, 1 - steep * 0.45].map((v, k) => v * (1 - snow) + snow * [1.08, 1.1, 1.14][k]);
      tint.set([c[0] + steep * 0.12, c[1] + steep * 0.08, c[2] + steep * 0.05], i * 3);   // rock leans warm grey-brown
    }
    geo.setAttribute('color', new THREE.BufferAttribute(tint, 3));
    land = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: groundTex, vertexColors: true }));
    land.receiveShadow = true;
    scene.add(land);
    plantTrees(avoid);
    buildCamp();
    water = new THREE.Mesh(new THREE.PlaneGeometry(W - 1, H - 1).rotateX(-Math.PI / 2),
      new THREE.MeshPhongMaterial({ color: 0x1f5570, specular: 0x9fc4d6, transparent: true, opacity: 0.72, shininess: 120 }));
    water.position.y = WATER * HS + 0.6;
    scene.add(water);
    // walls down from the map's edges, so it reads as a model on a table
    const edge = [];
    const N = 120;
    const pts = [];
    for (let i = 0; i <= N; i++) pts.push([(W * i) / N, 0]);
    for (let i = 1; i <= N; i++) pts.push([W, (H * i) / N]);
    for (let i = 1; i <= N; i++) pts.push([W - (W * i) / N, H]);
    for (let i = 1; i <= N; i++) pts.push([0, H - (H * i) / N]);
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const a = at(ax, ay, ground(Math.min(W - 1, ax), Math.min(H - 1, ay))), b = at(bx, by, ground(Math.min(W - 1, bx), Math.min(H - 1, by)));
      const a0 = at(ax, ay, -40), b0 = at(bx, by, -40);
      edge.push(a0.x, a0.y, a0.z, b0.x, b0.y, b0.z, b.x, b.y, b.z, a0.x, a0.y, a0.z, b.x, b.y, b.z, a.x, a.y, a.z);
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
    wg.computeVertexNormals();
    skirt = new THREE.Mesh(wg, new THREE.MeshLambertMaterial({ color: 0x3a3430, side: THREE.DoubleSide }));
    scene.add(skirt);
  }

  // ------------------------------------------------------------ objects
  // Every kind of part (drone frames, canopies, propellers, people, message
  // dots...) is ONE instanced mesh for the whole swarm, so the scene stays
  // around 40 draw calls however many drones fly. Per-drone colour and
  // dimming go in instance colours; anything hidden gets a zero-scale matrix.
  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2, ...extra });
  const label = (cls) => { const el = document.createElement('div'); el.className = cls; const o = new CSS2DObject(el); scene.add(o); return o; };
  // write a label only when its text changes; DOM writes are the expensive part
  const setHTML = (o, html) => { if (o.userData.html !== html) { o.userData.html = html; o.element.innerHTML = html; } };
  const place = (geo, x = 0, y = 0, z = 0, ry = 0) => geo.clone().rotateY(ry).translate(x, y, z);

  const MAXD = 16, MAXP = 8, MAXDOTS = 400, MAXRINGS = 160;
  const carbon = [0.17, 0.18, 0.2], metal = [0.55, 0.58, 0.62], black = [0.04, 0.05, 0.06];
  const motorAt = [[6, 6], [-6, 6], [-6, -6], [6, -6]];
  const FRAME = merged([
    [new THREE.CylinderGeometry(2.6, 3.2, 1.6, 16), carbon],
    ...[1, 3, 5, 7].map((k) => [new THREE.CylinderGeometry(0.38, 0.5, 8.5, 6).rotateZ(Math.PI / 2).translate(4.25, 0, 0).rotateY((k * Math.PI) / 4), carbon]),
    ...motorAt.map(([x, z]) => [place(new THREE.CylinderGeometry(1.0, 1.1, 1.3, 12), x, 0.4, z), metal]),
    ...[-2.3, 2.3].map((x) => [place(new THREE.CylinderGeometry(0.22, 0.22, 8, 6).rotateX(Math.PI / 2), x, -2.9, 0), carbon]),
    ...[-2.3, 2.3].flatMap((x) => [-2.2, 2.2].map((z) => [place(new THREE.CylinderGeometry(0.18, 0.18, 2.2, 5), x * 0.8, -1.8, z), carbon])),
    [place(new THREE.SphereGeometry(1.05, 12, 8), 0.6, -1.3, 0), carbon],
    [place(new THREE.CylinderGeometry(0.45, 0.45, 0.6, 10).rotateZ(Math.PI / 2), 1.6, -1.3, 0), black],
  ]);
  const CANOPY = new THREE.SphereGeometry(2.5, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.55, 1.25).translate(0, 0.75, 0);
  const BLADE = new THREE.BoxGeometry(7.6, 0.12, 0.65);
  const DISCS = merged(motorAt.map(([x, z]) => [new THREE.CircleGeometry(3.9, 24).rotateX(-Math.PI / 2).translate(x, 1.15, z), [1, 1, 1]]));
  const NAV = merged([[place(new THREE.SphereGeometry(0.55, 8, 6), 6.8, -0.3, -6.8), [1, 0.2, 0.2]], [place(new THREE.SphereGeometry(0.55, 8, 6), 6.8, -0.3, 6.8), [0.2, 1, 0.35]]]);

  // searchlight cone, apex at the drone, fading out before it reaches the ground
  // (vertex colours with additive blending: darker = more transparent)
  function fadingCone() {
    const geo = new THREE.ConeGeometry(1, 1, 32, 6, true).translate(0, -0.5, 0);
    const p = geo.attributes.position, col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { const k = Math.pow(1 + p.getY(i), 1.6); col.set([k, k, k], i * 3); }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  }

  const inst = (geo, material, n, { shadow = false } = {}) => {
    const m = new THREE.InstancedMesh(geo, material, n);
    m.count = 0; m.frustumCulled = false; m.castShadow = shadow;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(m); return m;
  };
  const additive = (extra = {}) => new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, ...extra });
  const D = {
    frame: inst(FRAME, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.4 }), MAXD, { shadow: true }),
    canopy: inst(CANOPY, mat(0xffffff, { roughness: 0.35, metalness: 0.1 }), MAXD, { shadow: true }),
    blade: inst(BLADE, mat(0xe9edf0, { roughness: 0.5 }), MAXD * 4),
    disc: inst(DISCS, new THREE.MeshBasicMaterial({ color: 0xdfe6ec, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }), MAXD),
    nav: inst(NAV, new THREE.MeshBasicMaterial({ vertexColors: true }), MAXD),
    strobe: inst(new THREE.SphereGeometry(0.6, 8, 6).translate(0, 1.7, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAXD),
    // searchlight cone, apex at the drone; brightness lives in the instance colour (additive)
    beam: inst(fadingCone(), additive({ side: THREE.DoubleSide, vertexColors: true }), MAXD),
    ring: inst(new THREE.TorusGeometry(11, 0.6, 8, 48).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial(), MAXD),
    pick: inst(new THREE.SphereGeometry(12, 8, 6), new THREE.MeshBasicMaterial({ visible: false }), MAXD),
  };
  const stalkGeo = new THREE.BufferGeometry();
  stalkGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(MAXD * 6), 3));
  const stalks = new THREE.LineSegments(stalkGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 }));
  stalks.frustumCulled = false; scene.add(stalks);

  // people: hikers, built from a neutral part (legs, boots, pack, head) and a
  // jacket part coloured per person, plus one waving arm and a flare beam
  const skin = [0.85, 0.65, 0.5], trousers = [0.18, 0.19, 0.21], boots = [0.23, 0.16, 0.12];
  const LIMB = new THREE.CylinderGeometry(0.36, 0.32, 3.8, 6).translate(0, -1.9, 0);
  const PERSON = merged([
    ...[-0.65, 0.65].flatMap((x) => [[new THREE.CylinderGeometry(0.5, 0.45, 4.2, 8).translate(x, 2.5, 0), trousers], [new THREE.BoxGeometry(1, 0.7, 1.7).translate(x, 0.35, 0.3), boots]]),
    [new THREE.BoxGeometry(2.3, 3.3, 1.3).translate(0, 6.9, -1.4), boots],
    [new THREE.SphereGeometry(1.15, 14, 10).translate(0, 9.85, 0), skin],
  ]);
  const JACKET = merged([
    [new THREE.CylinderGeometry(1.25, 1.05, 4.2, 10).translate(0, 6.6, 0), [1, 1, 1]],
    [new THREE.SphereGeometry(1.25, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 10.1, 0), [1, 1, 1]],
    [LIMB.clone().rotateZ(-0.12).translate(-1.55, 8.3, 0), [1, 1, 1]],
  ]);
  const JACKETS = [0xd8432c, 0x2f6fd0, 0xe8b829, 0x7a3fb5, 0x22a06b, 0xe0752b, 0x2b9fc2, 0xc23b7a];
  const P = {
    body: inst(PERSON, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }), MAXP, { shadow: true }),
    jacket: inst(JACKET, mat(0xffffff, { roughness: 0.7, metalness: 0 }), MAXP, { shadow: true }),
    arm: inst(LIMB, mat(0xffffff, { roughness: 0.7, metalness: 0 }), MAXP, { shadow: true }),
    flare: inst(new THREE.CylinderGeometry(1.4, 2.2, 1, 10, 1, true).translate(0, 0.5, 0), additive(), MAXP),
  };

  // base camp next to the helipad: a command tent, a hut and a rescue truck,
  // merged into one mesh once the terrain is known
  let camp = null;
  function buildCamp() {
    if (camp) { scene.remove(camp); camp.geometry.dispose(); }
    const parts = [];
    const put = (geo, rgb, dx, dy, ry = 0) => {
      const x = BASE.x + dx, y = BASE.y + dy, p = at(x, y, ground(x, y));
      parts.push([geo.rotateY(ry).translate(p.x, p.y, p.z), rgb]);
    };
    put(new THREE.ConeGeometry(6, 6.5, 4, 1).rotateY(Math.PI / 4).translate(0, 3.25, 0), [0.89, 0.38, 0.17], -34, -8, 0.3);
    put(new THREE.BoxGeometry(9, 5, 6).translate(0, 2.5, 0), [0.72, 0.69, 0.64], 32, -10, -0.2);
    put(new THREE.CylinderGeometry(0.01, 6.4, 3, 4, 1).rotateY(Math.PI / 4).scale(1.05, 1, 0.75).translate(0, 6.5, 0), [0.36, 0.23, 0.17], 32, -10, -0.2);
    put(new THREE.BoxGeometry(3.2, 3.2, 3.8).translate(4.2, 2.4, 0), [0.82, 0.23, 0.18], 30, 6, 0.1);
    put(new THREE.BoxGeometry(7, 4.2, 4).translate(-1, 2.9, 0), [0.91, 0.91, 0.89], 30, 6, 0.1);
    put(new THREE.BoxGeometry(7.05, 0.7, 4.05).translate(-1, 2.6, 0), [0.82, 0.23, 0.18], 30, 6, 0.1);
    for (const [x, z] of [[4, 2], [4, -2], [-3, 2], [-3, -2]]) put(new THREE.CylinderGeometry(0.9, 0.9, 0.6, 12).rotateX(Math.PI / 2).translate(x, 0.9, z), [0.1, 0.1, 0.1], 30, 6, 0.1);
    camp = new THREE.Mesh(merged(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05 }));
    camp.castShadow = camp.receiveShadow = true;
    scene.add(camp);
  }

  // base: an antenna mast on the helipad
  const mast = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.4, MAST, 8), mat(0xdfe5ea)); pole.position.y = MAST / 2; mast.add(pole);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(2, 12, 10), new THREE.MeshBasicMaterial({ color: 0xff4040 })); beacon.position.y = MAST + 1; mast.add(beacon);
  scene.add(mast);
  const baseTag = label('tag base'); baseTag.element.textContent = 'Base';

  // radio links: fat lines so they read at any zoom
  const linkMat = new LineMaterial({ color: 0x6ed7ff, linewidth: 2.4, transparent: true, opacity: 0.95 });
  const links = new LineSegments2(new LineSegmentsGeometry(), linkMat);
  links.frustumCulled = false;
  scene.add(links);
  const blockedMat = new LineMaterial({ color: 0xe5534b, linewidth: 1.2, transparent: true, opacity: 0.55 });
  const blocked = new LineSegments2(new LineSegmentsGeometry(), blockedMat);
  blocked.frustumCulled = false;
  scene.add(blocked);
  // sensor footprints: a thin dashed ring on the ground under each drone,
  // following the slope, coloured by what the drone can hear. All drones in
  // one fat-line mesh.
  const footMat = new LineMaterial({ vertexColors: true, linewidth: 1.8, transparent: true, opacity: 0.95, depthWrite: false });
  const foot = new LineSegments2(new LineSegmentsGeometry(), footMat);
  foot.frustumCulled = false;
  scene.add(foot);
  const RING_N = 40;
  function setColouredSegments(mesh, pos, col) {
    const cap = mesh.userData.cap || 0, n = pos.length / 6;
    if (n > cap) {
      const size = Math.max(64, 1 << Math.ceil(Math.log2(n)));
      mesh.geometry.dispose();
      mesh.geometry = new LineSegmentsGeometry().setPositions(new Float32Array(size * 6)).setColors(new Float32Array(size * 6));
      mesh.userData.cap = size;
    }
    const pb = mesh.geometry.attributes.instanceStart.data, cb = mesh.geometry.attributes.instanceColorStart.data;
    pb.array.fill(0); pb.array.set(pos); pb.needsUpdate = true;
    cb.array.fill(0); cb.array.set(col); cb.needsUpdate = true;
    mesh.geometry.instanceCount = n;
  }

  // Update a fat-line mesh in place. Its GPU buffer is only reallocated when
  // there are more segments than it has room for.
  function setSegments(mesh, arr) {
    const cap = mesh.userData.cap || 0, n = arr.length / 6;
    if (n > cap) {
      const size = Math.max(16, 1 << Math.ceil(Math.log2(n)));
      mesh.geometry.dispose();
      mesh.geometry = new LineSegmentsGeometry().setPositions(new Float32Array(size * 6));
      mesh.userData.cap = size;
    }
    const buf = mesh.geometry.attributes.instanceStart.data;
    buf.array.fill(0);
    buf.array.set(arr);
    buf.needsUpdate = true;
    mesh.geometry.instanceCount = n;
  }

  // message dots and the rings where news lands
  const dots = inst(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial(), MAXDOTS);
  const rings = inst(new THREE.TorusGeometry(1, 0.06, 6, 48).rotateX(Math.PI / 2), additive(), MAXRINGS);
  const flashTags = Array.from({ length: 12 }, () => label('flash'));

  const droneTags = new Map(), personTags = new Map();
  const tagFor = (map, id, cls) => { if (!map.has(id)) map.set(id, label(cls)); return map.get(id); };
  const dronePos = new Map();                      // id -> Vector3, this frame
  const nodePos = (n) => (n.id === undefined ? at(BASE.x, BASE.y, ground(BASE.x, BASE.y) + MAST + 1) : dronePos.get(n.id) || at(n.x, n.y, ground(n.x, n.y) + FLY));

  // scratch objects, reused every frame (no garbage)
  const M = new THREE.Matrix4(), L = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), S = new THREE.Vector3(), C = new THREE.Color();
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const setI = (mesh, i, matrix, colour) => { mesh.setMatrixAt(i, matrix); if (colour) mesh.setColorAt(i, colour); };
  const done = (...meshes) => { for (const m of meshes) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; } };

  // ------------------------------------------------------------ per frame
  /**
   * @param {object} world   the sim
   * @param {object} o
   * @param {object|null} o.selected     drone whose view is on
   * @param {object} o.msgs              from createMessages()
   * @param {number} o.now               performance.now()
   * @param {(id: number) => number[]} o.colour  drone colour, [r, g, b] 0..255
   */
  function update(world, { selected, msgs, now, colour }) {
    lastWorld = world;
    const live = world.drones.filter((d) => d.alive);
    mast.position.copy(at(BASE.x, BASE.y - 4, ground(BASE.x, BASE.y - 4)));
    beacon.material.color.setHex(Math.floor(now / 600) % 2 ? 0xff4040 : 0x5a1515);
    baseTag.position.copy(mast.position).add(S.set(0, MAST + 9, 0));

    // drones
    const n = Math.min(MAXD, world.drones.length);
    for (const m of Object.values(D)) m.count = m === D.blade ? n * 4 : n;
    const st = stalkGeo.attributes.position.array;
    for (let i = 0; i < n; i++) {
      const d = world.drones[i];
      const g0 = ground(d.x, d.y);
      const dim = selected && d !== selected ? 0.3 : 1;
      let pos;
      if (d.alive) {
        pos = at(d.x, d.y, g0 + FLY + Math.sin(now / 400 + d.id) * 0.6);
        Q.setFromAxisAngle(S.set(0, 1, 0), -d.angle);
      } else {
        // falls out of the sky, then lies on the ground
        const t = Math.min(1, (now - d.diedAt) / 1200), fall = t * t;
        pos = at(d.x, d.y, g0 + 1.5 + (FLY - 1.5) * (1 - fall));
        Q.setFromEuler(E.set(fall * 0.9, -d.angle, fall * 0.5));
      }
      dronePos.set(d.id, pos);
      M.compose(pos, Q, S.set(1.4, 1.4, 1.4));
      const [r, g, b] = colour(d.id);
      setI(D.frame, i, M, C.setScalar(d.alive ? dim : 0.45));
      setI(D.canopy, i, M, d.alive ? C.setRGB((r / 255) * dim, (g / 255) * dim, (b / 255) * dim, THREE.SRGBColorSpace) : C.setScalar(0.3));
      setI(D.pick, i, d.alive ? M : ZERO);
      for (let k = 0; k < 4; k++) {
        const [mx, mz] = motorAt[k];
        // spinning while it flies (neighbours counter-rotate), stopped once it's down
        L.makeRotationY(d.alive ? (k % 2 ? 1 : -1) * now / 25 + k : k).setPosition(mx, 1.15, mz);
        setI(D.blade, i * 4 + k, L.premultiply(M));
      }
      setI(D.disc, i, d.alive ? M : ZERO);
      setI(D.nav, i, d.alive ? M : ZERO);
      setI(D.strobe, i, d.alive && (now + d.id * 137) % 1100 < 90 ? M : ZERO);
      const hub = d.alive && (R.isHub(d.state) || d === selected);
      L.makeRotationY(now / 900).premultiply(M);
      setI(D.ring, i, hub ? L : ZERO, C.setHex(d === selected ? 0xffffff : 0xf2c14e));
      if (d.alive) {
        const fly = pos.y - g0;
        L.compose(pos, Q, S.set(SENSE, fly, SENSE));
        setI(D.beam, i, L, C.setHex(MODE_GLOW[d.commsMode] ?? 0x9fe8ff).multiplyScalar((d === selected ? 0.2 : 0.1) * dim));
      } else setI(D.beam, i, ZERO, C.setScalar(0));
      // line from the drone to the ground: shows how high it is
      st.set(d.alive ? [pos.x, pos.y, pos.z, pos.x, g0, pos.z] : [0, -999, 0, 0, -999, 0], i * 6);
      // label
      const tag = tagFor(droneTags, d.id, 'tag');
      tag.position.copy(pos).add(S.set(0, 13, 0));
      const hops = d.state.hops === null ? 'no route' : `${d.state.hops} hops`;
      setHTML(tag, d.alive
        ? `${R.isHub(d.state) ? '<b class="hub">Hub</b> ' : d.hubStatus === 'suspect' ? '<b class="sus">?</b> ' : ''}${d.id}: ${hops}${d.remote ? `<br><span class="phone">${d.inContact ? 'phone' : 'phone: no contact'}</span>` : ''}${d.muling ? '<br><span class="mule">carrying report</span>' : ''}`
        : `<span class="dead">${d.id} down</span>`);
      if (tag.userData.dim !== dim) { tag.userData.dim = dim; tag.element.style.opacity = dim; }
    }
    // footprints: dashes of 3 segments on, 1 off, round each live drone
    const fp = [], fc = [];
    for (let i = 0; i < n; i++) {
      const d = world.drones[i];
      if (!d.alive) continue;
      const dim = selected && d !== selected ? 0.3 : 1;
      C.setHex(d === selected ? 0xffffff : MODE_GLOW[d.commsMode] ?? 0x9fe8ff).multiplyScalar(dim);
      let prev = null;
      for (let k = 0; k <= RING_N; k++) {
        const a = (k / RING_N) * Math.PI * 2 + now / 4000;            // a slow turn, like a scanning reticle
        const x = d.x + Math.cos(a) * SENSE, y = d.y + Math.sin(a) * SENSE;
        const pt = [x - W / 2, ground(x, y) + 0.9, y - H / 2];
        if (prev && k % 4 !== 0) { fp.push(...prev, ...pt); fc.push(C.r, C.g, C.b, C.r, C.g, C.b); }
        prev = pt;
      }
    }
    setColouredSegments(foot, fp.length ? fp : [0, -999, 0, 0, -999, 0], fc.length ? fc : [0, 0, 0, 0, 0, 0]);

    stalkGeo.setDrawRange(0, n * 2);
    stalkGeo.attributes.position.needsUpdate = true;
    done(...Object.values(D));

    // keep a selected drone in view: slide the camera along with it
    if (selected?.alive && dronePos.get(selected.id)) {
      const step = dronePos.get(selected.id).clone().sub(controls.target).multiplyScalar(0.05);
      controls.target.add(step); camera.position.add(step);
    }

    // people
    const baseS = world.base.state.survivors;
    const np = Math.min(MAXP, world.survivors.length);
    for (const m of Object.values(P)) m.count = np;
    for (let i = 0; i < np; i++) {
      const s = world.survivors[i];
      const report = selected?.state.survivors[s.id];
      const shown = !selected || !!report;
      const tag = tagFor(personTags, s.id, 'ptag');
      const base = at(s.x, s.y, ground(s.x, s.y));
      M.compose(base, Q.setFromAxisAngle(S.set(0, 1, 0), s.pose * 6), S.set(1, 1, 1));
      if (!shown) M.copy(ZERO);
      setI(P.body, i, M);
      setI(P.jacket, i, M, C.setHex(JACKETS[i % JACKETS.length]));
      const waiting = s.foundBy && !baseS[s.id];
      // waves overhead until rescue is on the way
      L.makeRotationZ((waiting ? 2.6 : 0.3) + Math.sin(now / 180 + s.pose * 6) * (waiting ? 0.45 : 0.6)).setPosition(1.55, 8.3, 0).premultiply(M);
      setI(P.arm, i, L, C.setHex(JACKETS[i % JACKETS.length]));
      tag.position.copy(base).add(S.set(0, 17, 0));
      tag.visible = shown;
      if (!s.foundBy || !shown) { setI(P.flare, i, ZERO, C.setScalar(0)); setHTML(tag, ''); continue; }
      const ok = selected ? report?.delivered : !!baseS[s.id];
      // a flare over someone waiting for rescue, visible from anywhere; short and green once reported
      L.compose(base, Q.identity(), S.set(1, ok ? 56 : 160, 1));
      setI(P.flare, i, L, C.setHex(ok ? 0x3fb950 : 0xff7a59).multiplyScalar(ok ? 0.12 : 0.22 + 0.14 * Math.sin(now / 250 + s.pose * 6)));
      const knowing = live.filter((d) => d.state.survivors[s.id]).length;
      setHTML(tag, `<b class="${ok ? 'ok' : 'sos'}">${ok ? 'Reported' : 'SOS'}</b>${selected ? '' : `<br>${knowing}/${live.length} drones know`}`);
    }
    done(...Object.values(P));

    // links
    const show = ([a, b]) => !selected || a === selected || b === selected;
    const seg = (pairs) => {
      const arr = [];
      for (const [a, b] of pairs.filter(show)) { const p = nodePos(a), q = nodePos(b); arr.push(p.x, p.y, p.z, q.x, q.y, q.z); }
      return arr.length ? arr : [0, -999, 0, 0, -999, 0];
    };
    setSegments(links, seg(world.links));
    setSegments(blocked, seg(world.blocked));

    // messages
    const { flights, flashes } = msgs.active(now);
    const inView = (nd) => !selected || nd === selected;
    let k = 0;
    for (const f of flights) {
      if (k >= MAXDOTS || !(inView(f.from) || inView(f.to))) continue;
      const p = S.lerpVectors(nodePos(f.from), nodePos(f.to), f.t);
      p.y += Math.sin(f.t * Math.PI) * 6;               // a small arc between nodes
      const r = f.kind === 'map' ? 1.3 : 2.4;
      L.makeScale(r, r, r).setPosition(p);
      setI(dots, k++, L, C.setHex(KIND[f.kind]));
    }
    dots.count = k;
    k = 0;
    let t = 0;
    for (const f of flashes) {
      if (k >= MAXRINGS || !inView(f.node)) continue;
      const p = nodePos(f.node), r = 10 + f.t * (f.big ? 110 : 24);
      L.makeScale(r, r, r).setPosition(p);
      setI(rings, k++, L, C.setHex(KIND[f.kind]).multiplyScalar(1 - f.t));
      if (f.kind !== 'map' && f.label && t < flashTags.length) {
        const tag = flashTags[t++];
        tag.visible = true;
        tag.position.copy(p).add(S.set(0, 18 + f.t * 14, 0));
        tag.element.textContent = f.label;
        tag.element.style.color = `#${KIND[f.kind].toString(16).padStart(6, '0')}`;
        tag.element.style.opacity = 1 - f.t;
      }
    }
    rings.count = k;
    for (; t < flashTags.length; t++) flashTags[t].visible = false;
    done(dots, rings);
  }

  // ------------------------------------------------------------ input
  const ray = new THREE.Raycaster();
  /** What's under the pointer: a drone, and/or the ground point in sim px. */
  let lastWorld = null;
  function pick(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObject(D.pick, false)[0];
    const g = land && ray.intersectObject(land, false)[0];
    const d = hit && lastWorld?.drones[hit.instanceId];
    return { droneId: d ? d.id : null, point: g ? { x: g.point.x + W / 2, y: g.point.z + H / 2 } : null };
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    labels.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    for (const m of [linkMat, blockedMat, footMat]) m.resolution.set(w, h);
  }
  new ResizeObserver(resize).observe(container);
  resize();

  // Render budget: shadows refresh every 4th frame (drones move slowly), and if
  // frames come in slow the resolution steps down until they don't.
  let renders = 0, slow = 0, lastT = 0, ratio = renderer.getPixelRatio();
  function render() {
    const t = performance.now();
    if (lastT) slow = slow * 0.95 + (t - lastT > 45 ? 0.05 : 0);   // share of recent frames over 45 ms
    lastT = t;
    if (slow > 0.5 && ratio > 1) { ratio = Math.max(1, ratio - 0.25); renderer.setPixelRatio(ratio); resize(); slow = 0; }
    controls.update();
    if (renders++ % 4 === 0) renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    if (renders % 2 === 0) labels.render(scene, camera);   // label positions at 15 fps are plenty
  }

  /** Forget all drone and person labels (new run). */
  function clear() {
    for (const t of [...droneTags.values(), ...personTags.values()]) t.removeFromParent();
    droneTags.clear(); personTags.clear(); dronePos.clear();
  }

  /** Call after drawing on groundCanvas, so the terrain picks it up. */
  const groundChanged = () => { groundTex.needsUpdate = true; };

  /** Draw calls and triangles in the last frame, for checking the budget. */
  const stats = () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, pixelRatio: renderer.getPixelRatio() });

  return { stats, groundCanvas, groundChanged, shadeTrees, setTerrain, update, render, pick, resetView, clear, controls, dom: renderer.domElement };
}
