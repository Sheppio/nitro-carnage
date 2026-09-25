import { wrapAngle } from '../util.js';
/**
 * The hotlap ghost: a lap recorded as a list of poses and played back.
 *
 * Poses are taken at a fixed rate from the moment the lap starts, so a
 * sample's time is its index, and nothing but the poses need be stored.
 * They are kept quantised — decimetres, milliradians — as a flat array of
 * integers, which is what goes into `localStorage` with the lap record:
 * about 1,400 small numbers for a 45 s lap, a few kilobytes.
 *
 * Playback interpolates between samples, turning the shorter way, so the
 * ghost at 60 fps is as smooth as the car.
 */
/** Samples a second. */
export const GHOST_HZ = 10;
/** One lap's worth of recording in progress. */
export class LapTrace {
    data = [];
    next = 0;
    /**
     * Offer the car's pose `t` seconds into the lap; it is kept whenever a
     * sample is due. Called every frame; keeps one every 1/GHOST_HZ seconds.
     */
    offer(t, x, z, yaw) {
        while (t >= this.next / GHOST_HZ) {
            this.data.push(Math.round(x * 10), Math.round(z * 10), Math.round(wrapAngle(yaw) * 1000));
            this.next++;
        }
    }
}
/** Is this a plausible recording (from storage, so not to be trusted)? */
export function validTrace(data) {
    return Array.isArray(data) && data.length >= 6 && data.length % 3 === 0 && data.every((n) => Number.isInteger(n));
}
/** Where the recorded car was `t` seconds into its lap, or null past its end. */
export function ghostAt(data, t) {
    const n = data.length / 3;
    const f = t * GHOST_HZ;
    if (f < 0 || f > n - 1)
        return null;
    const i = Math.min(n - 2, Math.floor(f));
    const k = f - i;
    const x0 = data[i * 3] / 10, z0 = data[i * 3 + 1] / 10, y0 = data[i * 3 + 2] / 1000;
    const x1 = data[i * 3 + 3] / 10, z1 = data[i * 3 + 4] / 10, y1 = data[i * 3 + 5] / 1000;
    return {
        x: x0 + (x1 - x0) * k,
        z: z0 + (z1 - z0) * k,
        yaw: y0 + wrapAngle(y1 - y0) * k,
        speed: Math.hypot(x1 - x0, z1 - z0) * GHOST_HZ,
    };
}
//# sourceMappingURL=ghost.js.map