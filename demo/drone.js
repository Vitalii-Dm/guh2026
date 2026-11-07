// drone.js — what one drone does, wherever it runs: pick where to go, fly, look
// around, and decide who it can hear. No DOM and no view of other drones'
// memory, so the same code runs in sim.js and on a phone.
import * as R from '../recovery/swarm-recovery.js';

export const W = 880, H = 600, CELL = 20, COLS = W / CELL, ROWS = H / CELL;
export const N_DRONES = 15, N_SURVIVORS = 7;
export const DT = 0.016;            // one motion step, seconds
export const TICK_STEPS = 10;       // motion steps per protocol tick (160 ms)
export const SENSE = 17;            // sensor radius, px
export const BASE = { x: W / 2, y: H - 22 };
export const SPEED = 32;            // flight speed, px/s
const FLIGHT_AGL = 0.05;            // drone height above the ground (terrain units)
const MAST_AGL = 0.12;              // base antenna height
const LOS_STEP = 10;                // px between terrain samples along a link
const DETECT = SENSE + 15;          // person detection radius: a cell counts as searched from 17 px, so this reaches its corners
const HOME_OFFSET = 30;             // how far short of base drones stop, px; inside the lowest radio range
const MULE_WAIT = 40;               // ticks a mule waits at base before giving up
const MULE_REST = 200;              // ticks before a mule that gave up tries again

// Seeded RNG so every run is identical (rehearsal + backup video).
export function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The missing people for a seed. Every device builds the same list. */
export function makeSurvivors(seed, terrain) {
  const rng = mulberry32(seed);
  return Array.from({ length: N_SURVIVORS }, (_, i) => ({
    id: `s${i + 1}`, ...terrain.randomLandPoint(rng), foundBy: null, pose: rng(),
  }));
}

/** A drone at its launch position, in the arc around base. */
export function createDrone(id, ids) {
  const a = Math.PI * (0.15 + 0.7 * (ids.indexOf(id) / (ids.length - 1)));
  return { id, alive: true, x: BASE.x - Math.cos(a) * 70, y: BASE.y - Math.sin(a) * 50, hubStatus: 'ok', commsMode: 'hub',
    state: R.createState(id, ids, { hubId: 1, cols: COLS, rows: ROWS }), target: null, angle: 0, diedAt: null,
    muling: false, atBaseTicks: 0, restUntil: 0, task: 'launching' };
}

// ---------------------------------------------------------------- radio

function jammed(n, blackout) {
  const c = Math.floor(n.x / CELL), r = Math.floor(n.y / CELL);
  return blackout[Math.max(0, Math.min(ROWS - 1, r)) * COLS + Math.max(0, Math.min(COLS - 1, c))] === 1;
}

function lineOfSight(a, b, terrain) {
  const altitude = (n) => terrain.height(n.x, n.y) + (n.isBase ? MAST_AGL : FLIGHT_AGL);
  const ha = altitude(a), hb = altitude(b);
  const n = Math.ceil(Math.hypot(a.x - b.x, a.y - b.y) / LOS_STEP);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (terrain.height(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) > ha + (hb - ha) * t) return false;
  }
  return true;
}

/**
 * The radio rule, the same on every device.
 * @param a,b    anything with x and y; `isBase` marks the base mast
 * @param world  { radio, range, los, terrain, blackout }
 * @returns {'open'|'blocked'|'none'} 'blocked' means in range but behind a ridge
 */
export function radioLink(a, b, { radio, range, los, terrain, blackout }) {
  if (!radio || Math.hypot(a.x - b.x, a.y - b.y) > range || jammed(a, blackout) || jammed(b, blackout)) return 'none';
  return los && !lineOfSight(a, b, terrain) ? 'blocked' : 'open';
}

export const canHear = (a, b, world) => radioLink(a, b, world) === 'open';

// ---------------------------------------------------------------- where to go

/** Cells of a strip from the bottom row up, alternating direction. */
function serpentine(c0, c1) {
  const cells = [];
  for (let r = ROWS - 1; r >= 0; r--) {
    const row = [];
    for (let c = c0; c < c1; c++) row.push([c, r]);
    if ((ROWS - 1 - r) % 2) row.reverse();
    cells.push(...row);
  }
  return cells;
}

