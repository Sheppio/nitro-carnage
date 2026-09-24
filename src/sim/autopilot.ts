import { SIM } from '../config.js';
import type { DriveIntent } from '../types.js';
import { mulberry32, wrapAngle } from '../util.js';
import { steerLimit } from './car.js';
import type { CarState } from './car.js';
import type { RacingLine } from './racingLine.js';
import type { Track } from './track/buildTrack.js';

const WHEELBASE = SIM.car.cgToFront + SIM.car.cgToRear;

/** How good a driver is. Three numbers, so a grid of bots can be tuned by eye. */
export interface Skill {
  /** Fraction of the racing line's planned speed the driver dares, 0.8-1. */
  pace: number;
  /** How far the driver drifts off the ideal line, metres. */
  wander: number;
  /** Whether the driver uses the turbo on straights. */
  turbo: boolean;
}

export const SKILLS: readonly Skill[] = [
  { pace: 0.97, wander: 0.4, turbo: true },
  { pace: 0.94, wander: 0.8, turbo: true },
  { pace: 0.92, wander: 1.0, turbo: true },
  { pace: 0.9, wander: 1.2, turbo: false },
  { pace: 0.88, wander: 1.4, turbo: true },
  { pace: 0.86, wander: 1.6, turbo: false },
];

/** What the autopilot needs to know about another car. */
export interface Rival {
  id: string;
  x: number;
  z: number;
  vx: number;
  vz: number;
  s: number;
  d: number;
}

export interface AutopilotState {
  skill: Skill;
  /** Phase of the slow wander off the line. */
  phase: number;
  /** Lateral shift for an overtake, metres, and until when. */
  shift: number;
  shiftUntil: number;
  /** Seconds left of reversing out of trouble. */
  recover: number;
  recoverSteer: number;
  /** Seconds spent crawling while trying to go. */
  stuck: number;
  /** Smoothed steering output. */
  steer: number;
}

export function createAutopilot(seed: number, skill: Skill): AutopilotState {
  const rand = mulberry32(seed);
  return { skill, phase: rand() * Math.PI * 2, shift: 0, shiftUntil: 0, recover: 0, recoverSteer: 0, stuck: 0, steer: 0 };
}

/**
 * One step of self-driving.
 *
 * Pure pursuit on the racing line: aim at a point on the line a speed-scaled
 * distance ahead and steer the arc that reaches it. Throttle and brake chase
 * the line's speed profile, looked up a little ahead so the brakes go on at
 * the braking point rather than at the corner. Around that: overtaking (shift
 * off the line when a slower car is in the way), turbo on straights, and
 * recovery (back out of a wall rather than grinding into it).
 *
 * The same policy drives the bots, the self-driving test clients, and the
 * "autopilot completes a lap on every track" test.
 */
