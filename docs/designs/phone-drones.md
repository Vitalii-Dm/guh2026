# Phone Drones: a real network failure in the judge's hand

*   **Author:** Dima
*   **Status:** Implemented; rehearsal in progress
*   **Date:** 2026-11-07

--------------------------------------------------------------------------------

## Overview

The rescue swarm demo currently runs all 15 drones as one program in one browser
tab. This design makes part of the swarm run on separate devices. A judge scans
a QR code, and their phone becomes one of the 15 drones. The drone's search and
its copy of the swarm's knowledge then live on that phone, not on the laptop.

The judge switches on aeroplane mode. Their drone drops off the big screen, but
the phone keeps searching and may find a person. When the judge switches
aeroplane mode off, the phone reconnects and what it learned while offline
merges into the swarm's map on the big screen.

Up to three phones join. The laptop runs the base station and the remaining
simulated drones. The swarm logic in `recovery/swarm-recovery.js` is already
built and tested, including merging two copies of the swarm's knowledge. The new
work is everything needed to run that logic across real devices.

Terms used in this document:

*   **Hub**: the drone the others treat as coordinator. Nothing depends on it;
    if it fails, another drone takes over.
*   **Base**: the fixed station that rescue reports must reach.
*   **Strip**: the column of the map a drone searches first.
*   **Tick**: one 160 ms round of the swarm protocol.
*   **Big screen**: the laptop's display, which judges watch.

## The Problem

The project claims that a search carries on when communications fail, because no
drone waits for instructions. The demo cannot prove this. Every drone shares one
program, one clock and one memory, and "radio failure" is a rule in that program.
A judge can fairly say: "that is a simulation of a distributed system, not a
distributed system."

A real failure answers that objection better than an explanation does. If the
judge cuts the connection with their own hand and the drone carries on, nobody
has to take our word for it.

Four facts from the current code limit how this can work. The first two put the
demo's main moment at risk.

1.  **The mission is shorter than the demo.** Across 10 seeds of the current
    simulation, the search ended in 43–50 seconds and the last person was found
    at 29–41 seconds. Scanning, joining, going offline and reconnecting will
    take longer than that.
2.  **Finding someone offline is unlikely by chance.** Only 5–7 of the 15 drones
    find anyone in a run. A randomly chosen drone has about a 40% chance across
    the whole mission, and a lower chance during a short offline window.
3.  **Radio is currently a calculation.** The simulation decides who can talk
    from distance and ridges. A real connection is a second, separate source of
    truth, and the two can disagree.
4.  **Swarm messages do not carry position.** The big screen cannot draw a phone
    drone from the state messages alone. Those messages measured 541–1,017 bytes
    for 15 drones and 7 people.

## Goals

1.  **Real separation.** A phone drone runs the unmodified
    `recovery/swarm-recovery.js`, and it moves and senses on the phone. During an
    outage it needs nothing from the laptop.
2.  **Quick join.** A judge goes from scanning the QR code to controlling a drone
    in under 20 seconds, with nothing to install.
3.  **A visible outage.** Within 2 seconds of the connection being lost, the big
    screen shows that drone as out of contact, and the phone shows it is
    searching alone.
4.  **A visible recovery.** Within 5 seconds of the connection returning, with a
    neighbour in simulated range, the ground and reports the phone gathered
    offline appear in the swarm's picture on the big screen. Reports then reach
    base by the existing routes, including a drone flying them home.
5.  **A dependable payoff, with no staged find.** A phone offline for 30 seconds
    brings back at least 15 map cells that the rest of the swarm had not
    searched, in every rehearsal run. Finding a person offline is left to
    chance: about 40% of drones find anyone in a run, so it is a bonus, and the
    presenter's line is "your phone kept searching".
6.  **Enough time.** Phones join before launch. The mission lasts long enough for
    a judge to go offline for 30 seconds and reconnect while there is still
    ground to search. The target is at least 3 minutes after the first phone
    joins.
7.  **iPhones only.** Two or three iPhones complete the sequence in the same run.
    Only iPhones are tested. Judges use a team iPhone, because a judge's Android
    phone may work but is unsupported.
