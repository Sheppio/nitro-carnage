import { BTN } from '../input/GamepadSource.js';
import type { GamepadSource } from '../input/GamepadSource.js';
import { isConsole } from '../input/settings.js';
import type { RaceSession } from '../RaceSession.js';
import type { PhotoSettings } from '../render/GameView.js';
import type { PhotoMove } from '../render/PhotoCamera.js';
import { label } from './glyphs.js';
import type { PadFamily } from './glyphs.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/** The focus slider runs 0..100 over 0.5 m to 200 m, evenly by ratio, so near focus has room on it. */
const FOCUS_MIN = 0.5;
const FOCUS_MAX = 200;
const toSlider = (m: number): number => (100 * Math.log(m / FOCUS_MIN)) / Math.log(FOCUS_MAX / FOCUS_MIN);
const fromSlider = (v: number): number => FOCUS_MIN * (FOCUS_MAX / FOCUS_MIN) ** (v / 100);

/** Radians of turn per pixel dragged. */
const DRAG_LOOK = 0.004;
/** Radians a second at full stick, or for an arrow key. */
const STICK_LOOK = 1.8;
/** Metres moved per pixel of two-finger drag, and per pixel of pinch. */
const TOUCH_MOVE = 0.06;
const TOUCH_PINCH = 0.12;

/** The keys photo mode takes for itself while it is on; nothing else sees them. */
const KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space', 'ShiftLeft', 'ShiftRight',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'BracketLeft', 'BracketRight', 'Minus', 'Equal',
  'KeyF', 'KeyH', 'KeyP', 'KeyC', 'Escape', 'Backspace',
]);

/**
 * Photo mode, from the pause menu in an offline race: the world stays
 * stopped, the pause card goes, and the player flies a free camera to frame
 * a shot, with depth of field, the UI off for a clean view, and a PNG saved
 * on a button: to the gallery through the share sheet on a phone, as a
 * download elsewhere, and not at all on a console, whose browser blocks downloads.
 *
 * Keyboard: WASD moves, E and Q (or Space) go up and down, Shift is faster,
 * the arrows or a mouse drag look round, the wheel zooms. Pad: the left stick
 * moves, the right one looks, RT and LT go up and down. Touch: one finger
 * looks, two move, and a pinch goes forward and back.
 */
export class PhotoMode {
  /** Back to the pause menu (Esc, B, Back). */
  onBack: (() => void) | null = null;
  /** A photo was saved, or could not be; null when the player closed the share sheet without saving. */
  onSaved: ((ok: boolean | null) => void) | null = null;

  private session: RaceSession | null = null;
  private photo: PhotoSettings = { focus: 20, blur: 0 };
  private keys = new Set<string>();
  /** Look and move from the mouse and fingers since the last frame. */
  private lookX = 0;
  private lookY = 0;
  private nudge = { x: 0, y: 0, z: 0 };
  private pointers = new Map<number, { x: number; y: number; startX: number; startY: number; at: number }>();
  private pinch = 0;
  /** A second finger came down in this gesture: then it was a move, never a tap. */
  private multi = false;
  /** The pad's buttons as last read, for presses; null until the first read, so a held A is not a press. */
  private padWas: boolean[] | null = null;
  private family = '';
  private saving = false;
  /** Xbox Edge and the PlayStation browser block downloads, so a console has no Save. */
  private readonly canSave = !isConsole();

  constructor(private gamepad: GamepadSource, private surface: HTMLElement) {
    $('btn-photo-save').hidden = !this.canSave;
    $('photo-focus').addEventListener('input', (e) => {
      this.photo.focus = fromSlider(Number((e.target as HTMLInputElement).value));
      this.showValues(false);
    });
    $('photo-blur').addEventListener('input', (e) => {
      this.photo.blur = Number((e.target as HTMLInputElement).value) / 100;
      this.showValues(false);
    });
    this.button('btn-photo-car', () => this.focusOnCar());
    this.button('btn-photo-ui', () => this.toggleUi());
    this.button('btn-photo-save', () => void this.save());
    this.button('btn-photo-back', () => this.onBack?.());
  }

