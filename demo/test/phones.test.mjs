// A drone flown on another device, against the real simulation. This runs the
// same phone-drone.js as the phone page: only the network between them is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../../recovery/swarm-recovery.js';
import { createSim, W, H, BASE, COLS, ROWS, DT, TICK_STEPS } from '../sim.js';
import { cellsInView } from '../drone.js';
import { createPhoneDrone } from '../phone-drone.js';
import { makeTerrain } from '../terrain.js';

const SEED = 7, PHONE = 2, SPEED = 10;
const seconds = (s) => Math.round(s / (DT * TICK_STEPS));
const wire = (m) => JSON.parse(JSON.stringify(m));

function setup({ seed = SEED, range = 190 } = {}) {
  const terrain = makeTerrain(seed, W, H, BASE);
  const logs = [];
  const sim = createSim({ seed, terrain, range, speed: SPEED, remoteIds: [PHONE], onLog: (m) => logs.push(m) });
  const core = createPhoneDrone({ id: PHONE, seed, terrain, speed: SPEED });
  core.world.range = range;
  const phone = core.drone;
  const net = { online: true };

  const tick = () => {
    sim.run(1);
    if (net.online) for (const m of sim.outbox(PHONE).messages) core.receive(wire(m));
    const message = core.advance(sim.tick);
    if (net.online) sim.applyRemote(wire(message));
  };
  const run = (ticks) => { for (let i = 0; i < ticks; i++) tick(); };
  const goOffline = () => { net.online = false; sim.remoteLost(PHONE); };
  return { sim, core, phone, net, logs, run, goOffline, mirror: sim.drones.find((d) => d.id === PHONE) };
}

test('the sim does not fly or step a drone that runs elsewhere', () => {
  const terrain = makeTerrain(SEED, W, H, BASE);
  const sim = createSim({ seed: SEED, terrain, remoteIds: [PHONE] });
  const d = sim.drones.find((n) => n.id === PHONE), { x, y } = d;
  const other = sim.drones.find((n) => n.id === PHONE + 1), start = other.y;
  sim.run(50);
  assert.deepEqual([d.x, d.y, d.target], [x, y, null]);
  assert.notEqual(other.y, start, 'simulated drones still fly');
});

test('speed sets how far a drone travels', () => {
  const terrain = makeTerrain(SEED, W, H, BASE);
  const travel = (speed) => {
    const sim = createSim({ seed: SEED, terrain, speed });
    const d = sim.drones[7], { x, y } = d;
    sim.run(10);
    return Math.hypot(d.x - x, d.y - y);
  };
  assert.ok(travel(10) < travel(32) * 0.5);
});

test('a connected phone drone appears on the map and shares what it knows', () => {
  const { sim, core, phone, mirror, run } = setup();
  run(seconds(20));
  assert.deepEqual([mirror.x, mirror.y], [phone.x, phone.y]);
  assert.ok(core.heardCount > 0, 'it should hear a neighbour');
  const neighbour = sim.drones.find((d) => d.id === PHONE + 1);
  assert.equal(R.isVisited(neighbour.state, ...cellsInView(phone)[0]), true);
});

test('offline, the phone keeps searching and the laptop learns nothing', () => {
  const { sim, phone, mirror, run, goOffline } = setup();
  run(seconds(15));
  goOffline();
  const before = { cells: R.visitedCount(phone.state), x: mirror.x, seen: sim.truthVisited.size };
  run(seconds(30));
  assert.equal(mirror.x, before.x, 'the big screen keeps its last position');
  assert.equal(mirror.inContact, false);
  assert.equal(phone.commsMode, 'alone');
  assert.ok(R.visitedCount(phone.state) >= before.cells + 15, `gained ${R.visitedCount(phone.state) - before.cells} cells`);
});

