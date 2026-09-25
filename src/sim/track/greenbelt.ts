import { Surface } from '../surfaces.js';
import type { TrackDef } from './TrackDef.js';

/**
 * Greenbelt — a park circuit on a summer afternoon.
 *
 * The opposite of Downtown: fast, flowing curves with generous radii, and
 * grass rather than kerb either side, so running wide costs time instead of a
 * wall. In places there is no wall at all, only more grass and the trees. A
 * gravel stretch through the old quarry, and a jump over the creek on the
 * back straight. Farmland all round (M10): farms, fields, cattle and sheep,
 * windmills, and a duck pond by the open lawn.
 */
export const GREENBELT: TrackDef = {
  id: 'greenbelt',
  name: 'Greenbelt',
  laps: 3,
  seed: 0x6e2ee4,
  theme: 'park',

  corners: [
    [0, 0, 33],
    [145, -20, 46],
    [251, 26, 36],
    [264, 125, 30],
    [198, 172, 26],
    [218, 251, 33],
    [119, 284, 40],
    [26, 251, 30],
    [-26, 165, 33],
    [26, 99, 26],
    [-20, 53, 26],
  ],

  width: 16.25,
  verge: { width: 6, surface: Surface.Grass },
  walls: true,
  // Open parkland: no barrier, just the lawn running on into the trees.
  wallGaps: [
    { from: 0.115, to: 0.185, side: 'left' },
    { from: 0.49, to: 0.54, side: 'right' },
  ],
  // The creek, bridged by the road just past the jump.
  water: [[57, 238, 61, 310]],
  // The duck pond, just past the open lawn after the first corner: leave the road there and you are in it.
  ponds: [[201, -20, 9]],

  start: [61, -8],
  checkpoints: [0.25, 0.5, 0.75],

  surfaces: [{ shape: 'span', from: 0.328, to: 0.365, surface: Surface.Dirt }],

  ramps: [{ at: [71, 267], len: 14, lift: 1.6 }],

  // Farmland round the park (M10), placed before the trees so the trees keep off it.
  props: [
    { kind: 'farms', count: 2, clearance: 3 },
    { kind: 'windmills', count: 2, clearance: 3 },
    { kind: 'fields', count: 6, clearance: 2 },
    { kind: 'herds', count: 4, clearance: 2 },
    { kind: 'flowers', spacing: 36 },
    { kind: 'trees', area: [-132, -132, 409, 422], count: 1400, clearance: 2.5, height: [7, 17] },
  ],
};
