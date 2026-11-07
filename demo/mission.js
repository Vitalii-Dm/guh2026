// mission.js — what the phones and the big screen must agree on: who is who on
// the network, how fast drones fly, and what time it is.
import { DT, TICK_STEPS } from './drone.js';

export const PHONE_DRONES = [1, 2, 3];  // these exist in a swarm of any size
export const MIN_FLEET = 3, MAX_FLEET = 15;
export const PHONE_SPEED = 10;          // px/s: a search of about 2.5 minutes
export const LAUNCH_DELAY_MS = 3000;    // time for every device to hear the launch time
export const TICK_MS = DT * TICK_STEPS * 1000;
export const LAPTOP_ID = 'base';        // sorts below 'drone-…', so the laptop makes the offers
export const NOT_CONNECTED = '#ffd400'; // one colour for this on the big screen and the phones

export const netId = (drone) => `drone-${drone}`;
export const droneOf = (id) => (id.startsWith('drone-') ? Number(id.slice(6)) : null);

/** The tick every device should be on, from the helper's clock. */
export const missionTick = (helperNow, launchAt) => Math.floor((helperNow - launchAt) / TICK_MS) + 1;

/** How far the helper's clock is ahead of this device's, in ms. */
export async function measureClock(request = (...args) => fetch(...args), now = Date.now) {
  let best = null;
  for (let i = 0; i < 5; i++) {
    const sent = now();
    const { now: helper } = await (await request('/time')).json();
    const received = now();
    const trip = received - sent;
    if (!best || trip < best.trip) best = { trip, offset: helper - (sent + received) / 2 };
  }
  return best.offset;
}
