import { SIM } from '../config.js';
import { mulberry32, wrapAngle } from '../util.js';
import { steerLimit } from './car.js';
import { SURFACES } from './surfaces.js';
const WHEELBASE = SIM.car.cgToFront + SIM.car.cgToRear;
export const SKILLS = [
    { pace: 1.0, wander: 0.4, turbo: true, trigger: 3.5 },
    { pace: 0.985, wander: 0.7, turbo: true, trigger: 4.5 },
    { pace: 0.97, wander: 0.9, turbo: true, trigger: 4 },
    { pace: 0.96, wander: 1.0, turbo: false, trigger: 6 },
    { pace: 0.95, wander: 1.2, turbo: true, trigger: 5 },
    { pace: 0.94, wander: 1.4, turbo: false, trigger: 7 },
];
/** A front shot is taken at a rival within this cone either side of the nose, radians... */
const FIRE_CONE = (6 * Math.PI) / 180;
/** ...and this far ahead along the road, metres: far enough to be worth it, near enough to be on the same straight. */
const FIRE_RANGE = 55;
/** A mine or rear missile goes back at a rival this close behind, metres, and this near our line. */
const REAR_RANGE = 15;
const REAR_LANE = 1.6;
export function createAutopilot(seed, skill) {
    const rand = mulberry32(seed);
    return { skill, phase: rand() * Math.PI * 2, shift: 0, shiftUntil: 0, recover: 0, recoverSteer: 0, stuck: 0, steer: 0, fireAt: 0 };
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
export function autopilot(st, car, track, line, rivals, time, dt, stopAt = null) {
    const out = { throttle: 0, brake: 0, steer: 0, handbrake: false, fireFront: false, fireRear: false, turbo: false };
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
    if (v < 1.5)
        st.stuck += dt;
    else
        st.stuck = 0;
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
    const idx = (s) => Math.floor(track.wrapS(s) / spacing) % track.n;
    // --- Overtaking: a slower car close ahead in our lane. ---
    const myOffset = line.offset[idx(p.s)] + st.shift;
    let ahead = null;
    let aheadGap = Infinity;
    for (const r of rivals) {
        const gap = track.deltaS(p.s, r.s);
        if (gap <= 0 || gap > 18)
            continue;
        if (Math.abs(r.d - myOffset) > 2.6)
            continue;
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
    if (time >= st.shiftUntil)
        st.shift *= Math.max(0, 1 - dt * 1.5);
    // --- Steering: pure pursuit on the (shifted, wandering) line. ---
    const look = 5 + v * 0.42;
    const ti = idx(p.s + look);
    const limit = track.halfWidth - 1.3;
    const wander = st.skill.wander * Math.sin(time * 0.35 + st.phase);
    let off = Math.max(-limit, Math.min(limit, line.offset[ti] + st.shift + wander));
    // A car alongside: hold a lane's width off it rather than steer onto the
    // racing line through it. Without this, the two cars in every grid row
    // turned into each other the moment the lights went green.
    const myD = p.d;
    for (const r of rivals) {
        const gap = track.deltaS(p.s, r.s);
        if (Math.abs(gap) > 5.5)
            continue;
        const lane = 2.9;
        if (r.d > myD && off > r.d - lane)
            off = Math.min(off, r.d - lane);
        else if (r.d <= myD && off < r.d + lane)
            off = Math.max(off, r.d + lane);
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
    let target = line.speed[idx(p.s + v * 0.3 + 2)] * st.skill.pace;
    // The line was planned for tarmac. Off it, a corner's speed scales with the
    // square root of the grip: on grass that is about three quarters.
    const grip = Math.min(SURFACES[car.surfaceFront].grip, SURFACES[car.surfaceRear].grip);
    if (grip < 1)
        target *= Math.sqrt(grip);
    // Boxed in behind a car we are not passing: follow it rather than rear-end it.
    if (ahead && aheadGap < 9 && Math.abs(st.shift) < 1)
        target = Math.min(target, Math.hypot(ahead.vx, ahead.vz));
    // A stop line ahead (a level crossing with a train due): brake to stand
    // short of it, at a deceleration the brakes manage with room to spare.
    if (stopAt !== null) {
        const toStop = track.deltaS(p.s, stopAt);
        if (toStop > -1 && toStop < 160)
            target = Math.min(target, Math.sqrt(2 * 10 * Math.max(0, toStop - 2)));
    }
    const err = target - v;
    if (target < 0.5 && v < 2) {
        // Waiting at the line: hold still rather than creep, or back out of it.
        out.throttle = 0;
        out.brake = 0;
        out.handbrake = true;
        return out;
    }
    if (err > 0.3) {
        out.throttle = Math.min(1, 0.45 + err * 0.25);
    }
    else if (err < -1.2) {
        out.brake = Math.min(1, 0.3 + -err * 0.12);
    }
    else {
        out.throttle = 0.3;
    }
    // Traction control: sliding, the drive force only eats the grip that is
    // holding the car in the corner. Full throttle through a fast sweeper ran
    // bots wide onto the grass, where they fishtailed from verge to verge.
    const slide = Math.abs(car.slip);
    if (slide > 0.28)
        out.throttle = 0;
    else if (slide > 0.16)
        out.throttle = Math.min(out.throttle, 0.4);
    aim(st, out, car, p.s, p.d, track, rivals, time);
    // Turbo where the profile says flat out for a good while yet.
    if (st.skill.turbo && car.turbo > 1 && out.throttle > 0.9) {
        let straight = true;
        for (let a = 0; a < 60 && straight; a += 6)
            straight = line.speed[idx(p.s + a)] >= SIM.car.topSpeed * 0.85;
        out.turbo = straight;
    }
    return out;
}
/**
 * Weapons: a front missile at a rival in a narrow cone ahead and on the same
 * stretch of road; a mine (or a rear missile) at one right behind and on our
 * line. The world ignores a trigger with no ammo behind it, so this does not
 * count ammo — it only paces itself, by the driver's `trigger` interval, so a
 * bot does not empty its rack into the first car it sees.
 */
function aim(st, out, car, s, d, track, rivals, time) {
    if (time < st.fireAt)
        return;
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    for (const r of rivals) {
        if (!r.target)
            continue;
        const gap = track.deltaS(s, r.s);
        if (gap > 4 && gap < FIRE_RANGE) {
            const dx = r.x - car.x, dz = r.z - car.z;
            const bearing = Math.atan2(dx * fz - dz * fx, dx * fx + dz * fz);
            if (Math.abs(bearing) < FIRE_CONE) {
                out.fireFront = true;
                st.fireAt = time + st.skill.trigger;
                return;
            }
        }
        if (gap < -3 && gap > -REAR_RANGE && Math.abs(r.d - d) < REAR_LANE) {
            out.fireRear = true;
            st.fireAt = time + st.skill.trigger;
            return;
        }
    }
}
//# sourceMappingURL=autopilot.js.map