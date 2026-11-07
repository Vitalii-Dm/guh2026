// swarm-recovery.js — hub recovery core. Zero dependencies, no DOM.
//
// Every drone keeps a full copy of what the swarm knows (SwarmState) and sends
// it to every neighbour it can hear. Copies merge without conflicts, so once a
// report has reached one other drone it survives the finder and the hub.
//
// The state is plain JSON: put `snapshot(state)` into a radio message, and on
// receive call `step(state, inbox, now)`.

export const BASE_ID = 'base';

export const DEFAULTS = {
  hubTimeout: 30,   // listening ticks without news of the hub before it is "suspect"
  failTimeout: 90,  // listening ticks without news of a drone before it is marked failed
  slotTimeout: 15,  // listening ticks before a formation closes up around a silent drone
  contactWindow: 3, // heard nobody for longer than this = "I am the one cut off"
  maxHops: 16,      // hop counts above this mean "no route" (stops counting to infinity)
  muleStagger: 150, // ticks between holders giving up on a route and flying a report back
  cols: 44,         // search grid size, for the visited bitmap
  rows: 30,
};

// Shape the formation holds (normalised 0..1). Keep in sync with
// FORMATION_POLYLINE in nca/train_nca.py.
export const FORMATION_POLYLINE = [[0.12, 0.80], [0.50, 0.22], [0.88, 0.80]];

// ---------------------------------------------------------------- state

/**
 * @param {number|string} selfId  drone id (number) or BASE_ID
 * @param {number[]} droneIds     every drone in the swarm at launch
 * @param {{hubId?: number, now?: number, cols?: number, rows?: number}} [opts]
 */
export function createState(selfId, droneIds, { hubId, now = 0, cols = DEFAULTS.cols, rows = DEFAULTS.rows } = {}) {
  const roster = {};
  for (const id of droneIds) roster[id] = { v: now, alive: true };
  return {
    self: selfId,
    fleet: [...droneIds].sort((a, b) => a - b), // launch list, never changes
    lastHeard: now,         // last tick anyone was heard (local only)
    listened: 0,            // ticks spent able to hear someone (local only)
    news: {},               // id -> { v, at }: newest version seen, and `listened` then (local only)
    hops: selfId === BASE_ID ? 0 : null, // radio hops to base, null = no route
    noRouteSince: now,      // when the route to base was lost, null = have one (local only)
    heldSince: {},          // survivorId -> tick this drone got the report (local only)
    roster,                 // id -> { v: version, alive }
    survivors: {},          // survivorId -> { x, y, foundBy, tick, delivered }
    cols,
    visited: new Array(Math.ceil((cols * rows) / 32)).fill(0), // bitmap, 32 cells per number
    hub: { id: hubId ?? Math.min(...droneIds), epoch: 0 },
  };
}

/** The part of the state that goes into a radio message (JSON-safe). */
export function snapshot(state) {
  return { roster: state.roster, survivors: state.survivors, visited: state.visited, hub: state.hub, hops: state.hops };
}

export function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

// ---------------------------------------------------------------- merge

function rosterWins(a, b) {
  // Higher version wins. On a tie, "failed" wins so the result is deterministic.
  if (!a) return b;
  if (!b) return a;
  if (a.v !== b.v) return a.v > b.v ? a : b;
  return a.alive ? b : a;
}

function survivorWins(a, b) {
  if (!a) return { ...b };
  if (!b) return { ...a };
  const first = a.tick !== b.tick ? (a.tick < b.tick ? a : b) : (a.foundBy <= b.foundBy ? a : b);
  return { ...first, delivered: a.delivered || b.delivered };
}

function hubWins(a, b) {
  if (a.epoch !== b.epoch) return a.epoch > b.epoch ? a : b;
  return Number(a.id) <= Number(b.id) ? a : b;
}

/** Merge `src` into `dst` in place (fast path for the simulation). Returns dst. */
export function mergeInto(dst, src) {
  for (const id in src.roster) {
    const w = rosterWins(dst.roster[id], src.roster[id]);
    if (w !== dst.roster[id]) dst.roster[id] = { ...w };
  }
  for (const sid in src.survivors) {
    const cur = dst.survivors[sid];
    const inc = src.survivors[sid];
    if (!cur || cur.tick !== inc.tick || cur.delivered !== inc.delivered || cur.foundBy !== inc.foundBy) {
      dst.survivors[sid] = survivorWins(cur, inc);
    }
  }
  for (let i = 0; i < src.visited.length; i++) dst.visited[i] |= src.visited[i];
  dst.hub = { ...hubWins(dst.hub, src.hub) };
  return dst;
}

