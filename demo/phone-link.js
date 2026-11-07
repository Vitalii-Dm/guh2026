// phone-link.js — the big screen's side of phone mode. It starts the mission,
// keeps the laptop's drones on the same clock as the phones, and carries
// messages between the simulation and the phones.
import { DT } from './drone.js';
import { createNet } from './net.js';
import { LAPTOP_ID, droneOf, measureClock, netId } from './mission.js';

const MISSION_POLL_MS = 1000;

function tabId() {
  const make = () => Math.random().toString(36).slice(2);
  try {
    const id = sessionStorage.getItem('big-screen-tab') ?? make();
    sessionStorage.setItem('big-screen-tab', id);
    return id;
  } catch {
    return make();
  }
}

const post = (path, body) => fetch(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

/**
 * @param {object} o
 * @param {number} o.seed
 * @param {number} o.fleet  how many drones, phones included
 * @param {boolean} [o.restart]  replace a mission that is flying
 * @param {(mission: object|null, connected: number[]) => void} o.onUpdate  redraw the phones panel
 * @param {(why: 'busy'|'replaced'|'failed') => void} o.onStopped  this page is not running the mission
 * @param {(mission: object) => void} o.onResume  this page was reloaded or reopened during a run: rejoin it
 */
export function createPhoneLink({ seed, fleet, restart = false, onUpdate, onStopped, onResume }) {
  const net = createNet({ selfId: LAPTOP_ID, onLog: (text) => console.debug('net:', text) });
  let mission = null, offset = 0, world = null, lastSettings = '', stopped = false, poller = null;

  // Survives a reload of this tab, so the helper can tell it from a second big screen.
  const tab = tabId();

  const connected = () => net.peers().filter((p) => p.up).map((p) => droneOf(p.id)).filter(Boolean);
  const update = () => onUpdate(mission, connected());

  function settings() {
    const { radio, range, los, mode, blackout } = world;
    return { kind: 'world', radio, range, los, mode, blackout: Array.from(blackout).join('') };
  }

  function stop(why) {
    stopped = true;
    clearInterval(poller);
    net.stop();
    onStopped(why);
  }

  async function watch() {
    try {
      const latest = await (await fetch('/mission')).json();
      if (stopped) return;
      if (!latest.id) {
        // The helper restarted and forgot: give it the mission back.
        const { id, seed: s, fleet: f, launchAt, claims } = mission;
        await post('/mission', { restore: { id, seed: s, fleet: f, launchAt, claims, tab } });
        return;
      }
      if (latest.id !== mission.id) return stop('replaced');
      mission = latest;
      update();
    } catch { /* the helper is away: running links don't need it */ }
  }

  (async () => {
    const res = await post('/mission', { seed, fleet, restart, tab });
    if (res.status === 409) return stop('busy');
    if (!res.ok) throw new Error(`/mission: ${res.status}`);
    mission = await res.json();
    offset = await measureClock();
    if (mission.resume) onResume(mission);
    net.start();
    update();
    poller = setInterval(watch, MISSION_POLL_MS);
  })().catch(() => stop('failed'));

  net.onMessage((body) => { if (body.kind === 'drone') world?.applyRemote(body); });
  net.onPeer((id, up) => {
    const drone = droneOf(id);
    if (!drone) return;
    if (!up) world?.remoteLost(drone);
    else if (world) net.sendTo(id, settings());
    update();
  });

  return {
    /** Drones claimed by phones. */
    claimed: () => mission?.drones ?? [],

    connected,

    async launch() {
      const res = await post('/launch');
      if (!res.ok) throw new Error(`/launch: ${res.status}`);
      const launched = await res.json();
      if (launched.id !== mission.id) { stop('replaced'); throw new Error('replaced'); }
      mission = launched;
      update();
    },

    /** Use this sim from now on. Any phone not linked yet starts out of contact. */
    attach(sim) {
      world = sim;
      for (const drone of sim.drones) if (drone.remote && !connected().includes(drone.id)) sim.remoteLost(drone.id);
    },

    /** How many motion steps the mission should have run by now, or null if it isn't flying here. */
    targetSteps() {
      if (stopped || mission?.launchAt == null || !world) return null;
      const elapsed = Date.now() + offset - mission.launchAt;
      return elapsed < 0 ? 0 : Math.floor(elapsed / (DT * 1000)) + 1;
    },

    /** Call once per tick: send each phone what it can hear, and the settings. */
    sendTick() {
      if (stopped || !world) return;
      const current = settings();
      const text = JSON.stringify(current);
      // A change goes out at once. It's repeated every few seconds in case a
      // phone missed it, as there's no other sign that it did.
      if (text !== lastSettings) { net.send(current); lastSettings = text; }
      for (const drone of connected()) net.sendTo(netId(drone), { kind: 'outbox', settings: world.tick % 32 === 0 ? current : undefined, ...world.outbox(drone) });
    },
  };
}
