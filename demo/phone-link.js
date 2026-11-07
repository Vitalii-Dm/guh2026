// phone-link.js — the big screen's side of phone mode. It starts the mission,
// keeps the laptop's drones on the same clock as the phones, and carries
// messages between the simulation and the phones.
import { DT } from './drone.js';
import { createNet } from './net.js';
import { LAPTOP_ID, droneOf, measureClock, netId } from './mission.js';

const MISSION_POLL_MS = 1000;

const postJson = async (path, body) => {
  const res = await fetch(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};

/**
 * @param {object} o
 * @param {number} o.seed
 * @param {number} o.fleet  how many drones, phones included
 * @param {(mission: object|null, connected: number[]) => void} o.onUpdate  redraw the phones panel
 * @param {(error: Error) => void} o.onError
 */
export function createPhoneLink({ seed, fleet, onUpdate, onError }) {
  const net = createNet({ selfId: LAPTOP_ID, onLog: (text) => console.debug('net:', text) });
  let mission = null, offset = 0, world = null, lastSettings = '';

  const connected = () => net.peers().filter((p) => p.up).map((p) => droneOf(p.id)).filter(Boolean);
  const update = () => onUpdate(mission, connected());

  function settings() {
    const { radio, range, los, mode, blackout } = world;
    return { kind: 'world', radio, range, los, mode, blackout: Array.from(blackout).join('') };
  }

  net.onMessage((body) => { if (body.kind === 'drone') world?.applyRemote(body); });
  net.onPeer((id, up) => {
    const drone = droneOf(id);
    if (!drone) return;
    if (!up) world?.remoteLost(drone);
    else if (world) net.sendTo(id, settings());
    update();
  });

  (async () => {
    mission = await postJson('/mission', { seed, fleet });
    offset = await measureClock();
    net.start();
    update();
    setInterval(async () => {
      try {
        mission = await (await fetch('/mission')).json();
        update();
      } catch { /* the helper is away: running links don't need it */ }
    }, MISSION_POLL_MS);
  })().catch(onError);

  return {
    /** Drones claimed by phones. */
    claimed: () => mission?.drones ?? [],

    async launch() {
      mission = await postJson('/launch');
      update();
    },

    /** Use this sim from now on. Any phone not linked yet starts out of contact. */
    attach(sim) {
      world = sim;
      for (const drone of sim.drones) if (drone.remote && !connected().includes(drone.id)) sim.remoteLost(drone.id);
    },

    /** How many motion steps the mission should have run by now, or null before launch. */
    targetSteps() {
      if (mission?.launchAt == null) return null;
      const elapsed = Date.now() + offset - mission.launchAt;
      return elapsed < 0 ? 0 : Math.floor(elapsed / (DT * 1000)) + 1;
    },

    /** Call once per tick: send each phone what it can hear, and any changed settings. */
    sendTick() {
      const current = settings();
      const text = JSON.stringify(current);
      if (text !== lastSettings) { net.send(current); lastSettings = text; }
      for (const drone of connected()) net.sendTo(netId(drone), { kind: 'outbox', ...world.outbox(drone) });
    },
  };
}
