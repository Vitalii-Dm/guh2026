// scene.js — the landscape behind the page, the hero swarm, the ridge figure,
// scroll reveals and counters. Purely visual.

const NS = 'http://www.w3.org/2000/svg';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
};

function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Jagged skyline: midpoint displacement, then sharpened so peaks read as Himalayan. */
function skyline(seed, n, rough, sharp) {
  const r = rng(seed);
  let pts = [r(), r()];
  let amp = 1;
  while (pts.length < n) {
    const next = [];
    for (let i = 0; i < pts.length - 1; i++) next.push(pts[i], (pts[i] + pts[i + 1]) / 2 + (r() - 0.5) * amp);
    next.push(pts[pts.length - 1]);
    pts = next; amp *= rough;
  }
  const lo = Math.min(...pts), hi = Math.max(...pts);
  return pts.map((v) => Math.pow((v - lo) / (hi - lo), sharp));
}

const LAYERS = [
  // seed, top y, depth (px of relief), colour top → bottom, snow, parallax
  { seed: 11, base: 470, relief: 330, c: ['#9cc3e8', '#5f8fc4'], snow: 0.42, par: 0.04, facets: true },
  { seed: 29, base: 540, relief: 260, c: ['#6f9fd2', '#3c6aa3'], snow: 0.26, par: 0.09, facets: true },
  { seed: 47, base: 610, relief: 170, c: ['#3f6ea8', '#21477c'], snow: 0.1, par: 0.16 },
  { seed: 63, base: 680, relief: 120, c: ['#22477c', '#122c54'], snow: 0, par: 0.26 },
  { seed: 81, base: 750, relief: 80, c: ['#112a50', '#081a36'], snow: 0, par: 0.38 },
];

function drawRidges(svg) {
  const W = 1600, H = 800;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const defs = el('defs', {}, svg);
  const groups = [];
  LAYERS.forEach((L, li) => {
    const h = skyline(L.seed, 65, 0.52, 1.55);
    const step = (W + 200) / (h.length - 1);
    const pts = h.map((v, i) => [-100 + i * step, L.base - v * L.relief]);
    const top = Math.min(...pts.map((p) => p[1]));
    const gid = `rg${li}`;
    const g = el('linearGradient', { id: gid, x1: 0, y1: top, x2: 0, y2: L.base + 60, gradientUnits: 'userSpaceOnUse' }, defs);
    if (L.snow) {
      el('stop', { offset: 0, 'stop-color': '#f6fbff' }, g);
      el('stop', { offset: L.snow * 0.55, 'stop-color': '#e3f0fd' }, g);
      el('stop', { offset: L.snow, 'stop-color': L.c[0] }, g);
    } else {
      el('stop', { offset: 0, 'stop-color': L.c[0] }, g);
    }
    el('stop', { offset: 1, 'stop-color': L.c[1] }, g);

    const layer = el('g', { class: 'layer' }, svg);
    const d = `M${pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join('L')}L${W + 100},${H + 900}L-100,${H + 900}Z`;
    el('path', { d, fill: `url(#${gid})` }, layer);

    // Shadowed east faces: a facet from each peak down to the next valley.
    if (L.facets) {
      let fd = '';
      for (let i = 1; i < pts.length - 1; i++) {
        if (pts[i][1] < pts[i - 1][1] && pts[i][1] < pts[i + 1][1]) {
          let j = i + 1;
          while (j < pts.length - 1 && pts[j + 1][1] >= pts[j][1]) j++;
          const [px, py] = pts[i], [vx, vy] = pts[j];
          if (vy - py < L.relief * 0.12) continue;
          const foot = [px + (vx - px) * 0.15, vy + (vy - py) * 0.9];
          fd += `M${px},${py}` + pts.slice(i + 1, j + 1).map((p) => `L${p[0]},${p[1]}`).join('') + `L${foot[0]},${foot[1]}Z`;
        }
      }
      el('path', { d: fd, fill: '#0b2347', opacity: li === 0 ? 0.22 : 0.26 }, layer);
    }
    // Rim light along the ridge line.
    el('path', { d: `M${pts.map((p) => p.join(',')).join('L')}`, fill: 'none', stroke: '#eaf5ff', 'stroke-width': li < 2 ? 1.2 : 0.8, opacity: li < 2 ? 0.55 : 0.18 }, layer);
    groups.push({ g: layer, par: L.par });
  });
  return groups;
}