test('reconnecting brings back the ground, clears the failure, and rejoins a hub', () => {
  const { sim, core, phone, net, mirror, logs, run, goOffline } = setup();
  run(seconds(40));              // drones 1 to 3 take up to 34 s to reach their strips
  goOffline();
  run(seconds(30));
  const neighbour = sim.drones.find((d) => d.id === PHONE + 1);
  assert.equal(neighbour.state.roster[PHONE].alive, false, 'the swarm should have written it off by now');
  const unseen = [];
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (R.isVisited(phone.state, c, r) && !sim.truthVisited.has(`${c},${r}`)) unseen.push([c, r]);
  assert.ok(unseen.length >= 15, `the phone holds ${unseen.length} cells nobody else reported`);

  net.online = true;
  run(1);
  assert.equal(mirror.inContact, true);
  for (const [c, r] of unseen) assert.ok(sim.truthVisited.has(`${c},${r}`), 'the map fills in at once');
  assert.ok(logs.some((l) => l.includes('connected again')));

  run(seconds(5));
  assert.ok(core.heardCount > 0);
  assert.equal(neighbour.state.roster[PHONE].alive, true, 'the swarm takes it back');
  assert.ok(unseen.every(([c, r]) => R.isVisited(neighbour.state, c, r)), 'the swarm now knows that ground');
  // Ridges split the swarm, so drones can disagree about the hub with no phone
  // involved. The phone should just hold a hub that some simulated drone holds.
  assert.ok(sim.drones.some((d) => d.id !== PHONE && d.state.hub.id === phone.state.hub.id));
});

test('a report found offline reaches base after reconnecting', () => {
  // Find a seed where the phone's own strip holds someone, and catch them offline.
  for (const seed of [1, 2, 3, 4, 5, 8, 9, 11, 12, 14]) {
    const t = setup({ seed });
    t.run(seconds(5));
    t.goOffline();
    t.run(seconds(100));
    if (!Object.keys(t.phone.state.survivors).some((id) => t.phone.state.survivors[id].foundBy === PHONE)) continue;
    // Another drone may have found the same person. Only the phone's own news counts.
    const held = Object.keys(t.phone.state.survivors).filter((id) => t.phone.state.survivors[id].foundBy === PHONE && !t.sim.base.state.survivors[id]);
    if (!held.length) continue;
    t.net.online = true;
    t.run(seconds(120));
    assert.ok(held.every((id) => t.sim.base.state.survivors[id]), `seed ${seed}: report should reach base`);
    return;
  }
  assert.fail('no seed gave the phone a find');
});

test('a connected phone out of radio range hears nothing and tells nobody', () => {
  const { sim, phone, mirror } = setup({ range: 40 });
  sim.applyRemote({ id: PHONE, tick: 0, x: 20, y: 20, angle: 0, task: 'x', hubStatus: 'ok', mode: 'alone', snapshot: R.snapshot(phone.state) });
  sim.run(1);
  assert.ok(mirror.inContact, 'the real connection is up');
  assert.equal(sim.links.some(([a, b]) => a === mirror || b === mirror), false);
  assert.deepEqual(sim.outbox(PHONE).messages, []);
});

test('messages from a simulated drone id or an old tick are ignored', () => {
  const { sim, mirror, run } = setup();
  run(10);
  const other = sim.drones.find((d) => d.id === 5), { x } = other;
  sim.applyRemote({ id: 5, tick: 99, x: 1, y: 1, snapshot: {} });
  assert.equal(other.x, x);
  const { x: mx } = mirror;
  sim.applyRemote({ id: PHONE, tick: 1, x: 1, y: 1, snapshot: {} });
  assert.equal(mirror.x, mx);
});

