import type { TrackDef } from '../sim/track/TrackDef.js';
import { stepperFor } from './Picker.js';

/**
 * The track screens' chooser (#18, #14): first which kind of track, then,
 * for that kind, which one.
 *
 * - Track of the day: nothing more to choose, so the second part is blank.
 * - Favourites, Real world, Built in: a list of that kind's tracks, a dice
 *   for a random one of them, and a star.
 * - Seeded: the seed box, its dice, and a star.
 *
 * Underneath it all is the old track select, hidden: its value ('0'..'n' for
 * a built-in, 'day', 'seed') is still what the page reads, stores and links
 * to, and what tests pick. The chooser only drives it, firing its `change` as
 * a pick would, and follows it when code sets it (a room's settings arriving).
 */

export type TrackCategory = 'day' | 'fav' | 'real' | 'own' | 'seed';
const CATEGORIES: readonly { id: TrackCategory; label: string }[] = [
  { id: 'day', label: 'Track of the day' },
  { id: 'fav', label: 'Favourites' },
  { id: 'real', label: 'Real world' },
  { id: 'own', label: 'Built in' },
  { id: 'seed', label: 'Seeded' },
];

/**
 * The favourite tracks, kept on this device and shared by every chooser: a
 * built-in as `t:<track id>` (its id, so a favourite survives the list being
 * reordered), a seed as `s:<seed>`.
 */
export class Favourites {
  private list: string[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly key: string, private readonly store: { get(k: string): string; set(k: string, v: string): void }) {
    try {
      const saved = JSON.parse(store.get(key) || '[]') as unknown;
      if (Array.isArray(saved)) this.list = saved.filter((f): f is string => typeof f === 'string' && /^[ts]:./.test(f));
    } catch {
      this.list = [];
    }
  }

  get all(): readonly string[] {
    return this.list;
  }

  has(fav: string): boolean {
    return this.list.includes(fav);
  }

  toggle(fav: string): void {
    this.list = this.has(fav) ? this.list.filter((f) => f !== fav) : [...this.list, fav];
    this.store.set(this.key, JSON.stringify(this.list));
    for (const l of this.listeners) l();
  }

  onChange(l: () => void): void {
    this.listeners.add(l);
  }
}

