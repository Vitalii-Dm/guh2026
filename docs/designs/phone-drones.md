# Phone Drones: a real network failure in the judge's hand

*   **Author:** Dima
*   **Status:** Implemented; rehearsal in progress
*   **Date:** 2026-11-07

--------------------------------------------------------------------------------

## Overview

The rescue swarm demo normally runs every drone as one program in one browser
tab: 9 drones by default in the normal demo. This design makes part of the swarm
run on separate devices. A judge takes a team iPhone and scans a QR code, and
that phone becomes one of the drones in a swarm of 15 (the default in phone
mode). The drone's search and its copy of the swarm's knowledge then live on
that phone, not on the laptop.

The judge switches on aeroplane mode. Their drone is marked NOT CONNECTED on the
big screen, but the phone keeps searching. When the judge switches aeroplane
mode off, the phone reconnects and the ground it searched alone appears on the
big screen and spreads through the swarm. The promise is ground, not a find:
finding a person while offline is rare.

Up to three phones join, as drones 1, 2 and 3. The laptop runs the base station
and the remaining simulated drones. The swarm logic in
`recovery/swarm-recovery.js` was already built and tested, including merging two
copies of the swarm's knowledge. The new work was everything needed to run that
logic across real devices.

Terms used in this document:

*   **Hub**: the drone the others treat as coordinator. Nothing depends on it;
    if it fails, another drone takes over.
*   **Base**: the fixed station that rescue reports must reach.
*   **Strip**: the column of the map a drone searches first.
*   **Tick**: one 160 ms round of the swarm protocol.
*   **Big screen**: the laptop's display, which judges watch.
*   **Helper**: the small Node server on the laptop, `demo/phone-server.mjs`.
*   **Cell**: one square of the 44 x 30 map grid, 1,320 in all.

## The Problem

The project claims that a search carries on when communications fail, because no
drone waits for instructions. The normal demo cannot prove this. Every drone shares one
program, one clock and one memory, and "radio failure" is a rule in that program.
A judge can fairly say: "that is a simulation of a distributed system, not a
distributed system."

A real failure answers that objection better than an explanation does. If the
judge cuts the connection with their own hand and the drone carries on, nobody
has to take our word for it.

Four facts from the current code limit how this can work. The first two put the
demo's main moment at risk.

1.  **The mission is shorter than the demo.** At the normal speed of 32 px/s,
    with 15 drones on seeds 1–10, the search ended in 43–51 seconds and the last
    person was found at 19–44 seconds. Scanning, joining, going offline and
    reconnecting take longer than that.
2.  **Finding someone offline is unlikely.** In a 30-second outage the phone
    records a find in 21% of runs, and a person not already known to the big
    screen in 3.3%. On the default seed, 2026, it finds nobody. The demo cannot
    promise a find. It can promise ground.
3.  **Radio is a calculation.** The simulation decides who can talk from distance
    and ridges. A real connection is a second, separate source of truth, and the
    two can disagree.
4.  **Swarm messages do not carry position.** The big screen cannot draw a phone
    drone from the state messages alone. Those messages measured 553–1,412 bytes
    at 15 drones with 7 reports.

## Goals

1.  **Real separation.** A phone drone runs the same
    `recovery/swarm-recovery.js` as the laptop, and it moves and senses on the
    phone. During an outage it needs nothing from the laptop.
2.  **Quick join.** A judge goes from scanning the QR code to controlling a drone
    in under 20 seconds, with nothing to install. This is a target. The QR scan
    has not yet been tested on a real phone.
3.  **A visible outage.** Within 2 seconds of the connection being lost, the big
    screen shows that drone as NOT CONNECTED, and the phone shows it is searching
    alone.
4.  **A visible recovery.** Within 5 seconds of the connection returning, the
    ground the phone gathered offline appears on the big screen's map. With a
    neighbour in simulated range, it also enters the swarm's own picture. Reports
    then reach base by the existing routes, including a drone flying them home.
5.  **A dependable payoff, with no staged find.** An outage of 30 seconds, starting
    30–60 seconds after launch, brings back 21–28 cells that the rest of the swarm
    had not searched in 75% of runs. The full range is 0–28 and the median is 27.
    It brings back under 15 cells in 18% of runs, because a drone holding an
    undelivered report flies it home instead of searching. The presenter's line
    is "your phone kept searching", not "it will find someone".
