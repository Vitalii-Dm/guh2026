// Checks the JS port matches PyTorch on one deterministic step.
// Needs nca/nca-reference.json + recovery/models/formation-nca.json from
// `python3 nca/train_nca.py`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { NCA } from '../nca-runtime.js';

const root = new URL('../../', import.meta.url);
const modelPath = new URL('recovery/models/formation-nca.json', root);
const refPath = new URL('nca/nca-reference.json', root);

test('JS NCA step matches PyTorch (fire_rate = 1)', { skip: !existsSync(refPath) && 'no reference file' }, () => {
  const model = JSON.parse(readFileSync(modelPath));
  const ref = JSON.parse(readFileSync(refPath));
  const nca = new NCA(model);
  nca.setState(Float32Array.from(ref.input));
  nca.step(1.0);
  let maxDiff = 0;
  for (let i = 0; i < ref.output.length; i++) maxDiff = Math.max(maxDiff, Math.abs(nca.x[i] - ref.output[i]));
  assert.ok(maxDiff < 1e-4, `max abs diff ${maxDiff}`);
});

// ---- the network split across drones (stepSwarm)
import { formationSlots } from '../swarm-recovery.js';

const loadModel = () => JSON.parse(readFileSync(modelPath));
const lcg = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const patches = (nca, ids) => formationSlots(ids.length).map(([x, y], i) => ({ id: ids[i], gx: x * nca.N, gy: y * nca.N }));
const IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const together = (ids) => new Map(ids.map((id) => [id, 0]));
const apart = (ids) => new Map(ids.map((id) => [id, id]));

function grown() {
  const nca = new NCA(loadModel(), { random: lcg(3) });
  nca.reset();
  const owner = nca.assignOwners(patches(nca, IDS));
  for (let i = 0; i < 300; i++) nca.stepSwarm(owner, together(IDS));
  return { nca, owner };
}

test('split across drones that can all hear each other, it is the same network', () => {
  const a = new NCA(loadModel()), b = new NCA(loadModel());
  a.reset(); b.reset();
  for (let i = 0; i < 40; i++) a.step(1);
  b.setState(a.x);
  const ref = new NCA(loadModel()); ref.setState(a.x); ref.step(1);
  b.stepSwarm(b.assignOwners(patches(b, IDS)), together(IDS), 1);
  let maxDiff = 0;
  for (let i = 0; i < ref.x.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ref.x[i] - b.x[i]));
  assert.ok(maxDiff < 1e-6, `max abs diff ${maxDiff}`);
});

test('when any drone fails, its neighbours take over its patch and regrow it', () => {
  const { nca } = grown();
  assert.ok(nca.similarity() > 0.95, `grew to ${nca.similarity()}`);
  const start = Float32Array.from(nca.x);
  for (const dead of IDS) {
    nca.setState(start); nca.views = null;
    const slot = patches(nca, IDS).find((p) => p.id === dead);
    nca.erase(slot.gx, slot.gy, 5);
    const live = IDS.filter((id) => id !== dead);
    const owner = nca.assignOwners(patches(nca, live));
    for (let i = 0; i < 400; i++) nca.stepSwarm(owner, together(live));
    assert.ok(nca.similarity() > 0.9, `drone ${dead}: ${nca.similarity()}`);
  }
});

test('without radio a drone keeps a stale copy of its neighbours, updated once radio returns', () => {
  const { nca, owner } = grown();
  const victim = patches(nca, IDS)[4];                  // the tip
  const watcher = 4;                                    // its neighbour on the left
  const C = nca.C, N = nca.N;
  const cell = Math.floor(victim.gy) * N + Math.floor(victim.gx);
  nca.stepSwarm(owner, apart(IDS));
  nca.erase(victim.gx, victim.gy, 3);
  nca.stepSwarm(owner, apart(IDS));
  const copy = () => nca.views.get(watcher)[cell * C + 3];
  assert.ok(copy() > 0.1, 'cut off: drone 4 still sees the tip as it was');
  assert.equal(owner[cell], victim.id);
  nca.stepSwarm(owner, together(IDS));
  assert.ok(Math.abs(copy() - nca.next[cell * C + 3]) < 1e-6, 'radio back: drone 4 has the real value');
});
