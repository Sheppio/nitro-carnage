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
  /** What shape of circuit it is, in words, for the menu (generated tracks only). */
  layout?: string;

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
  /**
   * Stretches with no wall on one side (M5): lap fractions, and which side of
   * the direction of travel. Past an open verge lies whatever the ground is —
   * grass in the park, water off the quay.
   */
  wallGaps?: readonly { from: number; to: number; side: 'left' | 'right' }[];
  /**
   * Water, as axis-aligned rectangles (M5). Off the road inside one, a car is
   * in the water and is put back on the road. Drawn by the renderer as well.
   */
  water?: readonly (readonly [x0: number, z0: number, x1: number, z1: number])[];
  /**
   * Round water (M10): ponds, as centre and radius. Water like `water`, so a
   * car that leaves the road into one — through a gap in the wall — is put
   * back. Drawn as ponds with reeds.
   */
  ponds?: readonly (readonly [x: number, z: number, r: number])[];
  /**
   * A railway with a level crossing (M5): a straight line of track from
   * `from` to `to` that crosses the road once. A train runs it on a timetable
   * measured from GO — first after `first` seconds, then every `period`,
   * alternating direction — so every client runs the same train with no
   * messages at all.
   */
  railway?: { from: XZ; to: XZ; first: number; period: number; speed: number; cars: number };

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
    }
  /** Shipping containers stacked on a lot grid in a rectangle, clear of the road (M5). */
  | {
      kind: 'containers';
      area: readonly [x0: number, z0: number, x1: number, z1: number];
      clearance: number;
      /** Tallest stack, in containers. */
      stack: number;
      gaps: number;
      /** Fraction of lots that are yards instead (M10): forklifts, flatbeds, pallets, crates, drums. */
      yards?: number;
    }
  /** Dockside cranes at fixed spots (M5): tall, open gantries the cut-away looks through. */
  | { kind: 'cranes'; at: readonly (readonly [x: number, z: number, rot: number])[] }
  /*
   * M10 scenery. Placed beside the road — a random point on the lap, either
   * side, just past the wall plus `clearance` — because the camera sees a
   * band about 70 m wide, and a farm half a kilometre off would never be seen.
   * Each claims its ground, and trees, containers and each other keep off it.
   * Visual only: nothing here collides.
   */
  /** Farmsteads: a house, a barn, silos, bales and a tractor. */
  | { kind: 'farms'; count: number; clearance: number }
  /** Crop fields: maize, wheat, ploughed or cut, sometimes with a combine or a tractor at work. */
  | { kind: 'fields'; count: number; clearance: number }
  /** Fenced paddocks of cows or sheep. */
  | { kind: 'herds'; count: number; clearance: number }
  /** Ponds with reeds (walled tracks only: these are not water to the simulation — see `ponds`). */
  | { kind: 'ponds'; count: number; clearance: number }
  /** Windmills, sails turning. */
  | { kind: 'windmills'; count: number; clearance: number }
  /** Flower beds along the outside of the walls, every `spacing` metres or so. */
  | { kind: 'flowers'; spacing: number }
  /** Warehouses beside the road. */
  | { kind: 'warehouses'; count: number; clearance: number }
  /**
   * Cargo ships moored along a quay line: `out` metres from the line to the
   * ship's centreline, positive to the right of from→to as seen on screen.
   */
  | { kind: 'ships'; from: XZ; to: XZ; out: number; count: number }
  /** A marina off a quay line: a pontoon `out` metres off (sign as for ships), fingers, yachts. */
  | { kind: 'marina'; from: XZ; to: XZ; out: number };
