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