test('two phones with the laptop and the hub gone keep sharing, and pick one hub', () => {
  const terrain = makeTerrain(SEED, W, H, BASE);
  const a = createPhoneDrone({ id: 2, seed: SEED, terrain, speed: SPEED });
  const b = createPhoneDrone({ id: 3, seed: SEED, terrain, speed: SPEED });
  for (const p of [a, b]) p.world.los = false;       // this test is about the phones, not the ridges
  for (let tick = 1; tick <= seconds(20); tick++) {
    const ma = a.advance(tick), mb = b.advance(tick);
    a.receive(wire(mb)); b.receive(wire(ma));
  }
  const both = (fn) => [fn(a.drone), fn(b.drone)];
  assert.ok(both((d) => R.visitedCount(d.state)).every((n) => n > 15));
  const ground = cellsInView(a.drone)[0];
  assert.equal(R.isVisited(b.drone.state, ...ground), true, 'b knows what a searched');
  assert.deepEqual(both((d) => d.state.hub.id), [2, 2], 'the lowest live drone takes over');
  assert.equal(both((d) => R.isHub(d.state)).filter(Boolean).length, 1);
});

test('when the hub is the phone that goes offline, the swarm elects a new one', () => {
  const terrain = makeTerrain(SEED, W, H, BASE);
  const sim = createSim({ seed: SEED, terrain, speed: SPEED, los: false, remoteIds: [1] });
  const core = createPhoneDrone({ id: 1, seed: SEED, terrain, speed: SPEED });
  core.world.los = false;
  const flyFor = (ticks, online) => {
    for (let i = 0; i < ticks; i++) {
      sim.run(1);
      if (online) for (const m of sim.outbox(1).messages) core.receive(wire(m));
      const message = core.advance(sim.tick);
      if (online) sim.applyRemote(wire(message));
    }
  };
  flyFor(seconds(5), true);
  sim.remoteLost(1);
  flyFor(seconds(10), false);
  const hubs = sim.drones.filter((d) => d.id !== 1).map((d) => d.state.hub.id);
  assert.ok(hubs.every((h) => h !== 1), `hubs: ${hubs}`);
  assert.equal(core.drone.state.hub.id, 1, 'cut off, the phone does not claim anything new');
  flyFor(seconds(3), true);
  assert.notEqual(core.drone.state.hub.id, 1, 'it accepts the new hub on returning');
});

test('a phone in a smaller swarm agrees with the big screen about strips', () => {
  const terrain = makeTerrain(SEED, W, H, BASE);
  const sim = createSim({ seed: SEED, terrain, drones: 6, speed: SPEED, remoteIds: [1, 2, 3] });
  const ids = [1, 2, 3, 4, 5, 6];
  for (const id of [1, 2, 3]) {
    const core = createPhoneDrone({ id, seed: SEED, terrain, speed: SPEED, ids });
    const mirror = sim.drones.find((d) => d.id === id);
    assert.deepEqual(R.homeSector(core.drone.state, id, COLS), R.homeSector(mirror.state, id, COLS));
    assert.deepEqual([core.drone.x, core.drone.y], [mirror.x, mirror.y]);
  }
});

test('a phone winning the hub election shows on the big screen', () => {
  const terrain = makeTerrain(SEED, W, H, BASE);
  const logs = [];
  const sim = createSim({ seed: SEED, terrain, speed: SPEED, remoteIds: [2], onLog: (m) => logs.push(m) });
  const message = { id: 2, tick: 5, x: 1, y: 1, angle: 0, task: 't', hubStatus: 'ok', mode: 'hub', snapshot: { ...R.snapshot(sim.drones[1].state), hub: { id: 2, epoch: 1 } } };
  sim.applyRemote(message);
  assert.ok(logs.some((l) => l.includes('Drone 2 took over as hub')));
});

test('the big screen does not report a lost phone as live', () => {
  const t = setup();
  t.run(seconds(5));
  t.goOffline();
  assert.equal(t.mirror.commsMode, 'alone');
  assert.ok(t.logs.some((l) => l.includes('not connected')));
  const hubs = t.sim.drones.filter((d) => d.id !== PHONE);
  hubs.forEach((d) => { d.state.hub = { id: 3, epoch: 9 }; });
  t.mirror.state.hub = { id: PHONE, epoch: 99 };
  assert.equal(t.sim.currentHub(), 3, 'its last word on the hub gets no vote');
});

