// usecases.js — overlays for "Real-world applications". Each tile is a real
// photo with the same marks as the 3D scene drawn on top: white drones, teal
// radio links, red for jammed or lost, an orange report that turns green when
// it arrives. A status tag says what is happening at each moment of the loop.
const C = { link: '#6fdcff', sos: '#ff7a3d', ok: '#5fe0b0', bad: '#ff4d42', ice: '#eef4f8', rider: '#ffd23f' };
const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const span = (t, a, b) => ease(clamp((t - a) / (b - a)));

function canvasFor(tile) {
  const cv = tile.querySelector('canvas'), ctx = cv.getContext('2d');
  const fit = () => {
    const dpr = Math.min(2, devicePixelRatio || 1), r = cv.getBoundingClientRect();
    cv.width = Math.max(1, r.width * dpr); cv.height = Math.max(1, r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); cv._w = r.width; cv._h = r.height;
  };
  new ResizeObserver(fit).observe(cv); fit();
  return { cv, ctx };
}

// ───────── shared marks ─────────
function kit(ctx, cv) {
  const X = (u) => u * cv._w, Y = (v) => v * cv._h;
  return {
    drone(u, v, a = 1, col = C.ice) {
      if (a <= 0) return;
      const x = X(u), y = Y(v);
      ctx.globalAlpha = a;
      ctx.fillStyle = 'rgba(6,10,16,.62)'; ctx.beginPath(); ctx.arc(x, y, 12, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(238,244,248,.45)'; ctx.beginPath(); ctx.arc(x, y, 12, 0, TAU); ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(x - 9, y - 2); ctx.lineTo(x + 9, y - 2); ctx.stroke();
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y + 1, 3.2, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1; ctx.lineWidth = 1;
    },
    lost(u, v, a = 1) {
      const x = X(u), y = Y(v); ctx.globalAlpha = a; ctx.strokeStyle = C.bad; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6); ctx.moveTo(x + 6, y - 6); ctx.lineTo(x - 6, y + 6); ctx.stroke();
      ctx.globalAlpha = 1; ctx.lineWidth = 1;
    },
    link(a, b, kind = 'up', alpha = 1, t = 0, reach = 1) {
      if (alpha <= 0) return;
      const [x1, y1, x2, y2] = [X(a[0]), Y(a[1]), X(lerp(a[0], b[0], reach)), Y(lerp(a[1], b[1], reach))];
      ctx.globalAlpha = alpha;
      if (kind === 'up') { ctx.strokeStyle = 'rgba(111,220,255,.25)'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
      ctx.strokeStyle = kind === 'up' ? C.link : C.bad; ctx.lineWidth = kind === 'up' ? 1.8 : 1.6;
      ctx.setLineDash(kind === 'up' ? [7, 5] : [4, 6]); ctx.lineDashOffset = -t * 40;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.lineWidth = 1;
    },
    packet(path, f, col = C.sos) {
      const n = path.length - 1, g = clamp(f) * n, s = Math.min(n - 1, Math.floor(g)), e = g - s;
      const u = lerp(path[s][0], path[s + 1][0], e), v = lerp(path[s][1], path[s + 1][1], e);
      ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 14; ctx.beginPath(); ctx.arc(X(u), Y(v), 4.2, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
    },
    ring(u, v, p, col, max = 26) {
      ctx.strokeStyle = col; ctx.globalAlpha = 1 - p; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(u), Y(v), 4 + p * max, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1; ctx.lineWidth = 1;
    },
    tag(text, u, v, col = 'rgba(255,255,255,.45)', a = 1, align = 'center') {
      if (a <= 0) return;
      ctx.font = '500 10.5px "IBM Plex Mono", monospace'; const w = ctx.measureText(text.toUpperCase()).width + 12;
      let x = X(u), y = Y(v); if (align === 'center') x -= w / 2; else if (align === 'right') x -= w;
      x = clamp(x, 4, cv._w - w - 4);
      ctx.globalAlpha = a; ctx.fillStyle = 'rgba(6,10,16,.7)'; ctx.fillRect(x, y - 15, w, 19);
      ctx.strokeStyle = col; ctx.strokeRect(x + 0.5, y - 14.5, w - 1, 18);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(text.toUpperCase(), x + 6, y - 2); ctx.globalAlpha = 1;
    },
  };
}

function status(tile) {
  const el = tile.querySelector('.use-status'); let last = '';
  return (text, col) => { if (text !== last) { el.textContent = text; last = text; } el.style.setProperty('--st', col); };
}

// ───────── 01 · Defence: jamming cuts the direct link; the swarm routes around it ─────────
function defence(tile) {
  const { cv, ctx } = canvasFor(tile), k = kit(ctx, cv), say = status(tile);
  const A = [0.41, 0.16], OP = [0.73, 0.7], B = [0.66, 0.11], D = [0.9, 0.36], JAM = [0.56, 0.44];
  return (t) => {
    const T = t % 9; ctx.clearRect(0, 0, cv._w, cv._h);
    const jx = cv._w * JAM[0], jy = cv._h * JAM[1], jamR = Math.min(cv._w, cv._h) * (0.22 + 0.015 * Math.sin(t * 3));
    const g = ctx.createRadialGradient(jx, jy, 0, jx, jy, jamR);
    g.addColorStop(0, 'rgba(255,77,66,.32)'); g.addColorStop(1, 'rgba(255,77,66,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(jx, jy, jamR, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,77,66,.7)'; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.arc(jx, jy, jamR, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    k.tag('Jammer', JAM[0], JAM[1] + 0.03, C.bad);
    k.link(A, OP, 'cut', 1 - span(T, 3.2, 3.8), t, 0.55);
    const rr = span(T, 3, 3.6);
    k.drone(B[0], B[1], rr); k.drone(D[0], D[1], rr);
    k.link(A, B, 'up', span(T, 3.6, 4), t); k.link(B, D, 'up', span(T, 3.9, 4.3), t); k.link(D, OP, 'up', span(T, 4.2, 4.6), t);
    if (T > 4.6 && T < 8.6) { const f = ((T - 4.6) % 1.6) / 1.6; k.packet([A, B, D, OP], f, f > 0.9 ? C.ok : C.sos); }
    k.drone(A[0], A[1]); k.tag('Drone A', A[0], A[1] - 0.05);
    k.tag('Operator', OP[0], OP[1] + 0.1, T > 4.6 ? C.ok : 'rgba(255,255,255,.45)');
    if (T < 3.2) say('Link to operator jammed', C.bad); else if (T < 4.6) say('Drones nearby join in', C.link); else say('Footage rerouted through the swarm', C.ok);
  };
}

// ───────── 02 · Drone shows: drones fail; the rest spread out and close the gap ─────────
function show(tile) {
  const { cv, ctx } = canvasFor(tile), k = kit(ctx, cv), say = status(tile);
  const poly = [[0.52, 0.5], [0.62, 0.24], [0.68, 0.34], [0.77, 0.1], [0.86, 0.3], [0.9, 0.22], [0.97, 0.5]];
  const segs = poly.slice(1).map((p, i) => Math.hypot((p[0] - poly[i][0]) * 1.6, p[1] - poly[i][1]));
  const total = segs.reduce((a, b) => a + b, 0);
  const at = (f) => { let d = f * total; for (let i = 0; i < segs.length; i++) { if (d <= segs[i] || i === segs.length - 1) { const e = clamp(d / segs[i]); return [lerp(poly[i][0], poly[i + 1][0], e), lerp(poly[i][1], poly[i + 1][1], e)]; } d -= segs[i]; } return poly[poly.length - 1]; };
  const N = 46, lost = new Set([19, 20, 21, 22]);
  const alive = [...Array(N).keys()].filter((i) => !lost.has(i));
  return (t) => {
    const T = t % 8; ctx.clearRect(0, 0, cv._w, cv._h);
    const failed = T > 2, heal = span(T, 3, 5.2), restore = span(T, 7.2, 7.9);
    for (let i = 0; i < N; i++) {
      const home = at(i / (N - 1));
      if (failed && lost.has(i)) {
        const fall = span(T, 2, 3);
        ctx.globalAlpha = (1 - fall) * (1 - restore); ctx.fillStyle = C.bad;
        ctx.beginPath(); ctx.arc(cv._w * home[0], cv._h * (home[1] + fall * 0.25), 2.4, 0, TAU); ctx.fill();
        ctx.globalAlpha = restore; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cv._w * home[0], cv._h * home[1], 2.2, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;
        continue;
      }
      let p = home;
      if (failed) { const tgt = at(alive.indexOf(i) / (alive.length - 1)), m = heal * (1 - restore); p = [lerp(home[0], tgt[0], m), lerp(home[1], tgt[1], m)]; }
      const moving = failed && heal > 0 && heal < 1;
      ctx.fillStyle = moving ? C.link : `rgba(255,248,235,${0.7 + 0.3 * Math.sin(t * 4 + i)})`; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(cv._w * p[0], cv._h * p[1], 2.2, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
    }
    if (failed && T < 3.2) { const m = at(0.46); k.tag('4 drones lost', m[0], m[1] + 0.12, C.bad); }
    if (T < 2 || T >= 7.2) say('Formation complete', 'rgba(255,255,255,.5)');
    else if (T < 3) say('4 drones lost', C.bad); else if (T < 5.3) say('Neighbours closing the gap', C.link); else say('Shape whole again, nobody steered it', C.ok);
  };
}

// ───────── 03 · Sport: a relay chain from the riders to the TV truck; one relay fails, a spare steps in ─────────
function sport(tile) {
  const { cv, ctx } = canvasFor(tile), k = kit(ctx, cv), say = status(tile);
  const RIDERS = [0.42, 0.66], R1 = [0.47, 0.38], R2 = [0.7, 0.22], R3 = [0.9, 0.12], TV = [1.02, 0.06], SPARE = [0.64, 0.46];
  return (t) => {
    const T = t % 10; ctx.clearRect(0, 0, cv._w, cv._h);
    const fail = T > 4, swap = span(T, 5, 6.4);
    const mid = fail ? [lerp(SPARE[0], R2[0] - 0.02, swap), lerp(SPARE[1], R2[1] + 0.02, swap)] : R2;
    k.link(RIDERS, R1, 'up', 1, t); k.link(R1, mid, 'up', fail ? swap : 1, t); k.link(mid, R3, 'up', fail ? swap : 1, t); k.link(R3, TV, 'up', 1, t);
    if (fail && T < 6.4) k.link(R1, R2, 'cut', 1 - swap, t);
    if (!fail || swap >= 1) k.packet([RIDERS, R1, mid, R3, TV], (t * 0.7) % 1, C.sos);
    ctx.fillStyle = C.rider; ctx.shadowColor = C.rider; ctx.shadowBlur = 10; ctx.beginPath(); ctx.arc(cv._w * RIDERS[0], cv._h * RIDERS[1], 4.5, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
    k.ring(RIDERS[0], RIDERS[1], (t * 0.8) % 1, C.rider, 20);
    k.tag('Lead group', RIDERS[0], RIDERS[1] + 0.08);
    k.drone(R1[0], R1[1]); k.drone(R3[0], R3[1]);
    if (!fail) k.drone(R2[0], R2[1]);
    else { k.lost(R2[0], R2[1], 1 - span(T, 8, 9)); k.drone(mid[0], mid[1], 1, swap < 1 ? C.link : C.ice); if (swap < 1) k.tag('Spare', mid[0], mid[1] + 0.08, C.link); }
    k.tag('To TV truck →', 0.98, 0.2, 'rgba(255,255,255,.45)', 1, 'right');
    if (T < 4) say('Live · 3 relays to the truck', C.bad); else if (T < 5) say('Relay drone lost', C.bad); else if (T < 6.4) say('Spare drone takes its place', C.link); else say('Live · the picture never dropped', C.ok);
  };
}

// ───────── 04 · Blackout: phones on the street call for help; drones carry the calls to the crew ─────────
function blackout(tile) {
  const { cv, ctx } = canvasFor(tile), k = kit(ctx, cv), say = status(tile);
  const D1 = [0.3, 0.15], D2 = [0.62, 0.1], CREW = [1.02, 0.08];
  const phones = [[0.2, 0.74, 0.6], [0.52, 0.66, 2.6], [0.8, 0.78, 4.6]];
  return (t) => {
    const T = t % 9; ctx.clearRect(0, 0, cv._w, cv._h);
    k.link(D1, D2, 'up', 1, t); k.link(D2, CREW, 'up', 1, t);
    let carried = 0;
    phones.forEach(([u, v, t0]) => {
      const local = T - t0, sent = local > 1.6;
      if (local > 0 && !sent) k.ring(u, v, (local % 0.8) / 0.8, C.sos, 22);
      ctx.fillStyle = sent ? C.ok : local > 0 ? C.sos : 'rgba(255,255,255,.55)'; ctx.beginPath(); ctx.arc(cv._w * u, cv._h * v, 3.6, 0, TAU); ctx.fill();
      const near = Math.abs(u - D1[0]) < Math.abs(u - D2[0]) ? D1 : D2;
      if (local > 0.4 && local < 1.6) { k.link([u, v], near, 'up', 1, t); k.packet(near === D1 ? [[u, v], D1, D2, CREW] : [[u, v], D2, CREW], (local - 0.4) / 1.2, C.sos); }
      if (local > 0 && local < 1.6) k.tag('Call for help', u, v + 0.09, C.sos);
      if (sent) carried++;
    });
    k.drone(D1[0], D1[1]); k.drone(D2[0], D2[1]);
    k.tag('To crew post →', 0.98, 0.22, carried ? C.ok : 'rgba(255,255,255,.45)', 1, 'right');
    say(carried ? `Towers down · ${carried} of 3 calls delivered` : 'Towers down · phones have no signal', carried ? C.ok : C.bad);
  };
}

const KIND = { defence, show, sport, blackout };
for (const tile of document.querySelectorAll('.use[data-use]')) {
  const draw = KIND[tile.dataset.use](tile);
  let on = false;
  new IntersectionObserver(([e]) => { on = e.isIntersecting; }).observe(tile);
  const t0 = performance.now();
  draw(0);
  const loop = (now) => { if (on) draw((now - t0) / 1000); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
