// One drone's logic on its own: what a phone relies on matching the simulation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../../recovery/swarm-recovery.js';
import { createSim, W, H, BASE, COLS, ROWS } from '../sim.js';
import { canHear, chooseTarget, cellsInView, fly, makeSurvivors, peopleInView, radioLink } from '../drone.js';
import { makeTerrain } from '../terrain.js';

const SEED = 7;
const terrain = makeTerrain(SEED, W, H, BASE);

test('every device builds the same people from the seed', () => {
  const sim = createSim({ seed: SEED, terrain });
  assert.deepEqual(makeSurvivors(SEED, makeTerrain(SEED, W, H, BASE)), sim.survivors);
});

test('the radio rule gives the same links the simulation drew', () => {
  const sim = createSim({ seed: SEED, terrain });
  sim.paintBlackout(440, 300, 120);
  sim.run(120);
  // The next step starts a tick, which uses these positions before anyone moves.
  const nodes = [sim.base, ...sim.drones].map(({ id, x, y, isBase }) => ({ id: id ?? 'base', x, y, isBase }));
  const expected = { open: [], blocked: [] };
  nodes.forEach((a, i) => nodes.slice(i + 1).forEach((b) => {
    const link = radioLink(a, b, sim);
    if (link !== 'none') expected[link].push(`${a.id}-${b.id}`);
  }));
  sim.step();
  const names = (pairs) => pairs.map(([a, b]) => `${a.id ?? 'base'}-${b.id ?? 'base'}`);
  assert.ok(expected.open.length > 0 && expected.blocked.length > 0, 'the run should have both kinds of link');
  assert.deepEqual(names(sim.links), expected.open);
  assert.deepEqual(names(sim.blocked), expected.blocked);
});

test('nobody hears anybody with the radio off, out of range, or in a blackout', () => {
  const a = { x: 100, y: 100 }, b = { x: 150, y: 100 };
  const world = { radio: true, range: 190, los: false, terrain, blackout: new Uint8Array(COLS * ROWS) };
  assert.equal(canHear(a, b, world), true);
  assert.equal(canHear(a, b, { ...world, radio: false }), false);
  assert.equal(canHear(a, b, { ...world, range: 40 }), false);
  const blackout = new Uint8Array(COLS * ROWS);
  blackout[5 * COLS + 5] = 1;                 // the cell holding `a`
  assert.equal(canHear(a, b, { ...world, blackout }), false);
});

test('a drone alone searches its strip with nothing but its own state', () => {
  const ids = Array.from({ length: 15 }, (_, i) => i + 1);
  const d = { id: 7, x: 440, y: 500, angle: 0, state: R.createState(7, ids, { hubId: 1, cols: COLS, rows: ROWS }), restUntil: 0, atBaseTicks: 0, muling: false, task: '' };
  for (let tick = 1; tick <= 300; tick++) {
    R.step(d.state, [], tick);
    d.target = chooseTarget(d, { tick, mode: 'search' });
    for (let i = 0; i < 10; i++) {
      fly(d, 0.016);
      for (const [c, r] of cellsInView(d)) R.recordVisit(d.state, c, r);
    }
  }
  assert.ok(R.visitedCount(d.state) > 40, `searched ${R.visitedCount(d.state)} cells`);
  assert.match(d.task, /searching|helping/);
});

test('a person is seen once, then the drone holds a report', () => {
  const ids = [1, 2];
  const d = { id: 1, x: 100, y: 100, state: R.createState(1, ids, { hubId: 1, cols: COLS, rows: ROWS }) };
  const people = [{ id: 's1', x: 110, y: 100 }, { id: 's2', x: 400, y: 400 }];
  assert.deepEqual(peopleInView(d, people).map((s) => s.id), ['s1']);
  R.recordSurvivor(d.state, 's1', 110, 100, 1);
  assert.deepEqual(peopleInView(d, people), []);
});
