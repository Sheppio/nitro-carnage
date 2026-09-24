/**
 * Headless simulation suite. Runs in plain Node against the compiled `dist/`,
 * with no browser and no three.js: `sim/` and `input/sources` import neither,
 * and this suite is what keeps it that way.
 */
import { STEP, SIM } from '../dist/config.js';
import { createCar, stepCar, steerLimit, STOCK } from '../dist/sim/car.js';
import { Surface } from '../dist/sim/surfaces.js';
import { Track } from '../dist/sim/track/buildTrack.js';
import { closestSegSeg } from '../dist/sim/collide.js';
import { TRACKS } from '../dist/sim/track/index.js';
import { World } from '../dist/sim/World.js';
import { interpolateCar } from '../dist/sim/interpolate.js';
import { resolveColours, PALETTE } from '../dist/sim/palette.js';
import { applyDeadzone1, filterAxis } from '../dist/input/sources.js';
import { mulberry32, wrapAngle, smoothing } from '../dist/util.js';

let pass = 0;
let fail = 0;
function check(label, ok, note = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${note ? ` — ${note}` : ''}`);
  ok ? pass++ : fail++;
}

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

  check(`${name}: lap length is a short arcade circuit (1.2-1.8 km)`, t.length > 1200 && t.length < 1800, `${t.length.toFixed(0)} m`);

  let minR = Infinity;
  for (let i = 0; i < t.n; i++) {
    const k = Math.abs(t.line.curvature[i]);
    if (k > 1e-6) minR = Math.min(minR, 1 / k);
  }
  check(`${name}: tightest corner leaves room for the inside wall`, minR > t.wallOffset + 1,
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
  check(`${name}: no wall crosses another`, crossings === 0, `${crossings} crossings among ${t.wallCount} segments`);

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
  check(`${name}: centreline stays a wall offset from every wall`, tightest > t.wallOffset - 0.3,
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
  check(`${name}: projection recovers s and d anywhere on the road`, worstS < 0.6 && worstD < 0.3,
    `worst s error ${worstS.toFixed(2)} m, d error ${worstD.toFixed(2)} m`);

  const cps = t.checkpoints;
  check(`${name}: checkpoints are ordered inside the lap`, cps.length > 0 && cps.every((s, i) => s > 0 && s < t.length && (i === 0 || s > cps[i - 1])));

  const start = t.project(def.start[0], def.start[1]);
  check(`${name}: s = 0 is at the start line`, Math.min(start.s, t.length - start.s) < 1, `start projects to s=${start.s.toFixed(2)}`);

  const again = new Track(def);
  check(`${name}: scenery is deterministic from the seed`, JSON.stringify(again.props) === JSON.stringify(t.props), `${t.props.length} props`);

  const corners = (p) => [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]].map(([a, b]) => [p.x + (a * p.w) / 2, p.z + (b * p.d) / 2]);
  const intrusions = t.props.filter((p) => p.kind === 'tower' && corners(p).some(([x, z]) => Math.abs(t.project(x, z).d) < t.wallOffset));
  check(`${name}: no tower stands on the road`, intrusions.length === 0, `${intrusions.length} intruding`);

  const slots = [0, 1, 2, 3, 4, 5].map((k) => t.gridSlot(k));
  const onRoad = slots.every((p) => Math.abs(t.project(p.x, p.z).d) < t.halfWidth - 1);
  const behind = slots.every((p) => t.deltaS(0, t.project(p.x, p.z).s) < 0);
  let minGap = Infinity;
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) minGap = Math.min(minGap, Math.hypot(slots[a].x - slots[b].x, slots[a].z - slots[b].z));
  check(`${name}: six grid slots on the road, behind the line, not touching`, onRoad && behind && minGap > 4.5, `closest pair ${minGap.toFixed(1)} m`);
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
    // Start 3 m inside the wall, pointed straight at it at five times top speed.
    const car = createCar(mx + nx * 3, mz + nz * 3, Math.atan2(-nx, -nz));
    car.vx = -nx * fast;
    car.vz = -nz * fast;
    car.hint = t.project(car.x, car.z).i;
    tried++;
    for (let s = 0; s < 20; s++) {
      stepCar(car, intent({ throttle: 1 }), t, STEP);
      if (Math.abs(t.project(car.x, car.z, car.hint).d) > t.wallOffset + 0.05) {
        escaped++;
        break;
      }
    }
  }
  check(`${def.name}: no tunnelling at 5x top speed into any wall`, escaped === 0, `${escaped} of ${tried} escaped at ${fast} m/s`);
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
