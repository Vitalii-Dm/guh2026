// main.js — scroll choreography for the page; the 3D scene lives in scene3d.js.
const $ = (s) => document.querySelector(s);
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const root = document.documentElement;

// ───────── Backdrop: slow push-in, then darken behind the story, lift again at the end ─────────
const event = $('#event'), response = $('#response'), handoff = $('#handoff');
function backdrop() {
  const y = scrollY, vh = innerHeight;
  const evTop = event.offsetTop, hoTop = handoff.offsetTop;
  const intoEvent = clamp((y - (evTop - vh * 0.9)) / (vh * 0.8));
  const intoHandoff = clamp((y - (hoTop - vh)) / (vh * 0.8));
  root.style.setProperty('--zoom', clamp(y / (vh * 3)).toFixed(4));
  root.style.setProperty('--lift', clamp(y / (vh * 2)).toFixed(4));
  root.style.setProperty('--shade', (intoEvent * 0.82 * (1 - intoHandoff * 0.75)).toFixed(3));
}

// ───────── Timeline: one beat at a time, its picture wipes in ─────────
const beats = [...document.querySelectorAll('.beat')];
const frames = [...document.querySelectorAll('.frame')];
let current = -1;
function show(i) {
  if (i === current) return;
  frames.forEach((f, k) => {
    f.classList.toggle('on', k === i);
    f.classList.toggle('was', k === current && k !== i);
  });
  // load the heavy footage only when its beat is near
  const next = frames[Math.min(frames.length - 1, i + 1)].querySelector('img[data-src]');
  const here = frames[i].querySelector('img[data-src]');
  for (const img of [here, next]) if (img) { img.src = img.dataset.src; img.removeAttribute('data-src'); }
  if (beats[i].querySelector('[data-count]')) countUp(beats[i].querySelector('[data-count]'));
  current = i;
}
function timeline() {
  const mid = innerHeight * 0.55;
  let best = 0;
  beats.forEach((b, i) => {
    const r = b.getBoundingClientRect();
    const on = r.top < mid && r.bottom > mid;
    b.classList.toggle('on', on);
    if (r.top < mid) best = i;
  });
  show(best);
  // satellite wipe follows the scroll through its beat
  const sat = beats[1].getBoundingClientRect();
  const k = clamp((mid - sat.top) / (sat.height * 0.7));
  frames[1].style.setProperty('--wipe', `${(100 - k * 100).toFixed(2)}%`);
}

let counted = false;
function countUp(n) {
  if (counted) return; counted = true;
  const to = Number(n.dataset.count), fmt = new Intl.NumberFormat('en-GB');
  if (reduced) { n.textContent = fmt.format(to); return; }
  const t0 = performance.now(), dur = 1800;
  const f = (t) => {
    const p = clamp((t - t0) / dur), e = 1 - Math.pow(1 - p, 4);
    n.textContent = fmt.format(Math.round(to * e));
    if (p < 1) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}

// ───────── 3D response: scroll position is the timeline ─────────
const head = $('.stage-head'), caps = [...document.querySelectorAll('#captions li')], bar = $('#progressBar');
let scene = null;
import('./scene3d.js').then((m) => { scene = m.createScene($('#scene3d'), $('#hud')); onScroll(); })
  .catch((e) => { console.error(e); $('#scene3d').replaceWith(Object.assign(document.createElement('p'), { className: 'mono', textContent: '3D view needs WebGL.' })); });

const BEATS = [0, 0.2, 0.4, 0.58, 0.78];   // where each caption starts, in scene time
function responseProgress() {
  const r = response.getBoundingClientRect();
  return clamp(-r.top / (r.height - innerHeight));
}
function stage() {
  const p = responseProgress();
  head.classList.toggle('gone', p > 0.08);
  let k = 0; BEATS.forEach((b, i) => { if (p >= b) k = i; });
  caps.forEach((c, i) => c.classList.toggle('on', i === k && p > 0.02 && p < 0.995));
  bar.style.width = `${(p * 100).toFixed(2)}%`;
  const r = response.getBoundingClientRect();
  if (scene) scene.setProgress(p, r.bottom > 0 && r.top < innerHeight);
}

let ticking = false;
function onScroll() {
  if (ticking) return; ticking = true;
  requestAnimationFrame(() => { backdrop(); timeline(); stage(); ticking = false; });
}
addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', onScroll);
onScroll();
