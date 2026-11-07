// phone-drone.js — one drone running on its own device. No DOM and no network:
// messages go in through receive() and come out of advance(). During an outage
// nothing arrives and it carries on, because it needs nothing from anyone.
import * as R from '../recovery/swarm-recovery.js';
import { COLS, ROWS, DT, TICK_STEPS, N_DRONES, canHear, cellsInView, chooseTarget, createDrone, fly, makeSurvivors, peopleInView } from './drone.js';
import { PHONE_SPEED } from './mission.js';

const MAX_CATCH_UP = 5;    // ticks to replay if a little late. Beyond this the device slept, and sleeping is not flying
const STALE_TICKS = 6;     // about a second. A message older than this is out of date
const CELLS = COLS * ROWS;
const HEARD_DIRECTLY_TICKS = 6;   // a drone's own message beats the big screen's older word on it

/**
 * @param {object} o
 * @param {number} o.id       the drone this device flies
 * @param {number} o.seed     mission seed: gives the same people as every other device
 * @param {object} o.terrain  from makeTerrain(seed, ...)
 */
export function createPhoneDrone({ id, seed, terrain, ids = Array.from({ length: N_DRONES }, (_, i) => i + 1), speed = PHONE_SPEED, onFound = () => {} }) {
  const drone = createDrone(id, ids);
  const people = makeSurvivors(seed, terrain);
  const world = { tick: 0, mode: 'search', radio: true, range: 190, los: true, terrain, blackout: new Uint8Array(COLS * ROWS) };
  // Each sender's latest message stays in use until it's out of date. A message
  // that misses a tick must not read as silence, and merging one twice is harmless.
  const heard = new Map();
  const others = new Map();    // drone id -> { x, y, alive, inContact, seen }, for drawing only
  const own = { cols: COLS, visited: new Array(Math.ceil(CELLS / 32)).fill(0) };   // cells this drone flew over

  function protocolTick() {
    for (const [sender, m] of heard) if (m.tick < world.tick - STALE_TICKS) heard.delete(sender);
    const inbox = [...heard.values()].filter((m) => canHear(drone, m, world));
    phone.heardCount = inbox.length;
    phone.heardDrones = inbox.filter((m) => !m.isBase).length;
    const { hubStatus, mode } = R.step(drone.state, inbox.map((m) => m.snapshot), world.tick);
    Object.assign(drone, { hubStatus, commsMode: mode, target: chooseTarget(drone, world) });
  }

  function move() {
    if (!drone.target) return;
    fly(drone, DT, speed);
    for (const [c, r] of cellsInView(drone)) {
      if (!R.isVisited(drone.state, c, r)) {
        phone.firstLook++;
        if (phone.offline) phone.offlineCells[r * COLS + c] = 1;
      }
      R.recordVisit(drone.state, c, r);
      R.recordVisit(own, c, r);
    }
    for (const s of peopleInView(drone, people)) {
      R.recordSurvivor(drone.state, s.id, s.x, s.y, world.tick);
      onFound(s);
    }
  }

  const phone = {
    drone,
    world,
    people,
    others,
    own,
    heardCount: 0,            // nodes heard in the last tick, base included
    heardDrones: 0,           // the same without base
    offline: false,           // set by the page while no device is linked
    firstLook: 0,             // cells this drone was the first it knows of to search
    offlineCells: new Uint8Array(CELLS),   // those it searched while offline

    /** A message from another device: a drone, or base. */
    receive(m) {
      if (m.id === id) return;
      heard.set(m.id, m);
      if (m.id !== R.BASE_ID) others.set(m.id, { x: m.x, y: m.y, alive: true, inContact: true, seen: world.tick, direct: world.tick });
    },

    /** Everyone's positions from the big screen, for drawing. */
    setPositions(list) {
      for (const p of list) {
        const known = others.get(p.id);
        const direct = known?.direct ?? -Infinity;
        if (p.id !== id && world.tick - direct > HEARD_DIRECTLY_TICKS) others.set(p.id, { ...p, seen: world.tick, direct });
      }
    },

    /** Radio settings from the big screen, which the presenter can change. */
    setWorld({ radio, range, los, mode, blackout }) {
      Object.assign(world, { radio, range, los, mode });
      for (let i = 0; i < world.blackout.length; i++) world.blackout[i] = blackout.charCodeAt(i) - 48;
    },

    /** What a reloaded page needs to carry on from here. Plain JSON. */
    save() {
      const { x, y, angle, target, task, state, restUntil, atBaseTicks, muling } = drone;
      return { x, y, angle, target, task, state, restUntil, atBaseTicks, muling, tick: world.tick, own: own.visited, firstLook: phone.firstLook, offlineCells: phone.offlineCells.join('') };
    },

    restore({ tick, own: flown, firstLook, offlineCells, ...saved }) {
      Object.assign(drone, saved);
      world.tick = tick;
      own.visited = flown;
      phone.firstLook = firstLook;
      for (let i = 0; i < CELLS; i++) phone.offlineCells[i] = offlineCells.charCodeAt(i) - 48;
    },

    /** Run up to this tick. Returns the message to send, or null if no tick passed. */
    advance(target) {
      if (target <= world.tick) return null;
      if (target - world.tick > MAX_CATCH_UP) world.tick = target - 1;
      while (world.tick < target) {
        world.tick++;
        protocolTick();
        for (let i = 0; i < TICK_STEPS; i++) move();
      }
      const { x, y, angle, task, hubStatus, commsMode: mode, muling } = drone;
      return { kind: 'drone', id, tick: world.tick, x, y, angle, task, hubStatus, mode, muling, own: own.visited, snapshot: R.snapshot(drone.state) };
    },
  };
  return phone;
}
