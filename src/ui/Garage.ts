import { BODIES, BODY_NAMES, PATTERN_NAMES, PATTERNS, RIM_NAMES, RIMS, sanitizeLook } from '../sim/look.js';
import type { CarLook } from '../sim/look.js';
import { colourOf, PALETTE } from '../sim/palette.js';
import type { GaragePreview } from '../render/GaragePreview.js';
import { Picker } from './Picker.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * The Garage screen: five pickers and a turntable. Body, livery and wheels
 * are ‹ arrows ›, the stripe is a row of colour squares, and left/right or a
 * tap changes any of them; only the race number, a hundred of them, is still
 * a dropdown. LB/RB cycle the body from anywhere on the screen.
 *
 * The body colour is shown but not chosen here: it is the room colour,
 * picked in the lobby, because it is how cars are told apart.
 */
export class Garage {
  private look: CarLook;
  private readonly body: Picker;
  private readonly pattern: Picker;
  private readonly stripe: Picker;
  private readonly rims: Picker;
  private colourId = 'vermilion';
  onChange: ((look: CarLook) => void) | null = null;

  constructor(private preview: GaragePreview, look: CarLook) {
    this.look = sanitizeLook(look);
    this.body = new Picker($('garage-body'), BODIES.map((b) => ({ value: b, label: BODY_NAMES[b] })));
    this.pattern = new Picker($('garage-pattern'), PATTERNS.map((p) => ({ value: p, label: PATTERN_NAMES[p] })));
    this.stripe = new Picker($('garage-stripe'), PALETTE.map((c) => ({ value: c.id, label: c.name, swatch: c.cssColour })));
    this.rims = new Picker($('garage-rims'), RIMS.map((r) => ({ value: r, label: RIM_NAMES[r] })));
    for (const p of [this.body, this.pattern, this.stripe, this.rims]) p.onChange = () => this.read();
    $('garage-number').replaceChildren(...Array.from({ length: 100 }, (_, n) => {
      const o = document.createElement('option');
      o.value = o.textContent = String(n);
      return o;
    }));
    $('garage-number').addEventListener('change', () => this.read());
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

  /** Change part of the look as if picked on screen: for tests and links. */
  set(part: Partial<CarLook>): void {
    this.look = sanitizeLook({ ...this.look, ...part });
    this.write();
    this.changed();
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
    this.body.value = this.look.body;
    this.pattern.value = this.look.pattern;
    this.stripe.value = this.look.stripe;
    this.rims.value = this.look.rims;
    $<HTMLSelectElement>('garage-number').value = String(this.look.number);
  }

  private read(): void {
    this.look = sanitizeLook({
      body: this.body.value as CarLook['body'],
      pattern: this.pattern.value as CarLook['pattern'],
      stripe: this.stripe.value,
      rims: this.rims.value as CarLook['rims'],
      number: Number($<HTMLSelectElement>('garage-number').value),
    });
    this.changed();
  }

  private changed(): void {
    this.preview.show(this.look, colourOf(this.colourId).colour);
    this.onChange?.(this.look);
  }
}
