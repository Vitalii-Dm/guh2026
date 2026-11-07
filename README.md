# Resilient rescue drone swarm: hub recovery

For GreatUniHack 2026, Neptune North challenge. Drones search mountains for missing people and keep going when radio fails: no drone waits for instructions, and what they learn reaches base once a route exists. A report that has reached one other drone survives losing its finder or the hub. A neural cellular automaton, based on [Google's self-repairing gecko](https://distill.pub/2020/growing-ca/), is computed by the drones between them: each runs it on its own patch and swaps edge cells with neighbours by radio, and the formation picture regrows when one fails.

- `recovery/`: drop-in frontend modules (no dependencies). See [recovery/README.md](recovery/README.md).
- `demo/`: interactive demo. `sim.js` is the simulation with no DOM, `demo.js` draws it. Choose how many drones launch, fail them, paint a radio blackout, cut all radio, and watch the search graph. The graph compares this run with two unseen runs on the same terrain: one with comms on and nothing failed, one with no radio from launch.
- `demo3d/`: the same demo in 3D (Three.js, vendored in `demo3d/vendor/three`, MIT). It runs the same `demo/sim.js`; drag to orbit, scroll to zoom, click a drone to see its view.
- `nca/train_nca.py`: trains the network on the formation shape (PyTorch).
- `docs/hub-recovery-plan.md`: the plan for this part and how it plugs into the team's work.

## Run

Serve the repo root, because ES modules don't load from `file://`:

```bash
python3 serve.py
```

Then open http://localhost:8080/demo/ for the 2D version or http://localhost:8080/demo3d/ for 3D.

## Retrain the network

```bash
python3 -m venv nca/.venv && nca/.venv/bin/pip install torch numpy
nca/.venv/bin/python nca/train_nca.py                # ~16 min on an M2
node nca/eval_regrow.mjs                             # erase each drone slot, check it regrows
```

## Tests

```bash
npm test
```

## Reference code

The network is based on Google's Growing Neural Cellular Automata (Apache-2.0). The original code isn't committed here; clone it with:

```bash
git clone --depth 1 https://github.com/google-research/self-organising-systems.git vendor/self-organising-systems
```
