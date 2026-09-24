import { SIM } from '../config.js';
import type { DriveIntent } from '../types.js';
import { resolveWalls } from './collide.js';
import type { CapsuleShape, WallSource } from './collide.js';
import { Surface, SURFACES } from './surfaces.js';

/**
 * Arcade car physics on the XZ plane.
 *
 * A bicycle model: one front and one rear axle, a lateral tyre force at each
 * from its slip angle, clamped by the surface's grip, with the drive force at
 * the rear sharing that grip (the friction circle). No physics engine — the
 * whole thing is a few dozen lines that run in Node, that the tests can
 * reason about, and that every client steps identically.
 *
 * Conventions: yaw 0 faces +Z (screen down); forward is (sin yaw, cos yaw);
 * the car's left is (cos yaw, -sin yaw); a positive yaw rate turns left. With
 * forward, left and up in that order the frame is right-handed, so the
 * textbook bicycle-model equations (x forward, y left) apply unchanged.
 */

export interface CarState {
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  /** Yaw rate, rad/s, positive turning left. */
  w: number;
  /** Ride height above the ground plane, and its rate. */
  y: number;
  vy: number;
  airborne: boolean;
  /** Front wheel angle, radians, positive left. */
  steer: number;
  /** Turbo meter, seconds of boost remaining. */
  turbo: number;

  /* ---- derived each step, for the renderer, the HUD and the network ---- */
  /** Signed speed along the car's heading. */
  forward: number;
  /** Body slip angle, radians: how far the velocity points away from the nose. */
  slip: number;
  drifting: boolean;
  handbrake: boolean;
  braking: boolean;
  throttle: number;
  boosting: boolean;
  /** Body-frame acceleration, m/s^2, for body roll and pitch. */
  accelLong: number;
  accelLat: number;
  surfaceFront: Surface;
  surfaceRear: Surface;
  /** Nearest centreline sample, fed back to the track as a projection hint. */
  hint: number;

  /*
   * Events as monotonic counters rather than flags. The renderer runs after
   * however many fixed steps fitted into the frame — zero, one, or several —
   * so a flag set in one step and cleared in the next could be missed. A
   * counter that only goes up cannot be.
   */
  landings: number;
  lastLanding: number;
  impacts: number;
  lastImpact: number;
}

/** Upgrade multipliers. Stock is all ones; `economy.ts` (M5) supplies the rest. */
export interface CarStats {
  engine: number;
  grip: number;
  turbo: number;
}

export const STOCK: Readonly<CarStats> = Object.freeze({ engine: 1, grip: 1, turbo: 1 });

/** What the car needs to know about the world it drives in. `Track` implements it. */
export interface CarEnv extends WallSource {
  surfaceAt(x: number, z: number, hint: number): Surface;
  groundAt(x: number, z: number, hint: number): number;
  /** Nearest centreline sample, for the next step's hint. */
  project(x: number, z: number, hint: number): { i: number };
}

const C = SIM.car;
const WHEELBASE = C.cgToFront + C.cgToRear;
const G = 9.81;

export const CAR_SHAPE: CapsuleShape = {
  half: C.capsuleHalf,
  radius: C.radius,
  mass: C.mass,
  inertia: C.inertia,
  bounce: C.wallBounce,
  friction: C.wallFriction,
};

export function createCar(x: number, z: number, yaw: number): CarState {
  return {
    x, z, yaw, vx: 0, vz: 0, w: 0, y: 0, vy: 0, airborne: false, steer: 0, turbo: C.turboCapacity,
    forward: 0, slip: 0, drifting: false, handbrake: false, braking: false, throttle: 0, boosting: false,
    accelLong: 0, accelLat: 0, surfaceFront: Surface.Tarmac, surfaceRear: Surface.Tarmac, hint: -1,
    landings: 0, lastLanding: 0, impacts: 0, lastImpact: 0,
  };
}

/** Steering lock tightens with speed: full lock at 45 m/s would spin any car. */
export function steerLimit(speed: number): number {
  return C.maxSteer / (1 + Math.abs(speed) / C.steerHalfSpeed);
}

/**
 * Advance one car by `dt` (one fixed step).
 *
 * Internally the step is split into substeps so that the car moves at most
 * half its collision radius per substep — see `collide.ts` for why that makes
 * tunnelling impossible — and never fewer than two, which keeps the stiff
 * tyre model stable at 60 Hz.
 */
