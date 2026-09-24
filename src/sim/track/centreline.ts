/**
 * Centreline construction: a closed fillet polygon, resampled by arc length.
 *
 * See `TrackDef.corners` for why the road is straights and circular arcs
 * rather than a spline. The output is a polyline with exactly one sample per
 * metre of road, which every other system indexes by: the arc-length
 * parameter `s` of a sample is simply its index.
 */

export interface Centreline {
  /** Sample positions, one per metre. */
  px: Float64Array;
  pz: Float64Array;
  /** Unit tangents, in the direction of travel. */
  tx: Float64Array;
  tz: Float64Array;
  /** Signed curvature, 1/m; positive turns left. */
  curvature: Float64Array;
  /** Exact loop length, metres. Samples are `length / n` apart (within 1 mm of 1 m). */
  length: number;
}

export class TrackGeometryError extends Error {}

/** Build the dense polyline: straights plus arcs, points every `step` metres. */
export function filletPolygon(
  corners: readonly (readonly [number, number, number])[],
  step = 0.25,
): { x: number[]; z: number[] } {
  const n = corners.length;
  if (n < 3) throw new TrackGeometryError('a track needs at least three corners');

  interface Fillet { sx: number; sz: number; ex: number; ez: number; cx: number; cz: number; r: number; a0: number; sweep: number }
  const fillets: Fillet[] = [];

  for (let i = 0; i < n; i++) {
    const [ax, az] = corners[(i - 1 + n) % n]!;
    const [bx, bz, r] = corners[i]!;
    const [cx, cz] = corners[(i + 1) % n]!;
    const l1 = Math.hypot(bx - ax, bz - az);
    const l2 = Math.hypot(cx - bx, cz - bz);
    const u1x = (bx - ax) / l1, u1z = (bz - az) / l1;
    const u2x = (cx - bx) / l2, u2z = (cz - bz) / l2;
    // Turn angle, signed: positive means the road bends left.
    // Left of travel direction (x, z) is (z, -x) in this world — see car.ts.
    const cross = u1x * u2z - u1z * u2x;
    const dot = u1x * u2x + u1z * u2z;
    const turn = -Math.atan2(cross, dot);
    const t = r * Math.tan(Math.abs(turn) / 2);
    if (t > l1 / 2 + 1e-6 || t > l2 / 2 + 1e-6) {
      throw new TrackGeometryError(`corner ${i} radius ${r} does not fit between its neighbours`);
    }
    const sx = bx - u1x * t, sz = bz - u1z * t;
    const ex = bx + u2x * t, ez = bz + u2z * t;
    // Centre lies along the inside normal of the incoming direction.
    const side = turn > 0 ? 1 : -1; // +1: centre to the left
    const lx = u1z, lz = -u1x;
    const ccx = sx + lx * r * side, ccz = sz + lz * r * side;
    const a0 = Math.atan2(sz - ccz, sx - ccx);
    const a1 = Math.atan2(ez - ccz, ex - ccx);
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    fillets.push({ sx, sz, ex, ez, cx: ccx, cz: ccz, r, a0, sweep });
  }

  const x: number[] = [];
  const z: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = fillets[i]!;
    const arcLen = Math.abs(f.sweep) * f.r;
    const arcSteps = Math.max(1, Math.ceil(arcLen / step));
    for (let k = 0; k < arcSteps; k++) {
      const a = f.a0 + (f.sweep * k) / arcSteps;
      x.push(f.cx + Math.cos(a) * f.r);
      z.push(f.cz + Math.sin(a) * f.r);
    }
    const g = fillets[(i + 1) % n]!;
    const straight = Math.hypot(g.sx - f.ex, g.sz - f.ez);
    const lineSteps = Math.max(1, Math.ceil(straight / step));
    for (let k = 0; k < lineSteps; k++) {
      x.push(f.ex + ((g.sx - f.ex) * k) / lineSteps);
      z.push(f.ez + ((g.sz - f.ez) * k) / lineSteps);
    }
  }
  return { x, z };
}

/**
 * Resample a closed dense polyline to one point per metre, starting at the
 * dense point nearest `start` so that s = 0 is the start/finish line.
 */
export function resample(dense: { x: number[]; z: number[] }, start: readonly [number, number]): Centreline {
  const m = dense.x.length;
  // Rotate so the loop begins at the start line.
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < m; i++) {
    const d = (dense.x[i]! - start[0]) ** 2 + (dense.z[i]! - start[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const dx: number[] = [];
  const dz: number[] = [];
  for (let k = 0; k <= m; k++) {
    dx.push(dense.x[(best + k) % m]!);
    dz.push(dense.z[(best + k) % m]!);
  }
  const cum = [0];
  for (let k = 1; k < dx.length; k++) cum.push(cum[k - 1]! + Math.hypot(dx[k]! - dx[k - 1]!, dz[k]! - dz[k - 1]!));
  const length = cum[cum.length - 1]!;
  const n = Math.round(length);
  const spacing = length / n;

  const px = new Float64Array(n);
  const pz = new Float64Array(n);
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const target = i * spacing;
    while (seg < cum.length - 2 && cum[seg + 1]! < target) seg++;
    const span = cum[seg + 1]! - cum[seg]!;
    const t = span > 0 ? (target - cum[seg]!) / span : 0;
    px[i] = dx[seg]! + (dx[seg + 1]! - dx[seg]!) * t;
    pz[i] = dz[seg]! + (dz[seg + 1]! - dz[seg]!) * t;
  }

  const tx = new Float64Array(n);
  const tz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const b = (i + 1) % n;
    const ux = px[b]! - px[a]!;
    const uz = pz[b]! - pz[a]!;
    const len = Math.hypot(ux, uz) || 1;
    tx[i] = ux / len;
    tz[i] = uz / len;
  }

  // Signed curvature from the change in heading between neighbours. Left of
  // (x, z) is (z, -x), so a left turn rotates the tangent that way.
  const curvature = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const b = (i + 1) % n;
    const cross = tx[a]! * tz[b]! - tz[a]! * tx[b]!;
    const dot = tx[a]! * tx[b]! + tz[a]! * tz[b]!;
    curvature[i] = -Math.atan2(cross, dot) / (2 * spacing);
  }

  return { px, pz, tx, tz, curvature, length };
}
