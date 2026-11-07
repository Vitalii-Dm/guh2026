// sim.js — the swarm simulation, with no DOM. demo.js draws it; the tests and
// the graph's reference runs drive the same code. Fixed time steps, so a given
// seed and set of actions always plays out the same way.
import * as R from '../recovery/swarm-recovery.js';
import * as D from './drone.js';
import { COLS, ROWS, CELL, N_DRONES, DT, TICK_STEPS, BASE, SPEED } from './drone.js';

export { W, H, CELL, COLS, ROWS, N_DRONES, N_SURVIVORS, DT, TICK_STEPS, SENSE, BASE, mulberry32 } from './drone.js';

const RELAY_HOPS = 4;               // hops a message travels per tick
const SECONDS = (ticks) => Math.round(ticks * DT * TICK_STEPS);
/**
 * A radio message: a copy of the shared part of a drone's state, so drones in
 * the same JS thread never share objects. Same result as
 * structuredClone(R.snapshot(state)), several times cheaper, and the
 * simulation's main cost before.
 */
function message(state) {
  const roster = {}, survivors = {};
  for (const id in state.roster) roster[id] = { ...state.roster[id] };
  for (const id in state.survivors) survivors[id] = { ...state.survivors[id] };
  return { roster, survivors, visited: state.visited.slice(), hub: { ...state.hub }, hops: state.hops };
}


/**
 * @param {object} o
 * @param {number} o.seed
 * @param {object} o.terrain        from makeTerrain()
 * @param {number} [o.drones]       how many drones launch
 * @param {number} [o.range]        radio range, px
 * @param {boolean} [o.los]         ridges block radio
 * @param {boolean} [o.radio]       false = no drone ever hears another
 * @param {number} [o.speed]        flight speed, px/s
 * @param {number[]} [o.remoteIds]  drones flown by another device. The sim only
 *                                  holds what they last said: see applyRemote
 * @param {(msg: string, key?: string) => void} [o.onLog]
 */
