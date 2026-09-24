import type { InputSettings } from './settings.js';

export type SchemeId = 'keys' | 'pad' | 'touch';

/** One device's reading this frame, before the manager picks a winner. */
export interface DriveSample {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
  /** Held state; the manager turns these into edges. */
  front: boolean;
  rear: boolean;
  turbo: boolean;
  /** True if the user touched this device since the last poll. */
  active: boolean;
}

export interface InputSource {
  readonly id: SchemeId;
  readonly label: string;
  /** Whether the source is usable at all right now (e.g. a pad is connected). */
  available(): boolean;
  poll(dt: number, settings: Readonly<InputSettings>): DriveSample;
  destroy(): void;
}

export const EMPTY_SAMPLE: Readonly<DriveSample> = Object.freeze({
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  front: false,
  rear: false,
  turbo: false,
  active: false,
});

/**
 * Hardware drift floor, applied per axis before anything else looks at a stick.
 *
 * Worn analogue sticks — the Steam Deck's after a year of travel, an old
 * DualShock — rest at a non-zero value. Left alone that reads as a held
 * direction: the car drifts into a wall while nobody is touching the pad.
 */
export const HARDWARE_DEADZONE = 0.15;

/** Per-axis drift filter. Independent of the deadzone applied afterwards. */
export function filterAxis(value: number): number {
  return Math.abs(value) < HARDWARE_DEADZONE ? 0 : value;
}

/**
 * One-axis deadzone with rescale, so the stick still reaches full lock at the
 * rim. Never divides by zero: a zero deadzone with a centred stick is 0/0,
 * and in glitchburst that NaN made every bullet a hit.
 */
export function applyDeadzone1(value: number, deadzone: number): number {
  const mag = Math.abs(value);
  if (mag === 0 || mag <= deadzone || deadzone >= 1) return 0;
  return Math.sign(value) * Math.min(1, (mag - deadzone) / (1 - deadzone));
}