6.  **Enough time.** Phones join before launch, and the launch waits for the
    presenter. At 15 drones the search then takes 134–158 seconds, which leaves
    time for a judge to go offline for 30 seconds and reconnect while there is
    still ground to search.
7.  **iPhones only.** Two or three iPhones complete the sequence in the same run.
    Only iPhones are tested. Judges use a team iPhone, because a judge's Android
    phone may work but is unsupported.
8.  **A demo that cannot be stranded.** The existing `demo/` page and its tests
    keep working with no phones present. Phone mode itself needs one phone to
    launch. A manual "Radio off" button and a recorded video cover the case where
    the live version fails.
9.  **An accurate claim.** The presenter and the pages say what is real and what
    is simulated. Real: the separate devices, the Wi-Fi links between them, and
    aeroplane mode. Simulated: the flight, the sensors, the terrain, the people
    and the drones' radio range. The helper is disclosed, and the claim is true of
    what it does. The phone page lists what is real and what is simulated. The
    big screen's Phones card says that phones fly up to three drones and that
    "Known at base" comes over simulated radio. Neither page mentions the helper,
    so the presenter has to.
10. **No laptop needed between phones.** With the laptop taken off the network,
    the phones' direct link stays up. If they are also in simulated range, they
    keep exchanging what they find. This is the step that shows the phones talk
    directly, and it is the reason for using WebRTC. A hub election between the
    phones is a bonus, not part of the goal: see "Which drones the phones get".

## Non-Goals

*   Arranging for a phone to find a person, by choosing the map or by moving
    anyone.
*   Exempting phones from any radio rule. A phone drone obeys range, ridges and
    blackouts like every other drone.
*   Letting a new phone join after launch, or taking over a drone in flight. A
    phone that already holds a drone can reload and carry on flying it.
*   Flying real drones, or using a phone's sensors, GPS or camera as drone
    sensors.
*   Supporting more than three phones, or any public use beyond the demo.
*   Supporting or testing Android phones.
*   Publishing an app or supporting a phone browser older than the current
    release.
*   Accounts, encryption beyond what the browser provides, or defence against a
    hostile participant. Only people in the room join.
*   Changing the swarm's merge, hub takeover or failure detection rules, or their
    timers. If real devices expose a bug in them, that fix is separate work with
    its own tests.
*   Keeping what the presenter did on the laptop across a reload of the big
    screen, or rejoining a run launched more than 20 minutes ago.
*   Moving the laptop's simulated drones onto separate processes. They stay
    simulated, and the presenter says so.
*   Changing the formation "gecko" panel or retraining the network.

## Open Questions

*   **Backup network**: the venue Wi-Fi passed, so this is cover only. It must be
    a separate router or a spare phone's hotspot. A hotspot on the laptop cannot
    be used, because the laptop-off step would take the network down with it.
*   **Phones sleeping**: a hidden phone page stops, so the rule for now is to keep
    the page open with Auto-Lock off. What a judge sees if a screen does lock
    still needs a real iPhone test.
*   **Remaining phone tests**: who runs the tests listed under "Known limits", and
    when?

## Critical User Journeys (CUJs)

### CUJ 1: A judge joins before launch

*   **Given**: The big screen shows a QR code, the drones are waiting at base,
    and a team iPhone is on the demo network with Auto-Lock off.
*   **When**: The judge scans the code with the team iPhone and opens the page.
*   **Then**: Within 20 seconds the phone shows "You are drone 1" and the map, and
    the big screen's Phones card lists drone 1 as connected. Launch stays off until
    a phone has joined. The presenter presses it once the phones show as
    connected.

### CUJ 2: A judge goes offline and comes back

*   **Given**: The mission is running, the phone drone has reached its strip (at
    least 35 seconds after launch), and it is searching.
*   **When**: The judge switches on aeroplane mode, waits about 30 seconds, then
    switches it off.
*   **Then**: Within 2 seconds the big screen puts a pulsing yellow halo and a
    "1 NOT CONNECTED" tag on the drone at its last position, labelled "last seen
    here". The phone turns yellow, shows NOT CONNECTED and counts the cells it
    explores alone, and its own map keeps growing, with that ground in yellow.
    Within 5 seconds of reconnecting, the big screen's map fills in about 27
    cells on that drone's strip, and the phone shows "Back, with N cells explored
    alone". The phone also gains ground
    from the swarm. Any report it holds spreads through the swarm and later
    reaches base.

