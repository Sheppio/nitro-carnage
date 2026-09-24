import type { Surface } from '../surfaces.js';

/** A world-space point on the XZ plane, metres. */
export type XZ = readonly [x: number, z: number];

/**
 * A track, as data.
 *
 * Track files export exactly one of these and contain no logic. They are TS
 * modules rather than JSON because a `tsc`-only build and the Node tests can
 * both import them with no loader — and because the compiler then checks the
 * data against this schema. `test/sim.test.mjs` validates the geometry at
 * runtime on top of that: closed loop, no wall crossing itself, reachable
 * checkpoints.
 *
 * Coordinates: +X is east (screen right), +Z is south (screen down).
 */
export interface TrackDef {
  id: string;
  name: string;
  laps: number;
  /** Seeds every scatter rule, so all clients build the same world. */
  seed: number;
  /** Key into the renderer's theme table: sky, fog, ground, light. */
  theme: string;

  /**
   * The centreline as a closed control polygon: `[x, z, radius]` per corner.
   *
   * Each corner is rounded with a circular fillet of that radius, and the road
   * runs straight between fillets. A fillet radius rather than a spline
   * control point, because the radius is the one number that decides both how
   * fast a corner can be taken and whether the inside wall — offset from the
   * centreline by half the road plus the pavement — folds back over itself.
   * With a spline that has to be discovered; with a fillet it is written down.
   */
  corners: readonly (readonly [x: number, z: number, radius: number])[];

  /** Road width, metres. */
  width: number;
  /** What lies either side of the road, out to the wall. */
  verge: { width: number; surface: Surface };
  /** Walls at the edge of the verge on both sides. */
  walls: boolean;

  /** A point on or near the start/finish line; projected onto the centreline. */
  start: XZ;
  /** Ordered checkpoints as fractions of a lap (the start line is implicit). */
  checkpoints: readonly number[];

  /** Extra surface patches on top of road/verge: dirt spans, oil circles. */
  surfaces: readonly SurfaceZone[];

  /** Wedge ramps across the road. `at` is projected; the ramp is centred there. */
  ramps: readonly { at: XZ; len: number; lift: number }[];

  props: readonly PropRule[];
}

export type SurfaceZone =
  | { shape: 'circle'; at: XZ; r: number; surface: Surface }
  | { shape: 'span'; from: number; to: number; surface: Surface };

export type PropRule =
  /** Fill a rectangle with towers on a lot grid, keeping clear of the road. */
  | {
      kind: 'city';
      area: readonly [x0: number, z0: number, x1: number, z1: number];
      lot: number;
      clearance: number;
      footprint: readonly [min: number, max: number];
      height: readonly [min: number, max: number];
      /** Fraction of lots left empty (plazas, car parks). */
      gaps: number;
      /**
       * Height distribution: the random draw is raised to `2 - tallness`, so 0
       * skews towards low blocks with a few landmarks and 1 is uniform.
       */
      tallness: number;
    }
  /** Lamp posts along both walls. */
  | { kind: 'lamps'; spacing: number }
  /** Trees scattered in a rectangle, keeping clear of the road. */
  | {
      kind: 'trees';
      area: readonly [x0: number, z0: number, x1: number, z1: number];
      count: number;
      clearance: number;
      height: readonly [min: number, max: number];
    };
