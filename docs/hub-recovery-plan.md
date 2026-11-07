# Hub recovery and self-healing formation: my part

Owner: Vitalii · Add-on to "Hackathon plan: resilient rescue drone swarm" (the team's main plan, kept outside this repo)

This describes what is built. `hub-recovery-plan.pdf` next to this file is the original proposal and is out of date.

## TL;DR for the team

- **Piece A, shared swarm memory:** every drone keeps a copy of what the swarm knows and passes it on at every contact. A drone that hears nobody carries on alone. Failing the hub, or any other drone, doesn't stop the search.
- **Piece B, gecko panel:** a Growing Neural Cellular Automaton, based on Google's self-repairing gecko demo, trained on the V formation. The drones compute it between them: each owns a patch of the grid and swaps edge cells with its neighbours by radio. It draws the V; it doesn't steer the drones.
- **What the hub does:** nothing depends on it, on purpose. See "What the hub does" below.

## Piece A: shared swarm memory

### Goals

The common goal is finding every missing person and telling base. The brief says actors must keep working "without receiving instructions from a central hub". So:

- The search continues with no hub and no radio.
- What drones learn reaches base once a route exists.
- Success: a total blackout barely slows the search, and base catches up when radio returns.

Out of scope: battery, payload and real radio hardware.

### How a drone decides, with no instructions

Each drone runs the same rules on its own copy of the state:

1. **Search its home strip.** Strips are split from the launch list and never change, so no message is needed to agree them (`homeSector`).
2. **Then help.** When its strip is done, it flies to the nearest cell it believes is unsearched. This is also how a failed drone's strip gets covered. A cut-off drone can't know what others searched, so at this stage it repeats their ground. There is no mission-end signal.
3. **Carry reports home if there's no route.** A drone with no hop count to base flies an undelivered report back (`reportToCarry`). The finder leaves at once. Other holders wait their turn by rank, counted from when they got the report or lost the route, so the report survives the finder and a group doesn't leave together. A mule that reaches base and still can't be heard goes back to searching and retries later.
4. **Come home when nothing is left.** This hands base the final map.

### Comms modes

| Mode | Meaning | Behaviour |
|---|---|---|
| Hub reachable | Has news of the hub, directly or through others, within `hubTimeout` | Normal |
| Neighbours only | Hears a drone or base, but the hub has gone quiet | Normal; a takeover may follow |
| Fully cut off | Heard nobody for more than `contactWindow` ticks | Keeps everyone in its roster, claims nothing, keeps searching |

The rules above apply in every mode, so a drone never waits for an answer. The modes describe what a drone can hear, and they lag: a hub that has just failed still counts as reachable until `hubTimeout` passes.

### What each drone knows

| Field | Rule when two copies meet |
|---|---|
| Survivors | union; `delivered` = OR; earliest finder kept |
| Visited cells | bitmap, OR |
| Roster | per drone, higher `v` wins; a drone refreshes its own entry every tick, so one wrongly marked failed comes back |
| Hub | higher `epoch` wins, lowest ID breaks ties |

Hop count to base isn't merged. Each drone recomputes it from its neighbours every tick (`updateHops`). It decides whether a drone needs to carry a report. Reports themselves spread by gossip, so they don't travel along the gradient.

A full message is about 1.3 KB for 15 drones with all 7 reports on the 44 x 30 grid. It goes to each neighbour up to 4 times per 160 ms tick, so about 30 KB/s per neighbour. That suits Wi-Fi-class links, not LoRa.

### Taking over as hub

- If the hub's roster entry is more than `hubTimeout` (30 ticks, about 4.8 s) old, the hub is suspect.
- The lowest live ID a drone has fresh news of takes over with `epoch + 1`, but only if that drone can hear someone.
- If the old hub comes back, its epoch is lower, so it steps down and merges.
- A drone not heard for `failTimeout` (90 ticks, about 14 s) is marked failed, unless the drone marking it is itself cut off.
- Both timeouts count only ticks when a drone could hear someone. Time spent cut off counts against nobody, so radio coming back doesn't trigger false failures.

If a blackout splits the swarm, each half may pick a hub. When the halves reconnect, the higher epoch wins.

### What the hub does

The hub role doesn't change any drone's behaviour. Search, reports and mules all work without it, which is what the brief asks for: the hub is optional, so losing it costs nothing. Takeover stays as a demo beat: a judge fails the hub, the role moves on, and nothing else changes. We tested giving the hub the job of dealing out leftover cells in a separate simulation and it made no measurable difference, so it stays display-only.

### Alternatives we rejected

- **Dedicated backup drone:** it's one more thing to lose. Every drone holds a copy instead.
- **Recomputing strips from the live roster:** cut-off drones marked everyone failed, took the whole map and re-swept each other's ground. Coverage stalled around 28% in a blackout at tick 60. Fixed strips reach 98-100% (8 terrains, measured by hand). Formation mode still works this way, so false failures can move its slots.
- **Delta gossip:** less to send, but it needs per-neighbour tracking. A 1.3 KB full message makes that unnecessary in a simulation; real low-bandwidth radio would need it.
- **Quorum-based election:** avoids two hubs, but leaves a split swarm with none. As the hub is display-only, two hubs for a while do no harm.

### Seeing what each drone knows

Click a drone and the map shows only its private copy: the ground it knows is searched and the people it knows about. That ground is painted solid in the drone's colour where it searched itself, and in the finder's colour where another drone searched it and told it, so you can see each drone's share of the work and what it got from the others. Who searched a cell is tracked by the simulation for this view only; the radio message just says the cell is searched. Its panel compares that with reality. The "Who knows about each person" table below the map shows, for every found person, which drones and whether base know about them. In a blackout the drones disagree and the rows turn patchy; they fill in when the drones reconnect. Nothing a drone decides reads the full map, so this view is what it actually acts on.

### Limits (for judge questions)

- **A report held by one drone can die with it.** Replication only works after contact. The person can still be found again, and "Reports lost" counts this case.
- **False takeovers still happen.** With ridges blocking radio and nothing failed, a run has about 3-5 takeovers, and on some terrains every drone is marked failed at some point, then rejoins. The search doesn't notice, but mule order and Formation slots can shift, and it's visible.
- **Comms barely change how fast ground is searched,** because strips are fixed. What comms decide is when base finds out: in a total blackout base stays at whatever it knew when radio went, about 15% for a cut at tick 60, until radio returns.
- **Survivor timestamps assume a shared clock,** which real drones would get from GPS. Timeouts don't need one.
- **Messages aren't authenticated.** A forged epoch or `delivered` flag would be believed.
- **It's a simulation.** Drones move in 2D over a height map, and battery and payload aren't modelled.
- **Hop counts top out at 16,** so a longer chain would read as no route.

## Piece B: gecko panel

A 40 px grid, trained locally with `nca/train_nca.py` (PyTorch) in Regenerating mode. The weights export to JSON and run in plain JS (`recovery/nca-runtime.js`). Failing a drone erases part of the shape, and it regrows.

The grid is split between the live drones: each owns the cells nearest its place in the V (`assignOwners`) and computes only those (`stepSwarm`). A cell needs its 8 neighbours, so at patch borders a drone needs the cells another drone owns. It gets them from drones it can reach by radio, relays included. For a drone it can't reach, it keeps working from the last copy it received. When a drone fails, the patches are re-split and its neighbours regrow its part. Split this way with everyone in reach, it gives exactly the same result as running the network in one place (tested).

The panel tints each drone's patch and badges it with the drone's id. Patch borders are white when the cells are being swapped, brighter while that part is rebuilding, and red dashed when the neighbour is out of reach. Clicking a drone shows its own copy of the grid, with the parts it can't currently hear tinted red.

### Honest limits

- **It draws the formation, it doesn't fly it.** The drones compute the network, but where each drone flies comes from the shared state, not from the network. In Formation mode, they take slots by rank among the drones they've had news of within `slotTimeout` (15 ticks, about 2.4 s), so gaps close sooner than a drone is marked failed. Ridges make the V twitch, because a drone that dips behind one looks gone, so selecting Formation turns them off.
- **Patches are split using the true list of live drones,** not each drone's own belief, to keep the panel simple.
- **Stale copies hide damage instead of breaking the shape.** The V doesn't change, so an old copy of a neighbour is still a good copy. Cutting radio turns borders red, but the shape stays whole; a drone's view only goes wrong when the patch it can't hear was damaged.
- **The shape has 9 dots.** The demo launches 9 drones by default, so an erased patch matches the drone's slot. With another count, it only roughly matches.
- **The relay chain from the main plan isn't built.** The trained shape is the V.

Pitch line: *"Same idea as the self-repairing gecko: every drone runs one small learned rule on its own patch, using only what its neighbours radio it, and the whole repairs itself without a leader."*

### Message animations

On the map, dots fly along radio links when news crosses them: orange for a found person, green for "base has this report", gold for a new hub, small blue for searched ground (thinned out). A ring flashes on each drone as the news reaches it, hop by hop, so a find spreads visibly across the swarm. A new hub sends out a large gold ring, and each found person shows how many drones know about them. This is worked out from the shared state before and after each radio tick (`demo/messages.js`); it doesn't change the simulation.

## Touchpoints with the main plan

The demo already contains working versions of the main plan's parts: simulation and UI, sector split, drone policy, line of sight, blackout tools and the live graph. Anyone with their own version should agree with me how to merge it.

The protocol contract is `step(state, inbox, now)`, where `inbox` is the `snapshot()` of each neighbour in radio range. See `recovery/README.md`. The decision rules above are in `chooseTarget` in `demo/sim.js`, which also runs the extra relay rounds per tick.
