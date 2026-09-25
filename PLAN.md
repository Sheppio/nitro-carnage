# NITRO CARNAGE — build plan

A top-down 3D combat racer for 1–6 players, running entirely in the browser with no
game server. It's a spiritual successor to Super Cars II: short arcade races on tight
tracks, missiles front and rear, mines, a shop between races, and a championship.
Everything in it is original: the name, the tracks, the meshes, the sound and the music.

This plan was written after reading glitchburst (`README.md`, `src/net/*`,
`src/input/*`, `test/rig.mjs`, `test/mqtt-stub.js`, CI and the version hook). Where
glitchburst already solved a problem, we reuse its solution and say so. Where this game
needs something different, mostly because it's PvP and because cars move fast, the plan
explains why.

> **Status:** M1 to M7 are built (see README). M8 is deferred. Where building changed a decision, this plan has been
> updated to match, and the change is marked with its milestone, as in *(M1)* or *(M4)*.

---

## 1. Principles carried over from glitchburst

| Convention | What we do |
| --- | --- |
| `tsc` only, no bundler | ES2022 modules emitted to `dist/`. `dist/` is committed and served by GitHub Pages from `main` at `/`. CI fails if `dist/` is stale. |
| Import map to jsDelivr | `three@0.186.1` (`build/three.module.js`, which pulls in `three.core.js`) and `mqtt@5.15.2`. Nothing needs installing to *play*. `@types/three` is a dev dependency for `tsc` only. *(M1: the npm package has no minified build any more, so we load the one file we know exists rather than rely on the CDN minifying on the fly.)* |
| MQTT.js over `wss://`, QoS 0 | We keep the same `BROKERS` list (HiveMQ, EMQX, Mosquitto) and `MqttNet` almost verbatim. Pages is HTTPS, so every endpoint is `wss://`. |
| Distributed host | The alive player with the lowest time-prefixed ID is host. Heartbeat at 2 Hz, failover after 2.5 s, the lower ID wins a split brain, and the host claim also rides on presence. The `RoomSession` logic is ported. |
| Presence | Last Will with `alive:0`, an explicit `alive:0` on leave, a 15 s backstop timeout, and a sleep-aware roster tick (a gap over 2 s means *we* slept, so everyone gets a fresh window). |
| Room = place with a lobby | The heartbeat carries room state. Late joiners wait in the lobby for the next race. |
| Colours | Colours are unique per room, and clashes resolve by seniority, then the next free colour (`resolveColours`, ported). The palette grows from 8 to 10 colours so a 6-player room always has room to move. |
| Unified input | Keyboard, gamepad and touch produce one `Intent`, and the most recent device wins. We port `GamepadNavigator` and the on-screen keyboard. The Intent becomes a driving intent. |
| Layering | `net/`, `sim/` and `input/` never import `three` or touch the DOM renderer, so the whole race runs headless in Node. |
| Wire | Compact delimited base36 strings, never JSON. Decoders tolerate truncation. New fields are added at the end, so older builds still decode. |
| Time | All wall-clock timing uses `performance.now()`, and all smoothing is framerate-independent: `1 - (1-base)^(dt/16.67)`. |
| Tests | Node sim suite, plus browser suites under Playwright with a loopback MQTT stub over `BroadcastChannel`. Assertions poll for outcomes and never sleep for a fixed time. |
| Audio | Web Audio synthesis only, with the lookahead music scheduler. The repo contains no binary assets. |
| Versioning | Pre-commit hook bumps the patch version, rebuilds, and rewrites the README span. `test/consistency.mjs` checks the README test count and version. |

The name lives in one constant: `src/brand.ts` exports `GAME_NAME = 'NITRO CARNAGE'`
and `SLUG = 'nitrocarnage'`. The page title, menu, README badge text and
`BroadcastChannel` name all derive from it.

---

## 2. Architecture

```
src/
├── brand.ts          GAME_NAME, SLUG — the only place the title is spelled
├── config.ts         BROKERS, NET timings, SIM constants, QUALITY presets
├── types.ts          shared vocabulary (no three, no DOM)
├── util.ts           Emitter, clamp/lerp, hashing, seeded PRNG, ids (from glitchburst)
├── clock.ts          Clock interface { now(), setInterval, setTimeout } — injectable
│
├── sim/              PURE. No three, no DOM, no network.
│   ├── track/
│   │   ├── TrackDef.ts       the data-file schema
│   │   ├── downtown.ts       ┐
│   │   ├── greenbelt.ts      ├ data only: no logic, validated by tests
│   │   ├── docks.ts          ┘
│   │   ├── centreline.ts     closed fillet polygon (straights + arcs), arc-length table
│   │   ├── buildTrack.ts     TrackDef → Track (walls, surfaces, grid, props)
│   │   └── scatter.ts        seeded procedural prop placement from rules
│   ├── car.ts                CarState, stepCar() — the 60 Hz physics
│   ├── collide.ts            capsule-vs-segment (swept), capsule-vs-capsule
│   ├── surfaces.ts           grip/drag table per surface
│   ├── race.ts               checkpoints, laps, wrong way, stuck/off-course, standings
│   ├── weapons.ts            projectile + mine simulation, deterministic from events
│   ├── hazards.ts            train schedule from (seed, room time), oil
│   ├── racingLine.ts         min-curvature line + speed profile per track (cached)
│   ├── autopilot.ts          racing line follower, overtaking, weapons, shopping
│   ├── economy.ts            THE tunable table: prizes, prices, upgrade curves
│   ├── championship.ts       ledger ops (pure): award, buy, carry damage
│   └── World.ts              one race: fixed-step loop, local car, remotes, projectiles
│
├── net/              PURE of rendering. Runs in Node against a stub broker.
│   ├── MqttNet.ts            transport (ported)
│   ├── topics.ts             the whole topic map in one file
│   ├── codec.ts              every wire format, with byte counts in comments
│   ├── RoomSession.ts        presence, election, capacity, colours (ported + clock injection)
│   ├── ClockSync.ts          NTP-style offset to the room clock
│   ├── deadReckoning.ts      remote car prediction + correction (pure maths)
│   ├── RaceNet.ts            car state pub/sub, event batching, DR-threshold sends
│   └── HostRace.ts           host-only race director: phases, grid, finish order,
│                             pickups, train seed, ledger, bots
│
├── input/            ported: sources → one DriveIntent; haptics
├── render/           THE ONLY place `three` is imported
│   ├── Renderer.ts           WebGLRenderer, quality presets, resize, frame loop
│   ├── CameraRig.ts          lead, speed zoom/FOV, trauma shake
│   ├── TrackMesh.ts          road ribbon, kerbs, verges, markings, ramps
│   ├── Scenery.ts            chunked InstancedMesh: buildings, trees, barriers, furniture
│   ├── materials.ts          flat/gradient Lambert + emissive windows + cut-away chunk
│   ├── CarMesh.ts            procedural low-poly car, steering/spinning wheels, roll/pitch
│   ├── Fx.ts                 tyre-mark ring buffer, pooled particles, trails, explosions
│   ├── ShadowRig.ts          directional light + shadow camera following the player
│   └── Train.ts, Hazards.ts  train, crossing barriers, oil, mine lights
├── ui/               DOM overlay: menu, lobby, shop, results, championship, HUD, minimap
├── audio/            AudioBus/volume (ported), Engine synth, Sfx, Music
└── main.ts           wiring
```

*(M2: `RaceSession.ts` at the top level owns the frame loop for a local race or free drive,
and `ui/Hud.ts`, `ui/Minimap.ts` and `ui/RivalArrows.ts` draw the race HUD; M3 turns the
session into the networked race client.)*

The rule for `sim/` is that it's deterministic given its inputs. It advances only in
fixed steps of `1/60` s, draws randomness only from seeded `mulberry32`, and never calls
`Math.random` or reads the clock. That gives us three things. The Node tests can replay
a race exactly. A projectile fired on one client flies the same path on every other.
And the scenery scattered from a seed is identical everywhere, so walls line up.

### Frame loop

```
requestAnimationFrame
  └─ dt = performance.now() delta, clamped to 250 ms
     accumulator += dt
     while accumulator ≥ 1/60:  input → World.step(1/60) → RaceNet.afterStep()
     render(alpha = accumulator / (1/60))   // local car interpolated prev→current
                                            // remote cars dead-reckoned to "now"
```

Publishing happens inside the sim step, not in render. Every third step (20 Hz) we
publish, and we also publish on any step where the dead-reckoning check trips (§5.3).
Glitchburst learned this the hard way: a host whose broadcast was tied to rendering
broadcast at 8 Hz on a slow GPU.

**Background tabs.** When the tab is hidden, rAF stops and main-thread timers are
throttled to about 1 Hz. The host's heartbeat, clock pongs and bot cars would all stall.
A tiny `Worker`, created from a Blob URL so there's no extra file, posts a tick at 60 Hz.
Chrome doesn't throttle worker timers the way it throttles page timers. While
`document.hidden` is true, those ticks drive `World.step` in place of rAF. Glitchburst
lists "a backgrounded host slows the room" as a known limitation, and this is the fix.
A test emulates the hidden state and checks that heartbeat and bot packets stay at rate.

---

## 3. Simulation

Units are metres, seconds, kilograms and radians. The world is the XZ plane, Y is up,
and yaw 0 points along +Z.