### CUJ 3: The laptop leaves the network

*   **Given**: Two phones are linked directly, and the aeroplane-mode step is
    finished. The presenter has checked the big screen for a blue link between the
    two phone drones, which means they are in simulated range.
*   **When**: The presenter turns off the laptop's Wi-Fi.
*   **Then**: The simulated drones and base are gone. Each phone shows BIG SCREEN
    LOST and "Still linked to 1 other phone". If they are in simulated range,
    each shows what the other has found. If the hub they believed in was on the
    laptop and they can hear each other, they elect a new one in about 5 seconds.
    That is a bonus, and it often does not happen.

### CUJ 4: Aeroplane mode misbehaves

*   **Given**: A phone will not drop or restore its connection cleanly.
*   **When**: The judge taps "Radio off" on the phone, and later taps it again.
*   **Then**: The phone stops sending and ignores what it receives, so the
    sequence plays out as in CUJ 2. The phone shows "RADIO OFF" and "This is a
    button, not a real outage", and the presenter says the same.

## Technical Plan (Architecture)

### Summary of decisions

| Question | Decision |
|---|---|
| Connection | WebRTC data channels, directly between every pair of devices |
| Radio | Phones are plain drones: a message counts only if the sim's range, ridge and blackout rules allow it |
| Joining | Phones claim a drone before launch. The launch is held until the presenter presses it |
| Network | Plain local HTTP on the shared Wi-Fi. No tunnel and no public address |
| Speed | 10 px/s in phone mode, against 32 px/s in the normal demo. At 15 drones the search then takes 134–158 seconds |
| Finding a person | Left to chance. Phones get drones 1, 2 and 3 on any map |

### What runs where

```text
          helper: serves pages, starts the mission,
          shares the clock, introduces devices
          +--------------------------------------------+
          | demo/phone-server.mjs (on the laptop)      |
          | no positions or findings pass through it   |
          +----------+-----------------+---------------+
                     : setup and       : setup and
                     : reconnecting    : reconnecting
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
                  | base + simulated      |
                  | drones                |
                  +-----------------------+
```

Each device is one peer. The laptop is a single peer that speaks for base and
every simulated drone. With three phones that makes six connections. The swarm
logic stays in `recovery/swarm-recovery.js`, the same file on every device.

### Splitting the drone out of the simulation

`demo/drone.js` holds what one drone does, with no knowledge of other drones'
internals: choosing a target, carrying a report home, moving, and sensing.
`demo/sim.js` calls it for simulated drones, and `demo/phone-drone.js` calls it
for a drone on a phone. The radio rule (range, ridges, blackouts) is in the same
file as `radioLink(a, b, world)` and `canHear(a, b, world)`, so that the laptop
and phones apply the same rule.

Each phone rebuilds the terrain and the seven people from the mission seed. This
works because `makeTerrain` and `makeSurvivors` depend only on the seed. Sensing
a person on a phone is therefore simulated from the same data as on the laptop,
and Goal 9 says so.

### Time

The normal demo advances all drones in one loop. Real devices cannot do that, so
in phone mode every device works out the tick from a shared launch time.

1.  On joining, a device measures its clock difference from the helper by timing
    five round trips to `GET /time`.
2.  The big screen posts `/launch`, and the helper sets the launch time 3 seconds
    ahead. Phones read it by polling `GET /mission` once a second.
3.  Each device computes the tick from the helper's time and the launch time
    (`missionTick` in `demo/mission.js`).

A phone needs no connection to keep counting, so offline ticks stay correct.
Differences of a tick or two do no harm, because the merge does not depend on
message order. If a phone sleeps, its drone stops and the tick jumps forward on
waking. It does not replay the missed flight, because claiming it flew while
asleep would be false.

The laptop catches up to the same clock on each frame and on a 250 ms timer. A
hidden tab gets no frames, and the browser slows the timer, so a hidden big
screen steps about once a second. The big screen should stay in front.

### Messages

Every tick, each phone sends one message on each connection:

