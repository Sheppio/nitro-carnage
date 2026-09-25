import type { Clock } from '../clock.js';
import { filterToRegex } from './transport.js';
import type { Transport } from './transport.js';

interface Sub {
  regex: RegExp;
  handler: (topic: string, payload: string) => void;
}

/**
 * An in-process MQTT broker for the Node tests.
 *
 * Deliveries go through the injected clock with a configurable latency, so a
 * room of seven clients, a host that goes silent and a tab that freezes can
 * all be played out deterministically in milliseconds. It keeps the two MQTT
 * behaviours the room logic depends on: QoS 0 (a dropped client's messages
 * simply stop) and the Last Will (published by the broker when a client
 * disconnects without saying goodbye).
 */
export class MemoryBroker {
  private clients = new Set<MemoryClient>();
  /** One-way delivery delay, ms. */
  latency = 20;
  /** Extra one-way delay drawn up to this, ms, per message: a public broker's variable delay. */
  jitter = 0;
  /** Fraction of messages dropped, 0..1, drawn from `rand`. */
  loss = 0;
  rand: () => number = Math.random;
  /** Every publish, for byte-budget assertions. */
  readonly log: { topic: string; payload: string; at: number }[] = [];

  constructor(readonly clock: Clock) {}

  connect(id: string): MemoryClient {
    const c = new MemoryClient(this, id);
    this.clients.add(c);
    return c;
  }

  /** @internal */
  route(from: MemoryClient | null, topic: string, payload: string): void {
    this.log.push({ topic, payload, at: this.clock.now() });
    for (const c of this.clients) {
      if (!c.connected || c.deaf) continue;
      if (this.loss > 0 && this.rand() < this.loss) continue;
      const deliver = (): void => c.deliver(topic, payload);
      const delay = this.latency + (this.jitter > 0 ? this.rand() * this.jitter : 0);
      if (delay > 0) this.clock.setTimeout(deliver, delay);
      else deliver();
    }
  }

  /** @internal */
  drop(c: MemoryClient, graceful: boolean): void {
    this.clients.delete(c);
    if (!graceful && c.will) this.route(null, c.will.topic, c.will.payload);
  }
}

export class MemoryClient implements Transport {
  connected = true;
  /** Receives nothing (a partition, or a frozen tab's socket). */
  deaf = false;
  /** Sends nothing. */
  mute = false;
  will: { topic: string; payload: string } | null = null;
  private subs: Sub[] = [];

  constructor(private broker: MemoryBroker, readonly id: string) {}

  subscribe(pattern: string, handler: (topic: string, payload: string) => void): () => void {
    const sub = { regex: filterToRegex(pattern), handler };
    this.subs.push(sub);
    return () => {
      this.subs = this.subs.filter((s) => s !== sub);
    };
  }

  publish(topic: string, payload: string): void {
    if (!this.connected || this.mute) return;
    this.broker.route(this, topic, payload);
  }

  setWill(topic: string, payload: string): void {
    this.will = { topic, payload };
  }

  /** @internal */
  deliver(topic: string, payload: string): void {
    if (!this.connected || this.deaf) return;
    for (const s of [...this.subs]) if (s.regex.test(topic)) s.handler(topic, payload);
  }

  /** `graceful = false` is a crash: the broker publishes the will. */
  disconnect(graceful = true): void {
    if (!this.connected) return;
    this.connected = false;
    this.broker.drop(this, graceful);
  }
}
