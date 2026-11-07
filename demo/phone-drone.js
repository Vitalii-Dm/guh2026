// phone-drone.js — one drone running on its own device. No DOM and no network:
// messages go in through receive() and come out of advance(). During an outage
// nothing arrives and it carries on, because it needs nothing from anyone.
import * as R from '../recovery/swarm-recovery.js';
import { COLS, ROWS, DT, TICK_STEPS, N_DRONES, canHear, cellsInView, chooseTarget, createDrone, fly, makeSurvivors, peopleInView } from './drone.js';
import { PHONE_SPEED } from './mission.js';

const MAX_CATCH_UP = 5;    // ticks to replay if a little late. Beyond this the device slept, and sleeping is not flying
const STALE_TICKS = 3;     // a message older than this is out of date

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
  const heard = new Map();     // sender -> its latest message, waiting for the next tick
  const others = new Map();    // drone id -> { x, y, alive, inContact }, for drawing only

  function protocolTick() {
    const inbox = [...heard.values()].filter((m) => m.tick >= world.tick - STALE_TICKS && canHear(drone, m, world));
    heard.clear();
    phone.heardCount = inbox.length;
    const { hubStatus, mode } = R.step(drone.state, inbox.map((m) => m.snapshot), world.tick);
    Object.assign(drone, { hubStatus, commsMode: mode, target: chooseTarget(drone, world) });
  }

  function move() {
    if (!drone.target) return;
    fly(drone, DT, speed);
    for (const [c, r] of cellsInView(drone)) R.recordVisit(drone.state, c, r);
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
    heardCount: 0,

    /** A message from another device: a drone, or base. */
    receive(m) {
      if (m.id === id) return;
      heard.set(m.id, m);
      if (m.id !== R.BASE_ID) others.set(m.id, { ...others.get(m.id), x: m.x, y: m.y, alive: true, inContact: true });
    },

    /** Everyone's positions from the big screen, for drawing. */
    setPositions(list) {
      for (const p of list) if (p.id !== id) others.set(p.id, p);
    },

    /** Radio settings from the big screen, which the presenter can change. */
    setWorld({ radio, range, los, mode, blackout }) {
      Object.assign(world, { radio, range, los, mode });
      for (let i = 0; i < world.blackout.length; i++) world.blackout[i] = blackout.charCodeAt(i) - 48;
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
      const { x, y, angle, task, hubStatus, commsMode: mode } = drone;
      return { kind: 'drone', id, tick: world.tick, x, y, angle, task, hubStatus, mode, snapshot: R.snapshot(drone.state) };
    },
  };
  return phone;
}
