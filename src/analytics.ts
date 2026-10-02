import { ANALYTICS } from './config.js';
import { seedOf, trackName } from './sim/track/generate.js';
import { VERSION } from './version.js';

/*
 * Anonymous gameplay statistics (#35): which modes and tracks get raced, how
 * many races a visit lasts, and what goes wrong. Events go straight to
 * PostHog's capture API, batched, with no library and no cookies: an
 * anonymous id in localStorage, no person profiles, and never the player's
 * name. Anything that fails is dropped: an ad blocker or a dropped connection
 * must never touch the game.
 */

export type Props = Record<string, string | number | boolean | null | undefined>;

export interface Captured {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Props;
}

/** Sends a body to a URL; `beacon` when the page is going away. */
export type Sender = (url: string, body: string, beacon: boolean) => void;

/** Why this page might send nothing, beyond its address. */
export interface OptOut {
  /** Do Not Track or Global Privacy Control. */
  doNotTrack?: boolean;
  /** A browser driven by a test tool (`navigator.webdriver`): Playwright, Selenium, headless Chrome. */
  automated?: boolean;
  /** This device was opted out with `?noanalytics` (one of ours). */
  device?: boolean;
}

/**
 * Which `env` this page's events carry, or null for none sent: only the sites
 * in `ANALYTICS.sites`, never with `?noanalytics`, Do Not Track, a test tool
 * driving the browser, or a device opted out. `?analytics=force` on localhost
 * sends as `test`, for the smoke test that checks the events.
 */
export function analyticsEnv(hostname: string, search: string, out: OptOut = {}): string | null {
  const params = new URLSearchParams(search);
  if (params.has('noanalytics')) return null;
  if (params.get('analytics') === 'force' && (hostname === 'localhost' || hostname === '127.0.0.1')) return 'test';
  if (out.doNotTrack || out.automated || out.device) return null;
  return ANALYTICS.sites[hostname] ?? null;
}

/** The longest seed the menu's box takes. */
export const SEED_MAX = 20;

/** A seed as reported: as the game reads it, lower case, and nothing that looks like an email address. */
export function seedWord(text: string): string {
  const word = text.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, SEED_MAX) || 'nitro';
  return word.includes('@') ? '[redacted]' : word;
}

/** A seeded track's properties from the word typed: the word, the seed it makes, and the track's name. */
export function seedProps(text: string): Props {
  return { seed_word: seedWord(text), ...seedNumProps(seedOf(text || 'NITRO')) };
}

/** A seeded track's properties when only its seed is known (a room's race). */
export function seedNumProps(seed: number): Props {
  return { seed_num: seed, seed_name: trackName(seed) };
}