```text
{ kind: 'drone', id, tick, x, y, angle, task, hubStatus, mode, muling, own, snapshot }
```

`snapshot` is the existing `R.snapshot(state)`, measured at 553–1,412 bytes at 15
drones with 7 reports. `own` is a bitmap of the cells this drone flew over, which
the big screen uses to show who searched what. The position fields are there
because `canHear` and the big screen both need them.

Every tick, the laptop sends each linked phone one `outbox` message: all drones'
positions for drawing, and one message for each simulated drone or base that the
phone can hear. Traffic per phone measured a mean of 17 KB/s and a peak of
65 KB/s.

A phone keeps each sender's latest message for up to 6 ticks, so a message that
misses a tick does not read as silence. Each tick it applies `canHear`, and only
snapshots that pass go in the inbox for `R.step`. So a connected phone that is out
of simulated range hears nothing, as a drone would. The laptop applies the same
rule to what phones send it.

Inside the laptop a message crosses up to four drones per tick. Between devices
it crosses one per tick, or about 6 per second. That is slower but far inside the
4.8-second hub timeout.

The laptop also sends the settings: radio on or off, range, ridges, mode and the
blackout map, with one character per cell. This `world` message is about 1.4 KB.
It goes out on each change and when a phone links, and it is repeated every 32
ticks in case a phone missed it.

### Connecting and reconnecting

The helper is a small Node server. It serves the pages, starts the mission,
shares the clock and introduces devices. Positions and findings never pass
through it, and it plays no part in messages between linked devices. It uses
Node's built-in `http` module, plus `qrcode-generator` for the QR code. It starts
without that package, prints a warning, and phones then use the address it
prints. Devices fetch connection offers by polling, and offers are complete
before sending, which avoids a live channel to the helper.

| Route | What it does |
|---|---|
| `GET /` | Sends the laptop to the big screen and anyone else to the phone page |
| `POST /mission` | Laptop only. Starts a mission, or rejoins a flying one and returns `resume: true`. Answers 409 to a second big screen. `restart` replaces a flying mission, and `restore` hands a mission back to a restarted helper |
| `GET /mission` | Read the mission: seed, swarm size, launch time, claimed drones, join address |
| `POST /launch` | Set the launch time (laptop only) |
| `POST /join` | Claim a drone, get back a drone already held, or be told "full" or "launched" |
| `GET /time` | The helper's clock |
| `POST /signal`, `GET /signal?for=<peer>` | Pass offers and answers, and list who is around |
| `GET /qr.svg` | The QR code for the phone page. Returns 503 if `qrcode-generator` is not installed |
| `/report` | Phone logs, for rehearsals. Exists only with `PHONE_LOGS=1` |

Everything else is a static file from `demo/`, `demo3d/` or `recovery/`. Only the
laptop, seen as a loopback address, can start or launch a mission.

Pages are served over plain local HTTP, with no tunnel. Browsers hide local
addresses behind `.local` names, which did not resolve on the venue Wi-Fi, so the
helper writes each device's real address into its offer. That needs phones to
reach the helper directly. A plain HTTP page cannot keep the screen awake, so the
team iPhones are set to Auto-Lock: Never.

**Noticing a loss.** Browsers are slow to report a dropped connection, so each
device treats a peer as gone after 1 second with no message, or 5 seconds for a
peer whose page is hidden. That is what meets Goal 3.

**Reconnecting.** Aeroplane mode ends a WebRTC connection for good, so returning
needs a new introduction through the helper. When a phone's network returns, the
device with the lower id makes a new offer and the connection is rebuilt. This
has two consequences:

*   A phone can only reconnect while the laptop is on the network, so the
    laptop-off step must come last.
*   The helper is needed at joining, at launch, at reconnecting and at any page
    reload, and the presenter must say so.

**Claims.** Before launch, a page that stops polling for 10 seconds gives its
drone back. If it returns, it sees that it has lost the drone, reloads itself and
joins again, asking for the same number. After launch a claim is never released.
Phones keep their drones into the next run: a new mission copies the claims and
gives each phone 10 seconds to come back. Phones see the new mission id and reload
by themselves.

