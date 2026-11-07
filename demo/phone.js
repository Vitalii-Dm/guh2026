// The phone page: this device flies one drone. phone-drone.js does the flying,
// net.js the links; this file joins them up and draws what the drone knows.
import * as R from '../recovery/swarm-recovery.js';
import { W, H, CELL, COLS, ROWS, BASE, SENSE } from './drone.js';
import { makeTerrain } from './terrain.js';
import { createNet } from './net.js';
import { createPhoneDrone } from './phone-drone.js';
import { TICK_MS, measureClock, missionTick, netId } from './mission.js';

const JOIN_RETRY_MS = 1000, MISSION_POLL_MS = 1000, RUN_MS = 40, REPORT_MS = 2000;
const SHOW_RETURN_MS = 8000;    // how long "back online" stays up

const $ = (id) => document.getElementById(id);
const ctx = $('map').getContext('2d');
const fog = Object.assign(document.createElement('canvas'), { width: COLS, height: ROWS });
const fogCtx = fog.getContext('2d');
const logLines = [];

function log(text) { logLines.push(`${(performance.now() / 1000).toFixed(1).padStart(6)}s ${text}`); }

const cellCount = (n) => `${n} new ${n === 1 ? 'cell' : 'cells'}`;

function show(tone, headline, detail = '') {
  $('status').className = `status ${tone}`;
  $('headline').textContent = headline;
  $('detail').textContent = detail;
}

/** Stays the same across reloads, so a reloaded phone gets its drone back. */
function phoneKey() {
  try {
    const key = sessionStorage.getItem('phone-key') ?? `p${crypto.getRandomValues(new Uint32Array(2)).join('')}`;
    sessionStorage.setItem('phone-key', key);
    return key;
  } catch {
    return `p${crypto.getRandomValues(new Uint32Array(2)).join('')}`;
  }
}

async function join() {
  const key = phoneKey();
  for (;;) {
    try {
      const res = await fetch('/join', { method: 'POST', body: JSON.stringify({ key }) });
      const body = await res.json();
      if (res.ok) return body;
      if (body.error === 'full') show('bad', 'The swarm is full', 'All the phone drones are taken.');
      else if (body.error === 'launched') show('bad', 'Already launched', 'Reload the big screen on the laptop to start a new run. This phone will join by itself.');
      else show('warn', 'Waiting for the big screen', 'Open it on the laptop.');
    } catch {
      show('warn', 'Looking for the laptop', 'Check this phone is on the same Wi-Fi.');
    }
    await new Promise((done) => setTimeout(done, JOIN_RETRY_MS));
  }
}

const joined = await join();
const { drone: droneId, seed, fleet, id: missionId } = joined;
let launchAt = joined.launchAt;
const offset = await measureClock();
const helperNow = () => Date.now() + offset;
log(`joined as drone ${droneId}, clock offset ${Math.round(offset)} ms`);

$('drone').textContent = droneId;
const terrain = makeTerrain(seed, W, H, BASE);
const ids = Array.from({ length: fleet }, (_, i) => i + 1);
const phone = createPhoneDrone({ id: droneId, seed, terrain, ids, onFound: (s) => log(`found person ${s.id}`) });
const { drone, world } = phone;

const net = createNet({ selfId: netId(droneId), onLog: log });
net.onMessage((body) => {
  if (body.kind === 'outbox') {
    phone.setPositions(body.positions);
    body.messages.forEach(phone.receive);
  }
  if (body.kind === 'world') phone.setWorld(body);
  if (body.kind === 'drone') phone.receive(body);
});
net.start();

// What came back from an outage, for the status line.
let offlineFrom = null, returned = null;
function trackOutage(linked) {
  const cells = R.visitedCount(drone.state);
  if (!linked && offlineFrom === null && launchAt !== null) { offlineFrom = cells; returned = null; log('offline'); }
  if (linked && offlineFrom !== null) {
    returned = { cells: cells - offlineFrom, at: Date.now() };
    log(`back online with ${returned.cells} new cells`);
    offlineFrom = null;
  }
}

