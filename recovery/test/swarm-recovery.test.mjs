// Run: node --test recovery/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_ID, createState, merge, snapshot, step, liveIds, isHub,
  recordSurvivor, recordVisit, isVisited, visitedCount, formationSlotFor,
  homeSector, reportToCarry, DEFAULTS,
} from '../swarm-recovery.js';

const IDS = [1, 2, 3, 4, 5];
const strip = (s) => { const { self, ...rest } = s; return JSON.parse(JSON.stringify(rest)); };

function sample() {
  const a = createState(1, IDS);
  const b = createState(2, IDS);
  const c = createState(3, IDS);
  recordVisit(a, 0, 0); recordVisit(b, 1, 1); recordVisit(c, 2, 2);
  recordSurvivor(a, 's1', 5, 5, 3);
  recordSurvivor(b, 's1', 5, 5, 4);
  b.survivors.s1.delivered = true;
  a.roster[4] = { v: 7, alive: false };
  b.roster[4] = { v: 9, alive: true };
  c.hub = { id: 3, epoch: 2 };
  b.hub = { id: 2, epoch: 2 };
  return [a, b, c];
}

test('merge is commutative, associative and idempotent', () => {
  const [a, b, c] = sample();
  assert.deepEqual(strip(merge(a, b)), strip(merge(b, a)));
  assert.deepEqual(strip(merge(merge(a, b), c)), strip(merge(a, merge(b, c))));
  assert.deepEqual(strip(merge(a, a)), strip(a));
  const ab = merge(a, b);
  assert.deepEqual(strip(merge(ab, b)), strip(ab));
});

test('merge keeps everything: visited union, earliest finder, delivered OR', () => {
  const [a, b, c] = sample();
  const m = merge(merge(a, b), c);
  assert.equal(visitedCount(m), 3);
  for (const i of [0, 1, 2]) assert.ok(isVisited(m, i, i));
  assert.equal(m.survivors.s1.foundBy, 1);
  assert.equal(m.survivors.s1.delivered, true);
});

test('merge does not mutate inputs', () => {
  const [a, b] = sample();
  const before = JSON.stringify(a);
  merge(a, b);
  assert.equal(JSON.stringify(a), before);
});

test('epoch tie is broken by lowest id', () => {
  const [, b, c] = sample();
  assert.deepEqual(merge(b, c).hub, { id: 2, epoch: 2 });
  assert.deepEqual(merge(c, b).hub, { id: 2, epoch: 2 });
});

test('a drone wrongly marked failed rejoins via a higher version', () => {
  const s = createState(1, IDS);
  s.roster[4] = { v: 10, alive: false };
  const fromDrone4 = snapshot(createState(4, IDS, { now: 30 }));
  fromDrone4.roster[4] = { v: 30, alive: true };
  step(s, [fromDrone4], 30);
  assert.equal(s.roster[4].alive, true);
});

// Tiny simulation: drones in a line, each hears only its neighbours.
function runLine(n, ticks, { failAt = {}, cut = null } = {}) {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  const nodes = [createState(BASE_ID, ids), ...ids.map((id) => createState(id, ids))];
  const dead = new Set();
  for (let t = 1; t <= ticks; t++) {
    for (const [id, at] of Object.entries(failAt)) if (t === at) dead.add(Number(id));
    const snaps = nodes.map((s) => JSON.parse(JSON.stringify(snapshot(s))));
    nodes.forEach((s, i) => {
      if (i > 0 && dead.has(i)) return;
      const inbox = [];
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= nodes.length || (j > 0 && dead.has(j))) continue;
        if (cut && cut(t, i, j)) continue;
        inbox.push(snaps[j]);
      }
      step(s, inbox, t);
    });
  }
  return { nodes, dead };
}

test('hub fails: lowest live drone takes over, nobody else claims it', () => {
  const { nodes } = runLine(6, 140, { failAt: { 1: 5 } });
  const alive = nodes.slice(2);
  for (const s of alive) {
    assert.equal(s.hub.id, 2, `drone ${s.self} sees hub ${s.hub.id}`);
    assert.equal(s.hub.epoch, 1);
    assert.equal(s.roster[1].alive, false);
  }
  assert.equal(alive.filter(isHub).length, 1);
});

test('survivor found by a drone that later fails still reaches base', () => {
  const ids = [1, 2, 3];
  const { nodes } = (() => {
    const r = runLine(3, 5);
    recordSurvivor(r.nodes[3], 's9', 1, 1, 5);
    return r;
  })();
  // continue the run with drone 3 failing 3 ticks after finding the survivor
  const dead = new Set();
  for (let t = 6; t <= 130; t++) {
    if (t === 8) dead.add(3);
    const snaps = nodes.map((s) => JSON.parse(JSON.stringify(snapshot(s))));
    nodes.forEach((s, i) => {
      if (i > 0 && dead.has(i)) return;
      const inbox = [i - 1, i + 1].filter((j) => j >= 0 && j < nodes.length && !dead.has(j)).map((j) => snaps[j]);
      step(s, inbox, t);
    });
  }
  assert.equal(nodes[0].survivors.s9?.delivered, true);
  assert.equal(nodes[1].survivors.s9?.delivered, true);
  assert.deepEqual(liveIds(nodes[1]), [1, 2]);
  void ids;
});

