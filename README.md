# Resilient rescue drone swarm: hub recovery

For GreatUniHack 2026, Neptune North challenge. Drones search mountains for missing people and keep going when radio fails: no drone waits for instructions, and what they learn reaches base once a route exists. A report that has reached one other drone survives losing its finder or the hub. A neural cellular automaton, based on [Google's self-repairing gecko](https://distill.pub/2020/growing-ca/), is computed by the drones between them: each runs it on its own patch and swaps edge cells with neighbours by radio, and the formation picture regrows when one fails.

- `recovery/`: drop-in frontend modules (no dependencies). See [recovery/README.md](recovery/README.md).
- `demo/`: interactive demo. `drone.js` is what one drone does, `sim.js` is the simulation with no DOM, `demo.js` draws it. Choose how many drones launch, fail them, paint a radio blackout, cut all radio, and watch the search graph. The graph compares this run with two unseen runs on the same terrain: one with comms on and nothing failed, one with no radio from launch.
- `demo3d/`: the same demo in 3D (Three.js, vendored in `demo3d/vendor/three`, MIT). It runs the same `demo/sim.js`; drag to orbit, scroll to zoom, click a drone to see its view.
- `nca/train_nca.py`: trains the network on the formation shape (PyTorch).
- `demo/phone.html`: a page that turns an iPhone into one of the drones. `phone-drone.js` flies it, `net.js` links devices directly, and `phone-server.mjs` is the helper that introduces them. See [Run with phones](#run-with-phones).
- `docs/hub-recovery-plan.md`: the plan for this part and how it plugs into the team's work.
- `docs/designs/phone-drones.md`: the design of phone mode, with test results.

## Install

```bash
npm install
```

This installs the one dependency, `qrcode-generator`, which the phone helper uses. `npm test` and `npm run phones` run it for you. The demo pages themselves need nothing installed.

## Run

Serve the repo root, because ES modules don't load from `file://`:

```bash
python3 serve.py
```

Then open http://localhost:8080/demo/ for the 2D version or http://localhost:8080/demo3d/ for 3D.

## Run with phones

Up to three iPhones fly drones 1, 2 and 3 for real, and the laptop flies the rest. Put the laptop and the phones on the same Wi-Fi, and set Auto-Lock to Never on each phone (Settings > Display & Brightness), because the page can't keep the screen awake. Then:

```bash
npm run phones
```

Open http://localhost:8080/ on the laptop and keep that window in front. This is the big screen. Choose the number of drones first, as changing it starts a new run. Scan the QR code with each iPhone, then press Launch.

Wait about 35 seconds after launch, for the phone drones to reach their strips. Then turn on aeroplane mode on a phone: it keeps searching on its own, and what it found merges in when it reconnects. Keep the phone page open throughout, because a hidden page stops running.

Phone mode is in the 2D demo only; `demo3d/` doesn't show phone drones. Keep the big screen's window in front: if it's hidden it stops running, and the swarm wrongly writes off the phones.

The helper only introduces devices, and holds no swarm data. Phones need it to join and to reconnect after an outage, but linked phones keep talking without it. Flight, sensors and the missing people are simulated on each phone; the network and any outage are real. To read what each phone logged during a run, open http://localhost:8080/report.

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
