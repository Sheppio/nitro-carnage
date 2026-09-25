import { BODIES, BODY_NAMES, PATTERN_NAMES, PATTERNS, RIM_NAMES, RIMS, sanitizeLook } from '../sim/look.js';
import type { CarLook } from '../sim/look.js';
import { colourOf, PALETTE } from '../sim/palette.js';
import type { GaragePreview } from '../render/GaragePreview.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * The Garage screen: five pickers and a turntable. Plain dropdowns, so the
 * focus ring, left/right and the pad all work on them with no special code;
 * LB/RB cycle the body from anywhere on the screen.
 *
 * The body colour is shown but not chosen here: it is the room colour,
 * picked in the lobby, because it is how cars are told apart.
 */
export class Garage {
  private look: CarLook;
  private colourId = 'vermilion';
  onChange: ((look: CarLook) => void) | null = null;

  constructor(private preview: GaragePreview, look: CarLook) {
    this.look = sanitizeLook(look);
    const fill = (id: string, items: readonly (readonly [string, string])[]): void => {
      $(id).replaceChildren(...items.map(([value, text]) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        return o;
      }));
    };
    fill('garage-body', BODIES.map((b) => [b, BODY_NAMES[b]]));
    fill('garage-pattern', PATTERNS.map((p) => [p, PATTERN_NAMES[p]]));
    fill('garage-stripe', PALETTE.map((c) => [c.id, c.name]));
    fill('garage-rims', RIMS.map((r) => [r, RIM_NAMES[r]]));
    fill('garage-number', Array.from({ length: 100 }, (_, n) => [String(n), String(n)]));
    for (const id of ['garage-body', 'garage-pattern', 'garage-stripe', 'garage-rims', 'garage-number']) {
      $(id).addEventListener('change', () => this.read());
    }
    document.addEventListener('nc:shoulder', (e) => {
      if ($('screen-garage').hidden) return;
      const dir = (e as CustomEvent<{ dir: number }>).detail.dir;
      const i = BODIES.indexOf(this.look.body);
      this.look = { ...this.look, body: BODIES[(i + dir + BODIES.length) % BODIES.length]! };
      this.write();
      this.changed();
    });
  }

  /** The turntable, for tests. */
  get view(): GaragePreview {
    return this.preview;
  }

  get current(): CarLook {
    return this.look;
  }

  /** Open with the colour the car will wear. */
  open(colourId: string): void {
    this.colourId = colourId;
    this.write();
    this.preview.show(this.look, colourOf(colourId).colour);
    this.preview.start();
  }

  close(): void {
    this.preview.stop();
  }

  private write(): void {
    $<HTMLSelectElement>('garage-body').value = this.look.body;
    $<HTMLSelectElement>('garage-pattern').value = this.look.pattern;
    $<HTMLSelectElement>('garage-stripe').value = this.look.stripe;
    $<HTMLSelectElement>('garage-rims').value = this.look.rims;
    $<HTMLSelectElement>('garage-number').value = String(this.look.number);
  }

  private read(): void {
    this.look = sanitizeLook({
      body: $<HTMLSelectElement>('garage-body').value as CarLook['body'],
      pattern: $<HTMLSelectElement>('garage-pattern').value as CarLook['pattern'],
      stripe: $<HTMLSelectElement>('garage-stripe').value,
      rims: $<HTMLSelectElement>('garage-rims').value as CarLook['rims'],
      number: Number($<HTMLSelectElement>('garage-number').value),
    });
    this.changed();
  }

  private changed(): void {
    this.preview.show(this.look, colourOf(this.colourId).colour);
    this.onChange?.(this.look);
  }
}
