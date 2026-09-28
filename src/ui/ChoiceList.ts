const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * A dropdown's options as a list on the page, for a controller.
 *
 * A native `select` popup is browser chrome: a pad can't drive it, and Xbox
 * Edge doesn't show one at all. Left and right cycle a dropdown in place,
 * which is fine for Laps but no way to browse twenty-odd tracks. The Track of
 * the day sat at the very end of them. A (or Enter) on a dropdown opens this
 * instead: every option as a button, under the dropdown's own group headings,
 * the current one focused. Up and down move, A picks, B cancels. It's a
 * `data-nav-modal`, so the focus ring stays inside it.
 */
export class ChoiceList {
  private target: HTMLSelectElement | null = null;
  private veil = $('choice-veil');
  private list = $('choice-list');
  /** Puts the focus ring on an element: the navigator's, so the ring and the focus agree. */
  focus: (el: HTMLElement) => void = (el) => el.focus();

  constructor() {
    $('btn-choice-cancel').addEventListener('click', () => this.close());
    // The navigator asks for this when A is pressed on a dropdown.
    document.addEventListener('nc:choose', (e) => {
      const el = document.getElementById((e as CustomEvent<{ id: string }>).detail.id);
      if (el instanceof HTMLSelectElement) this.open(el);
    });
  }

  get isOpen(): boolean {
    return !this.veil.hidden;
  }

  open(sel: HTMLSelectElement): void {
    this.target = sel;
    $('choice-title').textContent = sel.closest('.field')?.querySelector('span')?.textContent ?? 'Choose';
    const item = (o: HTMLOptionElement): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'choice';
      b.textContent = o.textContent;
      b.dataset.value = o.value;
      if (o.selected) b.classList.add('current');
      b.addEventListener('click', () => this.pick(o.value));
      return b;
    };
    this.list.replaceChildren(
      ...[...sel.children].flatMap((c) => {
        if (c instanceof HTMLOptGroupElement) {
          const h = document.createElement('h3');
          h.textContent = c.label;
          return [h, ...[...c.children].filter((o): o is HTMLOptionElement => o instanceof HTMLOptionElement).map(item)];
        }
        return c instanceof HTMLOptionElement ? [item(c)] : [];
      }),
    );
    this.veil.hidden = false;
    const current = this.list.querySelector<HTMLElement>('.current') ?? this.list.querySelector<HTMLElement>('.choice');
    if (current) this.focus(current);
  }

  private pick(value: string): void {
    const sel = this.target;
    if (sel && sel.value !== value) {
      sel.value = value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    this.close();
  }

  close(): void {
    this.veil.hidden = true;
    const sel = this.target;
    this.target = null;
    if (sel) this.focus(sel);
  }
}
