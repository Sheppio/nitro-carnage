import type { Clock } from '../clock.js';
import { NET } from '../config.js';
import type { PlayerId, RoomId } from '../types.js';
import { Emitter } from '../util.js';
import type { RoomSession } from './RoomSession.js';
import { Topics, segment } from './topics.js';
import type { Transport } from './transport.js';

/** How this client reaches one other player's car messages. */
export type Link = 'connecting' | 'direct' | 'broker';

/* The parts of RTCPeerConnection and RTCDataChannel the mesh uses, so the
 * Node tests can stand in a fake. A browser's own objects fit them. */

export interface SessionDesc {
  type: string;
  sdp?: string;
}

export interface ChannelLike {
  readonly readyState: string;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface PeerLike {
  readonly localDescription: SessionDesc | null;
  readonly iceGatheringState: string;
  readonly connectionState: string;
  createDataChannel(label: string, init: { ordered: boolean; maxRetransmits: number }): ChannelLike;
  createOffer(): Promise<SessionDesc>;
  createAnswer(): Promise<SessionDesc>;
  setLocalDescription(d: SessionDesc): Promise<void>;
  setRemoteDescription(d: SessionDesc): Promise<void>;
  close(): void;
  onicegatheringstatechange: (() => void) | null;
  onconnectionstatechange: (() => void) | null;
  ondatachannel: ((ev: { channel: ChannelLike }) => void) | null;
}

export type PeerFactory = () => PeerLike;

/** A factory for the browser's own RTCPeerConnection. */
export function browserPeers(iceServers: readonly { urls: string }[]): PeerFactory | null {
  const RTC = (globalThis as { RTCPeerConnection?: new (c: object) => unknown }).RTCPeerConnection;
  if (!RTC) return null;
  return () => new RTC({ iceServers }) as PeerLike;
}

interface Pair {
  pid: PlayerId;
  link: Link;
  /** Which attempt this is; an answer to an older one is ignored. */
  epoch: number;
  pc: PeerLike | null;
  channel: ChannelLike | null;
  /** When the current attempt started, and when the channel last said anything, local ms. */
  since: number;
  heardAt: number;
  /** When a pair on the broker tries again (the offering side only). */
  retryAt: number;
  /** Round trip over the channel, ms, from the pings. */
  rtt: number;
}

export interface MeshEvents extends Record<string, unknown> {
  /** A pair's link changed. */
  link: { pid: PlayerId; link: Link };
}

/* On the channel, a car message is sent as it is: it always starts with a
 * base36 digit, a minus sign or a car id. Pings and pongs start with a
 * control character, so the two never mix. */
const PING = '\u0001';
const PONG = '\u0002';

/**
 * Direct links to every other player in the room, for car messages.
 *
 * One WebRTC data channel per pair, unordered and never retransmitted, like
 * the QoS 0 broker path it stands in for. The player with the lower id makes
 * the offer, so both ends agree who starts without asking. Set-up goes over
 * MQTT in one message each way: the offer waits for ICE gathering to finish
 * (or `gatherMs`), rather than trickling candidates one message at a time.
 *
 * A pair whose channel doesn't open within `openTimeoutMs`, closes, or goes
 * silent for `staleMs` is on the broker; the offering side tries again after
 * `retryMs`. There's no TURN server, so some pairs never get a direct link:
 * `HybridTransport` keeps their car messages on MQTT.
 */
export class PeerMesh {
  readonly events = new Emitter<MeshEvents>();
  /** A car message from `from` arrived over its direct link. */
  onMessage: (from: PlayerId, payload: string) => void = () => {};

  private pairs = new Map<PlayerId, Pair>();
  /** Offers from players whose presence hasn't reached us yet, answered when it does. */
  private early = new Map<PlayerId, string>();
  private unsubs: Array<() => void> = [];
  private timer = 0;
  private started = false;
  /** When `tick` last ran, local ms: a long gap means this tab stalled, not the links. */
  private tickedAt = 0;

  constructor(
    private net: Transport,
    private clock: Clock,
    private roomId: RoomId,
    private playerId: PlayerId,
    private createPeer: PeerFactory,
  ) {}

