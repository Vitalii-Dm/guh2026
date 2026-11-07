// The phone page: this device flies one drone. phone-drone.js does the flying,
// net.js the links; this file joins them up and shows what the drone has explored.
import * as R from '../recovery/swarm-recovery.js';
import { W, H, CELL, COLS, ROWS, BASE, SENSE } from './drone.js';
import { makeTerrain } from './terrain.js';
import { createNet } from './net.js';
import { createPhoneDrone } from './phone-drone.js';
import { LAPTOP_ID, NOT_CONNECTED, TICK_MS, measureClock, missionTick, netId } from './mission.js';

const JOIN_RETRY_MS = 1000, MISSION_POLL_MS = 1000, RUN_MS = 40, REPORT_MS = 2000;
const SHOW_RETURN_MS = 8000;    // how long "back online" stays up
const SHOW_FOUND_MS = 8000;
const POSITION_STALE_TICKS = 12;  // a drone not heard of for this long is drawn as out of date
const MAX_LOG_LINES = 300;
const CELLS = COLS * ROWS;
// Unexplored ground is dark. Explored ground is tinted by who explored it.
const SHADE = { unexplored: 'rgba(6,10,14,0.86)', others: 'rgba(106,168,255,0.6)', mine: 'rgba(43,212,196,0.7)', offline: 'rgba(255,212,0,0.78)' };
const SAVE_MS = 2000;           // a reloaded page carries on from its last save
const FIRST_LINK_GRACE_MS = 5000;  // a page that has just loaded is connecting, not offline

const $ = (id) => document.getElementById(id);
const ctx = $('map').getContext('2d');
const shade = Object.assign(document.createElement('canvas'), { width: COLS, height: ROWS });
const shadeCtx = shade.getContext('2d');
const logLines = [];

function log(text) {
  logLines.push(`${(performance.now() / 1000).toFixed(1).padStart(6)}s ${text}`);
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
}

function show(tone, headline, detail = '') {
  $('status').className = `status ${tone}`;
  $('headline').textContent = headline;
  $('detail').textContent = detail;
}

function remembered(key, make) {
  try {
    const value = localStorage.getItem(key) ?? make();
    localStorage.setItem(key, value);
    return value;
  } catch {
    return make();
  }
}

async function retrying(work) {
  for (;;) {
    try { return await work(); } catch { await new Promise((done) => setTimeout(done, JOIN_RETRY_MS)); }
  }
}

async function join() {
  // Kept across reloads and new tabs, so a phone keeps its drone.
  const key = remembered('phone-key', () => `p${crypto.getRandomValues(new Uint32Array(2)).join('')}`);
  const prefer = Number(remembered('phone-drone', () => '0'));
  for (;;) {
    try {
      const res = await fetch('/join', { method: 'POST', body: JSON.stringify({ key, prefer }) });
      const body = await res.json();
      if (res.ok) return body;
      if (body.error === 'full') show('bad', 'The swarm is full', 'All the phone drones are taken.');
      else if (body.error === 'launched') show('bad', 'Already launched', 'Waiting for the next run. This page will join by itself.');
      else show('warn', 'Waiting for the big screen', 'Open it on the laptop.');
    } catch {
      show('warn', 'Looking for the laptop', 'Check this phone is on the same Wi-Fi.');
    }
    await new Promise((done) => setTimeout(done, JOIN_RETRY_MS));
  }
}

const joined = await join();
const { drone: droneId, seed, fleet, id: missionId, logs } = joined;
let launchAt = joined.launchAt;
let clock = joined.clock;        // the mission clock: launch time and speed
try { localStorage.setItem('phone-drone', droneId); } catch { /* it just won't be remembered */ }
const offset = await retrying(() => measureClock());
const helperNow = () => Date.now() + offset;
log(`joined as drone ${droneId}, clock offset ${Math.round(offset)} ms`);

$('drone').textContent = droneId;
const terrain = makeTerrain(seed, W, H, BASE);
const ids = Array.from({ length: fleet }, (_, i) => i + 1);
let foundAt = 0;
const phone = createPhoneDrone({
  id: droneId, seed, terrain, ids,
  onFound: (s) => { foundAt = Date.now(); log(`found person ${s.id}`); },
});
const { drone, world } = phone;

// If this page was reloaded during this run, the drone carries on where it was.
const saveKey = `phone-run-${missionId}-${droneId}`;
try {
  const saved = JSON.parse(localStorage.getItem(saveKey));
  if (saved) { phone.restore(saved); log(`restored at tick ${saved.tick}`); }
} catch { /* nothing saved, or storage is off: it starts from launch */ }

