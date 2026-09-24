import { NET } from '../config.js';
const base = (r) => `${NET.topicRoot}/room/${r}`;
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
    presence: (r, p) => `${base(r)}/pr/${p}`,
    presenceAll: (r) => `${base(r)}/pr/+`,
    /** Host heartbeat: liveness plus the whole room and race state. */
    heartbeat: (r) => `${base(r)}/hb`,
    /** Host race events (finish confirmations). */
    hostEvents: (r) => `${base(r)}/hx`,
    /** One car's state, published by its owner (the host, for bots). */
    carState: (r, car) => `${base(r)}/c/${car}`,
    carStateAll: (r) => `${base(r)}/c/+`,
    /** One car's events: laps, finish, respawn, bumps. */
    carEvents: (r, car) => `${base(r)}/e/${car}`,
    carEventsAll: (r) => `${base(r)}/e/+`,
    /** Clock sync: a client's ping, and the host's answer to it. */
    clockPing: (r, p) => `${base(r)}/kq/${p}`,
    clockPingAll: (r) => `${base(r)}/kq/+`,
    clockPong: (r, p) => `${base(r)}/ka/${p}`,
};
/** The wildcard segment of a concrete topic, counted from the end. */
export function segment(topic, indexFromEnd) {
    const parts = topic.split('/');
    return parts[parts.length - 1 - indexFromEnd] ?? '';
}
//# sourceMappingURL=topics.js.map