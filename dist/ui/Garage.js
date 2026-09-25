import { BODIES, BODY_NAMES, PATTERN_NAMES, PATTERNS, RIM_NAMES, RIMS, sanitizeLook } from '../sim/look.js';
import { colourOf, PALETTE } from '../sim/palette.js';
import { Picker } from './Picker.js';
const $ = (id) => document.getElementById(id);
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
    preview;
    look;
    body;
    pattern;
    stripe;
    rims;
    colourId = 'vermilion';
    onChange = null;
    constructor(preview, look) {
        this.preview = preview;
        this.look = sanitizeLook(look);
        this.body = new Picker($('garage-body'), BODIES.map((b) => ({ value: b, label: BODY_NAMES[b] })));
        this.pattern = new Picker($('garage-pattern'), PATTERNS.map((p) => ({ value: p, label: PATTERN_NAMES[p] })));
        this.stripe = new Picker($('garage-stripe'), PALETTE.map((c) => ({ value: c.id, label: c.name, swatch: c.cssColour })));
        this.rims = new Picker($('garage-rims'), RIMS.map((r) => ({ value: r, label: RIM_NAMES[r] })));
        for (const p of [this.body, this.pattern, this.stripe, this.rims])
            p.onChange = () => this.read();
        $('garage-number').replaceChildren(...Array.from({ length: 100 }, (_, n) => {
            const o = document.createElement('option');
            o.value = o.textContent = String(n);
            return o;
        }));
        $('garage-number').addEventListener('change', () => this.read());
        document.addEventListener('nc:shoulder', (e) => {
            if ($('screen-garage').hidden)
                return;
            const dir = e.detail.dir;
            const i = BODIES.indexOf(this.look.body);
            this.look = { ...this.look, body: BODIES[(i + dir + BODIES.length) % BODIES.length] };
            this.write();
            this.changed();
        });
    }
    /** The turntable, for tests. */
    get view() {
        return this.preview;
    }
    get current() {
        return this.look;
    }
    /** Change part of the look as if picked on screen: for tests and links. */
    set(part) {
        this.look = sanitizeLook({ ...this.look, ...part });
        this.write();
        this.changed();
    }
    /** Open with the colour the car will wear. */
    open(colourId) {
        this.colourId = colourId;
        this.write();
        this.preview.show(this.look, colourOf(colourId).colour);
        this.preview.start();
    }
    close() {
        this.preview.stop();
    }
    write() {
        this.body.value = this.look.body;
        this.pattern.value = this.look.pattern;
        this.stripe.value = this.look.stripe;
        this.rims.value = this.look.rims;
        $('garage-number').value = String(this.look.number);
    }
    read() {
        this.look = sanitizeLook({
            body: this.body.value,
            pattern: this.pattern.value,
            stripe: this.stripe.value,
            rims: this.rims.value,
            number: Number($('garage-number').value),
        });
        this.changed();
    }
    changed() {
        this.preview.show(this.look, colourOf(this.colourId).colour);
        this.onChange?.(this.look);
    }
}
//# sourceMappingURL=Garage.js.map