import { NET } from '../config.js';
import { CAR_FLAG, encodeCars } from './codec.js';
import { RemoteCar } from './deadReckoning.js';
/** A car as it goes on the wire, stamped with room time `t`. */
export function packetOf(e, t) {
    const c = e.car;
    let flags = 0;
    if (c.throttle > 0)
        flags |= CAR_FLAG.throttle;
    if (c.braking)
        flags |= CAR_FLAG.brake;
    if (c.handbrake)
        flags |= CAR_FLAG.handbrake;
    if (c.boosting)
        flags |= CAR_FLAG.boost;
    if (c.drifting)
        flags |= CAR_FLAG.drift;
    if (c.airborne)
        flags |= CAR_FLAG.airborne;
    if (e.ghost > 0)
        flags |= CAR_FLAG.ghost;
    if (e.lap.finished)
        flags |= CAR_FLAG.finished;
    if (e.wrecked > 0)
        flags |= CAR_FLAG.wrecked;
    return {
        t, x: c.x, z: c.z, yaw: c.yaw, vx: c.vx, vz: c.vz, w: c.w, steer: c.steer, y: c.y, vy: c.vy,
        flags, hp: Math.round(e.hp), lap: e.lap.completed, s: e.s,
    };
}
/**
 * Events said again in the next messages after their first: a public broker
 * loses a few percent of QoS 0 messages, and a lost shot or hit is not
 * repaired by the next packet the way a lost position is. Receivers ignore
 * the copies. Laps, respawns and bumps are not repeated: a lap rides in the
 * car state anyway, and a respawn or bump applied twice would be wrong.
 */
const REPEATED = new Set(['fire', 'mine', 'hit', 'trigger', 'wreck', 'finish', 'cooldown']);
/** Events that should not wait out the send schedule: a shot is worth its 50 ms, and so is a shove. */
const URGENT = new Set(['fire', 'mine', 'hit', 'trigger', 'bump']);
/**
 * Everything this client tells the room about the cars it drives — its own,
 * and the bots while it is host — in one message on its own topic.
 *
 * The message goes out on a 20 Hz schedule; early (at most 30 Hz) when a
 * peer's dead reckoning of one of our cars has drifted too far or its flags
 * changed; and at once for a shot, a hit or a bump. Events ride with their
 * car's state, and the ones that matter are repeated.
 */
export class CarPublisher {
    net;
    clock;
    topic;
    playerId;
    cars = new Map();
    /** When the last car message went out, and when the next is due, local ms. */
    lastSentAt = 0;
    nextSendAt = 0;
    constructor(net, clock, topic, playerId) {
        this.net = net;
        this.clock = clock;
        this.topic = topic;
        this.playerId = playerId;
    }
    /** Start publishing this car. */
    own(e) {
        this.cars.set(e.id, { entrant: e, last: null, pending: [], repeats: [], urgent: false, finishSaidAt: 0 });
    }
    /** Stop publishing this car; it is somebody else's now. */
    release(id) {
        this.cars.delete(id);
    }
    clear() {
        this.cars.clear();
    }
    owns(id) {
        return this.cars.has(id);
    }
    /** A car this client drives, or undefined. */
    entrant(id) {
        return this.cars.get(id)?.entrant;
    }
    ids() {
        return [...this.cars.keys()];
    }
    /** Queue an event to go out with car `id`'s next state, if this client drives it. */
    say(id, ev) {
        const o = id ? this.cars.get(id) : undefined;
        if (!o)
            return;
        o.pending.push(ev);
        if (URGENT.has(ev.k))
            o.urgent = true;
    }
    /**
     * Send what is due.
     *
     * @param stamp room time of the world's current step, ms
     * @param unconfirmed whether a car's finish still waits for the host to list it
     */
    publish(w, stamp, unconfirmed) {
        if (this.cars.size === 0)
            return;
        const now = this.clock.now();
        const every = 1000 / NET.carHz;
        // A finish is sent once, and a public broker may drop it (and its repeats);
        // then the host never counts the car home. Say it again each second until
        // the room's heartbeat lists it.
        for (const o of this.cars.values()) {
            const e = o.entrant;
            if (e.lap.finished && e.lap.finishTime !== null && now - o.finishSaidAt >= 1000 && unconfirmed(e.id)) {
                if (o.finishSaidAt > 0 && !o.pending.some((ev) => ev.k === 'finish'))
                    o.pending.push({ k: 'finish', t: Math.round((e.lap.finishTime - w.goTime) * 1000) });
                o.finishSaidAt = now;
            }
        }
        // A schedule, not "is it 50 ms since the last one?": checked once a
        // frame, that waits for the frame *after* 50 ms, and on 16 ms frames
        // quietly sends every 64 ms — 15.6 Hz, not 20.
        const due = now >= this.nextSendAt;
        const mayEarly = now - this.lastSentAt >= 1000 / NET.carMaxHz;
        const records = [];
        for (const o of this.cars.values()) {
            const p = packetOf(o.entrant, stamp);
            // Would a peer drawing our last packet have us in the wrong place by now?
            let drifted = false;
            if (!due && mayEarly && o.last) {
                const err = RemoteCar.error(o.last, (stamp - o.last.t) / 1000, p.x, p.z, p.yaw);
                drifted = err.pos > NET.drPositionError || err.yaw > NET.drYawError || p.flags !== o.last.flags;
            }
            const eventsDue = o.pending.length > 0 && (o.urgent || now - this.lastSentAt >= NET.eventFlushMs);
            if (due || drifted || eventsDue)
                records.push({ id: o.entrant.id, car: p, events: [] });
        }
        if (records.length === 0)
            return;
        for (const r of records) {
            const o = this.cars.get(r.id);
            r.events = [...o.pending, ...o.repeats.map((x) => x.ev)];
            for (const x of o.repeats)
                x.left--;
            o.repeats = o.repeats.filter((x) => x.left > 0);
            for (const ev of o.pending)
                if (REPEATED.has(ev.k))
                    o.repeats.push({ ev, left: NET.eventRepeats });
            o.pending = [];
            o.urgent = false;
            o.last = r.car;
        }
        this.net.publish(this.topic, encodeCars(this.playerId, records));
        this.lastSentAt = now;
        if (due) {
            // Catch up by at most one period after a stall rather than bursting.
            this.nextSendAt = Math.max(this.nextSendAt + every, now - every / 2);
            if (this.nextSendAt <= now)
                this.nextSendAt = now + every;
        }
    }
}
//# sourceMappingURL=CarPublisher.js.map