/** A small quadcopter glyph, centred on 0,0. */
function drone(parent, colour = '#eaf6ff', scale = 1) {
  const g = el('g', { class: 'drone' }, parent);
  const s = el('g', { transform: `scale(${scale})` }, g);
  el('path', { d: 'M-15 0H15', stroke: colour, 'stroke-width': 2, 'stroke-linecap': 'round' }, s);
  el('ellipse', { cx: -15, cy: -3, rx: 9, ry: 1.8, fill: colour, opacity: 0.55, class: 'rotor' }, s);
  el('ellipse', { cx: 15, cy: -3, rx: 9, ry: 1.8, fill: colour, opacity: 0.55, class: 'rotor' }, s);
  el('path', { d: 'M-6 -1h12l-2 5h-8z', fill: colour }, s);
  el('circle', { cx: 0, cy: 6, r: 1.6, fill: '#5ee6d6', class: 'blink' }, s);
  return g;
}

function heroSwarm(svg) {
  const N = 5;
  const linkG = el('g', {}, svg), pulseG = el('g', {}, svg), droneG = el('g', {}, svg);
  const drones = Array.from({ length: N }, (_, i) => ({ g: drone(droneG, '#eaf6ff', 0.9), ph: i * 1.3, lane: 70 + (i % 3) * 70 }));
  const links = [];
  for (let i = 0; i < N - 1; i++) links.push({ a: i, b: i + 1, line: el('line', { stroke: '#5ee6d6', 'stroke-width': 1.2, 'stroke-dasharray': '4 6' }, linkG), p: el('circle', { r: 2.6, fill: '#bff8f0' }, pulseG), off: i * 0.25 });
  function frame(t) {
    const s = t / 1000;
    const pos = drones.map((d, i) => {
      const x = 140 + i * 230 + Math.sin(s * 0.35 + d.ph) * 40;
      const y = d.lane + Math.sin(s * 0.6 + d.ph * 2) * 18;
      d.g.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${(Math.cos(s * 0.35 + d.ph) * 6).toFixed(1)})`);
      return [x, y];
    });
    links.forEach((L, i) => {
      const [ax, ay] = pos[L.a], [bx, by] = pos[L.b];
      L.line.setAttribute('x1', ax); L.line.setAttribute('y1', ay + 4); L.line.setAttribute('x2', bx); L.line.setAttribute('y2', by + 4);
      L.line.setAttribute('stroke-dashoffset', (-s * 20).toFixed(1));
      // one pulse travels down the chain, like a report being relayed
      const k = ((s * 0.4 - L.off) % 1 + 1) % 1 * 4 - i;
      const on = k >= 0 && k <= 1;
      L.p.setAttribute('opacity', on ? 1 : 0);
      if (on) { L.p.setAttribute('cx', ax + (bx - ax) * k); L.p.setAttribute('cy', ay + 4 + (by - ay) * k); }
    });
    if (!reduced) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function whyFigure(svg) {
  const defs = el('defs', {}, svg);
  const g = el('linearGradient', { id: 'whyR', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el('stop', { offset: 0, 'stop-color': '#e8f3ff' }, g);
  el('stop', { offset: 0.25, 'stop-color': '#7fa9d8' }, g);
  el('stop', { offset: 1, 'stop-color': '#1d3f6e' }, g);
  el('path', { d: 'M0 240 L0 205 L70 190 L150 200 L240 70 L268 52 L300 82 L380 170 L450 185 L520 178 L520 240Z', fill: 'url(#whyR)' }, svg);
  el('path', { d: 'M240 70 L268 52 L300 82 L262 150Z', fill: '#0b2347', opacity: 0.25 }, svg);
  // base
  const b = el('g', { transform: 'translate(462 170)' }, svg);
  el('path', { d: 'M-16 12 L0 -4 L16 12Z', fill: '#cfe6ff' }, b);
  el('path', { d: 'M0 -4 V-30', stroke: '#cfe6ff', 'stroke-width': 2 }, b);
  el('circle', { cx: 0, cy: -32, r: 3, fill: '#5ee6d6' }, b);
  el('text', { x: 0, y: 30, 'text-anchor': 'middle', fill: '#a9bdd6', 'font-size': 12, 'font-family': 'Inter, sans-serif' }, b).textContent = 'BASE';
  // drone behind ridge
  const dg = el('g', { transform: 'translate(110 150)' }, svg);
  drone(dg, '#eaf6ff', 1.1);
  el('text', { x: 0, y: 30, 'text-anchor': 'middle', fill: '#ff8a5c', 'font-size': 12, 'font-weight': 600, 'font-family': 'Inter, sans-serif' }, dg).textContent = 'SOS found';
  // blocked link
  el('path', { d: 'M126 146 L250 96', stroke: '#5ee6d6', 'stroke-width': 2, 'stroke-dasharray': '6 6' }, svg);
  el('path', { d: 'M286 104 L452 136', stroke: '#ff5d5d', 'stroke-width': 2, 'stroke-dasharray': '6 6', opacity: 0.8 }, svg);
  const x = el('g', { transform: 'translate(268 100)' }, svg);
  el('circle', { r: 13, fill: '#2a0d14', stroke: '#ff5d5d', 'stroke-width': 2 }, x);
  el('path', { d: 'M-5 -5 L5 5 M5 -5 L-5 5', stroke: '#ff5d5d', 'stroke-width': 2.4, 'stroke-linecap': 'round' }, x);
  el('text', { x: 268, y: 30, 'text-anchor': 'middle', fill: '#ffb3b3', 'font-size': 13, 'font-weight': 600, 'font-family': 'Inter, sans-serif' }, svg).textContent = 'ridge blocks the signal';
}

function parallax(groups) {
  const sky = document.querySelector('.sky');
  const dusk = document.querySelector('.dusk');
  const moon = document.querySelector('.moon');
  const ridgesEl = document.getElementById('ridges');
  let ticking = false;
  const apply = () => {
    const y = scrollY, vh = innerHeight;
    const max = document.documentElement.scrollHeight - vh;
    const k = Math.min(1, y / Math.max(1, max));
    groups.forEach(({ g, par }) => g.setAttribute('transform', `translate(0 ${(-Math.min(y, vh * 2) * par * 0.22).toFixed(1)})`));
    // night falls as you go down into the valley, and dawn breaks at the close
    const toEnd = max - y;
    const night = Math.min(1, y / (vh * 0.9));
    const dawn = Math.max(0, 1 - toEnd / (vh * 1.1));
    dusk.style.opacity = (night * (1 - dawn * 0.75)).toFixed(3);
    ridgesEl.style.opacity = (1 - night * 0.55 + dawn * 0.55).toFixed(3);
    moon.style.transform = `translateY(${(-y * 0.05).toFixed(1)}px)`;
    sky.style.setProperty('--k', k);
    ticking = false;
  };
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(apply); } }, { passive: true });
  addEventListener('resize', apply);
  apply();
}

function reveals() {
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return;
    e.target.classList.add('in');
    e.target.querySelectorAll('[data-count]').forEach(countUp);
    io.unobserve(e.target);
  }), { threshold: 0.18 });
  document.querySelectorAll('.reveal').forEach((n) => io.observe(n));
}

function countUp(n) {
  const to = Number(n.dataset.count), fmt = new Intl.NumberFormat('en-GB');
  if (reduced) { n.textContent = fmt.format(to); return; }
  const t0 = performance.now(), dur = 1400;
  const f = (t) => {
    const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    n.textContent = fmt.format(Math.round(to * e));
    if (p < 1) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}

function navSpy() {
  const links = [...document.querySelectorAll('.nav-links a')];
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${e.target.id}`));
  }), { rootMargin: '-45% 0px -50% 0px' });
  document.querySelectorAll('section[id]').forEach((s) => io.observe(s));
}

export function initScene() {
  const groups = drawRidges(document.getElementById('ridges'));
  parallax(groups);
  heroSwarm(document.getElementById('heroSwarm'));
  whyFigure(document.getElementById('whyFig'));
  reveals();
  navSpy();
}

export { drone, el, NS, reduced };
