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
  // The notch's two sides, 37 m apart once the lap was shortened to about 30 s.
  minSeparation: 36,

  corners: [
    [0, 0, 14],
    // The kink: fast, but only on the right line.
    [67, 0, 21],
    [79, 6, 21],
    [96, 6, 21],
    [108, 0, 21],
    [175, 0, 14],
    [175, 62, 14],
    [125, 62, 14],
    [125, 112, 14],
    [175, 112, 14],
    [175, 175, 14],
    [75, 175, 14],
    [75, 137, 14],
    [37, 137, 14],
    [37, 175, 14],
    [0, 175, 14],
  ],

  width: 17.5,
  verge: { width: 3, surface: Surface.Kerb },
  walls: true,

  start: [55, 0],
  checkpoints: [0.25, 0.5, 0.75],

  surfaces: [],

  ramps: [{ at: [0, 88], len: 14, lift: 1.4 }],

  props: [
    {
      kind: 'city',
      area: [-78, -78, 255, 255],
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