**Two big screens.** Each big screen tab keeps a per-tab id in `sessionStorage`,
which survives a reload of that tab. While a mission flies, a tab with a different
id is refused if the first tab polled the helper in the last 3 seconds. It shows
"Another big screen is running this mission", with a "Start a new run here"
button. Before launch, a new tab replaces the mission and the old tab says so. A
run launched more than 20 minutes ago is not protected: a new tab replaces it in
the same way.

**Reloading the big screen.** A reload or reopen during a run rejoins it, if the
run was launched in the last 20 minutes. `POST /mission` returns `resume: true`
with the mission's seed, swarm size and launch time. The mission and its id do not
change, so the phones do not reload. They see a short outage, and link again.

The page gets no record of the run. It rebuilds the simulation from the seed and
replays the laptop's drones to the shared clock, with every phone out of contact.
The phones' next messages then bring back their positions and what they know.

| Across a reload of the big screen | |
|---|---|
| Kept | The seed, swarm size, launch time and claims. Everything on the phones. So the ground and reports the phones hold return to the map |
| Lost | Failed drones: a drone failed with a button flies again. Blackouts. A radio cut. Changes to range and ridges. Formation mode. The graph's markers and earlier log lines |

The lost settings go back to the page's starting values, and the page sends those
to the phones when they link. So a blackout or radio cut also ends on the phones.

The replay is only the same as the original for what the seed decides. What phones
told the laptop's drones before the reload is not in it, even if nobody touched a
control. In a headless check on 5 seeds, with two phones and a reload 90 seconds
in, 1–4 of the 13 laptop drones ended more than 5 px from where they had been, by
up to 121 px. Base knew 32–82 fewer cells until it heard from the phones again.

Before launch, a reload starts a new mission on the same seed, and phones keep
their drones. Reset, the Drones slider, New terrain and "Start a new run here" send
`restart`, so they always start a new run. The page then drops `restart` from its
address, so a later reload does not start another.

**Reloading a phone.** The page saves its drone to `localStorage` every 2 seconds,
under a key made from the mission id and the drone number. The save holds the
position, target, task, swarm state, tick, the cells the drone flew over and the
yellow cells. A reloaded page keeps its phone key, so `/join` gives it the same
drone, even after launch, and it carries on from the save. It loses the flight
since that save and the time the page was away: the tick jumps forward, as after
sleep.

The "Radio off" button is not saved, so a reload turns the radio back on. The
"cells explored alone" count starts again, but the yellow ground stays. For the
first 5 seconds a page that has not linked shows CONNECTING, so a reload is not
counted as an outage. With storage off a phone gets a new key on every load, so
after launch it cannot rejoin.

**A helper restart.** A restart keeps the mission: the big screen sees that the
helper has forgotten it, and hands the mission back with the phones' claims.

### What the big screen shows

The big screen shows two pictures, and they follow different rules.

**The viewer's window.** The fog on the map and "Area searched" come from
`world.truthVisited`, which in phone mode means "everything this screen has
received". They update from any phone message that arrives over Wi-Fi, whatever
the radio rules say. No drone acts on this picture, so it breaks no rule, but it
is not the swarm's knowledge. "People found" and phone drones' positions work the
same way.

**The swarm's real merge.** "Area known at base", "Reports at base" and the "Who
knows about each person" table show what the swarm has merged over simulated
radio. They rise only when a snapshot passes the radio rule, so they rise later
than the map. The one exception is a phone's own column in the table, which is
what that phone last said.

The Phones card on the page says this in a sentence, and the presenter should
say it too.

The jump on the map at reconnect is about 27 cells, or 2% of the map. That is
small, so the presenter should point at the strip where it happens. The bigger
change is on the phone, which gains 106–437 cells from the swarm when it hears
it again.

A phone drone is drawn with a dashed white ring and a PHONE tag. After launch, a
drone that is not connected gets a pulsing yellow halo, a tag such as "2 NOT
CONNECTED" and "last seen here" at its last position. Before launch, a phone that
has claimed a drone but is not linked gets the halo only, because the drones sit
too close together for tags. The Phones card names it in yellow, as "Drone 2: not
connected". Yellow means not connected on the big screen and on the phones. The
two hidden comparison runs behind the graph are switched off in phone mode, because
they cannot include a phone.

Before launch, the Fail buttons are refused, and the log says "The swarm has not
launched yet." Launch is disabled until a phone has claimed a drone. At widths of
1000 px or less, the side panel moves above the map, so the Phones card comes
first.

