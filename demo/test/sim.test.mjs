// Runs the real simulation headless. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, W, H, BASE } from '../sim.js';
import { makeTerrain } from '../terrain.js';

const SEEDS = [2026, 7, 1];
const make = (seed, opts = {}) => createSim({ seed, terrain: makeTerrain(seed, W, H, BASE), ...opts });
const delivered = (s) => Object.keys(s.base.state.survivors).length;
const found = (s) => s.survivors.filter((p) => p.foundBy).length;

test('the same seed plays out identically', () => {
  const a = make(2026), b = make(2026);
  a.run(300); b.run(300);
  assert.deepEqual(a.drones.map((d) => [d.x, d.y]), b.drones.map((d) => [d.x, d.y]));
});

test('an undisturbed swarm searches everything and reports everyone', () => {
  for (const seed of SEEDS) {
    const s = make(seed);
    s.run(900);
    assert.equal(s.coverage(), 1, `seed ${seed}`);
    assert.equal(delivered(s), s.survivors.length, `seed ${seed}`);
  }
});

test('a total blackout does not stop the search', () => {
  for (const seed of SEEDS) {
    const s = make(seed);
    s.run(60);
    s.radio = false;
    s.run(640);
    assert.ok(s.coverage() > 0.95, `seed ${seed}: ${s.coverage()}`);
    assert.equal(found(s), s.survivors.length, `seed ${seed}`);
  }
});

test('in a blackout every drone knows it is cut off and keeps everyone in its roster', () => {
  const s = make(2026);
  s.run(60);
  s.radio = false;
  s.run(300);
  for (const d of s.drones) {
    assert.equal(d.commsMode, 'alone');
    assert.equal(Object.values(d.state.roster).filter((e) => e.alive).length, 15);
  }
});

test('reports and maps reach base when the radio comes back', () => {
  const s = make(2026);
  s.run(60);
  s.radio = false;
  s.run(400);
  const before = s.baseCoverage();
  s.radio = true;
  s.run(300);
  assert.ok(s.baseCoverage() > before + 0.5, `${before} -> ${s.baseCoverage()}`);
  assert.equal(delivered(s), found(s));
});

test('a painted blackout cuts links only for drones inside it', () => {
  const s = make(2026, { los: false });
  s.run(1);
  const linked = s.links.length;
  s.paintBlackout(BASE.x, BASE.y, 60);
  s.run(1);
  assert.ok(s.links.length < linked);
  assert.ok(s.links.every(([a, b]) => a !== s.base && b !== s.base));
  s.clearBlackout();
  s.run(1);
  assert.ok(s.links.some(([a, b]) => a === s.base || b === s.base));
});

test('ridges block links that distance alone would allow', () => {
  const on = make(2026), off = make(2026, { los: false });
  on.run(200); off.run(200);
  assert.ok(on.blocked.length > 0);
  assert.equal(off.blocked.length, 0);
});

test('reports get home after their finders fail, with no route to base', () => {
  for (const seed of SEEDS) {
    const s = make(seed, { range: 90 });
    const seen = new Set();
    for (let t = 0; t < 1500; t++) {
      s.run(1);
      for (const p of s.survivors) {
        if (!p.foundBy || seen.has(p.id)) continue;
        seen.add(p.id);
        const finder = s.drones.find((d) => d.id === p.foundBy);
        if (finder.state.hops === null && t < 400) s.fail(finder);
      }
    }
    assert.equal(delivered(s), found(s), `seed ${seed}`);
  }
});

test('a person whose only report died with its finder can be found again', () => {
  const s = make(2026);
  s.radio = false;
  let lost = null;
  for (let t = 0; t < 900 && !lost; t++) {
    s.run(1);
    lost = s.survivors.find((p) => p.foundBy);
  }
  s.fail(s.drones.find((d) => d.id === lost.foundBy));
  assert.equal(s.holders(lost).length, 0);
  s.run(900);
  assert.ok(s.holders(lost).length > 0);
});

