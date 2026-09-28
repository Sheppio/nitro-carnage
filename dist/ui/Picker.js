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
        // As a <select> would: so page code can listen without holding the picker.
        this.el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    /** Mark squares (say, colours somebody else has) with a class; the rest lose it. */
    mark(values, cls) {
        this.squares.forEach((sq, i) => sq.classList.toggle(cls, values.has(this.items[i].value)));
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
/**
 * The ‹ Name › arrows in front of an existing `<select>`, which stays in the
 * page, hidden, as the value everything else reads and writes: page code
 * setting `.value`, change listeners, and tests picking an option all carry
 * on as before. Stepping sets the select and fires its `change`; setting the
 * select from code redraws the arrows.
 *
 * Options may be added after (the car-type list is filled in at boot): the
 * list is read afresh on every step.
 */
export function stepperFor(select) {
    const el = document.createElement('div');
    el.className = 'picker stepper select-stepper';
    if (select.id)
        el.id = `${select.id}-pick`;
    el.tabIndex = 0;
    el.dataset.nav = '';
    el.dataset.navCycle = '';
    el.setAttribute('role', 'spinbutton');
    const label = select.closest('label')?.querySelector('span')?.textContent;
    if (label)
        el.setAttribute('aria-label', label);
    const text = document.createElement('span');
    text.className = 'picker-value';
    const arrow = (glyph, name, dir) => {
        const a = document.createElement('span');
        a.className = 'step';
        a.textContent = glyph;
        a.setAttribute('aria-label', name);
        a.addEventListener('click', (e) => {
            // Inside a <label>: a click would otherwise also go to the select.
            e.preventDefault();
            step(dir);
        });
        return a;
    };
    const show = () => {
        const o = select.options[select.selectedIndex];
        text.textContent = o?.textContent ?? '';
        el.dataset.value = select.value;
        el.setAttribute('aria-valuetext', text.textContent);
    };
    const step = (dir) => {
        const n = select.options.length;
        if (n < 2 || select.disabled)
            return;
        select.selectedIndex = (select.selectedIndex + dir + n) % n;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    el.replaceChildren(arrow('‹', 'Previous', -1), text, arrow('›', 'Next', 1));
    el.addEventListener('nc:cycle', (e) => step(e.detail.dir));
    el.addEventListener('keydown', (e) => {
        if (e.defaultPrevented)
            return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            step(e.key === 'ArrowRight' ? 1 : -1);
        }
    });
    select.addEventListener('change', show);
    // Code sets the select without an event (a room's settings arriving): redraw then too.
    const proto = HTMLSelectElement.prototype;
    for (const prop of ['value', 'selectedIndex']) {
        const d = Object.getOwnPropertyDescriptor(proto, prop);
        Object.defineProperty(select, prop, {
            configurable: true,
            get() {
                return d.get.call(this);
            },
            set(v) {
                d.set.call(this, v);
                show();
            },
        });
    }
    // Kept for the value and for tests, but out of sight and out of the focus ring.
    select.classList.add('stepped');
    select.tabIndex = -1;
    select.dataset.navSkip = '';
    select.setAttribute('aria-hidden', 'true');
    select.after(el);
    show();
    // Options filled in later (or replaced) change the label under the arrows.
    new MutationObserver(show).observe(select, { childList: true, subtree: true });
    return el;
}
//# sourceMappingURL=Picker.js.map