/** Straight-line distance between two corners, by an exact square root. */
function dist(a, b) {
    return Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
}
/** tan of half the turn at `c`, from `p` on to `q`, and which way (+1 left, -1 right, 0 straight on). */
function turnAt(p, c, q) {
    const ax = c[0] - p[0], az = c[1] - p[1], bx = q[0] - c[0], bz = q[1] - c[1];
    const den = dist(p, c) * dist(c, q) + ax * bx + az * bz;
    const cross = ax * bz - az * bx;
    return cross === 0 || den <= 0 ? { tan: 0, side: 0 } : { tan: Math.abs(cross) / den, side: Math.sign(cross) };
}
export function sweepCorners(corners, opts) {
    const n = corners.length;
    const most = opts.most ?? 400;
    const turns = corners.map((c, i) => turnAt(corners[(i + n - 1) % n], c, corners[(i + 1) % n]));
    const reach = (i) => corners[i][2] * turns[i].tan;
    return corners.map((c, i) => {
        const t = turns[i];
        if (t.tan === 0)
            return [c[0], c[1], c[2]];
        const prev = (i + n - 1) % n, next = (i + 1) % n;
        const lp = dist(corners[prev], c), ln = dist(c, corners[next]);
        if (opts.runsUnder !== undefined) {
            // In a run: a neighbour turning the same way, not far off.
            const run = (j, l) => turns[j].side === t.side && l - reach(i) - reach(j) < opts.runsUnder;
            if (!run(prev, lp) && !run(next, ln))
                return [c[0], c[1], c[2]];
        }
        const grown = Math.floor((Math.min(lp, ln) * opts.share) / 2000 / t.tan);
        return [c[0], c[1], Math.max(c[2], Math.min(most, grown))];
    });
}
//# sourceMappingURL=sweep.js.map