/**
 * Pure merge: never mutates its inputs. Commutative, associative and
 * idempotent on the shared fields. Local ones (`self`, `hops`, `lastHeard`,
 * `listened`, `news`, `noRouteSince`, `heldSince`) are taken from `a`.
 */
export function merge(a, b) {
  return mergeInto(clone(a), b);
}

// ---------------------------------------------------------------- per tick

/**
 * Run once per tick on every drone (and on the base station).
 * @param state  this drone's SwarmState (mutated in place)
 * @param inbox  array of snapshots received from neighbours this tick
 * @param now    current tick
 * @returns {{ hubStatus: 'ok'|'suspect', mode: 'hub'|'neighbours'|'alone', events: string[] }}
 */
export function step(state, inbox, now, opts = {}) {
  const { hubTimeout, failTimeout, contactWindow, maxHops } = { ...DEFAULTS, ...opts };
  const events = [];
  const isBase = state.self === BASE_ID;

  for (const msg of inbox) mergeInto(state, msg);
  updateHops(state, inbox, maxHops);
  state.noRouteSince = state.hops !== null ? null : state.noRouteSince ?? now;
  for (const sid in state.survivors) state.heldSince[sid] ??= now;
  // Silence only means something if I can still hear someone. A drone that
  // can't assumes it is the one cut off: everyone else stays alive in its
  // roster and it does not claim the hub. So timeouts count listening ticks
  // only, and time spent deaf counts against nobody.
  if (inbox.length) state.lastHeard = now;
  const inContact = now - state.lastHeard <= contactWindow;
  if (inContact) state.listened++;

  // I'm alive: refresh my own entry (this is also how a drone that was
  // wrongly marked failed comes back — its version is now higher).
  if (!isBase) {
    const me = state.roster[state.self];
    state.roster[state.self] = { v: Math.max(now, me ? me.v + (me.alive ? 0 : 1) : now), alive: true };
  }

  // The base station is the destination for survivor reports.
  if (isBase) {
    for (const sid in state.survivors) {
      if (!state.survivors[sid].delivered) {
        state.survivors[sid] = { ...state.survivors[sid], delivered: true };
        events.push(`delivered:${sid}`);
      }
    }
  }

  for (const id in state.roster) {
    const v = state.roster[id].v;
    if (!state.news[id] || v > state.news[id].v) state.news[id] = { v, at: state.listened };
  }
  const silentFor = (id) => state.listened - state.news[id].at;

  // Failure detection: not heard (directly or through gossip) for too long.
  // The base station is a passive sink: it sits out of range most of the
  // time, so it never declares drones failed — only drones do.
  if (!isBase && inContact) for (const id in state.roster) {
    if (String(id) === String(state.self)) continue;
    const e = state.roster[id];
    if (e.alive && silentFor(id) > failTimeout) {
      state.roster[id] = { v: e.v + 1, alive: false };
      events.push(`marked-failed:${id}`);
    }
  }

  // Hub succession.
  const hubEntry = state.roster[state.hub.id];
  const hubStatus = !hubEntry || !hubEntry.alive || silentFor(state.hub.id) > hubTimeout ? 'suspect' : 'ok';
  if (hubStatus === 'suspect' && !isBase && inContact) {
    const fresh = Object.keys(state.roster)
      .filter((id) => {
        const e = state.roster[id];
        return Number(id) !== Number(state.hub.id) && e.alive && silentFor(id) <= hubTimeout;
      })
      .map(Number);
    const candidate = Math.min(...fresh);
    if (candidate === Number(state.self)) {
      state.hub = { id: Number(state.self), epoch: state.hub.epoch + 1 };
      events.push(`became-hub:${state.self}:epoch${state.hub.epoch}`);
    }
  }

  const mode = !inContact ? 'alone' : hubStatus === 'ok' ? 'hub' : 'neighbours';
  return { hubStatus, mode, events };
}

/**
 * Hop-count gradient: one more than my best neighbour's count to base. Safe to
 * run several times per tick, so a route crosses the swarm as fast as the
 * relayed messages do.
 */
