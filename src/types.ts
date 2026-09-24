/** Shared, engine-agnostic vocabulary. Nothing here imports three or touches the DOM. */

export type PlayerId = string;
export type RoomId = string;

/**
 * What the driver wants this step. Every input device — keyboard, pad, touch,
 * the autopilot — produces one of these, and nothing downstream knows which.
 */
export interface DriveIntent {
  /** 0..1 */
  throttle: number;
  /** 0..1 — brakes, then reverses once stopped. */
  brake: number;
  /** -1 (left) .. 1 (right). */
  steer: number;
  handbrake: boolean;
  /** Edge-triggered: true for exactly one step per press. */
  fireFront: boolean;
  fireRear: boolean;
  /** Held. */
  turbo: boolean;
}

export const IDLE_INTENT: Readonly<DriveIntent> = Object.freeze({
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  fireFront: false,
  fireRear: false,
  turbo: false,
});
