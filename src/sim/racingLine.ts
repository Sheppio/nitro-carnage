import type { Track } from './track/buildTrack.js';

/** Clearance kept from the road edge, metres: half the car plus a little. */
const EDGE_MARGIN = 1.7;
/** Curvature for the speed profile is measured between points this many metres either side. */
const CURVE_SPAN = 5;
/** The line's refinement: strides in metres, coarse to fine, and sweeps at each. */
const STRIDES = [64, 32, 16, 8, 4, 2, 1];
const SWEEPS = 60;

export interface RacingLine {
  /** Lateral offset from the centreline per sample, metres, positive left. */
  offset: Float64Array;
  /** Target speed per sample, m/s. */
  speed: Float64Array;
  /** Lap time the profile implies, seconds — a par for tests and bots. */
  parTime: number;
}

export interface LineOptions {
  /**
   * Lateral acceleration the profile plans for, m/s^2: `lateral` plus
   * `lateralPerMs` for every m/s. Downforce gives the car more grip the faster
   * it goes: measured on flat tarmac, about 14.8 at 20 m/s, 16.1 at 30 and
   * 17.5 at 40.
   */
  lateral: number;
  lateralPerMs: number;
  /** Braking deceleration the profile plans for, m/s^2. */
  braking: number;
  /** Acceleration used only to estimate the par time, m/s^2. */
  accel: number;
  /**
   * The profile's ceiling. Above anything the car reaches, turbo included, so
   * the braking curves reach up to every speed a car can arrive at: capped
   * at the car's own top speed, a bot on turbo met a braking zone planned
   * from 46 m/s at 55 and ran into the wall.
   */
  topSpeed: number;
  /** What the car reaches without turbo, for the par time. */
  carTop: number;
}

/**
 * Close to what the car can do. The first version planned 10.5 m/s^2 of
 * cornering and 11 of braking, well inside the car's limits, and play-testing
 * called it straight away: the bots were timid in every corner. At 16/16 the
 * best bot laps Neon Downtown in 59 s instead of 66.5 with no wall contact;
 * at 18 they start clipping the walls.
 */
export const DEFAULT_LINE: LineOptions = { lateral: 16, lateralPerMs: 0, braking: 16, accel: 6, topSpeed: 64, carTop: 51 };

const cache = new WeakMap<Track, RacingLine>();

/**
 * The fast way round: a smooth line inside the road, and a speed for every
 * metre of it.
 *
 * The line is K1999's (Rémi Coulom's TORCS robot): each point in turn moves
 * across the road until the line's curvature there is the average of its
 * neighbours', clamped to the road. That evens the turning out along the lap,
 * which is what a fast line does: out-in-out through a corner, one long arc
 * through a run of small ones. It works on points 64 m apart first, then 32,
 * and so on down to 1 m, so a change spreads across a whole corner in a few
 * sweeps rather than creeping a metre at a time.
 *
 * Two earlier versions each failed on the real circuits (M9), whose outlines
 * are short straights joined by 10 m fillets. Pulling each point to the
 * midpoint of its neighbours is a taut string: it hugs the inside edge and
 * kinks at every joint of it, and the bots braked for each kink as a hairpin
 * (Indianapolis's turns planned at 13-18 m/s). Descent on the squared second
 * difference weighs a line by its point spacing as well as its bending, which
 * is wider on the outside of a turn, so it never settled either.
 *
 * The speed profile is what the car can corner at each point, then a pass
 * backwards from every slow corner that brakes into it in time.
 *
 * Deterministic and memoised per track: every client, and every bot, gets the
 * same line.
 */
