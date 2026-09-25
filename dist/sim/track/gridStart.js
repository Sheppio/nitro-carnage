/** The grid needs this much straight road behind the line, and a little ahead of it, metres. */
export const GRID_BEHIND = 40;
export const GRID_AHEAD = 6;
/** "Straight": no tighter than this radius, metres. */
export const GRID_RADIUS = 80;
/** The tightest the road bends under the grid, as a curvature (1/m), for a start at `s`. */
export function gridBend(t, s = 0) {
    const spacing = t.length / t.n;
    let worst = 0;
    for (let a = -GRID_BEHIND; a <= GRID_AHEAD; a += spacing) {
        worst = Math.max(worst, Math.abs(t.line.curvature[t.poseAt(s + a).i]));
    }
    return worst;
}
/**
 * Where to put the start line so the whole grid is on a straight: the first
 * place on or after the current line with GRID_BEHIND metres of straight
 * road behind it. A shorter lap put some start lines just past a corner, and
 * the back of the grid started on the bend.
 *
 * @returns the centreline point there in whole metres, or null if the line
 *   is already fine or no straight is long enough
 */
export function straightStart(t, rebuild) {
    if (gridBend(t) <= 1 / GRID_RADIUS)
        return null;
    for (let s = 2; s < t.length; s += 2) {
        if (gridBend(t, s) > 1 / GRID_RADIUS)
            continue;
        // Whole metres move the line a fraction: check it where it lands.
        const p = t.poseAt(s);
        const start = [Math.round(p.x), Math.round(p.z)];
        if (gridBend(rebuild(start)) <= 1 / GRID_RADIUS)
            return start;
    }
    return null;
}
//# sourceMappingURL=gridStart.js.map