test('partition makes two hubs, reconnecting reconciles to one', () => {
  // Cut the link between drone 3 and 4 from tick 5 to 60, hub 1 fails at tick 5.
  const cut = (t, i, j) => t >= 5 && t < 60 && Math.min(i, j) === 3 && Math.max(i, j) === 4;
  const during = runLine(6, 59, { failAt: { 1: 5 }, cut });
  const hubsDuring = new Set(during.nodes.slice(2).map((s) => s.hub.id));
  assert.ok(hubsDuring.size === 2, `expected two hubs during split, got ${[...hubsDuring]}`);

  const after = runLine(6, 140, { failAt: { 1: 5 }, cut });
  const hubsAfter = new Set(after.nodes.slice(2).map((s) => s.hub.id));
  assert.deepEqual([...hubsAfter], [2]);
  for (const s of after.nodes.slice(2)) assert.equal(s.roster[5].alive, true, 'far side rejoined');
});

test('a lone drone that hears nobody does not claim the hub or give up on the swarm', () => {
  const cut = (t, i, j) => t >= 10 && t < 200 && Math.max(i, j) === 6 && Math.min(i, j) === 5;
  const { nodes } = runLine(6, 150, { cut });
  const loner = nodes[6];
  assert.equal(loner.hub.id, 1);
  assert.deepEqual(liveIds(loner), [1, 2, 3, 4, 5, 6]);
});

test('a drone back from isolation does not take the hub from a healthy one', () => {
  const cut = (t, i, j) => t >= 10 && t < 100 && Math.max(i, j) === 6 && Math.min(i, j) === 5;
  const { nodes } = runLine(6, 160, { cut });
  for (const s of nodes.slice(1)) assert.deepEqual(s.hub, { id: 1, epoch: 0 });
});

test('a drone back in contact waits for news before judging anyone', () => {
  const s = createState(3, IDS);
  const base = snapshot(createState(BASE_ID, IDS));
  const { events } = step(s, [base], 200);
  assert.deepEqual(events, []);
  assert.equal(s.hub.id, 1);
  assert.equal(s.hops, 1);
});

test('a dead hub is replaced even if the next in line hears only base', () => {
  const ids = [1, 2, 3];
  const [d2, d3, base] = [createState(2, ids), createState(3, ids), createState(BASE_ID, ids)];
  for (let t = 1; t <= 80; t++) {
    const [s2, s3, sb] = [d2, d3, base].map((s) => JSON.parse(JSON.stringify(snapshot(s))));
    step(d2, [sb], t);       // drone 2 hears only base
    step(d3, [sb], t);       // drone 3 hears only base
    step(base, [s2, s3], t);
  }
  assert.equal(d2.hub.id, 2);
});

test('repeated radio cuts do not keep a dead hub in place', () => {
  const ids = [1, 2, 3];
  const [d2, d3] = [createState(2, ids), createState(3, ids)];
  for (let t = 1; t <= 300; t++) {
    const on = t % 35 >= 10;
    const [s2, s3] = [d2, d3].map((s) => JSON.parse(JSON.stringify(snapshot(s))));
    step(d2, on ? [s3] : [], t);
    step(d3, on ? [s2] : [], t);
  }
  assert.equal(d3.hub.id, 2);
});

test('hop counts follow the chain and clear beyond a cut', () => {
  const cut = (t, i, j) => Math.max(i, j) === 4 && Math.min(i, j) === 3;
  const { nodes } = runLine(5, 12, { cut });
  assert.deepEqual(nodes.map((s) => s.hops), [0, 1, 2, 3, null, null]);
});

test('with no route, the finder carries first and other holders wait their turn', () => {
  const finder = createState(3, IDS);
  const other = createState(1, IDS);
  recordSurvivor(finder, 's1', 0, 0, 100);
  other.survivors.s1 = { ...finder.survivors.s1 };
  other.heldSince.s1 = 100;
  assert.equal(reportToCarry(finder, 100), 's1');
  assert.equal(reportToCarry(other, 100), null);
  assert.equal(reportToCarry(other, 100 + DEFAULTS.muleStagger), 's1');
  const lateHolder = createState(2, IDS);
  lateHolder.survivors.s1 = { ...finder.survivors.s1 };
  lateHolder.heldSince.s1 = 5000;
  assert.equal(reportToCarry(lateHolder, 5000), null, 'an old report gets no head start');
  finder.hops = 2;
  assert.equal(reportToCarry(finder, 100), null, 'a route means no need to fly');
});

test('home strips ignore the roster', () => {
  const s = createState(1, IDS);
  const before = homeSector(s, 4, 40);
  s.roster[2] = { v: 5, alive: false };
  assert.deepEqual(homeSector(s, 4, 40), before);
});

test('home strips and formation slots are the same on every drone', () => {
  const a = createState(1, IDS);
  const b = createState(4, IDS);
  a.roster[3] = { v: 5, alive: false };
  b.roster[3] = { v: 5, alive: false };
  for (const id of [1, 2, 4, 5]) {
    assert.deepEqual(homeSector(a, id, 40), homeSector(b, id, 40));
    assert.deepEqual(formationSlotFor(a, id), formationSlotFor(b, id));
  }
  assert.equal(formationSlotFor(a, 3), null);
  assert.deepEqual(homeSector(a, 5, 40), [32, 40]);
});
