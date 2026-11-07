# Resilient rescue drone swarm: hub recovery

For GreatUniHack 2026, Neptune North challenge. Drones search mountains for missing people and keep going when radio fails: no drone waits for instructions, and what they learn reaches base once a route exists. A report that has reached one other drone survives losing its finder or the hub. A neural cellular automaton, based on [Google's self-repairing gecko](https://distill.pub/2020/growing-ca/), is computed by the drones between them: each runs it on its own patch and swaps edge cells with neighbours by radio, and the formation picture regrows when one fails.

- `recovery/`: drop-in frontend modules (no dependencies). See [recovery/README.md](recovery/README.md).
- `demo/`: interactive demo. `drone.js` is what one drone does, `sim.js` is the simulation with no DOM, `demo.js` draws it. Choose how many drones launch, fail them, paint a radio blackout, cut all radio, and watch the search graph. The graph compares this run with two unseen runs on the same terrain: one with comms on and nothing failed, one with no radio from launch.
- `demo3d/`: the same demo in 3D (Three.js, vendored in `demo3d/vendor/three`, MIT). It runs the same `demo/sim.js`; drag to orbit, scroll to zoom, click a drone to see its view.
- `site/`: the presentation website: intro, the 26 August 2026 Langtang timeline with real photos, a scroll-driven 3D rescue scene (three.js), a link to the demo, and four real-world applications. Open http://localhost:8080/site/. Brief: `docs/presentation-brief.md`.
- `nca/train_nca.py`: trains the network on the formation shape (PyTorch).
- `demo/phone.html`: a page that turns an iPhone into one of the drones. `phone-drone.js` flies it, `net.js` links devices directly, `phone-link.js` is the big screen's side, `mission.js` holds what every device must agree on, and `phone-server.mjs` is the helper. See [Run with phones](#run-with-phones).
- `docs/hub-recovery-plan.md`: the plan for this part and how it plugs into the team's work.
- `docs/designs/phone-drones.md`: the design of phone mode, with test results.

## Install

```bash
npm install
```

This installs the one dependency, `qrcode-generator`, which the phone helper uses. The project needs Node 20 or later. `npm test` and `npm run phones` run it for you. If the install fails, `npm test` stops, but `npm run phones` carries on and the helper starts without the QR code: `/qr.svg` returns 503, and phones use the address the helper prints. The demo pages themselves need nothing installed.

## Run

Serve the repo root, because ES modules don't load from `file://`:

```bash
npm run demo
```

This runs `python3 serve.py`.

Then open http://localhost:8080/demo/ for the 2D version or http://localhost:8080/demo3d/ for 3D.

## Run with phones

Up to three iPhones fly drones 1, 2 and 3 for real, and the laptop flies the rest. Put the laptop and the phones on the same Wi-Fi, and set Auto-Lock to Never on each phone (Settings > Display & Brightness), because the page can't keep the screen awake. Then:

```bash
npm run phones
```

Open http://localhost:8080/ on the laptop only. This is the big screen. Choose the number of drones first (15 by default), as changing it starts a new run. Phones scan the QR code on the big screen; don't type the localhost address on a phone. Then press Launch, which stays off until a phone has joined. Before launch, the Fail buttons are refused. In a narrow window the Phones panel comes first, above the map.

Wait about 35 seconds after launch, for the phone drones to reach their strips. Then turn on aeroplane mode on a phone: it keeps searching on its own, and the ground it searched comes back when it reconnects.

Yellow means not connected, on both screens. After launch, a drone on the big screen gets a pulsing yellow halo and a tag such as `2 NOT CONNECTED` at its last known position. Before launch, a phone that isn't linked only gets the halo, and the Phones panel names it.

The status box on a phone shows one of these once the drone is flying:

| Status | Meaning |
|---|---|
| CONNECTED (green) | Linked to the big screen or another phone |
| CONNECTING (yellow) | This page has just loaded and isn't linked yet |
| NOT CONNECTED (yellow) | No link to any device. The drone carries on and counts the cells it explores alone |
| RADIO OFF (yellow) | The "Radio off" button is on. It's a button, not a real outage |
| BIG SCREEN LOST (yellow) | Still linked to another phone, but not to the laptop |

The line below it is about simulated radio, so a connected phone can still read "Hears nobody over radio". It says "Hears N drones", with "and base" if base is in range, or "Hears base", or "Radio cut from the big screen". It ends with the hub, as "Hub: drone N" or "This drone is the hub".

The phone's map shows what that drone knows:

| Colour | Meaning |
|---|---|
| Teal | Searched by this drone |
| Yellow | First explored by this drone while offline |
| Blue | Learned from other drones |
| Dark | Not explored |
| Dashed white outline | This drone's strip |
| Red | Radio blackout |

A reloaded phone carries on with its drone. The page saves the drone to `localStorage` every 2 seconds, per mission and drone.

Reloading or reopening the big screen during a run rejoins that run, if it was launched in the last 20 minutes. The page replays the laptop's drones to the shared clock from the same seed, and the phones then bring back what they know. Anything done on the laptop is lost: failed drones fly again, and blackouts, a radio cut and range changes are gone, on the phones too. A second big screen tab is refused while the first is running. To start a new run, use Reset, the Drones slider, New terrain, or "Start a new run here". Phones keep their drones into the next run and reload by themselves. Before launch, a phone page that stops polling for 10 seconds gives up its drone, and reloads itself to join again when it returns.

Keep the phone page open throughout, because a hidden phone page stops. Keep the big screen in front too: if it's hidden it stops drawing, and a timer steps it only about once a second. Phone mode is in the 2D demo only; `demo3d/` doesn't show phone drones.

The helper serves the pages, starts the mission, shares the clock and introduces devices. Positions and findings never pass through it. Only the laptop can start or launch a mission. Phones need the helper to join, to reload and to reconnect after an outage, but linked phones keep talking without it.

The separate devices, the Wi-Fi links between them and aeroplane mode are real. The flight, sensors, terrain, people and drone radio range are simulated on each phone.

If the QR code shows the wrong address, set it yourself:

```bash
PHONE_HOST=192.168.1.20 npm run phones
```

To read what each phone logged during a rehearsal, start the helper with logs on and open http://localhost:8080/report:

```bash
PHONE_LOGS=1 npm run phones
```

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

`demo/test/pages.test.mjs` checks that every page script parses. No test runs the pages in a browser.

## Reference code

The network is based on Google's Growing Neural Cellular Automata (Apache-2.0). The original code isn't committed here; clone it with:

```bash
git clone --depth 1 https://github.com/google-research/self-organising-systems.git vendor/self-organising-systems
```
