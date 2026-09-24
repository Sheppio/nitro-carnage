import type { Track } from './track/buildTrack.js';

/** Clearance kept from the road edge, metres: half the car plus a little. */
const EDGE_MARGIN = 1.7;
/** Coarse spacing for the relaxation, metres. */
const COARSE = 3;
const ITERATIONS = 2500;

export interface RacingLine {
  /** Lateral offset from the centreline per sample, metres, positive left. */
  offset: Float64Array;
  /** Target speed per sample, m/s. */
  speed: Float64Array;
  /** Lap time the profile implies, seconds — a par for tests and bots. */
  parTime: number;
}

export interface LineOptions {
  /** Lateral acceleration the profile plans for, m/s^2. */
  lateral: number;
  /** Braking deceleration the profile plans for, m/s^2. */
  braking: number;
  /** Acceleration used only to estimate the par time, m/s^2. */
  accel: number;
  topSpeed: number;
}

/**
 * Close to what the car can do. The first version planned 10.5 m/s^2 of
 * cornering and 11 of braking, well inside the car's limits, and play-testing
 * called it straight away: the bots were timid in every corner. At 16/16 the
 * best bot laps Neon Downtown in 59 s instead of 66.5 with no wall contact;
 * at 18 they start clipping the walls.
 */
export const DEFAULT_LINE: LineOptions = { lateral: 16, braking: 16, accel: 6, topSpeed: 46 };

const cache = new WeakMap<Track, RacingLine>();

/**
 * The fast way round: a minimum-curvature line inside the road, and a speed
 * for every metre of it.
 *
 * The line relaxes each point towards the midpoint of its neighbours — which
 * straightens the path, cutting apexes and running wide on entry and exit —
 * while clamped inside the road. That is the classic minimum-curvature line,
 * and close enough to the fastest line on tracks like these. It runs on a 3 m
 * grid, because relaxation spreads a correction one point per iteration and
 * a 1 m grid would need nine times the iterations to settle the long bends.
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
  const m = Math.floor(n / COARSE);
  const spacing = track.length / n;
  const limit = Math.max(0, track.halfWidth - EDGE_MARGIN);
  const { px, pz, tx, tz } = track.line;

  // Coarse samples: position and left normal.
  const cx = new Float64Array(m), cz = new Float64Array(m), nx = new Float64Array(m), nz = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const i = Math.floor((k * n) / m);
    cx[k] = px[i]!;
    cz[k] = pz[i]!;
    nx[k] = tz[i]!;
    nz[k] = -tx[i]!;
  }
  const off = new Float64Array(m);
  for (let it = 0; it < ITERATIONS; it++) {
    for (let k = 0; k < m; k++) {
      const a = (k - 1 + m) % m;
      const b = (k + 1) % m;
      const ax = cx[a]! + nx[a]! * off[a]!, az = cz[a]! + nz[a]! * off[a]!;
      const bx = cx[b]! + nx[b]! * off[b]!, bz = cz[b]! + nz[b]! * off[b]!;
      const x = cx[k]! + nx[k]! * off[k]!, z = cz[k]! + nz[k]! * off[k]!;
      const move = ((ax + bx) / 2 - x) * nx[k]! + ((az + bz) / 2 - z) * nz[k]!;
      off[k] = Math.max(-limit, Math.min(limit, off[k]! + move * 0.9));
    }
  }

  // Back to one sample per metre, interpolating the offset.
  const offset = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = (i * m) / n;
    const k = Math.floor(f) % m;
    const t = f - Math.floor(f);
    offset[i] = off[k]! + (off[(k + 1) % m]! - off[k]!) * t;
  }

  // Curvature of the line itself, from three points four metres apart.
  const speed = new Float64Array(n);
  const P = (i: number): [number, number] => {
    const j = ((i % n) + n) % n;
    return [px[j]! + tz[j]! * offset[j]!, pz[j]! - tx[j]! * offset[j]!];
  };
  for (let i = 0; i < n; i++) {
    const [ax, az] = P(i - 4);
    const [bx, bz] = P(i);
    const [qx, qz] = P(i + 4);
    // Menger curvature: 4 * area / (product of side lengths).
    const area2 = Math.abs((bx - ax) * (qz - az) - (bz - az) * (qx - ax));
    const d = Math.hypot(bx - ax, bz - az) * Math.hypot(qx - bx, qz - bz) * Math.hypot(qx - ax, qz - az);
    const kappa = d > 1e-9 ? (2 * area2) / d : 0;
    speed[i] = Math.min(opts.topSpeed, kappa > 1e-6 ? Math.sqrt(opts.lateral / kappa) : opts.topSpeed);
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
      v = Math.min(speed[i]!, Math.sqrt(v * v + 2 * opts.accel * spacing));
      parTime += spacing / Math.max(1, v);
    }
  }

  const line = { offset, speed, parTime };
  if (opts === DEFAULT_LINE) cache.set(track, line);
  return line;
}