8.  **A demo that cannot be stranded.** The existing `demo/` page and all 37
    existing tests keep working with no phones present. A manual "radio off"
    button and a recorded video cover the case where the live version fails.
9.  **An accurate claim.** The presenter and the pages say what is real and what
    is simulated. The network failure, the separate devices and the merge are
    real. The flight, sensors, terrain and people are simulated on the phone.
    Any helper used for connecting is disclosed, and the claim is true of what
    that helper does.
10. **No laptop needed between phones.** With the laptop taken off the network,
    two phones in simulated range keep exchanging what they find, and they elect
    a new hub between themselves if theirs was on the laptop. This is the step that shows the phones talk
    directly, and it is the reason for using WebRTC.

## Non-Goals

*   Arranging for a phone to find a person, by choosing the map or by moving
    anyone.
*   Exempting phones from any radio rule. A phone drone obeys range, ridges and
    blackouts like every other drone.
*   Letting a phone join after launch, or taking over a drone in flight.
*   Flying real drones, or using a phone's sensors, GPS or camera as drone
    sensors.
*   Supporting more than three phones, or any public use beyond the demo.
*   Supporting or testing Android phones.
*   Publishing an app or supporting a phone browser older than the current
    release.
*   Accounts, encryption beyond what the browser provides, or defence against a
    hostile participant. Only people in the room join.
*   Changing the swarm's merge, hub takeover or failure detection rules. If real
    devices expose a bug in them, that fix is separate work with its own tests.
*   Saving a mission across a page reload, or restoring a finished mission.
*   Moving the laptop's simulated drones onto separate processes. They stay
    simulated, and the presenter says so.
*   Changing the formation "gecko" panel or retraining the network.

## Open Questions

*   **Backup network**: the venue Wi-Fi passed, so this is cover only. It must be
    a separate router or a spare phone's hotspot. A hotspot on the laptop cannot
    be used, because the laptop-off step would take the network down with it.
*   **Phones sleeping**: what happens when the screen locks or the page goes to
    the background? This needs real iPhone testing. Hidden pages are already
    known to be unreliable: their timers slow down, so loss detection misfires
    or runs late.
*   **Time and people**: the 6–10 hour estimate is rough, and it was made before
    the laptop-off step and the big screen changes were added. Who does the
    phone testing, and how much time is left before judging?

## Critical User Journeys (CUJs)

### CUJ 1: A judge joins before launch

*   **Given**: The big screen shows a QR code, the drones are waiting at base,
    and the phone is on the demo network.
*   **When**: The judge scans the code and opens the page.
*   **Then**: Within 20 seconds the phone shows "You are drone 1" and the map,
    and the big screen marks drone 1 as a phone. The presenter presses Launch
    once the phones show as connected.

### CUJ 2: A judge goes offline and comes back

*   **Given**: The mission is running and the phone drone is searching.
*   **When**: The judge switches on aeroplane mode, waits about 30 seconds, then
    switches it off.
*   **Then**: Within 2 seconds the big screen greys out the drone at its last
    position, and the phone shows it is searching alone. The phone's own map
    keeps growing. Within 5 seconds of reconnecting, the big screen map fills in
    the ground the phone searched. Any report it holds spreads through the swarm
    and later reaches base.

### CUJ 3: The laptop leaves the network

*   **Given**: Two phones on neighbouring drones are connected directly, and the
    aeroplane-mode step is finished.
*   **When**: The presenter turns off the laptop's Wi-Fi.
*   **Then**: The simulated drones and base are gone. The phones stop hearing
    them and, when in simulated range, each shows what the other has found. If
    the hub they believed in was on the laptop, they elect a new one in about 5
    seconds.

### CUJ 4: Aeroplane mode misbehaves

*   **Given**: A phone will not drop or restore its connection cleanly.
*   **When**: The judge taps "Radio off" on the phone, and later taps it again.
*   **Then**: The phone stops sending and ignores what it receives, so the
    sequence plays out as in CUJ 2. The presenter says that this outage is a
    button and not a real network failure.

## Technical Plan (Architecture)

### Summary of decisions