const net = createNet({ selfId: netId(droneId), onLog: log });
net.onMessage((body) => {
  if (body.kind === 'outbox') {
    phone.setPositions(body.positions);
    body.messages.forEach(phone.receive);
    if (body.settings) phone.setWorld(body.settings);
  }
  if (body.kind === 'world') phone.setWorld(body);
  if (body.kind === 'drone') phone.receive(body);
});
net.start();

// An outage counts once the drone is flying and either this phone has been
// linked or it has had time to be, so a reload isn't mistaken for one.
const pageStart = Date.now();
let linkedOnce = false, offlineFrom = null, returned = null, baseOnce = false;
function trackOutage(linked) {
  if (linked) linkedOnce = true;
  const flying = launchAt !== null && helperNow() >= launchAt;
  phone.offline = !linked && flying && (linkedOnce || !net.radioOn() || Date.now() - pageStart > FIRST_LINK_GRACE_MS);
  if (phone.offline && offlineFrom === null) { offlineFrom = phone.firstLook; returned = null; log('offline'); }
  if (linked && offlineFrom !== null) {
    returned = { cells: phone.firstLook - offlineFrom, at: Date.now() };
    log(`back online with ${returned.cells} cells searched alone`);
    offlineFrom = null;
  }
}

const cellsText = (n) => `${n} ${n === 1 ? 'cell' : 'cells'}`;

function phonesText(links) {
  const n = links.filter((p) => p.id !== LAPTOP_ID).length;
  return n ? `${n} other ${n === 1 ? 'phone' : 'phones'}` : '';
}

function radioText() {
  const n = phone.heardDrones;
  const base = phone.heardCount > n;
  const heard = !world.radio ? 'Radio cut from the big screen'
    : n ? `Hears ${n} ${n === 1 ? 'drone' : 'drones'}${base ? ' and base' : ''}` : base ? 'Hears base' : 'Hears nobody over radio';
  const hub = R.isHub(drone.state) ? 'This drone is the hub' : `Hub: drone ${drone.state.hub.id}`;
  return `${heard}. ${hub}.`;
}

function updateCounts() {
  let mine = 0, offline = 0, others = 0;
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (phone.offlineCells[r * COLS + c]) offline++;
      else if (R.isVisited(phone.own, c, r)) mine++;
      else if (R.isVisited(drone.state, c, r)) others++;
    }
  }
  const pct = (n) => `${(n / CELLS) * 100}%`;
  $('searched').textContent = `${Math.round(((mine + offline + others) / CELLS) * 100)}%`;
  $('barMine').style.width = pct(mine); $('barOffline').style.width = pct(offline); $('barOthers').style.width = pct(others);
  $('nMine').textContent = mine; $('nOffline').textContent = offline; $('nOthers').textContent = others;
  $('nLeft').textContent = CELLS - mine - offline - others;
  $('found').textContent = Object.keys(drone.state.survivors).length;
}

function updateStatus() {
  const links = net.peers().filter((p) => p.up);
  const linked = links.length > 0;
  baseOnce ||= links.some((p) => p.id === LAPTOP_ID);
  trackOutage(linked);
  updateCounts();
  $('foundBanner').hidden = Date.now() - foundAt > SHOW_FOUND_MS;
  $('foundBanner').textContent = 'You found someone!';

  const connection = !net.radioOn() ? 'Radio off.' : linked ? 'Connected.' : 'Connecting to the swarm.';
  if (launchAt === null) {
    $('doing').textContent = '';
    return show(linked && net.radioOn() ? 'good' : 'warn', `You are drone ${droneId}`, `${connection} Waiting for launch.`);
  }
  const wait = launchAt - helperNow();
  if (wait > 0) return show(linked && net.radioOn() ? 'good' : 'warn', `Launching in ${Math.ceil(wait / 1000)}`, `You are drone ${droneId}. ${connection}`);

  // What the drone is really doing, whatever the network is doing.
  $('doing').textContent = `Drone ${droneId} is ${drone.task}.`;
  $('radioLine').textContent = radioText();
  const gained = offlineFrom === null ? 0 : phone.firstLook - offlineFrom;
  if (!net.radioOn()) return show('warn', 'RADIO OFF', `${cellsText(gained)} explored alone. This is a button, not a real outage.`);
  if (!linked) return show('warn', phone.offline ? 'NOT CONNECTED' : 'CONNECTING', phone.offline ? `${cellsText(gained)} explored alone. The drone carries on by itself.` : 'Linking to the swarm.');
  const toBase = links.some((p) => p.id === LAPTOP_ID);
  if (!toBase && baseOnce) return show('warn', 'BIG SCREEN LOST', `Still linked to ${phonesText(links)}.`);
  if (returned && Date.now() - returned.at < SHOW_RETURN_MS) return show('good', 'CONNECTED', `Back, with ${cellsText(returned.cells)} explored alone.`);
  const others = phonesText(links);
  show('good', 'CONNECTED', toBase ? `Linked to the big screen${others ? ` and ${others}` : ''}.` : `Linked to ${others}.`);
}

