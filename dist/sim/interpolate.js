import { lerp, lerpAngle } from '../util.js';
/**
 * The car as it would be `alpha` of the way from its previous fixed step to
 * its current one.
 *
 * The simulation steps at 60 Hz and the screen refreshes at whatever it
 * likes. Drawing the latest step as-is makes a 144 Hz monitor show each
 * position two or three times and then jump: judder that reads as the car
 * stuttering. Interpolating costs one step of latency (16 ms) and removes it.
 * Only pose is blended; everything else is taken from the current step.
 */
export function interpolateCar(prev, cur, alpha, out) {
    Object.assign(out, cur);
    out.x = lerp(prev.x, cur.x, alpha);
    out.z = lerp(prev.z, cur.z, alpha);
    out.y = lerp(prev.y, cur.y, alpha);
    out.yaw = lerpAngle(prev.yaw, cur.yaw, alpha);
    out.steer = lerp(prev.steer, cur.steer, alpha);
    out.vx = lerp(prev.vx, cur.vx, alpha);
    out.vz = lerp(prev.vz, cur.vz, alpha);
    return out;
}
//# sourceMappingURL=interpolate.js.map