| Question | Decision |
|---|---|
| Connection | WebRTC data channels, directly between every pair of devices |
| Radio | Phones are plain drones: a message counts only if the sim's range, ridge and blackout rules allow it |
| Joining | Phones claim a drone before launch. The launch is held until the presenter presses it |
| Speed | 10 px/s in phone mode, against 32 px/s today. The search then takes 137–159 seconds |
| Finding a person | Left to chance. Phones get neighbouring drones on any map |

### What runs where

```text
           helper: introductions only, holds no swarm data
          +--------------------------------------------+
          | demo/phone-server.mjs (on the laptop)      |
          | serves pages, passes connection offers     |
          +----------+-----------------+---------------+
                     : setup only      : setup only
     +---------------+---+     +-------+-----------+
     | Phone: drone 1    |=====| Phone: drone 2    |
     | own clock, flight |     | own clock, flight |
     | sensing, state    |     | sensing, state    |
     +---------------+---+     +-------+-----------+
                     \\               //
                      \\  WebRTC    //      = = direct data channels
                       \\         //
                  +-----------------------+
                  | Laptop: big screen    |
                  | base + 12 sim drones  |
                  +-----------------------+
```

Each device is one peer. The laptop is a single peer that speaks for base and
every simulated drone. With three phones that makes six connections. The swarm
logic stays in `recovery/swarm-recovery.js`, unchanged, on every device.

### Splitting the drone out of the simulation

`demo/sim.js` currently holds drone behaviour and the whole world in one
function. The behaviour moves to a new `demo/drone.js`, with no knowledge of
other drones' internals: choosing a target, carrying a report home, moving, and
sensing. `sim.js` calls it for simulated drones and the phone page calls it for
its own drone. The existing tests guard this split, since a given seed must play
out the same way as it does today.

The radio rule (range, ridges, blackouts) moves to the same file as a function
`canHear(a, b, world)`, so that the laptop and phones apply the same rule.

Each phone rebuilds the terrain and the seven people from the mission seed. This
works because `makeTerrain` and the people's positions depend only on the seed.
Sensing a person on a phone is therefore simulated from the same data as on the
laptop, and Goal 9 says so.

### Time

The current simulation advances all drones in one loop. Real devices cannot do
that, so every device works out the tick from a shared launch time.

1.  On joining, a phone measures its clock difference from the laptop by timing
    a few round trips to the helper.
2.  At launch, the laptop sends the launch time to all phones.
3.  Each device computes `tick = floor((now - launchTime) / 160 ms)`.

A phone needs no connection to keep counting, so offline ticks stay correct.
Differences of a tick or two do no harm, because the merge does not depend on
message order. If a phone sleeps, its drone stops and the tick jumps forward on
waking. It does not replay the missed flight, because claiming it flew while
asleep would be false.

The laptop's loop has the same need. It stops running when its tab is in the
background, so the big screen must stay in the foreground.

### Messages

Every tick, each device sends one message on each connection:

```text
{ id, tick, x, y, angle, task, snapshot }
```

`snapshot` is the existing `R.snapshot(state)`, measured at 541–1,017 bytes.
The position fields are new, because `canHear` and the big screen both need them.
The laptop sends one such message per drone in range of the receiving phone, plus
one for base, and a list of all drones' positions for drawing.

A receiver applies `canHear`. If it passes, the snapshot goes in that tick's
inbox for `R.step`. If it fails, the snapshot is ignored. So a connected phone
that is out of simulated range hears nothing, as a drone would.

Today a message crosses up to four drones per tick inside the laptop. Between
devices it crosses one per tick, or about 6 per second. That is slower but far
inside the 4.8-second hub timeout.

The laptop also sends each change to painted blackouts and "Cut all radio". The
whole blackout map fits in about 165 bytes.

### Connecting and reconnecting

The helper is a small Node server using only Node's built-in `http` module, so
the signalling needs no dependencies. It serves the pages and holds a short
list of connection offers that devices fetch by polling. Offers are complete
before sending, which avoids a live channel to the helper. It holds no positions,
reports or map data, and it plays no part once devices are connected.

Pages are served over plain local HTTP. Browsers hide local addresses behind
`.local` names, which did not resolve on the venue Wi-Fi, so the helper writes
each device's real address into its offer. That needs phones to reach the helper
directly, which rules out an HTTPS tunnel. A plain page cannot keep the screen
awake, so the team iPhones are set to Auto-Lock: Never.

