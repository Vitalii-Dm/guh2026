// usecases.js — four looping illustrations for "Not just Nepal".
// Each tile draws on its own canvas and only animates while it's on screen.
const C = { link: '#6fdcff', sos: '#ff7a3d', ok: '#5fe0b0', bad: '#ff4d42', ice: '#e9f1f7', faint: 'rgba(233,241,247,.14)' };
const TAU = Math.PI * 2;
const rnd = (() => { let a = 7; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
const lerp = (a, b, t) => a + (b - a) * t;

function setup(cv) {
  const ctx = cv.getContext('2d');
  const fit = () => {
    const dpr = Math.min(2, devicePixelRatio || 1), r = cv.getBoundingClientRect();
    cv.width = Math.max(1, r.width * dpr); cv.height = Math.max(1, r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cv._w = r.width; cv._h = r.height;
  };
  new ResizeObserver(fit).observe(cv); fit();
  return ctx;
}
const dot = (ctx, x, y, r, col, glow = 0) => { ctx.fillStyle = col; if (glow) { ctx.shadowColor = col; ctx.shadowBlur = glow; } ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); ctx.shadowBlur = 0; };
function contours(ctx, w, h, seed, alpha = 0.07) {
  ctx.strokeStyle = `rgba(233,241,247,${alpha})`; ctx.lineWidth = 1;
  for (let k = 0; k < 9; k++) {
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const y = h * (0.12 + k * 0.1) + Math.sin(x * 0.012 + k * 1.7 + seed) * 18 + Math.sin(x * 0.031 + k) * 7;
      x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
}
const label = (ctx, text, x, y, col = C.ice, align = 'left') => { ctx.font = '500 10px "IBM Plex Mono", monospace'; ctx.fillStyle = col; ctx.textAlign = align; ctx.fillText(text.toUpperCase(), x, y); };

// 01 · Defence: a jammed zone cuts links; the swarm routes around it.
function defence(cv) {
  const ctx = setup(cv);
  const N = 14;
  const nodes = Array.from({ length: N }, (_, i) => ({ u: 0.16 + rnd() * 0.78, v: 0.1 + rnd() * 0.44, ph: rnd() * TAU, sp: 0.15 + rnd() * 0.2 }));
  let pkt = [];
  return (t) => {
    const w = cv._w, h = cv._h; ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#08111b'; ctx.fillRect(0, 0, w, h); contours(ctx, w, h, 1);
    const jam = { x: w * 0.58, y: h * 0.3, r: Math.min(w, h) * (0.2 + 0.02 * Math.sin(t * 2)) };
    const g = ctx.createRadialGradient(jam.x, jam.y, 0, jam.x, jam.y, jam.r);
    g.addColorStop(0, 'rgba(255,77,66,.28)'); g.addColorStop(1, 'rgba(255,77,66,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(jam.x, jam.y, jam.r, 0, TAU); ctx.fill();
    ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(255,77,66,.6)'; ctx.beginPath(); ctx.arc(jam.x, jam.y, jam.r, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    label(ctx, 'Jamming', jam.x, jam.y - jam.r - 8, C.bad, 'center');
    const op = { x: w * 0.07, y: h * 0.34 };
    const P = nodes.map((n) => ({ x: (n.u + Math.sin(t * n.sp + n.ph) * 0.05) * w, y: (n.v + Math.cos(t * n.sp * 1.3 + n.ph) * 0.05) * h }));
    const jammed = P.map((p) => Math.hypot(p.x - jam.x, p.y - jam.y) < jam.r);
    const all = [{ ...op }, ...P], R = Math.max(w, h) * 0.24;
    const ok = (i, j) => Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y) < R;
    // links: clean ones teal, ones touching the jam red and broken
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      if (!ok(i, j)) continue;
      const bad = (i && jammed[i - 1]) || jammed[j - 1];
      ctx.strokeStyle = bad ? 'rgba(255,77,66,.35)' : 'rgba(111,220,255,.32)'; ctx.setLineDash(bad ? [2, 6] : []);
      ctx.beginPath(); ctx.moveTo(all[i].x, all[i].y); ctx.lineTo(all[j].x, all[j].y); ctx.stroke();
    }
    ctx.setLineDash([]);
    // BFS from the operator through clean links; the farthest drone it reaches sends its report home
    const prev = new Array(all.length).fill(-1), seen = new Array(all.length).fill(false), q = [0]; seen[0] = true;
    while (q.length) { const c = q.shift(); for (let j = 1; j < all.length; j++) if (!seen[j] && !jammed[j - 1] && ok(c, j)) { seen[j] = true; prev[j] = c; q.push(j); } }
    let far = -1; for (let j = 1; j < all.length; j++) if (seen[j] && (far < 0 || all[j].x > all[far].x)) far = j;
    const route = [];   // operator … far; the packet runs from the far end home
    if (far > 0) for (let c = far; c !== -1; c = prev[c]) route.unshift(c);
    if (route.length > 1) {
      ctx.strokeStyle = C.link; ctx.lineWidth = 2.5; ctx.shadowColor = C.link; ctx.shadowBlur = 12;
      ctx.beginPath(); route.forEach((c, k) => (k ? ctx.lineTo(all[c].x, all[c].y) : ctx.moveTo(all[c].x, all[c].y))); ctx.stroke(); ctx.shadowBlur = 0; ctx.lineWidth = 1;
      const k = (t * 0.7) % 1, seg = route.length - 1, f = k * seg, s = Math.min(seg - 1, Math.floor(f));
      const a = all[route[seg - s]], b = all[route[seg - s - 1]], e = f - s;
      dot(ctx, lerp(a.x, b.x, e), lerp(a.y, b.y, e), 3.5, C.sos, 14);
    }
    P.forEach((p, i) => { dot(ctx, p.x, p.y, 3.2, jammed[i] ? C.bad : C.ice, jammed[i] ? 10 : 0); if (jammed[i]) { ctx.strokeStyle = 'rgba(255,77,66,.5)'; ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, TAU); ctx.stroke(); } });
    ctx.fillStyle = C.ice; ctx.fillRect(op.x - 6, op.y - 6, 12, 12); label(ctx, 'Operator', op.x - 6, op.y + 20);
    void pkt;
  };
}

// 02 · Drone show: a mountain drawn in lights; dropped drones are replaced and the shape heals.
function show(cv) {
  const ctx = setup(cv);
  const shape = [];
  const peaks = [[0.08, 0.66], [0.26, 0.34], [0.36, 0.46], [0.52, 0.16], [0.66, 0.4], [0.76, 0.3], [0.92, 0.66]];
  for (let i = 0; i < peaks.length - 1; i++) {
    const [a, b] = [peaks[i], peaks[i + 1]], n = Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 60);
    for (let k = 0; k < n; k++) shape.push([lerp(a[0], b[0], k / n), lerp(a[1], b[1], k / n)]);
  }
  for (let k = 0; k <= 50; k++) shape.push([lerp(0.08, 0.92, k / 50), 0.66]);
  // snow line
  for (let k = 0; k < 10; k++) shape.push([lerp(0.47, 0.57, k / 9), 0.26 + Math.abs(k - 4.5) * 0.008]);
  for (const p of shape) p[1] = p[1] * 0.82 - 0.02;   // keep the shape clear of the caption
  const drones = shape.map((s) => ({ slot: s, x: s[0], y: s[1], state: 'on', t: 0 }));
  let nextFail = 1.2, last = 0;
  return (t) => {
    const w = cv._w, h = cv._h, dt = Math.min(0.05, t - last); last = t;
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#050b16'); g.addColorStop(1, '#0d1b2e');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // skyline of the crowd
    ctx.fillStyle = '#04070d'; ctx.beginPath(); ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 6) ctx.lineTo(x, h * 0.9 - Math.abs(Math.sin(x * 0.07) * 6) - Math.abs(Math.sin(x * 0.19)) * 4);
    ctx.lineTo(w, h); ctx.fill();
    if (t > nextFail) {
      // a cluster drops out at once
      const c = Math.floor(rnd() * drones.length);
      drones.forEach((d) => { if (d.state === 'on' && Math.hypot(d.slot[0] - drones[c].slot[0], d.slot[1] - drones[c].slot[1]) < 0.045) { d.state = 'fall'; d.t = t; d.vx = (rnd() - 0.5) * 0.02; } });
      nextFail = t + 2.4;
    }
    for (const d of drones) {
      if (d.state === 'fall') {
        d.y += dt * 0.35; d.x += d.vx * dt;
        if (t - d.t > 0.9) { d.state = 'fly'; d.t = t; d.x = d.slot[0] < 0.5 ? -0.05 : 1.05; d.y = 0.05 + rnd() * 0.2; }
      } else if (d.state === 'fly') {
        d.x = lerp(d.x, d.slot[0], Math.min(1, dt * 3)); d.y = lerp(d.y, d.slot[1], Math.min(1, dt * 3));
        if (Math.hypot(d.x - d.slot[0], d.y - d.slot[1]) < 0.002) d.state = 'on';
      } else { d.x = d.slot[0]; d.y = d.slot[1]; }
      const tw = 0.75 + 0.25 * Math.sin(t * 3 + d.slot[0] * 40);
      const col = d.state === 'fall' ? `rgba(255,77,66,${Math.max(0, 1 - (t - d.t))})` : d.state === 'fly' ? C.link : `rgba(240,246,255,${tw})`;
      dot(ctx, d.x * w, d.y * h, d.state === 'fly' ? 2.4 : 2, col, d.state === 'on' ? 6 : 10);
    }
    const flying = drones.filter((d) => d.state === 'fly').length;
    label(ctx, flying ? `Healing · ${flying} drones refilling` : 'Formation complete', 18, 26, flying ? C.link : 'rgba(233,241,247,.6)');
  };
}

