import { mulberry32 } from '../../util.js';
import { Surface } from '../surfaces.js';
import { filletPolygon, resample, TrackGeometryError } from './centreline.js';
import type { Centreline } from './centreline.js';
import type { TrackDef } from './TrackDef.js';

/** Where a point is relative to the road. */
export interface Projection {
  /** Arc length along the centreline, 0 at the start line, in [0, length). */
  s: number;
  /** Signed lateral offset, metres; positive is left of the direction of travel. */
  d: number;
  /** Nearest sample index — pass it back as the hint next time. */
  i: number;
}

export type PropKind = 'tower' | 'tree' | 'lamp' | 'container' | 'crane';

/** One piece of scenery. Purely visual in M1: everything solid is behind a wall. */
export interface Prop {
  kind: PropKind;
  x: number;
  z: number;
  /** Yaw, radians. */
  rot: number;
  /** Footprint along local X and Z, and height. */
  w: number;
  d: number;
  h: number;
  /** Per-instance variation (window pattern, colour pick), 0..1. */
  seed: number;
  /** Height the prop stands at: a container stacked on others. */
  y?: number;
}

export interface Ramp {
  s0: number;
  s1: number;
  lift: number;
}

const WALL_SPACING = 2;
const GRID = 16;

/**
 * A track, built from its `TrackDef`: the centreline table, the walls, the
 * surfaces, the ramps and the scenery. Everything the car physics asks about
 * the world goes through the queries on this class, and all of it is
 * deterministic, so every client builds an identical copy from the same data.
 */
export class Track {
  readonly line: Centreline;
  readonly n: number;
  readonly length: number;
  readonly halfWidth: number;
  /** Distance from the centreline to the wall face. */
  readonly wallOffset: number;
  /** Wall segments, 6 floats each: ax, az, bx, bz, nx, nz (unit normal, pointing onto the road). */
  readonly walls: Float64Array;
  readonly wallCount: number;
  readonly checkpoints: number[];
  readonly ramps: Ramp[];
  readonly props: Prop[];

  private wallGrid = new Map<number, number[]>();
  private sampleGrid = new Map<number, number[]>();
  /** Per-query dedupe stamps for the wall grid, so a segment in two cells is tested once. */
  private wallStamp: Uint32Array;
  private stamp = 0;
  private circles: { x: number; z: number; r2: number; surface: Surface }[] = [];
  private waters: readonly (readonly [number, number, number, number])[];
  /**
   * The railway, if the track has one: its ends, its unit direction and
   * length, and where it crosses the road (the point, its arc length, and how
   * far along the rail that is).
   */
  readonly rail: {
    ax: number; az: number; bx: number; bz: number; dx: number; dz: number; length: number;
    x: number; z: number; s: number; u: number;
  } | null = null;
  private spans: { from: number; to: number; surface: Surface }[] = [];