**Noticing a loss.** Browsers are slow to report a dropped connection, so each
device treats a peer as gone after 1 second with no message. That is what meets
Goal 3.

**Reconnecting.** Aeroplane mode ends a WebRTC connection for good, so returning
needs a new introduction through the helper. When a phone's network returns, it
posts a new offer and the connection is rebuilt. This has two consequences:

*   A phone can only reconnect while the laptop is on the network, so the
    laptop-off step must come last.
*   The helper is needed twice, at joining and at reconnecting, and the presenter
    must say so.

### What the big screen shows

Today the map's fog comes from `world.truthVisited`, which is what really
happened. With phones, the laptop only knows what it has been told, so that
layer becomes "everything received so far". It updates from every phone message
that arrives, whatever `canHear` says, because this is the viewer's picture and
no drone acts on it. That is what makes the map fill in on reconnect, and it does
not depend on a neighbour being nearby.

"Area known at base" and "Reports at base" stay as they are, and they rise later,
through the swarm. The gap between the two is the story: the map returns first,
and then the report travels home.

A phone drone is drawn with a phone marker, and greyed at its last position when
out of contact. The two hidden comparison runs behind the graph are switched off
in phone mode, because they cannot include a phone.

After about 14 seconds offline, the swarm marks the drone as failed, which is the
existing 90-tick rule. The log will say so, and the drone's return clears it
through the existing version rule. This is correct behaviour and worth pointing
out on stage.

### Which drones the phones get

Phones are given drones 1, 2 and 3, in joining order, because these exist in a
swarm of any size. A fourth phone is told the swarm is full. The swarm size is
chosen on the big screen, from 3 to 15. It travels with the mission, because every
device must agree on it to work out the same strips. Changing it starts a new
mission, and the phones rejoin by themselves.

This choice has costs, measured at 10 px/s over 10 seeds:

*   **Late start.** Drones 1 to 3 start near base and their strips are at the left
    edge, so they arrive 24–34 seconds after launch. An outage should start at
    least 35 seconds after launch. Before that the drone is crossing ground that
    others are searching, and brings back about 11 cells.
*   **Drone 1 is the first hub.** A judge's aeroplane mode on drone 1 can force a
    real hub election. In the laptop-off step, no election is needed if the hub is
    still on a phone.
*   **Offline yield.** An outage of 30 seconds starting 30–60 seconds after launch
    typically brings back 21–28 cells. A drone that finds someone while offline
    flies the report home instead of searching, so that run can bring back far
    fewer. Goal 5's target therefore holds for a typical run, not every run.

| Drones | Search takes | Drone 1 / 2 / 3 has a neighbour | Link 1–2 | Link 2–3 |
|---|---|---|---|---|
| 15 | 137–156 s | 85% / 95% / 94% | 73% | 80% |
| 12 | 172–196 s | 77% / 87% / 96% | 59% | 75% |
| 9 | 246–265 s | 64% / 73% / 93% | 54% | 55% |
| 6 | 402–479 s | 54% / 76% / 74% | 52% | 45% |
| 4 | 640–737 s | 20% / 46% / 39% | 20% | 16% |

Smaller swarms take longer, and their phones spend more time alone. At 6 drones
or fewer, a reconnecting phone often has nobody in radio range, and the laptop-off
step will often show nothing shared.

The hub is not fixed. It starts on drone 1, but ridges split the swarm, and with
no phones involved drones disagreed about the hub 37–59% of the time in testing.
So the phones elect a hub in the laptop-off step only if the hub they believe in
was on the laptop. If it was already on a phone, nothing visible happens.

### Connection test results

Tested on two iPhones (iOS 18.7) and the laptop, on the venue Wi-Fi, over plain
local HTTP, using the helper's address fix.

| Test | Result |
|---|---|
| iPhone to laptop, iPhone to iPhone | Direct, host to host |
| Aeroplane mode | Loss noticed in about 0.5 s; link back 1–2 s after the network returned, with no reload |
| Laptop page and helper shut down for 36 s | The iPhones' link to each other never dropped. Laptop loss noticed in 1 s |
| Helper and laptop page restarted | Phones linked again about 4 s after the helper returned |
| Page in the background | Unreliable: loss detection misfires or runs late, and links wait until the page is visible |

