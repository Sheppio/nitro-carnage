import { stepperFor } from './Picker.js';
const CATEGORIES = [
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
    key;
    store;
    list = [];
    listeners = new Set();
    constructor(key, store) {
        this.key = key;
        this.store = store;
        try {
            const saved = JSON.parse(store.get(key) || '[]');
            if (Array.isArray(saved))
                this.list = saved.filter((f) => typeof f === 'string' && /^[ts]:./.test(f));
        }
        catch {
            this.list = [];
        }
    }
    get all() {
        return this.list;
    }
    has(fav) {
        return this.list.includes(fav);
    }
    toggle(fav) {
        this.list = this.has(fav) ? this.list.filter((f) => f !== fav) : [...this.list, fav];
        this.store.set(this.key, JSON.stringify(this.list));
        for (const l of this.listeners)
            l();
    }
    onChange(l) {
        this.listeners.add(l);
    }
}
/** The seed as a favourite keeps it: trimmed, lower case, and NITRO for an empty box, as the track screen reads it. */
export const seedFav = (text) => `s:${text.trim().toLowerCase() || 'nitro'}`;
const $ = (id) => document.getElementById(id);
export class TrackChooser {
    tracks;
    favs;
    model;
    cat;
    list;
    listRow;
    seedRow;
    seed;
    listRandom;
    seedRandom;
    favButtons;
    /** The kind on show: Favourites is a choice of its own, not something the model's value says. */
    category = 'own';
    /** The last track picked in each list, to go back to when its kind is picked again. */
    last = new Map();
    /**
     * @param prefix  'menu' or 'lobby': the ids are `<prefix>-track`, `-cat`, `-list`, `-list-random`, `-fav`, `-seed`, `-seed-random`, `-seed-fav`
     * @param tracks  the built-in tracks, by index
     */
    constructor(prefix, tracks, favs) {
        this.tracks = tracks;
        this.favs = favs;
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
        this.cat.addEventListener('change', () => this.pickCategory(this.cat.value));
        this.list.addEventListener('change', () => this.pickFromList(this.list.value));
        this.listRandom.addEventListener('click', () => this.randomFromList());
        for (const b of this.favButtons)
            b.addEventListener('click', () => this.toggleFav());
        // Typing a seed makes it the pick; the star follows the word.
        this.seed.addEventListener('input', () => this.showFav());
        this.model.addEventListener('change', () => this.sync());
        favs.onChange(() => this.sync());
        // A championship under way disables the model: the chooser goes with it.
        new MutationObserver(() => this.sync()).observe(this.model, { attributes: true, attributeFilter: ['disabled'] });
        // Code setting the model without an event (a room's settings arriving): follow it too.
        const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        const self = this;
        Object.defineProperty(this.model, 'value', {
            configurable: true,
            get() {
                return d.get.call(this);
            },
            set(v) {
                const was = d.get.call(this);
                d.set.call(this, v);
                if (was !== v)
                    self.sync();
            },
        });
        this.sync();
    }
    /** Redraw from the model: its value, and whether it is disabled (a championship under way). */
    sync() {
        const v = this.model.value;
        const derived = this.categoryOf(v);
        // Favourites stays up while the pick is one of them, or while there are none
        // (the list says how to make one, and the next step moves on past it: snapping
        // back to the pick's own kind left a ‹ › stepper unable to get past an empty
        // Favourites); anything else shows its own kind.
        const favKey = this.favKey(v);
        const keepFav = this.category === 'fav' && (this.favs.all.length === 0 || (favKey !== null && this.favs.has(favKey)));
        if (!keepFav)
            this.category = derived;
        this.cat.value = this.category;
        this.fillList();
        if (this.category !== 'day' && this.category !== 'seed' && this.list.value)
            this.last.set(this.category, this.list.value);
        const off = this.model.disabled;
        const blank = this.category === 'day';
        const seeded = this.category === 'seed';
        this.seedRow.hidden = !seeded;
        this.listRow.hidden = seeded;
        // The day has nothing more to choose: the row keeps its place, so nothing below it jumps.
        this.listRow.classList.toggle('blank', blank);
        this.cat.disabled = off;
        this.list.disabled = off || blank || this.list.options.length === 0 || this.list.options[0].disabled;
        this.listRandom.disabled = off || blank || this.choices().length < 2;
        this.favButtons[0].disabled = off || blank || this.favKey(v) === null;
        this.favButtons[1].disabled = off;
        this.seed.disabled = off;
        this.seedRandom.disabled = off;
        this.showFav();
    }
    /** Which kind a model value is. */
    categoryOf(v) {
        if (v === 'day')
            return 'day';
        if (v === 'seed')
            return 'seed';
        return this.tracks[Number(v)]?.circuit ? 'real' : 'own';
    }
    /** The current pick as a favourite, or null for the Track of the Day. */
    favKey(v = this.model.value) {
        if (v === 'day')
            return null;
        if (v === 'seed')
            return seedFav(this.seed.value);
        const t = this.tracks[Number(v)];
        return t ? `t:${t.id}` : null;
    }
    /** The list's choices for the kind on show: [value, name]. A favourite seed's value is its `s:` key. */
    choices() {
        if (this.category === 'fav') {
            return this.favs.all.flatMap((f) => {
                if (f.startsWith('s:'))
                    return [[f, `Seed ${f.slice(2)}`]];
                const i = this.tracks.findIndex((t) => t.id === f.slice(2));
                return i < 0 ? [] : [[String(i), this.tracks[i].name]];
            });
        }
        if (this.category === 'real' || this.category === 'own') {
            const real = this.category === 'real';
            return this.tracks.flatMap((t, i) => (!!t.circuit === real ? [[String(i), t.name]] : []));
        }
        return [];
    }
    fillList() {
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
        if ([...this.list.options].some((o) => o.value === want))
            this.list.value = want;
    }
    showFav() {
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
    pickCategory(c) {
        this.category = c;
        if (c === 'day')
            return this.setModel('day');
        if (c === 'seed')
            return this.setModel('seed');
        const items = this.choices();
        if (!items.length) {
            // No favourites yet: the pick stays as it was, and the list says how to make one.
            this.sync();
            return;
        }
        const current = this.model.value === 'seed' ? seedFav(this.seed.value) : this.model.value;
        const remembered = this.last.get(c);
        const pick = items.some((i) => i[0] === current) ? current : items.some((i) => i[0] === remembered) ? remembered : items[0][0];
        this.pickFromList(pick);
    }
    pickFromList(value) {
        if (!value)
            return;
        if (value.startsWith('s:')) {
            // A favourite seed: into the seed box, as if typed, then raced.
            this.seed.value = value.slice(2);
            this.seed.dispatchEvent(new Event('input', { bubbles: true }));
            this.seed.dispatchEvent(new Event('change', { bubbles: true }));
            return this.setModel('seed', true);
        }
        this.setModel(value);
    }
    randomFromList() {
        const items = this.choices();
        const current = this.list.value;
        const others = items.filter((i) => i[0] !== current);
        if (!others.length)
            return;
        this.pickFromList(others[Math.floor(Math.random() * others.length)][0]);
    }
    toggleFav() {
        const key = this.favKey();
        if (key)
            this.favs.toggle(key);
    }
    /** Set the model and tell the page, as a pick in the old select did. */
    setModel(v, always = false) {
        if (this.model.value === v && !always) {
            this.sync();
            return;
        }
        this.model.value = v;
        this.model.dispatchEvent(new Event('change', { bubbles: true }));
    }
}
//# sourceMappingURL=TrackChooser.js.map