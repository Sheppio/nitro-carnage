/**
 * Headless simulation suite. Runs in plain Node against the compiled `dist/`,
 * with no browser and no three.js: `sim/` and `input/sources` import neither,
 * and this suite is what keeps it that way.
 */
import { STEP, SIM } from '../dist/config.js';
import { createCar, stepCar, steerLimit, STOCK } from '../dist/sim/car.js';
import { Surface } from '../dist/sim/surfaces.js';
import { Track } from '../dist/sim/track/buildTrack.js';
import { closestSegSeg, resolveCarPair } from '../dist/sim/collide.js';
import { CAR_SHAPE } from '../dist/sim/car.js';
import { createLapState, stepLaps, standings, displayLap, WRONG_WAY_AFTER } from '../dist/sim/race.js';
import { racingLine, DEFAULT_LINE } from '../dist/sim/racingLine.js';
import { SKILLS } from '../dist/sim/autopilot.js';
import { STUCK_RESPAWN, GHOST_TIME } from '../dist/sim/World.js';
import { TRACKS } from '../dist/sim/track/index.js';
import { World } from '../dist/sim/World.js';
import { interpolateCar } from '../dist/sim/interpolate.js';
import { resolveColours, PALETTE } from '../dist/sim/palette.js';
import { applyDeadzone1, filterAxis } from '../dist/input/sources.js';
import { mulberry32, wrapAngle, smoothing } from '../dist/util.js';
import { Armoury, castRay, missileAt } from '../dist/sim/weapons.js';
import { trainAt, crossingBlocked, crossingWarning, trainSegment } from '../dist/sim/train.js';
import { generateTrack, seedOf, daySeed, utcDay, trackName, attemptsFor } from '../dist/sim/track/generate.js';
import { validateTrack } from '../dist/sim/track/validate.js';
import { LapTrace, ghostAt, validTrace, GHOST_HZ } from '../dist/sim/ghost.js';
import { SEED_WORDS, randomSeedText } from '../dist/sim/track/seedWords.js';
import { hashString } from '../dist/util.js';

