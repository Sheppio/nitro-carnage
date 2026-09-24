/**
 * A keyboard for players who have no keyboard (ported from glitchburst).
 *
 * The name and the room code are the game's front door, and on a console
 * they were unfillable: whether the platform raises its own soft keyboard for
 * a focused field depends on the browser, and a desktop browser with a pad
 * plugged in never does. The keys are ordinary buttons in a grid, so the
 * gamepad navigator drives them with no special code, and the veil is a
 * `data-nav-modal` so the focus ring stays inside it.
 */
export class Keyboard {
  private target: HTMLInputElement | null = null;
  private veil: HTMLElement;
  private preview: HTMLElement;
  onClose: (() => void) | null = null;

  constructor() {
    this.veil = document.getElementById('keyboard-veil')!;
    this.preview = document.getElementById('keyboard-preview')!;
    const grid = document.getElementById('keyboard-grid')!;
    grid.replaceChildren(
      ...[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'].map((ch) => {
        const key = document.createElement('button');
        key.type = 'button';
        key.className = 'key';
        key.textContent = ch;
        key.addEventListener('click', () => this.type(ch));
        return key;
      }),
    );
    document.getElementById('btn-key-del')!.addEventListener('click', () => this.type(null));
    document.getElementById('btn-key-done')!.addEventListener('click', () => this.close());
    // The navigator asks for this when A is pressed on a text field.
    document.addEventListener('nc:text-entry', (e) => {
      const id = (e as CustomEvent<{ id: string }>).detail.id;
      const field = document.getElementById(id);
      if (field instanceof HTMLInputElement) this.open(field);
    });
  }

  get isOpen(): boolean {
    return !this.veil.hidden;
  }

  open(field: HTMLInputElement): void {
    this.target = field;
    document.getElementById('keyboard-title')!.textContent = field.id === 'input-room' ? 'Room code' : 'Your name';
    this.veil.hidden = false;
    this.render();
    const first = this.veil.querySelector<HTMLElement>('.key');
    first?.focus();
    first?.classList.add('nav-focus');
  }

  close(): void {
    this.veil.hidden = true;
    const field = this.target;
    this.target = null;
    field?.focus();
    this.onClose?.();
  }

  /** `null` deletes the last character. */
  private type(ch: string | null): void {
    const field = this.target;
    if (!field) return;
    const limit = field.maxLength > 0 ? field.maxLength : 12;
    const next = ch === null ? field.value.slice(0, -1) : (field.value + ch).slice(0, limit);
    if (next === field.value) return;
    field.value = next;
    // The same event real typing raises, so validation and persistence see it.
    field.dispatchEvent(new Event('input', { bubbles: true }));
    this.render();
  }

  private render(): void {
    this.preview.textContent = this.target?.value || '—';
  }
}