function muleTarget(d, tick, onLog) {
  const report = tick >= d.restUntil ? R.reportToCarry(d.state, tick) : null;
  if (!report) { d.muling = false; d.atBaseTicks = 0; return null; }
  const home = { x: BASE.x, y: BASE.y - HOME_OFFSET };
  if (Math.hypot(d.x - home.x, d.y - home.y) < 12 && ++d.atBaseTicks > MULE_WAIT) {
    // Made it back and base still can't hear us: search on, try again later.
    onLog(`Drone ${d.id} can't reach base even from here. Back to searching; it will retry later.`, `rest${d.id}t${tick}`);
    d.restUntil = tick + MULE_REST;
    d.muling = false; d.atBaseTicks = 0;
    return null;
  }
  onLog(`Drone ${d.id} has no route to base, so it's flying report ${report} back itself (data mule)`, `mule${report}d${d.id}`);
  d.muling = true;
  d.task = `carrying the report for ${report} home`;
  return home;
}

/**
 * Where a drone heads next, from what it alone knows. Sets `d.task`.
 * @param d      { id, x, y, state, restUntil, atBaseTicks, muling, task }
 * @param world  { tick, mode } mode is 'search' or 'formation'
 */
export function chooseTarget(d, { tick, mode }, onLog = () => {}) {
  const mule = muleTarget(d, tick, onLog);
  if (mule) return mule;
  if (mode === 'formation') {
    d.task = 'holding its place in the formation';
    const s = R.formationSlotFor(d.state, d.id);
    return s && { x: 40 + s[0] * (W - 80), y: 20 + s[1] * (H - 60) };
  }
  const [c0, c1] = R.homeSector(d.state, d.id, COLS);
  d.task = 'searching its home strip';
  for (const [c, r] of serpentine(c0, c1)) {
    if (!R.isVisited(d.state, c, r)) return { x: c * CELL + CELL / 2, y: r * CELL + CELL / 2 };
  }
  // Home strip done: help with the nearest ground this drone believes is unsearched.
  d.task = 'helping with the nearest ground it thinks is unsearched';
  let best = null, bd = Infinity;
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (R.isVisited(d.state, c, r)) continue;
      const x = c * CELL + CELL / 2, y = r * CELL + CELL / 2, dist = Math.hypot(x - d.x, y - d.y);
      if (dist < bd) { bd = dist; best = { x, y }; }
    }
  }
  // Nothing left: come home, which also hands base the final map. Spread
  // out only once there's a route, or a drone could stop just out of range.
  if (!best) d.task = 'finished, coming home';
  return best ?? { x: BASE.x + (d.state.hops === null ? 0 : (d.id - (d.state.fleet.length + 1) / 2) * 16), y: BASE.y - HOME_OFFSET };
}

// ---------------------------------------------------------------- flying and looking

/** Move toward `d.target` for `dt` seconds. */
export function fly(d, dt, speed = SPEED) {
  const dx = d.target.x - d.x, dy = d.target.y - d.y, dist = Math.hypot(dx, dy);
  if (dist > 0.5) {
    const s = Math.min(speed * dt, dist);
    d.x += (dx / dist) * s; d.y += (dy / dist) * s;
    d.angle = Math.atan2(dy, dx);
  }
}

/** Map cells close enough to count as searched from here, as [col, row]. */
export function cellsInView(d) {
  const cells = [];
  const c0 = Math.floor((d.x - SENSE) / CELL), c1 = Math.floor((d.x + SENSE) / CELL);
  const r0 = Math.floor((d.y - SENSE) / CELL), r1 = Math.floor((d.y + SENSE) / CELL);
  for (let c = Math.max(0, c0); c <= Math.min(COLS - 1, c1); c++) {
    for (let r = Math.max(0, r0); r <= Math.min(ROWS - 1, r1); r++) {
      if (Math.hypot(c * CELL + CELL / 2 - d.x, r * CELL + CELL / 2 - d.y) <= SENSE) cells.push([c, r]);
    }
  }
  return cells;
}

/**
 * People in sensor range that this drone holds no report for. It goes by what
 * it knows, so a person whose only report died with its finder can be found again.
 */
export function peopleInView(d, survivors) {
  return survivors.filter((s) => !d.state.survivors[s.id] && Math.hypot(s.x - d.x, s.y - d.y) <= DETECT);
}
