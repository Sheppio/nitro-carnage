# NITRO CARNAGE

<!-- version -->**v0.1.2**<!-- /version --> — the build currently on Pages.

A top-down 3D combat racer that runs entirely in the browser, for 1–6 players with
**no game server**. It is a spiritual successor to the Amiga-era arcade combat racers:
short races on tight circuits, missiles front and rear, mines, and a shop between races.
Everything here is original: the name, the tracks, the meshes and the sound.

**[▶ Play](https://sheppio.github.io/nitro-carnage/)**

> **Milestone 1 of 6: one car, one 3D track.** You can free-drive Neon Downtown with
> the full camera, parallax and occlusion cut-away. Laps and bots arrive in M2,
> multiplayer rooms in M3, weapons in M4, and the shop and championship in M5.
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
npm test           # 56 checks: simulation (Node) and a real browser
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
├── DriveSession.ts   one car on one track: read input, step, draw
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
  cannot hold a drift at all.
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

56 checks across two suites. The browser suite swaps the CDN for a local three.js and a
loopback MQTT stub (ready for M3), and runs Chromium on SwiftShader.

- **`sim.test.mjs`** (39, Node):
  - **Tracks:** lap length; corner radius against the wall offset; no wall crossing
    another; the centreline clear of every wall; projection round-trips; ordered
    checkpoints; s = 0 at the start line; deterministic scenery; no tower on the road;
    six grid slots on the road and not touching.
  - **Physics:** 0–100 km/h time; top speed; turbo; braking distance; reverse; steering
    lock against speed; grip order tarmac > dirt > grass > oil; handbrake slides; no
    control in the air; landings; ramp launches; a minute of random input without NaN.
  - **Collisions:** no tunnelling at 5× top speed into any wall; head-on bounces.
  - **Determinism:** identical worlds; 144 Hz against 24 Hz; stall clamping; a
    line-follower lapping cleanly and taking the ramp.
  - **Helpers:** interpolation, deadzones, framerate-independent smoothing, colour
    clash resolution.
- **`smoke.test.mjs`** (17, browser):
  - **Boot and driving:** the name comes from the one constant; nothing invisible
    covers the menu; the world takes exactly 60 steps per second of (clamped) clock; ↑
    drives and ← steers left; the HUD shows speed.
  - **Camera:** the car sits behind centre at speed, and the lens widens.
  - **Teardown:** Esc tears the renderer down.
  - **Occlusion pixel test:** a car hidden by a tower shows 0 of 25 pixels without the
    cut-away and 19 of 25 with it.
  - **Budget:** high quality with shadows stays inside the draw-call budget, with no
    console errors.

These caught real bugs:

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