test('hop counts grow with distance from base and clear when cut off', () => {
  const s = make(2026, { los: false });
  s.run(40);
  const near = s.drones.filter((d) => d.state.hops === 1);
  assert.ok(near.length > 0);
  for (const d of near) assert.ok(s.links.some(([a, b]) => (a === d && b === s.base) || (b === d && a === s.base)));
  s.radio = false;
  s.run(5);
  for (const d of s.drones) assert.equal(d.state.hops, null);
});

test('restoring radio causes no false failures or takeovers', () => {
  for (const seed of SEEDS) {
    const logs = [];
    const s = make(seed, { onLog: (m) => logs.push(m) });
    s.run(60);
    s.radio = false;
    s.run(200);
    logs.length = 0;
    s.radio = true;
    s.run(20); // less than hubTimeout: ridges may genuinely split the swarm after that
    assert.deepEqual(logs.filter((l) => /treating it as failed|took over/.test(l)), [], `seed ${seed}`);
    for (const d of s.drones) assert.equal(Object.values(d.state.roster).filter((e) => e.alive).length, 15);
  }
});

test('reports reach base even at the lowest radio range', () => {
  for (const seed of [2026, 1]) {
    const s = make(seed, { range: 40 });
    s.run(2500);
    assert.equal(delivered(s), s.survivors.length, `seed ${seed}`);
    assert.equal(s.baseCoverage(), 1, `seed ${seed}`);
  }
});

test('the final map reaches base even at the lowest range after failures', () => {
  for (const seed of [2026, 7, 1]) {
    const s = make(seed, { range: 40 });
    s.run(30);
    for (const id of [7, 8, 9]) s.fail(s.drones[id - 1]);
    s.run(6000);
    assert.equal(s.baseCoverage(), 1, `seed ${seed}`);
  }
});

test('nobody is missed once the map is fully searched', () => {
  const s = make(4);
  s.run(100);
  for (const id of [4, 8, 12]) s.fail(s.drones[id - 1]);
  s.run(2000);
  assert.equal(found(s), s.survivors.length);
});

test('a full message stays under 1.5 KB', () => {
  const s = make(2026);
  s.run(900);
  const bytes = JSON.stringify({ roster: s.drones[0].state.roster, survivors: s.drones[0].state.survivors, visited: s.drones[0].state.visited, hub: s.drones[0].state.hub, hops: 1 }).length;
  assert.ok(bytes < 1500, `${bytes}`);
});

test('the number of drones can be set at launch', () => {
  const s = make(2026, { drones: 5 });
  s.run(900);
  assert.equal(s.drones.length, 5);
  assert.ok(s.coverage() > 0.8);
});

test('a formation closes up within seconds of a drone failing', () => {
  const s = make(2026, { los: false, drones: 9 });
  s.mode = 'formation';
  s.run(300);
  const before = s.drones[8].target;
  s.fail(s.drones[4]);
  s.run(30);
  assert.notDeepEqual(s.drones[8 - 1].target, undefined);
  assert.notDeepEqual(s.drones[5].target, before);
  const slots = new Set(s.drones.filter((d) => d.alive).map((d) => `${d.target.x},${d.target.y}`));
  assert.equal(slots.size, 8);
});

test('drones disagree in a blackout and agree again once radio returns', () => {
  const s = make(2026, { drones: 9 });
  s.radio = false;
  s.run(400);
  const during = s.agreement();
  assert.ok(during < 0.5, `${during}`);
  s.radio = true;
  s.run(100);
  assert.ok(s.agreement() > during);
});

test('every drone can say what it is doing', () => {
  const s = make(2026);
  s.run(50);
  for (const d of s.drones) assert.notEqual(d.task, 'launching');
  assert.ok(s.drones.some((d) => d.task === 'searching its home strip'));
  s.mode = 'formation';
  s.run(1);
  assert.ok(s.drones.some((d) => /formation/.test(d.task)));
});
