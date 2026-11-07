// Erase each formation slot in turn and check the network regrows the V.
// Usage: node nca/eval_regrow.mjs [path/to/model.json]
import { readFileSync } from 'node:fs';
import { NCA } from '../recovery/nca-runtime.js';
import { formationSlots } from '../recovery/swarm-recovery.js';

const path = process.argv[2] || new URL('../recovery/models/formation-nca.json', import.meta.url);
const model = JSON.parse(readFileSync(path));
let s = 7;
const random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

const nca = new NCA(model, { random });
nca.reset();
for (let i = 0; i < 300; i++) nca.step();
const grown = Float32Array.from(nca.x);
console.log(`grown from seed: ${(nca.similarity() * 100).toFixed(1)}%`);

let worst = 1;
for (const n of [15, 9]) {
  for (const [i, [x, y]] of formationSlots(n, model.formation_polyline).entries()) {
    nca.setState(grown);
    nca.erase(x * nca.N, y * nca.N, 5);
    for (let k = 0; k < 400; k++) nca.step();
    const sim = nca.similarity();
    worst = Math.min(worst, sim);
    if (sim < 0.9) console.log(`  ${n} slots, slot ${i} (${x.toFixed(2)},${y.toFixed(2)}): ${(sim * 100).toFixed(1)}%`);
  }
}
console.log(`worst after single-slot damage: ${(worst * 100).toFixed(1)}%`);
process.exitCode = worst >= 0.9 ? 0 : 1;