export function createSim({ seed, terrain, drones = N_DRONES, range = 190, los = true, radio = true, speed = SPEED, remoteIds = [], onLog = () => {} }) {
  const ids = Array.from({ length: drones }, (_, i) => i + 1);
  const outages = {};                // drone id -> how many times it has lost its connection

  const sim = {
    tick: 0,
    steps: 0,
    range, los, radio, speed,
    mode: 'search',                  // or 'formation'
    terrain,
    base: { ...BASE, isBase: true, state: R.createState(R.BASE_ID, ids, { hubId: 1, cols: COLS, rows: ROWS }) },
    drones: ids.map((id) => ({ ...D.createDrone(id, ids), remote: remoteIds.includes(id), inContact: true, lastMessage: -1,
      own: new Uint8Array(COLS * ROWS) })),   // cells it searched itself (display only)
    survivors: D.makeSurvivors(seed, terrain),
    truthVisited: new Set(),
    searchedBy: new Int16Array(COLS * ROWS), // first drone to search each cell, 0 = nobody (display only)
    blackout: new Uint8Array(COLS * ROWS), // painted cells: no radio in or out
    links: [],                       // pairs that can talk
    blocked: [],                     // pairs in range but behind a ridge
  };

  const nodes = () => [sim.base, ...sim.drones.filter((d) => d.alive)];
  function protocolTick() {
    sim.tick++;
    // A drone on another device takes part only while its connection is up.
    const ns = nodes().filter((n) => !n.remote || n.inContact);
    const nbrs = ns.map(() => []);
    sim.links = [];
    sim.blocked = [];
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const link = D.radioLink(ns[i], ns[j], sim);
        if (link === 'blocked') sim.blocked.push([ns[i], ns[j]]);
        if (link !== 'open') continue;
        nbrs[i].push(j); nbrs[j].push(i);
        sim.links.push([ns[i], ns[j]]);
      }
    }
    // Radio relays in milliseconds, a tick is 160 ms: let messages travel
    // several hops per tick (merge-only rounds), then run the protocol step.
    if (sim.links.length) {
      for (let round = 0; round < RELAY_HOPS - 1; round++) {
        const snaps = ns.map((n) => message(n.state));
        ns.forEach((n, i) => {
          if (n.remote) return;
          const msgs = nbrs[i].map((j) => snaps[j]);
          for (const m of msgs) R.mergeInto(n.state, m);
          R.updateHops(n.state, msgs);
        });
      }
    }
    const snaps = ns.map((n) => message(n.state));
    const inbox = nbrs.map((js) => js.map((j) => snaps[j]));
    ns.forEach((n, i) => {
      if (n.remote) return;
      const { hubStatus, mode, events } = R.step(n.state, inbox[i], sim.tick);
      n.hubStatus = hubStatus;
      n.commsMode = mode;
      for (const e of events) {
        const [type, a, b] = e.split(':');
        if (type === 'became-hub') onLog(`<b>Drone ${a} took over as hub</b> (${b}), the lowest live id it can reach`, e);
        if (type === 'marked-failed') onLog(`Drone ${n.id} has heard nothing of drone ${a} for ${SECONDS(R.DEFAULTS.failTimeout)} s and treats it as failed`, `mf${a}${outages[a] ? `o${outages[a]}` : ''}`);
        if (type === 'delivered') onLog(`Report for person ${a} reached base. Rescue team dispatched.`, e);
      }
      if (n !== sim.base && hubStatus === 'suspect' && !R.isHub(n.state) && mode !== 'alone') {
        onLog(`Drone ${n.id}: no word from hub ${n.state.hub.id} for ${SECONDS(R.DEFAULTS.hubTimeout)} s, hub suspect`, `sus${n.state.hub.id}e${n.state.hub.epoch}`);
      }
    });
    for (const d of sim.drones) if (d.alive && !d.remote) d.target = D.chooseTarget(d, sim, onLog);
  }

  function move(dt) {
    for (const d of sim.drones) {
      if (!d.alive || d.remote || !d.target) continue;
      D.fly(d, dt, sim.speed);
      for (const [c, r] of D.cellsInView(d)) {
        R.recordVisit(d.state, c, r);
        sim.truthVisited.add(`${c},${r}`);
        d.own[r * COLS + c] = 1;
        if (!sim.searchedBy[r * COLS + c]) sim.searchedBy[r * COLS + c] = d.id;
      }
      for (const s of D.peopleInView(d, sim.survivors)) {
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

  /**
   * Take in a message from a drone on another device. Its position and map
   * update at once, because this is the viewer's picture and no drone acts on
   * it. Its snapshot only reaches other drones in a tick where the radio rule
   * allows it.
   * @param {{id, tick, x, y, angle, task, hubStatus, mode, muling, own, snapshot}} m
   */
  sim.applyRemote = (m) => {
    const d = sim.drones.find((n) => n.id === m.id);
    if (!d?.remote || !d.alive || m.tick < d.lastMessage) return;
    if (!d.inContact) onLog(`<b>Drone ${d.id} is connected again.</b> This screen now shows the ground it searched; the swarm hears of it over radio.`, `back${d.id}t${sim.tick}`);
    const hub = m.snapshot.hub, was = d.state.hub;
    if (hub.id === d.id && hub.epoch > was.epoch) {     // every real takeover raises the epoch
      onLog(`<b>Drone ${d.id} took over as hub</b> (epoch${hub.epoch}), the lowest live id it can reach`, `became-hub:${d.id}:epoch${hub.epoch}`);
    }
    Object.assign(d, { inContact: true, lastMessage: m.tick, x: m.x, y: m.y, angle: m.angle, task: m.task, hubStatus: m.hubStatus, commsMode: m.mode, muling: m.muling ?? false });
    Object.assign(d.state, structuredClone(m.snapshot));
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        if (!R.isVisited(d.state, c, r)) continue;
        sim.truthVisited.add(`${c},${r}`);
        const flown = m.own && R.isVisited({ cols: COLS, visited: m.own }, c, r);
        if (flown) d.own[r * COLS + c] = 1;
        if (flown && !sim.searchedBy[r * COLS + c]) sim.searchedBy[r * COLS + c] = d.id;
      }
    }
    for (const s of sim.survivors) {
      const report = d.state.survivors[s.id];
      if (report && !s.foundBy) { s.foundBy = report.foundBy; onLog(`<b>Person ${s.id} found</b> by drone ${report.foundBy}`); }
    }
  };

  /** The connection to a drone on another device has gone silent. */
  sim.remoteLost = (id) => {
    const d = sim.drones.find((n) => n.id === id);
    if (!d?.remote || !d.inContact) return;
    d.inContact = false;
    d.commsMode = 'alone';           // as far as this screen can tell
    outages[id] = (outages[id] ?? 0) + 1;
    onLog(`<b>Drone ${id} is not connected.</b> It keeps flying on its phone; this screen shows where it was last seen.`, `lost${id}t${sim.tick}`);
  };

  /**
   * What this device sends to a remote drone each tick: every drone's position
   * for drawing, and a message from each node here that it can hear.
   */
  sim.outbox = (id) => {
    const d = sim.drones.find((n) => n.id === id);
    const speakers = nodes().filter((n) => !n.remote && D.canHear(n, d, sim));
    return {
      tick: sim.tick,
      positions: sim.drones.map(({ id: n, x, y, alive, inContact }) => ({ id: n, x, y, alive, inContact })),
      messages: speakers.map((n) => ({ id: n.id ?? R.BASE_ID, isBase: n.isBase, tick: sim.tick, x: n.x, y: n.y, angle: n.angle, task: n.task, snapshot: message(n.state) })),
    };
  };

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
    for (const d of sim.drones) if (d.alive && d.inContact) votes[d.state.hub.id] = (votes[d.state.hub.id] || 0) + 1;
    const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    return best ? Number(best[0]) : null;   // null: no drone alive and in contact
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