### 3.1 Car physics (`sim/car.ts`)

This is an arcade model built on the bicycle model. We deliberately avoid a physics engine.

- **State.** Position `x,z`, yaw, velocity `vx,vz` in world space, yaw rate `w`, height
  `y` and `vy`, steer angle, and flags.
- **Longitudinal force.** Engine force from a torque curve that falls off with speed,
  brake force, reverse below 1 m/s with the brake held, and rolling resistance plus
  aerodynamic drag. Base car: 0–100 km/h in about 3.4 s and a top speed of about
  47 m/s (170 km/h). Engine upgrades raise force and top speed.
- **Lateral force.** Slip angles are computed per axle. The force is
  `F = clamp(-Cα·α, ±μ·N_axle)` inside a friction circle shared with that axle's share
  of the drive force. Drive is split 40/60 front/rear *(M1: rear-only drive was
  grip-limited to 6 m/s², and 0–100 took 4.8 s)*. `μ` comes from the surface under each axle:

  | Surface | μ | Rolling drag | Notes |
  | --- | --- | --- | --- |
  | Tarmac | 1.00 | 1.0× | baseline |
  | Dirt | 0.70 | 1.6× | throws dust particles |
  | Grass | 0.55 | 2.4× | slows you as well as sliding you |
  | Oil | 0.18 | 1.0× | almost no lateral grip; a hazard |

- **Handbrake.** Locks the rear axle: rear `μ ×0.4` and no drive. That's the
  flick-into-a-hairpin move.
- **Drift feel.** Maximum steer angle shrinks with speed. A counter-steer assist
  lets the front slip angle track the velocity direction. Slip past about 0.15 rad
  sets the `drifting` flag, which drives tyre marks, smoke and squeal.
- **Turbo.** While the meter lasts, it adds drive force and raises the top speed.
  Capacity and power come from the turbo upgrade.
- **Height.** A ramp zone (a span along the spline, §3.3) sets `vy` from speed on exit.
  In the air, gravity applies, there's no traction and no steering, and yaw rate is
  kept. On landing, `vy` is lost into a `landing` impulse. The renderer shakes the
  camera and the gamepad rumbles from that impulse, and a hard landing costs 10% speed.
  The shadow grows and softens with height (renderer only).
- All tunables live in `SIM.car` and are multiplied by upgrade levels from
  `economy.ts`.

### 3.2 Collisions (`sim/collide.ts`)

- The car is a **capsule**: a segment along its length with radius about 1.0 m. That's
  cheaper than an OBB and it never catches on segment joints.
- **Walls.** One-sided segments built from the track edges. They're stored in a
  uniform grid with 16 m cells, so a query touches only a few cells.
- **Sweeping.** We substep so each substep moves the capsule at most 0.5 × radius:
  `n = ceil(|v|·dt / (0.5·r))`. That's 2–3 substeps at top speed. A capsule can't
  cross a segment without overlapping it on some substep, so tunnelling is impossible
  by construction. The test launches a car at 5× top speed into every wall of every
  track and asserts it never crosses. That's the lesson from glitchburst's bullet
  tunnelling bug, applied up front.
- **Response.** Push out along the normal, remove the normal velocity with a
  restitution of 0.25, apply tangential friction, and add yaw torque from the contact
  point, so a glancing hit spins you a little. An impact whose normal speed exceeds
  12 m/s costs health, scaled by armour. The victim authors this damage, and it's local
  to the victim.
- **Car against car.** Capsule-vs-capsule with a mass-weighted impulse. Networking
  rules for bumps are in §5.5.

### 3.3 Tracks are data (`sim/track/*.ts`)

A track file is a TS module that exports one `TrackDef` object, and nothing else. We
use TS rather than JSON because `tsc`-only builds and Node tests can both import it with
no loader, and the compiler type-checks the data. `test/sim` also validates every track
at runtime: the loop is closed, there are no self-intersections, and the checkpoints are
ordered.

```ts
interface TrackDef {
  id: string; name: string; laps: number; seed: number;
  theme: ThemeId;                               // sky, fog, ground, light angle, palette
  corners: [x: number, z: number, r: number][];  // closed polygon, fillet radius per corner
  width: number | { at: number; w: number }[];  // road width, can vary along s
  verge: { left: VergeDef; right: VergeDef };   // width + surface + wall? on each side
  start: { s: number };                         // start/finish line (fraction of lap)
  checkpoints: number[];                        // ordered s fractions, start excluded
  surfaces: SurfaceZone[];                      // {span s0..s1, d0..d1} | {circle}
  ramps: { s: number; len: number; lift: number }[];
  pickups: { s: number; d: number; kind: 'cash' | 'repair' | 'ammo' | 'turbo' }[];
  hazards: HazardDef[];                         // train crossing, fixed oil, water
  props: PropRule[];                            // explicit props + seeded scatter rules
}
```

`buildTrack()` turns that into a `Track`:

- The centreline is **straights joined by circular fillets**, one radius per corner,
  rather than a Catmull-Rom spline *(M1)*. A radius is the one number that decides both
  how fast a corner can be taken and whether the inside wall (offset by half the road
  plus the pavement) folds back over itself. With a spline that has to be discovered;
  with a fillet it's written down, and the test checks it.
- An arc-length table sampled every 1 m, holding position, tangent and curvature. Projecting a point to `s` is a local search from the car's last `s`, with a
  grid lookup as a fallback, so it's O(1) per step.
- Wall segments from the left and right offset curves, with a verge where one is defined.
- Surface lookup `(x,z) → surface`: road if `|d| < w/2`, otherwise the verge surface,
  otherwise explicit zones such as oil circles and dirt spans.
- Grid slots: 6 slots in 2×3 staggered rows behind the start line.
- Props from explicit placements plus scatter rules, such as "fill blocks within
  30–120 m of the road with buildings of height 12–48 m" or "trees in this polygon at
  density 0.02/m², keeping 6 m clear of road". Scatter is seeded, so every client
  generates the same world.

Building heights are capped at 0.6 × the camera's minimum height (§4.1). At that ratio a
roof sits a little over halfway to the lens, which gives a strong lean without the roof
clipping through the camera.

### 3.4 The three launch tracks

