import { Surface } from '../surfaces.js';
import type { TrackDef } from './TrackDef.js';

/**
 * Neon Downtown — a city-grid circuit at dusk.
 *
 * Clockwise on screen: a long north straight with a flat-out kink, down the
 * east side into a square notch cut around one block, a long south straight,
 * a second notch around the old quarter, and back up the west side over the
 * plaza ramp. Mostly right-angled corners with tight radii, walled on both
 * sides — the circuit that rewards braking late and punishes missing a turn.
 */
export const DOWNTOWN: TrackDef = {
  id: 'downtown',
  name: 'Neon Downtown',
  laps: 3,
  seed: 0x0d0e7011,
  theme: 'dusk',

  corners: [
    [0, 0, 22],
    // The kink: fast, but only on the right line.
    [128, 0, 40],
    [152, 11, 40],
    [184, 11, 40],
    [208, 0, 40],
    [336, 0, 22],
    [336, 120, 18],
    [240, 120, 16],
    [240, 216, 16],
    [336, 216, 20],
    [336, 336, 24],
    [144, 336, 18],
    [144, 264, 14],
    [72, 264, 14],
    [72, 336, 14],
    [0, 336, 22],
  ],

  width: 14,
  verge: { width: 3, surface: Surface.Kerb },
  walls: true,

  start: [60, 0],
  checkpoints: [0.25, 0.5, 0.75],

  surfaces: [],

  ramps: [{ at: [0, 170], len: 14, lift: 1.4 }],

  props: [
    {
      kind: 'city',
      area: [-150, -150, 490, 490],
      lot: 20,
      clearance: 0.5,
      footprint: [12, 18],
      height: [10, 34],
      gaps: 0.05,
      tallness: 0.9,
    },
    { kind: 'lamps', spacing: 28 },
  ],
};

/**
 * The same streets by day (M10): a high sun, glass instead of lit windows,
 * the lamps off. Its own track, so it has its own hotlap record.
 */
export const DOWNTOWN_DAY: TrackDef = { ...DOWNTOWN, id: 'downtown-day', name: 'Downtown by Day', theme: 'day' };
