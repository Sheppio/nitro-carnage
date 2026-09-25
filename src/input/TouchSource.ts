import { EMPTY_SAMPLE } from './sources.js';
import type { DriveSample, InputSource } from './sources.js';

type Action = 'throttle' | 'brake' | 'handbrake' | 'front' | 'rear' | 'turbo';

/** Pixels of thumb travel from where it landed to full lock. */
const STEER_TRAVEL = 110;
/**
 * Response curve: the thumb's travel is raised to this power, so the first
 * half of the slider is fine control and full lock is at the end. Linear, a
 * nudge at speed was already a big bite of lock.
 */
const STEER_CURVE = 1.7;
/** Seconds for the wheel to follow the thumb from centre to full lock, and back. */
const STEER_IN = 0.12;
const STEER_OUT = 0.07;

/**
 * Touch driving: steer with the left thumb, pedals and weapons under the right.
 *
 * The steering zone is a floating slider — wherever the thumb lands is centre
 * — because a fixed one is always slightly in the wrong place for somebody's
 * hand, and there is no tactile edge on glass to find it by. Only the
 * horizontal travel counts: a car has one steering axis, and a stick that also
 * read vertical would let a thumb that drifts upward start braking.
 *
 * The layer only exists while a race is on screen. glitchburst learned that
 * one the hard way: an invisible full-screen touch layer over the menu
 * swallowed every tap on a phone.
 */
export class TouchSource implements InputSource {
  readonly id = 'touch' as const;
  readonly label = 'Touch';

  readonly root: HTMLDivElement;
  private knob: HTMLDivElement;
  private base: HTMLDivElement;
  private steerPointer: number | null = null;
  private originX = 0;
  private steer = 0;
  /** Where the thumb says the wheel should be; `steer` follows it at the rack's pace. */
  private steerTarget = 0;
  /** The thumb's own position on the slider, -1..1, for drawing the knob under it. */
  private thumb = 0;
  private held = new Map<Action, Set<number>>();
  private dirty = false;
  private enabled = false;

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'touch-layer';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="touch-steer" data-touch-steer>
        <div class="touch-steer-base"><div class="touch-steer-knob"></div></div>
      </div>
      <div class="touch-pad">
        <button class="touch-btn weapon" data-drive="front" aria-label="Front weapon">▲</button>
        <button class="touch-btn weapon" data-drive="rear" aria-label="Rear weapon">▼</button>
        <button class="touch-btn turbo" data-drive="turbo" aria-label="Turbo">TURBO</button>
        <button class="touch-btn hb" data-drive="handbrake" aria-label="Handbrake">HB</button>
        <button class="touch-btn pedal brake" data-drive="brake" aria-label="Brake">◼</button>
        <button class="touch-btn pedal gas" data-drive="throttle" aria-label="Accelerate">▶</button>
      </div>`;
    host.appendChild(this.root);
    this.base = this.root.querySelector('.touch-steer-base')!;
    this.knob = this.root.querySelector('.touch-steer-knob')!;

    const steerZone = this.root.querySelector<HTMLElement>('[data-touch-steer]')!;
    steerZone.addEventListener('pointerdown', this.onSteerDown);
    for (const btn of this.root.querySelectorAll<HTMLElement>('[data-drive]')) {
      btn.addEventListener('pointerdown', (e) => this.onButton(e, btn.dataset.drive as Action));
    }
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.root.hidden = !on;
    if (!on) this.reset();
  }

  available(): boolean {
    return this.enabled;
  }

  poll(dt = 1 / 60): DriveSample {
    const on = (a: Action): boolean => (this.held.get(a)?.size ?? 0) > 0;
    // Wind the wheel towards the thumb, as the keyboard does: glass has no
    // resistance, and a thumb flicked across it was full lock in one frame —
    // at speed, a car snapped sideways. (Touch had none of this until M7.)
    const t = this.steerTarget;
    const rate = t === 0 || Math.sign(t) !== Math.sign(this.steer) ? 1 / STEER_OUT : 1 / STEER_IN;
    const step = rate * dt;
    this.steer += Math.max(-step, Math.min(step, t - this.steer));
    this.drawKnob();
    const sample: DriveSample = {
      ...EMPTY_SAMPLE,
      throttle: on('throttle') ? 1 : 0,
      brake: on('brake') ? 1 : 0,
      steer: this.steer,
      handbrake: on('handbrake'),
      front: on('front'),
      rear: on('rear'),
      turbo: on('turbo'),
      active: this.dirty,
    };
    this.dirty = false;
    return sample;
  }

  destroy(): void {
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
    this.root.remove();
  }

  private reset(): void {
    this.held.clear();
    this.steerPointer = null;
    this.steer = 0;
    this.steerTarget = 0;
    this.thumb = 0;
    this.drawKnob();
  }

  private onSteerDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.steerPointer = e.pointerId;
    this.originX = e.clientX;
    this.base.style.left = `${e.clientX}px`;
    this.base.style.top = `${e.clientY}px`;
    this.base.classList.add('active');
    this.steerTarget = 0;
    this.thumb = 0;
    this.dirty = true;
    this.drawKnob();
  };

  private onButton(e: PointerEvent, action: Action): void {
    e.preventDefault();
    let set = this.held.get(action);
    if (!set) this.held.set(action, (set = new Set()));
    set.add(e.pointerId);
    (e.currentTarget as HTMLElement).classList.add('down');
    this.dirty = true;
  }

  private onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.steerPointer) return;
    const dx = e.clientX - this.originX;
    const x = Math.max(-1, Math.min(1, dx / STEER_TRAVEL));
    this.thumb = x;
    this.steerTarget = Math.sign(x) * Math.abs(x) ** STEER_CURVE;
    this.dirty = true;
    this.drawKnob();
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.steerPointer) {
      this.steerPointer = null;
      this.steerTarget = 0;
      this.thumb = 0;
      this.base.classList.remove('active');
      this.drawKnob();
    }
    for (const [action, set] of this.held) {
      if (set.delete(e.pointerId) && set.size === 0) {
        this.root.querySelector(`[data-drive="${action}"]`)?.classList.remove('down');
      }
    }
  };

  private drawKnob(): void {
    this.knob.style.transform = `translate(calc(-50% + ${this.thumb * STEER_TRAVEL}px), -50%)`;
  }
}
