# Swarm demo: data inventory for the frontend

This lists everything the demo tracks and shows, so the layout can be rebuilt without changing the simulation. The page title, the gecko card and Formation mode stay as they are.

All the display code is in `demo/demo.js`. The simulation is `demo/sim.js`, and each drone's memory is the state in `recovery/swarm-recovery.js`. In the code, `world` is the run on screen and `d` is a drone.

## Where the data comes from

Every value belongs to one of four sources. Most of the demo's point is the gap between them, so a new layout should keep them visibly separate.

| Source | What it is | Read it from |
|---|---|---|
| Reality | What is actually true. No drone can see this; only the viewer can | `world.drones`, `world.survivors`, `world.truthVisited`, `world.links` |
| One drone's copy | What that drone has seen or been told. It decides using only this | `d.state` |
| Base's copy | What the rescue team knows | `world.base.state` |
| Comparison runs | Two hidden runs on the same terrain and people, used only by the graph | `reference.on`, `reference.off` |

Timing: the simulation ticks every 160 ms and the numbers refresh on each tick (`updateStats`). The map redraws every frame. The graph takes a sample every 4 ticks (0.64 s).

## Swarm card

| Shown as | Meaning | Source | Read it from |
|---|---|---|---|
| Reports at base, of people found (`2/4`) | Reports base holds / people found so far. Box turns red if any report is lost | Base's copy + reality | `world.base.state.survivors`, `world.survivors` |
| Area searched | Share of the map really searched | Reality | `world.coverage()` |
| Area known at base | Share of the map base knows is searched | Base's copy | `world.baseCoverage()` |
| People found (`4/7`) | People found by at least one drone / total | Reality | `s.foundBy` |
| Reports lost | People found, but no live drone and not base holds a report | Reality | `world.holders(s)` |
| Hub line | Current hub and its epoch (how many times the role has moved). Also shows how many drones can't hear it, or that the hub is silent and when a takeover is due | All drones | `world.currentHub()`, `state.hub.epoch`, `d.hubStatus` |
| Live drones (`8 / 9`) | Drones still flying / launched | Reality | `d.alive` |
| Hub reachable / Neighbours only / Fully cut off | How many live drones are in each radio state | Each drone | `d.commsMode` |

`world.currentHub()` is a majority vote among live drones, because during a split there can be two hubs.

## Map

| Layer | Meaning | Read it from |
|---|---|---|
| Terrain | Mountain background. Fixed for a run; the seed is shown on the New terrain button | `world.terrain` |
| Dark fog | Ground not searched yet | `world.truthVisited`, or `R.isVisited(d.state, c, r)` for a selected drone |
| Dotted vertical lines | Home strips, one per drone (Search mode) | `R.homeSector` |
| Dashed V | The target shape (Formation mode) | `R.FORMATION_POLYLINE` |
| Red cells | Radio blackout | `world.blackout` |
| Blue lines | Radio links this tick | `world.links` |
| Dashed red lines | In range, but a ridge blocks the signal | `world.blocked` |
| H and BASE | Base location | `BASE` |
| Faint grey person | Not found yet. Only the viewer can see this person | `s.foundBy` is null |
| Orange person, pulsing, "SOS" | Found, report not at base | `s.foundBy`, not in base survivors |
| Green person, "REPORTED" | Report is at base | In base survivors |
| Red X with number | Failed drone, with an expanding ring for 1.5 s | `!d.alive` |
| Drone body | Position and heading | `d.x`, `d.y`, `d.angle` |
| Ring round a drone | Sensor range, coloured by radio state: teal hub reachable, orange neighbours only, red cut off | `d.commsMode` |
| Dot in the middle of a drone | Colour from its rank in its own roster. It can change during a run, so it doesn't identify a drone | `hue()` |
| Gold ring, "HUB" | This drone believes it is the hub | `R.isHub(d.state)` |
| Dashed orange ring, "?" | This drone suspects the hub has gone | `d.hubStatus` |
| Label under a drone (`4 · 2 hops`) | Drone ID and radio hops to base, or "no route" | `d.state.hops` |
| "carrying report" | Flying a report home because it has no route | `d.muling` |

