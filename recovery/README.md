# recovery/ — hub recovery + self-healing formation

Two plain ES modules, no dependencies, no build step. Drop this folder into the frontend.

| File | Size | What it is |
|---|---|---|
| `swarm-recovery.js` | light | Shared swarm state, merge, hub takeover, hop counts, comms modes, home strips, formation slots |
| `nca-runtime.js` | light | Runs the trained "gecko" network in the browser (plain JS) |
| `models/formation-nca.json` | ~100 KB | Trained weights. Rebuild with `python3 nca/train_nca.py` |

## Use in the simulation (each tick)

```js
import * as R from './recovery/swarm-recovery.js';

// once per drone (and once for base with R.BASE_ID)
drone.state = R.createState(drone.id, allIds, { hubId: 1 });

// every tick, for every live drone and the base:
const inbox = neighboursInRadioRange(drone).map((n) => structuredClone(R.snapshot(n.state)));
const { hubStatus, mode, events } = R.step(drone.state, inbox, tick); // mode: 'hub' | 'neighbours' | 'alone'

// when the drone senses things
R.recordVisit(drone.state, cx, cy);
R.recordSurvivor(drone.state, 's3', x, y, tick);

// where to go (worked out locally, no messages needed)
R.homeSector(drone.state, drone.id, COLS);  // [c0, c1) home strip, fixed at launch
R.reportToCarry(drone.state, tick);         // report id to fly back, or null
R.formationSlotFor(drone.state, drone.id);  // [x, y] in 0..1 along the V
R.isHub(drone.state);                       // draw the hub ring
```

`snapshot(state)` is plain JSON. Put it in the radio message as-is. Clone it if you deliver in the same JS thread, so drones don't share objects.

## Gecko panel

```js
import { NCA } from './recovery/nca-runtime.js';
const nca = new NCA(await (await fetch('recovery/models/formation-nca.json')).json());
nca.reset();                           // one seed cell
// every frame:
nca.step(); nca.draw(canvas.getContext('2d'));
// when a drone fails:
nca.erase(slotX * nca.N, slotY * nca.N, 5);
```

## Run the demo

ES modules don't load from `file://`, so serve the repo root:

```bash
python3 -m http.server 8080
```

Then open http://localhost:8080/demo/

## Tests

```bash
npm test
```

They check that merging is order-independent and that a hub failure gives exactly one new hub. They also check that a report from a drone that later fails still reaches base, that a split swarm comes back to one hub, and that the JS network matches PyTorch. `demo/test/` runs the real simulation headless: blackouts, line of sight, reports getting home after their finders fail.

## Tunables

`R.DEFAULTS.hubTimeout` (30 ticks) and `failTimeout` (90 ticks) are set in `swarm-recovery.js`. Keep them larger than the number of ticks a message needs to cross the swarm. Shorter values make hub takeover quicker but give more false takeovers once ridges block radio.

A drone that hears nobody for more than `contactWindow` (3) ticks assumes it is the one cut off: it keeps everyone in its roster and doesn't claim the hub. Timeouts count only ticks when a drone could hear someone.

`visited` is a bitmap sized by `cols` and `rows`, which default to 44 x 30. Pass them to `createState` for a different grid, and read it with `R.isVisited` and `R.visitedCount`.
