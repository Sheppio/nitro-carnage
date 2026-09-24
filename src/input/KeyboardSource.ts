import { EMPTY_SAMPLE } from './sources.js';
import type { DriveSample, InputSource } from './sources.js';

const THROTTLE = new Set(['ArrowUp', 'KeyW']);
const BRAKE = new Set(['ArrowDown', 'KeyS']);
const LEFT = new Set(['ArrowLeft', 'KeyA']);
const RIGHT = new Set(['ArrowRight', 'KeyD']);
const HANDBRAKE = new Set(['Space']);
const FRONT = new Set(['KeyZ', 'KeyJ']);
const REAR = new Set(['KeyX', 'KeyK']);
const TURBO = new Set(['ShiftLeft', 'ShiftRight']);
const ALL = [THROTTLE, BRAKE, LEFT, RIGHT, HANDBRAKE, FRONT, REAR, TURBO];

/** Seconds to wind the wheel from centre to full lock, and back. */
const STEER_IN = 0.14;
const STEER_OUT = 0.08;

/**
 * Keyboard driving.
 *
 * Keys are digital, and digital steering at speed spins a car: full lock
 * arrives in one frame. So the steering value winds in over `STEER_IN` and
 * returns faster, which is the difference between a keyboard car that can
 * hold a line and one that can only oscillate around it. (The sim tightens
 * the lock with speed on top of this.)
 */
export class KeyboardSource implements InputSource {
  readonly id = 'keys' as const;
  readonly label = 'Keyboard';

  private keys = new Set<string>();
  /**
   * Discrete presses are latched rather than sampled. A quick tap can begin
   * and end between two polls, and a sampled-only reading would drop it — the
   * missile simply would not fire, intermittently.
   */
  private latched = new Set<string>();
  private steer = 0;
  private dirty = false;

  constructor() {
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  available(): boolean {
    return true;
  }

  poll(dt: number): DriveSample {
    const has = (set: Set<string>): boolean => {
      for (const k of set) if (this.keys.has(k) || this.latched.has(k)) return true;
      return false;
    };
    const target = (has(RIGHT) ? 1 : 0) - (has(LEFT) ? 1 : 0);
    const rate = target === 0 || Math.sign(target) !== Math.sign(this.steer) ? 1 / STEER_OUT : 1 / STEER_IN;
    const step = rate * dt;
    this.steer += Math.max(-step, Math.min(step, target - this.steer));

    const sample: DriveSample = {
      ...EMPTY_SAMPLE,
      throttle: has(THROTTLE) ? 1 : 0,
      brake: has(BRAKE) ? 1 : 0,
      steer: this.steer,
      handbrake: has(HANDBRAKE),
      front: has(FRONT),
      rear: has(REAR),
      turbo: has(TURBO),
      active: this.dirty,
    };
    this.latched.clear();
    this.dirty = false;
    return sample;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Don't eat typing in text fields.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (!ALL.some((set) => set.has(e.code))) return;
    e.preventDefault();
    this.keys.add(e.code);
    if (!e.repeat) this.latched.add(e.code);
    this.dirty = true;
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  /** Alt-tabbing away must not leave the throttle stuck down. */
  private onBlur = (): void => {
    this.keys.clear();
    this.latched.clear();
  };
}