/** A UUIDv7, as PostHog wants its session ids: the time first, then random bits. */
export function uuidv7(now: number, rand: () => number = Math.random): string {
  const hex = now.toString(16).padStart(12, '0').slice(-12);
  const r = (n: number): string => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
  const variant = (8 + Math.floor(rand() * 4)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7${r(3)}-${variant}${r(3)}-${r(12)}`;
}

export class Analytics {
  private queue: Captured[] = [];
  private errors = 0;
  readonly sessionId: string;
  readonly startedAt: number;
  racesStarted = 0;
  racesFinished = 0;
  racesQuit = 0;
  /** Called as the visit ends, before its totals: a race still running is reported as left. */
  onEnd: (() => void) | null = null;

  /**
   * @param env    the `env` property, or null to send nothing at all
   * @param id     the anonymous player id
   * @param send   how a batch goes out
   * @param url    the page's address, without its query (room codes are in it)
   */
  constructor(
    readonly env: string | null,
    private readonly id: string,
    private readonly send: Sender,
    private readonly url = '',
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
    this.sessionId = uuidv7(this.startedAt);
  }

  get enabled(): boolean {
    return this.env !== null && ANALYTICS.token !== '';
  }

  /** The events waiting to go: for tests. */
  get pending(): readonly Captured[] {
    return this.queue;
  }

  track(event: string, props: Props = {}): void {
    if (!this.enabled) return;
    const properties: Props = {
      ...props,
      version: VERSION,
      env: this.env,
      $session_id: this.sessionId,
      $process_person_profile: false,
      $lib: 'nitrocarnage',
    };
    if (this.url) properties.$current_url = this.url;
    this.queue.push({ event, distinct_id: this.id, timestamp: new Date(this.now()).toISOString(), properties });
    if (this.queue.length >= ANALYTICS.batch) this.flush();
  }

  /** A race has started: counted, and its number in this visit returned. */
  raceStarted(): number {
    return ++this.racesStarted;
  }

  /** A page error, cut short, at most `maxErrors` a visit. */
  error(message: string, source = '', line = 0): void {
    if (this.errors >= ANALYTICS.maxErrors) return;
    this.errors++;
    this.track('error', { message: message.slice(0, 200), source: source.split(/[?#]/)[0]!.split('/').pop() ?? '', line });
  }

  /** The visit is over: its totals, then everything still queued. */
  end(): void {
    this.onEnd?.();
    this.track('session_end', {
      duration_s: Math.round((this.now() - this.startedAt) / 1000),
      races_started: this.racesStarted,
      races_finished: this.racesFinished,
      races_quit: this.racesQuit,
    });
    this.flush(true);
  }

  flush(beacon = false): void {
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    try {
      this.send(`${ANALYTICS.host}/batch/`, JSON.stringify({ api_key: ANALYTICS.token, batch }), beacon);
    } catch {
      /* dropped: statistics are never worth an error */
    }
  }
}

/** The kind of device, from the layout and the screen. */
export function deviceClass(tv: boolean): string {
  if (tv) return 'tv';
  const ua = navigator.userAgent;
  const w = Math.max(screen.width, screen.height);
  const h = Math.min(screen.width, screen.height);
  if (/Linux/.test(ua) && !/Android/.test(ua) && w === 1280 && h === 800) return 'deck';
  if (matchMedia('(pointer: coarse)').matches) return h < 600 ? 'phone' : 'tablet';
  return 'desktop';
}

/**
 * Statistics for this page: on only on the game's own sites. `?noanalytics`
 * also opts this device out for good (our own devices, so our play stays out
 * of the numbers); `?analytics=on` opts it back in.
 */
export function startAnalytics(store: { get(k: string): string; set(k: string, v: string): void }, key: string): Analytics {
  const params = new URLSearchParams(location.search);
  const optKey = `${key}.off`;
  if (params.has('noanalytics')) store.set(optKey, '1');
  if (params.get('analytics') === 'on') store.set(optKey, '');
  const env = analyticsEnv(location.hostname, location.search, {
    doNotTrack: navigator.doNotTrack === '1' || (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true,
    automated: navigator.webdriver === true,
    device: store.get(optKey) === '1',
  });
  let id = env ? store.get(key) : '';
  if (env && !id) {
    id = crypto.randomUUID?.() ?? uuidv7(Date.now());
    store.set(key, id);
  }
  const send: Sender = (url, body, beacon) => {
    // Plain text: a JSON content type would cost a CORS preflight per batch. PostHog reads the body either way.
    if (beacon && navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))) return;
    void fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true }).catch(() => undefined);
  };
  const a = new Analytics(env, id, send, location.origin + location.pathname);
  if (!a.enabled) return a;
  window.setInterval(() => a.flush(), ANALYTICS.flushMs);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') a.flush(true);
  });
  addEventListener('pagehide', () => a.end());
  addEventListener('error', (e) => a.error(e.message || 'error', e.filename, e.lineno));
  addEventListener('unhandledrejection', (e) => a.error(String((e.reason as Error | undefined)?.message ?? e.reason)));
  return a;
}
