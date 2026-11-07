// Demo: fail any drone (including the hub), cut the radio, and the swarm keeps
// going. sim.js is the simulation; this file draws it and handles input.
import * as R from '../recovery/swarm-recovery.js';
import { NCA } from '../recovery/nca-runtime.js';
import { makeTerrain } from './terrain.js';
import { createMessages } from './messages.js';
import { W, H, CELL, COLS, ROWS, N_DRONES, N_SURVIVORS, SENSE, BASE, DT, TICK_STEPS, createSim } from './sim.js';
import { NOT_CONNECTED, PHONE_SPEED, RATES, DEFAULT_RATE } from './mission.js';
import { createPhoneLink } from './phone-link.js';

const msgs = createMessages();

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const MAP_CTX = ctx;              // the 2D map; the 3D view draws its ground markings elsewhere
const BRUSH = 60;               // blackout brush radius, px
const SAMPLE_TICKS = 4;         // ticks between graph samples
const SECONDS_PER_TICK = 0.16;
const NCA_FRAMES_PER_STEP = 4;  // slow enough to watch the formation repair
const MODE_COLOUR = { hub: '#2bb3a8', neighbours: '#f29e4c', alone: '#e5534b' };
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const phoneMode = params.has('phones');   // ?phones=1: some drones fly on phones
if (phoneMode) $('drones').value = Number(params.get('drones')) || N_DRONES;
const PHONE_STEP_MS = 250;                // a timer as well as frames, as a hidden tab gets no frames
const MAX_STEPS_PER_FRAME = 3000;         // catching up after the tab was hidden
const unreachable = (d) => d.remote && !d.inContact;   // flown by a phone this screen can't hear
const calm = matchMedia('(prefers-reduced-motion: reduce)');
// Let the map fill the window below the toolbar, however many rows it wraps to.
new ResizeObserver(([e]) => document.documentElement.style.setProperty('--bar', `${e.target.offsetHeight}px`)).observe(document.querySelector('header'));

// `world` is the run on screen. The two reference runs share its terrain and
// survivors and play alongside it, unseen, for the graph to compare against.
let world, reference, logged, history, marks;
let mode = 'search';
let terrainSeed = Number(params.get('seed')) || 2026;
let link = null;                // phone mode only
const fog = document.createElement('canvas');
fog.width = COLS; fog.height = ROWS;
const fogCtx = fog.getContext('2d');
let range = +$('range').value;
let painting = false;
let selected = null;            // the drone whose view is on screen

function reset() {
  const terrain = makeTerrain(terrainSeed, W, H, BASE);
  const los = $('los').checked;
  const drones = +$('drones').value;
  $('dronesV').textContent = drones;
  $('seedV').textContent = terrainSeed;
  const phoneOptions = phoneMode ? { speed: PHONE_SPEED, remoteIds: link?.claimed() ?? [] } : {};
  world = createSim({ seed: terrainSeed, terrain, drones, range, los, onLog: log, ...phoneOptions });
  world.mode = mode;
  terrainFor3d();
  // The comparison runs can't include a phone, so phone mode leaves them out.
  reference = phoneMode ? null : {
    on: createSim({ seed: terrainSeed, terrain, drones, range, los }),
    off: createSim({ seed: terrainSeed, terrain, drones, radio: false }),
  };
  logged = new Set();
  history = [];
  marks = [];
  $('cutRadio').classList.remove('on');
  $('cutRadio').textContent = 'Cut all radio';
  $('log').innerHTML = '';
  select(null);
  log(`${phoneMode ? 'Swarm ready' : 'Swarm launched'} over terrain #${terrainSeed}: ${drones} drones, drone 1 is the hub, ${N_SURVIVORS} missing people`);
  msgs.clear();
  carried = null;
  if (nca) nca.reset();
  ncaWatch = null;
  ncaOwners = null;
}

// ---------------------------------------------------------------- log
function log(msg, key) {
  if (key) { if (logged.has(key)) return; logged.add(key); }
  const li = document.createElement('li');
  li.innerHTML = `<span class="t">${String(Math.round(world.tick * SECONDS_PER_TICK)).padStart(3, ' ')}s</span>${msg}`;
  $('log').prepend(li);
  while ($('log').children.length > 40) $('log').lastChild.remove();
}

// ---------------------------------------------------------------- input
function fail(d) {
  if (!d || !d.alive) return;
  if (phoneMode && !world.steps) { log('The swarm has not launched yet.'); return; }
  if (d.remote) { log(`Drone ${d.id} is flown by a phone, so this screen can't fail it. Aeroplane mode on the phone cuts its connection, but the drone keeps flying.`); return; }
  const wasHub = world.currentHub() === d.id;
  const slot = world.fail(d, performance.now());
  if (d === selected) select(null);
  marks.push({ tick: world.tick, label: wasHub ? 'hub failed' : `drone ${d.id} failed` });
  if (nca && slot) damageNca(slot[0] * nca.N, slot[1] * nca.N);
}

function mapPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
}

function setPainting(on) {
  painting = on;
  $('paint').classList.toggle('on', on);
  if (view) view.controls.enabled = !on;      // in 3D, dragging paints instead of turning the camera
}

function select(d) {
  selected = d;
  $('droneCard').hidden = !d;
  updateDronePanel();
  updateGrid();
}

let brushAt = null;              // last brush point while dragging
function brushTo(p) {
  const n = Math.ceil(Math.hypot(p.x - brushAt.x, p.y - brushAt.y) / (BRUSH / 2)) || 1;
  for (let i = 1; i <= n; i++) world.paintBlackout(brushAt.x + ((p.x - brushAt.x) * i) / n, brushAt.y + ((p.y - brushAt.y) * i) / n, BRUSH);
  brushAt = p;
}
canvas.addEventListener('pointerdown', (e) => {
  const p = mapPoint(e);
  if (painting) {
    brushAt = p;
    canvas.setPointerCapture(e.pointerId);
    world.paintBlackout(p.x, p.y, BRUSH);
    marks.push({ tick: world.tick, label: 'blackout' });
    return;
  }
  let best = null, bd = 22;
  for (const d of world.drones) {
    const dd = Math.hypot(d.x - p.x, d.y - p.y);
    if (d.alive && dd < bd) { best = d; bd = dd; }
  }
  select(best);
});
canvas.addEventListener('pointermove', (e) => {
  if (brushAt) brushTo(mapPoint(e));
});
canvas.addEventListener('pointerup', () => { brushAt = null; });

