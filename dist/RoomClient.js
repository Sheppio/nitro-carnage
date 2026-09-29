import { PumpedClock, startTicker } from './clock.js';
import { encodePresence } from './net/codec.js';
import { HybridTransport } from './net/HybridTransport.js';
import { MqttNet } from './net/MqttNet.js';
import { browserPeers, PeerMesh } from './net/PeerMesh.js';
import { NetRace } from './net/NetRace.js';
import { Topics } from './net/topics.js';
import { TRACKS } from './sim/track/index.js';
import { VERSION } from './version.js';
/**
 * One networked room, in the browser: the broker connection, the room and
 * race logic (`NetRace`), and the clock that keeps both running when the tab
 * is hidden.
 *
 * Car messages take a direct WebRTC link to each player where one opens
 * (`PeerMesh`, through `HybridTransport`), and the broker where it doesn't.
 * Everything else goes through the broker.
 *
 * The race session calls `net.update()` every frame while the tab is in
 * front. When it is not, the page's own timers are throttled to a crawl and
 * rAF stops altogether, so a Worker ticker takes over: it pumps the room's
 * timers (heartbeat, presence, clock pings) and steps the race, which keeps a
 * backgrounded host hosting and its bots driving.
 */
export class RoomClient {
    roomId;
    playerId;
    clock = new PumpedClock();
    mqtt = new MqttNet();
    net;
    /** Direct links to the other players; null when they are switched off or the browser has no WebRTC. */
    mesh;
    stopTicker = null;
    /**
     * @param iceServers STUN servers for direct links, or null for no direct links at all
     */
    constructor(roomId, playerId, name, colour, look = '', iceServers = null) {
        this.roomId = roomId;
        this.playerId = playerId;
        const peers = iceServers ? browserPeers(iceServers) : null;
        const mesh = peers ? new PeerMesh(this.mqtt, this.clock, roomId, playerId, peers) : null;
        this.mesh = mesh;
        this.net = new NetRace({
            transport: mesh ? new HybridTransport(this.mqtt, mesh, roomId) : this.mqtt,
            clock: this.clock, roomId, playerId, name, colour, ver: VERSION, tracks: TRACKS,
        });
        this.net.room.look = look;
        if (mesh)
            this.net.links = (pid) => ({ link: mesh.linkOf(pid), rtt: mesh.rttOf(pid) });
    }
    get status() {
        return this.mqtt.status;
    }
    /**
     * Connect, then join. The Last Will is registered first — it has to go in
     * the CONNECT packet — but the room is only joined once the broker answers,
     * so a slow connection cannot leave this client alone long enough to elect
     * itself host of a room that already has one.
     */
    async connect(url) {
        this.mqtt.setWill(Topics.presence(this.roomId, this.playerId), encodePresence({ name: '', colour: '', host: 0, alive: 0, ready: 0, ver: VERSION }));
        await this.mqtt.connect(url, `nc-${this.playerId}`);
        this.net.start();
        this.mesh?.start(this.net.room);
        this.stopTicker = startTicker(() => {
            this.clock.pump();
            // Hidden, rAF stops; and with no race on screen (the lobby, the results
            // after Back to lobby) nothing else calls update. The host's director
            // lives in update: undriven, a host that went back to the lobby early
            // left the room in its results phase for good, and Start did nothing.
            if (document.hidden || this.clock.now() - this.net.lastUpdateAt > 100)
                this.net.update();
        });
    }
    leave() {
        this.stopTicker?.();
        this.stopTicker = null;
        this.net.stop();
        this.mesh?.stop();
        this.mqtt.disconnect();
    }
}
//# sourceMappingURL=RoomClient.js.map