let pass = 0;
let fail = 0;
function check(label, ok, note = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${note ? ` — ${note}` : ''}`);
  ok ? pass++ : fail++;
}

/**
 * A check run once per track, from inside a loop over TRACKS. Named apart so
 * `consistency.mjs` can count it once per track rather than once.
 */
const tcheck = check;

const intent = (o = {}) => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, fireFront: false, fireRear: false, turbo: false, ...o });

/** A flat, wall-less world of one surface, for physics that should not depend on a track. */
class OpenGround {
  constructor(surface = Surface.Tarmac, ground = () => 0) {
    this.surface = surface;
    this.ground = ground;
    this.walls = new Float64Array(0);
  }
  forWallsNear() {}
  surfaceAt() { return this.surface; }
  groundAt(x, z) { return this.ground(x, z); }
  project() { return { i: 0 }; }
}

const speed = (c) => Math.hypot(c.vx, c.vz);

/** Drive a car with a fixed intent until `stop` says so or `max` seconds pass. */
function run(car, env, what, stop, max = 30) {
  let t = 0;
  while (t < max) {
    stepCar(car, typeof what === 'function' ? what(car, t) : what, env, STEP);
    t += STEP;
    if (stop(car, t)) break;
  }
  return t;
}

/** A simple centreline follower, good enough to get round a track in tests. */
function follower(track, entrant, grip = 11) {
  return () => {
    const c = entrant.car;
    const p = track.project(c.x, c.z, c.hint);
    const v = speed(c);
    const look = track.poseAt(p.s + 6 + v * 0.35);
    const d = wrapAngle(Math.atan2(look.x - c.x, look.z - c.z) - c.yaw);
    let kmax = 0;
    for (let a = 0; a < 40 + v; a += 2) kmax = Math.max(kmax, Math.abs(track.line.curvature[Math.floor(track.wrapS(p.s + a))]));
    const vt = Math.sqrt(grip / Math.max(kmax, 1e-4));
    return intent({ steer: Math.max(-1, Math.min(1, -d * 3)), throttle: v < vt ? 1 : 0, brake: v > vt + 2 ? 1 : 0 });
  };
}

/* ------------------------------------------------------------------ tracks */

console.log('\nsim.test\n\ntracks');

for (const def of TRACKS) {
  const t = new Track(def);
  const name = def.name;

  tcheck(`${name}: lap length is a short arcade circuit (1.2-1.8 km)`, t.length > 1200 && t.length < 1800, `${t.length.toFixed(0)} m`);

  let minR = Infinity;
  for (let i = 0; i < t.n; i++) {
    const k = Math.abs(t.line.curvature[i]);
    if (k > 1e-6) minR = Math.min(minR, 1 / k);
  }
  tcheck(`${name}: tightest corner leaves room for the inside wall`, minR > t.wallOffset + 1,
    `min radius ${minR.toFixed(1)} m vs wall offset ${t.wallOffset} m`);

  // No wall segment crosses a non-adjacent one: a folded inside wall would.
  let crossings = 0;
  const w = t.walls;
  const tmp = { ax: 0, az: 0, bx: 0, bz: 0 };
  for (let a = 0; a < t.wallCount; a++) {
    const o = a * 6;
    t.forWallsNear(Math.min(w[o], w[o + 2]), Math.min(w[o + 1], w[o + 3]), Math.max(w[o], w[o + 2]), Math.max(w[o + 1], w[o + 3]), (b) => {
      if (b <= a) return;
      const p = b * 6;
      const shares = [w[o], w[o + 2]].some((x, i) => [w[p], w[p + 2]].some((y, j) => Math.abs(x - y) < 1e-9 && Math.abs(w[o + 1 + i * 2] - w[p + 1 + j * 2]) < 1e-9));
      if (shares) return;
      if (closestSegSeg(w[o], w[o + 1], w[o + 2], w[o + 3], w[p], w[p + 1], w[p + 2], w[p + 3], tmp) < 1e-6) crossings++;
    });
  }
  tcheck(`${name}: no wall crosses another`, crossings === 0, `${crossings} crossings among ${t.wallCount} segments`);

  // The road is clear: every centreline sample sits a full wall offset from every wall.
  let tightest = Infinity;
  for (let i = 0; i < t.n; i++) {
    const x = t.line.px[i], z = t.line.pz[i];
    t.forWallsNear(x - 12, z - 12, x + 12, z + 12, (k) => {
      const o = k * 6;
      const d2 = closestSegSeg(x, z, x, z, w[o], w[o + 1], w[o + 2], w[o + 3], tmp);
      tightest = Math.min(tightest, Math.sqrt(d2));
    });
  }
  tcheck(`${name}: centreline stays a wall offset from every wall`, tightest > t.wallOffset - 0.3,
    `closest ${tightest.toFixed(2)} m`);

  const rand = mulberry32(7);
  let worstS = 0;
  let worstD = 0;
  for (let k = 0; k < 400; k++) {
    const s = rand() * t.length;
    const d = (rand() * 2 - 1) * t.halfWidth;
    const pose = t.poseAt(s);
    const [x, z] = t.offsetPoint(pose.i, d);
    const p = t.project(x, z);
    worstS = Math.max(worstS, Math.abs(t.deltaS(pose.i * (t.length / t.n), p.s)));
    worstD = Math.max(worstD, Math.abs(p.d - d));
  }
  tcheck(`${name}: projection recovers s and d anywhere on the road`, worstS < 0.6 && worstD < 0.3,
    `worst s error ${worstS.toFixed(2)} m, d error ${worstD.toFixed(2)} m`);

  const cps = t.checkpoints;
  tcheck(`${name}: checkpoints are ordered inside the lap`, cps.length > 0 && cps.every((s, i) => s > 0 && s < t.length && (i === 0 || s > cps[i - 1])));

  const start = t.project(def.start[0], def.start[1]);
  tcheck(`${name}: s = 0 is at the start line`, Math.min(start.s, t.length - start.s) < 1, `start projects to s=${start.s.toFixed(2)}`);

  const again = new Track(def);
  tcheck(`${name}: scenery is deterministic from the seed`, JSON.stringify(again.props) === JSON.stringify(t.props), `${t.props.length} props`);

  // Footprint corners, turned by the prop's yaw (containers lie either way).
  const corners = (p) => [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]].map(([a, b]) => {
    const lx = (a * p.w) / 2, lz = (b * p.d) / 2;
    const c = Math.cos(p.rot), sn = Math.sin(p.rot);
    return [p.x + lx * c + lz * sn, p.z - lx * sn + lz * c];
  });
  const solid = t.props.filter((p) => p.kind === 'tower' || p.kind === 'container');
  const intrusions = solid.filter((p) => corners(p).some(([x, z]) => Math.abs(t.project(x, z).d) < t.wallOffset));
  tcheck(`${name}: no building or container stands on the road`, intrusions.length === 0, `${intrusions.length} of ${solid.length} intruding`);
  const onRail = t.props.filter((p) => p.kind !== 'crane' && t.railDistance(p.x, p.z) < 4);
  const wet = t.props.filter((p) => p.kind !== 'crane' && t.inWater(p.x, p.z));
  tcheck(`${name}: nothing stands on the railway or in the water`, onRail.length === 0 && wet.length === 0, `${onRail.length} on the rails, ${wet.length} in the water`);

  // The railway, if any, crosses the road exactly once: count the entries into the road along it.
  let entries = 0;
  if (t.rail) {
    let inRoad = false;
    for (let u = 0; u <= t.rail.length; u += 0.5) {
      const now = Math.abs(t.project(t.rail.ax + t.rail.dx * u, t.rail.az + t.rail.dz * u).d) < t.wallOffset;
      if (now && !inRoad) entries++;
      inRoad = now;
    }
  }
  tcheck(`${name}: a railway crosses the road exactly once`, !t.rail || entries === 1, t.rail ? `${entries} crossings` : 'no railway');

  // An open verge really is open: no wall on that side within the gap.
  let walled = 0;
  for (const g of def.wallGaps ?? []) {
    const side = g.side === 'left' ? 1 : -1;
    for (let f = g.from + 0.005; f < g.to - 0.005; f += 0.005) {
      const pose = t.poseAt(f * t.length);
      const [x, z] = t.offsetPoint(pose.i, side * t.wallOffset);
      t.forWallsNear(x - 0.5, z - 0.5, x + 0.5, z + 0.5, () => walled++);
    }
  }
  tcheck(`${name}: an open verge has no wall`, walled === 0, `${(def.wallGaps ?? []).length} gaps`);

  const slots = [0, 1, 2, 3, 4, 5].map((k) => t.gridSlot(k));
  const onRoad = slots.every((p) => Math.abs(t.project(p.x, p.z).d) < t.halfWidth - 1);
  const behind = slots.every((p) => t.deltaS(0, t.project(p.x, p.z).s) < 0);
  let minGap = Infinity;
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) minGap = Math.min(minGap, Math.hypot(slots[a].x - slots[b].x, slots[a].z - slots[b].z));
  tcheck(`${name}: six grid slots on the road, behind the line, not touching`, onRoad && behind && minGap > 4.5, `closest pair ${minGap.toFixed(1)} m`);
}

/* --------------------------------------------------------------- physics */

console.log('\ncar physics');

{
  const car = createCar(0, 0, 0);
  const t = run(car, new OpenGround(), intent({ throttle: 1 }), (c) => speed(c) >= 100 / 3.6);
  check('0-100 km/h in 2.8-4.2 s', t > 2.8 && t < 4.2, `${t.toFixed(2)} s`);

  run(car, new OpenGround(), intent({ throttle: 1 }), () => false, 40);
  const top = speed(car);
  check('top speed around 48 m/s (44-52)', top > 44 && top < 52, `${top.toFixed(1)} m/s, ${(top * 3.6).toFixed(0)} km/h`);

  run(car, new OpenGround(), intent({ throttle: 1, turbo: true }), () => false, 3);
  check('turbo pushes past the normal top speed', speed(car) > top + 3, `${speed(car).toFixed(1)} m/s`);
  check('turbo drains while used', car.turbo < SIM.car.turboCapacity - 2.5, `${car.turbo.toFixed(2)} s left`);
}

{
  const car = createCar(0, 0, 0);
  car.vz = 40;
  const z0 = car.z;
  run(car, new OpenGround(), intent({ brake: 1 }), (c) => speed(c) < 0.5);
  const dist = car.z - z0;
  check('braking from 40 m/s stops within 70 m', dist < 70 && dist > 20, `${dist.toFixed(1)} m`);
}

{
  const car = createCar(0, 0, 0);
  run(car, new OpenGround(), intent({ brake: 1 }), () => false, 8);
  check('holding brake at a standstill reverses, at a capped speed', car.forward < -8 && car.forward > -SIM.car.reverseTopSpeed - 0.5,
    `${car.forward.toFixed(1)} m/s`);
}

check('steering lock tightens with speed', steerLimit(0) > steerLimit(20) && steerLimit(20) > steerLimit(45),
  `${steerLimit(0).toFixed(2)} / ${steerLimit(20).toFixed(2)} / ${steerLimit(45).toFixed(2)} rad`);

/**
 * How hard a car can corner on one surface: the rate the *velocity* turns,
 * times speed, averaged over two seconds at full lock from 20 m/s. Not the
 * yaw rate — a car spinning on oil has plenty of that while going straight on.
 */
function cornering(surface) {
  const car = createCar(0, 0, 0);
  car.vz = 20;
  let heading = Math.atan2(car.vx, car.vz);
  let sum = 0;
  let n = 0;
  run(car, new OpenGround(surface), intent({ steer: 1, throttle: 0.4 }), (c) => {
    const h = Math.atan2(c.vx, c.vz);
    sum += (Math.abs(wrapAngle(h - heading)) / STEP) * speed(c);
    heading = h;
    n++;
    return false;
  }, 2);
  return sum / n;
}
{
  const g = [Surface.Tarmac, Surface.Dirt, Surface.Grass, Surface.Oil].map(cornering);
  check('grip order: tarmac > dirt > grass > oil', g[0] > g[1] && g[1] > g[2] && g[2] > g[3],
    g.map((x) => x.toFixed(1)).join(' > ') + ' m/s^2');
}

/**
 * A keyboard driver turning in: full right lock wound on over 0.14 s, held
 * for 1.5 s at a fixed throttle. Returns how far the velocity turned and the
 * peak body slip.
 */
function turnIn(v0, throttle) {
  const car = createCar(0, 0, 0);
  car.vz = v0;
  let steer = 0;
  let peak = 0;
  const h0 = Math.atan2(car.vx, car.vz);
  run(car, new OpenGround(), () => {
    steer = Math.min(1, steer + STEP / 0.14);
    return intent({ steer, throttle });
  }, (c) => {
    peak = Math.max(peak, Math.abs(c.slip));
    return false;
  }, 1.5);
  return { turned: Math.abs(wrapAngle(Math.atan2(car.vx, car.vz) - h0)), peak };
}

// Reported from the first playable build: the car pushed wide unless you were
// on the power, and on the power the tail came round and it spun.
{
  const worst = Math.max(...[15, 25, 35].map((v) => turnIn(v, 1).peak));
  check('full throttle through a corner slides the tail but never spins', worst < 0.55 && worst > 0.2,
    `peak slip ${worst.toFixed(2)} rad at 15-35 m/s`);
  // The push came from the counter-steer assist treating the ordinary slip of
  // every corner as a slide to catch, and winding off the lock you asked for.
  const car = createCar(0, 0, 0);
  car.vz = 25;
  let lowest = Infinity;
  run(car, new OpenGround(), intent({ steer: 1 }), (c, t) => {
    if (t > 0.3) lowest = Math.min(lowest, Math.abs(c.steer) / steerLimit(c.forward));
    return false;
  }, 1.2);
  // Not 100%: past 0.12 rad the assist is meant to act, and a hard corner
  // with the grip this car has gets there. The bug left 59%.
  check('an ordinary corner off the throttle keeps most of the lock the driver asked for', lowest > 0.75,
    `wheels at ${(lowest * 100).toFixed(0)}% of full lock at worst`);
}

// Follow-up report: "can I steer more before it understeers?" At 25-35 m/s
// on full lock the car turned at only 30% of the rate its wheels asked for.
{
  const achieved = (v) => {
    const car = createCar(0, 0, 0);
    car.vz = v;
    let steer = 0;
    let got = 0;
    let asked = 0;
    run(car, new OpenGround(), (c, t) => {
      steer = Math.min(1, steer + STEP / 0.14);
      if (t > 1) {
        got += Math.abs(c.w);
        asked += Math.abs((speed(c) * Math.tan(c.steer)) / (SIM.car.cgToFront + SIM.car.cgToRear));
      }
      return intent({ steer, throttle: 0.35 });
    }, () => false, 2);
    return got / asked;
  };
  const worst = Math.min(achieved(25), achieved(35));
  check('at speed, full lock turns the car at least 60% as hard as the wheels ask', worst > 0.6,
    `${(worst * 100).toFixed(0)}% at worst`);
}

{
  const drift = (handbrake) => {
    const car = createCar(0, 0, 0);
    car.vz = 22;
    let slip = 0;
    run(car, new OpenGround(), intent({ steer: 0.6, handbrake }), (c) => {
      slip = Math.max(slip, Math.abs(c.slip));
      return false;
    }, 1.2);
    return slip;
  };
  const without = drift(false);
  const withHb = drift(true);
  check('handbrake kicks the tail out', withHb > without * 1.5 && withHb > SIM.car.driftSlip,
    `peak slip ${without.toFixed(2)} -> ${withHb.toFixed(2)} rad`);
}

{
  const car = createCar(0, 0, 0);
  car.vz = 25;
  car.y = 4;
  car.airborne = true;
  car.w = 0.2;
  stepCar(car, intent({ steer: 1, throttle: 1 }), new OpenGround(), STEP);
  const w1 = car.w;
  const v1 = speed(car);
  stepCar(car, intent({ steer: -1, brake: 1 }), new OpenGround(), STEP);
  check('in the air, neither steering nor pedals do anything', Math.abs(car.w - w1) < 0.01 && Math.abs(speed(car) - v1) < 1e-6,
    `yaw rate ${w1.toFixed(3)} -> ${car.w.toFixed(3)}`);
  run(car, new OpenGround(), intent(), (c) => !c.airborne, 5);
  check('a jump comes down and is counted as a landing', car.landings === 1 && car.lastLanding > SIM.car.hardLandingSpeed,
    `landing impulse ${car.lastLanding.toFixed(1)} m/s`);
  check('a hard landing costs speed', speed(car) < 25 * (1 - SIM.car.hardLandingLoss) + 0.01, `${speed(car).toFixed(1)} m/s`);
}

{
  // A ramp in open ground: a wedge 1.4 m high over 14 m, then a drop.
  const ramp = (_x, z) => (z > 10 && z < 24 ? ((z - 10) / 14) * 1.4 : 0);
  const car = createCar(0, 0, 0);
  car.vz = 30;
  let peak = 0;
  run(car, new OpenGround(Surface.Tarmac, ramp), intent({ throttle: 1 }), (c) => {
    peak = Math.max(peak, c.y);
    return c.landings > 0;
  }, 5);
  check('a ramp launches the car and it lands again', car.landings === 1 && peak > 1.6, `peak height ${peak.toFixed(2)} m`);
}

{
  const car = createCar(0, 0, 0);
  const rand = mulberry32(99);
  let finite = true;
  run(car, new OpenGround(), () => intent({
    throttle: rand(), brake: rand() < 0.2 ? rand() : 0, steer: rand() * 2 - 1, handbrake: rand() < 0.1, turbo: rand() < 0.2,
  }), (c) => {
    finite = [c.x, c.z, c.vx, c.vz, c.w, c.yaw, c.y].every(Number.isFinite);
    return !finite;
  }, 60);
  check('a minute of random inputs never produces NaN', finite);
}

/* ------------------------------------------------------------- collisions */

console.log('\ncollisions');

for (const def of TRACKS) {
  const t = new Track(def);
  const w = t.walls;
  const fast = SIM.car.topSpeed * 5;
  let escaped = 0;
  let tried = 0;
  for (let k = 0; k < t.wallCount; k += 5) {
    const o = k * 6;
    const mx = (w[o] + w[o + 2]) / 2, mz = (w[o + 1] + w[o + 3]) / 2;
    const nx = w[o + 4], nz = w[o + 5];
    // Which side of the road this wall is on: escaping means ending up behind
    // *it*. (A car that bounces back across the road and out through an open
    // quay on the far side has not tunnelled through anything.)
    const side = Math.sign(t.project(mx, mz).d);
    // Start 3 m inside the wall, pointed straight at it at five times top speed.
    const car = createCar(mx + nx * 3, mz + nz * 3, Math.atan2(-nx, -nz));
    car.vx = -nx * fast;
    car.vz = -nz * fast;
    car.hint = t.project(car.x, car.z).i;
    tried++;
    for (let s = 0; s < 20; s++) {
      stepCar(car, intent({ throttle: 1 }), t, STEP);
      const d = t.project(car.x, car.z, car.hint).d;
      if (Math.sign(d) === side && Math.abs(d) > t.wallOffset + 0.05) {
        escaped++;
        break;
      }
    }
  }
  tcheck(`${def.name}: no tunnelling at 5x top speed into any wall`, escaped === 0, `${escaped} of ${tried} escaped at ${fast} m/s`);
}

{
  const t = new Track(TRACKS[0]);
  // Hit a wall head on at 30 m/s: the car bounces, loses most of its speed, and the impact is recorded.
  const o = 0;
  const w = t.walls;
  const mx = (w[o] + w[o + 2]) / 2, mz = (w[o + 1] + w[o + 3]) / 2;
  const nx = w[o + 4], nz = w[o + 5];
  const car = createCar(mx + nx * 4, mz + nz * 4, Math.atan2(-nx, -nz));
  car.vx = -nx * 30;
  car.vz = -nz * 30;
  car.hint = t.project(car.x, car.z).i;
  for (let s = 0; s < 30; s++) stepCar(car, intent(), t, STEP);
  const away = car.vx * nx + car.vz * nz;
  check('a head-on wall hit bounces back and is recorded', car.impacts > 0 && car.lastImpact > 25 && away > 0 && away < 12,
    `impact ${car.lastImpact.toFixed(1)} m/s, rebound ${away.toFixed(1)} m/s`);
}

/* ------------------------------------------------------------------ laps */

console.log('\nlaps and race order');

{
  const t = new Track(TRACKS[0]);
  const L = t.length;
  /** Drive a lap state along the track from s0 by `metres`, one metre per step. */
  const drive = (st, from, metres, laps = 3, t0 = 0) => {
    let time = t0;
    let ev = null;
    const dir = Math.sign(metres);
    for (let k = 1; k <= Math.abs(metres); k++) {
      time += STEP;
      const e = stepLaps(st, t, t.wrapS(from + dir * k), time, STEP, dir * 20, laps);
      if (e) ev = e;
    }
    return { time, ev };
  };

  let st = createLapState(t, L - 20, 0);
  drive(st, L - 20, 25);
  check('leaving the grid over the line starts lap 1 without counting a lap', st.completed === 0 && st.lapTimes.length === 0 && displayLap(st, 3) === 1);

  const lap = drive(st, 5, L);
  check('a full lap past every checkpoint counts, with its time', st.completed === 1 && st.lapTimes.length === 1 && lap.ev?.kind === 'lap',
    `lap time ${st.lapTimes[0]?.toFixed(2)} s`);

  // Skip a checkpoint by teleporting past it: the line then does not count.
  st = createLapState(t, L - 20, 0);
  drive(st, L - 20, 25);
  const cp0 = t.checkpoints[0];
  stepLaps(st, t, cp0 + 30, 1, STEP, 20, 3, true);
  drive(st, cp0 + 30, L - cp0 - 25);
  check('a lap that missed a checkpoint does not count', st.completed === 0, `completed ${st.completed}`);

  // Back and forth over the line.
  st = createLapState(t, L - 20, 0);
  drive(st, L - 20, 25);
  drive(st, 5, L);
  const before = st.completed;
  for (let k = 0; k < 3; k++) {
    drive(st, t.wrapS(5 + L), -12);
    drive(st, t.wrapS(5 + L - 12), 12);
  }
  check('reversing over the line and back again gains nothing', st.completed === before, `${before} -> ${st.completed}`);

  st = createLapState(t, L - 20, 0);
  drive(st, L - 20, 25);
  drive(st, 5, cp0 + 5 - 5);
  const passed = st.nextCp;
  drive(st, cp0 + 5, -10);
  check('reversing back over a checkpoint un-passes it', passed === 1 && st.nextCp === 0);

  // Sub-step timing: cross the line exactly a quarter of the way through a step.
  st = createLapState(t, L - 20, 0);
  drive(st, L - 20, 25);
  drive(st, 5, L - 6);
  const sBefore = t.wrapS(L - 0.75);
  stepLaps(st, t, sBefore, 50, STEP, 20, 3);
  const at = 50 + STEP;
  stepLaps(st, t, t.wrapS(0.25 + 2), at, STEP, 20, 3);
  const expect = at - STEP + STEP * (0.75 / 3);
  check('lap times are interpolated inside the step', Math.abs(st.lapStart - expect) < 1e-9, `${st.lapStart.toFixed(5)} vs ${expect.toFixed(5)}`);

  st = createLapState(t, 100, 0);
  let wrong = false;
  for (let k = 0; k < Math.ceil(WRONG_WAY_AFTER / STEP) + 2; k++) stepLaps(st, t, t.wrapS(100 - k * 0.1), k * STEP, STEP, -5, 3);
  wrong = st.wrongWay;
  stepLaps(st, t, 99, 9, STEP, 5, 3);
  check('driving backwards shows WRONG WAY, and driving on clears it', wrong && !st.wrongWay);

  // Order: finishers by time, the rest by distance; ties by id.
  const mk = (id, finishTime, progress) => ({ id, lap: { finishTime, progress } });
  const order = standings([mk('c', null, 900), mk('a', 120, 3000), mk('d', null, 950), mk('b', 118, 3000), mk('e', null, 950)]).map((e) => e.id);
  check('race order: finishers by time, then distance, ties by id', order.join('') === 'badec', order.join(''));

  // Respawned back behind the line it just crossed: no lap jump in the order.
  st = createLapState(t, L - 20, 0);
  drive(st, L - 20, 25);
  const p0 = st.progress;
  stepLaps(st, t, t.wrapS(-7), 3, STEP, 0, 3, true);
  check('a respawn behind the line moves a car back metres, not a lap', Math.abs(st.progress - (p0 - 12)) < 1e-6 && st.completed === 0,
    `progress ${p0.toFixed(1)} -> ${st.progress.toFixed(1)}`);
}

/* ----------------------------------------------------------- racing line */

console.log('\nracing line and autopilot');

for (const def of TRACKS) {
  const t = new Track(def);
  const line = racingLine(t);
  const inside = line.offset.every((o) => Math.abs(o) <= t.halfWidth - 1.6);
  tcheck(`${def.name}: the racing line stays on the road`, inside);

  // Cutting apexes: where the road bends hardest, the line sits on the inside.
  // "Hardest" relative to the track: Greenbelt has no corner under 40 m.
  let kMax = 0;
  for (let i = 0; i < t.n; i++) kMax = Math.max(kMax, Math.abs(t.line.curvature[i]));
  let sum = 0;
  let n = 0;
  for (let i = 0; i < t.n; i++) {
    const k = t.line.curvature[i];
    if (Math.abs(k) < Math.min(1 / 30, kMax * 0.8)) continue;
    sum += Math.sign(k) * line.offset[i];
    n++;
  }
  tcheck(`${def.name}: the line takes the inside of tight corners`, n > 0 && sum / n > 1.5, `mean ${(sum / n).toFixed(2)} m to the inside`);

  let worst = 0;
  const sp = t.length / t.n;
  for (let i = 0; i < t.n; i++) {
    const a = line.speed[i];
    const b = line.speed[(i + 1) % t.n];
    worst = Math.max(worst, (a * a - b * b) / (2 * sp));
  }
  tcheck(`${def.name}: the speed profile never asks for more braking than planned`, worst <= DEFAULT_LINE.braking + 1e-6, `${worst.toFixed(2)} m/s^2`);

  const w = new World(def, { laps: 2, countdown: 0 });
  const bot = w.addBot('b', 0, SKILLS[0], 1);
  while (!bot.lap.finished && w.steps < 60 * 400) w.step();
  const best = bot.lap.best ?? Infinity;
  // Par is the line's own ideal; on a track of long, fast sweepers a real car
  // on a real steering wheel gets within a few per cent of it, not under it.
  tcheck(`${def.name}: the autopilot laps cleanly, within 5% of par`, bot.lap.finished && bot.respawns === 0 && bot.car.impacts <= 1 && best < line.parTime * 1.05,
    `best ${best.toFixed(1)} s vs par ${line.parTime.toFixed(1)} s, ${bot.car.impacts} wall hits, ${bot.respawns} respawns`);
}

{
  const w = new World(TRACKS[0], { laps: 3, countdown: 3, weapons: false });
  for (let i = 0; i < 6; i++) w.addBot(`b${i}`, i, SKILLS[i], 100 + i);
  let finite = true;
  let hardBumps = 0;
  while (w.entrants.some((e) => !e.lap.finished) && w.steps < 60 * 900) {
    w.step();
    // Fast bots side by side through the kink do rub; a shunt is harder than that.
    for (const ev of w.drain()) if (ev.kind === 'bump' && ev.closing > 15) hardBumps++;
    if (!w.entrants.every((e) => Number.isFinite(e.car.x) && Number.isFinite(e.car.z))) finite = false;
  }
  const done = w.entrants.filter((e) => e.lap.finished).length;
  const respawns = w.entrants.reduce((a, e) => a + e.respawns, 0);
  const times = w.entrants.map((e) => e.lap.finishTime ?? Infinity);
  const ordered = standings(w.entrants).every((e, i, arr) => i === 0 || (arr[i - 1].lap.finishTime ?? 0) <= (e.lap.finishTime ?? 0));
  check('six bots race three laps: all finish, nobody respawns, no hard shunts', done === 6 && respawns === 0 && hardBumps === 0 && finite && ordered,
    `${done}/6 finished, spread ${(Math.max(...times) - Math.min(...times)).toFixed(1)} s, ${respawns} respawns, ${hardBumps} bumps over 15 m/s`);
}

{
  // Parked across the road facing a wall: the bot must back out and get going.
  const w = new World(TRACKS[0], { laps: 1, countdown: 0 });
  const bot = w.addBot('b', 0, SKILLS[0], 3);
  const pose = w.track.poseAt(300);
  const [x, z] = w.track.offsetPoint(pose.i, w.track.halfWidth + 1.5);
  Object.assign(bot.car, { x, z, yaw: pose.yaw + Math.PI / 2, vx: 0, vz: 0, w: 0, hint: pose.i });
  // One step to let the lap tracker catch up with the move, so the move itself is not counted.
  w.step();
  const p0 = bot.lap.progress;
  for (let k = 0; k < 60 * 12; k++) w.step();
  check('the autopilot backs out of a wall and drives on', bot.lap.progress - p0 > 40 && bot.respawns === 0,
    `${(bot.lap.progress - p0).toFixed(0)} m in 12 s, ${bot.respawns} respawns`);
}

/* ------------------------------------------------------------- race rules */

console.log('\nrace rules');

{
  const w = new World(TRACKS[0], { laps: 3, countdown: 3 });
  const bots = [0, 1, 2].map((i) => w.addBot(`b${i}`, i, SKILLS[0], i));
  const start = bots.map((b) => [b.car.x, b.car.z]);
  while (w.time < 2.9) w.step();
  const still = bots.every((b, i) => Math.hypot(b.car.x - start[i][0], b.car.z - start[i][1]) < 0.01);
  let go = false;
  while (w.time < 4.5) {
    w.step();
    if (w.drain().some((e) => e.kind === 'go')) go = true;
  }
  const moving = bots.every((b) => Math.hypot(b.car.vx, b.car.vz) > 3);
  check('nobody moves before the lights, everybody after', still && go && moving);
}

{
  // A human who drives into the wall and keeps the throttle pinned.
  const w = new World(TRACKS[0], { laps: 3, countdown: 0 });
  const pose = w.track.poseAt(200);
  const e = w.addCar('p', 0, () => intent({ throttle: 1 }));
  for (let k = 0; k < 60 * 2; k++) w.step();
  const safe = e.safeS;
  const [x, z] = w.track.offsetPoint(pose.i, w.track.halfWidth + 1.2);
  Object.assign(e.car, { x, z, yaw: pose.yaw + Math.PI / 2, vx: 0, vz: 0, w: 0, hint: pose.i });
  let respawnAt = null;
  for (let k = 0; k < 60 * (STUCK_RESPAWN + 1) && respawnAt === null; k++) {
    w.step();
    if (w.drain().some((ev) => ev.kind === 'respawn')) respawnAt = w.time;
  }
  const back = w.track.project(e.car.x, e.car.z);
  const facing = Math.abs(wrapAngle(e.car.yaw - w.track.poseAt(back.s).yaw)) < 0.05;
  check('a car pinned against a wall is put back on the road after 3 s', respawnAt !== null && Math.abs(back.d) < 0.5 && facing && e.ghost > 0,
    respawnAt ? `respawned after ${(respawnAt - 2).toFixed(1)} s, ${w.track.deltaS(safe, back.s).toFixed(0)} m from its last good spot` : 'never respawned');

  // Park a second car right on top of it: while it is a ghost they pass
  // through each other; once the ghosting ends, they are pushed apart.
  const other = w.addCar('q', 1, () => intent());
  Object.assign(other.car, { x: e.car.x, z: e.car.z, yaw: e.car.yaw, vx: 0, vz: 0, w: 0, hint: e.car.hint });
  e.drive = () => intent();
  w.step();
  const overlapping = Math.hypot(other.car.x - e.car.x, other.car.z - e.car.z) < 0.1;
  for (let k = 0; k < 60 * GHOST_TIME + 5; k++) w.step();
  const apart = Math.hypot(other.car.x - e.car.x, other.car.z - e.car.z);
  check('a respawned car is a ghost for two seconds, then solid again', overlapping && e.ghost === 0 && apart > 1.5,
    `${apart.toFixed(1)} m apart once solid`);
}

{
  // Head on at 10 m/s each: they bounce apart, momentum is conserved, and they end up apart.
  const a = createCar(0, 0, 0);
  const b = createCar(0, 4.2, Math.PI);
  a.vz = 10;
  b.vz = -10;
  const hit = resolveCarPair(a, b, CAR_SHAPE);
  const d = Math.hypot(a.x - b.x, a.z - b.z);
  check('cars colliding head on bounce apart with momentum conserved', hit !== null && a.vz < 0 && b.vz > 0 && Math.abs(a.vz + b.vz) < 1e-9 && d >= 4.4 - 1e-9,
    `after: ${a.vz.toFixed(2)} / ${b.vz.toFixed(2)} m/s, ${d.toFixed(2)} m apart`);
  // One-sided resolution (M3): only A is moved, and B keeps its velocity.
  const c = createCar(0, 0, 0);
  const e = createCar(0, 4.2, Math.PI);
  c.vz = 10;
  e.vz = -10;
  resolveCarPair(c, e, CAR_SHAPE, true, false);
  check('a one-sided collision moves only the car it is asked to', c.vz < 0 && e.vz === -10 && e.z === 4.2);
}

/* ---------------------------------------------------------------- weapons */

console.log('\nweapons');

const W = SIM.weapons;

/** The start of the longest nearly straight stretch of a track: somewhere to shoot along. */
function straight(track, len = 80) {
  let best = 0;
  let bestTurn = Infinity;
  for (let s = 0; s < track.length; s += 5) {
    let turn = 0;
    for (let a = 0; a < len; a += 5) turn += Math.abs(wrapAngle(track.poseAt(s + a + 5).yaw - track.poseAt(s + a).yaw));
    if (turn < bestTurn) {
      bestTurn = turn;
      best = s;
    }
  }
  return best;
}

/** Put a car at arc length `s`, `d` metres off the centre line, facing along the track (or `turn` off it), stopped. */
function place(w, e, s, d = 0, turn = 0) {
  const pose = w.track.poseAt(s);
  const [x, z] = w.track.offsetPoint(pose.i, d);
  Object.assign(e.car, { x, z, yaw: pose.yaw + turn, vx: 0, vz: 0, w: 0, hint: pose.i });
  Object.assign(e.prev, e.car);
  const p = w.track.project(x, z, pose.i);
  e.s = p.s;
  e.d = p.d;
  e.safeS = p.s;
}

/** A world past its start grace, with scripted cars. */
function armedWorld(n) {
  const w = new World(TRACKS[0], { laps: 0, countdown: 0 });
  const cars = Array.from({ length: n }, (_, i) => {
    const e = w.addCar(`c${i}`, i, () => e.script ?? intent());
    return e;
  });
  while (w.time < W.startGrace + 0.1) w.step();
  w.drain();
  return { w, cars };
}

/** Step until `fn` is true or `max` seconds pass; returns the events seen. */
function stepFor(w, max, fn = () => false) {
  const evs = [];
  for (let k = 0; k < max * 60; k++) {
    w.step();
    evs.push(...w.drain());
    if (fn(evs)) break;
  }
  return evs;
}

const S0 = straight(TRACKS[0] && new World(TRACKS[0]).track);

{
  // A shot is a function of time: two worlds, the same launch, evaluated at
  // the same moment — one stepped there, one spawning the shot late — agree.
  const a = new Armoury(new World(TRACKS[0]).track);
  const b = new Armoury(new World(TRACKS[0]).track);
  const pose = new World(TRACKS[0]).track.poseAt(S0);
  const ma = a.launch('x', 1, 'front', pose.x, pose.z, pose.yaw, 10, true);
  const mb = b.launch('x', 1, 'front', pose.x, pose.z, pose.yaw, 10, false);
  const pa = missileAt(ma, 10.7);
  const pb = missileAt(mb, 10.7);
  check('a missile fired into two worlds flies identically, and one spawned late is already where it should be',
    ma.end === mb.end && ma.wall === mb.wall && pa.x === pb.x && pa.z === pb.z);
}

{
  // Two hundred shots from all over the track in every direction: none ends past a wall.
  const w = new World(TRACKS[0]);
  const t = w.track;
  const rand = mulberry32(99);
  let escaped = 0;
  let walls = 0;
  for (let k = 0; k < 200; k++) {
    const s = rand() * t.length;
    const pose = t.poseAt(s);
    const [x, z] = t.offsetPoint(pose.i, (rand() - 0.5) * 2 * (t.halfWidth - 1.5));
    const m = w.armoury.launch('x', k, rand() < 0.5 ? 'front' : 'rear', x, z, rand() * Math.PI * 2, 0, false);
    if (m.wall) walls++;
    // Walk the flight: every point of it must stay inside the walls.
    for (let tt = 0; tt <= m.end; tt += 0.01) {
      const p = missileAt(m, tt);
      if (Math.abs(t.project(p.x, p.z).d) > t.wallOffset + 0.05) {
        escaped++;
        break;
      }
    }
  }
  check('missiles stop at walls: 200 shots in random directions, none leaves the track', escaped === 0 && walls > 100, `${walls} hit a wall, ${escaped} escaped`);
}

{
  // Nose against a wall: the shot must not come out the other side.
  const w = new World(TRACKS[0]);
  const t = w.track;
  const pose = t.poseAt(S0);
  const [x, z] = t.offsetPoint(pose.i, t.wallOffset - 1.1);
  const toWall = pose.yaw - Math.PI / 2; // facing the wall on the car's right... or left
  const a = w.armoury.launch('x', 1, 'front', x, z, toWall, 0, false);
  const b = w.armoury.launch('x', 2, 'front', x, z, toWall + Math.PI, 0, false);
  const shortest = Math.min(a.end, b.end);
  const at = missileAt(shortest === a.end ? a : b, shortest);
  check('a car with its nose on a wall cannot shoot through it', shortest === 0 && Math.abs(t.project(at.x, at.z).d) <= t.wallOffset + 0.05,
    `flight ${(Math.min(a.end, b.end) * 1000).toFixed(0)} ms`);
}

{
  const { w, cars: [a, b] } = armedWorld(2);
  place(w, a, S0);
  place(w, b, S0 + 30);
  a.script = intent({ fireFront: true });
  w.step();
  a.script = intent();
  const evs = stepFor(w, 1, (e) => e.some((x) => x.kind === 'hit'));
  const hit = evs.find((e) => e.kind === 'hit');
  check('a front missile hits the car 30 m ahead: 20 damage, one missile gone',
    hit?.id === 'c1' && hit.by === 'c0' && b.hp === W.health - W.front.damage && a.ammo.front === W.loadout.front - 1 && w.armoury.missiles.length === 0,
    `hp ${b.hp}, ammo ${a.ammo.front}`);
  check('and the shooter never hits itself', a.hp === W.health);
}

{
  // Rear missile, once the mines are gone; cooldown and empty racks respected.
  const { w, cars: [a, b] } = armedWorld(2);
  place(w, a, S0 + 30);
  place(w, b, S0);
  a.ammo.mines = 0;
  a.script = intent({ fireRear: true });
  const evs = stepFor(w, 1);
  const fired = evs.filter((e) => e.kind === 'fire');
  check('with no mines left the rear button fires rear missiles, one per cooldown', fired.length >= 2 && fired.every((f) => f.weapon === 'rear')
    && fired.length <= Math.ceil(1 / W.rear.cooldown) + 1 && b.hp < W.health, `${fired.length} fired in the first second`);
  a.ammo.front = 0;
  a.script = intent({ fireFront: true });
  const none = stepFor(w, 0.5).filter((e) => e.kind === 'fire' && e.weapon === 'front');
  check('an empty rack fires nothing', none.length === 0);
}

{
  // Nobody fires on the grid, or before the start grace.
  const w = new World(TRACKS[0], { laps: 1, countdown: 1 });
  const e = w.addCar('a', 0, () => intent({ fireFront: true, fireRear: true }));
  let early = 0;
  while (w.time < 1 + W.startGrace - 0.05) {
    w.step();
    early += w.drain().filter((x) => x.kind === 'fire' || x.kind === 'mine').length;
  }
  const later = stepFor(w, 0.5).filter((x) => x.kind === 'fire' || x.kind === 'mine').length;
  check(`nobody fires before GO + ${W.startGrace} s, and fires after`, early === 0 && later > 0 && e.ammo.front < W.loadout.front);
}

{
  // Ghosts, finishers and wrecks are not targets: the shot flies on.
  const { w, cars: [a, b, c] } = armedWorld(3);
  place(w, a, S0);
  place(w, b, S0 + 20);
  place(w, c, S0 + 40);
  b.ghost = 5;
  c.lap.finished = true;
  a.script = intent({ fireFront: true });
  w.step();
  a.script = intent();
  const evs = stepFor(w, 1.5);
  check('shots pass through a ghost and a car that has finished', !evs.some((e) => e.kind === 'hit') && b.hp === 100 && c.hp === 100);
}

{
  // Mines: dropped behind, inert until armed, then they hurt whoever drives
  // over them — including their owner — and vanish.
  const { w, cars: [a, b] } = armedWorld(2);
  place(w, a, S0 + 20);
  place(w, b, S0 + 60, 5);
  a.script = intent({ fireRear: true });
  w.step();
  a.script = intent();
  const mine = w.armoury.mines[0];
  const behind = mine && w.track.deltaS(w.track.project(mine.x, mine.z).s, a.s);
  // Park B on it at once: not armed yet.
  Object.assign(b.car, { x: mine.x, z: mine.z, yaw: a.car.yaw, vx: 0, vz: 0 });
  const early = stepFor(w, W.mine.arm - 0.1).filter((e) => e.kind === 'hit');
  const evs = stepFor(w, 0.3);
  const hit = evs.find((e) => e.kind === 'hit');
  check('a mine drops behind the car and is harmless until it arms', mine && behind > 1.5 && early.length === 0, `${behind?.toFixed(1)} m behind`);
  check('armed, it hurts the car on it for 30, once, and is gone', hit?.weapon === 'mine' && b.hp === W.health - W.mine.damage && w.armoury.mines.length === 0 && a.ammo.mines === W.loadout.mines - 1);

  place(w, b, S0 + 60, 5);
  a.script = intent({ fireRear: true });
  w.step();
  a.script = intent();
  stepFor(w, W.mine.arm + 0.2);
  const own = w.armoury.mines[0];
  Object.assign(a.car, { x: own.x, z: own.z, vx: 0, vz: 0 });
  stepFor(w, 0.2);
  check('your own mine hurts you too, once armed', a.hp === W.health - W.mine.damage);
}

{
  // Wreck: to zero health, burn, back on the road with 35 health, ghosted,
  // and the kill credited.
  const { w, cars: [a, b] } = armedWorld(2);
  place(w, a, S0);
  place(w, b, S0 + 25);
  b.hp = 15;
  a.script = intent({ fireFront: true });
  w.step();
  a.script = intent();
  const evs = stepFor(w, 1, (e) => e.some((x) => x.kind === 'wreck'));
  const wreck = evs.find((e) => e.kind === 'wreck');
  const burning = b.wrecked > 0 && b.hp === 0;
  const before = [b.car.x, b.car.z];
  const later = stepFor(w, W.wreckTime + 0.1);
  const back = later.some((e) => e.kind === 'respawn' && e.id === 'c1');
  check('a car shot to zero is wrecked, and the shooter gets the kill', wreck?.id === 'c1' && wreck.by === 'c0' && a.kills === 1 && b.wrecks === 1 && burning);
  check(`it burns for ${W.wreckTime} s, then is back on the road with ${W.respawnHealth} health and ghosted`,
    back && b.wrecked === 0 && b.hp === W.respawnHealth && b.ghost > 0 && Math.hypot(b.car.x - before[0], b.car.z - before[1]) > 1);
}

{
  // Walls hurt past 12 m/s, and a wall that finishes off a car somebody
  // just shot is their wreck.
  const w = new World(TRACKS[0], { laps: 0, countdown: 0 });
  const e = w.addCar('a', 0, () => intent());
  const hitWall = (speed) => {
    place(w, e, S0, 0, Math.PI / 2);
    const hp = e.hp;
    e.car.vx = Math.sin(e.car.yaw) * speed;
    e.car.vz = Math.cos(e.car.yaw) * speed;
    stepFor(w, 1.5);
    return hp - e.hp;
  };
  const soft = hitWall(10);
  const hard = hitWall(35);
  check('a wall at 10 m/s costs nothing; at 35 m/s it costs health', soft === 0 && hard > 10, `${hard.toFixed(1)} health at 35 m/s`);
  e.hp = 5;
  e.lastAttacker = 'z';
  e.lastAttackAt = w.time;
  const z = w.addCar('z', 1, () => intent());
  place(w, e, S0, 0, Math.PI / 2);
  e.car.vx = Math.sin(e.car.yaw) * 35;
  e.car.vz = Math.cos(e.car.yaw) * 35;
  const evs = stepFor(w, 1.5);
  const wreck = evs.find((x) => x.kind === 'wreck');
  check('a wall that finishes a car just shot counts as the shooter\'s wreck', wreck?.by === 'z' && z.kills === 1);
}

{
  // A full armed race: six bots, three laps, weapons live.
  const run = () => {
    const w = new World(TRACKS[0], { laps: 3, countdown: 1 });
    const bots = SKILLS.map((sk, i) => w.addBot(`b${i}`, i, sk, 50 + i));
    const tally = { fire: 0, hit: 0, wreck: 0, mine: 0 };
    let bad = false;
    while (w.time < 400 && !bots.every((b) => b.lap.finished)) {
      w.step();
      for (const e of w.drain()) if (e.kind in tally) tally[e.kind]++;
      if (bots.some((b) => !Number.isFinite(b.car.x) || !Number.isFinite(b.hp))) bad = true;
    }
    return { w, bots, tally, bad };
  };
  const r = run();
  const kills = r.bots.reduce((a, b) => a + b.kills, 0);
  const wrecks = r.bots.reduce((a, b) => a + b.wrecks, 0);
  check('six armed bots race three laps: all finish, shots land, some wrecks, every kill credited to a wreck',
    r.bots.every((b) => b.lap.finished) && !r.bad && r.tally.hit > 10 && wrecks >= 1 && wrecks <= 20 && kills <= wrecks,
    `${r.tally.fire} missiles, ${r.tally.mine} mines, ${r.tally.hit} hits, ${wrecks} wrecks, ${kills} credited`);
  const again = run();
  check('and the same armed race run twice is identical to the last step',
    r.w.steps === again.w.steps && r.bots.every((b, i) => b.lap.finishTime === again.bots[i].lap.finishTime && b.hp === again.bots[i].hp));
}

/* ---------------------------------------------------------------- hazards */

console.log('\nhazards');

{
  const docks = TRACKS.find((d) => d.railway);
  const t1 = new Track(docks);
  const t2 = new Track(docks);
  const rw = docks.railway;
  // Same race time, two separately built tracks: the same train, to the millimetre.
  let same = true;
  for (let t = 0; t < 200; t += 0.37) {
    const a = trainAt(t1, t), b = trainAt(t2, t);
    if (JSON.stringify(a) !== JSON.stringify(b)) same = false;
  }
  const none = trainAt(t1, rw.first - 0.1) === null;
  const out = trainAt(t1, rw.first + 1);
  const back = trainAt(t1, rw.first + rw.period + 1);
  check('the train is a pure function of race time: two tracks agree, no train before its first run',
    same && none && out?.dir === 1 && back?.dir === -1, `first run ${rw.first} s, then every ${rw.period} s, alternating`);

  // It blocks the crossing for a few seconds each pass, and the lights come on before it does.
  let blockedFrom = null, blockedTo = null, warnedAt = null;
  for (let t = rw.first - 10; t < rw.first + rw.period - 10; t += 0.05) {
    if (warnedAt === null && crossingWarning(t1, t)) warnedAt = t;
    if (crossingBlocked(t1, t)) {
      blockedFrom ??= t;
      blockedTo = t;
    }
  }
  check('each pass blocks the crossing for a few seconds, with the lights on 5 s before',
    blockedFrom !== null && blockedTo - blockedFrom > 2 && blockedTo - blockedFrom < 10 && Math.abs(blockedFrom - warnedAt - 5) < 0.3,
    blockedFrom === null ? 'never blocked' : `blocked ${(blockedTo - blockedFrom).toFixed(1)} s, lights ${(blockedFrom - warnedAt).toFixed(1)} s ahead`);

  // Past the end of the line the train is in its shed or off the map: none of it may touch anything.
  const tr = trainAt(t1, rw.first + (t1.rail.length + 30) / rw.speed);
  const seg = tr && trainSegment(t1, tr);
  const inside = !seg || [seg.ax, seg.bx].every((x) => x >= Math.min(t1.rail.ax, t1.rail.bx) - 1e-6 && x <= Math.max(t1.rail.ax, t1.rail.bx) + 1e-6)
    && [seg.az, seg.bz].every((z) => z >= Math.min(t1.rail.az, t1.rail.bz) - 1e-6 && z <= Math.max(t1.rail.az, t1.rail.bz) + 1e-6);
  check('the train never reaches past the ends of its rails', inside);

  // A car parked on the crossing when the train comes through.
  const w = new World(docks, { laps: 0, countdown: 0, weapons: false });
  const e = w.addCar('p', 0, () => intent());
  const pose = w.track.poseAt(t1.rail.s);
  const parkAt = () => Object.assign(e.car, { x: pose.x, z: pose.z, yaw: pose.yaw, vx: 0, vz: 0, w: 0, hint: pose.i });
  while (!crossingBlocked(w.track, w.time + 0.2 - w.goTime)) {
    w.step();
    parkAt();
  }
  const evs = stepFor(w, 3);
  const hit = evs.find((x) => x.kind === 'train');
  const clear = trainSegment(w.track, trainAt(w.track, w.time - w.goTime));
  check('a car parked on the crossing is hit by the train: shoved clear and badly hurt', hit && e.hp <= 100 - 20 && Math.hypot(e.car.x - pose.x, e.car.z - pose.z) > 2,
    `${(100 - e.hp).toFixed(0)} damage`);

  // Six bots, three laps of the docks: they wait for the train, and nobody is hit by it.
  const r = new World(docks, { laps: 3, countdown: 1, weapons: false });
  const bots = SKILLS.map((sk, i) => r.addBot(`b${i}`, i, sk, 70 + i));
  let trainHits = 0, waited = 0;
  while (r.time < 400 && !bots.every((b) => b.lap.finished)) {
    r.step();
    trainHits += r.drain().filter((x) => x.kind === 'train').length;
    for (const b of bots) if (r.stopLine(b) !== null && Math.hypot(b.car.vx, b.car.vz) < 1) waited++;
  }
  check('six bots race the docks: they wait at the crossing and the train hits nobody', bots.every((b) => b.lap.finished) && trainHits === 0 && waited > 0,
    `${(waited / 60).toFixed(1)} car-seconds waiting, ${trainHits} hit`);
}

{
  // Off the quay: into the harbour, and back on the road within a second or so.
  const docks = TRACKS.find((d) => d.id === 'docks');
  const w = new World(docks, { laps: 0, countdown: 0, weapons: false });
  const e = w.addCar('p', 0, () => intent({ throttle: 1 }));
  const gap = docks.wallGaps[0];
  const pose = w.track.poseAt(((gap.from + gap.to) / 2) * w.track.length);
  const side = gap.side === 'left' ? 1 : -1;
  const [x, z] = w.track.offsetPoint(pose.i, side * (w.track.wallOffset + 3));
  Object.assign(e.car, { x, z, yaw: pose.yaw, vx: 0, vz: 0, hint: pose.i });
  const wet = w.track.surfaceAt(x, z, pose.i);
  const evs = stepFor(w, 1.5, (ev) => ev.some((y) => y.kind === 'respawn'));
  const back = Math.abs(w.track.project(e.car.x, e.car.z).d) < w.track.halfWidth;
  check('a car in the harbour is back on the road within a second', wet === 5 && evs.some((y) => y.kind === 'respawn') && back && w.time < 1.3,
    `surface ${wet}, after ${w.time.toFixed(2)} s, ${back ? 'on the road' : 'not on the road'}`);
}

{
  // Oil: a patch on the road has almost no grip; a car steering across it
  // hardly turns at all — it carries straight on.
  const docks = TRACKS.find((d) => d.surfaces.some((z) => z.surface === 3));
  const oil = docks.surfaces.find((z) => z.surface === 3);
  const t = new Track(docks);
  const run = (surface) => {
    const car = createCar(0, 0, 0);
    car.vz = 20;
    const env = { walls: new Float64Array(0), forWallsNear() {}, surfaceAt: () => surface, groundAt: () => 0, project: () => ({ i: 0 }) };
    for (let k = 0; k < 40; k++) stepCar(car, intent({ steer: -1, throttle: 0.5 }), env, STEP);
    // How far the direction of travel has turned.
    return Math.abs(Math.atan2(car.vx, car.vz));
  };
  check('an oil patch is oil, and a car steering across it barely turns',
    t.surfaceAt(oil.at[0], oil.at[1]) === 3 && run(3) < run(0) * 0.4, `turned ${run(0).toFixed(2)} rad on tarmac, ${run(3).toFixed(2)} on oil`);
}

/* ------------------------------------------------------ generated tracks */

console.log('\ngenerated tracks');

/**
 * The exact output for a few seeds, pinned. If the generator changes, these
 * change, and yesterday's track of the day would silently become a
 * different track: the test is there to make that a decision, not an accident.
 */
const PINNED = [
  [1, 'Neon Sprint', '5dbd25f5'],
  [42, 'Static Reach', '8c924ebc'],
  [seedOf('NITRO'), 'Neon Yard', 'b0269db'],
  [daySeed(Date.UTC(2026, 8, 25, 12)), 'Signal Mile', '80ed5d55'],
];

{
  const got = PINNED.map(([seed]) => {
    const d = generateTrack(seed);
    return [seed, d.name, hashString(JSON.stringify(d)).toString(16)];
  });
  check('the pinned seeds still generate exactly the same tracks', JSON.stringify(got) === JSON.stringify(PINNED),
    got.map(([, n, h]) => `${n} ${h}`).join(', '));

  // Integers only in the definition: nothing a different engine's Math.sin could nudge.
  const ints = [1, 2, 3, 7, 99].every((sd) => generateTrack(sd).corners.every((c) => c.every(Number.isInteger)));
  check('a generated track\'s corners are whole metres and whole numbers', ints);

  check('a seed is any word: case and spacing do not matter', seedOf('  green  mile ') === seedOf('GREEN MILE') && seedOf('a') !== seedOf('b'));
  const day = Date.UTC(2026, 8, 25);
  check('the track of the day changes at UTC midnight and not before',
    daySeed(day) === daySeed(day + 86399999) && daySeed(day) !== daySeed(day + 86400000) && daySeed(day - 1) !== daySeed(day)
    && utcDay(day + 86399999) === '2026-09-25', `today is "${trackName(daySeed(day))}"`);

  // A thousand seeds: every one yields a track, every one valid.
  let bad = 0;
  let most = 0;
  for (let sd = 1000; sd < 2000; sd++) {
    try {
      const d = generateTrack(sd);
      if (validateTrack(new Track({ ...d, props: [] })) !== null) bad++;
      most = Math.max(most, attemptsFor(sd));
    } catch {
      bad++;
    }
  }
  check('a thousand seeds all generate a valid track', bad === 0, `${bad} failed; at most ${most} candidates for one seed`);

  // A hundred of them lapped by the autopilot, cleanly.
  const lapped = [];
  const failed = [];
  for (let sd = 1; sd <= 100; sd++) {
    const w = new World(generateTrack(sd), { laps: 1, countdown: 0, weapons: false });
    const b = w.addBot('b', 0, SKILLS[0], 1);
    while (!b.lap.finished && w.time < 200) w.step();
    if (b.lap.finished && b.respawns === 0 && b.car.impacts <= 3) lapped.push(b.lap.best);
    else failed.push(sd);
  }
  check('the autopilot laps a hundred generated tracks cleanly', failed.length === 0,
    failed.length ? `failed seeds ${failed.join(' ')}` : `laps ${Math.min(...lapped).toFixed(0)}-${Math.max(...lapped).toFixed(0)} s`);

  // And the hotlap's splits: a time at each checkpoint, kept for the lap just done.
  const w = new World(generateTrack(7), { laps: 0, countdown: 0, weapons: false });
  const b = w.addBot('b', 0, SKILLS[0], 1);
  while (b.lap.completed < 2 && w.time < 200) w.step();
  const sp = b.lap.lastSplits;
  check('a lap records a split at every checkpoint, in order, inside the lap time',
    sp.length === w.track.checkpoints.length && sp.every((t, i) => t > 0 && (i === 0 || t > sp[i - 1])) && sp[sp.length - 1] < b.lap.lapTimes[1],
    sp.map((t) => t.toFixed(1)).join(' / '));
}

{
  // The hotlap ghost: record a bot's lap, then play it back at the same
  // moments and find the car where it really was.
  const w = new World(TRACKS[0], { laps: 0, countdown: 0, weapons: false });
  const b = w.addBot('b', 0, SKILLS[0], 3);
  while (b.lap.completed < 0) w.step();
  const trace = new LapTrace();
  const truth = [];
  while (b.lap.completed < 1) {
    w.step();
    if (b.lap.completed >= 1) break;
    const t = w.time - b.lap.lapStart;
    trace.offer(t, b.car.x, b.car.z, b.car.yaw);
    truth.push([t, b.car.x, b.car.z]);
  }
  let worst = 0;
  for (const [t, x, z] of truth) {
    const g = ghostAt(trace.data, t);
    if (g) worst = Math.max(worst, Math.hypot(g.x - x, g.z - z));
  }
  const samples = trace.data.length / 3;
  const lapTime = b.lap.lapTimes[0];
  check('a lap recorded at 10 Hz plays back where the car really was', worst < 1.2 && Math.abs(samples - lapTime * GHOST_HZ) < 2 && ghostAt(trace.data, lapTime + 1) === null,
    `worst ${worst.toFixed(2)} m off over a ${lapTime.toFixed(1)} s lap, ${samples} samples, ${JSON.stringify(trace.data).length} bytes stored`);
  check('a damaged ghost from storage is refused, not played', !validTrace([1, 2]) && !validTrace('x') && !validTrace([1, 2, 3.5, 4, 5, 6]) && validTrace(trace.data));
}

{
  // Random seeds: three words from the list, hyphenated, and every one a track.
  const rand = mulberry32(5);
  const seeds = Array.from({ length: 200 }, () => randomSeedText(rand));
  const shaped = seeds.every((t) => /^[a-z]{3}-[a-z]{3}-[a-z]{3}$/.test(t) && t.split('-').every((w) => SEED_WORDS.includes(w)));
  const unique = new Set(seeds).size;
  const clean = !['ass', 'sex', 'god', 'jew', 'gay'].some((w) => SEED_WORDS.includes(w));
  let tracks = 0;
  for (const t of seeds.slice(0, 20)) if (generateTrack(seedOf(t))) tracks++;
  check('a random seed is three listed words, hyphenated, and makes a track', shaped && unique > 195 && clean && tracks === 20 && SEED_WORDS.length === 367,
    `e.g. ${seeds.slice(0, 3).join(', ')}; ${SEED_WORDS.length} words`);
}

{
  // Race only: the trigger does nothing at all.
  const w = new World(TRACKS[0], { laps: 1, countdown: 0, weapons: false });
  const e = w.addCar('a', 0, () => intent({ fireFront: true, fireRear: true, throttle: 1 }));
  let fired = 0;
  while (w.time < 8) {
    w.step();
    fired += w.drain().filter((x) => x.kind === 'fire' || x.kind === 'mine').length;
  }
  check('a race-only world ignores every trigger', fired === 0 && e.ammo.front === SIM.weapons.loadout.front);
}

/* ------------------------------------------------------------ determinism */

console.log('\ndeterminism');

function scripted(steps) {
  const rand = mulberry32(1234);
  const script = Array.from({ length: steps }, () => intent({
    throttle: rand() < 0.8 ? 1 : 0, steer: Math.sin(rand() * 6), handbrake: rand() < 0.05,
  }));
  return script;
}

{
  const script = scripted(900);
  const make = () => {
    const w = new World(TRACKS[0]);
    let n = 0;
    const e = w.addCar('a', 0, () => script[Math.min(n++, script.length - 1)]);
    return { w, e };
  };
  const a = make();
  const b = make();
  for (let s = 0; s < 900; s++) {
    a.w.step();
    b.w.step();
  }
  check('two worlds fed the same inputs end in the identical state', JSON.stringify(a.e.car) === JSON.stringify(b.e.car));

  // Frame rate must not matter: the same wall time at 144 Hz and at 24 Hz
  // gives the same number of steps and the same car.
  const c = make();
  const d = make();
  for (let k = 0; k < 144 * 5; k++) c.w.advance(1 / 144);
  for (let k = 0; k < 24 * 5; k++) d.w.advance(1 / 24);
  const sameSteps = c.w.steps === d.w.steps;
  check('144 Hz and 24 Hz frame rates step the world identically', sameSteps && JSON.stringify(c.e.car) === JSON.stringify(d.e.car),
    `${c.w.steps} vs ${d.w.steps} steps`);

  const e = make();
  e.w.advance(10);
  check('a ten-second stall is clamped, not simulated in one frame', e.w.steps <= Math.ceil(0.25 / STEP), `${e.w.steps} steps`);
}

{
  const w = new World(TRACKS[0]);
  let entrant;
  entrant = w.addCar('a', 0, () => follow());
  const follow = follower(w.track, entrant);
  let dist = 0;
  let prev = w.track.project(entrant.car.x, entrant.car.z).s;
  let steps = 0;
  while (dist < w.track.length && steps < 60 * 180) {
    w.step();
    steps++;
    const p = w.track.project(entrant.car.x, entrant.car.z, entrant.car.hint);
    dist += w.track.deltaS(prev, p.s);
    prev = p.s;
  }
  check('a simple line-follower gets round Neon Downtown without touching a wall',
    dist >= w.track.length && entrant.car.impacts === 0, `${(steps / 60).toFixed(1)} s, ${entrant.car.impacts} impacts`);
  check('and takes off over the plaza ramp on the way', entrant.car.landings >= 1, `${entrant.car.landings} landings`);
}

/* ----------------------------------------------------------------- helpers */

console.log('\nhelpers');

{
  const a = createCar(0, 0, 3.0);
  const b = createCar(10, 20, -3.0);
  const out = createCar(0, 0, 0);
  interpolateCar(a, b, 0.5, out);
  check('interpolation blends position and takes the short way round in yaw',
    out.x === 5 && out.z === 10 && Math.abs(Math.abs(out.yaw) - Math.PI) < 0.01, `yaw ${out.yaw.toFixed(3)}`);
}

check('a centred stick with a zero deadzone is 0, not NaN', applyDeadzone1(0, 0) === 0);
check('deadzone rescales so the rim is still full lock', applyDeadzone1(1, 0.2) === 1 && Math.abs(applyDeadzone1(-0.6, 0.2) + 0.5) < 1e-9);
check('the hardware drift floor zeroes a resting stick', filterAxis(0.12) === 0 && filterAxis(-0.3) === -0.3);

{
  const r = smoothing(0.2, 1 / 60);
  const twice = 1 - (1 - smoothing(0.2, 1 / 120)) ** 2;
  check('smoothing converges the same per second at 60 and 120 Hz', Math.abs(r - twice) < 1e-12);
}

{
  const res = resolveColours([
    { id: 'b', colour: 'cyan' },
    { id: 'a', colour: 'cyan' },
    { id: 'c', colour: 'cyan' },
  ]);
  check('colour clashes resolve by seniority, then the next free colour', res.a === 'cyan' && res.b === 'amber' && res.c === 'magenta',
    JSON.stringify(res));
  const six = resolveColours(Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, colour: 'black' })));
  check('six players always get six different colours', new Set(Object.values(six)).size === 6 && PALETTE.length >= 6);
}

check('the stock car stats are all ones', STOCK.engine === 1 && STOCK.grip === 1 && STOCK.turbo === 1);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail) process.exitCode = 1;