export function stepCar(car: CarState, intent: DriveIntent, env: CarEnv, dt: number, stats: CarStats = STOCK): void {
  const speed0 = Math.hypot(car.vx, car.vz);
  const n = Math.min(24, Math.max(2, Math.ceil((speed0 * dt) / (0.5 * C.radius))));
  const h = dt / n;

  const fx0 = Math.sin(car.yaw), fz0 = Math.cos(car.yaw);
  const u0 = car.vx * fx0 + car.vz * fz0;
  const v0 = car.vx * fz0 - car.vz * fx0;

  car.handbrake = intent.handbrake && !car.airborne;
  car.throttle = intent.throttle;
  car.boosting = false;
  car.braking = false;

  for (let k = 0; k < n; k++) substep(car, intent, env, h, stats);

  // Body-frame acceleration over the whole step, for body roll and pitch.
  const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
  const u = car.vx * fx + car.vz * fz;
  const v = car.vx * fz - car.vz * fx;
  car.accelLong = (u - u0) / dt;
  car.accelLat = (v - v0) / dt;
  car.forward = u;
  const speed = Math.hypot(car.vx, car.vz);
  car.slip = speed > 1 ? Math.atan2(v, Math.abs(u)) : 0;
  car.drifting = !car.airborne && speed > 8 && (Math.abs(car.slip) > C.driftSlip || car.handbrake);
  car.hint = env.project(car.x, car.z, car.hint).i;
}

