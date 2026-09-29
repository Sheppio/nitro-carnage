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
 * The body colour is chosen here too. In a room it is the room colour, which
 * must be unique because it is how cars are told apart: other people's are
 * marked (`taken`), and the room moves whoever asked second.
 */
export class Garage {
    preview;
    look;
    body;
    pattern;
    stripe;
    rims;
    colour;
    colourId = 'vermilion';
    onChange = null;
    /** The body colour was picked. */
    onColour = null;
    constructor(preview, look) {
        this.preview = preview;
        this.look = sanitizeLook(look);
        this.body = new Picker($('garage-body'), BODIES.map((b) => ({ value: b, label: BODY_NAMES[b] })));
        this.pattern = new Picker($('garage-pattern'), PATTERNS.map((p) => ({ value: p, label: PATTERN_NAMES[p] })));
        this.stripe = new Picker($('garage-stripe'), PALETTE.map((c) => ({ value: c.id, label: c.name, swatch: c.cssColour })));
        this.rims = new Picker($('garage-rims'), RIMS.map((r) => ({ value: r, label: RIM_NAMES[r] })));
        this.colour = new Picker($('garage-colour'), PALETTE.map((c) => ({ value: c.id, label: c.name, swatch: c.cssColour })));
        for (const p of [this.body, this.pattern, this.stripe, this.rims])
            p.onChange = () => this.read();
        this.colour.onChange = () => {
            this.colourId = this.colour.value;
            this.onColour?.(this.colourId);
            this.changed();
        };
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
    /** Mark the colours other people in the room have. */
    taken(colours) {
        this.colour.mark(colours, 'taken');
    }
    /** Open with the colour the car will wear. */
    open(colourId) {
        this.colourId = colourId;
        this.colour.value = colourId;
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