  /** Listen for offers and answers, and keep links to the room's players as they come and go. */
  start(room: RoomSession): void {
    if (this.started) return;
    this.started = true;
    const follow = (): void => this.setPeers([...room.peers.keys()]);
    this.unsubs.push(
      this.net.subscribe(Topics.signalFor(this.roomId, this.playerId), (topic, payload) => this.onSignal(segment(topic, 0), payload)),
      room.events.on('roster', follow),
      room.events.on('peerJoin', follow),
      room.events.on('peerLeave', follow),
    );
    this.tickedAt = this.clock.now();
    this.timer = this.clock.setInterval(() => this.tick(), NET.rtc.pingMs);
    follow();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.clock.clearInterval(this.timer);
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const p of this.pairs.values()) this.shut(p);
    this.pairs.clear();
    this.early.clear();
  }

  linkOf(pid: PlayerId): Link {
    return this.pairs.get(pid)?.link ?? 'broker';
  }

  /** Round trip over the direct link, ms, or null without one. */
  rttOf(pid: PlayerId): number | null {
    const p = this.pairs.get(pid);
    return p?.link === 'direct' && p.rtt > 0 ? p.rtt : null;
  }

  /**
   * Car messages to and from this player can rely on the link: it is open and
   * has spoken within `quietMs`. A quiet link is kept (its far end may be
   * busy building a scene), but the broker carries the traffic meanwhile.
   */
  usable(pid: PlayerId): boolean {
    const p = this.pairs.get(pid);
    return p !== undefined && p.link === 'direct' && this.clock.now() - p.heardAt < NET.rtc.quietMs;
  }

  /** Every other player is reachable over a usable link (or there is nobody else). */
  allDirect(): boolean {
    for (const pid of this.pairs.keys()) if (!this.usable(pid)) return false;
    return true;
  }

  /** Send a car message down every open link. */
  broadcast(payload: string): void {
    for (const p of this.pairs.values()) if (p.link === 'direct') this.send(p, payload);
  }

  /** The room's players changed: open links to newcomers, close those to leavers. */
  setPeers(ids: readonly PlayerId[]): void {
    const want = new Set(ids.filter((id) => id !== this.playerId));
    for (const [pid, p] of this.pairs) {
      if (want.has(pid)) continue;
      this.shut(p);
      this.pairs.delete(pid);
    }
    for (const pid of want) {
      if (this.pairs.has(pid)) continue;
      const p: Pair = { pid, link: 'connecting', epoch: 0, pc: null, channel: null, since: this.clock.now(), heardAt: 0, retryAt: 0, rtt: 0 };
      this.pairs.set(pid, p);
      // The lower id offers; the other waits for it, and times out to the broker if it never comes.
      if (this.offers(pid)) void this.offer(p);
      const offer = this.early.get(pid);
      this.early.delete(pid);
      if (offer) this.onSignal(pid, offer);
    }
  }

  private offers(pid: PlayerId): boolean {
    return this.playerId < pid;
  }

  private setLink(p: Pair, link: Link): void {
    if (p.link === link) return;
    p.link = link;
    this.events.emit('link', { pid: p.pid, link });
  }

  /** Close a pair's connection, leaving the pair itself. */
  private shut(p: Pair): void {
    const { pc, channel } = p;
    p.pc = null;
    p.channel = null;
    if (channel) channel.onopen = channel.onclose = channel.onmessage = null;
    try {
      channel?.close();
      pc?.close();
    } catch {
      /* already closed */
    }
  }

  /** The link is not direct (any more): use the broker, and try again later — soon, if it had worked. */
  private fail(p: Pair): void {
    this.shut(p);
    p.retryAt = this.clock.now() + (p.link === 'direct' ? NET.rtc.reopenMs : NET.rtc.retryMs);
    this.setLink(p, 'broker');
  }

  private async offer(p: Pair): Promise<void> {
    this.shut(p);
    const epoch = ++p.epoch;
    p.since = this.clock.now();
    this.setLink(p, 'connecting');
    const pc = this.createPeer();
    p.pc = pc;
    this.watch(p, pc);
    this.wire(p, pc.createDataChannel('c', { ordered: false, maxRetransmits: 0 }));
    try {
      await pc.setLocalDescription(await pc.createOffer());
      const sdp = await this.gathered(pc);
      if (p.pc !== pc || p.epoch !== epoch) return;
      this.net.publish(Topics.signal(this.roomId, p.pid, this.playerId), `o|${epoch}|${sdp}`);
    } catch {
      if (p.pc === pc) this.fail(p);
    }
  }