  constructor(readonly def: TrackDef) {
    this.line = resample(filletPolygon(def.corners), def.start);
    this.n = this.line.px.length;
    this.length = this.line.length;
    this.halfWidth = def.width / 2;
    this.wallOffset = this.halfWidth + def.verge.width;

    for (let i = 0; i < this.n; i++) {
      const key = cellKey(this.line.px[i]!, this.line.pz[i]!);
      let cell = this.sampleGrid.get(key);
      if (!cell) this.sampleGrid.set(key, (cell = []));
      cell.push(i);
    }

    // Walls: the offset curves, one segment every WALL_SPACING samples.
    const segs: number[] = [];
    const spacing = this.length / this.n;
    const open = (side: 1 | -1, i: number): boolean =>
      (def.wallGaps ?? []).some((g) => (g.side === 'left' ? 1 : -1) === side && inSpan(i * spacing, g.from * this.length, g.to * this.length));
    if (def.walls) {
      const step = WALL_SPACING;
      for (const side of [1, -1] as const) {
        for (let i = 0; i < this.n; i += step) {
          if (open(side, i + step / 2)) continue;
          // The last segment closes the loop exactly at sample 0, however the
          // lap length divides: overshooting would overlap the first segment.
          const j = Math.min(i + step, this.n) % this.n;
          const a = this.offsetPoint(i, side * this.wallOffset);
          const b = this.offsetPoint(j, side * this.wallOffset);
          // Normal points back onto the road: right of the left wall, left of the right.
          let nx = b[1] - a[1];
          let nz = -(b[0] - a[0]);
          const len = Math.hypot(nx, nz) || 1;
          nx /= len;
          nz /= len;
          if (side === 1) {
            nx = -nx;
            nz = -nz;
          }
          segs.push(a[0], a[1], b[0], b[1], nx, nz);
        }
      }
    }
    this.walls = Float64Array.from(segs);
    this.wallCount = segs.length / 6;
    this.wallStamp = new Uint32Array(this.wallCount);
    for (let k = 0; k < this.wallCount; k++) {
      const o = k * 6;
      const x0 = Math.min(this.walls[o]!, this.walls[o + 2]!);
      const x1 = Math.max(this.walls[o]!, this.walls[o + 2]!);
      const z0 = Math.min(this.walls[o + 1]!, this.walls[o + 3]!);
      const z1 = Math.max(this.walls[o + 1]!, this.walls[o + 3]!);
      for (let cx = Math.floor(x0 / GRID); cx <= Math.floor(x1 / GRID); cx++) {
        for (let cz = Math.floor(z0 / GRID); cz <= Math.floor(z1 / GRID); cz++) {
          const key = packCell(cx, cz);
          let cell = this.wallGrid.get(key);
          if (!cell) this.wallGrid.set(key, (cell = []));
          cell.push(k);
        }
      }
    }

    this.checkpoints = def.checkpoints.map((f) => f * this.length);

    for (const zone of def.surfaces) {
      if (zone.shape === 'circle') {
        this.circles.push({ x: zone.at[0], z: zone.at[1], r2: zone.r * zone.r, surface: zone.surface });
      } else {
        this.spans.push({ from: zone.from * this.length, to: zone.to * this.length, surface: zone.surface });
      }
    }

    this.waters = def.water ?? [];
    if (def.railway) {
      const [ax, az] = def.railway.from;
      const [bx, bz] = def.railway.to;
      const length = Math.hypot(bx - ax, bz - az);
      const dx = (bx - ax) / length, dz = (bz - az) / length;
      // Where along the rail it meets the road: the point nearest the centreline.
      let bestU = 0, bestD = Infinity;
      for (let u = 0; u <= length; u += 0.25) {
        const d = Math.abs(this.project(ax + dx * u, az + dz * u).d);
        if (d < bestD) {
          bestD = d;
          bestU = u;
        }
      }
      const x = ax + dx * bestU, z = az + dz * bestU;
      this.rail = { ax, az, bx, bz, dx, dz, length, x, z, s: this.project(x, z).s, u: bestU };
    }

    this.ramps = def.ramps.map((r) => {
      const p = this.project(r.at[0], r.at[1]);
      return { s0: p.s - r.len / 2, s1: p.s + r.len / 2, lift: r.lift };
    });

    this.props = scatter(this);
  }

  /** Point at sample `i`, offset `d` metres to the left. */
  offsetPoint(i: number, d: number): [number, number] {
    const { px, pz, tx, tz } = this.line;
    // Left of travel direction (tx, tz) is (tz, -tx).
    return [px[i]! + tz[i]! * d, pz[i]! - tx[i]! * d];
  }

  /** Wrap an arc length into [0, length). */
  wrapS(s: number): number {
    const L = this.length;
    return ((s % L) + L) % L;
  }

  /** Signed shortest difference b - a along the loop. */
  deltaS(a: number, b: number): number {
    const L = this.length;
    let d = (b - a) % L;
    if (d > L / 2) d -= L;
    if (d < -L / 2) d += L;
    return d;
  }

