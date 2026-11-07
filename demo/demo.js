// Demo: fail any drone (including the hub), cut the radio, and the swarm keeps
// going. sim.js is the simulation; this file draws it and handles input.
import * as R from '../recovery/swarm-recovery.js';
import { NCA } from '../recovery/nca-runtime.js';
import { makeTerrain } from './terrain.js';
import { W, H, CELL, COLS, ROWS, N_SURVIVORS, SENSE, BASE, DT, createSim } from './sim.js';

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const BRUSH = 60;               // blackout brush radius, px
const SAMPLE_TICKS = 4;         // ticks between graph samples
const SECONDS_PER_TICK = 0.16;
const NCA_FRAMES_PER_STEP = 4;  // slow enough to watch the gecko repair
const MODE_COLOUR = { hub: '#2bb3a8', neighbours: '#f29e4c', alone: '#e5534b' };
const $ = (id) => document.getElementById(id);

// `world` is the run on screen. The two reference runs share its terrain and
// survivors and play alongside it, unseen, for the graph to compare against.
let world, reference, logged, history, marks;
let mode = 'search';
let terrainSeed = 2026;
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
  $('introDrones').textContent = drones;
  $('seedV').textContent = terrainSeed;
  world = createSim({ seed: terrainSeed, terrain, drones, range, los, onLog: log });
  world.mode = mode;
  reference = {
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
  log(`Swarm launched over terrain #${terrainSeed}: ${drones} drones, drone 1 is the hub, ${N_SURVIVORS} missing people`);
  if (nca) nca.reset();
  ncaWatch = null;
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
  $('hint').textContent = on ? 'Drag to paint a radio blackout' : 'Click a drone to see what it knows';
}

function select(d) {
  selected = d;
  $('droneCard').hidden = !d;
  $('viewBanner').hidden = !d;
  if (d) $('viewBanner').textContent = `Drone ${d.id}'s view: only what it has seen or been told`;
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
  const id = Number(e.target.closest('tr')?.dataset.id);
  const d = world.drones.find((x) => x.id === id && x.alive);
  if (d) select(d === selected ? null : d);
});
$('failHub').onclick = () => {
  const hub = world.drones.find((d) => d.id === world.currentHub());
  if (hub?.alive) fail(hub); else log('The hub is already down — no drone has taken over yet');
};
$('failRandom').onclick = () => { const live = world.drones.filter((d) => d.alive); fail(live[Math.floor(Math.random() * live.length)]); };
$('paint').onclick = () => setPainting(!painting);
$('clearBlackout').onclick = () => { world.clearBlackout(); marks.push({ tick: world.tick, label: 'blackout lifted' }); };
$('cutRadio').onclick = () => {
  world.radio = !world.radio;
  $('cutRadio').classList.toggle('on', !world.radio);
  $('cutRadio').textContent = world.radio ? 'Cut all radio' : 'Restore radio';
  marks.push({ tick: world.tick, label: world.radio ? 'radio back' : 'radio cut' });
};
$('reset').onclick = reset;
$('drones').oninput = reset;
$('newTerrain').onclick = () => { terrainSeed = Math.floor(Math.random() * 1e6); reset(); };
$('range').oninput = (e) => { range = +e.target.value; $('rangeV').textContent = range; world.range = range; reference.on.range = range; };
function setLos(on) { world.los = on; reference.on.los = on; }
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
const hue = (rank, n) => `hsl(${(rank / Math.max(1, n)) * 300 + 170}, 65%, 58%)`;

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

