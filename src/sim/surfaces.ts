/**
 * What the tyres are on.
 *
 * One table, read by the car physics per axle. Grip is a multiplier on the
 * car's tarmac friction; drag is extra rolling resistance, which is what makes
 * grass *slow* you rather than merely slide you — otherwise cutting a corner
 * across the lawn would be free.
 */
export enum Surface {
  Tarmac = 0,
  Dirt = 1,
  Grass = 2,
  Oil = 3,
  /** Kerbs and pavements: tarmac grip, a touch of drag. */
  Kerb = 4,
}

export interface SurfaceDef {
  name: string;
  grip: number;
  /** Extra deceleration, m/s^2, proportional to how much of the car is on it. */
  drag: number;
}

export const SURFACES: Record<Surface, SurfaceDef> = {
  [Surface.Tarmac]: { name: 'tarmac', grip: 1.0, drag: 0 },
  [Surface.Dirt]: { name: 'dirt', grip: 0.7, drag: 1.2 },
  [Surface.Grass]: { name: 'grass', grip: 0.55, drag: 3.0 },
  [Surface.Oil]: { name: 'oil', grip: 0.18, drag: 0 },
  [Surface.Kerb]: { name: 'kerb', grip: 0.95, drag: 0.3 },
};
