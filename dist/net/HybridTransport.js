import { Topics, carsFrom } from './topics.js';
import { filterToRegex } from './transport.js';
/**
 * The transport the room and race code see: MQTT, with car messages taking
 * a direct link wherever there is one.
 *
 * A car message goes down every open link, and to the broker as well while
 * anyone in the room is not on a usable link (none, or one quiet for a
 * second) — MQTT is a broadcast, so that one publish covers them all. The
 * other direction mirrors it: a car message that comes over MQTT from a
 * player whose link is usable is dropped, because it came over the link, and
 * a bump or respawn must not be applied twice. A link that goes quiet hands
 * over to the broker at once rather than after it is given up for dead.
 * Everything else — presence, heartbeat, clock sync, the link set-up itself —
 * only ever uses MQTT.
 *
 * While a link changes state a message may briefly arrive both ways or
 * neither. Both are harmless: `RemoteCar` drops stale stamps, and the events
 * that matter are repeated and heard once.
 */
export class HybridTransport {
    mqtt;
    mesh;
    roomId;
    routes = [];
    constructor(mqtt, mesh, roomId) {
        this.mqtt = mqtt;
        this.mesh = mesh;
        this.roomId = roomId;
        mesh.onMessage = (from, payload) => {
            const topic = Topics.cars(this.roomId, from);
            for (const r of this.routes)
                if (r.regex.test(topic))
                    r.handler(topic, payload);
        };
    }
    subscribe(pattern, handler) {
        const route = { regex: filterToRegex(pattern), handler };
        this.routes.push(route);
        const off = this.mqtt.subscribe(pattern, (topic, payload) => {
            const from = carsFrom(this.roomId, topic);
            if (from !== null && this.mesh.usable(from))
                return;
            handler(topic, payload);
        });
        return () => {
            off();
            this.routes = this.routes.filter((r) => r !== route);
        };
    }
    publish(topic, payload) {
        if (carsFrom(this.roomId, topic) === null) {
            this.mqtt.publish(topic, payload);
            return;
        }
        this.mesh.broadcast(payload);
        if (!this.mesh.allDirect())
            this.mqtt.publish(topic, payload);
    }
    setWill(topic, payload) {
        this.mqtt.setWill(topic, payload);
    }
}
//# sourceMappingURL=HybridTransport.js.map