  get active(): boolean {
    return this.session !== null;
  }

  /** Take over from the pause menu. */
  open(session: RaceSession): void {
    if (this.session || session.mode === 'net') return;
    this.session = session;
    this.keys.clear();
    this.pointers.clear();
    this.multi = false;
    this.lookX = this.lookY = 0;
    this.nudge = { x: 0, y: 0, z: 0 };
    this.padWas = null;
    this.family = '';
    // A fresh photo starts sharp, focused on the car.
    this.photo = { focus: 20, blur: 0 };
    session.startPhoto(this.read, this.photo);
    this.photo.focus = session.carDistance();
    this.showValues(true);
    document.body.classList.add('photo');
    document.body.classList.remove('photo-clean');
    $('photo-bar').hidden = false;
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    this.surface.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  }

  /** Back to the race camera. The pause menu, or the race, is the caller's to bring back. */
  close(): void {
    if (!this.session) return;
    this.session.stopPhoto();
    this.session = null;
    document.body.classList.remove('photo', 'photo-clean');
    $('photo-bar').hidden = true;
    $('photo-ring').hidden = true;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('wheel', this.onWheel, true);
    this.surface.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }

  /**
   * Save the frame as a PNG: the scene only, never the page's UI. On a phone
   * it goes to the share sheet, whose Save Image (iOS) or Save to gallery
   * (Android) puts it with the player's photos; a page cannot write there
   * itself. Anywhere the sheet can't take a file, it downloads.
   */
  async save(): Promise<void> {
    const s = this.session;
    if (!s || this.saving || !this.canSave) return;
    this.saving = true;
    try {
      const blob = await s.snapshot();
      if (!blob) {
        this.onSaved?.(false);
        return;
      }
      const name = `nitrocarnage-${stamp(new Date())}.png`;
      const file = new File([blob], name, { type: 'image/png' });
      if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
          this.onSaved?.(true);
          return;
        } catch (e) {
          // Closed without saving: nothing to say. Anything else (the tap's
          // permission ran out while the frame rendered) falls back to a download.
          if ((e as DOMException).name === 'AbortError') {
            this.onSaved?.(null);
            return;
          }
        }
      }
      download(blob, name);
      this.onSaved?.(true);
    } finally {
      this.saving = false;
    }
  }

  focusOnCar(): void {
    if (!this.session) return;
    this.photo.focus = Math.max(FOCUS_MIN, Math.min(FOCUS_MAX, this.session.carDistance()));
    this.showValues(true);
  }

  /**
   * Focus on whatever is at a point on the screen (a click or a tap), to the
   * depth of the very spot: a rival's bonnet, a lamp post, a tower's corner.
   * The sky focuses as far as the lens goes.
   */
  focusAtPoint(clientX: number, clientY: number): void {
    if (!this.session) return;
    const d = this.session.pointDistance(clientX, clientY) ?? FOCUS_MAX;
    this.photo.focus = Math.max(FOCUS_MIN, Math.min(FOCUS_MAX, d));
    this.showValues(true);
    const ring = $('photo-ring');
    // The TV layout zooms the overlay, and the ring's place with it: undone, so it lands on the click.
    const zoom = (ring.parentElement as (HTMLElement & { currentCSSZoom?: number }) | null)?.currentCSSZoom || 1;
    ring.style.left = `${clientX / zoom}px`;
    ring.style.top = `${clientY / zoom}px`;
    ring.hidden = false;
    // Restart the fade for a second click before the first has gone.
    ring.classList.remove('on');
    void ring.offsetWidth;
    ring.classList.add('on');
  }

  toggleUi(): void {
    document.body.classList.toggle('photo-clean');
  }

  /** The depth of field as it stands, for the tests. */
  get settings(): Readonly<PhotoSettings> {
    return this.photo;
  }

  /* ------------------------------------------------------------- the frame */

  /** Read once a frame by the session: everything pushing the camera, from every device. */
  private read = (dt: number): PhotoMove => {
    const k = (code: string): number => (this.keys.has(code) ? 1 : 0);
    const move = {
      x: k('KeyD') - k('KeyA'),
      y: k('KeyE') + k('Space') - k('KeyQ'),
      z: k('KeyW') - k('KeyS'),
      yaw: (k('ArrowRight') - k('ArrowLeft')) * STICK_LOOK * dt + this.lookX * DRAG_LOOK,
      pitch: (k('ArrowUp') - k('ArrowDown')) * STICK_LOOK * 0.7 * dt - this.lookY * DRAG_LOOK,
      fast: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      nudge: this.nudge,
    };
    this.lookX = this.lookY = 0;
    this.nudge = { x: 0, y: 0, z: 0 };
    // Held keys for the depth of field.
    if (this.keys.has('BracketLeft') || this.keys.has('BracketRight')) this.focusBy((k('BracketRight') - k('BracketLeft')) * dt);
    if (this.keys.has('Minus') || this.keys.has('Equal')) this.blurBy((k('Equal') - k('Minus')) * 0.6 * dt);
    this.readPad(move, dt);
    this.hints();
    return move;
  };

  private readPad(move: PhotoMove, dt: number): void {
    const pad = this.gamepad.readPhoto();
    if (!pad) {
      this.padWas = null;
      return;
    }
    const was = this.padWas;
    this.padWas = pad.buttons;
    const down = (b: number): boolean => pad.buttons[b] === true;
    // A press, not a hold: and nothing on the first read, which would be the A that chose Photo mode.
    const pressed = (b: number): boolean => was !== null && down(b) && !was[b];
    move.x += pad.lx;
    move.z -= pad.ly;
    move.y += pad.rt - pad.lt;
    move.yaw += pad.rx * STICK_LOOK * dt;
    move.pitch -= pad.ry * STICK_LOOK * 0.7 * dt;
    move.fast ||= down(BTN.L3);
    const s = this.session;
    if (down(BTN.DPAD_UP) || down(BTN.DPAD_DOWN)) s?.view.photoCam.zoom((down(BTN.DPAD_DOWN) ? 1 : -1) * 30 * dt);
    if (down(BTN.LB) || down(BTN.RB)) this.focusBy((down(BTN.RB) ? 1 : -1) * dt);
    if (down(BTN.DPAD_LEFT) || down(BTN.DPAD_RIGHT)) this.blurBy((down(BTN.DPAD_RIGHT) ? 1 : -1) * 0.6 * dt);
    if (pressed(BTN.X)) this.focusOnCar();
    if (pressed(BTN.Y)) this.toggleUi();
    if (pressed(BTN.A)) void this.save();
    if (pressed(BTN.B)) this.onBack?.();
    // Menu is read by the page's own pause poll, which resumes the race.
  }

  /** Focus further (+) or nearer, by ratio: a second's hold is about 2.7 times. */
  private focusBy(k: number): void {
    this.photo.focus = Math.max(FOCUS_MIN, Math.min(FOCUS_MAX, this.photo.focus * Math.exp(k)));
    this.showValues(true);
  }

  private blurBy(d: number): void {
    this.photo.blur = Math.max(0, Math.min(1, this.photo.blur + d));
    this.showValues(true);
  }

  /** The sliders' readouts, and the sliders themselves when the value came from elsewhere. */
  private showValues(sliders: boolean): void {
    const { focus, blur } = this.photo;
    if (sliders) {
      $<HTMLInputElement>('photo-focus').value = String(Math.round(toSlider(focus)));
      $<HTMLInputElement>('photo-blur').value = String(Math.round(blur * 100));
    }
    $('photo-focus-out').textContent = focus < 10 ? `${focus.toFixed(1)} m` : `${Math.round(focus)} m`;
    $('photo-blur-out').textContent = blur <= 0 ? 'Off' : `${Math.round(blur * 100)}%`;
  }

  /** The controls line, for the pad in the player's hands, the keyboard, or a touch screen. */
  private hints(): void {
    const family = (document.body.dataset.pad ?? 'none') as PadFamily;
    const touch = family === 'none' && matchMedia('(pointer: coarse)').matches;
    const key = touch ? 'touch' : family;
    if (key === this.family) return;
    this.family = key;
    const l = (a: Parameters<typeof label>[0]): string => label(a, family);
    const stick = family === 'playstation' ? 'L3' : 'LS';
    const y = family === 'playstation' ? '△' : 'Y';
    const save = (key: string): string => (this.canSave ? `<b>Save</b> ${key} · ` : '');
    $('photo-keys').innerHTML = touch
      ? '<b>Look</b> drag · <b>Move</b> two fingers · <b>Forward</b> pinch · <b>Focus</b> tap · <b>UI</b> tap when hidden'
      : family === 'none'
        ? '<b>Move</b> W A S D · <b>Up / down</b> E / Q · <b>Fast</b> Shift · <b>Look</b> arrows or drag · <b>Zoom</b> wheel · ' +
          `<b>Focus</b> click, or [ ] · <b>On car</b> F · <b>Blur</b> − = · <b>Hide UI</b> H · ${save('P')}<b>Back</b> Esc`
        : `<b>Move</b> left stick · <b>Look</b> right stick · <b>Up / down</b> ${l('throttle')} / ${l('brake')} · <b>Fast</b> ${stick} · ` +
          `<b>Zoom</b> D-pad ↑↓ · <b>Focus</b> ${l('prev')} / ${l('next')} · <b>On car</b> ${l('delete')} · <b>Blur</b> D-pad ←→ · ` +
          `<b>Hide UI</b> ${y} · ${save(l('confirm'))}<b>Back</b> ${l('back')} · <b>Resume</b> ${l('menu')}`;
  }

  /* ---------------------------------------------------------------- input */

  private button(id: string, act: () => void): void {
    $(id).addEventListener('click', (e) => {
      act();
      // Off the button, so Space and Enter go on meaning up and nothing, not another click.
      (e.currentTarget as HTMLElement).blur();
    });
  }

  /** In the capture phase, ahead of the driving keys and the menus, which never see these. */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (!KEYS.has(e.code) || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    this.keys.add(e.code);
    if (e.repeat) return;
    if (e.code === 'KeyF') this.focusOnCar();
    else if (e.code === 'KeyH') this.toggleUi();
    else if (e.code === 'KeyP') void this.save();
    else if (e.code === 'Escape' || e.code === 'Backspace') this.onBack?.();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!KEYS.has(e.code)) return;
    this.keys.delete(e.code);
    e.stopPropagation();
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.pointers.clear();
  };

  /** The wheel zooms the photo, not the race camera's saved setting. */
  private onWheel = (e: WheelEvent): void => {
    if ((e.target as HTMLElement | null)?.closest?.('#photo-bar')) return;
    e.preventDefault();
    e.stopPropagation();
    this.session?.view.photoCam.zoom(Math.sign(e.deltaY) * 2);
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, at: performance.now() });
    if (this.pointers.size > 1) this.multi = true;
    this.pinch = this.spread();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size === 1) {
      this.lookX += dx;
      this.lookY += dy;
      return;
    }
    // Two fingers: each moves the camera by half its drag, so together they move it by the midpoint's.
    this.nudge.x -= (dx / 2) * TOUCH_MOVE;
    this.nudge.y += (dy / 2) * TOUCH_MOVE;
    const spread = this.spread();
    this.nudge.z += (spread - this.pinch) * TOUCH_PINCH;
    this.pinch = spread;
  };

  private onPointerUp = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    this.pinch = this.spread();
    const tap = !this.multi && Math.hypot(e.clientX - p.startX, e.clientY - p.startY) < 8 && performance.now() - p.at < 350;
    if (this.pointers.size === 0) this.multi = false;
    if (!tap) return;
    // A click focuses where it lands, UI or no UI (H brings it back). A tap
    // does too, but with the UI hidden it brings it back: a touch screen has no H or Y.
    if (e.pointerType !== 'mouse' && document.body.classList.contains('photo-clean')) this.toggleUi();
    else this.focusAtPoint(e.clientX, e.clientY);
  };

  /** How far apart the first two fingers are, or 0 with fewer down. */
  private spread(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
}

/** Hand a file to the browser as a download. */
function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** 20261001-142233: a file name's date and time, in the player's own time zone. */
function stamp(d: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}