$('failSelected').onclick = () => fail(selected);
$('closeView').onclick = () => select(null);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') select(null); });
$('knowGrid').addEventListener('pointerdown', (e) => {
  const id = Number(e.target.closest('[data-id]')?.dataset.id);
  const d = world.drones.find((x) => x.id === id && x.alive);
  if (d) select(d === selected ? null : d);
});
$('failHub').onclick = () => {
  const hub = world.drones.find((d) => d.id === world.currentHub());
  if (hub?.alive) fail(hub); else log('The hub is already down and no drone has taken over yet');
};
$('failRandom').onclick = () => { const live = world.drones.filter((d) => d.alive && !d.remote); fail(live[Math.floor(Math.random() * live.length)]); };
$('paint').onclick = () => setPainting(!painting);
$('clearBlackout').onclick = () => { world.clearBlackout(); marks.push({ tick: world.tick, label: 'blackout lifted' }); };
function showRadioButton() {
  $('cutRadio').classList.toggle('on', !world.radio);
  $('cutRadio').textContent = world.radio ? 'Cut all radio' : 'Restore radio';
}
$('cutRadio').onclick = () => {
  world.radio = !world.radio;
  showRadioButton();
  marks.push({ tick: world.tick, label: world.radio ? 'radio back' : 'radio cut' });
};
// A phone-mode run can't restart in place: the phones have to join a new mission.
$('reset').onclick = phoneMode ? () => restartPhones() : reset;
// Every device must agree on the swarm's size, so in phone mode a change starts a new mission.
const restartPhones = () => { location.search = `?phones=1&seed=${terrainSeed}&drones=${$('drones').value}&restart=1`; };
if (phoneMode) {
  $('drones').oninput = (e) => { $('dronesV').textContent = e.target.value; };
  $('drones').onchange = restartPhones;
} else $('drones').oninput = reset;
$('newTerrain').onclick = () => {
  terrainSeed = Math.floor(Math.random() * 1e6);
  if (phoneMode) restartPhones(); else reset();
};
$('range').oninput = (e) => { range = +e.target.value; $('rangeV').textContent = range; world.range = range; if (reference) reference.on.range = range; };
function setLos(on) { world.los = on; if (reference) reference.on.los = on; }
$('los').onchange = (e) => setLos(e.target.checked);
for (const el of document.querySelectorAll('input[name=mode]')) {
  el.onchange = (e) => {
    mode = e.target.value;
    world.mode = mode;
    // Ridges make a formation twitch: a drone that dips behind one looks gone.
    $('los').checked = mode === 'search';
    setLos($('los').checked);
  };
}

// ---------------------------------------------------------------- drawing
const hueDeg = (rank, n) => (rank / Math.max(1, n)) * 300 + 170;
const hue = (rank, n) => `hsl(${hueDeg(rank, n)}, 65%, 58%)`;

