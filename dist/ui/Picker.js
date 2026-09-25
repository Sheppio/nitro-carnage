export class Picker {
    el;
    items;
    index = 0;
    text = null;
    squares = [];
    onChange = null;
    constructor(el, items) {
        this.el = el;
        this.items = items;
        const swatches = items.every((i) => i.swatch);
        el.classList.add('picker', swatches ? 'swatches' : 'stepper');
        el.tabIndex = 0;
        el.dataset.nav = '';
        el.dataset.navCycle = '';
        el.setAttribute('role', swatches ? 'radiogroup' : 'spinbutton');
        if (swatches) {
            el.replaceChildren(...items.map((item, i) => {
                const sq = document.createElement('span');
                sq.className = 'swatch';
                sq.setAttribute('role', 'radio');
                sq.title = item.label;
                sq.setAttribute('aria-label', item.label);
                sq.style.background = item.swatch;
                sq.addEventListener('click', () => this.pick(i));
                this.squares.push(sq);
                return sq;
            }));
        }
        else {
            const arrow = (glyph, label, dir) => {
                // Not a <button>: the arrows are for pointers, and the focus ring stops on the control as a whole.
                const a = document.createElement('span');
                a.className = 'step';
                a.textContent = glyph;
                a.setAttribute('aria-label', label);
                a.addEventListener('click', () => this.step(dir));
                return a;
            };
            this.text = document.createElement('span');
            this.text.className = 'picker-value';
            el.replaceChildren(arrow('‹', 'Previous', -1), this.text, arrow('›', 'Next', 1));
        }
        el.addEventListener('nc:cycle', (e) => this.step(e.detail.dir));
        el.addEventListener('keydown', (e) => {
            // Keys for when the navigator is not the one listening (a mouse user who tabbed here).
            if (e.defaultPrevented)
                return;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                this.step(e.key === 'ArrowRight' ? 1 : -1);
            }
        });
        this.show();
    }
    get value() {
        return this.items[this.index].value;
    }
    /** Set without telling anyone: for writing the saved look back into the screen. */
    set value(v) {
        const i = this.items.findIndex((item) => item.value === v);
        if (i >= 0)
            this.index = i;
        this.show();
    }
    step(dir) {
        this.pick((this.index + dir + this.items.length) % this.items.length);
    }
    pick(i) {
        this.index = i;
        this.show();
        this.onChange?.(this.value);
    }
    show() {
        const item = this.items[this.index];
        this.el.dataset.value = item.value;
        this.el.setAttribute('aria-valuetext', item.label);
        if (this.text)
            this.text.textContent = item.label;
        this.squares.forEach((sq, i) => {
            sq.classList.toggle('on', i === this.index);
            sq.setAttribute('aria-checked', String(i === this.index));
        });
    }
}
//# sourceMappingURL=Picker.js.map