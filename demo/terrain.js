// terrain.js — seeded random mountain terrain. height() also drives radio line
// of sight in sim.js. Runs without a DOM too; `canvas` is then null.
// Fractal value noise + ridges, coloured by elevation, with hillshading and
// contour lines. The base sits in a low valley at the bottom.

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function makeNoise(rng) {
  const N = 256, perm = new Uint8Array(N * 2), vals = new Float32Array(N);
  for (let i = 0; i < N; i++) { perm[i] = i; vals[i] = rng(); }
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < N; i++) perm[i + N] = perm[i];
  const v = (x, y) => vals[perm[(perm[x & 255] + y) & 511]];
  const s = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = s(x - xi), yf = s(y - yi);
    const a = v(xi, yi), b = v(xi + 1, yi), c = v(xi, yi + 1), d = v(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
}

const STOPS = [ // elevation -> colour
  [0.00, [22, 58, 84]], [0.17, [44, 98, 122]], [0.185, [92, 122, 82]],
  [0.30, [78, 122, 64]], [0.45, [46, 96, 52]], [0.60, [34, 74, 44]],
  [0.68, [104, 96, 82]], [0.80, [146, 138, 126]], [0.88, [222, 228, 234]], [1.00, [248, 250, 252]],
];
function colourAt(h) {
  for (let i = 1; i < STOPS.length; i++) {
    if (h <= STOPS[i][0]) {
      const [h0, c0] = STOPS[i - 1], [h1, c1] = STOPS[i];
      const t = (h - h0) / (h1 - h0);
      return c0.map((v, k) => v + (c1[k] - v) * t);
    }
  }
  return STOPS[STOPS.length - 1][1];
}

export const WATER = 0.17;

/**
 * @returns {{ seed, canvas, height(x,y)->0..1, isWater(x,y), randomLandPoint(rng, margin) }}
 */
export function makeTerrain(seed, W, H, base) {
  const rng = mulberry32(seed);
  const noise = makeNoise(rng);
  const RES = 2;                       // one height sample per 2 px
  const gw = Math.ceil(W / RES), gh = Math.ceil(H / RES);
  const hm = new Float32Array(gw * gh);
  const ox = rng() * 1000, oy = rng() * 1000;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const nx = (x * RES) / 220 + ox, ny = (y * RES) / 220 + oy;
      let h = 0, amp = 0.55, f = 1;
      for (let o = 0; o < 5; o++) { h += amp * noise(nx * f, ny * f); amp *= 0.5; f *= 2.03; }
      const ridge = 1 - Math.abs(noise(nx * 1.3 + 50, ny * 1.3) * 2 - 1);
      h = h * 0.75 + ridge * ridge * 0.42 - 0.12;
      // valley around the base, mountains higher toward the top
      const dx = (x * RES - base.x) / W, dy = (y * RES - base.y) / H;
      const v = Math.min(1, Math.hypot(dx * 1.6, dy * 2.2) / 0.32);
      const valley = v * v * (3 - 2 * v);
      h = h * (0.55 + 0.45 * valley) + (1 - (y * RES) / H) * 0.10;
      hm[y * gw + x] = Math.max(0, Math.min(1, h));
    }
  }
  const height = (px, py) => {
    const x = Math.max(0, Math.min(gw - 1, Math.floor(px / RES)));
    const y = Math.max(0, Math.min(gh - 1, Math.floor(py / RES)));
    return hm[y * gw + x];
  };

  return {
    seed,
    canvas: typeof document === 'undefined' ? null : render(hm, gw, gh, W, H),
    height,
    isWater: (x, y) => height(x, y) <= WATER + 0.01,
    randomLandPoint(r, margin = 30) {
      for (let i = 0; i < 500; i++) {
        const x = margin + r() * (W - 2 * margin), y = margin + r() * (H - 2 * margin - 90);
        const h = height(x, y);
        if (h > WATER + 0.05 && h < 0.82) return { x, y };
      }
      return { x: W / 2, y: H / 2 };
    },
  };
}

// Colour by elevation x hillshade, plus contour lines.
function render(hm, gw, gh, W, H) {
  const small = document.createElement('canvas');
  small.width = gw; small.height = gh;
  const sctx = small.getContext('2d');
  const img = sctx.createImageData(gw, gh);
  const L = [-0.6, -0.7, 0.55]; // light from top-left
  const Ln = Math.hypot(...L);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const h = hm[y * gw + x];
      const hx = hm[y * gw + Math.min(gw - 1, x + 1)] - hm[y * gw + Math.max(0, x - 1)];
      const hy = hm[Math.min(gh - 1, y + 1) * gw + x] - hm[Math.max(0, y - 1) * gw + x];
      let c = colourAt(h);
      let shade = 1;
      if (h > WATER) {
        const nx = -hx * 18, ny = -hy * 18, nz = 1, nn = Math.hypot(nx, ny, nz);
        shade = 0.55 + 0.75 * Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / (nn * Ln));
        const band = Math.floor(h / 0.06);
        const bR = Math.floor(hm[y * gw + Math.min(gw - 1, x + 1)] / 0.06);
        const bD = Math.floor(hm[Math.min(gh - 1, y + 1) * gw + x] / 0.06);
        if (band !== bR || band !== bD) shade *= 0.82;
      } else {
        shade = 0.85 + 0.15 * Math.sin((x + y) * 0.35 + h * 40); // water shimmer
      }
      const o = (y * gw + x) * 4;
      img.data[o] = Math.min(255, c[0] * shade);
      img.data[o + 1] = Math.min(255, c[1] * shade);
      img.data[o + 2] = Math.min(255, c[2] * shade);
      img.data[o + 3] = 255;
    }
  }
  sctx.putImageData(img, 0, 0);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const cctx = canvas.getContext('2d');
  cctx.imageSmoothingEnabled = true;
  cctx.drawImage(small, 0, 0, W, H);
  return canvas;
}
