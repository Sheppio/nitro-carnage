/**
 * Time and timers, injectable.
 *
 * Everything in `net/` asks this for the time and for its intervals rather
 * than calling `performance.now()` and `setInterval` directly. In the browser
 * that is a thin wrapper. In the Node tests it is `FakeClock`, which lets a
 * test advance a whole room by sixty seconds in one call — which is how the
 * frozen-tab, failover and timeout rules are tested in milliseconds instead
 * of by waiting, and without reaching into private fields to backdate them
 * (which is what glitchburst's frozen-tab test had to do).
 */
export interface Clock {
  /** Milliseconds, monotonic. */
  now(): number;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export const realClock: Clock = {
  now: () => performance.now(),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms) as unknown as number,
  clearInterval: (id) => globalThis.clearInterval(id),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

interface Timer {
  id: number;
  at: number;
  every: number;
  fn: () => void;
}

/**
 * A clock whose timers only fire when told to.
 *
 * `tick(ms)` moves time forward and fires everything that fell due, in order
 * — so a 250 ms roster tick and a 500 ms heartbeat interleave exactly as they
 * would in real time. `jump(ms)` moves time forward *without* firing anything,
 * which is what a frozen tab experiences: the clock kept going and nothing ran.
 *
 * It is also the base of the browser's background-tab clock (`TickedClock`),
 * which is the same machinery driven by a Worker.
 */
export class FakeClock implements Clock {
  private t: number;
  private timers: Timer[] = [];
  private nextId = 1;

  constructor(start = 1000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setInterval(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + ms, every: Math.max(1, ms), fn });
    return id;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + ms, every: 0, fn });
    return id;
  }

  clearInterval(id: number): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  clearTimeout(id: number): void {
    this.clearInterval(id);
  }

  /** Advance, firing timers as they fall due. */
  tick(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: Timer | null = null;
      for (const t of this.timers) if (t.at <= end && (!next || t.at < next.at)) next = t;
      if (!next) break;
      this.t = Math.max(this.t, next.at);
      if (next.every > 0) next.at += next.every;
      else this.timers = this.timers.filter((t) => t !== next);
      next.fn();
    }
    this.t = end;
  }

  /**
   * Advance without firing anything, then let overdue timers run once each
   * (as a browser does when a frozen tab wakes: each interval fires once,
   * late, rather than once per missed period).
   */
  jump(ms: number): void {
    this.t += ms;
    const due = this.timers.filter((t) => t.at <= this.t).sort((a, b) => a.at - b.at);
    for (const t of due) {
      if (t.every > 0) t.at = this.t + t.every;
      else this.timers = this.timers.filter((x) => x !== t);
    }
    for (const t of due) t.fn();
  }
}

/**
 * The browser's clock for the network: real time, but timers that fire when
 * `pump()` is called rather than when the page's own timers say.
 *
 * A tab that is not in front has its timers throttled — to once a second at
 * first and, after five minutes, to once a *minute*. A host in a background
 * tab would miss every heartbeat and be voted out of its own room. So the
 * pump is driven from two places: an ordinary interval while the tab is in
 * front, and a tiny Worker while it is hidden, whose messages the browser
 * does not throttle (see `startTicker`).
 */
export class PumpedClock implements Clock {
  private inner = new FakeClock(0);
  private last = performance.now();

  now(): number {
    return performance.now();
  }

  setInterval(fn: () => void, ms: number): number {
    this.sync();
    return this.inner.setInterval(fn, ms);
  }

  clearInterval(id: number): void {
    this.inner.clearInterval(id);
  }

  setTimeout(fn: () => void, ms: number): number {
    this.sync();
    return this.inner.setTimeout(fn, ms);
  }

  clearTimeout(id: number): void {
    this.inner.clearTimeout(id);
  }

  /** Fire whatever has fallen due. */
  pump(): void {
    this.sync();
  }

  private sync(): void {
    const now = performance.now();
    const dt = now - this.last;
    this.last = now;
    // A gap longer than a few seconds is the tab having been frozen outright
    // (not merely throttled): run each overdue timer once, late, as a browser
    // does, so the room's stall detection sees the gap for what it is.
    if (dt > 3000) this.inner.jump(dt);
    else if (dt > 0) this.inner.tick(dt);
  }
}

/**
 * Call `fn` about every `ms`, even in a hidden tab: an interval inside a
 * Worker made from a Blob (so there is no extra file to serve), posting a
 * message each time. Returns a stop function.
 */
export function startTicker(fn: () => void, ms = 25): () => void {
  let worker: Worker | null = null;
  try {
    const src = `setInterval(() => postMessage(0), ${ms});`;
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = () => fn();
  } catch {
    // No workers (a very locked-down browser): fall back to a plain interval.
  }
  const id = worker ? 0 : globalThis.setInterval(fn, ms);
  return () => {
    worker?.terminate();
    if (id) globalThis.clearInterval(id);
  };
}
