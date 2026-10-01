import { SLUG } from '../brand.js';
import { BROKERS, CAMERA_ORDER } from '../config.js';
import { Emitter } from '../util.js';
/** Numeric settings and the range each is clamped to when read back. */
export const RANGES = {
    deadzone: { min: 0.15, max: 0.45 },
    sfxVolume: { min: 0, max: 1 },
    musicVolume: { min: 0, max: 1 },
    ghostLead: { min: -1, max: 3 },
    fov: { min: 35, max: 70 },
    camX: { min: -5, max: 5 },
    camY: { min: 0.3, max: 60 },
    camZ: { min: -5, max: 40 },
    camPitch: { min: -90, max: 20 },
};
const STORAGE_KEY = `${SLUG}.settings.v1`;
const QUALITIES = ['potato', 'low', 'medium', 'high'];
export const DEFAULT_SETTINGS = {
    quality: 'high',
    deadzone: 0.15,
    touchControls: 'auto',
    touchSteer: 'slider',
    vibration: true,
    reduceMotion: false,
    autopilot: false,
    sfxVolume: 1,
    musicVolume: 0.8,
    ghostLead: 0,
    nameTags: 'rivals',
    botLevel: 'hard',
    fov: 50,
    broker: BROKERS[0].id,
    direct: true,
    uiSize: 'auto',
    fullscreen: false,
    autoThrottle: false,
    cameraView: 'overhead',
    // The Custom view starts where Chase, far is.
    camX: 0,
    camY: 4.5,
    camZ: 11,
    camPitch: -12,
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
/** Xbox Edge and the PlayStation browser say so in the user agent: a console means a TV. */
export function isConsole() {
    const ua = typeof navigator === 'object' ? navigator.userAgent : '';
    return /Xbox|PlayStation/i.test(ua);
}
/** Whether the TV layout is on: asked for, or 'auto' on a console. */
export function tvLayout(size) {
    return size === 'tv' || (size === 'auto' && isConsole());
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
    if (!['slider', 'buttons'].includes(out.touchSteer))
        out.touchSteer = 'slider';
    if (!['easy', 'medium', 'hard', 'expert'].includes(out.botLevel))
        out.botLevel = 'hard';
    if (!['rivals', 'all', 'off'].includes(out.nameTags))
        out.nameTags = 'rivals';
    if (!BROKERS.some((b) => b.id === out.broker))
        out.broker = BROKERS[0].id;
    if (!['auto', 'normal', 'tv'].includes(out.uiSize))
        out.uiSize = 'auto';
    if (!CAMERA_ORDER.includes(out.cameraView))
        out.cameraView = 'overhead';
    for (const key of ['vibration', 'reduceMotion', 'autopilot', 'fullscreen', 'autoThrottle'])
        out[key] = Boolean(out[key]);
    // Missing from settings saved before it existed: on.
    out.direct = out.direct !== false;
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
    /** Your car wrecked. Long and heavy. */
    wreck: { weak: 0.7, strong: 1, ms: 420 },
    /** You fired. A tick in the light motor, so a shot is felt leaving. */
    fire: { weak: 0.3, strong: 0.05, ms: 45 },
    /** A wall. Scaled by impact speed at the call site. */
    crash: { weak: 0.2, strong: 0.7, ms: 120 },
    /** Coming down off a jump. */
    landing: { weak: 0.15, strong: 0.6, ms: 90 },
    /** Each light of the countdown: a tap, so GO lands harder. */
    count: { weak: 0.25, strong: 0.2, ms: 80 },
    /** Took a pickup box: a light double tick. */
    pickup: { weak: 0.4, strong: 0.1, ms: 70 },
    /** The lights go green. */
    go: { weak: 0.6, strong: 0.3, ms: 140 },
    /** Menu focus moved. */
    navigate: { weak: 0.08, strong: 0.0, ms: 18 },
};
//# sourceMappingURL=settings.js.map