The laptop's Wi-Fi stayed on during the shutdown test, so the session could
continue. The phones' route did not pass through the laptop, but one rehearsal
should turn the laptop's Wi-Fi off for real. Repeat these tests in the room used
for judging, as it may be served by different access points.

### Main risks

*   **The venue network changes on the day.** Direct connections passed on the
    venue Wi-Fi, but the judging room or a crowded network may behave
    differently. No WebSocket fallback is planned, so the recorded video is the
    only cover, and a separate router is the backup network.
*   **The laptop-off step lands out of range.** With 15 drones, drones 1 and 2
    are out of simulated range about 27% of the time. The presenter should check that the
    phones show a link before turning the laptop's Wi-Fi off.
*   **A slower mission is duller.** At 10 px/s drones move at a third of today's
    speed. Rehearsal will show whether this is acceptable.

## Alternatives Considered

### Alternative A: WebSocket through the laptop

*   **Pros**: Least work, and it behaves the same on iPhone and Android. The
    aeroplane-mode moment looks identical to a judge.
*   **Cons**: Every message passes through the laptop, so it cannot pass the
    laptop-off step, and the laptop is a hub in practice.
*   **Reason for Rejection**: Rejected by author: direct phone-to-phone links are
    the stronger answer to "that is not a distributed system".

### Alternative B: WebSocket first, WebRTC added later

*   **Pros**: A working demo early, and WebRTC problems could not sink it.
*   **Cons**: Two connection paths, and the claim stays unknown until late.
*   **Reason for Rejection**: Rejected by author in favour of building WebRTC
    directly. The cost is that no fallback exists if direct connections fail.

### Alternative C: Exempting phones from radio rules

*   **Pros**: Merging on reconnect would always be immediate.
*   **Cons**: Phones would talk across ridges and through blackouts.
*   **Reason for Rejection**: Rejected by author: phones should function as
    drones. Measurement supported this: a drone has a neighbour in range 93% of
    the time.

### Alternative D: Choosing the map or placing a person

*   **Pros**: A phone would reliably find someone while offline.
*   **Cons**: The find would be arranged, which weakens "nothing is faked".
*   **Reason for Rejection**: Rejected by author: the find is left to chance.

### Alternative E: Joining during the mission

*   **Pros**: Latecomers could take part.
*   **Cons**: Needs a live takeover of a flying drone, the hardest new code.
*   **Reason for Rejection**: Rejected by author: phones join at the beginning.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security & Privacy**: No accounts and no personal data. The public address
    is temporary and lasts for the demo. Anyone holding the link can join, which
    is accepted for a demo in one room.
*   **Performance**: One phone receives about 15 messages per tick at most, or
    under 100 KB per second. Terrain is generated once at joining.
*   **Rollout & Rollback**: Phone mode is opt-in through `demo/?phones=1`. Without
    it, the demo behaves as it does today.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Work in this order. Step 1 is a go/no-go test, so finish it before anything else.

### Target Files to Create/Modify

#### 1. `demo/spike.html` (Create, then delete in step 10)

*   **Type / Scope**: Throwaway connection test.
*   **Proposed Changes**: Two phones and the laptop open a WebRTC data channel
    through the helper and show round-trip time. Run it on two iPhones, on the planned
    network. Then test aeroplane mode and
    reconnecting. If direct links fail, try asking for microphone permission,
    which makes browsers reveal local addresses. If that fails too, stop and
    revisit the connection decision.

#### 2. `demo/phone-server.mjs` (Create)

*   **Type / Scope**: Node helper, built-in `http` only.
*   **Proposed Changes**: Serves the repo. Adds `POST /join` (returns drone id and
    seed, or "full"), `GET /time` (for clock difference), `POST /signal` and
    `GET /signal?for=<peer>` (offers and answers), and `GET /mission` (launch
    time). Holds no swarm data.

#### 3. `demo/drone.js` (Create)

