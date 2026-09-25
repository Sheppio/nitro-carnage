/** Seconds of reversing along the track before the WRONG WAY banner. */
export const WRONG_WAY_AFTER = 1.5;
export function createLapState(track, s, goTime) {
    return {
        completed: -1,
        nextCp: track.checkpoints.length,
        s,
        progress: track.deltaS(0, s),
        lapStart: goTime,
        lapTimes: [],
        best: null,
        finished: false,
        finishTime: null,
        backwards: 0,
        wrongWay: false,
        splits: [],
        lastSplits: [],
    };
}
/** Did the step from `a` to `b` (a short hop along the loop) cross point `p` forwards (+1), backwards (-1), or not (0)? */
export function crossing(track, a, b, p) {
    const d = track.deltaS(a, b);
    if (d === 0)
        return 0;
    const toP = track.deltaS(a, p);
    if (d > 0 && toP > 0 && toP <= d)
        return 1;
    if (d < 0 && toP <= 0 && toP > d)
        return -1;
    return 0;
}
/**
 * Advance one car's lap state by one step.
 *
 * @param s        the car's arc length now
 * @param time     race time at the *end* of this step
 * @param dt       step length, for sub-step timing and the wrong-way clock
 * @param along    the car's velocity along the track tangent, m/s
 * @param laps     race length; 0 for a free drive that never finishes
 * @param teleport true when the car was just respawned: no crossings count
 */
export function stepLaps(st, track, s, time, dt, along, laps, teleport = false) {
    const prev = st.s;
    const moved = track.deltaS(prev, s);
    st.progress += moved;
    st.s = s;
    if (along < -2)
        st.backwards += dt;
    else if (along > 1)
        st.backwards = 0;
    st.wrongWay = st.backwards >= WRONG_WAY_AFTER;
    if (teleport || st.finished || moved === 0)
        return null;
    const cps = track.checkpoints;
    // Backwards over the last passed checkpoint: it no longer counts.
    if (st.nextCp > 0 && st.nextCp <= cps.length && crossing(track, prev, s, cps[st.nextCp - 1]) < 0) {
        st.nextCp--;
        st.splits.length = Math.min(st.splits.length, st.nextCp);
        return null;
    }
    if (st.nextCp < cps.length && crossing(track, prev, s, cps[st.nextCp]) > 0) {
        st.nextCp++;
        if (st.completed >= 0)
            st.splits[st.nextCp - 1] = time - st.lapStart;
        return null;
    }
    const line = crossing(track, prev, s, 0);
    if (line < 0 && st.nextCp === 0) {
        // Reversed back over the line: the lap it started is un-started.
        st.completed--;
        st.nextCp = cps.length;
        return null;
    }
    if (line > 0 && st.nextCp === cps.length) {
        // When in the step did we cross? Interpolate on distance.
        const before = track.deltaS(prev, 0);
        const frac = moved > 0 ? Math.max(0, Math.min(1, before / moved)) : 1;
        const at = time - dt + frac * dt;
        st.completed++;
        st.nextCp = 0;
        if (st.completed === 0)
            return null; // left the grid: lap 1 has begun
        const lapTime = at - st.lapStart;
        st.lapTimes.push(lapTime);
        st.lastSplits = st.splits;
        st.splits = [];
        st.best = st.best === null ? lapTime : Math.min(st.best, lapTime);
        st.lapStart = at;
        if (laps > 0 && st.completed >= laps) {
            st.finished = true;
            st.finishTime = at;
            return { kind: 'finish', lap: st.completed, time: at };
        }
        return { kind: 'lap', lap: st.completed, time: at };
    }
    return null;
}
/** Current lap to show on the HUD: 1-based, never 0, never past the race length. */
export function displayLap(st, laps) {
    const lap = Math.max(1, st.completed + 1);
    return laps > 0 ? Math.min(lap, laps) : lap;
}
/**
 * Race order: finishers by finish time, then everyone else by distance
 * covered. Ties (two cars on the same metre) break on id, so every client
 * sorting the same data gets the same order.
 */
export function standings(entries) {
    return [...entries].sort((a, b) => {
        const fa = a.lap.finishTime;
        const fb = b.lap.finishTime;
        if (fa !== null && fb !== null)
            return fa - fb || (a.id < b.id ? -1 : 1);
        if (fa !== null)
            return -1;
        if (fb !== null)
            return 1;
        return b.lap.progress - a.lap.progress || (a.id < b.id ? -1 : 1);
    });
}
//# sourceMappingURL=race.js.map