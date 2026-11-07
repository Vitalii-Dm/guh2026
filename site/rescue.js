// rescue.js — the illustrated rescue scene: drone A finds a trekker behind a
// ridge, the ridge blocks its signal, drone B climbs to the ridge line and
// relays the report to base. A 16 s loop driven by one clock.
import { drone, el, reduced } from './scene.js';

const LOOP = 16;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const span = (t, a, b) => clamp((t - a) / (b - a));

/** Point along a polyline at fraction k (by length). */
function along(pts, k) {
  const seg = []; let total = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); total += l; }
  let d = k * total;
  for (let i = 0; i < seg.length; i++) {
    if (d <= seg[i] || i === seg.length - 1) { const f = seg[i] ? d / seg[i] : 0; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]; }
    d -= seg[i];
  }
}

export function initRescue(svg, caps) {
  const defs = el('defs', {}, svg);
  const grad = (id, stops, x2 = 0, y2 = 1) => { const g = el('linearGradient', { id, x1: 0, y1: 0, x2, y2 }, defs); stops.forEach(([o, c, op = 1]) => el('stop', { offset: o, 'stop-color': c, 'stop-opacity': op }, g)); };
  grad('rsSky', [[0, '#0a1d3c'], [0.55, '#244f86'], [1, '#6b9dd0']]);
  grad('rsFar', [[0, '#f3f9ff'], [0.22, '#bcd6f0'], [1, '#4f7fb6']]);
  grad('rsRidge', [[0, '#e9f3ff'], [0.12, '#9fc0e4'], [0.4, '#3a689f'], [1, '#13305a']]);
  grad('rsNear', [[0, '#1d3f6e'], [1, '#0a1c38']]);
  grad('rsRiver', [[0, '#7fb4dc', 0.9], [1, '#4b7ea8', 0.9]], 1, 0);
  const blur = el('filter', { id: 'rsGlow', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
  el('feGaussianBlur', { stdDeviation: 4 }, blur);

  el('rect', { width: 1200, height: 520, fill: 'url(#rsSky)' }, svg);
  // stars
  for (let i = 0; i < 40; i++) el('circle', { cx: (i * 263) % 1200, cy: (i * 97) % 180, r: i % 5 ? 0.8 : 1.3, fill: '#fff', opacity: 0.5 }, svg);
  // far peaks
  el('path', { d: 'M0 300 L90 230 L150 250 L240 150 L300 200 L380 170 L470 240 L560 190 L700 120 L790 210 L880 160 L980 230 L1070 140 L1150 200 L1200 180 L1200 520 L0 520Z', fill: 'url(#rsFar)', opacity: 0.55 }, svg);
  // main ridge
  el('path', { d: 'M300 520 L380 470 L455 380 L520 300 L575 230 L612 175 L640 150 L668 172 L700 205 L760 280 L830 360 L900 440 L960 520Z', fill: 'url(#rsRidge)' }, svg);
  el('path', { d: 'M640 150 L668 172 L700 205 L760 280 L830 360 L900 440 L960 520 L700 520 L690 330Z', fill: '#0b2347', opacity: 0.28 }, svg);
  el('path', { d: 'M455 380 L520 300 L575 230 L612 175 L640 150 L668 172 L700 205', fill: 'none', stroke: '#f3f9ff', 'stroke-width': 1.4, opacity: 0.6 }, svg);
  // valley floors
  el('path', { d: 'M0 430 C120 420 220 440 330 450 L420 520 L0 520Z', fill: 'url(#rsNear)' }, svg);
  el('path', { d: 'M880 470 C960 440 1080 430 1200 440 L1200 520 L860 520Z', fill: 'url(#rsNear)' }, svg);
  // flooded river
  const RIVER = 'M-10 472 C80 457 160 482 240 470 C300 461 350 480 420 505';
  el('path', { d: RIVER, fill: 'none', stroke: 'url(#rsRiver)', 'stroke-width': 18, 'stroke-linecap': 'round', opacity: 0.75 }, svg);
  const river = el('path', { d: RIVER, fill: 'none', stroke: '#e6f3ff', 'stroke-width': 2, 'stroke-linecap': 'round', opacity: 0.45, 'stroke-dasharray': '18 34' }, svg);
  el('text', { x: 40, y: 505, fill: '#9ec5ec', 'font-size': 13, 'font-family': 'Inter, sans-serif', opacity: 0.8 }, svg).textContent = 'flooded river';

  // base camp
  const base = el('g', { transform: 'translate(1040 440)' }, svg);
  el('path', { d: 'M-48 10 L-30 -14 L-12 10Z', fill: '#cfe6ff', opacity: 0.9 }, base);
  el('path', { d: 'M18 10 L36 -16 L54 10Z', fill: '#ffb27a', opacity: 0.9 }, base);
  el('path', { d: 'M0 10 V-60', stroke: '#cfe6ff', 'stroke-width': 3 }, base);
  el('path', { d: 'M-10 10 L0 -30 L10 10', fill: 'none', stroke: '#cfe6ff', 'stroke-width': 1.5 }, base);
  const mastLight = el('circle', { cx: 0, cy: -62, r: 4.5, fill: '#5ee6d6' }, base);
  const baseRing = el('circle', { cx: 0, cy: -62, r: 10, fill: 'none', stroke: '#4ade80', 'stroke-width': 3, opacity: 0 }, base);
  el('text', { x: 0, y: 34, 'text-anchor': 'middle', fill: '#eaf6ff', 'font-size': 14, 'font-weight': 700, 'font-family': 'Sora, Inter, sans-serif', 'letter-spacing': '.08em' }, base).textContent = 'BASE';
  const dispatched = el('text', { x: 0, y: -84, 'text-anchor': 'middle', fill: '#4ade80', 'font-size': 14, 'font-weight': 600, 'font-family': 'Inter, sans-serif', opacity: 0 }, base);
  dispatched.textContent = 'Rescue team dispatched';
  const MAST = [1040, 378];

  // trekker
  const P = [222, 420];
  const person = el('g', { transform: `translate(${P[0]} ${P[1]}) scale(1.35)` }, svg);
  const beacon = el('circle', { r: 12, fill: 'none', stroke: '#ff8a5c', 'stroke-width': 2.5, opacity: 0 }, person);
  const body = el('g', {}, person);
  el('circle', { cx: 0, cy: -20, r: 5, fill: 'currentColor' }, body);
  el('path', { d: 'M0 -14 V2 M0 2 L-6 14 M0 2 L6 14 M-8 -8 L0 -11 L9 -18', stroke: 'currentColor', 'stroke-width': 3, 'stroke-linecap': 'round', fill: 'none' }, body);
  body.setAttribute('color', '#cbd8e8');
  const tag = el('g', { opacity: 0 }, person);
  const tagBg = el('rect', { x: -44, y: -58, width: 88, height: 24, rx: 12, fill: '#ff8a5c' }, tag);
  const tagTx = el('text', { x: 0, y: -41, 'text-anchor': 'middle', fill: '#2a0e00', 'font-size': 12, 'font-weight': 700, 'font-family': 'Inter, sans-serif', 'letter-spacing': '.06em' }, tag);
  tagTx.textContent = 'SOS';

  // links
  const blocked = el('path', { stroke: '#ff5d5d', 'stroke-width': 2.4, 'stroke-dasharray': '8 8', fill: 'none', opacity: 0 }, svg);
  const xMark = el('g', { opacity: 0 }, svg);
  el('circle', { r: 15, fill: '#2a0d14', stroke: '#ff5d5d', 'stroke-width': 2.5 }, xMark);
  el('path', { d: 'M-6 -6 L6 6 M6 -6 L-6 6', stroke: '#ff5d5d', 'stroke-width': 3, 'stroke-linecap': 'round' }, xMark);
  const xLabel = el('text', { 'text-anchor': 'middle', fill: '#ffb3b3', 'font-size': 13, 'font-weight': 600, 'font-family': 'Inter, sans-serif', opacity: 0 }, svg);
  xLabel.textContent = 'no signal';
  const linkAB = el('line', { stroke: '#5ee6d6', 'stroke-width': 2.4, 'stroke-dasharray': '8 6', opacity: 0 }, svg);
  const linkBC = el('line', { stroke: '#5ee6d6', 'stroke-width': 2.4, 'stroke-dasharray': '8 6', opacity: 0 }, svg);
  const packetGlow = el('circle', { r: 11, fill: '#ff8a5c', filter: 'url(#rsGlow)', opacity: 0 }, svg);
  const packet = el('circle', { r: 6, fill: '#ff8a5c', opacity: 0 }, svg);

  // scan cone under drone A
  const cone = el('path', { fill: '#5ee6d6', opacity: 0 }, svg);

  // drones
  const A = drone(svg, '#eaf6ff', 1.5);
  const B = drone(svg, '#eaf6ff', 1.5);
  const labelA = el('text', { 'text-anchor': 'middle', fill: '#eaf6ff', 'font-size': 13, 'font-weight': 700, 'font-family': 'Sora, Inter, sans-serif' }, svg); labelA.textContent = 'A';
  const labelB = el('text', { 'text-anchor': 'middle', fill: '#eaf6ff', 'font-size': 13, 'font-weight': 700, 'font-family': 'Sora, Inter, sans-serif' }, svg); labelB.textContent = 'B';
  const relayTag = el('text', { 'text-anchor': 'middle', fill: '#5ee6d6', 'font-size': 12, 'font-weight': 600, 'font-family': 'Inter, sans-serif', opacity: 0 }, svg); relayTag.textContent = 'relay';
  const rotors = [...svg.querySelectorAll('.rotor')];

  const pathA = [[1000, 330], [860, 200], [700, 92], [560, 150], [420, 250], [262, 330]];
  const pathB = [[1040, 366], [960, 250], [800, 140], [652, 104]];
  const XAT = [488, 337];   // where the A → base line meets the ridge

  const show = (n, v) => n.setAttribute('opacity', v.toFixed(3));
  const at = (n, [x, y], rot = 0) => n.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(1)})`);
  let beat = -1;

  function render(t, now) {
    const bob = (ph) => Math.sin(now / 420 + ph) * 3;
    // drone A: fly over the ridge to the trekker
    const ka = ease(span(t, 0.4, 4.4));
    const pa = along(pathA, ka); pa[1] += bob(0);
    const tilt = ka > 0 && ka < 1 ? -10 : 0;
    at(A, pa, tilt);
    labelA.setAttribute('x', pa[0]); labelA.setAttribute('y', pa[1] - 18);
    // drone B: climbs from base to the ridge line
    const kb = ease(span(t, 7.6, 10.2));
    const pb = along(pathB, kb); pb[1] += bob(2);
    at(B, pb, kb > 0 && kb < 1 ? -10 : 0);
    labelB.setAttribute('x', pb[0]); labelB.setAttribute('y', pb[1] - 18);
    relayTag.setAttribute('x', pb[0]); relayTag.setAttribute('y', pb[1] - 34); show(relayTag, span(t, 10.2, 10.8) * (1 - span(t, 15, 15.8)));
    rotors.forEach((r, i) => r.setAttribute('rx', (7 + Math.abs(Math.sin(now / 40 + i)) * 6).toFixed(1)));

    // scan cone and find
    const scan = span(t, 3.8, 4.6) * (1 - span(t, 5.4, 6));
    cone.setAttribute('d', `M${pa[0] - 4} ${pa[1] + 8} L${P[0] - 50} ${P[1] + 16} L${P[0] + 50} ${P[1] + 16}Z`);
    show(cone, scan * 0.16);

    const found = t >= 4.6;
    const reported = t >= 12.6;
    const col = reported ? '#4ade80' : found ? '#ff8a5c' : '#cbd8e8';
    body.setAttribute('color', col);
    show(tag, span(t, 4.6, 5));
    tagBg.setAttribute('fill', reported ? '#4ade80' : '#ff8a5c');
    tagBg.setAttribute('x', reported ? -52 : -30); tagBg.setAttribute('width', reported ? 104 : 60);
    tagTx.textContent = reported ? 'REPORTED' : 'SOS';
    tagTx.setAttribute('fill', reported ? '#05230f' : '#2a0e00');
    const bp = (now / 1000) % 1;
    beacon.setAttribute('r', (10 + bp * 26).toFixed(1));
    beacon.setAttribute('stroke', reported ? '#4ade80' : '#ff8a5c');
    show(beacon, found ? (1 - bp) * 0.9 : 0);

    // blocked attempt: A → base
    const tryK = span(t, 5.2, 6.2);
    const ex = pa[0] + (XAT[0] - pa[0]) * tryK, ey = pa[1] + (XAT[1] - pa[1]) * tryK;
    blocked.setAttribute('d', `M${pa[0]} ${pa[1] + 6} L${ex} ${ey}`);
    blocked.setAttribute('stroke-dashoffset', (-now / 30).toFixed(1));
    const blockedOn = span(t, 5.2, 5.4) * (1 - span(t, 10.2, 10.8));
    show(blocked, blockedOn * 0.85);
    at(xMark, XAT); show(xMark, span(t, 6.2, 6.5) * (1 - span(t, 10.2, 10.8)));
    xLabel.setAttribute('x', XAT[0]); xLabel.setAttribute('y', XAT[1] + 34); show(xLabel, span(t, 6.4, 6.8) * (1 - span(t, 10.2, 10.8)));

    // relay links
    const linkOn = span(t, 10.2, 10.6) * (1 - span(t, 15.2, 15.9));
    for (const [ln, a, b] of [[linkAB, pa, pb], [linkBC, pb, MAST]]) {
      ln.setAttribute('x1', a[0]); ln.setAttribute('y1', a[1] + 6); ln.setAttribute('x2', b[0]); ln.setAttribute('y2', b[1] + (b === MAST ? 0 : 6));
      ln.setAttribute('stroke-dashoffset', (-now / 25).toFixed(1));
      show(ln, linkOn);
    }
    // the report hops A → B → base
    const h1 = span(t, 10.8, 11.6), h2 = span(t, 11.6, 12.5);
    let px, py;
    if (t < 11.6) { px = pa[0] + (pb[0] - pa[0]) * ease(h1); py = pa[1] + 6 + (pb[1] - pa[1]) * ease(h1); }
    else { px = pb[0] + (MAST[0] - pb[0]) * ease(h2); py = pb[1] + 6 + (MAST[1] - pb[1] - 6) * ease(h2); }
    const pOn = t >= 10.8 && t < 12.55 ? 1 : 0;
    const pc = t < 11.6 ? '#ff8a5c' : t < 12.2 ? '#ff8a5c' : '#4ade80';
    for (const n of [packet, packetGlow]) { n.setAttribute('cx', px); n.setAttribute('cy', py); n.setAttribute('fill', pc); }
    show(packet, pOn); show(packetGlow, pOn * 0.8);

    // base receives
    const rk = span(t, 12.5, 14);
    baseRing.setAttribute('r', (10 + rk * 40).toFixed(1)); show(baseRing, t >= 12.5 ? 1 - rk : 0);
    mastLight.setAttribute('fill', t >= 12.5 ? '#4ade80' : '#5ee6d6');
    show(dispatched, span(t, 12.8, 13.3) * (1 - span(t, 15.3, 15.9)));

    river.setAttribute('stroke-dashoffset', (-now / 18).toFixed(1));

    const b = t < 5.2 ? 0 : t < 7.6 ? 1 : t < 10.4 ? 2 : 3;
    if (b !== beat) { beat = b; caps.querySelectorAll('span').forEach((s) => s.classList.toggle('on', Number(s.dataset.beat) === b)); }
  }

  if (reduced) { render(13.5, 0); return; }
  let visible = false, t0 = null;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible && t0 == null) t0 = performance.now(); }, { threshold: 0.25 }).observe(svg);
  render(0, 0);
  const loop = (now) => {
    if (visible && t0 != null) render(((now - t0) / 1000) % LOOP, now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