test('a second outage on the same phone is logged too', () => {
  const t = setup();
  t.run(seconds(5));
  for (let i = 0; i < 2; i++) {
    t.goOffline();
    t.run(seconds(20));
    t.net.online = true;
    t.run(seconds(10));
  }
  assert.ok(t.logs.filter((l) => l.includes(`of drone ${PHONE} for`)).length >= 2);
});

test('cells explored alone counts only what the drone flew over, not what it merged', () => {
  const t = setup();
  t.run(seconds(40));
  const before = t.core.firstLook;
  t.net.online = false;
  t.core.offline = true;
  t.run(seconds(30));
  const alone = t.core.firstLook - before;
  assert.ok(alone > 0 && alone < 40, `${alone} cells`);
  t.core.offline = false;
  t.net.online = true;
  const known = R.visitedCount(t.phone.state);
  t.run(seconds(2));
  assert.ok(R.visitedCount(t.phone.state) > known + 40, 'the merge brings in far more');
  assert.ok(t.core.firstLook - before < alone + 10, 'but the count does not jump with it');
  assert.equal(t.core.offlineCells.reduce((n, v) => n + v, 0), alone);
});

test('what the phone flew over and its mule state reach the big screen', () => {
  const t = setup();
  t.run(seconds(20));
  const flown = t.mirror.own.reduce((n, v) => n + v, 0);
  assert.equal(flown, R.visitedCount(t.core.own));
  t.sim.applyRemote({ ...JSON.parse(JSON.stringify(t.core.advance(t.sim.tick + 1))), muling: true });
  assert.equal(t.mirror.muling, true);
});

test('a message that misses a tick does not read as silence', () => {
  const terrain = makeTerrain(SEED, W, H, BASE);
  const p = createPhoneDrone({ id: 2, seed: SEED, terrain, speed: SPEED });
  p.world.los = false;
  p.advance(10);
  const other = R.createState(3, p.drone.state.fleet, { hubId: 1, cols: COLS, rows: ROWS });
  other.hops = 1;
  p.receive({ id: 3, tick: 10, x: p.drone.x + 5, y: p.drone.y, snapshot: R.snapshot(other) });
  p.advance(11);
  p.advance(12);
  assert.equal(p.heardCount, 1, 'still heard on the next tick');
  assert.equal(p.drone.state.hops, 2, 'and the route stays');
  p.advance(30);
  assert.equal(p.heardCount, 0, 'until it is out of date');
});

test('base is not counted as a drone heard', () => {
  const terrain = makeTerrain(SEED, W, H, BASE);
  const p = createPhoneDrone({ id: 2, seed: SEED, terrain, speed: SPEED });
  p.world.los = false;
  p.advance(1);
  const b = R.createState(R.BASE_ID, p.drone.state.fleet, { hubId: 1, cols: COLS, rows: ROWS });
  p.receive({ id: R.BASE_ID, isBase: true, tick: 1, x: p.drone.x, y: p.drone.y, snapshot: R.snapshot(b) });
  p.advance(2);
  assert.deepEqual([p.heardCount, p.heardDrones], [1, 0]);
});

test('a reloaded page carries on where the drone was', () => {
  const t = setup();
  t.run(seconds(45));
  const saved = JSON.parse(JSON.stringify(t.core.save()));
  const terrain = makeTerrain(SEED, W, H, BASE);
  const again = createPhoneDrone({ id: PHONE, seed: SEED, terrain, speed: SPEED });
  again.restore(saved);
  assert.deepEqual([again.drone.x, again.drone.y, again.world.tick, again.firstLook], [t.phone.x, t.phone.y, t.sim.tick, t.core.firstLook]);
  assert.equal(R.visitedCount(again.drone.state), R.visitedCount(t.phone.state));
  assert.equal(R.visitedCount(again.own), R.visitedCount(t.core.own));
  const message = again.advance(t.sim.tick + 1);
  assert.ok(Math.hypot(message.x - t.phone.x, message.y - t.phone.y) < 5, 'and flies on from there');
});