/** The seed as a favourite keeps it: trimmed, lower case, and NITRO for an empty box, as the track screen reads it. */
export const seedFav = (text: string): string => `s:${text.trim().toLowerCase() || 'nitro'}`;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export class TrackChooser {
  private readonly model: HTMLSelectElement;
  private readonly cat: HTMLSelectElement;
  private readonly list: HTMLSelectElement;
  private readonly listRow: HTMLElement;
  private readonly seedRow: HTMLElement;
  private readonly seed: HTMLInputElement;
  private readonly listRandom: HTMLButtonElement;
  private readonly seedRandom: HTMLButtonElement;
  private readonly favButtons: HTMLButtonElement[];
  /** The kind on show: Favourites is a choice of its own, not something the model's value says. */
  private category: TrackCategory = 'own';
  /** The last track picked in each list, to go back to when its kind is picked again. */
  private readonly last = new Map<TrackCategory, string>();

  /**
   * @param prefix  'menu' or 'lobby': the ids are `<prefix>-track`, `-cat`, `-list`, `-list-random`, `-fav`, `-seed`, `-seed-random`, `-seed-fav`
   * @param tracks  the built-in tracks, by index
   */
  constructor(prefix: string, private readonly tracks: readonly TrackDef[], private readonly favs: Favourites) {
    this.model = $(`${prefix}-track`);
    this.cat = $(`${prefix}-cat`);
    this.list = $(`${prefix}-list`);
    this.listRow = $(`${prefix}-list-row`);
    this.seedRow = $(`${prefix}-seed-row`);
    this.seed = $(`${prefix}-seed`);
    this.listRandom = $(`${prefix}-list-random`);
    this.seedRandom = $(`${prefix}-seed-random`);
    this.favButtons = [$(`${prefix}-fav`), $(`${prefix}-seed-fav`)];
    this.cat.replaceChildren(...CATEGORIES.map((c) => new Option(c.label, c.id)));
    stepperFor(this.cat);

    this.cat.addEventListener('change', () => this.pickCategory(this.cat.value as TrackCategory));
    this.list.addEventListener('change', () => this.pickFromList(this.list.value));
    this.listRandom.addEventListener('click', () => this.randomFromList());
    for (const b of this.favButtons) b.addEventListener('click', () => this.toggleFav());
    // Typing a seed makes it the pick; the star follows the word.
    this.seed.addEventListener('input', () => this.showFav());
    this.model.addEventListener('change', () => this.sync());
    favs.onChange(() => this.sync());
    // A championship under way disables the model: the chooser goes with it.
    new MutationObserver(() => this.sync()).observe(this.model, { attributes: true, attributeFilter: ['disabled'] });
    // Code setting the model without an event (a room's settings arriving): follow it too.
    const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!;
    const self = this;
    Object.defineProperty(this.model, 'value', {
      configurable: true,
      get() {
        return d.get!.call(this);
      },
      set(v: string) {
        const was = d.get!.call(this);
        d.set!.call(this, v);
        if (was !== v) self.sync();
      },
    });
    this.sync();
  }

  /** Redraw from the model: its value, and whether it is disabled (a championship under way). */
  sync(): void {
    const v = this.model.value;
    const derived = this.categoryOf(v);
    // Favourites stays up while the pick is one of them; anything else shows its own kind.
    if (!(this.category === 'fav' && this.favKey(v) !== null && this.favs.has(this.favKey(v)!))) this.category = derived;
    this.cat.value = this.category;
    this.fillList();
    if (this.category !== 'day' && this.category !== 'seed' && this.list.value) this.last.set(this.category, this.list.value);
    const off = this.model.disabled;
    const blank = this.category === 'day';
    const seeded = this.category === 'seed';
    this.seedRow.hidden = !seeded;
    this.listRow.hidden = seeded;
    // The day has nothing more to choose: the row keeps its place, so nothing below it jumps.
    this.listRow.classList.toggle('blank', blank);
    this.cat.disabled = off;
    this.list.disabled = off || blank || this.list.options.length === 0 || this.list.options[0]!.disabled;
    this.listRandom.disabled = off || blank || this.choices().length < 2;
    this.favButtons[0]!.disabled = off || blank || this.favKey(v) === null;
    this.favButtons[1]!.disabled = off;
    this.seed.disabled = off;
    this.seedRandom.disabled = off;
    this.showFav();
  }

  /** Which kind a model value is. */
  private categoryOf(v: string): TrackCategory {
    if (v === 'day') return 'day';
    if (v === 'seed') return 'seed';
    return this.tracks[Number(v)]?.circuit ? 'real' : 'own';
  }

  /** The current pick as a favourite, or null for the Track of the Day. */
  private favKey(v = this.model.value): string | null {
    if (v === 'day') return null;
    if (v === 'seed') return seedFav(this.seed.value);
    const t = this.tracks[Number(v)];
    return t ? `t:${t.id}` : null;
  }

  /** The list's choices for the kind on show: [value, name]. A favourite seed's value is its `s:` key. */
  private choices(): [string, string][] {
    if (this.category === 'fav') {
      return this.favs.all.flatMap((f): [string, string][] => {
        if (f.startsWith('s:')) return [[f, `Seed ${f.slice(2)}`]];
        const i = this.tracks.findIndex((t) => t.id === f.slice(2));
        return i < 0 ? [] : [[String(i), this.tracks[i]!.name]];
      });
    }
    if (this.category === 'real' || this.category === 'own') {
      const real = this.category === 'real';
      return this.tracks.flatMap((t, i): [string, string][] => (!!t.circuit === real ? [[String(i), t.name]] : []));
    }
    return [];
  }

  private fillList(): void {
    const items = this.choices();
    const key = `${this.category}|${items.map((i) => i[0]).join()}`;
    if (this.list.dataset.key !== key) {
      this.list.dataset.key = key;
      this.list.replaceChildren(...items.map(([value, name]) => new Option(name, value)));
      if (!items.length) {
        const none = new Option(this.category === 'fav' ? 'None yet: ☆ marks one' : '—', '');
        none.disabled = true;
        this.list.append(none);
      }
    }
    const v = this.model.value;
    const want = v === 'seed' ? seedFav(this.seed.value) : v;
    if ([...this.list.options].some((o) => o.value === want)) this.list.value = want;
  }

  private showFav(): void {
    const key = this.favKey();
    const on = key !== null && this.favs.has(key);
    for (const b of this.favButtons) {
      b.textContent = on ? '★' : '☆';
      b.classList.toggle('on', on);
      const what = on ? 'Take this track out of your favourites' : 'Add this track to your favourites';
      b.title = what;
      b.setAttribute('aria-label', what);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  private pickCategory(c: TrackCategory): void {
    this.category = c;
    if (c === 'day') return this.setModel('day');
    if (c === 'seed') return this.setModel('seed');
    const items = this.choices();
    if (!items.length) {
      // No favourites yet: the pick stays as it was, and the list says how to make one.
      this.sync();
      return;
    }
    const current = this.model.value === 'seed' ? seedFav(this.seed.value) : this.model.value;
    const remembered = this.last.get(c);
    const pick = items.some((i) => i[0] === current) ? current : items.some((i) => i[0] === remembered) ? remembered! : items[0]![0];
    this.pickFromList(pick);
  }

  private pickFromList(value: string): void {
    if (!value) return;
    if (value.startsWith('s:')) {
      // A favourite seed: into the seed box, as if typed, then raced.
      this.seed.value = value.slice(2);
      this.seed.dispatchEvent(new Event('input', { bubbles: true }));
      this.seed.dispatchEvent(new Event('change', { bubbles: true }));
      return this.setModel('seed', true);
    }
    this.setModel(value);
  }

  private randomFromList(): void {
    const items = this.choices();
    const current = this.list.value;
    const others = items.filter((i) => i[0] !== current);
    if (!others.length) return;
    this.pickFromList(others[Math.floor(Math.random() * others.length)]![0]);
  }

  private toggleFav(): void {
    const key = this.favKey();
    if (key) this.favs.toggle(key);
  }

  /** Set the model and tell the page, as a pick in the old select did. */
  private setModel(v: string, always = false): void {
    if (this.model.value === v && !always) {
      this.sync();
      return;
    }
    this.model.value = v;
    this.model.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
