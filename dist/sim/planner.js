import { SIM } from '../config.js';
import { wrapAngle } from '../util.js';
import { stepCar, steerLimit } from './car.js';
/**
 * Corner technique for the best bots (#5), found rather than scripted.
 *
 * Driven neatly on its grip, the car is held back by its own steering: the
 * lock tightens with speed until the front tyres cannot use all their grip.
 * A good driver gets past that by getting the car sideways — the throttle
 * flat to hold the tail out, a stab of handbrake, a Scandinavian flick away
 * from the corner and back — and a slide past the stability aid's limit is
 * swung back towards the nose, which turns the car harder still.
 *
 * Which of those a corner wants depends on everything at once, so the bot
 * tries them out: every few steps it copies its car, drives each move a
 * second ahead with the same physics every car has, and keeps the one that
 * gets furthest down the road without touching a wall, ending on the line,
 * pointing up the road, and no faster than the road ahead allows.
 */
const WHEELBASE = SIM.car.cgToFront + SIM.car.cgToRear;
/** How far ahead a move is tried, seconds, and in what steps. */
const HORIZON = 1;
const DT = 1 / 15;
/** World steps between plans. */
export const PLAN_EVERY = 4;
const YAW_DAMP = 0.8;
const m = (lean, pedal, until = Infinity, handbrake = false) => ({ lean, pedal, handbrake, until });
export const PLANS = [
    { name: 'neat', moves: [m(0, 'neat')] },
    { name: 'neat in', moves: [m(0.3, 'neat')] },
    { name: 'flat', moves: [m(0, 'flat')] },
    { name: 'flat in', moves: [m(0.35, 'flat')] },
    { name: 'flat hard in', moves: [m(0.7, 'flat')] },
    { name: 'flat out', moves: [m(-0.3, 'flat')] },
    { name: 'lift, flat', moves: [m(0, 'lift', 0.2), m(0, 'flat')] },
    { name: 'brake, flat', moves: [m(0, 'brake', 0.25), m(0.3, 'flat')] },
    { name: 'brake, neat', moves: [m(0, 'brake', 0.25), m(0, 'neat')] },
    { name: 'handbrake, flat', moves: [m(0.4, 'flat', 0.2, true), m(0, 'flat')] },
    { name: 'handbrake, lift', moves: [m(0.6, 'lift', 0.3, true), m(0, 'flat')] },
    { name: 'flick', moves: [m(-0.8, 'lift', 0.15), m(0.9, 'flat', 0.45), m(0, 'flat')] },
    { name: 'flick, handbrake', moves: [m(-0.8, 'lift', 0.15), m(0.9, 'lift', 0.35, true), m(0, 'flat')] },
];
export function createPlanState() {
    return { plan: null, age: 0, dir: 1, wait: 0 };
}
/** What a move does to the controls, for a car at this moment. */
export function moveIntent(move, dir, car, track, line, pace, shift, out) {
    const spacing = track.length / track.n;
    const idx = (s) => Math.floor(track.wrapS(s) / spacing) % track.n;
    const p = track.project(car.x, car.z, car.hint);
    const v = Math.hypot(car.vx, car.vz);
    // Pure pursuit on the line, as the neat driver steers (see autopilot.ts).
    const look = Math.max(8, 3 + v * 0.2);
    const ti = idx(p.s + look);
    const limit = track.halfWidth - 1.3;
    const off = Math.max(-limit, Math.min(limit, line.offset[ti] + shift));
    const [gx, gz] = track.offsetPoint(ti, off);
    const dx = gx - car.x, dz = gz - car.z;
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    const dist = Math.hypot(dx, dz) || 1;
    const alpha = Math.atan2(dx * fz - dz * fx, dx * fx + dz * fz);
    const wheel = Math.atan((2 * Math.sin(alpha) * WHEELBASE) / dist);
    const wantRate = (v * 2 * Math.sin(alpha)) / dist;
    const damp = move.pedal === 'neat' ? YAW_DAMP * (car.w - wantRate) : 0;
    out.steer = Math.max(-1, Math.min(1, -wheel / steerLimit(car.forward) + damp + move.lean * dir));
    out.handbrake = move.handbrake;
    out.throttle = 0;
    out.brake = 0;
    if (move.pedal === 'flat')
        out.throttle = 1;
    else if (move.pedal === 'brake')
        out.brake = 1;
    else if (move.pedal === 'neat') {
        const err = line.speed[idx(p.s + v * 0.3 + 2)] * pace - v;
        if (err > 0.3)
            out.throttle = Math.min(1, 0.45 + err * 0.25);
        else if (err < -1.2)
            out.brake = Math.min(1, 0.3 + -err * 0.12);
        else
            out.throttle = 0.3;
        const slide = Math.abs(car.slip);
        if (slide > 0.28)
            out.throttle = 0;
        else if (slide > 0.16)
            out.throttle = Math.min(out.throttle, 0.4);
    }
    return out;
}
/** The move a plan makes `age` seconds in. */
export function moveAt(plan, age) {
    for (const mv of plan.moves)
        if (age < mv.until)
            return mv;
    return plan.moves[plan.moves.length - 1];
}
/** Worth planning here: a bend ahead the grip alone cannot take at this speed, or a slide to finish. */
export function technical(car, track, line, s) {
    const v = Math.hypot(car.vx, car.vz);
    if (Math.abs(car.slip) > 0.15)
        return true;
    const spacing = track.length / track.n;
    for (let a = 0; a <= v * HORIZON; a += 3) {
        const i = Math.floor(track.wrapS(s + a) / spacing) % track.n;
        if (line.driftSpeed[i] > line.speed[i] + 1 || v * v * Math.abs(line.curvature[i]) > 14)
            return true;
    }
    return false;
}
const scratch = { throttle: 0, brake: 0, steer: 0, handbrake: false, fireFront: false, fireRear: false, turbo: false };
/** Metres a plan is worth: road covered, less what its ending will cost. */
function score(plan, dir, car0, track, line, pace, shift, s0) {
    const car = { ...car0 };
    const hits0 = car.impacts;
    for (let t = 0; t < HORIZON - 1e-9; t += DT) {
        moveIntent(moveAt(plan, t), dir, car, track, line, pace, shift, scratch);
        stepCar(car, scratch, track, DT);
    }
    const p = track.project(car.x, car.z, car.hint);
    const spacing = track.length / track.n;
    const i = Math.floor(p.s / spacing) % track.n;
    const v = Math.hypot(car.vx, car.vz);
    let value = track.deltaS(s0, p.s);
    value -= 25 * (car.impacts - hits0);
    // Off the line, and worse, off the road.
    value -= Math.max(0, Math.abs(p.d - line.offset[i]) - 2);
    value -= 6 * Math.max(0, Math.abs(p.d) - (track.halfWidth - 1.3));
    // Going faster than the road ahead allows is speed to brake away, or a wall.
    let safe = Infinity;
    for (let a = 0; a <= 12; a += 3)
        safe = Math.min(safe, line.driftSpeed[Math.floor(track.wrapS(p.s + a) / spacing) % track.n] * pace);
    value -= 1.5 * Math.max(0, v - safe);
    // Travelling across the road rather than along it.
    if (v > 3) {
        const pose = track.poseAt(p.s);
        const heading = Math.atan2(car.vx, car.vz);
        value -= 10 * Math.max(0, Math.abs(wrapAngle(heading - pose.yaw)) - 0.35);
    }
    return value;
}
/** Choose a plan for now: every one tried a second ahead, the best kept. */
export function choosePlan(ps, car, track, line, pace, shift, s) {
    // Into the corner: the way the line turns over the next second.
    const spacing = track.length / track.n;
    const v = Math.hypot(car.vx, car.vz);
    let turn = 0;
    for (let a = 0; a <= v * HORIZON; a += 3)
        turn += line.curvature[Math.floor(track.wrapS(s + a) / spacing) % track.n];
    // A left turn (positive curvature) is negative steering.
    ps.dir = turn > 0 ? -1 : 1;
    let best = -Infinity;
    for (const plan of PLANS) {
        const value = score(plan, ps.dir, car, track, line, pace, shift, s);
        if (value > best) {
            best = value;
            ps.plan = plan;
        }
    }
    ps.age = 0;
}
//# sourceMappingURL=planner.js.map