function substep(car: CarState, intent: DriveIntent, env: CarEnv, h: number, stats: CarStats): void {
  const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
  const lx = fz, lz = -fx;
  const u = car.vx * fx + car.vz * fz;
  const v = car.vx * lx + car.vz * lz;
  const speed = Math.hypot(u, v);

  // --- Steering: the rack slews towards the wheel, and follows a slide. ---
  let target = car.steer;
  if (!car.airborne) {
    target = -intent.steer * steerLimit(u);
    // Counter-steer assist: the front wheels lean towards the direction of
    // travel, so a slide is caught rather than spun. Without it a keyboard
    // player — who has full lock or nothing — cannot hold a drift at all.
    if (u > 2) target += C.counterSteer * Math.max(-0.5, Math.min(0.5, Math.atan2(v, u)));
  }
  const maxDelta = C.steerRate * h;
  car.steer += Math.max(-maxDelta, Math.min(maxDelta, target - car.steer));

  if (car.airborne) {
    // Ballistic. No traction and no steering: whatever you left the ramp with,
    // you land with.
    car.x += car.vx * h;
    car.z += car.vz * h;
    car.yaw += car.w * h;
    car.w *= 1 - 0.3 * h;
    car.vy -= SIM.gravity * h;
    car.y += car.vy * h;
    const ground = env.groundAt(car.x, car.z, car.hint);
    if (car.y <= ground) {
      const impulse = -car.vy;
      car.y = ground;
      car.vy = 0;
      car.airborne = false;
      car.landings++;
      car.lastLanding = impulse;
      if (impulse > C.hardLandingSpeed) {
        car.vx *= 1 - C.hardLandingLoss;
        car.vz *= 1 - C.hardLandingLoss;
      }
    }
    hitWalls(car, env);
    return;
  }

  // --- Surfaces, per axle. ---
  const sf = env.surfaceAt(car.x + fx * C.cgToFront, car.z + fz * C.cgToFront, car.hint);
  const sr = env.surfaceAt(car.x - fx * C.cgToRear, car.z - fz * C.cgToRear, car.hint);
  car.surfaceFront = sf;
  car.surfaceRear = sr;
  const gripF = C.grip * SURFACES[sf].grip * stats.grip;
  let gripR = C.grip * SURFACES[sr].grip * stats.grip;
  if (car.handbrake) gripR *= C.handbrakeGrip;

  // Static axle loads. Weight transfer is left out: it adds realism nobody can
  // see from 70 m up and makes the handling harder to tune.
  const nF = (C.mass * G * C.cgToRear) / WHEELBASE;
  const nR = (C.mass * G * C.cgToFront) / WHEELBASE;
  const maxR = gripR * nR;

  // --- Longitudinal: drive, brakes, reverse. ---
  let drive = 0;
  let decel = 0; // magnitude of a deceleration that must not overshoot zero speed
  const throttle = intent.throttle;
  const brake = intent.brake;

  if (car.handbrake) {
    decel += C.handbrakeDecel;
  } else if (brake > 0 && u > 0.5) {
    decel += (C.brakeForce * brake) / C.mass;
    car.braking = true;
  } else if (throttle > 0 && u < -0.5) {
    decel += (C.brakeForce * throttle) / C.mass;
    car.braking = true;
  } else if (brake > 0) {
    const r = Math.min(1, Math.abs(Math.min(0, u)) / C.reverseTopSpeed);
    drive = -C.reverseForce * brake * (1 - r * r);
  } else if (throttle > 0) {
    let top = C.topSpeed * (0.85 + 0.15 * stats.engine);
    let force = C.engineForce * stats.engine;
    if (intent.turbo && car.turbo > 0) {
      top += C.turboTopSpeed;
      force += C.turboForce * stats.turbo;
      car.turbo = Math.max(0, car.turbo - h);
      car.boosting = true;
    }
    const r = Math.max(0, u) / top;
    drive = force * throttle * Math.max(0, 1 - r * r * r);
  } else {
    decel += C.coastDecel;
  }
  // Four-wheel drive, split towards the rear so the throttle still steers the
  // tail. Wheelspin is not modelled: the tyres can only push as hard as they grip.
  const maxF = gripF * nF;
  const traction = maxF + maxR;
  drive = Math.max(-traction, Math.min(traction, drive));
  const driveR = drive * C.driveRear;
  const driveF = drive - driveR;

  const surfaceDrag = (SURFACES[sf].drag + SURFACES[sr].drag) / 2;
  decel += surfaceDrag;

  // --- Lateral: slip angles per axle. ---
  // Against a floor speed, not the real one: at walking pace the slip angle is
  // a ratio of two tiny numbers, and a stiff tyre acting on it rings.
  const floor = C.slipFloorSpeed;
  const cs = Math.cos(car.steer), sn = Math.sin(car.steer);
  const vFront = v + C.cgToFront * car.w;
  const wheelLong = u * cs + vFront * sn;
  const wheelLat = -u * sn + vFront * cs;
  const alphaF = Math.atan2(wheelLat, Math.max(Math.abs(wheelLong), floor));
  // Friction circles: whatever grip the drive force uses is not there for cornering.
  const latF = Math.sqrt(Math.max(0, maxF * maxF - driveF * driveF));
  const fyF = Math.max(-latF, Math.min(latF, -C.stiffnessFront * alphaF));

  const vRear = v - C.cgToRear * car.w;
  const alphaR = Math.atan2(vRear, Math.max(Math.abs(u), floor));
  const latR = Math.sqrt(Math.max(0, maxR * maxR - driveR * driveR));
  const fyR = Math.max(-latR, Math.min(latR, -C.stiffnessRear * alphaR));

  // Front forces act in the wheel's frame, turned by the steering angle.
  const fLong = driveR + driveF * cs - fyF * sn - C.drag * u * Math.abs(u);
  const fLat = driveF * sn + fyF * cs + fyR;
  const torque = C.cgToFront * (driveF * sn + fyF * cs) - C.cgToRear * fyR;

  // --- Integrate in the world frame (no rotating-frame terms needed). ---
  car.vx += ((fLong * fx + fLat * lx) / C.mass) * h;
  car.vz += ((fLong * fz + fLat * lz) / C.mass) * h;
  car.w += (torque / C.inertia) * h;

  // Decelerations act along the direction of motion and stop at zero rather
  // than reversing it.
  if (decel > 0) {
    const sp = Math.hypot(car.vx, car.vz);
    const cut = decel * h;
    if (sp <= cut) {
      car.vx = 0;
      car.vz = 0;
    } else {
      car.vx -= (car.vx / sp) * cut;
      car.vz -= (car.vz / sp) * cut;
    }
  }

  // Parked: kill the residual creep and spin a stiff model leaves behind.
  if (speed < 0.3 && throttle === 0 && brake === 0) {
    car.vx *= 0.8;
    car.vz *= 0.8;
    car.w *= 0.8;
  }

  car.yaw += car.w * h;
  car.x += car.vx * h;
  car.z += car.vz * h;

  // --- Height: follow the ground, and leave it when it drops away. ---
  const ground = env.groundAt(car.x, car.z, car.hint);
  if (ground >= car.y - 0.05) {
    car.vy = (ground - car.y) / h;
    car.y = ground;
  } else {
    // The ramp ended under us. Keep the climb rate it gave us: that is the launch.
    car.airborne = true;
  }

  hitWalls(car, env);

  // The turbo meter trickles back when it is not in use.
  if (!car.boosting && car.turbo < C.turboCapacity * stats.turbo) {
    car.turbo = Math.min(C.turboCapacity * stats.turbo, car.turbo + h * 0.08);
  }
}

function hitWalls(car: CarState, env: CarEnv): void {
  const hit = resolveWalls(car, CAR_SHAPE, env);
  if (hit > 0) {
    car.impacts++;
    car.lastImpact = hit;
  }
}