export function updateHops(state, inbox, maxHops = DEFAULTS.maxHops) {
  if (state.self === BASE_ID) { state.hops = 0; return; }
  let best = null;
  for (const m of inbox) {
    if (m.hops !== null && m.hops !== undefined && m.hops < maxHops && (best === null || m.hops < best)) best = m.hops;
  }
  state.hops = best === null ? null : best + 1;
}

// ---------------------------------------------------------------- helpers

export function liveIds(state) {
  return Object.keys(state.roster)
    .filter((id) => state.roster[id].alive)
    .map(Number)
    .sort((a, b) => a - b);
}

export function isHub(state) {
  return Number(state.hub.id) === Number(state.self);
}

export function recordVisit(state, cx, cy) {
  const i = cy * state.cols + cx;
  state.visited[i >> 5] |= 1 << (i & 31);
}

export function isVisited(state, cx, cy) {
  const i = cy * state.cols + cx;
  return (state.visited[i >> 5] & (1 << (i & 31))) !== 0;
}

/** How many cells this copy of the state knows have been searched. */
export function visitedCount(state) {
  let n = 0;
  for (let w of state.visited) for (; w !== 0; w &= w - 1) n++;
  return n;
}

export function recordSurvivor(state, survivorId, x, y, now) {
  if (!state.survivors[survivorId]) {
    state.survivors[survivorId] = { x, y, foundBy: Number(state.self), tick: now, delivered: false };
  }
}

/**
 * Which undelivered report this drone should fly back, or null. Only with no
 * route to base. The finder goes at once; other holders wait their turn by
 * rank, counted from when they got the report or lost the route, so a report
 * still gets home if the finder fails and a group that hears of it together
 * doesn't all leave together.
 */
export function reportToCarry(state, now, { muleStagger = DEFAULTS.muleStagger } = {}) {
  if (state.hops !== null) return null;
  const rank = Math.max(0, liveIds(state).indexOf(Number(state.self)));
  for (const sid of Object.keys(state.survivors).sort()) {
    const s = state.survivors[sid];
    if (s.delivered) continue;
    if (s.foundBy === Number(state.self)) return sid;
    const since = Math.max(state.heldSince[sid] ?? now, state.noRouteSince ?? now);
    if (now - since >= muleStagger * (rank + 1)) return sid;
  }
  return null;
}

/**
 * Home strip: the column range [c0, c1) for `id`, from the launch list. It
 * never changes, so a drone keeps searching its own ground however little it
 * can hear. Strips of failed drones get picked up once neighbours finish theirs.
 */
export function homeSector(state, id, cols) {
  const rank = state.fleet.indexOf(Number(id));
  if (rank < 0) return null;
  const n = state.fleet.length;
  return [Math.floor((rank * cols) / n), Math.floor(((rank + 1) * cols) / n)];
}

/** n points evenly spaced along a polyline (normalised coords). */
export function formationSlots(n, polyline = FORMATION_POLYLINE) {
  const segs = [];
  let total = 0;
  for (let i = 0; i + 1 < polyline.length; i++) {
    const [ax, ay] = polyline[i];
    const [bx, by] = polyline[i + 1];
    const L = Math.hypot(bx - ax, by - ay);
    segs.push({ ax, ay, bx, by, L });
    total += L;
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    let s = n === 1 ? total / 2 : (total * i) / (n - 1);
    for (const g of segs) {
      if (s <= g.L + 1e-9) {
        const t = g.L ? s / g.L : 0;
        out.push([g.ax + (g.bx - g.ax) * t, g.ay + (g.by - g.ay) * t]);
        break;
      }
      s -= g.L;
    }
  }
  return out;
}

/**
 * Drones with recent news. Quicker than the failed mark, which waits longer to
 * avoid false alarms: a gap in a formation is cheap to close and to reopen.
 */
function presentIds(state) {
  return liveIds(state).filter((id) => {
    const news = state.news[id];
    return id === Number(state.self) || !news || state.listened - news.at <= DEFAULTS.slotTimeout;
  });
}

/**
 * Formation slot for a drone: present drones in id order take slots in order
 * along the shape. When one goes silent, everyone after it slides one place —
 * the "defender moves into the middle" move — and every drone works this out
 * from its own roster.
 */
export function formationSlotFor(state, id, polyline = FORMATION_POLYLINE) {
  const live = presentIds(state);
  const rank = live.indexOf(Number(id));
  if (rank < 0) return null;
  return formationSlots(live.length, polyline)[rank];
}