// 03 · Sport: a mountain stage; drones hold a relay chain from the riders to the TV truck.
function sport(cv) {
  const ctx = setup(cv);
  const ridge = (u) => 0.78 - 0.5 * Math.exp(-((u - 0.58) ** 2) / 0.05) - 0.08 * Math.sin(u * 9);
  const road = []; // switchbacks up the left flank
  // hairpins climbing the flank, each leg sitting on the slope
  for (let k = 0; k <= 12; k++) { const u = 0.2 + k * 0.03; road.push([u + (k % 2 ? 0.035 : -0.02), ridge(u) + (k % 2 ? 0.07 : 0.025)]); }
  road.push([0.58, ridge(0.58) + 0.01]);
  const len = road.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - road[i][0], p[1] - road[i][1]), 0);
  const at = (k) => { let d = k * len; for (let i = 1; i < road.length; i++) { const l = Math.hypot(road[i][0] - road[i - 1][0], road[i][1] - road[i - 1][1]); if (d <= l) return [lerp(road[i - 1][0], road[i][0], d / l), lerp(road[i - 1][1], road[i][1], d / l)]; d -= l; } return road[road.length - 1]; };
  return (t) => {
    const w = cv._w, h = cv._h, H = h * 0.68; ctx.clearRect(0, 0, w, h);
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#24456b'); g.addColorStop(1, '#0a1523');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // far range and the col
    ctx.fillStyle = 'rgba(160,190,220,.18)'; ctx.beginPath(); ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 8) ctx.lineTo(x, h * (0.5 - 0.12 * Math.abs(Math.sin(x * 0.011 + 1)) - 0.06 * Math.sin(x * 0.04)));
    ctx.lineTo(w, h); ctx.fill();
    ctx.fillStyle = '#0d1b2b'; ctx.beginPath(); ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 4) ctx.lineTo(x, ridge(x / w) * H);
    ctx.lineTo(w, h); ctx.fill();
    ctx.strokeStyle = 'rgba(233,241,247,.25)'; ctx.lineWidth = 1; ctx.beginPath(); for (let x = 0; x <= w; x += 4) x ? ctx.lineTo(x, ridge(x / w) * H) : ctx.moveTo(x, ridge(0) * H); ctx.stroke();
    // road
    ctx.strokeStyle = 'rgba(233,241,247,.35)'; ctx.lineWidth = 1.5; ctx.beginPath(); road.forEach((p, i) => (i ? ctx.lineTo(p[0] * w, p[1] * H) : ctx.moveTo(p[0] * w, p[1] * H))); ctx.stroke(); ctx.lineWidth = 1;
    // riders climbing
    const k = (t * 0.045) % 1;
    const r1 = at(k), r2 = at(Math.max(0, k - 0.04));
    dot(ctx, r1[0] * w, r1[1] * H, 3.2, '#ffd23f', 8); dot(ctx, r2[0] * w, r2[1] * H, 2.6, C.ice);
    // relay chain: rider → drones over the col → TV truck on the far side
    const truck = [0.9 * w, ridge(0.9) * H - 6];
    const chain = [[r1[0] * w, r1[1] * H - 4], [0.34 * w, 0.36 * H], [0.58 * w, 0.14 * H + Math.sin(t) * 3], [0.78 * w, 0.4 * H + Math.sin(t * 1.3) * 3], truck];
    ctx.strokeStyle = 'rgba(111,220,255,.6)'; ctx.setLineDash([5, 5]); ctx.lineDashOffset = -t * 30;
    ctx.beginPath(); chain.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke(); ctx.setLineDash([]);
    chain.slice(1, -1).forEach((p) => { dot(ctx, p[0], p[1], 3.4, C.ice); ctx.strokeStyle = 'rgba(233,241,247,.6)'; ctx.beginPath(); ctx.moveTo(p[0] - 7, p[1] - 3); ctx.lineTo(p[0] + 7, p[1] - 3); ctx.stroke(); });
    const f = (t * 0.9) % 1 * (chain.length - 1), s = Math.floor(f), e = f - s;
    dot(ctx, lerp(chain[s][0], chain[s + 1][0], e), lerp(chain[s][1], chain[s + 1][1], e), 3.2, C.sos, 12);
    ctx.fillStyle = C.ice; ctx.fillRect(truck[0] - 10, truck[1] - 6, 20, 10); label(ctx, 'TV truck', truck[0], truck[1] + 18, C.ice, 'center');
    label(ctx, '● Live', 18, 26, C.bad); label(ctx, `Col · km ${(k * 13).toFixed(1)} / 13`, 64, 26, 'rgba(233,241,247,.7)');
  };
}