## Selected drone

Clicking a drone opens a panel and switches the map to that drone's view. Escape, "Back to full view" or clicking empty map leaves it.

| Row | Meaning | Read it from |
|---|---|---|
| Doing | Its current job, in plain words | `d.task` |
| Radio | Has news of the hub / hears others but not the hub / hears nobody | `d.commsMode` |
| Route to base | Hop count, or none | `d.state.hops` |
| Map it knows | Share it believes is searched, next to the real figure | `R.visitedCount(d.state)`, `world.coverage()` |
| Thinks alive | How many drones it believes are alive, next to the real figure | `R.liveIds(d.state)` |
| Thinks the hub is | Which drone it believes is the hub | `d.state.hub.id` |
| People it knows of | Reports it holds, next to the real number found | `d.state.survivors` |
| Report list | Per report: who found it, and whether this drone knows base has it | `d.state.survivors[id]` |

What changes on the map in this view:

- Fog shows only the ground this drone knows is searched, and is darker.
- People it doesn't know about disappear.
- A person turns green only if this drone knows base has the report.
- Only its own radio links are drawn.
- Other drones and wrecks dim to 30%, and it gets a white ring.

Other drones stay at their real positions in this view, although a drone doesn't actually know them. Positions aren't sent over radio, so a stricter view could hide them.

## Who knows what grid

The grid shows, for base and every launched drone, what it knows about each of the 7 people. It uses each copy's `state.survivors[personId]`.

| Cell | Meaning |
|---|---|
| Empty | Doesn't know about this person |
| Orange ● | Knows, and doesn't know whether base has it |
| Green ✓ | Knows, and knows base has it |

Rows are clickable and select that drone. A failed drone's row is struck through. Below the grid, "Drones know 22% of what's been found" comes from `world.agreement()`: of all live drone and found person pairs, the share where the drone holds the report. It leaves out base and failed drones.

Why it's hard to read:

- **An empty cell has two meanings.** It can be "this drone hasn't heard" or "nobody has found this person yet". Both look the same.
- **✓ is second-hand.** A drone without ✓ doesn't mean base lacks the report. Only the Base row answers that.
- **The columns mean nothing to a viewer.** People are just numbered 1 to 7.
- **It's up to 16 rows by 7 columns of very small text** (15 drones plus base), sitting on top of the map.

It tries to answer three questions at once: which reports reached base, who is out of date, and how far the swarm disagrees. The same data can be cut per person instead: found by whom, at base or not, and how many live drones know.

## Search progress graph

| Line | Meaning | Read it from |
|---|---|---|
| Searched, this run (solid) | Real coverage | `world.coverage()` |
| Known at base, this run (solid) | Base's coverage | `world.baseCoverage()` |
| Searched, comms on, nothing failed (dashed) | Comparison run. Follows the radio range and ridges settings | `reference.on.coverage()` |
| Searched, no radio from launch (dotted) | Comparison run | `reference.off.coverage()` |

The vertical markers are `hub failed`, `drone N failed`, `blackout`, `blackout lifted`, `radio cut` and `radio back`. Each legend row shows the latest value, and hovering gives all four at that moment. The data is in `history` and `marks`. In Formation mode the comparison runs keep searching, so the lines stop being comparable.

## Events log

It shows the newest 40, each with a time in seconds. Messages contain HTML (`<b>`).

| Event | Example |
|---|---|
| Launch | Swarm launched over terrain #2026: 9 drones, drone 1 is the hub, 7 missing people |
| Person found | Person s3 found by drone 4 |
| Person found again | Person s3 found again by drone 6 — the first report was lost |
| Report delivered | Report for person s3 reached base — rescue team dispatched |
| Drone failed | Drone 2 failed — it was the hub |
| Hub takeover | Drone 3 took over as hub (epoch1) — lowest live id it can reach |
| Hub suspect | Drone 5: no word from hub 1 for 5 s — hub suspect |
| Marked failed | Drone 4 has heard nothing of drone 2 for 14 s — treating it as failed |
| Carrying a report | Drone 6 has no route to base — flying report s3 back (data mule) |
| Carrying failed | Drone 6 can't reach base even from here — back to searching, will retry |
| Hub already down | The hub is already down — no drone has taken over yet |
| Gecko regrow | Formation panel: damage too close to the seed — regrowing from one cell |

