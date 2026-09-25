import { BODIES, BODY_NAMES, PATTERN_NAMES, PATTERNS, RIM_NAMES, RIMS, sanitizeLook } from '../sim/look.js';
import { colourOf, PALETTE } from '../sim/palette.js';
const $ = (id) => document.getElementById(id);
/**
 * The Garage screen: five pickers and a turntable. Plain dropdowns, so the
 * focus ring, left/right and the pad all work on them with no special code;
 * LB/RB cycle the body from anywhere on the screen.
 *
 * The body colour is shown but not chosen here: it is the room colour,
 * picked in the lobby, because it is how cars are told apart.
 */
export class Garage {
    preview;
    look;
    colourId = 'vermilion';
    onChange = null;
    constructor(preview, look) {
        this.preview = preview;
        this.look = sanitizeLook(look);
        const fill = (id, items) => {
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
        $('garage-body').value = this.look.body;
        $('garage-pattern').value = this.look.pattern;
        $('garage-stripe').value = this.look.stripe;
        $('garage-rims').value = this.look.rims;
        $('garage-number').value = String(this.look.number);
    }
    read() {
        this.look = sanitizeLook({
            body: $('garage-body').value,
            pattern: $('garage-pattern').value,
            stripe: $('garage-stripe').value,
            rims: $('garage-rims').value,
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