test('a reloaded phone does not read as a hub takeover', () => {
  const terrain = makeTerrain(SEED, W, H, BASE);
  const logs = [];
  const sim = createSim({ seed: SEED, terrain, speed: SPEED, remoteIds: [1], onLog: (m) => logs.push(m) });
  sim.drones[0].state.hub = { id: 7, epoch: 3 };
  sim.applyRemote({ id: 1, tick: 5, x: 1, y: 1, angle: 0, task: 't', hubStatus: 'ok', mode: 'hub', snapshot: { ...R.snapshot(sim.drones[0].state), hub: { id: 1, epoch: 0 } } });
  assert.equal(logs.filter((l) => l.includes('took over')).length, 0);
});

test('a drone heard directly is not moved by the big screen\'s older word', () => {
  const terrain = makeTerrain(SEED, W, H, BASE);
  const p = createPhoneDrone({ id: 2, seed: SEED, terrain, speed: SPEED });
  p.advance(10);
  p.receive({ id: 3, tick: 10, x: 300, y: 300, snapshot: {} });
  p.setPositions([{ id: 3, x: 100, y: 100, alive: true, inContact: false }, { id: 4, x: 50, y: 50, alive: true, inContact: true }]);
  assert.deepEqual([p.others.get(3).x, p.others.get(3).inContact, p.others.get(4).x], [300, true, 50]);
});

test('a device that slept does not pretend it flew', () => {
  const terrain = makeTerrain(SEED, W, H, BASE);
  const p = createPhoneDrone({ id: 7, seed: SEED, terrain, speed: SPEED });
  for (let tick = 1; tick <= 20; tick++) p.advance(tick);
  const { x, y } = p.drone;
  const message = p.advance(1000);
  assert.equal(message.tick, 1000);
  assert.ok(Math.hypot(p.drone.x - x, p.drone.y - y) < 3, 'it only moved for one tick');
});

test('an old message, or one from out of range, is not heard', () => {
  const terrain = makeTerrain(SEED, W, H, BASE);
  const p = createPhoneDrone({ id: 7, seed: SEED, terrain, speed: SPEED });
  p.advance(50);
  const other = R.createState(8, p.drone.state.fleet, { hubId: 1, cols: COLS, rows: ROWS });
  const near = { id: 8, x: p.drone.x + 5, y: p.drone.y, snapshot: R.snapshot(other) };
  p.world.los = false;
  p.receive({ ...near, tick: 10 });
  p.advance(51);
  assert.equal(p.heardCount, 0, 'out of date');
  p.receive({ ...near, tick: 51, x: p.drone.x + 500 });
  p.advance(52);
  assert.equal(p.heardCount, 0, 'out of range');
  p.receive({ ...near, tick: 52, x: p.drone.x + 5 });
  p.advance(53);
  assert.equal(p.heardCount, 1);
});

test('blackouts painted on the big screen reach the phone', () => {
  const terrain = makeTerrain(SEED, W, H, BASE);
  const sim = createSim({ seed: SEED, terrain });
  const p = createPhoneDrone({ id: 7, seed: SEED, terrain, speed: SPEED });
  sim.paintBlackout(300, 300, 60);
  p.setWorld({ radio: false, range: 120, los: false, mode: 'formation', blackout: Array.from(sim.blackout).join('') });
  assert.deepEqual([...p.world.blackout], [...sim.blackout]);
  assert.deepEqual([p.world.radio, p.world.range, p.world.los, p.world.mode], [false, 120, false, 'formation']);
});
