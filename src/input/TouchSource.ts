import { FEATURES, SIM } from '../config.js';
import { EMPTY_SAMPLE } from './sources.js';
import type { DriveSample, InputSource } from './sources.js';

type Action = 'throttle' | 'brake' | 'handbrake' | 'front' | 'rear' | 'turbo' | 'left' | 'right';
/** Steering by the floating slider, or by a left and a right button (#26). */
export type TouchSteer = 'slider' | 'buttons';

/**
 * The touch buttons' pictures (#24): drawn in `currentColor`, so each takes
 * its button's colour. Plain glyphs (▲ ◆ HB) read as placeholders.
 */
const ICON = {
  // A missile, nose up, with fins and a flame.
  front: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1.5c2.2 2 3.3 4.8 3.3 8.3v6.4H8.7V9.8c0-3.5 1.1-6.3 3.3-8.3Z"/><path fill="currentColor" opacity=".75" d="M8.7 11.5 5.5 15v2.2h3.2Zm6.6 0 3.2 3.5v2.2h-3.2Z"/><path fill="#ffb13c" d="M10 17.2h4l-.8 3.3L12 23l-1.2-2.5Z"/></svg>',
  // A mine: a ball of spikes with a light in the middle.
  mine: '<svg viewBox="0 0 24 24" aria-hidden="true"><g stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2M5.3 5.3l2.2 2.2M16.5 16.5l2.2 2.2M5.3 18.7l2.2-2.2M16.5 7.5l2.2-2.2"/></g><circle cx="12" cy="12" r="6" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="#ff4d2e"/></svg>',
  // A rear missile: the front one turned round.
  rear: '<svg viewBox="0 0 24 24" aria-hidden="true" style="transform:rotate(180deg)"><path fill="currentColor" d="M12 1.5c2.2 2 3.3 4.8 3.3 8.3v6.4H8.7V9.8c0-3.5 1.1-6.3 3.3-8.3Z"/><path fill="currentColor" opacity=".75" d="M8.7 11.5 5.5 15v2.2h3.2Zm6.6 0 3.2 3.5v2.2h-3.2Z"/><path fill="#ffb13c" d="M10 17.2h4l-.8 3.3L12 23l-1.2-2.5Z"/></svg>',
  // The dashboard's handbrake light: (P) in brackets.
  handbrake: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="6.5"/><path d="M4.2 6.5a9.5 9.5 0 0 0 0 11M19.8 6.5a9.5 9.5 0 0 1 0 11"/></g><path fill="currentColor" d="M10.3 8.6h2.4a2.3 2.3 0 0 1 0 4.6h-1v2.2h-1.4Zm1.4 1.3v2h1a1 1 0 0 0 0-2Z"/></svg>',
  // The brake: a wide pedal with grooves across it.
  brake: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="3" fill="currentColor"/><g stroke="#000" stroke-opacity=".35" stroke-width="1.6" stroke-linecap="round"><path d="M7 9.5h10M7 12h10M7 14.5h10"/></g></svg>',
  // The accelerator: a tall pedal, grooved, on its hinge.
  gas: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7.5" y="2.5" width="9" height="16" rx="2.5" fill="currentColor"/><g stroke="#000" stroke-opacity=".35" stroke-width="1.5" stroke-linecap="round"><path d="M10 6h4M10 9h4M10 12h4M10 15h4"/></g><rect x="9" y="19.5" width="6" height="2.5" rx="1" fill="currentColor" opacity=".7"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" d="M15 4.5 7.5 12l7.5 7.5"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" d="M9 4.5 16.5 12 9 19.5"/></svg>',
};

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
/** The steering buttons are digital, as keys are: they wind the wheel in at the keyboard's pace. */
const BUTTON_STEER_IN = 0.14;
const BUTTON_STEER_OUT = 0.08;

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
  private steerMode: TouchSteer = 'slider';
  private steerZone: HTMLElement;
  private steerButtons: HTMLElement;

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'touch-layer';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="touch-steer" data-touch-steer>
        <div class="touch-steer-base"><div class="touch-steer-knob"></div></div>
      </div>
      <div class="touch-steer-buttons" hidden>
        <button class="touch-btn steer" data-drive="left" aria-label="Steer left">${ICON.left}</button>
        <button class="touch-btn steer" data-drive="right" aria-label="Steer right">${ICON.right}</button>
      </div>
      <div class="touch-pad">
        <button class="touch-btn weapon" data-drive="front" aria-label="Front weapon">${ICON.front}</button>
        <button class="touch-btn weapon" data-drive="rear" aria-label="${SIM.weapons.rearMissiles ? 'Rear weapon' : 'Mine'}">${SIM.weapons.rearMissiles ? ICON.rear : ICON.mine}</button>
        ${FEATURES.turbo ? '<button class="touch-btn turbo" data-drive="turbo" aria-label="Turbo">TURBO</button>' : '<span aria-hidden="true"></span>'}
        <button class="touch-btn hb" data-drive="handbrake" aria-label="Handbrake">${ICON.handbrake}</button>
        <button class="touch-btn pedal brake" data-drive="brake" aria-label="Brake">${ICON.brake}</button>
        <button class="touch-btn pedal gas" data-drive="throttle" aria-label="Accelerate">${ICON.gas}</button>
      </div>`;
    host.appendChild(this.root);
    this.base = this.root.querySelector('.touch-steer-base')!;
    this.knob = this.root.querySelector('.touch-steer-knob')!;

    this.steerZone = this.root.querySelector<HTMLElement>('[data-touch-steer]')!;
    this.steerButtons = this.root.querySelector<HTMLElement>('.touch-steer-buttons')!;
    this.steerZone.addEventListener('pointerdown', this.onSteerDown);
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

  /** The slider, or the two steering buttons. */
  setSteerMode(mode: TouchSteer): void {
    if (mode === this.steerMode) return;
    this.steerMode = mode;
    this.steerZone.hidden = mode !== 'slider';
    this.steerButtons.hidden = mode !== 'buttons';
    this.reset();
  }

  available(): boolean {
    return this.enabled;
  }

  poll(dt = 1 / 60): DriveSample {
    const on = (a: Action): boolean => (this.held.get(a)?.size ?? 0) > 0;
    // Wind the wheel towards the thumb, as the keyboard does: glass has no
    // resistance, and a thumb flicked across it was full lock in one frame —
    // at speed, a car snapped sideways. (Touch had none of this until M7.)
    const buttons = this.steerMode === 'buttons';
    const t = buttons ? (on('right') ? 1 : 0) - (on('left') ? 1 : 0) : this.steerTarget;
    const rate = t === 0 || Math.sign(t) !== Math.sign(this.steer) ? 1 / (buttons ? BUTTON_STEER_OUT : STEER_OUT) : 1 / (buttons ? BUTTON_STEER_IN : STEER_IN);
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