function run() {
  if (launchAt === null || !clock || helperNow() < launchAt) return;
  const message = phone.advance(missionTick(helperNow(), clock));
  if (message) net.send(message);
}

function drawDot(x, y, colour, radius) {
  ctx.fillStyle = colour;
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
}

function label(text, x, y, colour) {
  ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(4,8,12,0.85)'; ctx.strokeText(text, x, y);
  ctx.fillStyle = colour; ctx.fillText(text, x, y);
}

function draw() {
  ctx.drawImage(terrain.canvas, 0, 0);
  shadeCtx.clearRect(0, 0, COLS, ROWS);
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      shadeCtx.fillStyle = phone.offlineCells[r * COLS + c] ? SHADE.offline
        : R.isVisited(phone.own, c, r) ? SHADE.mine
          : R.isVisited(drone.state, c, r) ? SHADE.others : SHADE.unexplored;
      shadeCtx.fillRect(c, r, 1, 1);
    }
  }
  ctx.imageSmoothingEnabled = false;    // keep cells square, so explored ground has a clear edge
  ctx.drawImage(shade, 0, 0, W, H);

  const [c0, c1] = R.homeSector(drone.state, droneId, COLS);
  ctx.strokeStyle = '#ffffff'; ctx.setLineDash([10, 8]); ctx.lineWidth = 3;
  ctx.strokeRect(c0 * CELL + 2, 2, (c1 - c0) * CELL - 4, H - 4);
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(190,40,50,0.5)';
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (world.blackout[r * COLS + c]) ctx.fillRect(c * CELL, r * CELL, CELL, CELL);

  ctx.textAlign = 'center'; ctx.font = '800 26px system-ui';
  drawDot(BASE.x, BASE.y - 6, '#f2f5f8', 16);
  ctx.fillStyle = '#10151b'; ctx.fillText('H', BASE.x, BASE.y + 3);

  for (const r of Object.values(drone.state.survivors)) {
    const colour = r.delivered ? '#3fb950' : '#ff7a59';
    drawDot(r.x, r.y, colour, 12);
    ctx.font = '700 24px system-ui';
    label(r.delivered ? 'REPORTED' : 'SOS', r.x, r.y - 20, colour);
  }

  for (const o of phone.others.values()) {
    if (o.alive === false) continue;
    const outOfDate = o.inContact === false || world.tick - o.seen > POSITION_STALE_TICKS;
    drawDot(o.x, o.y, outOfDate ? 'rgba(150,160,170,0.5)' : '#eef3f8', 9);
  }

  const linked = net.peers().some((p) => p.up) && net.radioOn();
  ctx.strokeStyle = linked ? '#ffffff' : NOT_CONNECTED; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(drone.x, drone.y, SENSE + 6, 0, Math.PI * 2); ctx.stroke();
  drawDot(drone.x, drone.y, linked ? '#2bd4c4' : NOT_CONNECTED, 13);
  ctx.font = '800 30px system-ui';
  label(droneId, drone.x, drone.y + 54 > H - 6 ? drone.y - 34 : drone.y + 54, '#ffffff');   // keep it on the map
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
    if (!mission.id) return;                                  // the helper restarted: the big screen will restore it
    if (mission.id !== missionId) return location.reload();   // the big screen started a new run
    if (!mission.drones.includes(droneId)) return location.reload();  // this page was away and lost its drone
    if (launchAt === null && mission.launchAt !== null) { launchAt = mission.launchAt; log(`launch at ${launchAt}`); }
    if (mission.clock && JSON.stringify(mission.clock) !== JSON.stringify(clock)) { clock = mission.clock; log(`speed ${clock.rate}x`); }
  } catch { /* no network: nothing here changes what the drone does */ }
}

function save() {
  if (world.tick === 0) return;
  try { localStorage.setItem(saveKey, JSON.stringify(phone.save())); } catch { /* it just won't survive a reload */ }
}

setInterval(run, RUN_MS);
setInterval(save, SAVE_MS);
setInterval(updateStatus, TICK_MS);
setInterval(watchMission, MISSION_POLL_MS);
if (logs) {
  // Only with PHONE_LOGS=1, so rehearsals can be read on the laptop.
  setInterval(() => {
    const text = `${navigator.userAgent}\nsecure: ${isSecureContext}\n${logLines.join('\n')}`;
    fetch('/report', { method: 'POST', body: JSON.stringify({ id: netId(droneId), text }) }).catch(() => {});
  }, REPORT_MS);
}
document.addEventListener('visibilitychange', () => log(`page ${document.visibilityState}`));
requestAnimationFrame(draw);
