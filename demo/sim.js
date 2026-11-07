// sim.js — the swarm simulation, with no DOM. demo.js draws it; the tests and
// the graph's reference runs drive the same code. Fixed time steps, so a given
// seed and set of actions always plays out the same way.
import * as R from '../recovery/swarm-recovery.js';

export const W = 880, H = 600, CELL = 20, COLS = W / CELL, ROWS = H / CELL;
export const N_DRONES = 15, N_SURVIVORS = 7;
export const DT = 0.016;            // one motion step, seconds
export const TICK_STEPS = 10;       // motion steps per protocol tick (160 ms)
export const SENSE = 17;            // sensor radius, px
export const BASE = { x: W / 2, y: H - 22 };
const SPEED = 32;                   // flight speed, px/s
const RELAY_HOPS = 4;               // hops a message travels per tick
const FLIGHT_AGL = 0.05;            // drone height above the ground (terrain units)
const MAST_AGL = 0.12;              // base antenna height
const LOS_STEP = 10;                // px between terrain samples along a link
const DETECT = SENSE + 15;          // person detection radius: a cell counts as searched from 17 px, so this reaches its corners
const SECONDS = (ticks) => Math.round(ticks * DT * TICK_STEPS);
const HOME_OFFSET = 30;             // how far short of base drones stop, px; inside the lowest radio range
const MULE_WAIT = 40;               // ticks a mule waits at base before giving up
const MULE_REST = 200;              // ticks before a mule that gave up tries again

// Seeded RNG so every run is identical (rehearsal + backup video).
export function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

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

/**
 * @param {object} o
 * @param {number} o.seed
 * @param {object} o.terrain        from makeTerrain()
 * @param {number} [o.drones]       how many drones launch
 * @param {number} [o.range]        radio range, px
 * @param {boolean} [o.los]         ridges block radio
 * @param {boolean} [o.radio]       false = no drone ever hears another
 * @param {(msg: string, key?: string) => void} [o.onLog]
 */