  private async answer(p: Pair, epoch: number, sdp: string): Promise<void> {
    this.shut(p);
    p.epoch = epoch;
    p.since = this.clock.now();
    this.setLink(p, 'connecting');
    const pc = this.createPeer();
    p.pc = pc;
    this.watch(p, pc);
    pc.ondatachannel = (ev) => {
      if (p.pc === pc) this.wire(p, ev.channel);
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      const mine = await this.gathered(pc);
      if (p.pc !== pc) return;
      this.net.publish(Topics.signal(this.roomId, p.pid, this.playerId), `a|${epoch}|${mine}`);
    } catch {
      if (p.pc === pc) this.fail(p);
    }
  }

  /** The local description once ICE gathering is done, or once `gatherMs` has passed. */
  private gathered(pc: PeerLike): Promise<string> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        pc.onicegatheringstatechange = null;
        this.clock.clearTimeout(timer);
        resolve(pc.localDescription?.sdp ?? '');
      };
      const timer = this.clock.setTimeout(finish, NET.rtc.gatherMs);
      if (pc.iceGatheringState === 'complete') finish();
      else pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
    });
  }

  private watch(p: Pair, pc: PeerLike): void {
    pc.onconnectionstatechange = () => {
      if (p.pc === pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) this.fail(p);
    };
  }

  private wire(p: Pair, ch: ChannelLike): void {
    p.channel = ch;
    ch.onopen = () => {
      if (p.channel !== ch) return;
      p.heardAt = this.clock.now();
      p.rtt = 0;
      this.setLink(p, 'direct');
    };
    ch.onclose = () => {
      if (p.channel === ch) this.fail(p);
    };
    ch.onmessage = (ev) => {
      if (p.channel !== ch || typeof ev.data !== 'string') return;
      const data = ev.data;
      p.heardAt = this.clock.now();
      if (data[0] === PING) this.send(p, PONG + data.slice(1));
      else if (data[0] === PONG) {
        const rtt = this.clock.now() - Number(data.slice(1));
        if (rtt >= 0) p.rtt = p.rtt ? p.rtt + (rtt - p.rtt) * 0.3 : rtt;
      } else this.onMessage(p.pid, data);
    };
  }

  private send(p: Pair, data: string): void {
    const ch = p.channel;
    if (!ch || ch.readyState !== 'open') return;
    try {
      ch.send(data);
    } catch {
      this.fail(p);
    }
  }

  /** `o|epoch|sdp` (an offer) or `a|epoch|sdp` (the answer to it). */
  private onSignal(from: PlayerId, payload: string): void {
    const p = this.pairs.get(from);
    if (!p) {
      if (payload[0] === 'o') this.early.set(from, payload);
      return;
    }
    const bar = payload.indexOf('|', 2);
    if (bar < 0) return;
    const kind = payload[0];
    const epoch = Number(payload.slice(2, bar));
    const sdp = payload.slice(bar + 1);
    if (kind === 'o' && !this.offers(from)) {
      void this.answer(p, epoch, sdp);
    } else if (kind === 'a' && this.offers(from) && epoch === p.epoch && p.pc) {
      const pc = p.pc;
      pc.setRemoteDescription({ type: 'answer', sdp }).catch(() => {
        if (p.pc === pc) this.fail(p);
      });
    }
  }

  private tick(): void {
    const now = this.clock.now();
    // A gap this long between ticks means this tab stalled (a scene build, a
    // background tab): the silence was ours, so forgive every link rather than
    // drop them all at once.
    const stalled = now - this.tickedAt > NET.rtc.staleMs / 2;
    this.tickedAt = now;
    for (const p of this.pairs.values()) {
      if (stalled && p.link === 'direct') p.heardAt = now;
      if (stalled && p.link === 'connecting') p.since = now;
      if (p.link === 'connecting' && now - p.since >= NET.rtc.openTimeoutMs) {
        this.fail(p);
      } else if (p.link === 'direct') {
        if (now - p.heardAt >= NET.rtc.staleMs) this.fail(p);
        else this.send(p, PING + String(now));
      } else if (p.link === 'broker' && this.offers(p.pid) && now >= p.retryAt) {
        void this.offer(p);
      }
    }
  }
}
