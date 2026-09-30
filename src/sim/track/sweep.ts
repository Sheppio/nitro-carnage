/**
 * Rounder corners (#20, #22): each corner's fillet grown into the room its
 * two edges leave, so a curve drawn as a few points reads as one sweep and
 * not as short straights joined by tight arcs.
 *
 * A fillet of radius r takes r·tan(θ/2) of road from each edge beside it.
 * Grown until it takes `share` (per mille) of half the shorter edge, two
 * corners on one edge never overlap, and at least (1 - share) of every edge
 * is still straight. A radius only ever grows, and never past `most`.
 *
 * Whole metres out, from exact square roots and integer division: generated
 * tracks must come out the same on every computer.
 */
type Corner = [number, number, number];

/** Straight-line distance between two corners, by an exact square root. */
function dist(a: readonly number[], b: readonly number[]): number {
  return Math.sqrt((b[0]! - a[0]!) * (b[0]! - a[0]!) + (b[1]! - a[1]!) * (b[1]! - a[1]!));
}

/** tan of half the turn at `c`, from `p` on to `q`, and which way (+1 left, -1 right, 0 straight on). */
function turnAt(p: readonly number[], c: readonly number[], q: readonly number[]): { tan: number; side: number } {
  const ax = c[0]! - p[0]!, az = c[1]! - p[1]!, bx = q[0]! - c[0]!, bz = q[1]! - c[1]!;
  const den = dist(p, c) * dist(c, q) + ax * bx + az * bz;
  const cross = ax * bz - az * bx;
  return cross === 0 || den <= 0 ? { tan: 0, side: 0 } : { tan: Math.abs(cross) / den, side: Math.sign(cross) };
}

export interface SweepOptions {
  /** Per mille of half the shorter edge a corner may take. */
  share: number;
  /**
   * Only corners in a run (a real circuit's curves): a corner grows only when
   * a neighbour turns the same way with less than this much straight between
   * them. Unset, every corner grows (a generated flowing loop).
   */
  runsUnder?: number;
  /** The largest radius a corner is grown to. */
  most?: number;
}

export function sweepCorners(corners: readonly (readonly [number, number, number])[], opts: SweepOptions): Corner[] {
  const n = corners.length;
  const most = opts.most ?? 400;
  const turns = corners.map((c, i) => turnAt(corners[(i + n - 1) % n]!, c, corners[(i + 1) % n]!));
  const reach = (i: number): number => corners[i]![2] * turns[i]!.tan;
  return corners.map((c, i) => {
    const t = turns[i]!;
    if (t.tan === 0) return [c[0], c[1], c[2]];
    const prev = (i + n - 1) % n, next = (i + 1) % n;
    const lp = dist(corners[prev]!, c), ln = dist(c, corners[next]!);
    if (opts.runsUnder !== undefined) {
      // In a run: a neighbour turning the same way, not far off.
      const run = (j: number, l: number): boolean => turns[j]!.side === t.side && l - reach(i) - reach(j) < opts.runsUnder!;
      if (!run(prev, lp) && !run(next, ln)) return [c[0], c[1], c[2]];
    }
    const grown = Math.floor((Math.min(lp, ln) * opts.share) / 2000 / t.tan);
    return [c[0], c[1], Math.max(c[2], Math.min(most, grown))];
  });
}
