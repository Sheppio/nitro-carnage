import type { Prop, Track } from './buildTrack.js';
import type { PropRule, XZ } from './TrackDef.js';

/**
 * Placing the M10 scenery: farms, fields, herds, ponds, windmills and
 * flower beds for the parkland; warehouses, yards, ships and a marina for
 * the port.
 *
 * Everything sits beside the road rather than anywhere in an area, because
 * the camera shows a band about 70 m wide round the car: a farm half a
 * kilometre off would cost triangles and never be seen. Each placement claims
 * a circle of ground (`taken`) that later placements, trees and containers
 * keep off.
 *
 * Seeded like the rest of the scatter, so every screen shows the same farm.
 * Visual only: nothing here collides, and nothing here is water to the
 * simulation except a track's explicit `ponds`.
 */

export interface ScatterContext {
  track: Track;
  rand: () => number;
  props: Prop[];
  /** Ground already claimed, as circles. */
  taken: [x: number, z: number, r: number][];
  /** Distance from a point to the road centreline. */
  roadDist: (x: number, z: number) => number;
  /** The railway's corridor, or water. */
  blocked: (x: number, z: number, r: number) => boolean;
}

/** Is a circle clear of everything claimed so far? */
export function free(ctx: ScatterContext, x: number, z: number, r: number): boolean {
  for (const [tx, tz, tr] of ctx.taken) if ((x - tx) * (x - tx) + (z - tz) * (z - tz) < (r + tr) * (r + tr)) return false;
  return true;
}

/**
 * Somewhere beside the road for a thing of radius `r`: a random point on the
 * lap, either side, just past the wall plus `clearance`, turned to run along
 * the road. Null when thirty tries find nowhere.
 */
function besideRoad(ctx: ScatterContext, r: number, clearance: number, water = false, rect?: [w: number, d: number]): { x: number; z: number; rot: number } | null {
  const { track, rand } = ctx;
  const keep = track.wallOffset + clearance + r;
  for (let tries = 0; tries < 30; tries++) {
    const i = Math.floor(rand() * track.n);
    const side = rand() < 0.5 ? 1 : -1;
    const [x, z] = track.offsetPoint(i, side * (keep + rand() * 6));
    // Where the road bends back, a point that far off one stretch is near another.
    if (ctx.roadDist(x, z) < keep) continue;
    if (!water && ctx.blocked(x, z, r)) continue;
    if (!free(ctx, x, z, r)) continue;
    const rot = Math.atan2(track.line.tx[i]!, track.line.tz[i]!);
    // A rectangle is checked by its corners and edges too: on a tight circuit the road can reach round to it.
    if (rect && !rectClear(ctx, x, z, rot, rect[0], rect[1], track.wallOffset + clearance)) continue;
    return { x, z, rot };
  }
  return null;
}

/** Is a w x d rectangle at (x, z), turned `rot`, at least `keep` from the road at its corners, edge midpoints and centre? */
function rectClear(ctx: ScatterContext, x: number, z: number, rot: number, w: number, d: number, keep: number): boolean {
  const c = Math.cos(rot), s = Math.sin(rot);
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0], [0, 0]] as const) {
    const lx = (a * w) / 2, lz = (b * d) / 2;
    if (ctx.roadDist(x + lx * c + lz * s, z - lx * s + lz * c) < keep) return false;
  }
  return true;
}

/** Place a part at (lx, lz) in a frame at (x, z) turned `rot`. */
function part(ctx: ScatterContext, kind: Prop['kind'], at: { x: number; z: number; rot: number }, lx: number, lz: number, turn: number, size: [number, number, number], seed: number): void {
  const c = Math.cos(at.rot), s = Math.sin(at.rot);
  ctx.props.push({
    kind, x: at.x + lx * c + lz * s, z: at.z - lx * s + lz * c, rot: at.rot + turn, w: size[0], d: size[1], h: size[2], seed,
  });
}

