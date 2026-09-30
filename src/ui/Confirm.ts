const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * "Leave the room?" and its like: a question with a safe answer and a
 * destructive one. B leaves the lobby, and B is the turbo in a race, so one
 * press must never throw a player out of a room on its own. The safe answer
 * has the focus and B, so pressing B twice changes nothing. It's a
 * `data-nav-modal`, so the focus ring stays inside it.
 */
export class Confirm {
  private veil = $('confirm-veil');
  private answer: ((yes: boolean) => void) | null = null;
  /** Where the focus was, to hand it back on a No. */
  private from: HTMLElement | null = null;
  /** Puts the focus ring on an element: the navigator's, so the ring and the focus agree. */
  focus: (el: HTMLElement) => void = (el) => el.focus();

  constructor() {
    $('btn-confirm-yes').addEventListener('click', () => this.settle(true));
    $('btn-confirm-no').addEventListener('click', () => this.settle(false));
  }

  get isOpen(): boolean {
    return !this.veil.hidden;
  }

  /** Resolves true for the destructive answer (`yes`), false for the safe one. */
  ask(title: string, note: string, yes: string, no = 'Stay'): Promise<boolean> {
    this.settle(false);
    this.from = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    $('confirm-title').textContent = title;
    $('confirm-note').textContent = note;
    $('btn-confirm-yes').textContent = yes;
    $('btn-confirm-no').textContent = no;
    this.veil.hidden = false;
    this.focus($('btn-confirm-no'));
    return new Promise((resolve) => (this.answer = resolve));
  }

  /** Closed by a screen change underneath: the question no longer applies. */
  dismiss(): void {
    if (!this.isOpen) return;
    this.from = null;
    this.settle(false);
  }

  private settle(yes: boolean): void {
    if (!this.answer) return;
    const answer = this.answer;
    const from = this.from;
    this.answer = null;
    this.from = null;
    this.veil.hidden = true;
    if (!yes && from && from.getClientRects().length) this.focus(from);
    answer(yes);
  }
}
