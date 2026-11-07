# Presentation site: design brief and build prompts

Branch: `presentation-website`. Folder: `site/`. Open at `http://localhost:8080/site/` (serve the repo root, as for the demo).

There are two websites. The **presentation site** (this one) tells the story: name, problem, solution, how it works, a QR code so the judges can try it, and the rescue scene. The **technical demo** (`demo/`, built by the team) shows the full simulation, the gecko network and every number. The presentation shows the solution only in part and hands the judges over to the demo.

## The story in one line

When a flood hits a Himalayan valley, phone towers go down first. Our drones keep searching, pass every find from drone to drone, and get it to the rescuers even when the hub drone is lost.

## Who it's for

Hackathon judges, who see it for about 3 minutes on a projector and then on their own phones. So: big type, one idea per screen, real numbers, and something they can do themselves.

## Facts used (checked 7 Nov 2026)

- 26 Aug 2026, about 08:40 NPT: a rock-ice avalanche fell off the north face of Langtang Lirung into the Lhende Khola. It dammed the river, the dam burst, and the flood ran down the Bhote Koshi into the Trishuli. Rasuwa and Nuwakot were hit worst.
- The Trishuli rose up to 9 m in 30 minutes (Al Jazeera).
- Communication towers went down before 09:00 (Wikipedia). 120 Nepal Telecom towers were affected.
- 668 tourists from 34 countries were out of contact, most of them trekking (Department of Tourism, via Al Jazeera, 27 Aug).
- In Nepal, as of 5 Oct: 1,455 dead and 5,285 missing (Wikipedia).
- Helicopters couldn't reach Tiru village until 15 days after the flood (Wikipedia).

Sources: [Wikipedia: 2026 Nepal–Tibet floods](https://en.wikipedia.org/wiki/2026_Nepal%E2%80%93Tibet_floods), [Al Jazeera, 27 Aug 2026](https://www.aljazeera.com/news/2026/8/27/nepal-tibet-floods-what-happened-what-caused-them-and-who-is-missing).

## Look and feel

- **Place:** Himalayan peaks at blue hour. Deep navy sky, icy blue ridges in layers, snow on the peaks, valley mist. Every section sits on this landscape, and scrolling moves you down the mountain into the valley.
- **Material:** liquid glass. Frosted panels with blur and boosted colour, a fine bright edge on top, a soft inner glow, rounded corners. Used for cards, the nav and the QR panel; never for body text on its own.
- **Colour roles** (the same as the demo, so the two sites match): teal = radio link up, gold = hub, orange = person found / SOS, green = reported to base, red = failed or cut off.
- **Type:** a tight geometric display face for headings, a quiet sans for body text. Large numbers in tabular figures.
- **Motion:** slow and calm (parallax, drifting mist), with fast, sharp signal pulses. Respect `prefers-reduced-motion`.

## Build prompts, one per section

Each prompt is written as an instruction to the builder. The checks under it are the loop's exit criteria.

### 1. Hero

> Full-height hero over a layered Himalayan ridge scene. Project name huge, a one-line promise under it, and a small line with the challenge (GreatUniHack 2026 · Neptune North). Three faint drones cross the peaks, linked by thin teal lines that pulse. A scroll cue at the bottom.

Checks: the name reads from the back of a room; the mountains are recognisably Himalayan and blue; nothing moves fast.

### 2. Problem: Langtang, 26 August

> Tell the flood in four beats (avalanche, dam, burst, towers down) with three big numbers in glass tiles. Then the real problem for drones: in a valley the ridge blocks the radio, so a drone that drops behind it, or a hub that fails, goes silent and the search stalls. Show it with a small ridge diagram: a drone, a ridge, a red broken link.

Checks: every number has a source; the step from "flood" to "why drones fail here" is a single sentence; it isn't exploitative (no imagery of victims).

### 3. Solution: three ideas

> Three glass cards, each with a small drawn icon: (1) Shared swarm memory: every drone carries a copy and passes it on at every contact. (2) No leader to lose: if the hub goes quiet, the lowest live ID takes over, and nothing else changes. (3) A swarm that heals: a neural cellular automaton the drones compute between them redraws the formation when a drone is lost. Under the cards, one strip: "data mule": a drone with no route flies the report home itself.

Checks: in plain words, matches `docs/hub-recovery-plan.md`, claims nothing the code doesn't do.

### 4. How it works: a live network graph

> A network graph driven by the team's real protocol code (`demo/sim.js` + `recovery/swarm-recovery.js`) running in the background on a fixed seed, drawn as a clean node-link diagram rather than the full map: base, drones, links, hub halo, found people. Beside it, a five-step walkthrough that highlights as it advances: search → find → relay → the hub fails → takeover. Buttons: Fail the hub, Cut radio, Replay. Live counters: reports at base, drones live, current hub and epoch.

Checks: clicking "Fail the hub" visibly moves the gold halo within about 5 s (`hubTimeout` is 30 ticks); the graph never shows invented numbers; it labels itself as the real protocol running in the browser.

### 5. Rescue scene: two drones, one person

> A wide illustrated scene in the valley. Drone A crosses a ridge and finds a stranded trekker (orange SOS). Its link to base is blocked by the ridge (red dashed). Drone B climbs to the ridge line and becomes a relay; the report hops A → B → base and the person turns green, "REPORTED". Loops with a short caption for each beat. Drawn in SVG, in the same palette.

Checks: the story is understood with the sound off and no narration; it loops cleanly; captions sync with the beats.

### 6. Try it: QR code

> A glass panel with a big QR code to the live demo and a phone mock-up beside it showing what the judges will press: "Fail the hub", "Fail a drone", "Cut radio". Copy: "Break it yourself. A learned network keeps it flying." The URL comes from `?demo=` or a constant so it can be pointed at the LAN or deployed address on the day.

Checks: the QR scans from 2 m on a projector (high contrast, a quiet zone); the URL is printed under it as a fallback.

### 7. Close

> One line of social value, the team, and a link to the technical demo.

## Ralph loop

1. Build the section from its prompt.
2. Open it in the browser at desktop (1440) and phone (375) widths and take screenshots.
3. Score it against the checks and these: visual hierarchy, contrast (WCAG AA for text), no horizontal scroll, no console errors, motion comfortable.
4. Write down the worst problem, fix it, and repeat. A section is done when two passes in a row find nothing worth fixing.
