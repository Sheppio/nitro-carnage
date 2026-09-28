import { SIM } from '../config.js';
const P = SIM.pickups;
/**
 * Where the boxes stand: `P.rows` rows spread round the lap, each a box per
 * lane. A row goes on the straightest piece of road near its share of the
 * lap, clear of the start line, the ramps and any level crossing. With
 * weapons off every box is turbo: ammo and repairs would do nothing.
 */
export function pickupSpots(track, weapons) {
    const L = track.length;
    const spacing = L / track.n;
    const heading = (s) => track.poseAt(s).yaw;
    const turn = (s) => {
        let d = heading(s + 20) - heading(s - 20);
        while (d > Math.PI)
            d -= 2 * Math.PI;
        while (d < -Math.PI)
            d += 2 * Math.PI;
        return Math.abs(d);
    };
    const near = (s, at, r) => {
        const d = Math.abs(((s - at) % L + L * 1.5) % L - L / 2);
        return d < r;
    };
    const kinds = [['ammo', 'repair', 'turbo'], ['turbo', 'ammo', 'repair'], ['repair', 'turbo', 'ammo']];
    const out = [];
    for (let r = 0; r < P.rows; r++) {
        const target = L * ((r + 0.5) / P.rows);
        let best = -1;
        let bestTurn = Infinity;
        // Search a window round the target, in 5 m steps, for the straightest clear road.
        for (let o = -L * 0.12; o <= L * 0.12; o += 5) {
            const s = (target + o + L) % L;
            // Not on the grid, a ramp or the level crossing.
            if (near(s, 0, 45) || track.ramps.some((rp) => near(s, (rp.s0 + rp.s1) / 2, 30 + (rp.s1 - rp.s0) / 2)))
                continue;
            if (track.rail && near(s, track.rail.s, 30))
                continue;
            const t = turn(s) + Math.abs(o) * 0.0005;
            if (t < bestTurn) {
                bestTurn = t;
                best = s;
            }
        }
        if (best < 0)
            continue;
        const pose = track.poseAt(best);
        const lanes = [-1, 0, 1];
        lanes.forEach((lane, k) => {
            const [x, z] = track.offsetPoint(pose.i, lane * track.halfWidth * 0.55);
            const frac = best / spacing - pose.i;
            out.push({
                x: x + track.line.tx[pose.i] * frac, z: z + track.line.tz[pose.i] * frac, s: best,
                kind: weapons ? kinds[r % kinds.length][k] : 'turbo',
            });
        });
    }
    return out;
}
/** The boxes in one race, and when each is back. */
export class Pickups {
    spots;
    /** World time each box is back on the road; 0 while it is there. */
    back;
    constructor(track, weapons) {
        this.spots = pickupSpots(track, weapons);
        this.back = new Float64Array(this.spots.length);
    }
    /** Whether box `i` is on the road at world time `t`. */
    here(i, t) {
        return t >= (this.back[i] ?? Infinity);
    }
    /** Box `i` was taken at world time `t`: gone until it respawns. Later news of the same take changes nothing. */
    take(i, t) {
        if (i < 0 || i >= this.spots.length)
            return;
        this.back[i] = Math.max(this.back[i], t + P.respawn);
    }
    /** The box a car at (x, z) is touching at time `t`, or -1. */
    touching(x, z, t) {
        const r2 = P.radius * P.radius;
        for (let i = 0; i < this.spots.length; i++) {
            const p = this.spots[i];
            if (this.here(i, t) && (p.x - x) ** 2 + (p.z - z) ** 2 < r2)
                return i;
        }
        return -1;
    }
}
//# sourceMappingURL=pickups.js.map