During an outage the swarm marks the drone as failed, under the existing 90-tick
rule. That rule counts from each drone's own last news of it, and only ticks when
that drone could hear someone, so the time varies. A drone is first marked failed
1.6–20 seconds after an outage starts, with a mean of 10.9 seconds. After the
phone returns, the existing version rule clears the mark, which takes 0.5–103
seconds for all drones, with a mean of 24.6 seconds. Do not promise either time
on stage.

False "treats it as failed" log lines and hub churn also happen with no fault at
10 px/s, and the swarm can end split. This is known behaviour of the existing
rules. It is not changed here, because recovery timers are out of scope.

### What the phone shows

The status box has a headline and a line of detail. Green means linked. Yellow
means anything less.

| Headline | Detail | When |
|---|---|---|
| You are drone 1 | "Connected. Waiting for launch.", or the same with "Connecting to the swarm." or "Radio off." | Before launch |
| Launching in 3 | "You are drone 1. Connected." | The 3 seconds before launch |
| CONNECTED | "Linked to the big screen and 1 other phone.", or "Back, with N cells explored alone." for 8 seconds after an outage | Flying, with a link |
| CONNECTING | "Linking to the swarm." | Flying, with no link yet, on a page that has never linked and loaded under 5 seconds ago |
| NOT CONNECTED | "N cells explored alone. The drone carries on by itself." | Flying, with no link to any device |
| RADIO OFF | "N cells explored alone. This is a button, not a real outage." | The "Radio off" button is on |
| BIG SCREEN LOST | "Still linked to 1 other phone." | Linked to a phone, after losing the laptop |

Two lines below the box say what the drone is doing and what it hears. The second
line is about simulated radio, so a CONNECTED phone can still hear nobody. It reads
"Hears 2 drones and base", "Hears 1 drone", "Hears base", "Hears nobody over radio"
or "Radio cut from the big screen". The hub follows: "Hub: drone 3." or "This drone
is the hub."

| On the map | Meaning |
|---|---|
| Teal | Searched by this drone |
| Yellow | First explored by this drone while offline. It stays yellow after reconnecting |
| Blue | Learned from other drones |
| Dark | Not explored |
| Dashed white outline | This drone's strip |
| Red | Radio blackout |

The drone's own marker is teal with a white ring when linked, and yellow when not.

### Which drones the phones get

Phones are given drones 1, 2 and 3, in joining order, because these exist in a
swarm of any size. A phone keeps its number from run to run. A fourth phone is
told the swarm is full. The swarm size is chosen on the big screen, from
3 to 15, and defaults to 15 in phone mode. It travels with the mission, because
every device must agree on it to work out the same strips. Changing it starts a
new mission, and the phones rejoin by themselves.

This choice has costs, measured at 10 px/s over 10 seeds:

*   **Late start.** Drones 1 to 3 start near base and their strips are at the left
    edge, so they arrive 24–34 seconds after launch. An outage should start at
    least 35 seconds after launch. Before that the drone is crossing ground that
    others are searching. A 30-second outage brings back 12 cells if it starts 15
    seconds after launch, 17 at 20 seconds, 20 at 25 seconds and 23 at 30 seconds.
*   **Offline yield.** See Goal 5. A drone that finds someone while offline, or
    holds a report it has not delivered, flies it home instead of searching, so
    that run can bring back far fewer cells.

| Drones | Search takes | Drone 1 / 2 / 3 has a neighbour | Link 1–2 | Link 2–3 |
|---|---|---|---|---|
| 15 | 134–158 s | 82% / 91% / 94% | 66% | 75% |
| 12 | 172–203 s | 73% / 84% / 94% | 56% | 70% |
| 9 | 237–276 s | 66% / 76% / 94% | 57% | 56% |
| 6 | 387–481 s | 58% / 79% / 72% | 56% | 46% |
| 4 | 594–728 s | 23% / 48% / 43% | 22% | 18% |

These percentages are averages, and they vary widely by seed. At 15 drones, link
1–2 ranges from 43% to 91%.

Smaller swarms take longer, and their phones spend more time alone. At 6 drones
or fewer, a reconnecting phone often has nobody in radio range, and the laptop-off
step will often show nothing shared.

