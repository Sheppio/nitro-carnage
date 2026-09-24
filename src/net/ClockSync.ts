import type { Clock } from '../clock.js';
import { NET } from '../config.js';
import type { PlayerId, RoomId } from '../types.js';
import { decodePing, decodePong, encodePing, encodePong } from './codec.js';
import { Topics, segment } from './topics.js';
import type { Transport } from './transport.js';

/** Samples kept; the one with the lowest round trip wins. */
const WINDOW = 8;

interface Sample {
  rtt: number;
  offset: number;
}

/**
 * The room clock: one timeline every client agrees on, to within a few
 * milliseconds, for GO, lap and finish stamps and (M5) the train.
 *
 * Room time is the host's clock. A client pings, the host answers straight
 * away with its room time, and the client takes
 *
 *     offset = t1 + rtt / 2 - t3
 *
 * — the NTP estimate, assuming the trip there and back took equally long. Of
 * the last eight samples the one with the *lowest* round trip is trusted,
 * because the fastest trip is the one least likely to have sat in a queue on
 * one leg only. Corrections slew rather than step, so the race clock never
 * jumps under a player's feet.
 *
 * Failover keeps the timeline continuous. A promoted host does not start
 * serving its own raw `performance.now()` — which differs from the dead
 * host's by however long the two machines have been running — but its
 * *current estimate* of room time. A GO stamped by the old host still means
 * the same instant, and nobody's lap timer jumps.
 */
export class ClockSync {
  /** Local clock + offset = room time. 0 for the original host. */
  offset = 0;
  /** Round trip of the sample currently trusted, ms. */
  rtt = 0;
  private samples: Sample[] = [];
  private synced = false;
  private isHost = false;
  private unsubs: Array<() => void> = [];
  private timer = 0;
  private fastUntil = 0;
  private lastPing = 0;

  constructor(
    private net: Transport,
    private clock: Clock,
    private roomId: RoomId,
    private playerId: PlayerId,
  ) {}

  /** Room time now, ms. */
  now(): number {
    return this.clock.now() + this.offset;
  }

  /** True once a sample has arrived (or this client is the host). */
  get ready(): boolean {
    return this.synced || this.isHost;
  }

  start(): void {
    this.unsubs.push(
      this.net.subscribe(Topics.clockPingAll(this.roomId), (topic, payload) => {
        if (!this.isHost) return;
        const from = segment(topic, 0);
        this.net.publish(Topics.clockPong(this.roomId, from), encodePong(decodePing(payload), this.now()));
      }),
      this.net.subscribe(Topics.clockPong(this.roomId, this.playerId), (_t, payload) => this.onPong(payload)),
    );
    this.hurry();
    this.timer = this.clock.setInterval(() => this.maybePing(), NET.clockFastMs);
  }

  stop(): void {
    this.clock.clearInterval(this.timer);
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  /**
   * Authority moved. As host we answer pings with the room time we already
   * hold; as a client of a new host we start sampling it quickly — but keep
   * our current offset until the new samples replace it.
   */
  setHost(isHost: boolean): void {
    this.isHost = isHost;
    this.samples = [];
    if (!isHost) this.hurry();
  }

  private hurry(): void {
    this.fastUntil = this.clock.now() + NET.clockFastForMs;
  }

  private maybePing(): void {
    if (this.isHost) return;
    const now = this.clock.now();
    const every = now < this.fastUntil ? NET.clockFastMs : NET.clockSlowMs;
    if (now - this.lastPing < every - 1) return;
    this.lastPing = now;
    this.net.publish(Topics.clockPing(this.roomId, this.playerId), encodePing(now));
  }

  private onPong(payload: string): void {
    if (this.isHost) return;
    const pong = decodePong(payload);
    if (!pong) return;
    const t3 = this.clock.now();
    const rtt = t3 - pong.t0;
    if (rtt < 0 || rtt > 10000) return;
    this.samples.push({ rtt, offset: pong.t1 + rtt / 2 - t3 });
    if (this.samples.length > WINDOW) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.rtt = best.rtt;
    if (!this.synced || Math.abs(best.offset - this.offset) > 250) {
      // First sample, or a jump too big to slew through (a new host on a
      // clock that disagrees): take it outright.
      this.offset = best.offset;
      this.synced = true;
    } else {
      this.offset += (best.offset - this.offset) * 0.5;
    }
  }
}
