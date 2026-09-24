import { SLUG } from '../brand.js';
import { BROKERS } from '../config.js';
import { Emitter } from '../util.js';
/** Numeric settings and the range each is clamped to when read back. */
export const RANGES = {
    deadzone: { min: 0.15, max: 0.45 },
    sfxVolume: { min: 0, max: 1 },
    musicVolume: { min: 0, max: 1 },
};
const STORAGE_KEY = `${SLUG}.settings.v1`;
const QUALITIES = ['potato', 'low', 'medium', 'high'];
export const DEFAULT_SETTINGS = {
    quality: 'high',
    deadzone: 0.15,
    touchControls: 'auto',
    vibration: true,
    reduceMotion: false,
    autopilot: false,
    sfxVolume: 1,
    musicVolume: 0.8,
    broker: BROKERS[0].id,
};
/**
 * Persisted player settings. Read back through `coerce`, because storage
 * outlives code and is trivially hand-editable, and these numbers reach a
 * deadzone divisor and a gain node.
 */
export class SettingsStore {
    events = new Emitter();
    state;
    constructor(overrides = {}) {
        this.state = coerce({ ...DEFAULT_SETTINGS, ...detectDefaults(), ...load(), ...overrides });
    }
    get current() {
        return this.state;
    }
    set(key, value) {
        if (this.state[key] === value)
            return;
        this.state = coerce({ ...this.state, [key]: value });
        save(this.state);
        this.events.emit('change', { settings: this.state });
    }
}
/**
 * Out-of-the-box graphics: Medium on a Steam Deck (its GPU is a laptop iGPU at
 * 1280x800, and it runs cooler and longer on Medium), Low on a phone.
 */
function detectDefaults() {
    if (isSteamDeck())
        return { quality: 'medium' };
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    return coarse ? { quality: 'low' } : {};
}
/** Steam's browser and Gaming Mode say so in the user agent. */
export function isSteamDeck() {
    const ua = typeof navigator === 'object' ? navigator.userAgent : '';
    return /Steam Deck|SteamOS|Valve Steam/i.test(ua);
}
function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    }
    catch {
        // Private browsing, or storage disabled. Defaults are a fine answer.
        return {};
    }
}
function coerce(state) {
    const out = { ...state };
    for (const key of Object.keys(RANGES)) {
        const { min, max } = RANGES[key];
        const value = Number(out[key]);
        out[key] = !Number.isFinite(value) ? DEFAULT_SETTINGS[key] : value < min ? min : value > max ? max : value;
    }
    if (!QUALITIES.includes(out.quality))
        out.quality = DEFAULT_SETTINGS.quality;
    if (!['auto', 'on', 'off'].includes(out.touchControls))
        out.touchControls = 'auto';
    if (!BROKERS.some((b) => b.id === out.broker))
        out.broker = BROKERS[0].id;
    for (const key of ['vibration', 'reduceMotion', 'autopilot'])
        out[key] = Boolean(out[key]);
    return out;
}
function save(settings) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    }
    catch {
        /* nothing to do — the session just won't remember these */
    }
}
/**
 * Haptic presets. Intent-named so call sites read as game events rather than
 * motor values, and so the whole game's feel can be retuned from one place.
 */
export const HAPTIC = {
    /** Hit by something. Sharp, mostly low-end. */
    damage: { weak: 0.35, strong: 0.85, ms: 160 },
    /** A wall. Scaled by impact speed at the call site. */
    crash: { weak: 0.2, strong: 0.7, ms: 120 },
    /** Coming down off a jump. */
    landing: { weak: 0.15, strong: 0.6, ms: 90 },
    /** The lights go green. */
    go: { weak: 0.6, strong: 0.3, ms: 140 },
    /** Menu focus moved. */
    navigate: { weak: 0.08, strong: 0.0, ms: 18 },
};
//# sourceMappingURL=settings.js.map