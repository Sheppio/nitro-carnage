import { ANALYTICS } from './config.js';
import { seedOf, trackName } from './sim/track/generate.js';
import { VERSION } from './version.js';
/**
 * Which `env` this page's events carry, or null for none sent: only the sites
 * in `ANALYTICS.sites`, never with `?noanalytics`, Do Not Track, a test tool
 * driving the browser, or a device opted out. `?analytics=force` on localhost
 * sends as `test`, for the smoke test that checks the events.
 */
export function analyticsEnv(hostname, search, out = {}) {
    return analyticsStatus(hostname, search, out).env;
}
/** As `analyticsEnv`, with the reason when nothing is sent. */
export function analyticsStatus(hostname, search, out = {}) {
    const params = new URLSearchParams(search);
    const off = (why) => ({ env: null, off: why });
    if (params.has('noanalytics'))
        return off('noanalytics');
    if (params.get('analytics') === 'force' && (hostname === 'localhost' || hostname === '127.0.0.1'))
        return { env: 'test', off: null };
    if (out.automated)
        return off('automated');
    if (out.device)
        return off('device opted out');
    if (out.doNotTrack)
        return off('do not track');
    const env = ANALYTICS.sites[hostname] ?? null;
    return env ? { env, off: null } : off('not our site');
}
/** The longest seed the menu's box takes. */
export const SEED_MAX = 20;
/** A seed as reported: as the game reads it, lower case, and nothing that looks like an email address. */
export function seedWord(text) {
    const word = text.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, SEED_MAX) || 'nitro';
    return word.includes('@') ? '[redacted]' : word;
}
/** A seeded track's properties from the word typed: the word, the seed it makes, and the track's name. */
export function seedProps(text) {
    return { seed_word: seedWord(text), ...seedNumProps(seedOf(text || 'NITRO')) };
}
/** A seeded track's properties when only its seed is known (a room's race). */
export function seedNumProps(seed) {
    return { seed_num: seed, seed_name: trackName(seed) };
}
/** A UUIDv7, as PostHog wants its session ids: the time first, then random bits. */
export function uuidv7(now, rand = Math.random) {
    const hex = now.toString(16).padStart(12, '0').slice(-12);
    const r = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
    const variant = (8 + Math.floor(rand() * 4)).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8)}-7${r(3)}-${variant}${r(3)}-${r(12)}`;
}
export class Analytics {
    env;
    id;
    send;
    url;
    now;
    queue = [];
    errors = 0;
    sessionId;
    startedAt;
    racesStarted = 0;
    racesFinished = 0;
    racesQuit = 0;
    /** Called as the visit ends, before its totals: a race still running is reported as left. */
    onEnd = null;
    /** Why nothing is sent, when it isn't. */
    off = null;
    /** How the last batch went: its size and status (an HTTP status, `beacon`, `sent` or `failed`). */
    lastSend = null;
    /** Events sent without an error, this visit. */
    sentEvents = 0;
    /** Each batch's outcome, as a line: `?analytics=debug` logs them. */
    onLog = null;
    /**
     * @param env    the `env` property, or null to send nothing at all
     * @param id     the anonymous player id
     * @param send   how a batch goes out
     * @param url    the page's address, without its query (room codes are in it)
     */
    constructor(env, id, send, url = '', now = Date.now) {
        this.env = env;
        this.id = id;
        this.send = send;
        this.url = url;
        this.now = now;
        this.startedAt = now();
        this.sessionId = uuidv7(this.startedAt);
    }
    get enabled() {
        return this.env !== null && ANALYTICS.token !== '';
    }
    /** One line for the `?debug` readout: on or off, and how the last batch went. */
    get summary() {
        if (!this.enabled)
            return `stats: off (${this.off ?? 'no token'})`;
        return `stats: ${this.env} · ${this.lastSend?.status ?? 'waiting'} · ${this.sentEvents} sent`;
    }
    /** The events waiting to go: for tests. */
    get pending() {
        return this.queue;
    }
    track(event, props = {}) {
        if (!this.enabled)
            return;
        const properties = {
            ...props,
            version: VERSION,
            env: this.env,
            $session_id: this.sessionId,
            $process_person_profile: false,
            $lib: 'nitrocarnage',
        };
        if (this.url)
            properties.$current_url = this.url;
        this.queue.push({ event, distinct_id: this.id, timestamp: new Date(this.now()).toISOString(), properties });
        if (this.queue.length >= ANALYTICS.batch)
            this.flush();
    }
    /** A race has started: counted, and its number in this visit returned. */
    raceStarted() {
        return ++this.racesStarted;
    }
    /** A page error, cut short, at most `maxErrors` a visit. */
    error(message, source = '', line = 0) {
        if (this.errors >= ANALYTICS.maxErrors)
            return;
        this.errors++;
        this.track('error', { message: message.slice(0, 200), source: source.split(/[?#]/)[0].split('/').pop() ?? '', line });
    }
    /** The visit is over: its totals, then everything still queued. */
    end() {
        this.onEnd?.();
        this.track('session_end', {
            duration_s: Math.round((this.now() - this.startedAt) / 1000),
            races_started: this.racesStarted,
            races_finished: this.racesFinished,
            races_quit: this.racesQuit,
        });
        this.flush(true);
    }
    flush(beacon = false) {
        if (!this.queue.length)
            return;
        const batch = this.queue;
        this.queue = [];
        const done = (status) => {
            this.lastSend = { at: this.now(), events: batch.length, status };
            if (status !== 'failed' && !/^[45]/.test(status))
                this.sentEvents += batch.length;
            this.onLog?.(`statistics: sent ${batch.length} events → ${status}`);
        };
        // Dropped on failure: statistics are never worth an error.
        try {
            const r = this.send(`${ANALYTICS.host}/batch/`, JSON.stringify({ api_key: ANALYTICS.token, batch }), beacon);
            if (r)
                void r.then(done, () => done('failed'));
            else
                done('sent');
        }
        catch {
            done('failed');
        }
    }
}
/** The kind of device, from the layout and the screen. */
export function deviceClass(tv) {
    if (tv)
        return 'tv';
    const ua = navigator.userAgent;
    const w = Math.max(screen.width, screen.height);
    const h = Math.min(screen.width, screen.height);
    if (/Linux/.test(ua) && !/Android/.test(ua) && w === 1280 && h === 800)
        return 'deck';
    if (matchMedia('(pointer: coarse)').matches)
        return h < 600 ? 'phone' : 'tablet';
    return 'desktop';
}
/**
 * Statistics for this page: on only on the game's own sites. `?noanalytics`
 * also opts this device out for good (our own devices, so our play stays out
 * of the numbers); `?analytics=on` opts it back in.
 */
export function startAnalytics(store, key) {
    const params = new URLSearchParams(location.search);
    const optKey = `${key}.off`;
    if (params.has('noanalytics'))
        store.set(optKey, '1');
    if (params.get('analytics') === 'on')
        store.set(optKey, '');
    const { env, off } = analyticsStatus(location.hostname, location.search, {
        doNotTrack: navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true,
        automated: navigator.webdriver === true,
        device: store.get(optKey) === '1',
    });
    let id = env ? store.get(key) : '';
    if (env && !id) {
        id = crypto.randomUUID?.() ?? uuidv7(Date.now());
        store.set(key, id);
    }
    const send = async (url, body, beacon) => {
        // Plain text: a JSON content type would cost a CORS preflight per batch. PostHog reads the body either way.
        if (beacon && navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' })))
            return 'beacon';
        try {
            const r = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true });
            return String(r.status);
        }
        catch {
            return 'failed';
        }
    };
    const a = new Analytics(env, id, send, location.origin + location.pathname);
    a.off = off;
    // `?analytics=debug`: on or off and why, and every batch's outcome, in the console.
    if (params.get('analytics') === 'debug') {
        a.onLog = (line) => console.info(line);
        console.info(a.enabled ? `statistics: on as ${env}` : `statistics: off: ${off ?? 'no token'}`);
    }
    if (!a.enabled)
        return a;
    window.setInterval(() => a.flush(), ANALYTICS.flushMs);
    addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden')
            a.flush(true);
    });
    addEventListener('pagehide', () => a.end());
    addEventListener('error', (e) => a.error(e.message || 'error', e.filename, e.lineno));
    addEventListener('unhandledrejection', (e) => a.error(String(e.reason?.message ?? e.reason)));
    return a;
}
//# sourceMappingURL=analytics.js.map