People are named three ways: `s3` in the log and drone panel, `3` in the grid, and "Person s3" in sentences. One name throughout would help.

## Gecko panel

| Shown as | Meaning | Read it from |
|---|---|---|
| Image | The self-repairing V. Failing a drone or clicking the image erases part of it | `nca.draw()` |
| Shape restored: 93% | How close it is to the trained shape | `nca.similarity()` |

It steps every 4 frames, and the percentage updates every 15 frames. The card stays as it is.

## Tracked but not shown

| Data | Meaning | Read it from |
|---|---|---|
| Who each drone thinks is alive | The list itself. Only the count is shown | `d.state.roster` |
| Which epoch each drone is on | Shows when drones disagree about the hub | `d.state.hub.epoch` |
| When each person was found, and where | Found tick and position, per report | `state.survivors[id].tick`, `.x`, `.y` |
| When a drone got a report | Tick it first held each report | `d.state.heldSince` |
| Time out of contact | Last tick it heard anyone, and how long it has had no route | `d.state.lastHeard`, `d.state.noRouteSince` |
| Where a drone is heading | Its current target point | `d.target` |
| Elapsed time | Tick count (× 0.16 for seconds). Only used for log times and the graph axis | `world.tick` |
| Link counts | How many links are up or blocked | `world.links.length`, `world.blocked.length` |
| Comparison runs' finds | People found in each hidden run | `reference.on.survivors`, `reference.off.survivors` |

## Not tracked at all

These would need a small simulation change before they could be shown.

| Data | What's missing |
|---|---|
| Duplicate finds | How many times a person was found by a drone that didn't know they already had been. The log only reports a re-find when the first report was lost |
| When a report reached base | Base marks it delivered but doesn't store the time |
| Number of hub takeovers | Only the log records them, though the epoch gives a rough count |
| False failure count | Drones wrongly marked failed appear only in the log |
| Battery and payload | Not modelled |

## Controls

| Control | Options | Effect |
|---|---|---|
| Mode | Search, Formation | Formation also turns off Ridges block radio |
| Fail the hub, Fail a random drone | Buttons | Fails a drone and marks the graph |
| Fail this drone | In the drone panel | Fails the selected drone and closes the panel |
| Paint blackout | Toggle, then drag on the map | Paints a 60 px radius brush |
| Clear blackout | Button | Removes all blackout |
| Cut all radio | Toggles to Restore radio | Stops all links |
| Reset | Button | Restarts the same terrain |
| New terrain | Button, shows the seed | Restarts on a random terrain |
| Drones | Slider, 3 to 15, default 9 | Restarts the run |
| Radio range (px) | Slider, 40 to 320, default 190 | Applies live |
| Ridges block radio | Checkbox, default on | Applies live |
| Regrow from one cell | Button on the gecko card | Restarts the gecko |

## Phone mode

`demo/?phones=1` runs some drones on phones. The layout gains a Phones card, and these values change meaning:

| Value | Change in phone mode | Read it from |
|---|---|---|
| Phones card | QR code, join address, which drones are linked, and the Launch button | `/qr.svg`, `/mission` |
| Dashed ring, "PHONE" | This drone is flown by a phone. Red, "PHONE: NO CONTACT", when its connection is lost | `d.remote`, `d.inContact` |
| Reality | The laptop can't see a phone offline, so `world.truthVisited`, `s.foundBy` and a phone drone's position mean "everything received so far". The map fills in when a phone reconnects | `world.truthVisited` |
| One drone's copy, for a phone drone | What that phone last said, not live. It freezes during an outage | `d.state` |
| Graph | Shows this run only: the two comparison runs can't include a phone, so `reference` is null | `reference` |
| Drones slider | Starts a new mission, and the phones rejoin by themselves | `?drones=` |
| Reset, New terrain | Start a new mission in the same way | `?seed=` |
| Fail buttons | Skip phone drones, which are failed with aeroplane mode on the phone | `d.remote` |

