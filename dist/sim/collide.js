/**
 * Car collisions: a capsule against one-sided wall segments.
 *
 * The car is a capsule — a core segment along its length, inflated by a
 * radius — rather than an oriented box. It is cheaper, it slides smoothly
 * along a wall instead of catching its corners on every joint between wall
 * segments, and at a top-down camera's distance nobody can tell a rounded
 * bumper from a square one.
 *
 * Nothing here moves fast enough to tunnel, by construction: `car.ts`
 * substeps so that the capsule advances at most half its radius per substep,
 * and a capsule cannot pass through a segment without overlapping it on some
 * substep along the way. That is cheaper than a true time-of-impact sweep and
 * much easier to trust.
 */
/** Closest points between segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection 5.1.9). */
export function closestSegSeg(p1x, p1z, q1x, q1z, p2x, p2z, q2x, q2z, out) {
    const d1x = q1x - p1x, d1z = q1z - p1z;
    const d2x = q2x - p2x, d2z = q2z - p2z;
    const rx = p1x - p2x, rz = p1z - p2z;
    const a = d1x * d1x + d1z * d1z;
    const e = d2x * d2x + d2z * d2z;
    const f = d2x * rx + d2z * rz;
    let s;
    let t;
    const EPS = 1e-9;
    if (a <= EPS && e <= EPS) {
        s = 0;
        t = 0;
    }
    else if (a <= EPS) {
        s = 0;
        t = clamp01(f / e);
    }
    else {
        const c = d1x * rx + d1z * rz;
        if (e <= EPS) {
            t = 0;
            s = clamp01(-c / a);
        }
        else {
            const b = d1x * d2x + d1z * d2z;
            const denom = a * e - b * b;
            s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0;
            t = (b * s + f) / e;
            if (t < 0) {
                t = 0;
                s = clamp01(-c / a);
            }
            else if (t > 1) {
                t = 1;
                s = clamp01((b - c) / a);
            }
        }
    }
    out.ax = p1x + d1x * s;
    out.az = p1z + d1z * s;
    out.bx = p2x + d2x * t;
    out.bz = p2z + d2z * t;
    return (out.ax - out.bx) ** 2 + (out.az - out.bz) ** 2;
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const tmp = { ax: 0, az: 0, bx: 0, bz: 0 };
/**
 * Push a capsule out of every wall it overlaps and apply the bounce.
 *
 * @returns the fastest normal impact speed this call resolved, m/s (0 for none)
 */
export function resolveWalls(body, shape, world) {
    let impact = 0;
    // Two passes: in the inside of a corner, pushing out of one segment can push
    // into its neighbour.
    for (let pass = 0; pass < 2; pass++) {
        const fx = Math.sin(body.yaw);
        const fz = Math.cos(body.yaw);
        const p1x = body.x + fx * shape.half, p1z = body.z + fz * shape.half;
        const q1x = body.x - fx * shape.half, q1z = body.z - fz * shape.half;
        const r = shape.radius;
        const walls = world.walls;
        let hit = false;
        world.forWallsNear(Math.min(p1x, q1x) - r, Math.min(p1z, q1z) - r, Math.max(p1x, q1x) + r, Math.max(p1z, q1z) + r, (k) => {
            const o = k * 6;
            const d2 = closestSegSeg(p1x, p1z, q1x, q1z, walls[o], walls[o + 1], walls[o + 2], walls[o + 3], tmp);
            if (d2 >= r * r)
                return;
            const nx = walls[o + 4];
            const nz = walls[o + 5];
            // Signed distance along the wall's own normal. The walls are one-sided,
            // so the normal — not the direction between closest points, which
            // degenerates to nothing at zero distance — is the way out.
            const sd = (tmp.ax - tmp.bx) * nx + (tmp.az - tmp.bz) * nz;
            const pen = r - sd;
            if (pen <= 0)
                return;
            hit = true;
            body.x += nx * pen;
            body.z += nz * pen;
            impact = Math.max(impact, applyImpulse(body, shape, tmp.ax - nx * r - body.x, tmp.az - nz * r - body.z, nx, nz));
        });
        if (!hit)
            break;
    }
    return impact;
}
/**
 * Collision impulse at a contact point `rc` (relative to the centre of mass)
 * with a static surface of normal `n`, plus Coulomb friction along it.
 *
 * Returns the normal closing speed that was cancelled.
 */
function applyImpulse(body, shape, rcx, rcz, nx, nz) {
    // Velocity of the contact point: v + w * perp(rc), where perp rotates a
    // vector a quarter turn towards the car's left: (x, z) -> (z, -x).
    const px = rcz;
    const pz = -rcx;
    const vcx = body.vx + body.w * px;
    const vcz = body.vz + body.w * pz;
    const vn = vcx * nx + vcz * nz;
    if (vn >= 0)
        return 0;
    const rn = px * nx + pz * nz;
    const kn = 1 / shape.mass + (rn * rn) / shape.inertia;
    const j = (-(1 + shape.bounce) * vn) / kn;
    body.vx += (j * nx) / shape.mass;
    body.vz += (j * nz) / shape.mass;
    body.w += (j * rn) / shape.inertia;
    // Friction along the wall, capped by the normal impulse.
    const tx = -nz;
    const tz = nx;
    const vt = (body.vx + body.w * px) * tx + (body.vz + body.w * pz) * tz;
    const rt = px * tx + pz * tz;
    const kt = 1 / shape.mass + (rt * rt) / shape.inertia;
    let jt = -vt / kt;
    const cap = shape.friction * j;
    jt = jt < -cap ? -cap : jt > cap ? cap : jt;
    body.vx += (jt * tx) / shape.mass;
    body.vz += (jt * tz) / shape.mass;
    body.w += (jt * rt) / shape.inertia;
    return -vn;
}
const pairTmp = { ax: 0, az: 0, bx: 0, bz: 0 };
/**
 * Car against car: two capsules. Pushes them apart and exchanges an impulse.
 *
 * `applyA` / `applyB` choose which side is actually moved. Offline both are;
 * in a networked race (M3) each client resolves only its own car and sends
 * the other side's impulse as an event, so the same function serves both.
 *
 * @returns the impulse applied to A (world frame, N·s), or null if they did not touch
 */
export function resolveCarPair(a, b, shape, applyA = true, applyB = true, bounce = 0.3) {
    const afx = Math.sin(a.yaw), afz = Math.cos(a.yaw);
    const bfx = Math.sin(b.yaw), bfz = Math.cos(b.yaw);
    const h = shape.half;
    const d2 = closestSegSeg(a.x + afx * h, a.z + afz * h, a.x - afx * h, a.z - afz * h, b.x + bfx * h, b.z + bfz * h, b.x - bfx * h, b.z - bfz * h, pairTmp);
    const reach = shape.radius * 2;
    if (d2 >= reach * reach)
        return null;
    const dist = Math.sqrt(d2);
    // Normal from B to A. Degenerate (cores crossing): fall back to centre to centre.
    let nx = pairTmp.ax - pairTmp.bx;
    let nz = pairTmp.az - pairTmp.bz;
    if (dist > 1e-6) {
        nx /= dist;
        nz /= dist;
    }
    else {
        nx = a.x - b.x;
        nz = a.z - b.z;
        const l = Math.hypot(nx, nz);
        if (l > 1e-6) {
            nx /= l;
            nz /= l;
        }
        else {
            // Exactly on top of each other (two respawns onto one spot): there is
            // no "away" to push along, and a zero normal pushed them nowhere, so
            // they stayed welded together. Separate them sideways, A to its left.
            nx = afz;
            nz = -afx;
        }
    }
    const pen = reach - dist;
    const share = applyA && applyB ? 0.5 : 1;
    if (applyA) {
        a.x += nx * pen * share;
        a.z += nz * pen * share;
    }
    if (applyB) {
        b.x -= nx * pen * share;
        b.z -= nz * pen * share;
    }
    // Contact point: midway between the two closest points.
    const cx = (pairTmp.ax + pairTmp.bx) / 2;
    const cz = (pairTmp.az + pairTmp.bz) / 2;
    const rax = cx - a.x, raz = cz - a.z;
    const rbx = cx - b.x, rbz = cz - b.z;
    // perp(r) = (rz, -rx): the velocity a unit yaw rate gives a point at r.
    const vax = a.vx + a.w * raz, vaz = a.vz - a.w * rax;
    const vbx = b.vx + b.w * rbz, vbz = b.vz - b.w * rbx;
    const vn = (vax - vbx) * nx + (vaz - vbz) * nz;
    if (vn >= 0)
        return { jx: 0, jz: 0, closing: 0 };
    const ra = raz * nx - rax * nz;
    const rb = rbz * nx - rbx * nz;
    const k = 2 / shape.mass + (ra * ra + rb * rb) / shape.inertia;
    const j = (-(1 + bounce) * vn) / k;
    if (applyA) {
        a.vx += (j * nx) / shape.mass;
        a.vz += (j * nz) / shape.mass;
        a.w += (j * ra) / shape.inertia;
    }
    if (applyB) {
        b.vx -= (j * nx) / shape.mass;
        b.vz -= (j * nz) / shape.mass;
        b.w -= (j * rb) / shape.inertia;
    }
    return { jx: j * nx, jz: j * nz, closing: -vn };
}
//# sourceMappingURL=collide.js.map