# NITRO CARNAGE

<!-- version -->**v0.1.8**<!-- /version --> — the build currently on Pages.

A top-down 3D combat racer that runs entirely in the browser, for 1–6 players with
**no game server**. It is a spiritual successor to the Amiga-era arcade combat racers:
short races on tight circuits, missiles front and rear, mines, and a shop between races.
Everything here is original: the name, the tracks, the meshes and the sound.

**[▶ Play](https://sheppio.github.io/nitro-carnage/)**

> **Milestone 2 of 6: racing against bots.** Choose *Quick race* for three laps of
> Neon Downtown against five self-driving rivals, with a countdown, laps and times,
> race order, a minimap and a results table. *Free drive* is still there. Multiplayer
> rooms arrive in M3, weapons in M4, and the shop and championship in M5.
> [`PLAN.md`](PLAN.md) has the whole design: the topic map, codec byte counts and
> milestones.

---

## Stack, and why

The architecture follows our previous game, [glitchburst](https://github.com/Sheppio/glitchburst),
wherever it fits.

| Choice | Reason |
| --- | --- |
| **three.js 0.186** | Real 3D is the point: skyscrapers that lean away from the centre of the screen as you drive past. It is confined to `src/render/`, so it stays swappable. |
| **TypeScript, `tsc` only** | No bundler. `tsc` emits plain ES modules to `dist/`, which is committed. |
| **CDN import map** | `three` and `mqtt` resolve to jsDelivr at runtime, so there is nothing to install to *play*. We load `build/three.module.js`, not a `.min.js`: the npm package no longer ships a minified build, and we would rather load a file we know exists than rely on the CDN minifying on the fly. |
| **GitHub Pages** | The whole game is static files. Push to `main` and it deploys. |

## Running it

Playing needs nothing but a web server:

```bash
npm run serve      # http://localhost:8080
```

Developing needs the compiler:

```bash
npm install
npm run watch      # tsc --watch, rebuilding dist/ on save
npm test           # 84 checks: simulation (Node) and a real browser
```

Add `?debug` to the URL for an fps and draw-call readout, and `?quality=low` to
override the graphics preset.

`dist/` is committed on purpose, because it is what GitHub Pages serves.
**Rebuild and commit it with any change to `src/`.** CI fails if they drift, and the
pre-commit hook bumps the version and rebuilds for you.

---

## Architecture

```
src/
├── sim/      car physics, collisions, tracks-as-data, the fixed-step World — pure
├── input/    keyboard, gamepad, touch → one DriveIntent
├── render/   everything three.js: camera, track mesh, instanced scenery, cars, effects
├── ui/       DOM overlay and gamepad menu navigation (ported)
├── net/      (M3) MQTT transport, rooms, codecs
├── RaceSession.ts    one race (or free drive) on this machine: read input, step, draw
└── main.ts   wiring
```

`sim/` and `input/sources` import neither three nor the DOM. That is what lets
`test/sim.test.mjs` drive a car round a whole track in Node in a fraction of a
second, and what will let a promoted host adopt a race without inheriting renderer
state.

### A fixed 60 Hz step

The simulation advances in exact `1/60` s steps, and rendering interpolates between
the last two. Wall-clock time goes in, whole steps come out, and the remainder
carries over. The physics therefore sees the same sequence of steps whether the
screen runs at 24 Hz, 144 Hz or not at all. Two players on different hardware
simulate the same race, and a test proves it: the same wall time fed in at 144 Hz
and at 24 Hz gives the same number of steps and a bit-identical car.

Interpolation costs one step (16 ms) of latency. Without it, a 144 Hz monitor shows
each position two or three times and then jumps, which reads as the car stuttering.

A tab that slept for ten seconds does not wake up and simulate ten seconds in one
frame. Each frame's time is clamped to a quarter of a second before it reaches
the accumulator. The cost of that is deliberate: a renderer managing fewer than four
frames a second runs the race slower than real time rather than in jumps.

### The car: a bicycle model, not a physics engine

There is one front axle and one rear axle, and each gets a lateral tyre force from
its slip angle, clamped by the grip of the surface under that axle. Drive is split
40/60 front/rear and shares each axle's grip through a friction circle. Everything is
integrated in the world frame, so the textbook rotating-frame terms are not needed.

- **Why not rear-wheel drive?** It was, at first. The rear tyres can only push as
  hard as they grip, and with 49% of the weight on them that capped acceleration at
  6 m/s², so 0–100 km/h took 4.8 s. It felt like a bus. Splitting the drive gives
  3.4 s and leaves enough at the rear for the throttle to steer the tail.
- **Slip angles against a floor speed.** At walking pace a slip angle is the ratio of
  two tiny numbers, and a stiff tyre acting on it rings. Below 3 m/s the maths uses
  3 m/s.
- **Counter-steer assist.** The front wheels lean towards the direction of travel in
  a slide. A keyboard player has full lock or nothing, and without the assist they
  cannot hold a drift at all. It only acts on slip *beyond* 0.12 rad: every
  ordinary corner has some slip, and the first version, acting on all of it,
  quietly wound off 40% of the lock the driver asked for (see *Tests* below).
- **Stability aids, off with the handbrake.** The car may rotate a little faster
  than its steering asks for, enough to feel the tail step out under power, and past
  0.3 rad of slide the velocity swings back towards the nose at the same speed. Only
  part of the drive force is charged against cornering grip. A true friction circle,
  with 60% of the drive at the rear, left the rear tyres almost nothing at full
  throttle. The handbrake switches all of this off, which is the point of the handbrake.
- **Steering lock tightens with speed.** It halves by 22 m/s. Full lock at 45 m/s
  would spin any car.
- **Height is a scalar.** A ramp is a wedge in the track data. When the ground drops
  away, the car keeps the climb rate the ramp gave it: that is the launch. In the air
  there is no steering and no traction, and a hard landing costs 10% of your speed.

| Surface | Grip | Extra drag |
| --- | --- | --- |
| Tarmac | 1.00 | — |
| Kerb / pavement | 0.95 | light |
| Dirt | 0.70 | medium |
| Grass | 0.55 | heavy |
| Oil | 0.18 | — |

Drag matters as much as grip. Without it, cutting a corner across the grass would
be free.

Events such as landings and wall impacts are **monotonic counters**, not flags. The
renderer runs after however many fixed steps fitted in the frame (zero, one or
several), so a flag set in one step and cleared in the next could be missed. A
counter that only goes up cannot be.

### Collisions that cannot tunnel

The car is a **capsule**: a segment along its length inflated by a 1 m radius. That is
cheaper than a box, it slides along a wall instead of catching its corners on every
joint between wall segments, and from 56 m up nobody can tell a rounded bumper from
a square one.

Walls are one-sided segments pushed out along their own normal. Each step is split
into substeps so that the capsule moves at most half its radius per substep, and a
capsule cannot cross a segment without overlapping it on some substep. **Tunnelling is
impossible by construction**, not by luck. The test fires a car at every fifth wall
segment of the track at *five times* top speed (255 m/s) and checks that none gets
out. glitchburst learned this lesson from bullets passing through enemies. Here it
went in from day one.

### Tracks are data

A track file (`src/sim/track/downtown.ts`) exports one `TrackDef` object and nothing
else. It lists the corners, road width, pavement, start line, checkpoints, ramps and
scenery rules. `buildTrack()` turns that into a 1 m arc-length table, wall segments, a
surface lookup and seeded scenery. The files are TS rather than JSON because a
`tsc`-only build and the Node tests can both import them with no loader, and the
compiler then checks the data.

**The centreline is straights joined by circular fillets, not a spline.** Each corner
of the control polygon carries a radius. That radius is the one number that decides
both how fast the corner can be taken and whether the inside wall (offset by half the
road plus the pavement) folds back over itself. With a spline that would have to be
discovered. With a fillet it is written down, and a test checks every corner leaves
room for its wall.

Scenery is scattered from the track's seed, so every client will build the same city.

### Racing: laps you cannot cheat, and an order that never jumps

A lap is tracked from each car's arc length along the centreline (`sim/race.ts`,
pure). Cars start on the grid *behind* the line, so a car begins on lap "−1
completed": crossing the line the first time starts lap 1 and finishes nothing.
After that a lap only counts once every checkpoint has been passed in order, and
**reversing over a checkpoint or the line un-passes it**. Driving back over the line
and forwards again gains nothing, and a test does exactly that three times.

Lap times are interpolated *inside* the step. The crossing happens somewhere between
two 60 Hz steps, and the tracker works out where from the distance either side. A
16 ms quantum would decide photo finishes by rounding.

Race order is finishers by finish time, then everyone else by **distance covered**:
a running total of metres, continuous across the line and across respawns. The
obvious `laps × length + s` jumps a whole lap if a car is respawned behind the line
it just crossed, and the order would flicker. Ties break on id, so every client
sorting the same data (from M3) gets the same order.

**Respawns.** A car that has crawled for 3 s while its driver is trying to go, or has
been off the course for 1 s, goes back on the centreline 12 m behind the last place
it was on the road and heading the right way. It is placed stationary and pointing
along the track, and it is a **ghost for 2 s**, so it cannot be dropped into
somebody. WRONG WAY shows after 1.5 s of going backwards.

**Cars touch.** Car-against-car is capsule against capsule, with the impulse applied
to each side separately, because in M3 each client will resolve only its own car.

### The racing line and the autopilot

The bots, the self-driving test clients and the player's optional autopilot all use
one pure policy (`sim/autopilot.ts`):

- **The line** (`sim/racingLine.ts`) is a minimum-curvature line. Each point relaxes
  towards the midpoint of its neighbours while clamped inside the road, which cuts
  apexes and runs wide on entry and exit. It runs on a 3 m grid, because relaxation
  spreads a correction one point per iteration and a 1 m grid would need nine times
  as long to settle the long bends. On Neon Downtown the line sits over 5 m to the
  inside of the tight corners.
- **The speed profile** is what the car can corner at each point, followed by a
  backwards pass from every slow corner that brakes into it in time. It plans 16 m/s²
  of cornering and 16 of braking. The first version planned 10.5 and 11, well inside
  the car's limits "to leave a margin", and play-testing called it at once: the bots
  were timid in every corner. At 16 the best bot laps in 59 s instead of 66.5, still
  without touching a wall. At 18 they start clipping walls.
- **Steering** is pure pursuit: aim at a point on the line a speed-scaled distance
  ahead, and steer the arc that reaches it. The output is eased, because pure pursuit
  re-decides every step and a 60 Hz twitch reads on screen as a car vibrating.
- **Overtaking and room.** A slower car close ahead in our lane gets passed on the
  side with more road. A car *alongside* gets a lane's width. Without that, the two
  cars in every grid row turned into each other the moment the lights went green:
  a six-bot start produced shunts at 8–13 m/s, and now produces 2–4 m/s rubs.
- **Recovery.** Crawling or pointing the wrong way, it reverses out steering the
  opposite way, before the respawn rule would have to step in.
- **Skill** is three numbers per bot: pace (a fraction of the profile's speed, 94–100%
  across the grid, once 86–97%), wander (how far it strays off the line), and whether
  it uses the turbo on straights.

The fastest bot laps Neon Downtown in 59 s and the slowest in about 62. Six bots race
three laps in under half a second of CPU in Node. Faster bots running side by side
through the kink do rub, so the race test's "no hard shunts" means nothing over
15 m/s. It was 8, which the timid bots met and the quicker ones do not.

**Laps are long.** About 60 s on a 1.6 km lap of right-angle corners is longer than the
plan's 35–45 s, and a three-lap race runs about 3 minutes. Worth deciding once the race
has been played: fewer laps, a shorter circuit, or more grip.

### The camera

The camera sits high overhead and looks almost straight down with a 10° forward
tilt. It is fixed **north-up**: the car turns on screen, not the world. Everyone in a
race sees the same map, and the minimap agrees with the world.

**Perspective, not orthographic, is the whole trick.** The lens is 56 m up and towers
reach 34 m, so a roof sits well over halfway to the camera. As you drive past, the
buildings visibly lean away from the middle of the screen. That parallax is free: it
comes from the projection, not an effect. The tower height cap (0.6 × camera height)
is what stops a roof clipping through the lens.

- **Lead.** The camera looks along your velocity, by up to 22 m through a critically
  damped spring, so at speed you see where you're going and a sudden spin doesn't
  whip the screen round.
- **Speed.** The camera rises from 56 m to 68 m and the lens widens from 50° to 56°.
- **Shake** is trauma-based: hits add trauma, the shake is its *square*, and it decays
  linearly, so small knocks stay small. "Reduce camera shake" in settings scales it to
  a quarter.
- **Phones.** In portrait the lens widens until the narrow axis still shows 50 m of
  ground. Otherwise the view is a keyhole.

The camera started at 70 m. That made the car 4% of the screen height, which was
fine for admiring the city and bad for driving.

### Tall things must never hide a car

Buildings that cover a car are **cut away around it, not faded whole**. Fading whole
buildings pops a big tower out of existence because one corner of it covers a car. Each
building fragment asks two questions: is it nearer the camera than a car, and is it
close to that car on screen? If so, it is discarded through a 4×4 ordered-dither
pattern that thins out with screen distance. This is screen-door transparency:

- There is no sorting and depth stays correct.
- It is continuous in every input (car, camera, depth), so nothing ever pops. The
  depth test itself is softened over 1.5–4 m so the line where a wall passes the car's
  depth is not a seam.
- **Shadows are untouched**, because the shadow pass uses its own depth material. The
  tower still shades the car it has been cut away over, which is exactly right.
- About 6% of the building is left as a faint dotted ghost, so the hole reads as "you
  are behind this", not as a missing building.

It covers towers, rooftop clutter and lamp posts, which share one set of uniforms: up
to six cars' screen positions, updated once a frame.

**How often does it matter?** Less than you'd think, and the test that proved the
shader works is how we found out. A roof at height *h* can only cover the first
(*h*−1)/55 of the ground path from a car to the lens. So with the camera nearly
overhead, a car on the road on Neon Downtown is covered from roughly **one camera
position in six**, and nearly always right at the edge of the frame. The cut-away
matters more on the later tracks, where trees overhang the road and cranes cross it.

### Drawing a city at 60 fps

- **Instanced and chunked.** There is one `InstancedMesh` per kind of thing (towers,
  roof clutter, barrier blocks, lamp posts, lamp heads) per 160 m square. A single
  track-wide InstancedMesh has a bounding sphere the size of the city, so it is never
  frustum-culled and every tower is drawn every frame. Chunked, only the squares near
  the camera are. On *high* a frame is under 60 draw calls **including the shadow
  pass**, against a budget of 150, and a test holds it there.
- **Windows without textures.** Towers are a unit box scaled per instance. The shader
  recovers those scales from the instance matrix, so windows come out the same size
  in metres whatever the building's shape. It then lights a hashed subset per
  building, warm or cool, and the city glows at dusk. There are no image files anywhere.
- **A shadow box that follows you.** One directional light lights everything, but its
  shadow map only covers 150 m around your car. That box moves in steps of exactly one
  shadow texel, measured in the light's own frame. A box that slides smoothly
  re-samples every shadow edge each frame, and the edges crawl.
- **Tyre marks** are a fixed ring buffer of quads. New marks overwrite the oldest, fade
  by age in the shader, and only the slots written this frame are uploaded.
- **Particles** (smoke, verge dust, sparks off walls) are one pooled `Points` draw.
  When the pool is full the oldest particle is recycled: a fresh spark at a crash is
  worth more than the tail of old smoke.

| Quality | Pixel ratio | Shadows | Particles | Draw distance |
| --- | --- | --- | --- | --- |
| Low (phones) | 1.0 | blob only | 300 | 180 m |
| Medium | 1.25 | 1024², hard | 900 | 260 m |
| High | 1.5 | 2048², soft | 2000 | 360 m |

Every car also keeps a soft blob shadow. On *low* it is the whole shadow, and on every
setting it is what grows and fades while you are in the air, so the height of a jump
reads from straight above.

### The city had a moat

The first scenery scatter dropped any lot whose bounding *circle* came near the road.
With 12–18 m footprints that circle is about 12 m in radius, so the city stood 30 m
back from every street. There was a moat of dark ground and nothing that could lean
over a car. The test that searches for a car hidden behind a tower found no such
place anywhere on the track, which is how it came to light. The scatter now tests the
footprint's own corners and edge midpoints, and shrinks a building to fit before
giving up on its lot. The city comes right up to the pavement.

---

## Controls

| | Drive | Steer | Handbrake | Front weapon | Rear weapon | Turbo |
| --- | --- | --- | --- | --- | --- | --- |
| **Keyboard** | ↑ / W, ↓ / S | ← → / A D | Space | Z / J | X / K | Shift |
| **Gamepad** | RT / LT (analogue) | left stick | A | RB | LB | B |
| **Touch** | pedals, right thumb | left-thumb slider | button | button | button | button |

The weapons do nothing until M4. The most recently used device drives the car, so
picking up a controller mid-race just works.

- **Keyboard steering winds in over 140 ms** and returns faster. Keys are digital, and
  full lock in one frame spins the car.
- **Gamepad.** A 0.15 per-axis drift floor, then a deadzone that rescales so the rim is
  still full lock (both ported from glitchburst). Triggers are read as `value`, so half
  a trigger is half throttle. It rumbles on landings and wall hits. Menus are driven by
  the ported spatial `GamepadNavigator`.
- **Touch.** Steering is a floating slider: wherever your thumb lands is centre, and
  only horizontal travel counts. A thumb that drifts upward must not start braking. The
  layer exists only while driving: glitchburst learned that an invisible full-screen
  touch layer over the menu swallows every tap.

---

## Tests

```bash
npm test
```

84 checks across two suites. The browser suite swaps the CDN for a local three.js and a
loopback MQTT stub (ready for M3), and runs Chromium on SwiftShader.

- **`sim.test.mjs`** (62, Node):
  - **Tracks:** lap length; corner radius against the wall offset; no wall crossing
    another; the centreline clear of every wall; projection round-trips; ordered
    checkpoints; s = 0 at the start line; deterministic scenery; no tower on the road;
    six grid slots on the road and not touching.
  - **Physics:** 0–100 km/h time; top speed; turbo; braking distance; reverse; steering
    lock against speed; grip order tarmac > dirt > grass > oil; handbrake slides; no
    control in the air; landings; ramp launches; a minute of random input without NaN;
    full throttle through a corner never spins; an ordinary corner keeps most of the
    lock you asked for; at speed, full lock still turns the car.
  - **Collisions:** no tunnelling at 5× top speed into any wall; head-on bounces.
  - **Laps and order:** the grid run-up is not a lap; a full lap counts with its time;
    a missed checkpoint voids it; reversing over the line gains nothing; reversing over
    a checkpoint un-passes it; sub-step lap timing; wrong way; race order; a respawn
    behind the line costs metres, not a lap.
  - **Racing line and autopilot:** the line stays on the road and takes the inside;
    braking stays within plan; the autopilot laps cleanly inside par; six bots finish
    three laps with no respawns and no hard shunts; a bot backs out of a wall.
  - **Race rules:** nobody moves before GO; a car pinned against a wall is respawned
    after 3 s; a respawned car is a ghost for 2 s, then solid; car-to-car contact
    conserves momentum, and a one-sided resolve moves only its own car.
  - **Determinism:** identical worlds; 144 Hz against 24 Hz; stall clamping; a
    line-follower lapping cleanly and taking the ramp.
  - **Helpers:** interpolation, deadzones, framerate-independent smoothing, colour
    clash resolution.
- **`smoke.test.mjs`** (22, browser):
  - **Boot and driving:** the name comes from the one constant; nothing invisible
    covers the menu; the world takes exactly 60 steps per second of (clamped) clock; ↑
    drives and ← steers left; the HUD shows speed.
  - **Camera:** the car sits behind centre at speed, and the lens widens.
  - **Teardown:** Esc tears the renderer down.
  - **Occlusion pixel test:** a car hidden by a tower shows 0 of 25 pixels without the
    cut-away and 19 of 25 with it.
  - **Race:** a countdown with every car held; after GO six cars race, with position
    and lap shown; the minimap draws the circuit; rivals out of view get arrows; a
    one-lap autopilot race ends on a results table with the player marked.
  - **Budget:** high quality with shadows stays inside the draw-call budget, with no
    console errors.

These caught real bugs:

- **Two cars on the same spot stayed welded together.** Car contact pushes along the
  line between the closest points of the two capsules, falling back to centre to
  centre. Two cars exactly on top of each other have neither, so the push was zero and
  they never separated. That could happen with two respawns onto one spot. Found by
  the ghosting test, which parks a car on a respawned one and waits for the ghost to
  wear off. They now separate sideways.
- **The bots crashed at every start** (see *The racing line and the autopilot*),
  found by the first screenshot of a race, where the player's car was sideways and
  last.

- **The car was hard to steer**, reported from the first playable build: it pushed
  wide off the throttle, and on the throttle the tail came round and it spun. Both
  were measurable once looked for. The counter-steer assist was treating the ordinary
  slip of every corner as a slide to catch, leaving the front wheels at 59% of the
  lock asked for. Full throttle into a corner reached 1.56 rad of body slip at every
  speed from 15 to 35 m/s, which is a spin. The fixes are the assist deadband, the
  stability aids and more grip (1.25 → 1.45). A test for each half of the report now
  fails against the old physics and passes against the new: peak slip is 0.44 rad and
  the wheels keep 95% of their lock.
- **Then: "can I steer more before it understeers?"** At 25–35 m/s on full lock the
  car turned at only 30% of the rate its front wheels asked for, because the fronts
  ran out of grip long before the rears. The front now has 5% more grip, a shade
  under the rear, and light downforce lets the tyres bite harder the faster you go.
  That gives 73% at full lock, with no spins. The balance is steep: at 1.08× front grip
  the car oversteers at full lock. The price is that a hard corner now carries enough
  slip for the counter-steer assist to act, so that check's floor is 75% of the lock
  asked for (the original bug left 59%).

- **The walls did not close.** Wall segments are laid every 2 m of centreline, and
  Neon Downtown is 1,589 m, which is odd. The last segment wrapped past the start line
  and overlapped the first, which left a snag exactly where every race starts.
  *No wall crosses another* found it.
- **The city moat** (see above), found by the occlusion test failing to find anything
  to test.
- **A check that promised more than the design does.** The browser suite first
  asserted 60 steps per second of *wall* time. CI's runner, compiling shaders just
  after boot, drew about two frames a second, and the quarter-second clamp turned
  that into 31 steps a second, exactly as designed. The check now measures steps
  against the clamped clock, which is what the World guarantees, and reports the
  wall rate alongside.
- **Test bugs, again.** The first "bot backs out of a wall" check counted the test's
  own teleport as 300 m of progress (492 m in 12 s from a standstill), and the first
  ghosting check only compared a constant with itself. Both were rewritten before
  they could vouch for anything.
- **Two bugs in the tests themselves**, both worth recording because they looked like
  physics bugs:
  - The first grip test measured yaw rate times speed and declared oil the grippiest
    surface. A car spinning on oil has plenty of yaw while going straight on. It now
    measures how fast the *velocity* turns.
  - The first occlusion search required the line of sight to *leave* a tower before
    reaching the car. That excluded exactly the towers standing next to it.

The browser suite polls for outcomes and never sleeps for a fixed time. At
SwiftShader's few frames a second, a sleep tuned on a laptop is a flake.

---

## Deployment

GitHub Pages deploys from a branch: `main`, folder `/ (root)`. `.nojekyll` is present
so nothing is filtered. To deploy, run `npm run build`, commit `dist/`, and push.

CI (`.github/workflows/ci.yml`) deliberately **does not deploy**. It typechecks,
fails if the committed `dist/` has drifted from `src/`, checks that this README's test
count and version agree with the code, and runs both suites.