  /**
   * Project a point onto the centreline.
   *
   * With a hint (the index returned last time) this is a local search a few
   * samples either way — a car moves at most about a metre per step — so it is
   * O(1) and cannot jump to a different stretch of road that happens to pass
   * nearby. Without one, or when the hint has gone stale, it falls back to the
   * sample grid.
   */
  project(x: number, z: number, hint = -1): Projection {
    const { px, pz } = this.line;
    const n = this.n;
    let best = -1;
    let bestD = Infinity;

    if (hint >= 0 && hint < n) {
      for (let k = -12; k <= 12; k++) {
        const i = (hint + k + n) % n;
        const d = (px[i]! - x) ** 2 + (pz[i]! - z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      // Stale hint (a teleport): the best local sample is far away.
      if (bestD > (this.wallOffset + 12) ** 2) best = -1;
    }

    if (best < 0) {
      bestD = Infinity;
      const cx = Math.floor(x / GRID);
      const cz = Math.floor(z / GRID);
      for (let r = 1; r <= 4 && best < 0; r++) {
        for (let gx = cx - r; gx <= cx + r; gx++) {
          for (let gz = cz - r; gz <= cz + r; gz++) {
            const cell = this.sampleGrid.get(packCell(gx, gz));
            if (!cell) continue;
            for (const i of cell) {
              const d = (px[i]! - x) ** 2 + (pz[i]! - z) ** 2;
              if (d < bestD) {
                bestD = d;
                best = i;
              }
            }
          }
        }
      }
      if (best < 0) {
        for (let i = 0; i < n; i++) {
          const d = (px[i]! - x) ** 2 + (pz[i]! - z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }

    // Refine along the tangent: samples are a metre apart, and a metre of
    // quantisation in `s` would make lap timing and position jittery.
    const tx = this.line.tx[best]!;
    const tz = this.line.tz[best]!;
    const rx = x - px[best]!;
    const rz = z - pz[best]!;
    const along = Math.max(-0.5, Math.min(0.5, rx * tx + rz * tz));
    const d = rx * tz - rz * tx;
    const spacing = this.length / n;
    return { s: this.wrapS(best * spacing + along * spacing), d, i: best };
  }

  /** What the ground is at a point. `hint` as for `project`. */
  surfaceAt(x: number, z: number, hint = -1): Surface {
    for (const c of this.circles) {
      if ((x - c.x) ** 2 + (z - c.z) ** 2 < c.r2) return c.surface;
    }
    const p = this.project(x, z, hint);
    for (const span of this.spans) {
      if (inSpan(p.s, span.from, span.to)) return span.surface;
    }
    if (Math.abs(p.d) <= this.halfWidth) return Surface.Tarmac;
    if (Math.abs(p.d) > this.wallOffset && this.inWater(x, z)) return Surface.Water;
    return this.def.verge.surface;
  }

  /** Inside one of the track's water rectangles (whatever is built over it). */
  inWater(x: number, z: number): boolean {
    for (const [x0, z0, x1, z1] of this.waters) if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return true;
    return false;
  }

  /** Distance from a point to the railway line, or Infinity with no railway. */
  railDistance(x: number, z: number): number {
    const r = this.rail;
    if (!r) return Infinity;
    const u = Math.max(0, Math.min(r.length, (x - r.ax) * r.dx + (z - r.az) * r.dz));
    return Math.hypot(x - (r.ax + r.dx * u), z - (r.az + r.dz * u));
  }

  /** Ground height: zero everywhere except on a ramp. */
  groundAt(x: number, z: number, hint = -1): number {
    if (this.ramps.length === 0) return 0;
    const p = this.project(x, z, hint);
    if (Math.abs(p.d) > this.halfWidth) return 0;
    for (const r of this.ramps) {
      if (p.s >= r.s0 && p.s <= r.s1) return (r.lift * (p.s - r.s0)) / (r.s1 - r.s0);
    }
    return 0;
  }

  /**
   * Visit every wall segment whose grid cells overlap a box. Each segment is
   * visited once even when it spans several cells.
   */
  forWallsNear(x0: number, z0: number, x1: number, z1: number, fn: (k: number) => void): void {
    if (this.wallCount === 0) return;
    if (++this.stamp === 0xffffffff) {
      this.wallStamp.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    for (let cx = Math.floor(x0 / GRID); cx <= Math.floor(x1 / GRID); cx++) {
      for (let cz = Math.floor(z0 / GRID); cz <= Math.floor(z1 / GRID); cz++) {
        const cell = this.wallGrid.get(packCell(cx, cz));
        if (!cell) continue;
        for (const k of cell) {
          if (this.wallStamp[k] === stamp) continue;
          this.wallStamp[k] = stamp;
          fn(k);
        }
      }
    }
  }

  /** Centreline position and heading at an arc length. */
  poseAt(s: number): { x: number; z: number; yaw: number; i: number } {
    const spacing = this.length / this.n;
    const f = this.wrapS(s) / spacing;
    const i = Math.floor(f) % this.n;
    const j = (i + 1) % this.n;
    const t = f - Math.floor(f);
    const { px, pz, tx, tz } = this.line;
    const x = px[i]! + (px[j]! - px[i]!) * t;
    const z = pz[i]! + (pz[j]! - pz[i]!) * t;
    // Yaw 0 faces +Z, so heading (sin yaw, cos yaw) = tangent.
    return { x, z, yaw: Math.atan2(tx[i]!, tz[i]!), i };
  }

  /**
   * Grid slots behind the start line: two staggered columns, three rows.
   * Slot 0 is pole.
   */
  gridSlot(slot: number): { x: number; z: number; yaw: number } {
    const row = Math.floor(slot / 2);
    const col = slot % 2;
    const s = -10 - row * 9 - col * 4.5;
    const pose = this.poseAt(s);
    const d = (col === 0 ? 1 : -1) * this.halfWidth * 0.45;
    const [x, z] = this.offsetPoint(pose.i, d);
    const spacing = this.length / this.n;
    const frac = this.wrapS(s) / spacing - pose.i;
    return { x: x + this.line.tx[pose.i]! * frac, z: z + this.line.tz[pose.i]! * frac, yaw: pose.yaw };
  }
}

function inSpan(s: number, from: number, to: number): boolean {
  return from <= to ? s >= from && s <= to : s >= from || s <= to;
}

/** Points round a unit footprint at which to test clearance: corners, edge midpoints, centre. */
const FOOTPRINT_PROBES: readonly (readonly [number, number])[] = [
  [-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0], [0, 0],
];

const packCell = (cx: number, cz: number): number => (cx + 4096) * 8192 + (cz + 4096);
const cellKey = (x: number, z: number): number => packCell(Math.floor(x / GRID), Math.floor(z / GRID));

/**
 * Seeded procedural scenery. The same seed always yields the same world,
 * which matters once the scenery can be driven into: every client has to
 * agree where the trees are.
 */
function scatter(track: Track): Prop[] {
  const def = track.def;
  const rand = mulberry32(def.seed);
  const props: Prop[] = [];

  /** Distance from a point to the road centreline, without a hint. */
  const roadDist = (x: number, z: number): number => Math.abs(track.project(x, z).d);
  /** Somewhere nothing may stand: the railway's corridor, or the water. */
  const blocked = (x: number, z: number, r: number): boolean => track.railDistance(x, z) < r + 5 || track.inWater(x, z);

  for (const rule of def.props) {
    if (rule.kind === 'city') {
      const [x0, z0, x1, z1] = rule.area;
      for (let lx = x0; lx < x1; lx += rule.lot) {
        for (let lz = z0; lz < z1; lz += rule.lot) {
          const gap = rand();
          let w = rule.footprint[0] + rand() * (rule.footprint[1] - rule.footprint[0]);
          let d = rule.footprint[0] + rand() * (rule.footprint[1] - rule.footprint[0]);
          const hr = rand() ** (2 - rule.tallness);
          const h = rule.height[0] + hr * (rule.height[1] - rule.height[0]);
          const seed = rand();
          if (gap < rule.gaps) continue;
          const x = lx + rule.lot / 2;
          const z = lz + rule.lot / 2;
          const keep = track.wallOffset + rule.clearance;
          // Test the footprint itself — corners and edge midpoints — rather
          // than its bounding circle, and shrink a building to fit before
          // giving up on the lot. The circle test left a 20 m moat of empty
          // lots along every road, and a city that stands back from the
          // street has nothing to lean over it.
          let fits = false;
          for (let tries = 0; tries < 5 && !fits; tries++) {
            fits = true;
            for (const [fx, fz] of FOOTPRINT_PROBES) {
              if (roadDist(x + (fx * w) / 2, z + (fz * d) / 2) < keep) {
                fits = false;
                break;
              }
            }
            if (!fits) {
              w *= 0.8;
              d *= 0.8;
            }
          }
          if (!fits || Math.min(w, d) < 6 || blocked(x, z, Math.max(w, d) / 2)) continue;
          props.push({ kind: 'tower', x, z, rot: 0, w, d, h, seed });
        }
      }
    } else if (rule.kind === 'lamps') {
      const every = Math.max(4, Math.round(rule.spacing / (track.length / track.n)));
      for (let i = 0; i < track.n; i += every) {
        for (const side of [1, -1]) {
          const [x, z] = track.offsetPoint(i, side * (track.wallOffset + 1.4));
          // The inside of a tight corner folds the offset curve back towards
          // the road; a lamp there would stand in the traffic.
          if (roadDist(x, z) < track.wallOffset + 0.8) continue;
          // Facing the road: the arm reaches out over the pavement.
          const rot = Math.atan2(track.line.px[i]! - x, track.line.pz[i]! - z);
          props.push({ kind: 'lamp', x, z, rot, w: 0.3, d: 0.3, h: 7, seed: rand() });
        }
      }
    } else if (rule.kind === 'trees') {
      const [x0, z0, x1, z1] = rule.area;
      for (let k = 0; k < rule.count; k++) {
        const x = x0 + rand() * (x1 - x0);
        const z = z0 + rand() * (z1 - z0);
        const h = rule.height[0] + rand() * (rule.height[1] - rule.height[0]);
        const seed = rand();
        if (roadDist(x, z) < track.wallOffset + rule.clearance || blocked(x, z, h * 0.25)) continue;
        props.push({ kind: 'tree', x, z, rot: seed * Math.PI * 2, w: h * 0.45, d: h * 0.45, h, seed });
      }
    } else if (rule.kind === 'containers') {
      // A 40 ft box is 12.2 x 2.4 x 2.6 m. Lots hold a row of three side by
      // side, so stacks read as blocks with alleys between them.
      const [x0, z0, x1, z1] = rule.area;
      const LW = 14, LD = 9;
      for (let lx = x0; lx < x1; lx += LW + 3) {
        for (let lz = z0; lz < z1; lz += LD + 3) {
          const gap = rand();
          const along = rand() < 0.5;
          const seed = rand();
          if (gap < rule.gaps) continue;
          const x = lx + LW / 2, z = lz + LD / 2;
          const w = along ? 12.2 : 7.4, d = along ? 7.4 : 12.2;
          let clear = true;
          for (const [fx, fz] of FOOTPRINT_PROBES) {
            if (roadDist(x + (fx * w) / 2, z + (fz * d) / 2) < track.wallOffset + rule.clearance) clear = false;
          }
          if (!clear || blocked(x, z, 7)) continue;
          for (let k = 0; k < 3; k++) {
            const off = (k - 1) * 2.5;
            const levels = 1 + Math.floor(rand() * rule.stack);
            for (let lv = 0; lv < levels; lv++) {
              props.push({
                kind: 'container', x: x + (along ? 0 : off), z: z + (along ? off : 0), rot: along ? Math.PI / 2 : 0,
                w: 2.4, d: 12.2, h: 2.6, y: lv * 2.6, seed: (seed + k * 0.37 + lv * 0.61) % 1,
              });
            }
          }
        }
      }
    } else if (rule.kind === 'cranes') {
      for (const [x, z, rot] of rule.at) props.push({ kind: 'crane', x, z, rot, w: 14, d: 10, h: 34, seed: rand() });
    }
  }
  return props;
}

export { TrackGeometryError };