*   **Type / Scope**: ES module, no DOM.
*   **Proposed Changes**: Moved from `sim.js`: `serpentine`, `muleTarget`,
    `chooseTarget`, and the movement and sensing in `move`. Adds
    `canHear(a, b, world)` from the link checks in `protocolTick`,
    `makeSurvivors(seed, terrain)`, and `createDrone(id, ids)`.

#### 4. `demo/sim.js` (Modify)

*   **Type / Scope**: Simulation.
*   **Proposed Changes**: Calls `drone.js`. `createSim` gains `speed` (default 32)
    and `remoteIds` (default empty). A remote drone is not moved or stepped. It
    holds its latest message, joins link checks by position, and its snapshot
    goes in neighbours' inboxes. Adds `sim.applyRemote(message)`, which updates
    position and `truthVisited`, `sim.remoteLost(id)`, and `sim.outbox(id)`, which
    gives a remote drone everyone's positions and the messages it can hear.

#### 5. `demo/net.js` (Create)

*   **Type / Scope**: Browser module, used by both pages.
*   **Proposed Changes**: `createNet({ selfId, onLog })`, returning `start()`,
    `send(body)`, `sendTo(id, body)`, `onMessage(fn)`, `onPeer(fn)`, `peers()` and
    `setRadio(on)`. Handles offers through the helper, the 1-second silence rule
    (5 seconds for a peer whose page is hidden), and rebuilding lost connections.
    A linked device ignores a stray offer, and the helper keeps only each
    device's newest one. `setRadio(false)` drops everything in both directions
    and keeps the connection open.

#### 6. `demo/phone.html` and `demo/phone.js` (Create)

*   **Type / Scope**: Phone page.
*   **Proposed Changes**: Joins, rebuilds terrain and people from the seed, waits
    for launch, then runs one drone on the shared tick. Calls `R.step` with the
    inbox that passed `canHear`. Shows its map, drone number, connection state,
    cells searched while offline, and what other phones found. Includes the
    "Radio off" button.

#### 7. `demo/demo.js` and `demo/index.html` (Modify)

*   **Type / Scope**: Big screen.
*   **Proposed Changes**: With `?phones=1`: uses the slider's drone count at 10 px/s, shows the QR
    code and the claimed drones, holds until Launch is pressed, and turns off the
    comparison runs. Sends messages per tick. Draws phone markers and greyed
    out-of-contact drones.

#### 8. `package.json`, `package-lock.json` and `demo/phone-server.mjs` (Modify)

*   **Type / Scope**: QR code, using the `qrcode-generator` npm package (MIT, no
    dependencies of its own).
*   **Proposed Changes**: The helper serves `GET /qr.svg`, built from the laptop's
    current address, so the browser pages need nothing installed. `npm test` and
    `npm run phones` run `npm install` first, so everyone gets the package.

#### 9. `demo/test/drone.test.mjs` and `demo/test/phones.test.mjs` (Create)

*   **Type / Scope**: Unit and headless tests.
*   **Proposed Changes**: `drone.test.mjs`: `canHear` matches today's link rules,
    and `makeSurvivors` matches on two builds. `phones.test.mjs`: a fake network
    runs a phone drone against a laptop sim. Covers a 30-second outage, at least
    15 cells returning, a report reaching base, recovery from being marked
    failed, the laptop leaving and two phones electing one hub, and out-of-range
    phones hearing nothing.

#### 10. `README.md`, `docs/frontend-data-inventory.md`, `package.json` (Modify)

*   **Type / Scope**: Docs and scripts.
*   **Proposed Changes**: Add a `phones` script and phone setup steps, and note
    that "reality" in phone mode means everything received so far. Update the
    test glob only if needed. Delete `demo/spike.html`, which is done. Remove
    `/report` and the phones' logging after the last rehearsal.

### Verification Plan

*   **Unit Tests**: `npm test`. All 37 existing tests pass after step 4, unchanged.
*   **Team iPhones**: Settings > Display & Brightness > Auto-Lock > Never.
*   **Local**: three browser windows on the laptop run the whole sequence.
*   **Real devices**: two or three iPhones, against Goals 2–7 and 10.
*   **Venue**: repeat the connection tests in the judging room, and test the
    backup network.
*   **Rehearsal**: five full runs, then record the backup video.

--------------------------------------------------------------------------------

*Drafted with EGM*
