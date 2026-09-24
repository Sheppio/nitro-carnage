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

  /** One car's state, published by its owner (the host, for bots). */
  carState: (r: RoomId, car: string) => `${base(r)}/c/${car}`,
  carStateAll: (r: RoomId) => `${base(r)}/c/+`,

  /** One car's events: laps, finish, respawn, bumps. */
  carEvents: (r: RoomId, car: string) => `${base(r)}/e/${car}`,
  carEventsAll: (r: RoomId) => `${base(r)}/e/+`,

  /** Clock sync: a client's ping, and the host's answer to it. */
  clockPing: (r: RoomId, p: PlayerId) => `${base(r)}/kq/${p}`,
  clockPingAll: (r: RoomId) => `${base(r)}/kq/+`,
  clockPong: (r: RoomId, p: PlayerId) => `${base(r)}/ka/${p}`,
} as const;

/** The wildcard segment of a concrete topic, counted from the end. */
export function segment(topic: string, indexFromEnd: number): string {
  const parts = topic.split('/');
  return parts[parts.length - 1 - indexFromEnd] ?? '';
}