function updateStatus() {
  const links = net.peers().filter((p) => p.up);
  const linked = links.length > 0;
  trackOutage(linked);
  $('searched').textContent = `${Math.round((R.visitedCount(drone.state) / (COLS * ROWS)) * 100)}%`;
  $('found').textContent = Object.keys(drone.state.survivors).length;

  if (launchAt === null) return show(linked ? 'good' : 'warn', `You are drone ${droneId}`, linked ? 'Linked. Waiting for launch.' : 'Waiting for launch. Connecting to the swarm.');
  const wait = launchAt - helperNow();
  if (wait > 0) return show('good', `Launching in ${Math.ceil(wait / 1000)}`, `You are drone ${droneId}.`);
  const gained = offlineFrom === null ? 0 : R.visitedCount(drone.state) - offlineFrom;
  if (!net.radioOn()) return show('warn', 'Radio off: still searching', `${cellCount(gained)} since the radio went off. This is a button, not a real network failure.`);
  if (!linked) return show('bad', 'No network: still searching', `${cellCount(gained)} searched alone.`);
  if (returned && Date.now() - returned.at < SHOW_RETURN_MS) return show('good', 'Back online', `Bringing back ${cellCount(returned.cells)} searched alone.`);
  const n = phone.heardCount;
  show('good', `Drone ${droneId}: ${drone.task}`, n ? `Radio: hearing ${n} ${n === 1 ? 'neighbour' : 'neighbours'}.` : 'Network up, but nobody in radio range.');
}

function run() {
  if (launchAt === null || helperNow() < launchAt) return;
  const message = phone.advance(missionTick(helperNow(), launchAt));
  if (message) net.send(message);
}

function drawDot(x, y, colour, radius) {
  ctx.fillStyle = colour;
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
}

function draw() {
  ctx.drawImage(terrain.canvas, 0, 0);
  fogCtx.clearRect(0, 0, COLS, ROWS);
  fogCtx.fillStyle = 'rgba(6,10,16,0.72)';
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (!R.isVisited(drone.state, c, r)) fogCtx.fillRect(c, r, 1, 1);
  ctx.drawImage(fog, 0, 0, W, H);

  const [c0, c1] = R.homeSector(drone.state, droneId, COLS);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.setLineDash([6, 8]); ctx.lineWidth = 2;
  ctx.strokeRect(c0 * CELL, 0, (c1 - c0) * CELL, H);
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(120,24,36,0.42)';
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (world.blackout[r * COLS + c]) ctx.fillRect(c * CELL, r * CELL, CELL, CELL);

  ctx.textAlign = 'center';
  drawDot(BASE.x, BASE.y - 4, '#f2f5f8', 12);
  ctx.fillStyle = '#10151b'; ctx.font = '800 16px system-ui'; ctx.fillText('H', BASE.x, BASE.y + 2);

  for (const r of Object.values(drone.state.survivors)) {
    drawDot(r.x, r.y, r.delivered ? '#3fb950' : '#ff7a59', 11);
    ctx.fillStyle = r.delivered ? '#3fb950' : '#ff7a59'; ctx.font = '700 20px system-ui';
    ctx.fillText(r.delivered ? 'REPORTED' : 'SOS', r.x, r.y - 18);
  }

  for (const o of phone.others.values()) {
    if (o.alive === false) continue;
    drawDot(o.x, o.y, o.inContact === false ? 'rgba(140,155,175,0.5)' : 'rgba(200,215,230,0.75)', 8);
  }

  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(drone.x, drone.y, SENSE, 0, Math.PI * 2); ctx.stroke();
  drawDot(drone.x, drone.y, '#2bb3a8', 11);
  ctx.fillStyle = '#ffffff'; ctx.font = '700 22px system-ui'; ctx.fillText(droneId, drone.x, drone.y + 40);
  requestAnimationFrame(draw);
}

$('radio').hidden = false;
$('radio').onclick = () => {
  net.setRadio(!net.radioOn());
  $('radio').textContent = net.radioOn() ? 'Radio off' : 'Radio on';
  $('radio').classList.toggle('on', !net.radioOn());
};

async function watchMission() {
  try {
    const mission = await (await fetch('/mission')).json();
    if (mission.id !== missionId) return location.reload();   // the big screen started a new run
    if (launchAt === null && mission.launchAt !== null) { launchAt = mission.launchAt; log(`launch at ${launchAt}`); }
  } catch { /* no network: nothing here changes what the drone does */ }
}

setInterval(run, RUN_MS);
setInterval(updateStatus, TICK_MS);
setInterval(watchMission, MISSION_POLL_MS);
// So rehearsals can be read on the laptop without copying logs off a phone.
setInterval(() => {
  const text = `${navigator.userAgent}\nsecure: ${isSecureContext}\n${logLines.join('\n')}`;
  fetch('/report', { method: 'POST', body: JSON.stringify({ id: netId(droneId), text }) }).catch(() => {});
}, REPORT_MS);
document.addEventListener('visibilitychange', () => log(`page ${document.visibilityState}`));
requestAnimationFrame(draw);
