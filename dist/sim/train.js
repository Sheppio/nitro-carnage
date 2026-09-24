/** Length of one locomotive or wagon, and the coupling gap between them, metres. */
export const CAR_LENGTH = 14;
export const COUPLING = 1;
/** Half the train's width: it is a capsule this fat along the rail. */
export const TRAIN_HALF_WIDTH = 1.6;
/** Seconds of flashing lights and lowered barriers before the train reaches the road. */
export const WARNING = 5;
/**
 * The train, as a pure function of race time (seconds since GO).
 *
 * The whole point: nobody sends a train message. Every client has the same
 * track, the same timetable and — through the room clock — the same GO, so
 * every client computes the same train at the same moment. A late joiner
 * computes it too. Passes alternate direction, so the train that went out
 * comes back.
 */
export function trainAt(track, raceTime) {
    const rw = track.def.railway;
    const rail = track.rail;
    if (!rw || !rail)
        return null;
    const t = raceTime - rw.first;
    if (t < 0)
        return null;
    const pass = Math.floor(t / rw.period);
    const phase = t - pass * rw.period;
    const len = trainLength(rw.cars);
    const run = rw.speed * phase;
    if (run > rail.length + len)
        return null; // gone: into the shed, or off the map
    const dir = pass % 2 === 0 ? 1 : -1;
    const head = dir > 0 ? run : rail.length - run;
    return { head, tail: head - dir * len, dir, speed: rw.speed, pass };
}
export const trainLength = (cars) => cars * CAR_LENGTH + (cars - 1) * COUPLING;
/** The stretch of rail the road (with its verges) occupies. */
function crossingSpan(track) {
    const r = track.rail;
    // The rail may cross at an angle; this is the width of road along the rail.
    const tx = track.line.tx[track.poseAt(r.s).i], tz = track.line.tz[track.poseAt(r.s).i];
    const sin = Math.abs(r.dx * tz - r.dz * tx) || 1;
    const half = track.wallOffset / sin + TRAIN_HALF_WIDTH + 1;
    return [r.u - half, r.u + half];
}
/** Is the train across the road at this race time? */
export function crossingBlocked(track, raceTime) {
    const tr = trainAt(track, raceTime);
    if (!tr)
        return false;
    const [a, b] = crossingSpan(track);
    const lo = Math.min(tr.head, tr.tail), hi = Math.max(tr.head, tr.tail);
    return hi >= a && lo <= b;
}
/**
 * Will the crossing be blocked at any moment between two race times? Checked
 * in quarter-second slices: the train takes several seconds to pass, so it
 * cannot slip between two samples.
 */
export function crossingBusy(track, t0, t1) {
    for (let t = t0; t <= t1; t += 0.25)
        if (crossingBlocked(track, t))
            return true;
    return crossingBlocked(track, t1);
}
/** Lights flashing: the train is on the crossing or due within `WARNING` seconds. */
export function crossingWarning(track, raceTime) {
    return track.rail !== null && crossingBusy(track, raceTime, raceTime + WARNING);
}
/**
 * The part of the train that exists: its body along the rail, clipped to the
 * rail's ends. Past an end the train is inside the shed or off the map —
 * and not clipping it once ran an invisible train across another road
 * beyond the buffers, three hundred metres from the crossing.
 *
 * @returns the segment in world coordinates, or null if none of it is out
 */
export function trainSegment(track, tr) {
    const r = track.rail;
    const lo = Math.max(0, Math.min(tr.head, tr.tail));
    const hi = Math.min(r.length, Math.max(tr.head, tr.tail));
    if (hi <= lo)
        return null;
    return { ax: r.ax + r.dx * lo, az: r.az + r.dz * lo, bx: r.ax + r.dx * hi, bz: r.az + r.dz * hi };
}
//# sourceMappingURL=train.js.map