export function placeCountryside(ctx: ScatterContext, rule: PropRule): boolean {
  const { rand } = ctx;
  switch (rule.kind) {
    case 'farms':
      for (let k = 0; k < rule.count; k++) {
        const at = besideRoad(ctx, 22, rule.clearance);
        if (!at) continue;
        ctx.taken.push([at.x, at.z, 22]);
        // The yard's layout, mirrored half the time so farms are not all alike.
        const m = rand() < 0.5 ? 1 : -1;
        const v = rand();
        part(ctx, 'farmhouse', at, -8 * m, 7, 0, [10, 12, 9.6], v);
        part(ctx, 'barn', at, 7 * m, -5, 0, [18, 21, 12], rand());
        const silos = 1 + Math.floor(rand() * 2);
        for (let s = 0; s < silos; s++) part(ctx, 'silo', at, (15 + s * 7) * m, 9, 0, [6.3, 6.3, 18.2], rand());
        const bales = 3 + Math.floor(rand() * 5);
        for (let b = 0; b < bales; b++) part(ctx, 'bale', at, (-13 + b * 1.8) * m, -12, Math.PI / 2, [1.6, 1.2, 1.6], rand());
        if (rand() < 0.6) part(ctx, 'bales', at, -6 * m, -8, 0, [3.8, 2.4, 1.7], rand());
        part(ctx, 'tractor', at, 1 * m, 4, rand() * Math.PI * 2, [2.1, 3.6, 2.9], rand());
      }
      return true;

    case 'fields':
      for (let k = 0; k < rule.count; k++) {
        const w = 30 + Math.floor(rand() * 40);
        const d = 24 + Math.floor(rand() * 26);
        const r = Math.hypot(w, d) / 2;
        const at = besideRoad(ctx, r, rule.clearance, false, [w, d]);
        if (!at) continue;
        ctx.taken.push([at.x, at.z, r]);
        const crop = Math.floor(rand() * 4);
        part(ctx, 'field', at, 0, 0, 0, [w, d, 0], crop / 4 + 0.01);
        const work = rand();
        // Someone at work: a combine in the maize or wheat, a tractor on the ploughed field, bales on the cut one.
        if (crop <= 1 && work < 0.5) part(ctx, 'combine', at, (rand() - 0.5) * w * 0.6, (rand() - 0.5) * d * 0.5, rand() < 0.5 ? 0 : Math.PI, [7.2, 8.6, 5], rand());
        if (crop === 2 && work < 0.6) part(ctx, 'tractor', at, (rand() - 0.5) * w * 0.6, (rand() - 0.5) * d * 0.6, 0, [2.1, 3.6, 2.9], rand());
        if (crop === 3) {
          const n = 4 + Math.floor(rand() * 8);
          for (let b = 0; b < n; b++) part(ctx, 'bale', at, (rand() - 0.5) * (w - 4), (rand() - 0.5) * (d - 4), rand() * Math.PI, [1.6, 1.2, 1.6], rand());
        }
      }
      return true;

    case 'herds':
      for (let k = 0; k < rule.count; k++) {
        const w = 22 + Math.floor(rand() * 18);
        const d = 16 + Math.floor(rand() * 14);
        const r = Math.hypot(w, d) / 2;
        const at = besideRoad(ctx, r, rule.clearance, false, [w, d]);
        if (!at) continue;
        ctx.taken.push([at.x, at.z, r]);
        part(ctx, 'fence', at, 0, 0, 0, [w, d, 1.2], 0);
        const cows = rand() < 0.5;
        const n = cows ? 5 + Math.floor(rand() * 8) : 7 + Math.floor(rand() * 10);
        const coat = rand();
        for (let a = 0; a < n; a++) {
          part(ctx, cows ? 'cow' : 'sheep', at, (rand() - 0.5) * (w - 3), (rand() - 0.5) * (d - 3), rand() * Math.PI * 2, [0.8, 2, 1.5],
            // A herd is mostly one breed, with the odd stray; about half are grazing.
            ((rand() < 0.8 ? coat : rand()) * 0.5) + (rand() < 0.5 ? 0.5 : 0));
        }
      }
      return true;

    case 'ponds':
      for (let k = 0; k < rule.count; k++) {
        const r = 8 + Math.floor(rand() * 10);
        const at = besideRoad(ctx, r + 2, rule.clearance);
        if (!at) continue;
        pond(ctx, at.x, at.z, r);
      }
      return true;

    case 'windmills':
      for (let k = 0; k < rule.count; k++) {
        const at = besideRoad(ctx, 9, rule.clearance);
        if (!at) continue;
        ctx.taken.push([at.x, at.z, 9]);
        // Sails face the road, so their turning is side-on to the camera less often.
        part(ctx, 'windmill', at, 0, 0, rand() * Math.PI * 2, [8.4, 8.4, 18], rand());
      }
      return true;

    case 'flowers': {
      const { track } = ctx;
      const step = Math.max(4, Math.round(rule.spacing / (track.length / track.n)));
      for (let i = 0; i < track.n; i += step) {
        for (const side of [1, -1]) {
          if (rand() < 0.45) continue;
          const len = 6 + Math.floor(rand() * 8);
          const [x, z] = track.offsetPoint(i, side * (track.wallOffset + 3.4));
          const rot = Math.atan2(track.line.tx[i]!, track.line.tz[i]!);
          // The whole bed, not just its middle: on a bend its ends swing in towards the road.
          if (!rectClear(ctx, x, z, rot, 2.4, len, track.wallOffset + 0.8) || ctx.blocked(x, z, len / 2) || !free(ctx, x, z, len / 2)) continue;
          ctx.props.push({ kind: 'flowers', x, z, rot, w: 2.4, d: len, h: 0.6, seed: rand() });
        }
      }
      return true;
    }

    case 'warehouses':
      for (let k = 0; k < rule.count; k++) {
        const w = 30 + Math.floor(rand() * 30);
        const d = 20 + Math.floor(rand() * 12);
        const r = Math.hypot(w, d) / 2;
        const at = besideRoad(ctx, r, rule.clearance, false, [w, d]);
        if (!at) continue;
        ctx.taken.push([at.x, at.z, r]);
        part(ctx, 'warehouse', at, 0, 0, rand() < 0.5 ? 0 : Math.PI, [w, d, 9 + Math.floor(rand() * 5)], rand());
      }
      return true;

    case 'ships': {
      const { dx, dz, nx, nz, len } = line(rule.from, rule.to);
      for (let k = 0; k < rule.count; k++) {
        const f = (k + 0.5) / rule.count;
        const x = rule.from[0] + dx * len * f + nx * rule.out;
        const z = rule.from[1] + dz * len * f + nz * rule.out;
        const seed = rand();
        // Moored either way round.
        ctx.props.push({ kind: 'ship', x, z, rot: Math.atan2(dx, dz) + (rand() < 0.5 ? Math.PI : 0), w: 26, d: 170, h: 25, seed });
      }
      return true;
    }

    case 'marina': {
      const { dx, dz, nx, nz, len } = line(rule.from, rule.to);
      const out = Math.sign(rule.out);
      const yaw = Math.atan2(dx, dz);
      // The walkway out from the quay, the main pontoon along it, fingers every 9 m with a yacht each side.
      const px = (f: number, o: number): [number, number] => [rule.from[0] + dx * len * f + nx * o, rule.from[1] + dz * len * f + nz * o];
      const [gx, gz] = px(0.5, rule.out / 2);
      ctx.props.push({ kind: 'pontoon', x: gx, z: gz, rot: yaw + Math.PI / 2, w: 2, d: Math.abs(rule.out), h: 0.5, seed: 0 });
      const [mx, mz] = px(0.5, rule.out);
      ctx.props.push({ kind: 'pontoon', x: mx, z: mz, rot: yaw, w: 2, d: len, h: 0.5, seed: 0 });
      for (let s = 5; s < len - 4; s += 9) {
        const f = s / len;
        const [fx, fz] = px(f, rule.out + out * 6);
        ctx.props.push({ kind: 'pontoon', x: fx, z: fz, rot: yaw + Math.PI / 2, w: 1.4, d: 10, h: 0.5, seed: 0 });
        for (const along of [-4.5, 4.5]) {
          if (rand() < 0.25) continue;
          const [yx, yz] = px((s + along) / len, rule.out + out * 7);
          ctx.props.push({ kind: 'yacht', x: yx, z: yz, rot: yaw + (out * Math.PI) / 2 + (rand() < 0.5 ? Math.PI : 0), w: 4, d: 15, h: 3, seed: rand() });
        }
      }
      return true;
    }

    default:
      return false;
  }
}

/** A pond, its reeds, and the ground it claims. */
export function pond(ctx: ScatterContext, x: number, z: number, r: number): void {
  ctx.taken.push([x, z, r + 2]);
  ctx.props.push({ kind: 'pond', x, z, rot: 0, w: r, d: r, h: 0, seed: ctx.rand() });
  const clumps = 3 + Math.floor(ctx.rand() * 4);
  for (let k = 0; k < clumps; k++) {
    const a = ctx.rand() * Math.PI * 2;
    ctx.props.push({ kind: 'reeds', x: x + Math.cos(a) * r * 0.92, z: z + Math.sin(a) * r * 0.92, rot: a, w: 2, d: 2, h: 2, seed: ctx.rand() });
  }
}

/** A quay line's direction, its right-hand normal on screen, and its length. */
function line(from: XZ, to: XZ): { dx: number; dz: number; nx: number; nz: number; len: number } {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const dx = (to[0] - from[0]) / len, dz = (to[1] - from[1]) / len;
  // +X is screen right and +Z screen down, so turning the direction right on screen is (dx, dz) -> (-dz, dx).
  return { dx, dz, nx: -dz, nz: dx, len };
}
