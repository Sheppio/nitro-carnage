import type { Track } from './track/buildTrack.js';

/**
 * Lap and checkpoint tracking for one car. Pure: fed the car's arc length
 * each step, it decides laps, lap times, wrong-way and finishing.
 *
 * The car starts on the grid *behind* the start line, so it begins on lap
 * "-1 completed": the first crossing of the line starts lap 1 without
 * finishing anything. From then on a lap only counts when every checkpoint
 * has been passed in order, and driving backwards over a checkpoint or the
 * line un-passes it — so reversing over the line and driving forward again
 * gains nothing.
 */
export interface LapState {
  /** Laps completed; -1 until the car first crosses the line. */
  completed: number;
  /** Index of the next checkpoint to pass; `checkpoints.length` means the line is next. */
  nextCp: number;
  /** Arc length at the last step, metres. */
  s: number;
  /**
   * Distance along the track since the start, in metres, continuous across
   * the line and across respawns. Race order is decided on this, not on
   * `completed * length + s`, which jumps a whole lap if a car is put back
   * behind the line it just crossed.
   */
  progress: number;
  /** Race time the current lap began (GO for lap 1). */
  lapStart: number;
  lapTimes: number[];
  best: number | null;
  finished: boolean;
  /** Race time of the finish, sub-step accurate. */
  finishTime: number | null;
  /** Seconds spent going backwards; see `WRONG_WAY_AFTER`. */
  backwards: number;
  wrongWay: boolean;
}

/** Seconds of reversing along the track before the WRONG WAY banner. */
export const WRONG_WAY_AFTER = 1.5;

export function createLapState(track: Track, s: number, goTime: number): LapState {
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
  };
}

/** Did the step from `a` to `b` (a short hop along the loop) cross point `p` forwards (+1), backwards (-1), or not (0)? */
export function crossing(track: Track, a: number, b: number, p: number): number {
  const d = track.deltaS(a, b);
  if (d === 0) return 0;
  const toP = track.deltaS(a, p);
  if (d > 0 && toP > 0 && toP <= d) return 1;
  if (d < 0 && toP <= 0 && toP > d) return -1;
  return 0;
}

export interface LapEvent {
  kind: 'lap' | 'finish';
  lap: number;
  time: number;
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
export function stepLaps(
  st: LapState, track: Track, s: number, time: number, dt: number, along: number, laps: number, teleport = false,
): LapEvent | null {
  const prev = st.s;
  const moved = track.deltaS(prev, s);
  st.progress += moved;
  st.s = s;

  if (along < -2) st.backwards += dt;
  else if (along > 1) st.backwards = 0;
  st.wrongWay = st.backwards >= WRONG_WAY_AFTER;

  if (teleport || st.finished || moved === 0) return null;

  const cps = track.checkpoints;
  // Backwards over the last passed checkpoint: it no longer counts.
  if (st.nextCp > 0 && st.nextCp <= cps.length && crossing(track, prev, s, cps[st.nextCp - 1]!) < 0) {
    st.nextCp--;
    return null;
  }
  if (st.nextCp < cps.length && crossing(track, prev, s, cps[st.nextCp]!) > 0) {
    st.nextCp++;
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
    if (st.completed === 0) return null; // left the grid: lap 1 has begun
    const lapTime = at - st.lapStart;
    st.lapTimes.push(lapTime);
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
export function displayLap(st: LapState, laps: number): number {
  const lap = Math.max(1, st.completed + 1);
  return laps > 0 ? Math.min(lap, laps) : lap;
}

export interface Standing {
  id: string;
  lap: LapState;
}

/**
 * Race order: finishers by finish time, then everyone else by distance
 * covered. Ties (two cars on the same metre) break on id, so every client
 * sorting the same data gets the same order.
 */
export function standings<T extends Standing>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    const fa = a.lap.finishTime;
    const fb = b.lap.finishTime;
    if (fa !== null && fb !== null) return fa - fb || (a.id < b.id ? -1 : 1);
    if (fa !== null) return -1;
    if (fb !== null) return 1;
    return b.lap.progress - a.lap.progress || (a.id < b.id ? -1 : 1);
  });
}
