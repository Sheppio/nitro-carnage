import { SIM } from '../config.js';
import { closestSegSeg } from './collide.js';
const W = SIM.weapons;
/** Where a missile is at world time `t` (clamped to its flight). */
export function missileAt(m, t) {
    const d = m.speed * Math.max(0, Math.min(t, m.end) - m.t0);
    return { x: m.x0 + m.dx * d, z: m.z0 + m.dz * d };
}
/** Whether a mine is armed at world time `t`. */
export const mineArmed = (m, t) => t >= m.armAt;
const seg = { ax: 0, az: 0, bx: 0, bz: 0 };
/**
 * Distance along a ray to the first wall it meets, up to `max`.
 *
 * Walls are one-sided, and only a wall whose face points back at the ray can
 * stop it — the same rule that keeps cars in. The ray is walked in short
 * pieces so the grid query stays a few cells rather than a 120 m box, and
 * the walk stops at the first piece with a hit.
 */
export function castRay(walls, x, z, dx, dz, max) {
    const PIECE = 12;
    const arr = walls.walls;
    for (let from = 0; from < max; from += PIECE) {
        const to = Math.min(max, from + PIECE);
        const ax = x + dx * from, az = z + dz * from;
        const bx = x + dx * to, bz = z + dz * to;
        let best = Infinity;
        walls.forWallsNear(Math.min(ax, bx) - 0.5, Math.min(az, bz) - 0.5, Math.max(ax, bx) + 0.5, Math.max(az, bz) + 0.5, (k) => {
            const o = k * 6;
            const nx = arr[o + 4], nz = arr[o + 5];
            if (dx * nx + dz * nz >= 0)
                return; // travelling out through its back
            const t = raySegment(x, z, dx, dz, arr[o], arr[o + 1], arr[o + 2], arr[o + 3]);
            if (t >= 0 && t < best)
                best = t;
        });
        if (best <= to)
            return Math.max(0, best);
    }
    return max;
}
/** Distance along a unit ray to segment p-q, or -1 if it misses. */
function raySegment(x, z, dx, dz, px, pz, qx, qz) {
    const ex = qx - px, ez = qz - pz;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12)
        return -1;
    const wx = px - x, wz = pz - z;
    const t = (wx * ez - wz * ex) / den;
    const u = (wx * dz - wz * dx) / den;
    return t >= 0 && u >= 0 && u <= 1 ? t : -1;
}
/**
 * Every missile and mine in one race.
 */
export class Armoury {
    walls;
    missiles = [];
    mines = [];
    constructor(walls) {
        this.walls = walls;
    }
    /**
     * Fire a missile from a car at (x, z) facing `yaw` (a rear missile flies
     * the other way). The ray is cast from the car's centre, not the muzzle,
     * so a car with its nose on a wall cannot shoot through it.
     */
    launch(owner, seq, kind, x, z, yaw, t0, live) {
        const spec = W[kind];
        const dir = kind === 'front' ? yaw : yaw + Math.PI;
        const dx = Math.sin(dir), dz = Math.cos(dir);
        const flight = spec.speed * spec.life;
        const toWall = castRay(this.walls, x, z, dx, dz, W.muzzle + flight);
        // The flight starts at the muzzle — or at the wall, if the wall is nearer
        // than the muzzle: a shot fired into a wall bursts on this side of it.
        const muzzle = Math.min(W.muzzle, toWall);
        const reach = Math.min(flight, toWall - muzzle);
        const m = {
            owner, seq, kind, x0: x + dx * muzzle, z0: z + dz * muzzle, dx, dz, yaw: dir, speed: spec.speed,
            t0, end: t0 + reach / spec.speed, wall: toWall - muzzle < flight, live, done: false,
        };
        this.missiles.push(m);
        return m;
    }
    /** Drop a mine behind a car at (x, z) facing `yaw`. */
    drop(owner, seq, x, z, yaw, t0) {
        // Clear of the tail by more than the trigger radius: a car standing
        // still must not be sitting on its own mine when it arms. (It was, 2.4 m
        // back, and the test that parks on a fresh mine blew its owner up.)
        const back = SIM.car.capsuleHalf + W.mine.radius + 0.6;
        const m = {
            owner, seq, x: x - Math.sin(yaw) * back, z: z - Math.cos(yaw) * back, t0,
            armAt: t0 + W.mine.arm, expires: t0 + W.mine.life, done: false,
        };
        this.mines.push(m);
        return m;
    }
    /** Place a mine exactly where somebody else's client dropped it. */
    place(owner, seq, x, z, t0) {
        const m = { owner, seq, x, z, t0, armAt: t0 + W.mine.arm, expires: t0 + W.mine.life, done: false };
        this.mines.push(m);
        return m;
    }
    findMissile(owner, seq) {
        return this.missiles.find((m) => m.owner === owner && m.seq === seq);
    }
    findMine(owner, seq) {
        return this.mines.find((m) => m.owner === owner && m.seq === seq);
    }
    /**
     * Which car, if any, a live missile's flight from `ta` to `tb` passes
     * through first. A swept test — the missile covers 1.5 m a step, more than
     * a car is wide from some angles — along the missile's path segment
     * against each car's capsule core.
     */
    sweep(m, ta, tb, cars) {
        const a = missileAt(m, ta);
        const b = missileAt(m, tb);
        const reach = SIM.car.radius + W.missileRadius;
        const half = SIM.car.capsuleHalf;
        let best = null;
        let bestAlong = Infinity;
        for (const c of cars) {
            if (!c.hittable || c.id === m.owner || c.y > 1.6)
                continue;
            const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
            const d2 = closestSegSeg(a.x, a.z, b.x, b.z, c.x + fx * half, c.z + fz * half, c.x - fx * half, c.z - fz * half, seg);
            if (d2 >= reach * reach)
                continue;
            const along = (seg.ax - a.x) * m.dx + (seg.az - a.z) * m.dz;
            if (along < bestAlong) {
                bestAlong = along;
                best = { target: c, x: seg.ax, z: seg.az };
            }
        }
        return best;
    }
    /** Does a car's capsule sit on this mine? */
    static onMine(mine, c) {
        if (!c.hittable || c.y > 0.6)
            return false;
        const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
        const half = SIM.car.capsuleHalf;
        const d2 = closestSegSeg(mine.x, mine.z, mine.x, mine.z, c.x + fx * half, c.z + fz * half, c.x - fx * half, c.z - fz * half, seg);
        return d2 < W.mine.radius * W.mine.radius;
    }
    /** Forget everything finished. */
    prune() {
        if (this.missiles.some((m) => m.done))
            this.missiles = this.missiles.filter((m) => !m.done);
        if (this.mines.some((m) => m.done))
            this.mines = this.mines.filter((m) => !m.done);
    }
}
//# sourceMappingURL=weapons.js.map