**The hub moves by itself.** It starts on drone 1, but ridges split the swarm. In
a 15-drone swarm, drone 1 is the majority hub at 20 seconds in 8 of 10 seeds, at
35 seconds in 4 of 10, at 65 seconds in 2 of 10, and at 90 seconds in 1 of 10.
Drones disagree about the hub 52–80% of the time at 10 px/s, and 21–68% at
32 px/s. So aeroplane mode on drone 1 cannot be relied on to force an election.

**The laptop-gone step.** Phones 1 and 2 are in simulated range in 5 of 10 seeds
at 90 seconds. The real link between them holds either way, and that is the point
of the step. Shared findings need simulated range, and an election also needs the
hub they believe in to have been on the laptop. Treat a hub election as a bonus.

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
| Drones 1 and 2 flying in a 15-drone swarm | Worked, with short outages |

The laptop's Wi-Fi stayed on during the shutdown test, so the session could
continue. The phones' route did not pass through the laptop, but one rehearsal
should turn the laptop's Wi-Fi off for real. Repeat these tests in the room used
for judging, as it may be served by different access points.

### Main risks

*   **The venue network changes on the day.** Direct connections passed on the
    venue Wi-Fi, but the judging room or a crowded network may behave
    differently. No WebSocket fallback is planned, so the recorded video is the
    only cover, and a separate router is the backup network.
*   **The laptop-off step lands out of range.** With 15 drones, drones 1 and 2 are
    out of simulated range about 34% of the time, and 9–57% by seed. The presenter
    should check for a blue link between the two phone drones on the big screen
    before turning the laptop's Wi-Fi off.
*   **The payoff is small.** The map's jump is about 2% of the map, and 18% of
    outages bring back under 15 cells. The presenter should point at the strip,
    and at the yellow ground on the phone.
*   **A slower mission is duller.** At 10 px/s drones move at a third of the normal
    speed. Rehearsal will show whether this is acceptable.

## Known limits

From the first round of review:

*   **A hidden big screen** stops drawing, but a timer still steps it about once a
    second. Keep it in front.
*   **A hidden phone stops.** Its drone does not fly while the page is hidden.
*   **Phones need the laptop to reconnect or reload.** The helper makes the
    introduction and serves the page.
*   **A reload of the big screen forgets what the presenter did.** It rejoins the
    run, but failed drones, blackouts, a radio cut and range changes are lost. See
    "Reloading the big screen".
*   **Only a run launched in the last 20 minutes can be rejoined.** After that, a
    reload starts a new run.
*   **No test runs the pages in a browser.** `demo/test/pages.test.mjs` only checks
    that page scripts parse. The big screen's replay and the phone page's text are
    not covered by any test.

Tested on real iPhones so far:

*   Two iPhones linked directly.
*   Aeroplane mode.
*   Laptop page and helper shut down for 36 s.
*   Drones 1 and 2 flying in a 15-drone swarm, with short outages.

Not yet tested on real phones:

*   Scanning the QR code.
*   A full 30-second outage on the merged build.
*   Reloading a phone, or the big screen, during a run.
*   The laptop's Wi-Fi really off.
*   The room used for judging.

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
    drones. Measurement supported this: at 15 drones, drones 1, 2 and 3 have a
    neighbour in range 82–94% of the time.

### Alternative D: Choosing the map or placing a person

*   **Pros**: A phone would reliably find someone while offline.
*   **Cons**: The find would be arranged, which makes Goal 9's claim false.
*   **Reason for Rejection**: Rejected by author: the find is left to chance.

### Alternative E: Joining during the mission

*   **Pros**: Latecomers could take part.
*   **Cons**: Needs a live takeover of a flying drone, the hardest new code.
*   **Reason for Rejection**: Rejected by author: phones join at the beginning.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security & Privacy**: No accounts and no personal data. The helper is on the
    local Wi-Fi only, and serves only `demo/`, `demo3d/` and `recovery/`. Anyone on
    that Wi-Fi can open the phone page and claim a free drone before launch, which
    is accepted for a demo in one room. Only the laptop can start or launch a
    mission. Devices ask a public STUN server for their addresses when linking;
    no swarm data goes there.
*   **Performance**: One phone receives a mean of 17 KB/s and a peak of 65 KB/s.
    Terrain is generated once at joining.