export function autopilot(
  st: AutopilotState, car: CarState, track: Track, line: RacingLine, rivals: readonly Rival[], time: number, dt: number,
): DriveIntent {
  const out: DriveIntent = { throttle: 0, brake: 0, steer: 0, handbrake: false, fireFront: false, fireRear: false, turbo: false };
  const p = track.project(car.x, car.z, car.hint);
  const v = Math.hypot(car.vx, car.vz);
  const pose = track.poseAt(p.s);
  const headingError = wrapAngle(car.yaw - pose.yaw);

  // --- Recovery: reverse out, steering the other way. ---
  if (st.recover > 0) {
    st.recover -= dt;
    out.brake = 1;
    out.steer = st.recoverSteer;
    return out;
  }
  if (v < 1.5) st.stuck += dt;
  else st.stuck = 0;
  if (st.stuck > 1.2 || (v < 2 && Math.abs(headingError) > 1.4)) {
    st.stuck = 0;
    st.recover = 1.1;
    // Reversing swings the nose the opposite way to the wheel: to point the
    // nose back up the road, steer away from it.
    st.recoverSteer = headingError > 0 ? -1 : 1;
    out.brake = 1;
    out.steer = st.recoverSteer;
    return out;
  }

  const spacing = track.length / track.n;
  const idx = (s: number): number => Math.floor(track.wrapS(s) / spacing) % track.n;

  // --- Overtaking: a slower car close ahead in our lane. ---
  const myOffset = line.offset[idx(p.s)]! + st.shift;
  let ahead: Rival | null = null;
  let aheadGap = Infinity;
  for (const r of rivals) {
    const gap = track.deltaS(p.s, r.s);
    if (gap <= 0 || gap > 18) continue;
    if (Math.abs(r.d - myOffset) > 2.6) continue;
    if (gap < aheadGap) {
      aheadGap = gap;
      ahead = r;
    }
  }
  if (ahead && time >= st.shiftUntil) {
    const theirSpeed = Math.hypot(ahead.vx, ahead.vz);
    if (v > theirSpeed + 0.5) {
      const room = track.halfWidth - 1.4;
      // Go round on the side with more road.
      const side = ahead.d > 0 ? -1 : 1;
      st.shift = side * Math.min(3.4, room - Math.abs(ahead.d) + 1);
      st.shiftUntil = time + 1.6;
    }
  }
  if (time >= st.shiftUntil) st.shift *= Math.max(0, 1 - dt * 1.5);

  // --- Steering: pure pursuit on the (shifted, wandering) line. ---
  const look = 5 + v * 0.42;
  const ti = idx(p.s + look);
  const limit = track.halfWidth - 1.3;
  const wander = st.skill.wander * Math.sin(time * 0.35 + st.phase);
  let off = Math.max(-limit, Math.min(limit, line.offset[ti]! + st.shift + wander));
  // A car alongside: hold a lane's width off it rather than steer onto the
  // racing line through it. Without this, the two cars in every grid row
  // turned into each other the moment the lights went green.
  const myD = p.d;
  for (const r of rivals) {
    const gap = track.deltaS(p.s, r.s);
    if (Math.abs(gap) > 5.5) continue;
    const lane = 2.9;
    if (r.d > myD && off > r.d - lane) off = Math.min(off, r.d - lane);
    else if (r.d <= myD && off < r.d + lane) off = Math.max(off, r.d + lane);
  }
  off = Math.max(-limit, Math.min(limit, off));
  const [gx, gz] = track.offsetPoint(ti, off);
  const dx = gx - car.x, dz = gz - car.z;
  const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
  const fwd = dx * fx + dz * fz;
  const left = dx * fz - dz * fx;
  const dist = Math.hypot(dx, dz) || 1;
  const alpha = Math.atan2(left, fwd);
  const wheel = Math.atan((2 * Math.sin(alpha) * WHEELBASE) / dist);
  const want = Math.max(-1, Math.min(1, -wheel / steerLimit(car.forward)));
  // Ease the output: pure pursuit re-decides every step, and a 60 Hz twitch
  // reads on screen as a car vibrating.
  st.steer += (want - st.steer) * Math.min(1, dt * 14);
  out.steer = st.steer;

  // --- Speed: chase the profile, looked up a reaction time ahead. ---
  let target = line.speed[idx(p.s + v * 0.3 + 2)]! * st.skill.pace;
  // Boxed in behind a car we are not passing: follow it rather than rear-end it.
  if (ahead && aheadGap < 9 && Math.abs(st.shift) < 1) target = Math.min(target, Math.hypot(ahead.vx, ahead.vz));
  const err = target - v;
  if (err > 0.3) {
    out.throttle = Math.min(1, 0.45 + err * 0.25);
  } else if (err < -1.2) {
    out.brake = Math.min(1, 0.3 + -err * 0.12);
  } else {
    out.throttle = 0.3;
  }

  // Turbo where the profile says flat out for a good while yet.
  if (st.skill.turbo && car.turbo > 1 && out.throttle > 0.9) {
    let straight = true;
    for (let a = 0; a < 60 && straight; a += 6) straight = line.speed[idx(p.s + a)]! >= SIM.car.topSpeed * 0.85;
    out.turbo = straight;
  }
  return out;
}