export function racingLine(track: Track, opts: LineOptions = DEFAULT_LINE): RacingLine {
  const cached = cache.get(track);
  if (cached && opts === DEFAULT_LINE) return cached;

  const n = track.n;
  const spacing = track.length / n;
  const limit = Math.max(0, track.halfWidth - EDGE_MARGIN);
  const { px, pz, tx, tz } = track.line;
  // Left normals.
  const nx = new Float64Array(n), nz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    nx[i] = tz[i]!;
    nz[i] = -tx[i]!;
  }
  const offset = new Float64Array(n);
  const wrap = (i: number): number => ((i % n) + n) % n;
  const X = (i: number, o = offset[wrap(i)]!): number => px[wrap(i)]! + nx[wrap(i)]! * o;
  const Z = (i: number, o = offset[wrap(i)]!): number => pz[wrap(i)]! + nz[wrap(i)]! * o;

  for (const stride of STRIDES) {
    if (stride * 8 > n) continue;
    for (let sweep = 0; sweep < SWEEPS; sweep++) {
      for (let i = 0; i < n; i += stride) {
        const a = i - stride, b = i + stride;
        // What the neighbours turn at, and what this point should.
        const kPrev = signedCurvature(X(a - stride), Z(a - stride), X(a), Z(a), X(i), Z(i));
        const kNext = signedCurvature(X(i), Z(i), X(b), Z(b), X(b + stride), Z(b + stride));
        const want = (kPrev + kNext) / 2;
        // Curvature here is close to linear in the offset: two samples, and solve.
        const o = offset[i]!;
        const k0 = signedCurvature(X(a), Z(a), X(i, o), Z(i, o), X(b), Z(b));
        const k1 = signedCurvature(X(a), Z(a), X(i, o + 1e-3), Z(i, o + 1e-3), X(b), Z(b));
        const dk = (k1 - k0) / 1e-3;
        if (Math.abs(dk) < 1e-9) continue;
        offset[i] = Math.max(-limit, Math.min(limit, o + (want - k0) / dk));
      }
      // The points between follow in a straight line.
      if (stride > 1) {
        for (let i = 0; i < n; i += stride) {
          const j = i + stride;
          const oa = offset[i]!, ob = offset[wrap(j)]!;
          const end = Math.min(j, n + stride);
          for (let u = i + 1; u < end && u < n; u++) offset[u] = oa + ((ob - oa) * (u - i)) / (j - i);
        }
      }
    }
  }

  // Speed from the curvature of the line as driven: three points
  // CURVE_SPAN metres apart.
  const speed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const kappa = Math.abs(signedCurvature(X(i - CURVE_SPAN), Z(i - CURVE_SPAN), X(i), Z(i), X(i + CURVE_SPAN), Z(i + CURVE_SPAN)));
    // v^2 * kappa = a + b v, solved for v.
    const R = 1 / Math.max(kappa, 1e-6);
    const b = opts.lateralPerMs;
    speed[i] = Math.min(opts.topSpeed, (b * R + Math.sqrt(b * b * R * R + 4 * opts.lateral * R)) / 2);
  }
  // Brake in time: sweep backwards twice round the loop so the wrap is covered.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const next = speed[(i + 1) % n]!;
      speed[i] = Math.min(speed[i]!, Math.sqrt(next * next + 2 * opts.braking * spacing));
    }
  }

  // Par: drive the profile forwards with limited acceleration, from rolling speed.
  let v = speed[0]!;
  let parTime = 0;
  for (let pass = 0; pass < 2; pass++) {
    parTime = 0;
    for (let i = 0; i < n; i++) {
      v = Math.min(speed[i]!, opts.carTop, Math.sqrt(v * v + 2 * opts.accel * spacing));
      parTime += spacing / Math.max(1, v);
    }
  }

  const line = { offset, speed, parTime };
  if (opts === DEFAULT_LINE) cache.set(track, line);
  return line;
}


/** Curvature of the circle through three points, positive turning left. */
function signedCurvature(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  const cross = (bx - ax) * (cz - bz) - (bz - az) * (cx - bx);
  const d = Math.hypot(bx - ax, bz - az) * Math.hypot(cx - bx, cz - bz) * Math.hypot(cx - ax, cz - az);
  return d > 1e-12 ? (2 * cross) / d : 0;
}