*   **Rollout & Rollback**: Phone mode is opt-in. `npm run phones` starts the
    helper, and http://localhost:8080/ on the laptop opens `demo/?phones=1`.
    Without it, the demo behaves as it does normally.

--------------------------------------------------------------------------------

## What was built

This section lists what exists now.

### Files

| File | What it is |
|---|---|
| `demo/drone.js` | What one drone does, with no DOM: `chooseTarget`, `fly`, `cellsInView`, `peopleInView`, `radioLink`, `canHear`, `makeSurvivors` and `createDrone`. Runs in the simulation and on a phone |
| `demo/mission.js` | What all devices must agree on: phone drone numbers, swarm size limits, phone speed, network ids and the shared clock |
| `demo/sim.js` | The simulation. `createSim` takes `speed` (default 32) and `remoteIds` (default empty). A remote drone is not moved or stepped: it holds its latest message and joins link checks by position. Adds `sim.applyRemote(message)`, `sim.remoteLost(id)` and `sim.outbox(id)` |
| `demo/net.js` | Direct links, used by both pages. `createNet({ selfId, onLog })` returns `start()`, `stop()`, `send(body)`, `sendTo(id, body)`, `onMessage(fn)`, `onPeer(fn)`, `peers()` and `setRadio(on)`. Handles offers through the helper, the silence rule and rebuilding lost links. `setRadio(false)` drops everything in both directions and keeps the connection open |
| `demo/phone-drone.js` | One drone on its own device, with no DOM and no network. Messages go in through `receive()` and out of `advance()`. `save()` and `restore()` carry it across a reload |
| `demo/phone.html`, `demo/phone.js` | The phone page. Joins, rebuilds terrain and people from the seed, restores a saved drone, waits for launch and flies the drone on the shared tick. Shows the status, what the drone is doing, who it hears, its map, the cells explored alone and the "Radio off" button. See "What the phone shows" |
| `demo/phone-link.js` | The big screen's side of phone mode: starts or rejoins the mission, keeps the laptop's drones on the shared clock, carries messages between the simulation and the phones, and hands the mission back to a restarted helper |
| `demo/phone-server.mjs` | The helper. See "Connecting and reconnecting" |
| `demo/demo.js`, `demo/index.html` | The big screen. With `?phones=1`: the Phones card, 10 px/s, launch on request, no comparison runs, the phone and NOT CONNECTED markers |
| `package.json`, `package-lock.json` | `qrcode-generator` (MIT, no dependencies of its own), the `demo` script (`python3 serve.py`) and the `phones` script. Needs Node 20 or later. `npm test` and `npm run phones` run `npm install` first. A failed install stops `npm test`, but not `npm run phones` |
| `demo/test/drone.test.mjs` | The drone rules on their own |
| `demo/test/phones.test.mjs` | A phone drone against a laptop sim, with only the network faked. Covers an outage, ground returning, a report reaching base, recovery from being marked failed, the laptop leaving and two phones electing one hub, out-of-range phones hearing nothing, and a phone carrying on after `save()` and `restore()` |
| `demo/test/net.test.mjs` | Links, loss, rebuilding and hidden pages, with a fake WebRTC |
| `demo/test/phone-server.test.mjs` | The helper's routes, claims, mission rules, rejoining and file serving |
| `demo/test/pages.test.mjs` | A parse check of every script in `demo/` and `demo3d/`, and a check that `demo.js` reaches the browser history through `window` |

### Verification Plan

*   **Unit Tests**: `npm test`. No test runs the pages in a browser.
*   **Team iPhones**: Settings > Display & Brightness > Auto-Lock > Never.
*   **Local**: browser windows on the laptop can run the whole sequence, using
    http://localhost:8080/demo/phone.html for the phones. Use a separate browser
    profile for each phone, because windows in one profile share a phone key and
    so get the same drone.
*   **Real devices**: two or three iPhones, against Goals 2–7 and 10.
*   **Venue**: repeat the connection tests in the judging room, and test the
    backup network.
*   **Rehearsal**: five full runs with `PHONE_LOGS=1 npm run phones`, reading the
    logs at http://localhost:8080/report. Then record the backup video.

--------------------------------------------------------------------------------

*Drafted with EGM*