// 04 · Blackout: a town goes dark; drones sweep it and carry calls for help to the crew post.
function blackout(cv) {
  const ctx = setup(cv);
  const cols = 12, rows = 7;
  const houses = []; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (rnd() > 0.18) houses.push({ c, r, lit: 1, sos: rnd() < 0.16, heard: -10, w: 0.5 + rnd() * 0.35, h: 0.45 + rnd() * 0.35 });
  const drones = [0, 1, 2].map((i) => ({ ph: i / 3 }));
  let carried = 0, cycle = -1;
  return (t) => {
    const w = cv._w, h = cv._h; ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#070d16'; ctx.fillRect(0, 0, w, h);
    const ox = w * 0.06, oy = h * 0.11, cw = (w * 0.72) / cols, ch = (h * 0.46) / rows;
    const T = t % 14;               // one loop: lights on, blackout, sweep
    const cyc = Math.floor(t / 14); if (cyc !== cycle) { cycle = cyc; carried = 0; houses.forEach((hh) => (hh.heard = -10)); }
    const dark = Math.min(1, Math.max(0, (T - 1.2) / 1.6));
    // streets
    ctx.strokeStyle = 'rgba(233,241,247,.07)';
    for (let c = 0; c <= cols; c++) { ctx.beginPath(); ctx.moveTo(ox + c * cw, oy); ctx.lineTo(ox + c * cw, oy + rows * ch); ctx.stroke(); }
    for (let r = 0; r <= rows; r++) { ctx.beginPath(); ctx.moveTo(ox, oy + r * ch); ctx.lineTo(ox + cols * cw, oy + r * ch); ctx.stroke(); }
    // drones sweep in a serpentine over the grid
    const sweep = Math.max(0, T - 3.2) / 10;
    const dp = drones.map((d, i) => {
      const k = Math.min(1, sweep + d.ph * 0.0);
      const row = Math.min(rows - 1, Math.floor(k * rows)), f = k * rows - row, dir = row % 2 ? -1 : 1;
      const band = (i + 0.5) / drones.length;
      const x = ox + (dir > 0 ? f : 1 - f) * cols * cw, y = oy + (row + band) * ch;
      return { x, y, on: T > 3.2 };
    });
    for (const hh of houses) {
      const x = ox + hh.c * cw + cw * (1 - hh.w) / 2, y = oy + hh.r * ch + ch * (1 - hh.h) / 2, bw = cw * hh.w, bh = ch * hh.h;
      const lit = 1 - dark;
      ctx.fillStyle = `rgba(${lerp(18, 255, lit * 0.0)},${20},${30},1)`; ctx.fillStyle = '#121b27'; ctx.fillRect(x, y, bw, bh);
      if (lit > 0) { ctx.fillStyle = `rgba(255,214,140,${0.55 * lit})`; ctx.fillRect(x + bw * 0.2, y + bh * 0.25, bw * 0.22, bh * 0.25); ctx.fillRect(x + bw * 0.58, y + bh * 0.25, bw * 0.22, bh * 0.25); }
      if (hh.sos && dark > 0.9) {
        const cx = x + bw / 2, cy = y + bh / 2;
        const near = dp.some((d) => d.on && Math.hypot(d.x - cx, d.y - cy) < cw * 0.9);
        if (near && hh.heard < 0) { hh.heard = T; carried++; }
        const p = (t * 1.4 + hh.c) % 1;
        if (hh.heard < 0) { ctx.strokeStyle = `rgba(255,122,61,${1 - p})`; ctx.beginPath(); ctx.arc(cx, cy, 3 + p * 10, 0, TAU); ctx.stroke(); dot(ctx, cx, cy, 2.4, C.sos); }
        else dot(ctx, cx, cy, 2.4, C.ok, 6);
      }
    }
    // the tower is dead
    const tw = [ox + cols * cw + w * 0.08, oy + ch * 1.2];
    ctx.strokeStyle = dark > 0.5 ? 'rgba(255,77,66,.9)' : C.ice; ctx.beginPath(); ctx.moveTo(tw[0] - 8, tw[1] + 22); ctx.lineTo(tw[0], tw[1] - 6); ctx.lineTo(tw[0] + 8, tw[1] + 22); ctx.stroke();
    label(ctx, dark > 0.5 ? 'Tower down' : 'Tower', tw[0], tw[1] + 36, dark > 0.5 ? C.bad : C.ice, 'center');
    // crew post
    const post = [tw[0], oy + rows * ch - ch * 1.2];
    ctx.fillStyle = C.ok; ctx.fillRect(post[0] - 7, post[1] - 7, 14, 14); label(ctx, 'Crew post', post[0], post[1] + 22, C.ok, 'center');
    dp.forEach((d) => {
      if (!d.on) return;
      ctx.strokeStyle = 'rgba(111,220,255,.25)'; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(post[0], post[1]); ctx.stroke(); ctx.setLineDash([]);
      dot(ctx, d.x, d.y, 3.6, C.ice, 8); ctx.strokeStyle = 'rgba(111,220,255,.35)'; ctx.beginPath(); ctx.arc(d.x, d.y, cw * 0.9, 0, TAU); ctx.stroke();
    });
    const hour = Math.min(72, Math.floor(Math.max(0, T - 1.2) / 12.8 * 72));
    label(ctx, `Hour ${String(hour).padStart(2, '0')} / 72`, 18, 26, dark > 0.5 ? C.sos : 'rgba(233,241,247,.7)');
    label(ctx, `Calls carried · ${carried}`, 150, 26, C.ok);
  };
}

const KIND = { defence, show, sport, blackout };
for (const cv of document.querySelectorAll('canvas[data-use]')) {
  const draw = KIND[cv.dataset.use](cv);
  let on = false;
  new IntersectionObserver(([e]) => { on = e.isIntersecting; }).observe(cv);
  const t0 = performance.now();
  draw(0);
  const loop = (now) => { if (on) draw((now - t0) / 1000); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