export function createSim({ seed, terrain, drones = N_DRONES, range = 190, los = true, radio = true, onLog = () => {} }) {
  const rng = mulberry32(seed);
  const ids = Array.from({ length: drones }, (_, i) => i + 1);

  const sim = {
    tick: 0,
    steps: 0,
    range, los, radio,
    mode: 'search',                  // or 'formation'
    terrain,
    base: { ...BASE, state: R.createState(R.BASE_ID, ids, { hubId: 1, cols: COLS, rows: ROWS }) },
    drones: ids.map((id, i) => {
      const a = Math.PI * (0.15 + 0.7 * (i / (drones - 1)));
      return { id, alive: true, x: BASE.x - Math.cos(a) * 70, y: BASE.y - Math.sin(a) * 50, hubStatus: 'ok', commsMode: 'hub',
        state: R.createState(id, ids, { hubId: 1, cols: COLS, rows: ROWS }), target: null, angle: 0, diedAt: null,
        muling: false, atBaseTicks: 0, restUntil: 0, task: 'launching',
        own: new Uint8Array(COLS * ROWS) };             // cells it searched itself (display only)
    }),
    survivors: Array.from({ length: N_SURVIVORS }, (_, i) => ({
      id: `s${i + 1}`, ...terrain.randomLandPoint(rng), foundBy: null, pose: rng(),
    })),
    truthVisited: new Set(),
    searchedBy: new Int16Array(COLS * ROWS), // first drone to search each cell, 0 = nobody (display only)
    blackout: new Uint8Array(COLS * ROWS), // painted cells: no radio in or out
    links: [],                       // pairs that can talk
    blocked: [],                     // pairs in range but behind a ridge
  };

  const nodes = () => [sim.base, ...sim.drones.filter((d) => d.alive)];
  const groundAlt = (n) => terrain.height(n.x, n.y) + (n === sim.base ? MAST_AGL : FLIGHT_AGL);

  function jammed(n) {
    const c = Math.floor(n.x / CELL), r = Math.floor(n.y / CELL);
    return sim.blackout[Math.max(0, Math.min(ROWS - 1, r)) * COLS + Math.max(0, Math.min(COLS - 1, c))] === 1;
  }

  function lineOfSight(a, b) {
    const ha = groundAlt(a), hb = groundAlt(b);
    const n = Math.ceil(Math.hypot(a.x - b.x, a.y - b.y) / LOS_STEP);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (terrain.height(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) > ha + (hb - ha) * t) return false;
    }
    return true;
  }

  function protocolTick() {
    sim.tick++;
    const ns = nodes();
    const nbrs = ns.map(() => []);
    sim.links = [];
    sim.blocked = [];
    if (sim.radio) {
      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          if (Math.hypot(ns[i].x - ns[j].x, ns[i].y - ns[j].y) > sim.range || jammed(ns[i]) || jammed(ns[j])) continue;
          if (sim.los && !lineOfSight(ns[i], ns[j])) { sim.blocked.push([ns[i], ns[j]]); continue; }
          nbrs[i].push(j); nbrs[j].push(i);
          sim.links.push([ns[i], ns[j]]);
        }
      }
    }
    // Radio relays in milliseconds, a tick is 160 ms: let messages travel
    // several hops per tick (merge-only rounds), then run the protocol step.
    if (sim.links.length) {
      for (let round = 0; round < RELAY_HOPS - 1; round++) {
        const snaps = ns.map((n) => structuredClone(R.snapshot(n.state)));
        ns.forEach((n, i) => {
          const msgs = nbrs[i].map((j) => snaps[j]);
          for (const m of msgs) R.mergeInto(n.state, m);
          R.updateHops(n.state, msgs);
        });
      }
    }
    const snaps = ns.map((n) => structuredClone(R.snapshot(n.state)));
    const inbox = nbrs.map((js) => js.map((j) => snaps[j]));
    ns.forEach((n, i) => {
      const { hubStatus, mode, events } = R.step(n.state, inbox[i], sim.tick);
      n.hubStatus = hubStatus;
      n.commsMode = mode;
      for (const e of events) {
        const [type, a, b] = e.split(':');
        if (type === 'became-hub') onLog(`<b>Drone ${a} took over as hub</b> (${b}), the lowest live id it can reach`, e);
        if (type === 'marked-failed') onLog(`Drone ${n.id} has heard nothing of drone ${a} for ${SECONDS(R.DEFAULTS.failTimeout)} s and treats it as failed`, `mf${a}`);
        if (type === 'delivered') onLog(`Report for person ${a} reached base. Rescue team dispatched.`, e);
      }
      if (n !== sim.base && hubStatus === 'suspect' && !R.isHub(n.state) && mode !== 'alone') {
        onLog(`Drone ${n.id}: no word from hub ${n.state.hub.id} for ${SECONDS(R.DEFAULTS.hubTimeout)} s, hub suspect`, `sus${n.state.hub.id}e${n.state.hub.epoch}`);
      }
    });
    for (const d of sim.drones) if (d.alive) d.target = chooseTarget(d);
  }

  function muleTarget(d) {
    const report = sim.tick >= d.restUntil ? R.reportToCarry(d.state, sim.tick) : null;
    if (!report) { d.muling = false; d.atBaseTicks = 0; return null; }
    const home = { x: BASE.x, y: BASE.y - HOME_OFFSET };
    if (Math.hypot(d.x - home.x, d.y - home.y) < 12 && ++d.atBaseTicks > MULE_WAIT) {
      // Made it back and base still can't hear us: search on, try again later.
      onLog(`Drone ${d.id} can't reach base even from here. Back to searching; it will retry later.`, `rest${d.id}t${sim.tick}`);
      d.restUntil = sim.tick + MULE_REST;
      d.muling = false; d.atBaseTicks = 0;
      return null;
    }
    onLog(`Drone ${d.id} has no route to base, so it's flying report ${report} back itself (data mule)`, `mule${report}d${d.id}`);
    d.muling = true;
    d.task = `carrying the report for ${report} home`;
    return home;
  }

  function chooseTarget(d) {
    const mule = muleTarget(d);
    if (mule) return mule;
    if (sim.mode === 'formation') {
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
    return best ?? { x: BASE.x + (d.state.hops === null ? 0 : (d.id - (drones + 1) / 2) * 16), y: BASE.y - HOME_OFFSET };
  }

  function move(dt) {
    for (const d of sim.drones) {
      if (!d.alive || !d.target) continue;
      const dx = d.target.x - d.x, dy = d.target.y - d.y, dist = Math.hypot(dx, dy);
      if (dist > 0.5) {
        const s = Math.min(SPEED * dt, dist);
        d.x += (dx / dist) * s; d.y += (dy / dist) * s;
        d.angle = Math.atan2(dy, dx);
      }
      const c0 = Math.floor((d.x - SENSE) / CELL), c1 = Math.floor((d.x + SENSE) / CELL);
      const r0 = Math.floor((d.y - SENSE) / CELL), r1 = Math.floor((d.y + SENSE) / CELL);
      for (let c = Math.max(0, c0); c <= Math.min(COLS - 1, c1); c++) {
        for (let r = Math.max(0, r0); r <= Math.min(ROWS - 1, r1); r++) {
          if (Math.hypot(c * CELL + CELL / 2 - d.x, r * CELL + CELL / 2 - d.y) <= SENSE) {
            R.recordVisit(d.state, c, r);
            sim.truthVisited.add(`${c},${r}`);
            d.own[r * COLS + c] = 1;
            if (!sim.searchedBy[r * COLS + c]) sim.searchedBy[r * COLS + c] = d.id;
          }
        }
      }
      for (const s of sim.survivors) {
        // Each drone goes by what it knows, so a person whose only report died
        // with its finder can still be found again.
        if (d.state.survivors[s.id] || Math.hypot(s.x - d.x, s.y - d.y) > DETECT) continue;
        const again = s.foundBy && !sim.holders(s).length;
        R.recordSurvivor(d.state, s.id, s.x, s.y, sim.tick);
        if (!s.foundBy) { s.foundBy = d.id; onLog(`<b>Person ${s.id} found</b> by drone ${d.id}`); }
        else if (again) onLog(`<b>Person ${s.id} found again</b> by drone ${d.id}. The first report was lost.`);
      }
    }
  }

  /** Advance one fixed motion step, with a protocol tick every TICK_STEPS. */
  sim.step = () => {
    if (sim.steps++ % TICK_STEPS === 0) protocolTick();
    move(DT);
  };

  /** Run whole protocol ticks (for tests and headless runs). */
  sim.run = (ticks) => { for (let i = 0; i < ticks * TICK_STEPS; i++) sim.step(); };

  /** Live nodes (base included) that hold a report for survivor `s`. */
  sim.holders = (s) => nodes().filter((n) => n.state.survivors[s.id]);

  /** Share of what has been found that live drones know about, 0..1, or null if nothing has. */
  sim.agreement = () => {
    const found = sim.survivors.filter((p) => p.foundBy);
    const live = sim.drones.filter((d) => d.alive);
    if (!found.length || !live.length) return null;
    const known = live.reduce((n, d) => n + found.filter((p) => d.state.survivors[p.id]).length, 0);
    return known / (found.length * live.length);
  };

  /** The hub most live drones currently believe in. */
  sim.currentHub = () => {
    const votes = {};
    for (const d of sim.drones) if (d.alive) votes[d.state.hub.id] = (votes[d.state.hub.id] || 0) + 1;
    const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    return best ? Number(best[0]) : null;
  };

  /** Fail a drone. Returns its formation slot, or null if it was already down. */
  sim.fail = (d, now = 0) => {
    if (!d || !d.alive) return null;
    const wasHub = sim.currentHub() === d.id;
    const slot = R.formationSlotFor(d.state, d.id);
    d.alive = false; d.diedAt = now;
    onLog(`<b>Drone ${d.id} failed</b>${wasHub ? '. It was the hub.' : ''}`);
    return slot;
  };

  /** Paint or clear blackout in a circle around (x, y). */
  sim.paintBlackout = (x, y, radius, on = true) => {
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        if (Math.hypot(c * CELL + CELL / 2 - x, r * CELL + CELL / 2 - y) <= radius) sim.blackout[r * COLS + c] = on ? 1 : 0;
      }
    }
  };

  sim.clearBlackout = () => sim.blackout.fill(0);

  /** Share of the map actually searched, 0..1. */
  sim.coverage = () => sim.truthVisited.size / (COLS * ROWS);

  /** Share of the map base knows has been searched, 0..1. */
  sim.baseCoverage = () => R.visitedCount(sim.base.state) / (COLS * ROWS);

  return sim;
}