| Track | Theme | Character | Hazards |
| --- | --- | --- | --- |
| **Neon Downtown** (M1) | skyscraper grid at dusk, emissive windows | 90° corners, a chicane, a long straight between towers, a plaza ramp; walls on both sides | none (it's the clean one) |
| **Greenbelt** (M5) | park and forest, afternoon | flowing curves, grass verges instead of walls in places, a dirt shortcut, a creek jump | grass, dirt |
| **Tidewater Docks** (M5) | container port, overcast | tight container canyons, cranes as tall occluders, quay edge | railway level crossing with a host-timed train, oil patches, water off the quay (respawn) |

Each lap is about 1.2–1.8 km, so about 35–45 s. A race is 3–5 laps.

*(M5, as built.)*
- **Greenbelt's shortcut** became a gravel stretch on the racing line. A shortcut would
  need lap-validation rules for a second path. The creek is bridged: the road runs over
  it just past the jump. The open verges are **wall gaps**: `wallGaps` in the
  `TrackDef` removes the barrier along a stretch on one side.
- **The Docks' water** is a `water` rectangle: off the road inside it, a car is put
  straight back on the road.
- **The railway** is a finite line from `from` to `to` that must cross the road exactly
  once (a test checks). The train is a pure function of race time, clipped to the
  rails' ends. Bots stop for it using the same function.
- Laps are 49 s (Greenbelt), 60 s (Downtown) and 62 s (Docks) for the fastest bot.

### 3.5 Race logic (`sim/race.ts`)

- **Laps.** A car must pass its checkpoints in order. Crossing the start line with every
  checkpoint passed completes a lap. The crossing time is interpolated inside the step
  and stamped in *room time* (§5.2), so lap times are sub-frame accurate and comparable
  across clients.
- **Progress.** `lap × L + s` (along the spline) gives the running order.
- **Wrong way.** If velocity along the tangent is below −2 m/s for 1.5 s, the WRONG WAY
  banner shows. Reversing across the line un-passes checkpoints, so you can't farm laps.
- **Respawn.** Triggers when the car is stuck (under 1 m/s with throttle held for 3 s),
  off-course (the projection distance exceeds half the width plus the verge plus 4 m, or
  the car is in water), or wrecked (§3.6). The car goes to the centreline about 15 m
  before where it failed, faces along the tangent, and gets 2 s of ghost time: no car
  collisions and no hits. A respawn is announced as a teleport event (§5.4), so remotes
  snap instead of sliding.

### 3.6 Weapons (`sim/weapons.ts`)

| Weapon | Behaviour | Damage | Bought in |
| --- | --- | --- | --- |
| Front missile | 90 m/s straight, 1.4 s life, stops at walls | 20 *(M4: was 30)* | packs of 5 |
| Rear missile | fired backwards, 70 m/s, 1.2 s | 20 *(M4: was 25)* | packs of 5 |
| Mine | dropped behind, arms after 0.6 s, lasts 45 s, pulsing light | 30 *(M4: was 35)* | packs of 3 |
| Turbo | meter, not ammo; capacity and power by upgrade | — | upgrade + pickup refill |
| Super weapon | one-shot; see the design below *(M5 design pass; not built)* | — | later |

- A projectile is fully determined by `(origin, angle, weapon, t_fire, seed)`. Every
  client simulates it, fast-forwarding from `t_fire` on arrival so late packets catch up.
  Walls stop it identically everywhere, because the walls are identical everywhere.
  *(M4: better than fast-forwarding. A missile flies straight at a constant speed, so
  one ray cast when it's fired gives its whole flight, and its position is a function
  of time. A late arrival is just evaluated later. No seed is needed.)*
- *(M4)* **Balance, measured.** The damages above, a 4 s no-fire grace after GO, and
  3.5–7 s between a bot's shots give 5–7 wrecks in a 6-bot, 3-lap race, about one per
  car. The first numbers gave 13. Until the shop in M8, every car starts a race with
  10 front missiles, 5 rear missiles and 3 mines. The rear button drops mines while
  you have them, then fires rear missiles. A selector can come with the shop.
- *(M5 design pass)* **Super weapon: the Shockwave.** It's a ring that expands from the
  car to 22 m in 0.35 s. Every car it reaches is knocked away from the centre by
  12 m/s, takes 15 damage, and has its weapons and turbo jammed for 3 s. It's charged,
  not bought: the charge fills with damage you deal (100 damage for one charge, one
  charge held at most), so it rewards the aggressive driver and gives a car being
  hunted a way out. It follows the same rules as the other weapons:
  - Like a missile, the ring is a function of time from `(x, z, tFire)`, so one `S`
    event carries it and late arrival costs nothing.
  - Like a mine, **the victim detects** whether the ring reached it, and applies the
    knock-back to itself. A ring is a single decision per victim, and
    victim-detection keeps the knock-back smooth on the one screen that matters.

  It stays unbuilt until the core game has been played enough to know whether it
  needs one.
- *(M4)* Car-to-car contact does **not** cause damage. It would need both owners to
  agree on the impact, and walls and weapons already give plenty. It may be revisited.
- *(M4)* A wall hit faster than 12 m/s costs 1.4 health per m/s over. A wall that
  wrecks a car within 4 s of somebody hitting it credits them with the kill.
- A projectile is **inert everywhere except on the shooter's client** (§5.4).
- Health is 100 base, reduced by armour. At 0 health the car is **wrecked**: it
  explodes, respawns after 2.5 s with 35 health, and the killer earns a bounty. The time
  lost is the penalty. That keeps a 6-player race from going empty.
- Missile and mine sims are pure, so a Node test fires the same event into two separate
  `World`s and asserts identical trajectories and wall hits.

### 3.7 Autopilot (`sim/autopilot.ts`)

One pure policy: `(car, track, line, others, loadout) → DriveIntent`. It's used for
three things. It fills empty grid slots with bots, run by the host. It drives
self-driving test clients, as glitchburst's auto-move did. And the "autopilot completes
a lap on every track" test uses it.

- **Racing line** (`racingLine.ts`). A minimum-curvature relaxation of the lateral offset
  inside `width/2 − margin`, followed by a speed profile `v = sqrt(μ·g·k / κ)` with
  forward (acceleration) and backward (braking) passes. It's computed once per track and
  memoised.
- **Steering.** Pure pursuit on the line, with the look-ahead scaled by speed.
- **Throttle, brake and handbrake.** Track the profile speed. Use the handbrake below a
  radius threshold.
- **Overtaking.** If a car is ahead on the line within about 12 m and closing, shift the
  target offset to the side with more room, then return to the line once past.
- **Weapons.** Fire a front missile when a rival is in a ±6° cone within the missile's
  reach. Drop a mine or fire a rear missile when a rival is within 15 m behind and in line.
- **Shopping.** Repair first, then ammo to a target, then the cheapest next upgrade, with
  a savings bias.
- **Recovery.** Reverse and steer out when stuck, before the respawn rule kicks in.
- An 80 ms exponential ease on the output stops it vibrating. Glitchburst measured 531
  heading reversals a minute without that ease.
- **Difficulty.** Bots take a speed-profile scale, a line-noise amplitude and a
  weapon-reaction delay. That's three numbers, set in `SIM.bots`.
- Real input always overrides the autopilot, frame by frame.

### 3.8 Economy and championship (`sim/economy.ts`, `sim/championship.ts`)

Every number lives in **one table**:

```ts
export const ECONOMY = {
  prize:   [1000, 700, 500, 350, 250, 150],  // by finishing position
  points:  [10, 6, 4, 3, 2, 1],
  bounty:  150,                              // per wreck you cause
  startingCash: 1500,
  repairPerHp: 6,
  ammo: { front: { pack: 5, price: 250, max: 20 }, rear: { … }, mine: { … } },
  upgrades: {                                 // level 0 = stock, 4 = max
    engine: { price: [600, 1100, 1800, 2800], effect: [1, 1.08, 1.16, 1.24, 1.32] },
    tyres:  { price: […],                     effect: [1, 1.06, …] },  // μ multiplier
    armour: { price: […],                     effect: [1, .88, …] },   // damage taken
    turbo:  { price: […],                     effect: [{cap, force}, …] },
  },
};
```

- Damage **carries between races**, and repairs cost money. That's the Super Cars loop:
  winning pays for the repairs that racing dirty costs you.
- A championship is N races: 3, 5 or 7, chosen in the lobby. It cycles the track
  rotation. From race 2 onwards the grid is reverse championship order, so the leader
  starts at the back.
- The **host owns the ledger** (§5.6), and clients render the host's numbers only.
- The summary screen shows points, wins, wrecks caused, best laps and total earnings.

---

## 4. Rendering (`src/render/`, Three.js)

### 4.1 Camera (`CameraRig.ts`)

- A perspective camera with a vertical FOV of 50° that widens to 56° at top speed.
- Height is 56 m, rising to 68 m at top speed *(M1: lowered from 70 m, where a car was
  4% of the screen height)*. The camera looks almost straight down
  with a **10° forward tilt**. Screen orientation is **fixed north-up**, as in the
  original genre, so the car rotates on screen and multiplayer and the minimap stay
  readable. (A rotate-with-car mode can be a setting later.)
- **Lead.** The look-at point is offset along velocity by `v × 0.5 s`, capped at 22 m,
  through a critically damped spring. At speed you see where you're going, and the car
  sits off-centre towards the back.
- **Parallax** comes from the perspective itself. Towers up to 34 m tall under a camera
  at 56 m lean visibly away from screen centre as you pass.
- **Shake.** A trauma model: `trauma ∈ [0,1]` decays at 1.5/s, and the offset and roll
  are `trauma² × noise(t)`. Hits add 0.5, wrecks 1.0, and landings add
  `impulse × k`. There's a "reduce motion" setting that scales it down.
- The camera is framerate-independent, and it reads the *interpolated* local car so it
  never judders at 144 Hz.

### 4.2 Occlusion: a screen-space dithered cut-away

When a tall object stands between the camera and a car, part of it disappears around
that car's screen position. Fading whole buildings would be the other option, and it's
worse on both counts. A big building pops out entirely just because its corner covers a
car. And per-instance raycasts cost CPU per building per car.

- Each frame the CPU projects up to 6 cars to screen space and uploads
  `uCars[6] = (ndc.x, ndc.y, viewDepth, strength)`.
- The tall-occluder material (buildings, tree canopies, cranes) gets a shader chunk via
  `onBeforeCompile` on `MeshLambertMaterial`. For each car it takes the fragment's
  aspect-corrected screen distance to the car. **Only if the fragment is nearer to the
  camera than the car**, it computes a soft radial `cut` (the radius scales with the
  car's projected size) and discards when `bayer4x4(gl_FragCoord) < cut × strength`.
  That's screen-door transparency. It needs no sorting and keeps depth correct. Buildings
  still cast their shadows, because the shadow depth material is untouched, so the car
  stays correctly in shadow.
- `strength` eases per car in about 180 ms. A car driving under a tower gets a hole that
  opens and closes smoothly rather than popping.
- There's a pixel test for it: park a car where a tower provably blocks the line of
  sight, read back the pixels at its projected position with the cut-away off and on,
  and assert the car's colour is hidden without it and visible with it.
- *(M1 finding)* With this camera, a car on the road is covered only from about one
  camera position in six on Neon Downtown, and then nearly always at the frame's edge,
  because a roof at height h covers only the first (h−1)/55 of the ground path from the
  car to the lens. The cut-away matters more for overhanging trees and cranes (M5).

### 4.3 Look and lighting

- Low-poly and flat-shaded, using `MeshLambertMaterial` with vertex colours for gradients
  such as darker at the base of buildings and a sky-tinted roof edge.
- One `DirectionalLight` with shadows. `ShadowRig` keeps its orthographic frustum (about
  140 m) centred on the local car and **snapped to shadow-texel increments**, so shadows
  don't shimmer as the camera moves. There's also a hemisphere fill light, and `Fog`
  tuned per theme so the draw-distance setting hides the far plane cleanly.
- Building windows are emissive and procedural. A shader function of the building's UVs
  and instance seed lights a random subset of windows. There's no texture.
- All geometry is generated in code. Road texture detail (lane dashes, kerbs, start grid)
  comes from vertex colours and a small procedurally drawn `CanvasTexture`, and there are
  no image files.

### 4.4 Instancing and chunking (`Scenery.ts`)

- There's one `InstancedMesh` per prop kind per **spatial chunk** (128 m squares). That
  way frustum culling works at chunk level. A single track-wide InstancedMesh would never
  be culled.
- Prop kinds: box towers (3 silhouettes), trees (cone, sphere, poplar), barrier blocks,
  tyre walls, lamp posts, bollards, containers (docks), and crane parts.
- The budget is **under 150 draw calls and under 350k triangles** on "high". A browser
  test asserts `renderer.info.render.calls` stays inside the budget on every track.

### 4.5 Cars (`CarMesh.ts`)

- A procedural body from a few chamfered boxes (hull, cabin, spoiler, bumpers), about
  400 triangles. Body colour comes from the resolved player colour, with a darker
  secondary, and the cabin is glass-dark.
- Front wheels steer by `steer` and all wheels spin by speed. Body roll and pitch come
  from a spring-damper fed by the sim's lateral and longitudinal acceleration. That's
  render-only, so it costs nothing on the wire.
- Below 30% health the car smokes, and below 15% it smokes more with a spark. The
  shadow blob grows while airborne. A ghost car is dithered at 50%.

### 4.5b Car customisation: liveries and body styles *(M6, added after M3)*

Players choose how their car **looks**. How it drives doesn't change: every body style
uses the same `SIM.car` tunables and the same collision capsule, so choosing a style is
never a competitive decision. Handling per model is a possible later step (see below),
but it isn't part of M6.

**What stays fixed.** The **body colour is still the room colour.** It's unique per room
and resolved by `resolveColours`, because it's how you tell cars apart on the minimap,
on the rival arrows and on the results screen. Customisation adds to that colour; it
never replaces it.

**What you choose.**

| Choice | Options | Notes |
| --- | --- | --- |
| Body style | 5 to start: **Coupé** (today's car), **Hatch**, **Muscle**, **Wedge** (low supercar), **Buggy** (open wheels, roll cage) | Each one is procedural like today's car: chamfered boxes, about 300–500 triangles, and no model files. Each has to fit inside the shared capsule footprint, and a test checks that. |
| Stripe pattern | none, twin racing stripes, single offset stripe, side flash, chequer bonnet, number roundel | Drawn into a small `CanvasTexture` per car, the same way procedural windows are drawn now. There are no image assets. |
| Stripe colour | any colour from the palette, including the one your body already uses | It doesn't have to be unique, so it's chosen freely. Contrast with the body is kept automatically: if the two colours are too close, the stripe is drawn darker. |
| Wheel rims | silver, black, gold, body colour | This is a colour only, not a mesh change. |
| Race number | 0–99, shown on the roundel and the roof | |

**Networking.** A car's look goes out **once**, on presence, and never in the 20 Hz car
packets. It's a compact `look` field of 4 base-36 characters: body, pattern, stripe
colour and rims, with 2 more for the number. That adds about 7 bytes to presence, so the
§5.10 budget doesn't change. Older clients ignore the unknown field. An unknown or
malformed look falls back to the stock Coupé with no stripe, the same way `sanitizeName`
treats bad names, so a bad packet can't crash a renderer. Bots get a look from the room
seed, so every screen shows them the same way.

**Storage.** The look is saved in `localStorage` (`nitrocarnage.look`) next to your name
and colour.

**UI: the Garage.** The Garage opens from the menu and from the lobby. It has a turntable
preview of your car rendered by the normal `CarMesh`, and the choices above laid out as
left/right pickers. It's driven by the same `GamepadNavigator` as the other screens, with
LB/RB to cycle body styles. It has to fit the Deck's 1280×800 screen. In the lobby, each
roster row gets a small car icon in that player's look. The room colour stays the one
from the lobby colour picker, and the Garage shows it but doesn't change it.

**Render.**
- `CarMesh` takes a `look` and builds one of the body builders (`render/cars/*.ts`).
- Wheel positions come from the shared car dimensions, so the steering, spin, roll and
  pitch code doesn't change.
- Meshes are cached per `(body, look)` in a room of up to 6, so the draw-call budget
  isn't affected.
- Damage smoke, the airborne shadow and the ghost dither work the same on every body.

*(As built in M6:*
- *stripes are geometry (thin boxes on the bonnet, roof and boot), not a
  `CanvasTexture`, which matches the flat-shaded look and costs no texture per car;*
- *the race number is a small canvas-drawn disc: on the roof always, and on the doors
  with the roundel;*
- *each body carries its own light positions;*
- *the footprint and triangle-budget check runs in the browser suite, because the
  bodies are three.js geometry.)*

**Handling per model (future, not M6).** If body styles are ever made to drive
differently, it would be a small multiplier table on top of `SIM.car`: mass, grip, top
speed and turn-in. It would be balanced by a test in which the autopilot laps every
track in every body, and the fastest and slowest lap times must be within about 1.5%. The
table would sit behind a room option so that equal cars stay the default. M8 upgrades
already provide the "different cars drive differently" idea, so this can wait until M8
has been played.

### 4.6 Effects (`Fx.ts`)

- **Tyre marks.** A ring buffer of 4096 quads in one `BufferGeometry`, written in place
  with `addUpdateRange`. The oldest marks are overwritten and fade with age through a
  vertex attribute. Marks are laid while drifting, handbraking or braking hard.
- **Particles.** One pooled `InstancedMesh` of billboards per material, for smoke, dust,
  sparks and debris. Pool size comes from the quality setting. When the pool is full, the
  oldest particle is recycled rather than new ones being refused.
- **Missile trails.** These are particles too. **Explosions** are a flash sprite, a
  debris burst and camera trauma. **Mine lights** are emissive and pulse at 2 Hz, faster
  when a car is near.

### 4.7 Quality presets

| | Low (phones) | Medium | High (iGPU laptop target) |
| --- | --- | --- | --- |
| Pixel ratio cap | 1.0 | 1.25 | 1.5 |
| Shadows | off (blob only) | 1024², hard | 2048², PCF soft |
| Particles | 300 | 900 | 2000 |
| Draw distance / fog | 180 m | 260 m | 360 m |
| Tyre marks | 1024 | 2048 | 4096 |
| Antialias | off | off | on |

The default preset depends on device class, and the game auto-drops one level if frame
time stays above 20 ms for 3 s. The cut-away (§4.2) is always on, because not being able
to see your car is a gameplay bug, not a visual one.

---

## 5. Networking

### 5.1 Authority

| Thing | Authority | Mechanism |
| --- | --- | --- |
| Your car's position, velocity and health | **you** | `c/<id>` at 20 Hz, plus immediately when the dead-reckoning error trips |
| Your missile hitting someone | **shooter** detects, **victim** applies | `H` event from the shooter. The victim applies it once, deduplicated by `(shooter, shotSeq)` |
| A mine you drive over | **victim** detects and applies | `T` event, and every client removes the mine |
| Wall impacts, wrecks, respawns | **you** | `D` / `R` events |
| Car-vs-car bumps | each side resolves its own car | `B` impulse event, applied only if the receiver saw no contact itself (§5.5) |
| Countdown, grid, lap and finish order, train, pickups | **host** | heartbeat and `hx` events |
| Prize money, points, upgrades, ammo stock between races | **host** | `ch` ledger |
| Bot cars | **host** | published exactly like a human car. The new host adopts them on failover |

"Favour the shooter" is a deliberate trade-off, the same one glitchburst made. On the
shooter's screen the hit is exact and instant. The victim may see a missile that looked
like a near miss, which is accepted in exchange for zero-latency hits and exactly one
decision per hit.

### 5.2 Room clock (`ClockSync.ts`)

All shared timing uses **room time**: the host's `performance.now()` plus the host's own
offset. That includes GO, lap and finish stamps, fire times and train crossings.

- A client pings `kq/<pid>` with `t0`, and the host answers straight away on
  `ka/<pid>` with `t1`, its room time on receipt. The client computes
  `rtt = t3 − t0` and `offset = t1 + rtt/2 − t3`. It keeps the sample with the **lowest
  RTT out of the last 8**, since the fastest round trip is the most symmetric, and it
  slews towards a new estimate rather than stepping.
- Pings go at 2 Hz for the first 4 s after joining or after a host change, then every 5 s.
- **Failover keeps the clock continuous.** The original host has offset 0. A promoted
  host keeps serving *its current estimate* of room time, not its raw
  `performance.now()`. The timeline therefore survives the handover, and a `goAt` stamped
  by the dead host still means the same instant. Without this, every stamp in flight
  would be wrong by the difference between two machines' uptimes.
- The race starts when `roomNow() ≥ goAt`. The host sets `goAt = now + 4000`, which
  gives the 3-2-1 countdown time to reach everyone.

### 5.3 Dead reckoning and correction (`deadReckoning.ts`)

Plain interpolation renders remote cars 100–150 ms in the past. At 45 m/s that's 5–7 m,
more than a car length, so you'd shoot at cars that aren't there any more. Instead we
**extrapolate to now**:

- **Model: constant turn rate and velocity.** From a packet stamped `ts`, we predict
  `dt = roomNow − ts`. The velocity vector rotates by `w·dt`, so a car mid-corner is
  predicted along its arc, not off the tangent into a wall. In the air, `y` follows a
  ballistic path.
- **Cap.** Extrapolation stops at 300 ms. Past that the car decelerates to hold, and the
  HUD marks the player as lagging.
- **Correction.** Projective velocity blending. When a packet arrives, the displayed state
  doesn't jump. We blend from the *current displayed* trajectory to the *new predicted*
  trajectory over 150 ms: `pos = lerp(oldPred(t), newPred(t), smooth(τ))`, framerate
  independent. The result carries no visible pop and still converges fast.
- **Snap** only past 10 m of error, or on an explicit `R` (respawn) event.
- **Walls.** A remote's extrapolation is collided against walls with the same swept
  routine, so lag never draws a car inside a building.
- **Sender side.** Each step the sender runs *the same predictor* on its own last
  published packet. If the prediction is off by more than 0.35 m or 4° of yaw, or the
  flags or health changed, it publishes immediately. That's the "plus immediately on
  sharp changes" rule, made precise. Sends are capped at 30 Hz.
- **Acceptance test.** Replay recorded autopilot laps through a simulated link with
  60–150 ms jitter and 5% loss. Assert a 95th-percentile position error under 0.8 m and
  a maximum yaw error under 8° outside snaps.

### 5.4 Projectiles and mines

- The shooter publishes `F` with `(shotSeq, weapon, x, z, angle, tFire)`. The seed is
  `hash(carId, shotSeq)`, so it costs no bytes. Each client spawns the projectile and
  fast-forwards it to `roomNow − tFire`.
- **Only the shooter's copy collides with cars.** It tests against its *displayed*
  (dead-reckoned) cars. On contact it publishes `H(shotSeq, victimSlot, dmg, x, z)`.
  Every client removes that shot and plays the explosion at `(x, z)`. The victim applies
  the damage once, keyed on `(shooter, shotSeq)` for idempotence, and then publishes its
  health on the next state packet, which goes immediately because health changed.
- **Mines.** `M(mineSeq, x, z, tDrop)` places a mine everywhere. Only the *car that
  drives over it* detects it. It publishes `T(ownerSlot, mineSeq)`, applies the damage to
  itself, and every client removes the mine. If two cars genuinely hit the same mine in
  the same 50 ms, both take damage. That's rare and harmless, and it's cheaper than
  arbitration.
- Anything a dropped packet could leave dangling expires by lifetime, since missiles and
  mines are both short-lived.

### 5.5 Car-vs-car bumps

Each client resolves contacts **for its own car only**. It pushes its own car out of the
remote's dead-reckoned capsule and applies its half of the impulse to its own velocity.
It then publishes `B(otherSlot, jx, jz)`, the impulse it believes the *other* car
received.

- A receiver that detected the same contact itself within the last 200 ms ignores the
  `B`, because it has already handled it.
- A receiver that didn't detect it, because it saw a slightly different geometry,
  applies `jx, jz` to its **velocity** only, over 3 steps. It never moves its position,
  so the local car never hard-snaps.
- Net result: each car gets bumped once, by its owner, from the owner's best information.

### 5.6 Host race director (`HostRace.ts`)

The race moves through these phases:

```
LOBBY → COUNTDOWN → RACING → FINISHING (first finisher +30 s, or all done) → RESULTS
      → SHOP (all ready, or 60 s) → COUNTDOWN (next race) … → CHAMPIONSHIP → LOBBY
```

- **Grid.** At COUNTDOWN the host freezes the grid: slot 0–5 → car ID, with humans
  first and then bots. Slots are the 1-character short IDs used on the wire.
- **Standings.** Live position is computed on every client from `(lap, s)` in the car
  packets. That uses the same inputs and the same rule as the host, so it's instant and
  almost always identical. **Finish order is the host's.** It orders by the reported
  `tFinish` room stamps, not by arrival order, so latency can't reorder a photo finish.
  It publishes `O(slot, pos, tFinish)` and carries the whole order on every heartbeat.
- **Pickups.** A client that drives over a pickup sends `P(idx)`. The host grants the
  first claim with `G(idx, slot)` and schedules a respawn. Pickup availability is a
  bitmask on the heartbeat, so a dropped `G` heals itself within 500 ms. The claimant
  gets a "pending" sparkle straight away and the reward on grant.
- **Train.** The host picks a `trainSeed` at race start and puts it on the heartbeat.
  `hazards.ts` turns `(seed, goAt, roomNow)` into crossing windows. The barriers come
  down 4 s ahead, and the train takes about 6 s to pass. Every client derives the same
  train from the same numbers, and each client checks its own car against the train
  (victim authority, as for mines).
- **Ledger.** Cash, points, upgrades, ammo stock and carried health are held per car ID.
  Shop purchases are `Q(item)` requests to the host, which validates the cash, applies
  the purchase and republishes `ch`. The shop is between races, so the round trip doesn't
  matter. At race end each client reports its final health and ammo in its finish event.
- **Failover mid-race.** The new host adopts phase, `goAt`, grid, finish order, pickups
  and train seed from the last heartbeat. It adopts the ledger from the last `ch`, since
  every client keeps the latest copy. It adopts the bot cars from their current
  dead-reckoned states and starts stepping them. Clock continuity (§5.2) means nothing
  shifts. **The race doesn't end.**

### 5.7 Room capacity and late joiners

- The cap is 6 humans. As in glitchburst, a client ranked 7th or later in the sorted
  alive IDs knows it's the overflow and backs out with a "room full" message. Nobody
  gatekeeps.
- Bots fill empty grid slots only when a race begins, so a new human displaces a bot at
  the next race and never mid-race.
- A late joiner sees the room phase on the heartbeat, stays in the lobby, and watches
  the race live in spectator mode, following the leader, because it's already receiving
  the car packets. It joins the championship at the next COUNTDOWN with 0 points and
  starting cash.

### 5.8 Topic map

All topics sit under `nc/room/<roomId>/`, where `<roomId>` is a 4-character code from
glitchburst's unambiguous alphabet. MQTT 3.1.1 has no topic aliases, so the topic string
travels in **every** PUBLISH. The hot topics therefore get 1–2 character names. The
long, descriptive names live in `topics.ts` as function names, not on the wire.

| Topic | Publisher | Rate | Payload |
| --- | --- | --- | --- |
| `pr/<pid>` | each player (+ Last Will) | 1 Hz | presence |
| `hb` | host | 2 Hz | heartbeat: room + race state |
| `hx` | host | on event, batched per 50 ms | race events: countdown, finish, grants, shop replies |
| `ch` | host | on change + every 2 s | championship ledger |
| `c/<carId>` | car owner (host for bots) | **20 Hz**, plus DR bursts (cap 30 Hz), racing only | car state |
| `e/<carId>` | car owner | on event, batched per 50 ms, only when non-empty | car events |
| `kq/<pid>` | client | 2 Hz for 4 s, then 0.2 Hz | clock ping |
| `ka/<pid>` | host | reply to each ping | clock pong |

Car IDs are player IDs (13 characters, time-prefixed as in glitchburst) or `b0`–`b5` for
bots. Bot IDs are keyed to the grid slot, so a promoted host republishes on the same
topics.

### 5.9 Codecs and byte counts

Fields are comma-separated and records `;`- or `|`-separated. Numbers are base36 and
signed with a leading `-`. Decoders tolerate truncation, and new fields go at the end.

**Car state** (`c/<carId>`, the ID is in the topic):

```
t,x,z,yaw,vx,vz,w,steer,y,vy,flags,hp,lap,s
1b2c,a3k,7fq,zk,ci,-9x,46,m,0,0,1a,2s,2,12w
```

| Field | Encoding | Chars |
| --- | --- | --- |
| `t` | room-time ms mod 36⁴ (28 min wrap, decoded to the nearest) | 4 |
| `x`, `z` | decimetres, offset so tracks are ≥ 0 (up to 4.6 km) | 3 + 3 |
| `yaw` | 1/1296 turn (0.28°) | 2 |
| `vx`, `vz` | dm/s, signed | 2–3 each |
| `w` | yaw rate, centi-rad/s, signed | 1–3 |
| `steer` | −1..1 → 0..35 | 1 |
| `y`, `vy` | cm, dm/s. Both `0` on the ground | 1 + 1 (up to 3 + 3 airborne) |
| `flags` | bits: throttle, brake, handbrake, turbo, drift, airborne, ghost, wrecked, reverse, finished | 1–2 |
| `hp` | 0–100 | 1–2 |
| `lap` | 0–9 | 1 |
| `s` | metres along the spline | 3 |

**Payload: 43 bytes for the example above, 54 at worst** (airborne, full-speed
reverse drift). For comparison, JSON would be about 190. On the wire, one publish is
2 (fixed header) + 2 (topic length) + 28 (topic) + 43 = **75 bytes**, plus 2–6 bytes of
WebSocket framing.

**Car events** (`e/<carId>`), as `tag:fields` records joined by `|`:

| Tag | Meaning | Fields | Typical bytes |
| --- | --- | --- | --- |
| `F` | fire | shotSeq, weapon, x, z, angle, tFire | 22 |
| `M` | mine drop | mineSeq, x, z, tDrop | 18 |
| `H` | my shot hit | shotSeq, victimSlot, dmg, x, z | 16 |
| `T` | I triggered a mine | ownerSlot, mineSeq | 6 |
| `B` | bump impulse | otherSlot, jx, jz (cm/s) | 11 |
| `K` | lap done | lap, tLap | 8 |
| `X` | finished | tFinish, hp, ammoF, ammoR, mines | 14 |
| `D` | wrecked | killerSlot or `-` | 4 |
| `R` | respawned (teleport: remotes snap) | x, z, yaw | 13 |
| `P` | pickup claim | idx | 4 |
| `Q` | shop request (lobby/shop only) | item, qty | 6 |
| `Y` | ready flag | 0/1 | 3 |

**Heartbeat** (`hb`):

```
hostId,seq,roomT,phase,race,of,track,laps,goAt,grid,finish,pickups,trainSeed
```

| Field | Chars |
| --- | --- |
| hostId | 13 |
| seq | 2 |
| roomT (ms) | 6 |
| phase (`L`/`C`/`R`/`F`/`X`/`S`/`E`) | 1 |
| race no. and championship length | 1 + 1 |
| track and laps | 1 + 1 |
| goAt | 6 |
| grid: IDs in slot order, `.`-joined | up to 83 |
| finish: `slot:tFinish` in order, `.`-joined | up to 41 |
| pickup bitmask | ≤ 4 |
| train seed | 2 |
| separators | 12 |

**About 110 bytes typical and 184 worst** *(M7: was 174; a track seed and the weapons switch added 10)*. At 2 Hz that's under 370 B/s.

**Presence** (`pr/<pid>`) is `name,colour,host,alive,ready,ver`, about 35 bytes.
**Ledger** (`ch`) has a header and one record per car: `id,name,pts,cash,hp,eng,tyr,arm,tur,front,rear,mines,wrecks,wins`.
That's about 58 bytes a car and **about 360 bytes for 6**, sent every 2 s or on change.
**Clock** ping and pong payloads are 6–12 bytes.

### 5.10 Bandwidth budget (6 cars racing)

| Flow | Per client | Room total at the broker |
| --- | --- | --- |
| Car state up (20 Hz, bursts to 30) | 1.6–2.4 KB/s | 10–15 KB/s in |
| Car state down (6 cars, own echo included) | 9.5–14 KB/s | 57–86 KB/s out |
| Heartbeat, presence, ledger, clock, events | ~1 KB/s | ~6 KB/s out |
| **Messages per second** | ~25 up / ~135 down | ~150 in / ~810 out |

Glitchburst's proven load was a 36 KB/s horde stream fanned out to 4 clients, about
144 KB/s out, and the public brokers carried it. **This room is at roughly half that.**
Per-connection publish rates (20–30 msg/s) match glitchburst's host.

There's headroom for one later optimisation. Moving to MQTT 5 and subscribing with
`noLocal` would drop the own-echo, which is 1/6 of the downstream. That's deferred until
all three brokers are verified on protocol v5. Glitchburst runs v4, and we start there.

A Node test asserts every codec's worst-case size against these numbers. Changing a
format then fails loudly instead of quietly eroding the budget.

---

## 6. Input

The glitchburst layer is ported, but its `Intent` becomes:

```ts
interface DriveIntent {
  throttle: number;   // 0..1
  brake: number;      // 0..1 (brake, then reverse once stopped)
  steer: number;      // -1..1
  handbrake: boolean;
  fireFront: boolean; // edge
  fireRear: boolean;  // edge (mine or rear missile, whichever is selected / available)
  turbo: boolean;     // held
}
```

| | Drive | Steer | Handbrake | Front | Rear | Turbo |
| --- | --- | --- | --- | --- | --- | --- |
| Keyboard | ↑/W, ↓/S | ←→ / AD (ramped, speed-sensitive) | Space | Z / J | X / K | Shift |
| Gamepad | RT / LT (analogue) | left stick | A | RB | LB | B |
| Touch | pedals, right thumb | left-thumb horizontal slider | button | button | button | button |

- **Keyboard steering** ramps in over about 120 ms and centres faster. Digital full lock
  at speed would spin the car.
- **Gamepad.** A per-axis 0.15 hardware drift floor, then a radial deadzone (ported).
  Triggers are read as `value || pressed`, and haptics fire on hits, landings, wrecks
  and the GO. Menus use the ported spatial `GamepadNavigator` and the on-screen keyboard.
- **Touch.** A left-thumb steering zone with a floating origin. The right side holds
  gas/brake pedals and the handbrake, front, rear and turbo buttons. The layer exists
  only in game (the glitchburst mobile bug). The mobile suite hit-tests every button.
- Rear fire picks the rear missile if you have any and a mine otherwise. A settings
  toggle sets the preference.

---

## 6b. Console and handheld *(added after M2)*

**Targets:** Steam Deck (Chrome or Edge in Gaming Mode, 1280×800, controls plus a
touchscreen), Xbox Series and One (Edge), and PlayStation (its built-in browser).
The game has to be fully playable from a controller alone: no mouse, no keyboard, no
pointer emulation. glitchburst was tuned for the same three devices, and most of what
follows is ported from it.

| Requirement | How |
| --- | --- |
| **Every screen works from the pad** | The ported spatial `GamepadNavigator` drives every menu. D-pad or left stick moves the focus ring, A/✕ selects, B/○ backs out. Dropdowns cycle in place, because a native `select` popup is browser chrome a pad cannot reach. The ring is confined to the topmost open overlay. |
| **Text entry without a keyboard** | An on-screen keyboard (ported) for the name and the room code, which are the game's front door in M3. It is ordinary buttons in a grid, so the navigator needs no special code. |
| **Focus lock** | Xbox Edge and the PlayStation browser only route pad input to a page while it holds focus. When a pad is present, the menu shows "Press Menu / Options to lock the controller to this window". That button goes fullscreen and pulls focus back (ported `lockFocus`). |
| **Start / Options in a race** | Opens the in-race menu: Resume, Settings, Leave. In a solo race it **pauses** the world. In a multiplayer race it **cannot**, since nobody can pause a PvP race for everyone else, so the car is held on brakes while the menu is up and the menu says so. |
| **Button prompts match the pad** | Detected from the Gamepad API `id`: Xbox (`045e`, "Xbox"), PlayStation (`054c`, "DualSense", "Wireless Controller"), Steam Deck (`28de`, "Steam Deck"). Hints show A/B/X/Y, ✕/○/□/△, or the Deck's A/B/X/Y and L/R labels. Keyboard hints show when no pad is present. |
| **Triggers** | Read as `value` with `pressed` as a fallback, because pads and firmwares disagree about which one analogue triggers set (ported). |
| **Haptics** | Dual-rumble through the Gamepad Haptics API on landings, crashes, hits and GO, off in settings (built in M1). |
| **Steam Deck** | The HUD, lobby and results are laid out for 1280×800 and checked at that size in tests. Default graphics is **Medium** when the user agent or pad says Steam Deck. The touchscreen stays usable alongside the pad: most recent device wins. |

**Honest limits.** None of this can be tested on real hardware from the dev container.
The suite drives a virtual pad through a stubbed `navigator.getGamepads()` in headless
Chromium. PlayStation browser support depends on the console: its browser is limited
and not always reachable, so it is best effort. Xbox Edge and the Deck's Chromium are
the primary console targets.

**Tests (`gamepad.test.mjs`, built in M3, not M5):**
- The whole front end driven by a virtual pad only, with no click and no keypress:
  menu → quick race → Start opens the pause → resume → leave; name and room code
  typed on the on-screen keyboard → lobby → start.
- Button prompts switch between Xbox, PlayStation and Deck glyphs from the pad `id`.
- At 1280×800, nothing on the lobby, HUD or results screens is clipped or covered.

## 7. HUD and UI (DOM overlay)

- **HUD.** Position (big), lap `2/4`, race time, last lap and best lap, speed, a
  segmented health bar, ammo icons with counts, the turbo meter, the countdown, WRONG
  WAY, a "respawning" notice, and the finish-order banner as cars cross the line.
- **Minimap.** The spline is drawn once to an offscreen canvas, then blitted each frame
  with car dots in player colours, the local car larger, and mines and the train.
- **Off-screen rival arrows.** Chevrons on an inset rectangle point at rivals in their
  colours, dimmed when a rival is wrecked. This is the ported `edgeMarkers` idea.
- **Screens.** Menu, lobby (roster with colour swatches, track and championship choice,
  bots fill, Start for the host), shop (cash, repair slider, ammo, upgrade tiers with
  the next price), race results, championship table and summary, settings (quality,
  volumes, controls, reduce motion, touch layout), and room full.

---

## 8. Audio (`src/audio/`)

- **Engine.** Per car, two detuned sawtooth or pulse oscillators with a lowpass, pitch
  from RPM (derived from speed and a gear curve) and filter cutoff from throttle. Remote
  cars are attenuated by distance, and only the nearest 3 are voiced.
- **Sound effects.** Tyre squeal (band-passed noise gated by slip), missile launch and
  whoosh, explosion (noise plus a sine drop), mine arm blip and proximity beeps, a crash
  thud scaled by impact, countdown beeps, the level-crossing bell and train horn, and
  shop blips. Everything is rate-limited, as in glitchburst.
- **Music.** Original driving synth patterns on the lookahead scheduler (25 ms timer,
  150 ms horizon), with separate race and shop cues. The volume curve is squared, and
  mute builds no oscillators. Both are ported.

---

## 9. Tests

`npm test` runs `build` and then every suite. Browser suites use the glitchburst rig:
a generated `test/rig/index.html` whose import map points at a local `three` and the
loopback MQTT stub, served over HTTP, with Chromium on SwiftShader. A `?quality=potato`
flag (no shadows, pixel ratio 0.5, 400×300) keeps multi-tab runs affordable. Assertions
poll for outcomes and never sleep for a fixed time.

| Suite | Runs in | Covers |
| --- | --- | --- |
| `sim.test.mjs` | Node | physics (acceleration, top speed, surface grip ordering, handbrake yaw, airborne no-steer, landing), **no tunnelling at 5× top speed on every wall of every track**, frame-chunking determinism (the same inputs over 1×60 steps and 60×1 give an identical state), track validation, laps and checkpoints (can't be farmed by reversing), wrong way, stuck and off-course respawn, weapons determinism across two Worlds, mine arming, **autopilot completes a clean lap on every track** within a par time, economy table invariants, championship ledger |
| `net.test.mjs` | Node | **every codec's round trip and worst-case byte size**, truncation tolerance, timestamp wrap, dead-reckoning error bounds on recorded laps through a jittery and lossy link, clock-sync convergence and failover continuity, and a **multi-client room with an in-memory broker and a fake clock**: election, 7th client backs out, split brain healing over presence, frozen-tab wake, host failover mid-race with bots adopted, finish order by timestamp, pickup first-claim, ledger purchase validation |
| `smoke.test.mjs` | browser, 1 tab | boot, menus, settings persistence, drive a lap on autopilot, **occlusion pixel test**, draw-call budget per track, camera lead and shake, quality auto-drop, hidden-tab worker ticker holds 20 Hz |
| `multiplayer.test.mjs` | browser, 2–3 tabs | two clients race to the finish, both see the same finish order, A fires and B's health drops on both screens, mine trigger removes the mine everywhere, bump without a position snap, **failover mid-race** (close the host tab and the race completes), **a late joiner lands in the lobby** and spectates, then joins the next race, **a frozen tab** (CDP `Page.setWebLifecycleState: frozen`) wakes without splitting the room, and the shop round trip |
| `gamepad.test.mjs` (M3), `mobile.test.mjs` (M5) | browser | the whole front end by virtual pad only (see §6b), and by touch only on an emulated phone, with hit-tests for nothing invisible covering buttons |

The biggest change from glitchburst is that `net/` gets a **fake `Clock`** injected in
place of `window.setInterval` and `performance.now()`. Glitchburst's frozen-tab test had
to reach into private fields and backdate them. Here the Node suite can advance time by
60 s in one call and test the election, timeouts, and a 7-client overflow in
milliseconds. The browser suite then proves the same behaviour end to end with a real
freeze.

`test/consistency.mjs` is ported. It checks that the README test count matches the
suites and that the version span matches `package.json`.

---

## 10. Milestones

Each one is playable, tested and pushed before the next starts. Every milestone updates
the README with the *why* and any bugs the tests caught.

**M1 — One car, one 3D track.**
Scaffold: `package.json`, `tsconfig`, import map, version hook, CI, and the rig with the
local three and the MQTT stub. Then `sim/track` with the downtown data, `car.ts`,
`collide.ts` and `surfaces.ts`. On the render side: road mesh, chunked instanced
downtown scenery, car mesh, camera rig with lead, zoom, FOV and shake, the dithered
cut-away, the following shadow camera, fog, and quality presets. Input for keyboard,
pad and touch. Free drive.
*Done when* you can drive downtown at 60 fps on a laptop, towers lean with parallax, the
car never disappears behind a tower, and `sim` (physics, tunnelling, determinism, track
validation) plus `smoke` (boot, occlusion pixel test, draw-call budget) are green.

**M2 — Racing against bots, offline.**
`race.ts` with checkpoints, laps, wrong way and respawn. Room-time stamps (local clock
for now). `racingLine.ts` and `autopilot.ts`. The countdown. The HUD with position,
laps, times, speed and minimap. Results screen. Single-player races against local bots.
*Done when* the autopilot laps downtown cleanly under par in Node, and a browser smoke
test finishes a 2-lap race on autopilot.

**M3 — MQTT rooms, 6 cars.**
Ported `MqttNet` and `RoomSession` with clock injection, lobby, colours, `ClockSync`,
the car codec, `deadReckoning`, `RaceNet`, and `HostRace` phases, grid, finish order,
bots on the host and failover adoption. Also room full, late-joiner spectating and the
worker ticker. (Off-screen rival arrows landed early, in M2.) **Plus the console and
handheld work in §6b:** on-screen keyboard, focus lock, Start/Options menu (pausing
solo races), pad-matched button prompts, the 1280×800 Deck layout, and the
`gamepad.test.mjs` suite.
*Done when* `net.test`, `multiplayer.test` and `gamepad.test` are green (race, failover
mid-race, late joiner, frozen tab, overflow; the whole flow by pad only) and 6 cars
(humans plus bots) race on a public broker inside the §5.10 budget, with the budget
measured and written up in the README.

**M4 — Weapons, damage and respawn.** *(built)*
`weapons.ts` with front and rear missiles and mines, hit, mine and bump events, damage,
wreck and respawn, ghost time, and effects (trails, explosions, sparks, smoke, mine
lights). Haptics.
*Done when* the determinism, dedupe and bump tests are green and the two-client weapon
tests pass.

**M5 — More tracks, hazards, audio and polish.** *(built)*
Greenbelt and Tidewater Docks, the host-timed train and crossing, oil, water and dirt
zones, the engine and SFX synth, music, the mobile suite, a performance
pass on a real iGPU, and a super-weapon design pass.
*Done when* the autopilot laps every track in Node, the train is identical across two
clients to within one frame, and every suite is green.
*(As built:*
- *the performance pass on a real iGPU can't be done from the dev container, so it
  isn't claimed. What is checked is that every track stays inside the 150 draw-call
  budget on High, in the browser suite;*
- *the train agrees across clients to the metre in a network test;*
- *the pause menu gained Settings, with the volume sliders, at the player's request.)*

**M6 — Car customisation: liveries and body styles** *(added after M3; see §4.5b)* *(built)*.
Five procedural body styles, stripe patterns, stripe and rim colours, and race numbers.
Also the `look` field on presence and its sanitiser, bot looks from the room seed, the
Garage screen (pad-driven, and fitting the Deck), and look icons in the lobby roster. The
look is cosmetic only: handling and the collision capsule are the same for every body.
*Done when* the following are green:
- the codec round-trip and malformed-look fallback in `net.test`;
- a sim check that every body fits the shared capsule and the triangle budget;
- a `smoke` pixel test that a stripe renders and each body builds without errors;
- `gamepad.test` covering the Garage by pad alone, and at 1280×800;
- `multiplayer.test` showing that a second tab sees your body, stripe and number.

**M7 — Track of the day, hotlaps, and a race-only mode** *(added after M3)* *(built)*.
Build it in this order:

1. **Track of the day.** A track generated from a seed, and the day's seed derived
   from the UTC date: `seed = hash("YYYY-MM-DD")`. The generator is pure and
   deterministic:
   - integer maths and its own PRNG, with no `Math.random` and no date or locale
     formatting that could differ between machines;
   - it produces an ordinary `TrackDef` (control points, width, checkpoints, a ramp or
     two, a theme and a scenery mix), so everything downstream just works: the
     collision walls, the racing line, the bots and the renderer;
   - a candidate must pass the existing track validation (the corner radius against
     the wall offset, no self-crossing, a lap length within limits, the grid on the
     road). If it fails, the generator retries from the next derived seed, and the
     number of retries is part of the determinism.

   *(Follow-up, built.)* The first generator only drew loose stars, so seeded tracks
   were all round. A seed now draws one of three layouts before any candidate: a
   **flowing loop**; a **city grid** of notched rectangles with tight right angles,
   like Downtown and the Docks; or **long straights**, with hairpins and kinks. Each
   gets a third of the seeds, and a failed candidate retries in the same layout. This
   changed every seed's track, including the track of the day, so the pinned hashes
   were re-pinned on purpose. Hotlap records for seeds from before the change no
   longer match their tracks.

   Any seed can be typed in, as a short word or number, so a track can be shared by
   name. In a room, the host's heartbeat carries the seed instead of a track index.
   Tests:
   - the same seed gives a byte-identical `TrackDef` in Node and in the browser;
   - a stored table of seeds pins the exact output, so a change to the generator can't
     silently change yesterday's track;
   - a thousand seeds all validate and are lapped by the autopilot inside a time
     limit;
   - two tabs on different clocks agree on today's track at UTC midnight.
2. **Hotlap** replaces *Free drive*. You drive alone on the chosen track (the track of
   the day, a built-in track, or a seed you enter) for as many laps as you like, with no
   bots and no weapons. The HUD shows the current lap against your best, with a live
   split at each checkpoint. Your best lap per track or seed is kept in
   `localStorage`, for bragging rights. (A shared leaderboard would need a server or
   the public broker's retained messages, so it's left for later.) An optional ghost of
   your best lap, replayed from recorded poses, is a stretch goal.
3. **Race only.** A lobby and Quick-race option that turns weapons off for the race
   (`World` already supports `weapons: false`). Mines and missiles are neither
   allowed nor drawn, and the HUD hides the ammo. It rides in the heartbeat, so every
   client agrees.

*Done when* the generator tests above are green, a hotlap on today's track records and
reloads a best lap, and a race-only room races with no weapon events on the wire.
*(As built:*
- *the corners are integers from an integer-trig table, and the scenery scatter and
  fillet maths run on those same integers in every engine. The tests pin the
  `TrackDef` bytes, which is what decides the track;*
- *the autopilot laps a hundred generated seeds cleanly, rather than a thousand, to
  keep CI quick; all thousand are validated;*
- *the ghost of your best lap stays a stretch goal.)*

**M8 — Shop, upgrades and the championship** *(deferred: moved to the end after M4; it may be dropped to keep the game simple)*.
`economy.ts`, `championship.ts`, the host ledger, shop UI, upgrades feeding physics,
reverse-order grids, the summary screen, and bot shopping.
*Done when* the ledger survives host failover in tests and a 3-race championship with
bots plays through.

**M9 — Built-in tracks shaped like real circuits** *(added after M7; future)*.
Twenty-one more built-in tracks, each a recognisable outline of a real circuit:

| Europe | Americas | Rest of the world |
| --- | --- | --- |
| Circuit de Spa-Francorchamps | Indianapolis Motor Speedway | Suzuka Circuit |
| Autodromo Nazionale Monza | Daytona International Speedway | Mount Panorama Circuit |
| Circuit de Monaco | WeatherTech Raceway Laguna Seca | Yas Marina Circuit |
| Silverstone Circuit | Sebring International Raceway | |
| Circuit de la Sarthe | Road America | |
| Brands Hatch (Grand Prix) | Watkins Glen International | |
| Brands Hatch (Indy) | Circuit Gilles Villeneuve | |
| Hockenheimring | Autódromo José Carlos Pace (Interlagos) | |
| Red Bull Ring | | |
| Circuit de Barcelona-Catalunya | | |

They are ordinary `TrackDef`s, fillet polygons like Downtown, so everything downstream
works unchanged: walls, racing line, bots, minimap and preview.

- **Authoring.** Trace each layout as a list of points from a public circuit map,
  then run it through a small script that:
  - scales it;
  - snaps it to whole metres;
  - fits each corner's radius to its edges (`fit` from the generator);
  - runs `validateTrack`;
  - prints the `TrackDef`.

  Hand-tune afterwards. The data files stay pure data.
- **Scale is the hard part.** Real laps run from about 1.9 km (Brands Hatch Indy) to
  13.6 km (la Sarthe); the arcade lap is 1.2–1.8 km. A uniform scale down to 1.8 km
  shrinks Spa by 4× and la Sarthe by 7.5×, and their small corners fall below the
  minimum radius. So, per track:
  - keep the signature corners at a drivable radius (Eau Rouge, Parabolica, the
    Loews hairpin, Maggotts–Becketts, the Esses, 130R, the Corkscrew, the Mulsanne
    chicanes);
  - merge wiggles that are too small to drive;
  - allow a *grand* lap limit (say up to 2.6 km) for the longest few, with fewer laps
    to match.

  The test for each track is that it's recognisable side by side with its outline,
  not a surveyed copy.
- **Ovals.** Indianapolis and Daytona as bare ovals would be four corners and flat
  out, which suits weapons more than racing. Decide per track whether to use the oval
  or its road course (Indy's road course, Daytona's 24-hour layout). There's no
  banking: the world is flat apart from ramps.
- **No elevation.** Mount Panorama, Spa, Laguna Seca's Corkscrew and Road America are
  famous for their hills, and the engine has none. A crest can become a jump (a ramp)
  where it's safe.
- **Themes.** Each track gets the nearest existing theme: Monaco and Circuit Gilles
  Villeneuve the city, Spa and Mount Panorama parkland, Yas Marina city at dusk. A new
  theme (desert, or night) is a separate decision.
- **Names.** Circuit names and logos are trademarks. The tracks can be *shaped like*
  the real ones, but in-game names should be the game's own (e.g. "Ardennes" for Spa,
  "Royal Park" for Monza), perhaps with a small "inspired by" line. See §12.
- **The menu.** Twenty-four built-in tracks is too many for a flat dropdown. Group
  them ("Originals", "Real circuits", "Generated"), and let the preview show each
  shape before it's picked.
- **Order.** Build in batches of about five, each fully tested before the next: the
  compact road courses first (Brands Hatch ×2, the Red Bull Ring, Laguna Seca,
  Monaco), then the classic Grand Prix tracks, then the long ones and the ovals.

*Done when* every track passes `validateTrack`, the autopilot laps each one cleanly
within its par, the whole set loads within the draw-call budget, and a contact sheet
of the minimaps next to the reference outlines shows each is recognisable.

**M10 — Richer environments** *(added after M7)* *(built; see the README's *Places, not backdrops*)*.
Make the three settings feel like places. Start with a daytime city, then add props to
the parkland and the docks.

1. **The city by day.** A `day` theme beside `dusk`: a blue sky, a high sun with crisp
   shadows, lighter fog, street lamps off, and windows as glass rather than lit. It
   uses the same `city` scatter and the same buildings, so it's a theme, not a new
   track. Downtown can be raced at dusk or by day, and generated city tracks draw
   either. The theme table and the preview's style line gain the new entry.
2. **Parkland, as farmland.** New scatter rules and props:
   - ponds;
   - flower beds;
   - windmills, with turning sails;
   - barns, silos and a farmhouse;
   - a tractor and a combine harvester;
   - cows and sheep, grazing;
   - cornfields;
   - hay bales.

   Ponds are `water` rectangles, or a new round water shape, so a car that leaves the
   road into one is put back like at the docks. Fields and flowers are ground patches
   with low instanced stalks. The rest are low-poly models placed by rule, e.g.
   "a farm: a house, a barn, a silo and bales, 60 m clear of the road".
3. **Docks, as a working port.** New props:
   - cargo ships and yachts moored along the water;
   - gantry cranes over the quay (the existing cranes, extended);
   - forklifts and flatbed trucks;
   - pallets and wooden crates;
   - oil drums;
   - warehouses.

   Ships sit in the water rectangles, against the quay wall. Crates, pallets and drums
   scatter in yards between the container stacks.

Rules that hold throughout:
- **Scenery only.** Props sit behind the walls (or in the open parkland verge beyond
  the wall gaps) and don't collide. Making drums or bales knockable or explosive
  would be a gameplay change, decided separately.
- **Budgets.** Every new prop kind is one merged or instanced mesh per track, so the
  high preset stays within 150 draw calls and the smoke test keeps checking it.
  Animals and flowers thin out on the low presets, and potato drops them.
- **Tall things never hide a car.** Windmills, silos, cranes, ships and warehouses
  join the occlusion cut-away (§4.2), and the occlusion probe test covers them.
- **Deterministic.** Placement comes from the seeded scatter, so every client sees
  the same farm. Animation (sails, grazing) is visual only and runs on the local clock.
- **Generated tracks use them too**, so a seeded parkland track gets farms and a
  docks track gets ships.

*Done when* the day city, the farmland and the port each boot within the draw-call
budget on the high preset; the occlusion test passes with the new tall props; and
screenshots of each theme show the new props clear of the road.

---

## 11. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Public broker throttling at 6 × 20 Hz | Worst-case bytes are asserted in tests. The room is at about half of glitchburst's proven load. Fallback options are an adaptive 15 Hz when RTT or loss rises, and MQTT 5 `noLocal`. |
| Dead reckoning looks rubbery on sharp direction changes | The DR-threshold send makes updates denser exactly when the prediction breaks, and the correction is tested against recorded laps. |
| SwiftShader too slow for multi-tab Three.js tests | The `potato` quality flag, few tabs, and most multi-client logic runs in Node against the fake clock. |
| Buildings clip the camera or hide cars | The height cap (0.6 × camera height) and the cut-away with its pixel test. |
| iGPU frame budget | Chunked instancing, the draw-call test, shadow frustum snapping, quality auto-drop. |
| Train timing disagreeing across screens | It's derived from `(seed, goAt, roomTime)` with no train messages at all. A test compares two clients. |

---

## 12. Open questions

These have sensible defaults, so building can start on the defaults unless you say
otherwise.

1. **Repo name.** This repository is `Sheppio/nitro-carnage`. The brief says
   `nitrocarnage`. I'll use this repo as it is, keep `SLUG = 'nitrocarnage'` for storage
   keys and channel names, and serve from Pages at `/nitro-carnage/`. Rename the repo
   if you want the shorter URL.
2. **Camera orientation.** I've assumed fixed north-up, as in the original genre, where
   the car rotates on screen. The alternative is a chase-style camera that rotates with
   the car. North-up keeps the minimap and multiplayer readable.
3. **Damage carries between races.** I've assumed it does, with paid repairs, since
   that's the core shop loop. The alternative is resetting to full health each race.
4. **Wrecked cars respawn.** I've assumed a respawn after 2.5 s with 35 health, plus a
   bounty to the killer, rather than being out of the race.
5. **Own mines.** I've assumed they're harmless to you for their arming period and
   dangerous after it.
6. **Championship lengths.** I've assumed 3, 5 or 7 races, rotating through the
   unlocked tracks.