/** A drone's colour as [r, g, b]; the same one its dot uses. Down drones are grey. */
function droneRgb(id) {
  const d = world.drones.find((x) => x.id === id);
  if (!d || !d.alive) return [150, 150, 160];
  const ids = R.liveIds(d.state);
  const h = hueDeg(ids.indexOf(d.id), ids.length) % 360, sat = 0.65, l = 0.58;
  const k = (n) => (n + h / 30) % 12, a = sat * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

// Who searched what, for a selected drone: its own cells solid in its colour,
// cells it was told about faint in the colour of the drone that searched them.
const paint = document.createElement('canvas');
paint.width = COLS; paint.height = ROWS;
const paintCtx = paint.getContext('2d');
const paintImg = paintCtx.createImageData(COLS, ROWS);
function drawWhoSearched(d, ctx = MAP_CTX) {
  const px = paintImg.data, cache = new Map();
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const i = r * COLS + c, o = i * 4;
    if (!R.isVisited(d.state, c, r)) { px[o + 3] = 0; continue; }
    const own = d.own[i] === 1;
    const by = own ? d.id : world.searchedBy[i];
    if (!cache.has(by)) cache.set(by, droneRgb(by));
    const [cr, cg, cb] = cache.get(by);
    px[o] = cr; px[o + 1] = cg; px[o + 2] = cb; px[o + 3] = own ? 175 : 105;
  }
  paintCtx.putImageData(paintImg, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(paint, 0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  // edges: white around what it searched itself, thin dark lines between
  // areas that came from different drones
  const src = (c, r) => (c < 0 || r < 0 || c >= COLS || r >= ROWS || !R.isVisited(d.state, c, r)) ? -1 : d.own[r * COLS + c] ? d.id : world.searchedBy[r * COLS + c];
  for (const [colour, width, ownOnly] of [['rgba(4,10,20,0.55)', 1, false], ['#ffffff', 2, true]]) {
    ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.beginPath();
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const a = src(c, r);
      for (const [dc, dr] of [[1, 0], [0, 1]]) {
        const b = src(c + dc, r + dr);
        if (a === b || (ownOnly ? a !== d.id && b !== d.id : a === -1 || b === -1)) continue;
        if (ownOnly && (a === d.id) === (b === d.id)) continue;
        const x = (c + dc) * CELL, y = (r + dr) * CELL;
        if (dc) { ctx.moveTo(x, r * CELL); ctx.lineTo(x, (r + 1) * CELL); } else { ctx.moveTo(c * CELL, y); ctx.lineTo((c + 1) * CELL, y); }
      }
    }
    ctx.stroke();
  }
  // its responsibility: the home strip it was given
  if (mode === 'search') {
    const [c0, c1] = R.homeSector(d.state, d.id, COLS);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.setLineDash([8, 5]);
    ctx.strokeRect(c0 * CELL + 1, 1, (c1 - c0) * CELL - 2, H - 2);
    ctx.setLineDash([]);
    ctx.font = '700 11px system-ui'; ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(4,10,20,0.85)';
    const label = `drone ${d.id}'s home strip`;
    ctx.strokeText(label, ((c0 + c1) / 2) * CELL, H - 10); ctx.fillStyle = '#fff'; ctx.fillText(label, ((c0 + c1) / 2) * CELL, H - 10);
  }
}

function drawDrone(d, color) {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(d.x + 7, d.y + 10, 11, 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = MODE_COLOUR[d.commsMode]; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(d.x, d.y, SENSE, 0, Math.PI * 2); ctx.stroke();
  ctx.save();
  ctx.translate(d.x, d.y);
  ctx.rotate(d.angle + Math.PI / 4);
  ctx.strokeStyle = 'rgba(220,230,240,0.85)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-8, -8); ctx.lineTo(8, 8); ctx.moveTo(8, -8); ctx.lineTo(-8, 8); ctx.stroke();
  const spin = performance.now() / 60;
  for (const [x, y] of [[-8, -8], [8, -8], [8, 8], [-8, 8]]) {
    ctx.beginPath(); ctx.arc(x, y, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(200,215,230,0.25)'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(x + Math.cos(spin) * 4, y + Math.sin(spin) * 4); ctx.lineTo(x - Math.cos(spin) * 4, y - Math.sin(spin) * 4);
    ctx.strokeStyle = 'rgba(230,240,250,0.7)'; ctx.lineWidth = 1; ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(0, 0, 5.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  ctx.restore();
}

/** A pulsing yellow halo and tag, so a drone with no connection stands out from anywhere in the room. */
function drawNotConnected(d, now, tagged) {
  const pulse = calm.matches ? 0.5 : (Math.sin(now / 220) + 1) / 2;
  ctx.save();
  ctx.fillStyle = NOT_CONNECTED;
  ctx.globalAlpha = 0.28 + pulse * 0.17;
  ctx.beginPath(); ctx.arc(d.x, d.y, SENSE + 12, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = NOT_CONNECTED; ctx.lineWidth = 3.5;
  ctx.beginPath(); ctx.arc(d.x, d.y, SENSE + 7 + pulse * 5, 0, Math.PI * 2); ctx.stroke();
  if (!tagged) { ctx.restore(); return; }
  const text = `${d.id} NOT CONNECTED`;
  ctx.font = '800 11px system-ui'; ctx.textAlign = 'center';
  // Kept on the map, as phones fly the strips at its edge.
  const w = ctx.measureText(text).width + 12;
  const x = Math.max(w / 2 + 2, Math.min(W - w / 2 - 2, d.x)), y = Math.max(2, d.y - SENSE - 32);
  ctx.fillRect(x - w / 2, y, w, 17);
  ctx.fillStyle = '#17140a'; ctx.fillText(text, x, y + 12.5);
  ctx.restore();
}

function drawPerson(x, y, color, pose) {
  ctx.save(); ctx.translate(x, y);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(0, -7, 2.6, 0, Math.PI * 2); ctx.fill();          // head
  ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(0, 3);                       // body
  const wave = Math.sin(performance.now() / 180 + pose * 6) * 3;
  ctx.moveTo(0, -2); ctx.lineTo(-4, -6 - wave);                               // waving arm
  ctx.moveTo(0, -2); ctx.lineTo(4, 1);
  ctx.moveTo(0, 3); ctx.lineTo(-3, 8); ctx.moveTo(0, 3); ctx.lineTo(3, 8);     // legs
  ctx.stroke(); ctx.restore();
}

function draw2D() {
  const now = performance.now();
  ctx.drawImage(world.terrain.canvas, 0, 0);

  // fog of war: unsearched ground stays dark, it lifts where drones have looked
  fogCtx.clearRect(0, 0, COLS, ROWS);
  fogCtx.fillStyle = selected ? 'rgba(6,10,16,0.78)' : 'rgba(6,10,16,0.55)';
  const searched = selected ? (c, r) => R.isVisited(selected.state, c, r) : (c, r) => world.truthVisited.has(`${c},${r}`);
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (!searched(c, r)) fogCtx.fillRect(c, r, 1, 1);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(fog, 0, 0, W, H);
  if (selected) drawWhoSearched(selected);

  const live = world.drones.filter((d) => d.alive);
  const ranks = (d) => R.liveIds(d.state).indexOf(d.id);
  if (mode === 'search') {
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.setLineDash([2, 6]); ctx.lineWidth = 1;
    for (const d of world.drones) {
      const sec = R.homeSector(d.state, d.id, COLS);
      if (sec[0] === 0) continue;
      ctx.beginPath(); ctx.moveTo(sec[0] * CELL, 0); ctx.lineTo(sec[0] * CELL, H); ctx.stroke();
    }
    ctx.setLineDash([]);
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 2;
    ctx.beginPath();
    R.FORMATION_POLYLINE.forEach(([x, y], i) => { const px = 40 + x * (W - 80), py = 20 + y * (H - 60); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke(); ctx.setLineDash([]);
  }
  // blackout
  ctx.fillStyle = 'rgba(120,24,36,0.42)';
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (world.blackout[r * COLS + c]) ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
  // in range, but a ridge is in the way
  ctx.strokeStyle = 'rgba(229,83,75,0.4)'; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
  const inView = ([a, b]) => !selected || a === selected || b === selected;
  ctx.beginPath();
  for (const [a, b] of world.blocked.filter(inView)) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
  ctx.stroke(); ctx.setLineDash([]);
  // radio links
  // two passes: a dark casing keeps links readable on snow, a bright core on forest
  ctx.lineCap = 'round';
  for (const [style, width] of [['rgba(4,10,20,0.6)', 4], ['rgba(110,215,255,0.95)', 1.6]]) {
    ctx.strokeStyle = style; ctx.lineWidth = width;
    ctx.beginPath();
    for (const [a, b] of world.links.filter(inView)) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    ctx.stroke();
  }
  // base: helipad
  ctx.fillStyle = 'rgba(14,20,28,0.85)'; ctx.strokeStyle = '#f2f5f8'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(BASE.x, BASE.y - 4, 15, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#f2f5f8'; ctx.font = '800 14px system-ui'; ctx.textAlign = 'center'; ctx.fillText('H', BASE.x, BASE.y + 1);
  ctx.font = '600 10px system-ui'; ctx.fillText('BASE', BASE.x + 34, BASE.y);
  // missing people
  const baseS = world.base.state.survivors;
  for (const s of world.survivors) {
    const report = selected?.state.survivors[s.id];
    if (selected && !report) continue;   // this drone doesn't know this person exists
    if (!s.foundBy) { drawPerson(s.x, s.y, 'rgba(255,255,255,0.28)', s.pose); continue; }
    const ok = selected ? report.delivered : !!baseS[s.id];
    const col = ok ? '#3fb950' : '#ff7a59';
    const pulse = (now / 1200 + s.pose) % 1;
    ctx.strokeStyle = ok ? 'rgba(63,185,80,0.8)' : `rgba(255,122,89,${1 - pulse})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(s.x, s.y, ok ? 13 : 8 + pulse * 18, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(10,14,20,0.55)'; ctx.beginPath(); ctx.arc(s.x, s.y, 11, 0, Math.PI * 2); ctx.fill();
    drawPerson(s.x, s.y + 1, col, s.pose);
    ctx.font = '700 9px system-ui'; ctx.fillStyle = col;
    ctx.fillText(ok ? 'REPORTED' : 'SOS', s.x, s.y - 17);
    if (!selected) {
      const knowing = live.filter((d) => d.state.survivors[s.id]).length;
      ctx.font = '600 9px system-ui'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(4,10,20,0.85)';
      const t = `${knowing}/${live.length} drones know`;
      ctx.strokeText(t, s.x, s.y + 24); ctx.fillStyle = '#e6edf3'; ctx.fillText(t, s.x, s.y + 24);
    }
  }
  // wrecks: dimmed in a drone's view, as it can't see where the others are
  ctx.globalAlpha = selected ? 0.3 : 1;
  for (const d of world.drones.filter((d) => !d.alive)) {
    const age = Math.min(1, (now - d.diedAt) / 1500);
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(d.x, d.y + 2, 9, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = `rgba(229,83,75,${1 - age * 0.4})`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(d.x - 7, d.y - 7); ctx.lineTo(d.x + 7, d.y + 7); ctx.moveTo(d.x + 7, d.y - 7); ctx.lineTo(d.x - 7, d.y + 7); ctx.stroke();
    if (age < 1) { ctx.strokeStyle = `rgba(229,83,75,${1 - age})`; ctx.beginPath(); ctx.arc(d.x, d.y, 10 + age * 30, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = 'rgba(255,140,130,0.9)'; ctx.font = '10px system-ui'; ctx.fillText(d.id, d.x, d.y + 20);
  }
  // drones
  for (const d of live) {
    const n = R.liveIds(d.state).length;
    ctx.globalAlpha = selected && d !== selected ? 0.3 : 1;
    const waiting = d.phone && !link?.connected().includes(d.id);   // before launch, only the panel names them: they sit too close for tags
    if (unreachable(d) || waiting) drawNotConnected(d, now, !waiting);
    drawDrone(d, hue(ranks(d), n));
    if ((d.remote || d.phone) && !unreachable(d) && !waiting) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.arc(d.x, d.y, SENSE + 5, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#ffffff'; ctx.font = '700 10px system-ui'; ctx.fillText('PHONE', d.x, d.y - 33);
    }
    if (d === selected) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(d.x, d.y, SENSE + 5, 0, Math.PI * 2); ctx.stroke();
    }
    if (unreachable(d)) {
      const text = `${d.id}: last seen here`;
      ctx.fillStyle = 'rgba(240,245,250,0.9)'; ctx.font = '600 10px system-ui';
      const half = ctx.measureText(text).width / 2 + 2;
      ctx.fillText(text, Math.max(half, Math.min(W - half, d.x)), Math.min(H - 4, d.y + 30));
      continue;
    }
    if (R.isHub(d.state)) {
      ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(d.x, d.y, 16, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#f2c14e'; ctx.font = '700 10px system-ui'; ctx.fillText('HUB', d.x, d.y - 21);
    } else if (d.hubStatus === 'suspect') {
      ctx.strokeStyle = '#f29e4c'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(d.x, d.y, 14, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#f29e4c'; ctx.font = '700 11px system-ui'; ctx.fillText('?', d.x, d.y - 18);
    }
    ctx.fillStyle = 'rgba(240,245,250,0.9)'; ctx.font = '600 10px system-ui'; ctx.fillText(`${d.id}: ${d.state.hops === null ? 'no route' : `${d.state.hops} hops`}`, d.x, d.y + 22);
    if (d.muling) { ctx.fillStyle = '#ff7a59'; ctx.font = '600 10px system-ui'; ctx.fillText('carrying report', d.x, d.y + 33); }
  }
  ctx.globalAlpha = 1;
  // messages in flight, and rings where news lands
  msgs.draw(ctx, now, (n) => !selected || n === selected);
}

// ---------------------------------------------------------------- what each drone knows
const MODE_TEXT = { hub: 'has news of the hub', neighbours: 'hears others, but not the hub', alone: 'hears nobody' };

function updateDronePanel() {
  if (!selected) return;
  const d = selected, s = d.state;
  const found = world.survivors.filter((p) => p.foundBy).length;
  const reports = Object.entries(s.survivors);
  // Phone mode: this screen only knows what it has been told, and for a drone
  // it can't reach, all of this is from the last message.
  const truth = phoneMode ? 'this screen has' : 'really';
  const facts = [
    ...(unreachable(d) ? [['Connection', 'not connected. All of this is from its last message.']] : []),
    ['Doing', d.task],
    ['Radio', unreachable(d) ? 'unknown' : MODE_TEXT[d.commsMode]],
    ['Route to base', unreachable(d) ? 'unknown' : s.hops === null ? 'none' : `${s.hops} hops`],
    ['Map it knows', `${Math.round((R.visitedCount(s) / (COLS * ROWS)) * 100)}% searched (${truth} ${Math.round(world.coverage() * 100)}%)`],
    ['Thinks alive', `${R.liveIds(s).length} drones (${phoneMode ? 'launched' : 'really'} ${world.drones.filter((x) => x.alive).length})`],
    ['Thinks the hub is', `drone ${s.hub.id}`],
    ['People it knows of', `${reports.length} (${truth} ${found} found)`],
  ];
  $('droneTitle').textContent = `Drone ${d.id}`;
  $('droneFacts').innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  // where its map came from
  const total = COLS * ROWS, from = new Map();
  let ownN = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const i = r * COLS + c;
    if (!R.isVisited(s, c, r)) continue;
    if (d.own[i]) ownN++; else if (world.searchedBy[i]) from.set(world.searchedBy[i], (from.get(world.searchedBy[i]) || 0) + 1);
  }
  const pct = (n) => `${Math.round((n / total) * 100)}%`;
  const sw = (id, solid) => { const [r, g, b] = droneRgb(id); return `<i class="sw" style="background:rgba(${r | 0},${g | 0},${b | 0},${solid ? 1 : 0.45})"></i>`; };
  const others = [...from.entries()].sort((a, b) => b[1] - a[1]);
  $('droneShare').innerHTML = `<div>${sw(d.id, true)}Searched itself <b>${pct(ownN)}</b> of the map</div>` +
    (others.length ? `<div class="k">Told by other drones: <b>${pct(others.reduce((n, [, v]) => n + v, 0))}</b></div>` +
      others.map(([id, n]) => { const x = world.drones.find((q) => q.id === id); return `<div>${sw(id, false)}from drone ${id}${x && !x.alive ? ' (down)' : ''} <b>${pct(n)}</b></div>`; }).join('')
      : '<div class="k">Nothing from other drones yet</div>');
  $('droneReports').innerHTML = reports.map(([id, r]) => `<li>${id}: found by drone ${r.foundBy}, ${r.delivered ? 'it knows base has this' : 'not known to be at base'}</li>`).join('');
}

function updateGrid() {
  // One row per found person: which drones know about them, and whether base does.
  const live = world.drones.filter((d) => d.alive);
  const css = (id) => { const [r, g, b] = droneRgb(id); return `rgb(${r | 0},${g | 0},${b | 0})`; };
  const found = world.survivors.filter((p) => p.foundBy);
  const waiting = world.survivors.filter((p) => !p.foundBy).map((p) => p.id.slice(1));
  const cls = (d) => [d === selected && 'on', !d.alive && 'down'].filter(Boolean).join(' ');
  const head = `<tr><th></th><th scope="col" class="basecol">Base</th>${world.drones.map((d) =>
    `<th scope="col" data-id="${d.id}" class="${cls(d)}" title="Drone ${d.id}${d.alive ? '' : ' (down)'}"><span style="border-color:${css(d.id)}">${d.id}</span></th>`).join('')}<th></th></tr>`;
  const rows = found.map((p) => {
    const atBase = !!world.base.state.survivors[p.id];
    const knowing = live.filter((d) => d.state.survivors[p.id]).length;
    return `<tr><th scope="row">Person ${p.id.slice(1)}</th>` +
      `<td class="basecol ${atBase ? 'yes' : ''}" title="${atBase ? 'Base has the report' : 'Base hasn\'t heard yet'}">${atBase ? '✓' : ''}</td>` +
      world.drones.map((d) => {
        const knows = d.alive && d.state.survivors[p.id];
        return `<td data-id="${d.id}" class="${cls(d)}" ${knows ? `style="background:${css(d.id)}"` : ''} title="Drone ${d.id} ${knows ? 'knows' : 'doesn\'t know'}${p.foundBy === d.id ? ', found this person' : ''}">${p.foundBy === d.id ? '★' : ''}</td>`;
      }).join('') +
      `<td class="count">${knowing}/${live.length}</td></tr>`;
  }).join('');
  $('knowGrid').innerHTML = head + (rows || `<tr><td class="empty" colspan="${world.drones.length + 3}">No one found yet</td></tr>`);
  $('agreement').textContent = waiting.length ? `Not found yet: ${waiting.map((n) => `person ${n}`).join(', ')}` : 'Everyone has been found';
}

// ---------------------------------------------------------------- stats
function updateStats() {
  updateDronePanel();
  updateGrid();
  const live = world.drones.filter((d) => d.alive);
  $('cov').textContent = `${Math.round(world.coverage() * 100)}%`;
  $('covBase').textContent = `${Math.round(world.baseCoverage() * 100)}%`;
  const found = world.survivors.filter((s) => s.foundBy);
  $('found').textContent = `${found.length}/${world.survivors.length}`;
  $('delivered').textContent = `${Object.keys(world.base.state.survivors).length}/${found.length}`;
  // A report is lost if no live drone and not the base has it any more.
  const lost = found.filter((s) => !world.holders(s).length).length;
  $('lost').textContent = lost;
  $('lostBox').classList.toggle('bad', lost > 0);
  $('live').textContent = `${live.length} / ${world.drones.length}`;
  for (const m of ['hub', 'neighbours', 'alone']) $(`mode-${m}`).textContent = live.filter((d) => d.commsMode === m).length;
  const hub = world.currentHub();
  const hubDrone = world.drones.find((d) => d.id === hub);
  const epoch = hubDrone ? hubDrone.state.hub.epoch : live[0]?.state.hub.epoch;
  const waiting = live.filter((d) => d.hubStatus === 'suspect' && !R.isHub(d.state)).length;
  $('hubline').innerHTML = !live.length ? '<span class="suspect">No drones left</span>' : hub === null ? '<span class="suspect">This screen is in contact with no drone.</span>' : hubDrone && hubDrone.alive
    ? `Hub is <b>drone ${hub}</b>, epoch ${epoch}.` + (waiting ? ` <span class="suspect">${waiting} drones can't hear it.</span>` : '')
    : `<span class="suspect">Hub ${hub} is silent and ${waiting} of ${live.length} drones have noticed. The search goes on; a drone that can hear others takes over after about ${Math.round(R.DEFAULTS.hubTimeout * SECONDS_PER_TICK)} s.</span>`;
}

// ---------------------------------------------------------------- graph
const SERIES = [
  { key: 'run', label: 'Searched, this run', colour: '#1f9e94', dash: [] },
  { key: 'base', label: 'Known at base, this run', colour: '#c47a12', dash: [] },
  { key: 'on', label: 'Searched, comms on, nothing failed', colour: '#5b92e0', dash: [6, 4] },
  { key: 'off', label: 'Searched, no radio from launch', colour: '#d45fa0', dash: [2, 4] },
].filter((s) => !phoneMode || s.key === 'run' || s.key === 'base');
const graph = $('graph'), gctx = graph.getContext('2d');
const PAD = { l: 34, r: 10, t: 16, b: 20 };
let hoverX = null;

$('graphLegend').innerHTML = SERIES.map((s) => `<li><svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke="${s.colour}" stroke-width="2" stroke-dasharray="${s.dash.join(' ')}"/></svg><span>${s.label}</span><b id="gv-${s.key}">0%</b></li>`).join('');

function sample() {
  const point = {
    tick: world.tick,
    run: world.coverage() * 100,
    base: world.baseCoverage() * 100,
    on: reference && reference.on.coverage() * 100,
    off: reference && reference.off.coverage() * 100,
  };
  history.push(point);
  for (const s of SERIES) $(`gv-${s.key}`).textContent = `${Math.round(point[s.key])}%`;
}

function drawGraph() {
  const dpr = window.devicePixelRatio || 1;
  const cw = graph.clientWidth, ch = graph.clientHeight;
  if (graph.width !== cw * dpr || graph.height !== ch * dpr) { graph.width = cw * dpr; graph.height = ch * dpr; }
  gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gctx.clearRect(0, 0, cw, ch);
  const iw = cw - PAD.l - PAD.r, ih = ch - PAD.t - PAD.b;
  const tMax = Math.max(500, world.tick);
  const X = (t) => PAD.l + (t / tMax) * iw, Y = (v) => PAD.t + (1 - v / 100) * ih;

  gctx.font = '12px Barlow, system-ui'; gctx.fillStyle = '#a3abad'; gctx.strokeStyle = '#424b50'; gctx.lineWidth = 1;
  gctx.textAlign = 'right'; gctx.textBaseline = 'middle';
  for (const v of [0, 50, 100]) {
    gctx.beginPath(); gctx.moveTo(PAD.l, Y(v)); gctx.lineTo(cw - PAD.r, Y(v)); gctx.stroke();
    gctx.fillText(`${v}%`, PAD.l - 6, Y(v));
  }
  gctx.textAlign = 'center'; gctx.textBaseline = 'top';
  const stepS = tMax * SECONDS_PER_TICK > 120 ? 40 : 20;
  for (let s = 0; s <= tMax * SECONDS_PER_TICK; s += stepS) gctx.fillText(`${s}s`, X(s / SECONDS_PER_TICK), ch - PAD.b + 5);

  gctx.textAlign = 'left'; gctx.textBaseline = 'alphabetic';
  let lastLabelEnd = -Infinity;
  for (const m of marks) {
    const x = X(m.tick);
    gctx.strokeStyle = '#5a646a'; gctx.setLineDash([2, 3]);
    gctx.beginPath(); gctx.moveTo(x, PAD.t); gctx.lineTo(x, PAD.t + ih); gctx.stroke();
    gctx.setLineDash([]);
    if (x < lastLabelEnd) continue;  // keep labels from colliding
    gctx.fillStyle = '#a3abad'; gctx.fillText(m.label, x + 3, PAD.t - 4);
    lastLabelEnd = x + gctx.measureText(m.label).width + 10;

  }

  gctx.lineJoin = 'round'; gctx.lineCap = 'round'; gctx.lineWidth = 2;
  for (const s of [...SERIES].reverse()) {
    gctx.strokeStyle = s.colour; gctx.setLineDash(s.dash);
    gctx.beginPath();
    history.forEach((p, i) => (i ? gctx.lineTo(X(p.tick), Y(p[s.key])) : gctx.moveTo(X(p.tick), Y(p[s.key]))));
    gctx.stroke();
  }
  gctx.setLineDash([]);

  const tip = $('graphTip');
  if (hoverX === null || !history.length) { tip.hidden = true; return; }
  const t = ((hoverX - PAD.l) / iw) * tMax;
  const p = history.reduce((a, b) => (Math.abs(b.tick - t) < Math.abs(a.tick - t) ? b : a));
  gctx.strokeStyle = '#a3abad'; gctx.beginPath(); gctx.moveTo(X(p.tick), PAD.t); gctx.lineTo(X(p.tick), PAD.t + ih); gctx.stroke();
  for (const s of SERIES) {
    gctx.fillStyle = s.colour; gctx.strokeStyle = '#22282c'; gctx.lineWidth = 2;
    gctx.beginPath(); gctx.arc(X(p.tick), Y(p[s.key]), 4, 0, Math.PI * 2); gctx.fill(); gctx.stroke();
  }
  tip.hidden = false;
  tip.innerHTML = `<div class="k">${Math.round(p.tick * SECONDS_PER_TICK)}s</div>` + SERIES.map((s) => `<div>${s.label}: <b>${Math.round(p[s.key])}%</b></div>`).join('');
  const left = X(p.tick) + 12;
  tip.style.left = `${left + tip.offsetWidth > cw ? Math.max(0, X(p.tick) - tip.offsetWidth - 12) : left}px`;
}
graph.addEventListener('pointermove', (e) => { hoverX = e.clientX - graph.getBoundingClientRect().left; });
graph.addEventListener('pointerleave', () => { hoverX = null; graphDirty = true; });

// ---------------------------------------------------------------- NCA panel
// The neural cellular automaton runs on the drones: each drone computes the cells nearest
// its place in the V, and gets the edge cells it needs from the drones it can
// reach by radio. A drone that can't reach a neighbour keeps using the last
// copy it received (stale).
let nca = null;
let ncaOwners = null, ncaKey = '', ncaGroup = new Map(), ncaLast = { fresh: 0, stale: 0 };
let ncaActivity = null;           // how much each cell changed in the last step
// Safety net: if the shape hasn't recovered ~7 s after damage, regrow it
// from one cell (this is how Google's growing NCA starts too).
const NCA_GIVE_UP = 420, NCA_OK = 0.93;
let ncaWatch = null;
function damageNca(gx, gy) {
  nca.erase(gx, gy, 5);
  ncaWatch = 0;
}
function watchNca() {
  if (ncaWatch === null) return;
  ncaWatch++;
  if (ncaWatch % 30 === 0 && nca.similarity() >= NCA_OK) { ncaWatch = null; return; }
  if (ncaWatch > NCA_GIVE_UP) {
    nca.reset(); ncaWatch = null;
    log('Cellular automaton: the damage reached the seed cell, so it regrows from one cell');
  }
}

/** Patches: each live drone owns the cells nearest its formation slot. */
function ncaPatches() {
  const live = world.drones.filter((d) => d.alive).map((d) => d.id).sort((a, b) => a - b);
  const key = live.join(',');
  if (key !== ncaKey || !ncaOwners) {
    ncaKey = key;
    const slots = R.formationSlots(live.length, R.FORMATION_POLYLINE);
    ncaPatches.slots = live.map((id, i) => ({ id, gx: slots[i][0] * nca.N, gy: slots[i][1] * nca.N }));
    ncaOwners = live.length ? nca.assignOwners(ncaPatches.slots) : null;
  }
  // who can reach whom right now, relays (and base) included
  const parent = new Map();
  const find = (n) => { while (parent.get(n) !== n) n = parent.get(n); return n; };
  for (const n of [world.base, ...world.drones]) parent.set(n, n);
  for (const [a, b] of world.links) parent.set(find(a), find(b));
  ncaGroup = new Map(world.drones.filter((d) => d.alive).map((d) => [d.id, find(d)]));
}

function stepNca() {
  ncaPatches();
  if (!ncaOwners) return;
  const C = nca.C;
  ncaLast = nca.stepSwarm(ncaOwners, ncaGroup);
  const now = nca.x, was = nca.next;
  if (!ncaActivity) ncaActivity = new Float32Array(nca.N * nca.N);
  for (let cell = 0; cell < ncaActivity.length; cell++) {
    let d = 0;
    for (let k = 0; k < 4; k++) d += Math.abs(now[cell * C + k] - was[cell * C + k]);
    ncaActivity[cell] = ncaActivity[cell] * 0.8 + d;
  }
}

function drawNca() {
  const { N, C } = nca;
  const px = ncaCanvas.width / N;
  const view = selected && nca.views?.get(selected.id);
  nca.draw(ncaCtx, undefined, view || nca.x);
  if (!ncaOwners) return;
  const src = view || nca.x;
  const huesById = new Map(world.drones.filter((d) => d.alive).map((d) => {
    const ids = R.liveIds(d.state);
    return [d.id, hue(ids.indexOf(d.id), ids.length)];
  }));
  const inShape = (cell) => src[cell * C + 3] > 0.1;
  // territory tint
  ncaCtx.globalAlpha = 0.13;
  for (let cell = 0; cell < N * N; cell++) {
    ncaCtx.fillStyle = huesById.get(ncaOwners[cell]) || '#888';
    ncaCtx.fillRect((cell % N) * px, Math.floor(cell / N) * px, px, px);
  }
  ncaCtx.globalAlpha = 1;
  // a selected drone's copy: cells it can't currently hear are stale
  if (view) {
    ncaCtx.fillStyle = 'rgba(229,83,75,0.28)';
    for (let cell = 0; cell < N * N; cell++) {
      const o = ncaOwners[cell];
      if (o !== selected.id && ncaGroup.get(o) !== ncaGroup.get(selected.id) && inShape(cell)) ncaCtx.fillRect((cell % N) * px, Math.floor(cell / N) * px, px, px);
    }
  }
  // patch borders inside the shape: the cells two drones swap by radio
  const sees = (a, b) => ncaGroup.get(a) === ncaGroup.get(b);
  ncaCtx.lineCap = 'round';
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const cell = y * N + x;
    for (const [nb, x0, y0, x1, y1] of [[cell + 1, x + 1, y, x + 1, y + 1], [cell + N, x, y + 1, x + 1, y + 1]]) {
      if ((nb === cell + 1 && x + 1 >= N) || nb >= N * N) continue;
      if (ncaOwners[nb] === ncaOwners[cell] || !(inShape(cell) || inShape(nb))) continue;
      if (sees(ncaOwners[cell], ncaOwners[nb])) {
        const busy = Math.min(1, (ncaActivity?.[cell] + ncaActivity?.[nb]) * 4 || 0);
        ncaCtx.strokeStyle = `rgba(255,255,255,${0.35 + 0.65 * busy})`; ncaCtx.lineWidth = 1 + 2 * busy; ncaCtx.setLineDash([]);
      } else {
        ncaCtx.strokeStyle = 'rgba(255,90,80,0.95)'; ncaCtx.lineWidth = 2; ncaCtx.setLineDash([3, 3]);
      }
      ncaCtx.beginPath(); ncaCtx.moveTo(x0 * px, y0 * px); ncaCtx.lineTo(x1 * px, y1 * px); ncaCtx.stroke();
    }
  }
  ncaCtx.setLineDash([]);
  // badge: which drone computes which patch
  ncaCtx.textAlign = 'center'; ncaCtx.textBaseline = 'middle'; ncaCtx.font = '700 10px system-ui';
  for (const s of ncaPatches.slots || []) {
    const cx = s.gx * px, cy = s.gy * px + 14;
    ncaCtx.beginPath(); ncaCtx.arc(cx, cy, 8, 0, Math.PI * 2);
    ncaCtx.fillStyle = 'rgba(11,15,20,0.85)'; ncaCtx.fill();
    ncaCtx.lineWidth = selected?.id === s.id ? 3 : 2; ncaCtx.strokeStyle = selected?.id === s.id ? '#fff' : huesById.get(s.id); ncaCtx.stroke();
    ncaCtx.fillStyle = '#e6edf3'; ncaCtx.fillText(s.id, cx, cy + 0.5);
  }
  ncaCtx.textBaseline = 'alphabetic';
}

const ncaCanvas = $('nca'), ncaCtx = ncaCanvas.getContext('2d');
fetch('../recovery/models/formation-nca.json')
  .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then((model) => { nca = new NCA(model); nca.reset(); })
  .catch(() => { $('ncaSim').textContent = 'No trained model found. Run nca/train_nca.py to make one.'; });
ncaCanvas.addEventListener('click', (e) => {
  if (!nca) return;
  const r = ncaCanvas.getBoundingClientRect();
  damageNca(((e.clientX - r.left) / r.width) * nca.N, ((e.clientY - r.top) / r.height) * nca.N);
});
$('ncaReset').onclick = () => { if (nca) nca.reset(); ncaWatch = null; };

// ---------------------------------------------------------------- 3D view
// The same run drawn in 3D (../demo3d/scene.js, Three.js). Switching views
// only changes what's drawn: the simulation, panels and phones carry on.
// The 3D code loads the first time it's needed, so 2D-only use stays light.
let view = null, view3d = false, loading3d = null;
const GROUND_MS = 100;            // 3D ground markings: at most 10 redraws a second
let groundAt = -Infinity, treeKey = '';

function terrainFor3d() {
  if (!view) return;
  view.clear();
  treeKey = '';
  view.setTerrain(world.terrain, [...world.survivors.map((p) => ({ x: p.x, y: p.y })), { x: BASE.x, y: BASE.y, r: 52 }]);
}

async function setView(three) {
  if (three && !view) {
    $('view3d').hidden = false;   // visible first, so the scene gets a size
    loading3d ??= import('../demo3d/scene.js').then(({ createScene3D }) => {
      view = createScene3D($('view3d'), { W, H, BASE });
      hook3dInput(view.dom);
      view.controls.enabled = !painting;
      terrainFor3d();
    });
    try { await loading3d; } catch (err) {
      log(`3D view failed to load: ${err.message}`);
      $('view3d').hidden = true;
      loading3d = null;
      return;
    }
  }
  view3d = three;
  canvas.hidden = three;
  $('view3d').hidden = !three;
  $('resetView').hidden = !three;
  $('viewBtn').textContent = three ? '2D view' : '3D view';
  groundAt = -Infinity; treeKey = '';
  try { localStorage.setItem('swarm.view', three ? '3d' : '2d'); } catch {}
}
$('viewBtn').onclick = () => setView(!view3d);
$('resetView').onclick = () => view?.resetView();

function draw() {
  if (!view3d || !view) { draw2D(); return; }
  const now = performance.now();
  if (now - groundAt >= GROUND_MS) {
    groundAt = now;
    drawGround3D(view.groundCanvas.getContext('2d'), now);
    view.groundChanged();
    // trees go dark with the ground under them: same fog, same view. Only
    // recoloured when what's searched (or whose view it is) has changed.
    const key = selected ? `${selected.id}:${R.visitedCount(selected.state)}` : `all:${world.truthVisited.size}`;
    if (key !== treeKey) {
      treeKey = key;
      const dark = selected ? 0.22 : 0.45;
      const lit = selected ? (c, r) => R.isVisited(selected.state, c, r) : (c, r) => world.truthVisited.has(`${c},${r}`);
      view.shadeTrees((x, y) => (lit(Math.floor(x / CELL), Math.floor(y / CELL)) ? 1 : dark));
    }
  }
  view.update(world, { selected, msgs, now, colour: droneRgb });
  view.render();
}

/** Ground markings for the 3D view, drawn flat and draped over the terrain. */
function drawGround3D(ctx, now) {
  ctx.drawImage(world.terrain.canvas, 0, 0);
  fogCtx.clearRect(0, 0, COLS, ROWS);
  fogCtx.fillStyle = selected ? 'rgba(6,10,16,0.78)' : 'rgba(6,10,16,0.55)';
  const searched = selected ? (c, r) => R.isVisited(selected.state, c, r) : (c, r) => world.truthVisited.has(`${c},${r}`);
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (!searched(c, r)) fogCtx.fillRect(c, r, 1, 1);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(fog, 0, 0, W, H);
  if (selected) drawWhoSearched(selected, ctx);
  if (mode === 'search') {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.setLineDash([3, 6]); ctx.lineWidth = 1.5;
    for (const d of world.drones) {
      const sec = R.homeSector(d.state, d.id, COLS);
      if (sec[0] === 0) continue;
      ctx.beginPath(); ctx.moveTo(sec[0] * CELL, 0); ctx.lineTo(sec[0] * CELL, H); ctx.stroke();
    }
    ctx.setLineDash([]);
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 2;
    ctx.beginPath();
    R.FORMATION_POLYLINE.forEach(([x, y], i) => { const px = 40 + x * (W - 80), py = 20 + y * (H - 60); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.fillStyle = 'rgba(150,24,40,0.5)';
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (world.blackout[r * COLS + c]) ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
  ctx.fillStyle = 'rgba(14,20,28,0.85)'; ctx.strokeStyle = '#f2f5f8'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(BASE.x, BASE.y - 4, 15, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#f2f5f8'; ctx.font = '800 14px system-ui'; ctx.textAlign = 'center'; ctx.fillText('H', BASE.x, BASE.y + 1);
  const baseS = world.base.state.survivors;
  for (const s of world.survivors) {
    const report = selected?.state.survivors[s.id];
    if (!s.foundBy || (selected && !report)) continue;
    const ok = selected ? report.delivered : !!baseS[s.id];
    const pulse = (now / 1200 + s.pose) % 1;
    ctx.strokeStyle = ok ? 'rgba(63,185,80,0.9)' : `rgba(255,122,89,${1 - pulse})`; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(s.x, s.y, ok ? 13 : 8 + pulse * 18, 0, Math.PI * 2); ctx.stroke();
  }
  // failed drones: a red cross where they came down (live drones' footprints are drawn in 3D)
  ctx.strokeStyle = 'rgba(229,83,75,0.9)'; ctx.lineWidth = 3;
  for (const d of world.drones) {
    if (d.alive) continue;
    ctx.globalAlpha = selected ? 0.3 : 1;
    ctx.beginPath(); ctx.moveTo(d.x - 9, d.y - 9); ctx.lineTo(d.x + 9, d.y + 9); ctx.moveTo(d.x + 9, d.y - 9); ctx.lineTo(d.x - 9, d.y + 9); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Clicks and blackout painting on the 3D view; a drag without paint turns the camera. */
function hook3dInput(el) {
  let downAt = null;
  el.addEventListener('pointerdown', (e) => {
    downAt = { x: e.clientX, y: e.clientY };
    if (!painting) return;
    const p = view.pick(e.clientX, e.clientY).point;
    if (!p) return;
    brushAt = p;
    el.setPointerCapture(e.pointerId);
    world.paintBlackout(p.x, p.y, BRUSH);
    marks.push({ tick: world.tick, label: 'blackout' });
  });
  el.addEventListener('pointermove', (e) => {
    if (!brushAt) return;
    const p = view.pick(e.clientX, e.clientY).point;
    if (p) brushTo(p);
  });
  el.addEventListener('pointerup', (e) => {
    const click = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5;
    downAt = null;
    if (brushAt) { brushAt = null; return; }
    if (painting || !click) return;
    const { droneId, point } = view.pick(e.clientX, e.clientY);
    let best = droneId !== null ? world.drones.find((d) => d.id === droneId) : null;
    if (!best && point) {
      let bd = 22;
      for (const d of world.drones) {
        const dd = Math.hypot(d.x - point.x, d.y - point.y);
        if (d.alive && dd < bd) { best = d; bd = dd; }
      }
    }
    select(best);
  });
}

// ---------------------------------------------------------------- loop
// Speed slider: runs more or fewer fixed sim steps per second, so a run
// plays out the same at any speed, just faster or slower.
// In phone mode the rate goes to the helper, which shares it with every phone.
let simSpeed = DEFAULT_RATE;
function showSpeed(rate) {
  $('speed').value = RATES.indexOf(rate);
  $('speedV').textContent = `${rate}×`;
  $('speed').setAttribute('aria-valuetext', `${rate} times`);
}
showSpeed(simSpeed);
$('speed').oninput = (e) => {
  simSpeed = RATES[+e.target.value];
  showSpeed(simSpeed);
  if (phoneMode) link?.setSpeed(simSpeed).catch(() => log('Couldn\'t change the speed: the phone helper isn\'t answering'));
};
// Work budget. The simulation keeps to real time; everything drawn runs only
// as often as it needs to, and not at all while it's off screen.
const RENDER_MS = 1000 / 30;     // map frame rate cap
const PANEL_MS = 200;            // stats, people table, drone panel: 5 times a second
const NCA_RENDERS_PER_STEP = 2;  // NCA steps ~15 times a second
const onScreenNow = new Map();
const io = new IntersectionObserver((es) => { for (const e of es) onScreenNow.set(e.target.id, e.isIntersecting); });
for (const id of ['nca', 'graph']) io.observe($(id));
const onScreen = (id) => onScreenNow.get(id) !== false;
let carried = null;              // phone mode: what nodes knew at the end of the last tick
let frame = 0, lastFrame = 0, owed = 0, lastRender = -Infinity, lastPanel = -Infinity, graphDirty = true, panelDirty = true;
function stepOnce(refsDone) {
  const before = world.tick;
  const radioTick = world.steps % TICK_STEPS === 0;
  const nodes = radioTick && [world.base, ...world.drones.filter((d) => d.alive)];
  // A phone's news arrives between ticks, so phone mode compares with the last tick's end.
  const pre = radioTick && (carried ?? msgs.before(nodes));
  world.step();
  if (!refsDone) { reference.on.step(); reference.off.step(); }
  if (world.tick !== before) {
    msgs.after(pre, nodes.filter((n) => n === world.base || n.alive), world.links, performance.now());
    panelDirty = true;
    if (world.tick % SAMPLE_TICKS === 0) { sample(); graphDirty = true; }
    link?.sendTick();
    if (phoneMode) carried = msgs.before([world.base, ...world.drones.filter((d) => d.alive)]);
  }
}
/** Phone mode: every device works out the tick from the launch time, so they stay together. */
function catchUp() {
  const target = link.targetSteps();
  for (let n = 0; target !== null && world.steps < target && n < MAX_STEPS_PER_FRAME; n++) stepOnce(true);
}
function loop(t) {
  requestAnimationFrame(loop);
  if (phoneMode) {
    catchUp();
  } else {
    owed += Math.min(0.1, (t - (lastFrame || t)) / 1000) * simSpeed; lastFrame = t;
    // the comparison runs only feed the graph; once they've searched everything they stop
    const refsDone = reference.on.coverage() === 1 && reference.off.coverage() === 1;
    for (; owed >= DT; owed -= DT) stepOnce(refsDone);
  }
  if (panelDirty && t - lastPanel >= PANEL_MS) { lastPanel = t; panelDirty = false; updateStats(); }
  if (t - lastRender < RENDER_MS) return;
  lastRender = t;
  draw();
  if (onScreen('graph') && (graphDirty || hoverX !== null)) { graphDirty = false; drawGraph(); }
  if (nca) {
    // keep the network running so damage still heals, but only draw it when it's visible
    if (++frame % NCA_RENDERS_PER_STEP === 0) {
      stepNca(); watchNca();
      if (onScreen('nca')) drawNca();
    }
    if (frame % 8 === 0) {
      const n = ncaPatches.slots?.length || 0;
      $('ncaSim').innerHTML = `Shape ${Math.round(nca.similarity() * 100)}% restored. ${n} drones computing, ${ncaLast.fresh} edges shared` +
        (ncaLast.stale ? `, <span style="color:#ff5a50">${ncaLast.stale} stale</span>.` : '.');
      $('ncaTitle').textContent = selected ? `Drone ${selected.id}'s copy of the network` : 'Neural cellular automaton on the drones';
    }
  }
}
// ---------------------------------------------------------------- phone mode
function updatePhones(mission, connected) {
  $('phonesCard').hidden = false;
  const url = mission?.joinUrl;
  if (url && $('joinUrl').textContent !== url) {
    $('joinUrl').textContent = url; $('joinUrl').href = url;
    $('qr').src = '/qr.svg';
  }
  const claimed = mission?.drones ?? [];
  const launched = mission?.launchAt != null;
  for (const d of world.drones) d.phone = !launched && claimed.includes(d.id);
  $('joinBox').hidden = launched;      // the swarm is closed once it has launched
  $('phoneList').innerHTML = claimed.length
    ? claimed.map((d) => (connected.includes(d) ? `Drone ${d}: connected` : `<span class="not-connected">Drone ${d}: not connected</span>`)).join('<br>')
    : 'No phones have joined yet';
  $('launch').hidden = launched;
  $('launch').disabled = !claimed.length;
  $('launch').textContent = claimed.length ? `Launch with ${claimed.length} ${claimed.length === 1 ? 'phone' : 'phones'}` : 'Waiting for phones';
}

/** This page was reloaded or reopened during a run: it replays to the present and rejoins. */
function resumePhones(mission) {
  terrainSeed = mission.seed;
  $('drones').value = mission.fleet;
  if (RATES.includes(mission.rate)) { simSpeed = mission.rate; showSpeed(simSpeed); }
  reset();
  link.attach(world);
  log('<b>This screen rejoined the flying run.</b> It replays the laptop drones, then the phones catch it up.');
}

function stoppedPhones(why) {
  $('phonesCard').hidden = false;
  $('joinBox').hidden = true;
  $('launch').hidden = why !== 'busy';
  $('launch').disabled = false;
  $('launch').textContent = 'Start a new run here';
  $('launch').onclick = restartPhones;
  $('phoneList').textContent = {
    busy: 'Another big screen is running this mission.',
    replaced: 'Another big screen took over. Close this tab.',
    failed: 'Start this page with npm run phones, and open it at localhost on the laptop.',
  }[why];
}

if (phoneMode) {
  const restart = params.has('restart');
  if (restart) {
    params.delete('restart');   // so a plain reload after this rejoins the run. `window`: this file has its own `history`
    window.history.replaceState(null, '', `${location.pathname}?${params}`);
  }
  document.body.classList.add('phones');
  link = createPhoneLink({ seed: terrainSeed, fleet: +$('drones').value, restart, onUpdate: updatePhones, onStopped: stoppedPhones, onResume: resumePhones });
  $('launch').onclick = async () => {
    $('launch').disabled = true;
    // Anything the presenter set up before launch carries over.
    const blackout = world.blackout.slice(), { radio } = world;
    try {
      await link.launch();
    } catch (e) {
      if (e.message !== 'replaced') $('phoneList').textContent = 'The helper refused the launch. Reload this page.';
      return;
    }
    reset();
    world.blackout.set(blackout);
    world.radio = radio;
    showRadioButton();
    link.attach(world);
    const n = link.claimed().length;
    log(`Launching with ${n} ${n === 1 ? 'phone' : 'phones'}`);
  };
  setInterval(catchUp, PHONE_STEP_MS);
}
reset();
requestAnimationFrame(loop);
{
  // open in 3D with ?view=3d, or in whichever view was used last
  let start = params.get('view');
  try { start ??= localStorage.getItem('swarm.view'); } catch {}
  if (start === '3d') setView(true);
}
