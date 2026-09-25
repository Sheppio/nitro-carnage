import { Surface } from '../surfaces.js';
import type { TrackDef } from './TrackDef.js';

/**
 * Tidewater Docks — a container port under an overcast sky.
 *
 * Tight right angles through canyons of stacked containers, a flat-out run
 * along the quay with nothing between the road and the harbour, oil where the
 * straddle carriers park, and a railway across the south straight. The train
 * keeps its own timetable and does not stop for anybody.
 */
export const DOCKS: TrackDef = {
  id: 'docks',
  name: 'Tidewater Docks',
  laps: 3,
  seed: 0xd0c45,
  theme: 'overcast',

  corners: [
    [0, 0, 18],
    [300, 0, 20],
    [300, 140, 16],
    [200, 140, 14],
    [200, 220, 14],
    [330, 220, 16],
    [330, 360, 18],
    [60, 360, 18],
    [60, 240, 14],
    [120, 240, 14],
    [120, 160, 14],
    [0, 160, 16],
  ],

  width: 13,
  verge: { width: 2, surface: Surface.Kerb },
  walls: true,
  // The quay: the harbour is on the left the whole way along the north straight.
  wallGaps: [{ from: 0.03, to: 0.13, side: 'left' }],
  water: [[-240, -300, 560, -8.5]],
  railway: { from: [250, 280], to: [250, 720], first: 18, period: 42, speed: 18, cars: 5 },

  start: [90, 0],
  checkpoints: [0.25, 0.5, 0.75],

  surfaces: [
    { shape: 'circle', at: [203, 186], r: 3.5, surface: Surface.Oil },
    { shape: 'circle', at: [120, 357], r: 4, surface: Surface.Oil },
    { shape: 'circle', at: [327, 300], r: 3, surface: Surface.Oil },
  ],

  ramps: [],

  props: [
    // A working port (M10): warehouses first, so the container stacks keep off them; yards between the stacks.
    { kind: 'warehouses', count: 4, clearance: 3 },
    { kind: 'containers', area: [-160, 20, 480, 520], clearance: 1.5, stack: 4, gaps: 0.1, yards: 0.2 },
    { kind: 'cranes', at: [[70, -20, 0], [170, -20, 0], [240, -20, 0]] },
    // One ship moored under the crane booms, one off the corner where the quay turns, and a marina off the other
    // corner: where the camera looks. The harbour is north, to the left of these lines, so `out` is negative.
    { kind: 'ships', from: [60, -8.5], to: [260, -8.5], out: -40, count: 1 },
    { kind: 'ships', from: [300, -8.5], to: [460, -8.5], out: -16, count: 1 },
    { kind: 'marina', from: [-110, -8.5], to: [-12, -8.5], out: -6 },
  ],
};
