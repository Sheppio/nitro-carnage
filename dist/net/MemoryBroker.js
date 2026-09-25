import { filterToRegex } from './transport.js';
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
    clock;
    clients = new Set();
    /** One-way delivery delay, ms. */
    latency = 20;
    /** Extra one-way delay drawn up to this, ms, per message: a public broker's variable delay. */
    jitter = 0;
    /** Fraction of messages dropped, 0..1, drawn from `rand`. */
    loss = 0;
    rand = Math.random;
    /** Every publish, for byte-budget assertions. */
    log = [];
    constructor(clock) {
        this.clock = clock;
    }
    connect(id) {
        const c = new MemoryClient(this, id);
        this.clients.add(c);
        return c;
    }
    /** @internal */
    route(from, topic, payload) {
        this.log.push({ topic, payload, at: this.clock.now() });
        for (const c of this.clients) {
            if (!c.connected || c.deaf)
                continue;
            if (this.loss > 0 && this.rand() < this.loss)
                continue;
            const deliver = () => c.deliver(topic, payload);
            const delay = this.latency + (this.jitter > 0 ? this.rand() * this.jitter : 0);
            if (delay > 0)
                this.clock.setTimeout(deliver, delay);
            else
                deliver();
        }
    }
    /** @internal */
    drop(c, graceful) {
        this.clients.delete(c);
        if (!graceful && c.will)
            this.route(null, c.will.topic, c.will.payload);
    }
}
export class MemoryClient {
    broker;
    id;
    connected = true;
    /** Receives nothing (a partition, or a frozen tab's socket). */
    deaf = false;
    /** Sends nothing. */
    mute = false;
    will = null;
    subs = [];
    constructor(broker, id) {
        this.broker = broker;
        this.id = id;
    }
    subscribe(pattern, handler) {
        const sub = { regex: filterToRegex(pattern), handler };
        this.subs.push(sub);
        return () => {
            this.subs = this.subs.filter((s) => s !== sub);
        };
    }
    publish(topic, payload) {
        if (!this.connected || this.mute)
            return;
        this.broker.route(this, topic, payload);
    }
    setWill(topic, payload) {
        this.will = { topic, payload };
    }
    /** @internal */
    deliver(topic, payload) {
        if (!this.connected || this.deaf)
            return;
        for (const s of [...this.subs])
            if (s.regex.test(topic))
                s.handler(topic, payload);
    }
    /** `graceful = false` is a crash: the broker publishes the will. */
    disconnect(graceful = true) {
        if (!this.connected)
            return;
        this.connected = false;
        this.broker.drop(this, graceful);
    }
}
//# sourceMappingURL=MemoryBroker.js.map