/**
 * A choice without a dropdown: either ‹ Name › arrows or a row of colour
 * squares. The whole control is one stop for the focus ring; left and right
 * change it (the navigator hands them over through `nc:cycle`), and the arrows
 * or squares can be tapped or clicked.
 *
 * Dropdowns were the Garage's first pickers. They work, but the list they
 * open is the browser's, not the game's, and a colour is better seen than
 * read.
 */
export interface PickerItem {
  value: string;
  label: string;
  /** A CSS colour: shown as a square instead of by name. */
  swatch?: string;
}

export class Picker {
  private index = 0;
  private readonly text: HTMLElement | null = null;
  private readonly squares: HTMLElement[] = [];
  onChange: ((value: string) => void) | null = null;

  constructor(readonly el: HTMLElement, private readonly items: readonly PickerItem[]) {
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
        sq.style.background = item.swatch!;
        sq.addEventListener('click', () => this.pick(i));
        this.squares.push(sq);
        return sq;
      }));
    } else {
      const arrow = (glyph: string, label: string, dir: number): HTMLElement => {
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
    el.addEventListener('nc:cycle', (e) => this.step((e as CustomEvent<{ dir: number }>).detail.dir));
    el.addEventListener('keydown', (e) => {
      // Keys for when the navigator is not the one listening (a mouse user who tabbed here).
      if (e.defaultPrevented) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        this.step(e.key === 'ArrowRight' ? 1 : -1);
      }
    });
    this.show();
  }

  get value(): string {
    return this.items[this.index]!.value;
  }

  /** Set without telling anyone: for writing the saved look back into the screen. */
  set value(v: string) {
    const i = this.items.findIndex((item) => item.value === v);
    if (i >= 0) this.index = i;
    this.show();
  }

  step(dir: number): void {
    this.pick((this.index + dir + this.items.length) % this.items.length);
  }

  private pick(i: number): void {
    this.index = i;
    this.show();
    this.onChange?.(this.value);
  }

  private show(): void {
    const item = this.items[this.index]!;
    this.el.dataset.value = item.value;
    this.el.setAttribute('aria-valuetext', item.label);
    if (this.text) this.text.textContent = item.label;
    this.squares.forEach((sq, i) => {
      sq.classList.toggle('on', i === this.index);
      sq.setAttribute('aria-checked', String(i === this.index));
    });
  }
}