function draw() {
  const now = performance.now();
  ctx.drawImage(world.terrain.canvas, 0, 0);

  // fog of war: unsearched ground stays dark, it lifts where drones have looked
  fogCtx.clearRect(0, 0, COLS, ROWS);
  fogCtx.fillStyle = selected ? 'rgba(6,10,16,0.78)' : 'rgba(6,10,16,0.55)';
  const searched = selected ? (c, r) => R.isVisited(selected.state, c, r) : (c, r) => world.truthVisited.has(`${c},${r}`);
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (!searched(c, r)) fogCtx.fillRect(c, r, 1, 1);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(fog, 0, 0, W, H);

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
    drawDrone(d, hue(ranks(d), n));
    if (d === selected) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(d.x, d.y, SENSE + 5, 0, Math.PI * 2); ctx.stroke();
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
    ctx.fillStyle = 'rgba(240,245,250,0.9)'; ctx.font = '600 10px system-ui'; ctx.fillText(`${d.id} · ${d.state.hops === null ? 'no route' : `${d.state.hops} hops`}`, d.x, d.y + 22);
    if (d.muling) { ctx.fillStyle = '#ff7a59'; ctx.font = '600 10px system-ui'; ctx.fillText('carrying report', d.x, d.y + 33); }
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- what each drone knows
const MODE_TEXT = { hub: 'has news of the hub', neighbours: 'hears others, but not the hub', alone: 'hears nobody' };

function updateDronePanel() {
  if (!selected) return;
  const d = selected, s = d.state;
  const found = world.survivors.filter((p) => p.foundBy).length;
  const reports = Object.entries(s.survivors);
  const facts = [
    ['Doing', d.task],
    ['Radio', MODE_TEXT[d.commsMode]],
    ['Route to base', s.hops === null ? 'none' : `${s.hops} hops`],
    ['Map it knows', `${Math.round((R.visitedCount(s) / (COLS * ROWS)) * 100)}% searched (really ${Math.round(world.coverage() * 100)}%)`],
    ['Thinks alive', `${R.liveIds(s).length} drones (really ${world.drones.filter((x) => x.alive).length})`],
    ['Thinks the hub is', `drone ${s.hub.id}`],
    ['People it knows of', `${reports.length} (really ${found} found)`],
  ];
  $('droneTitle').textContent = `Drone ${d.id}`;
  $('droneFacts').innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('droneReports').innerHTML = reports.map(([id, r]) => `<li>${id}: found by drone ${r.foundBy}, ${r.delivered ? 'it knows base has this' : 'not known to be at base'}</li>`).join('');
}

function updateGrid() {
  const share = world.agreement();
  $('agreement').textContent = share === null ? '' : `Drones know ${Math.round(share * 100)}% of what's been found`;
  const row = (label, state, attrs = '') => `<tr ${attrs}><th scope="row">${label}</th>${world.survivors.map((p) => {
    const r = state.survivors[p.id];
    if (!r) return '<td title="doesn\'t know"></td>';
    return r.delivered ? '<td class="sent" title="knows, and knows base has it">✓</td>' : '<td class="known" title="knows, base not confirmed">●</td>';
  }).join('')}</tr>`;
  const head = `<tr><th></th>${world.survivors.map((p) => `<th scope="col" title="Person ${p.id}">${p.id.slice(1)}</th>`).join('')}</tr>`;
  const drones = world.drones.map((d) => row(`D${d.id}`, d.state, `data-id="${d.id}" class="${[d === selected && 'on', !d.alive && 'down'].filter(Boolean).join(' ')}"`));
  $('knowGrid').innerHTML = head + row('Base', world.base.state, 'class="base"') + drones.join('');
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
  $('hubline').innerHTML = !live.length ? '<span class="suspect">No drones left</span>' : hubDrone && hubDrone.alive
    ? `Hub: <b>drone ${hub}</b> · epoch ${epoch}` + (waiting ? ` · <span class="suspect">${waiting} drones can't hear it</span>` : '')
    : `<span class="suspect">Hub ${hub} silent — ${waiting}/${live.length} drones noticed; still searching, a drone that can hear others takes over after about ${Math.round(R.DEFAULTS.hubTimeout * SECONDS_PER_TICK)} s</span>`;
}

// ---------------------------------------------------------------- graph
const SERIES = [
  { key: 'run', label: 'Searched, this run', colour: '#1f9e94', dash: [] },
  { key: 'base', label: 'Known at base, this run', colour: '#c47a12', dash: [] },
  { key: 'on', label: 'Searched, comms on, nothing failed', colour: '#5b92e0', dash: [6, 4] },
  { key: 'off', label: 'Searched, no radio from launch', colour: '#d45fa0', dash: [2, 4] },
];
const graph = $('graph'), gctx = graph.getContext('2d');
const PAD = { l: 34, r: 10, t: 16, b: 20 };
let hoverX = null;

$('graphLegend').innerHTML = SERIES.map((s) => `<li><svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke="${s.colour}" stroke-width="2" stroke-dasharray="${s.dash.join(' ')}"/></svg><span>${s.label}</span><b id="gv-${s.key}">0%</b></li>`).join('');

function sample() {
  const point = {
    tick: world.tick,
    run: world.coverage() * 100,
    base: world.baseCoverage() * 100,
    on: reference.on.coverage() * 100,
    off: reference.off.coverage() * 100,
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

  gctx.font = '11px system-ui'; gctx.fillStyle = '#8b9bb0'; gctx.strokeStyle = '#223042'; gctx.lineWidth = 1;
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
    gctx.strokeStyle = '#3a4d66'; gctx.setLineDash([2, 3]);
    gctx.beginPath(); gctx.moveTo(x, PAD.t); gctx.lineTo(x, PAD.t + ih); gctx.stroke();
    gctx.setLineDash([]);
    if (x < lastLabelEnd) continue;  // keep labels from colliding
    gctx.fillStyle = '#8b9bb0'; gctx.fillText(m.label, x + 3, PAD.t - 4);
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
  gctx.strokeStyle = '#8b9bb0'; gctx.beginPath(); gctx.moveTo(X(p.tick), PAD.t); gctx.lineTo(X(p.tick), PAD.t + ih); gctx.stroke();
  for (const s of SERIES) {
    gctx.fillStyle = s.colour; gctx.strokeStyle = '#121821'; gctx.lineWidth = 2;
    gctx.beginPath(); gctx.arc(X(p.tick), Y(p[s.key]), 4, 0, Math.PI * 2); gctx.fill(); gctx.stroke();
  }
  tip.hidden = false;
  tip.innerHTML = `<div class="k">${Math.round(p.tick * SECONDS_PER_TICK)}s</div>` + SERIES.map((s) => `<div>${s.label}: <b>${Math.round(p[s.key])}%</b></div>`).join('');
  const left = X(p.tick) + 12;
  tip.style.left = `${left + tip.offsetWidth > cw ? Math.max(0, X(p.tick) - tip.offsetWidth - 12) : left}px`;
}
graph.addEventListener('pointermove', (e) => { hoverX = e.clientX - graph.getBoundingClientRect().left; });
graph.addEventListener('pointerleave', () => { hoverX = null; });

// ---------------------------------------------------------------- NCA panel
let nca = null;
// Safety net: if the shape hasn't recovered ~7 s after damage, regrow it
// from one cell (this is how the gecko starts too).
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
    log('Formation panel: damage too close to the seed — regrowing from one cell');
  }
}
const ncaCanvas = $('nca'), ncaCtx = ncaCanvas.getContext('2d');
fetch('../recovery/models/formation-nca.json')
  .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then((model) => { nca = new NCA(model); nca.reset(); })
  .catch(() => { $('ncaSim').textContent = 'model not trained yet — run nca/train_nca.py'; });
ncaCanvas.addEventListener('click', (e) => {
  if (!nca) return;
  const r = ncaCanvas.getBoundingClientRect();
  damageNca(((e.clientX - r.left) / r.width) * nca.N, ((e.clientY - r.top) / r.height) * nca.N);
});
$('ncaReset').onclick = () => { if (nca) nca.reset(); ncaWatch = null; };

// ---------------------------------------------------------------- loop
let frame = 0, lastFrame = 0, owed = 0;
function loop(t) {
  owed += Math.min(0.1, (t - (lastFrame || t)) / 1000); lastFrame = t;
  for (; owed >= DT; owed -= DT) {
    const before = world.tick;
    world.step(); reference.on.step(); reference.off.step();
    if (world.tick !== before) {
      updateStats();
      if (world.tick % SAMPLE_TICKS === 0) sample();
    }
  }
  draw();
  drawGraph();
  if (nca) {
    if (++frame % NCA_FRAMES_PER_STEP === 0) { nca.step(); watchNca(); }
    nca.draw(ncaCtx);
    if (frame % 15 === 0) $('ncaSim').textContent = `shape restored: ${Math.round(nca.similarity() * 100)}%`;
  }
  requestAnimationFrame(loop);
}
reset();
requestAnimationFrame(loop);
