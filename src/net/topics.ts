import { NET } from '../config.js';
import type { PlayerId, RoomId } from '../types.js';

const base = (r: RoomId): string => `${NET.topicRoot}/room/${r}`;

/**
 * Every topic the game uses, in one place.
 *
 * MQTT 3.1.1 has no topic aliases, so the topic string travels in *every*
 * publish. The hot ones are therefore one or two characters on the wire —
 * `c/<car>` at 20 Hz per car is most of the room's traffic — and the
 * readable names live here, as function names, instead.
 */
export const Topics = {
  /** Presence beacon, one per player; also the Last Will topic. */
  presence: (r: RoomId, p: PlayerId) => `${base(r)}/pr/${p}`,
  presenceAll: (r: RoomId) => `${base(r)}/pr/+`,

  /** Host heartbeat: liveness plus the whole room and race state. */
  heartbeat: (r: RoomId) => `${base(r)}/hb`,

  /** Host race events (finish confirmations). */
  hostEvents: (r: RoomId) => `${base(r)}/hx`,

  /** Every car one client drives (its own; the bots, as host), with their events. */
  cars: (r: RoomId, p: PlayerId) => `${base(r)}/c/${p}`,
  carsAll: (r: RoomId) => `${base(r)}/c/+`,

  /** WebRTC set-up for a direct link, one message each way: an offer or answer for `to`, from `from`. */
  signal: (r: RoomId, to: PlayerId, from: PlayerId) => `${base(r)}/rtc/${to}/${from}`,
  signalFor: (r: RoomId, me: PlayerId) => `${base(r)}/rtc/${me}/+`,

  /** Clock sync: a client's ping, and the host's answer to it. */
  clockPing: (r: RoomId, p: PlayerId) => `${base(r)}/kq/${p}`,
  clockPingAll: (r: RoomId) => `${base(r)}/kq/+`,
  clockPong: (r: RoomId, p: PlayerId) => `${base(r)}/ka/${p}`,
} as const;

/** The publisher of a car message, from its topic; null for any other topic. */
export function carsFrom(r: RoomId, topic: string): PlayerId | null {
  const prefix = `${base(r)}/c/`;
  return topic.startsWith(prefix) ? topic.slice(prefix.length) : null;
}

/** The wildcard segment of a concrete topic, counted from the end. */
export function segment(topic: string, indexFromEnd: number): string {
  const parts = topic.split('/');
  return parts[parts.length - 1 - indexFromEnd] ?? '';
}
