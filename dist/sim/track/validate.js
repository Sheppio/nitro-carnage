import { closestSegSeg } from '../collide.js';
/** Lap length an arcade circuit should have, metres (PLAN.md §3.4). */
export const LAP_MIN = 600;
export const LAP_MAX = 1400;
/** Closest two stretches of road that are not neighbours along the lap may come, centre to centre. */
export const MIN_SEPARATION = 40;
/**
 * Everything that makes a track drivable, checked on a built `Track`:
 * a lap of arcade length, every corner wide enough for its inside wall, no
 * wall crossing another, the road clear of the walls, and no two stretches
 * of road so close they would share a wall.
 *
 * The launch tracks are held to it by the tests; the generator (M7) holds
 * every candidate to it and throws away any that fail.
 *
 * @returns null when the track is fine, or the first reason it is not
 */
export function validateTrack(t, opts = {}) {
    const minSeparation = opts.minSeparation ?? t.def.minSeparation ?? MIN_SEPARATION;
    if (t.length < LAP_MIN || t.length > LAP_MAX)
        return `lap ${t.length.toFixed(0)} m`;
    let minR = Infinity;
    for (let i = 0; i < t.n; i++) {
        const k = Math.abs(t.line.curvature[i]);
        if (k > 1e-6)
            minR = Math.min(minR, 1 / k);
    }
    if (minR <= t.wallOffset + 1)
        return `corner radius ${minR.toFixed(1)} m`;
    // Two stretches of road far apart along the lap but near in space.
    const step = 3;
    for (let i = 0; i < t.n; i += step) {
        for (let j = i + step; j < t.n; j += step) {
            const along = Math.min(j - i, t.n - (j - i));
            if (along < 60)
                continue;
            const d = Math.hypot(t.line.px[i] - t.line.px[j], t.line.pz[i] - t.line.pz[j]);
            if (d < minSeparation)
                return `road passes itself ${d.toFixed(0)} m apart`;
        }
    }
    const w = t.walls;
    const tmp = { ax: 0, az: 0, bx: 0, bz: 0 };
    for (let a = 0; a < t.wallCount; a++) {
        const o = a * 6;
        let crossed = false;
        t.forWallsNear(Math.min(w[o], w[o + 2]), Math.min(w[o + 1], w[o + 3]), Math.max(w[o], w[o + 2]), Math.max(w[o + 1], w[o + 3]), (b) => {
            if (crossed || b <= a)
                return;
            const p = b * 6;
            // Neighbouring segments share an end; that is a joint, not a crossing.
            for (const [x, z] of [[w[o], w[o + 1]], [w[o + 2], w[o + 3]]]) {
                for (const [y, v] of [[w[p], w[p + 1]], [w[p + 2], w[p + 3]]]) {
                    if (Math.abs(x - y) < 1e-9 && Math.abs(z - v) < 1e-9)
                        return;
                }
            }
            if (closestSegSeg(w[o], w[o + 1], w[o + 2], w[o + 3], w[p], w[p + 1], w[p + 2], w[p + 3], tmp) < 1e-6)
                crossed = true;
        });
        if (crossed)
            return 'walls cross';
    }
    return null;
}
//# sourceMappingURL=validate.js.map