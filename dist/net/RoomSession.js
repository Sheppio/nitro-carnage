import { NET } from '../config.js';
import { DEFAULT_COLOUR, resolveColours } from '../sim/palette.js';
import { Emitter } from '../util.js';
import { decodeHeartbeat, decodePresence, encodeHeartbeat, encodePresence } from './codec.js';
import { Topics, segment } from './topics.js';
export const LOBBY_STATE = {
    phase: 'L', race: 1, of: 1, track: 0, laps: 3, goAt: 0, grid: [], finish: [], cars: 6,
};
/**
 * Room membership and authority — ported from glitchburst, where every rule
 * in here was paid for with a bug.
 *
 * There is no server, so "who is in charge" is something the clients agree on
 * by themselves, with a rule boring enough to converge: **the alive player
 * with the lowest id is the host.** Ids are time-prefixed, so that is the
 * player who joined first, and every client computes it alone.
 *
 * The host heartbeats twice a second. Miss 2.5 s of beats and every client
 * re-runs the sort; exactly one promotes. Two claiming at once (a partition
 * healing) resolve on the heartbeat *and* on presence: the lower id wins.
 *
 * Time comes from the injected `Clock`, never from `performance.now()`, so
 * the Node tests can play out timeouts, failovers and frozen tabs in
 * milliseconds.
 */
export class RoomSession {
    net;
    clock;
    roomId;
    playerId;
    name;
    colour;
    ver;
    events = new Emitter();
    peers = new Map();
    unsubs = [];
    timers = [];
    lastHostBeat = 0;
    /** When the roster tick last ran, so a gap can be told from a timeout. */
    lastTickAt = 0;
    beatSeq = 0;
    _hostId = null;
    _isHost = false;
    joined = false;
    announcedFull = false;
    ready = false;
    /** The latest heartbeat heard, for a promoted host to adopt. */
    lastHeartbeat = null;
    /** Supplied by the race layer: what the heartbeat carries while this client is host. */
    stateProvider = () => LOBBY_STATE;
    /** Supplied by the clock sync: room time now, ms. */
    roomNow;
    constructor(net, clock, roomId, playerId, name, colour = DEFAULT_COLOUR, ver = '') {
        this.net = net;
        this.clock = clock;
        this.roomId = roomId;
        this.playerId = playerId;
        this.name = name;
        this.colour = colour;
        this.ver = ver;
        this.roomNow = () => clock.now();
    }
    get hostId() {
        return this._hostId;
    }
    get isHost() {
        return this._isHost;
    }
    /** Everyone currently believed alive, including this client, in id order. */
    get aliveIds() {
        const ids = [this.playerId];
        for (const p of this.peers.values())
            ids.push(p.id);
        return ids.sort();
    }
    /** Change how this client appears to the room, and say so now rather than at the next beacon. */
    setIdentity(name, colour = this.colour, look = this.look) {
        if (name === this.name && colour === this.colour && look === this.look)
            return;
        this.name = name;
        this.colour = colour;
        this.look = look;
        this.announcePresence();
    }
    /** This client's own encoded look. */
    look = '';
    setReady(ready) {
        if (ready === this.ready)
            return;
        this.ready = ready;
        this.announcePresence();
    }
    get claimedColour() {
        return this.colour;
    }
    get displayName() {
        return this.name;
    }
    /** Who ends up wearing what: computed from presence on every client, identically. */
    resolvedColours() {
        const claims = [{ id: this.playerId, colour: this.colour }];
        for (const peer of this.peers.values())
            claims.push({ id: peer.id, colour: peer.colour });
        return resolveColours(claims);
    }
    join() {
        if (this.joined)
            return;
        this.joined = true;
        // The will fires if this tab crashes or the network drops: peers de-list
        // us immediately instead of waiting out the presence timeout.
        this.net.setWill(Topics.presence(this.roomId, this.playerId), this.presencePayload(false));
        this.unsubs.push(this.net.subscribe(Topics.presenceAll(this.roomId), (topic, payload) => this.onPresence(segment(topic, 0), payload)), this.net.subscribe(Topics.heartbeat(this.roomId), (_t, payload) => this.onHeartbeat(payload)));
        this.announcePresence();
        this.timers.push(this.clock.setInterval(() => this.announcePresence(), NET.presenceMs), this.clock.setInterval(() => this.tick(), 250), this.clock.setInterval(() => this.beat(), 1000 / NET.heartbeatHz));
        // Give the room a moment to answer before claiming authority; if nobody
        // heartbeats in that window we are alone and become host by default.
        this.lastHostBeat = this.clock.now();
        this.lastTickAt = this.clock.now();
        this.timers.push(this.clock.setTimeout(() => {
            if (!this._hostId)
                this.evaluateHost('initial');
        }, 900));
    }
    leave() {
        if (!this.joined)
            return;
        this.joined = false;
        this.net.publish(Topics.presence(this.roomId, this.playerId), this.presencePayload(false));
        for (const t of this.timers)
            this.clock.clearInterval(t);
        this.timers = [];
        for (const u of this.unsubs)
            u();
        this.unsubs = [];
        this.peers.clear();
        this._isHost = false;
        this._hostId = null;
    }
    /** Publish a heartbeat now (the host does on every phase change). */
    beatNow() {
        this.beat();
    }
    presencePayload(alive) {
        return encodePresence({
            name: this.name,
            colour: this.colour,
            host: alive && this._isHost ? 1 : 0,
            alive: alive ? 1 : 0,
            ready: this.ready ? 1 : 0,
            ver: this.ver,
            look: this.look,
        });
    }
    announcePresence() {
        if (!this.joined)
            return;
        this.net.publish(Topics.presence(this.roomId, this.playerId), this.presencePayload(true));
    }
    onPresence(id, payload) {
        if (!id || id === this.playerId)
            return;
        const msg = decodePresence(payload);
        if (!msg)
            return;
        if (!msg.alive) {
            if (this.peers.delete(id)) {
                this.events.emit('peerLeave', { id });
                this.events.emit('roster', { peers: [...this.peers.values()] });
                // Losing the host is exactly what the election exists for.
                if (this._hostId === id)
                    this.evaluateHost('election');
            }
            return;
        }
        const existing = this.peers.get(id);
        const record = {
            id,
            name: msg.name,
            colour: msg.colour,
            claimsHost: msg.host === 1,
            ready: msg.ready === 1,
            ver: msg.ver,
            look: msg.look ?? '',
            lastSeen: this.clock.now(),
        };
        this.peers.set(id, record);
        const changed = !existing || existing.name !== record.name || existing.colour !== record.colour || existing.ready !== record.ready || existing.look !== record.look;
        if (!existing) {
            this.events.emit('peerJoin', { peer: record });
            // A newcomer needs to know who is in charge without waiting for a beat.
            if (this._isHost)
                this.beat();
        }
        if (changed)
            this.events.emit('roster', { peers: [...this.peers.values()] });
        // Two clients claiming authority at once, healed over presence as well as
        // the heartbeat — the heartbeat alone left a split for exactly as long as
        // its beats failed to arrive.
        if (record.claimsHost)
            this.resolveHostClaim(id);
    }
    /** Somebody else says they are host. Decide whether that outranks us. */
    resolveHostClaim(id) {
        if (this._isHost) {
            if (id >= this.playerId)
                return;
            this._isHost = false;
            this._hostId = id;
            this.events.emit('hostChange', { hostId: id, isHost: false, reason: 'yield' });
            this.announcePresence();
            return;
        }
        if (this._hostId === null) {
            this._hostId = id;
            this.events.emit('hostChange', { hostId: id, isHost: false, reason: 'election' });
        }
    }
    onHeartbeat(payload) {
        const hb = decodeHeartbeat(payload);
        if (!hb || hb.hostId === this.playerId)
            return;
        this.lastHostBeat = this.clock.now();
        this.lastHeartbeat = hb;
        // Split brain: the lower id always wins, so step down immediately.
        if (this._isHost && hb.hostId < this.playerId) {
            this._isHost = false;
            this._hostId = hb.hostId;
            this.events.emit('hostChange', { hostId: hb.hostId, isHost: false, reason: 'yield' });
            this.announcePresence();
        }
        else if (!this._isHost && this._hostId !== hb.hostId) {
            this._hostId = hb.hostId;
            this.events.emit('hostChange', { hostId: hb.hostId, isHost: false, reason: 'election' });
        }
        if (!this._isHost)
            this.events.emit('heartbeat', { hb });
    }
    beat() {
        if (!this._isHost || !this.joined)
            return;
        this.net.publish(Topics.heartbeat(this.roomId), encodeHeartbeat({ hostId: this.playerId, seq: ++this.beatSeq, roomT: this.roomNow(), ...this.stateProvider() }));
    }
    /** @internal — public so the browser suite can drive one tick directly. */
    tick() {
        if (!this.joined)
            return;
        const now = this.clock.now();
        // Were we even running? A frozen or throttled tab wakes up with every
        // timeout already blown through no fault of the room. Forgive the gap,
        // hand everyone a fresh window, and say so: our own presence is just as
        // stale to them.
        const gap = now - this.lastTickAt;
        this.lastTickAt = now;
        if (gap > NET.stallForgivenessMs) {
            for (const peer of this.peers.values())
                peer.lastSeen = now;
            this.lastHostBeat = now;
            this.announcePresence();
            return;
        }
        let dropped = false;
        for (const [id, peer] of this.peers) {
            if (now - peer.lastSeen > NET.presenceTimeoutMs) {
                this.peers.delete(id);
                this.events.emit('peerLeave', { id });
                dropped = true;
                if (this._hostId === id)
                    this.evaluateHost('election');
            }
        }
        if (dropped)
            this.events.emit('roster', { peers: [...this.peers.values()] });
        if (!this._isHost && now - this.lastHostBeat > NET.hostTimeoutMs)
            this.evaluateHost('election');
        this.checkCapacity();
    }
    /**
     * Capacity, resolved like the host: sort the alive ids and take a rank. A
     * client ranked seventh or later knows it is the overflow and stands down on
     * its own — no gatekeeper, and every client agrees on which six are in.
     */
    checkCapacity() {
        const rank = this.aliveIds.indexOf(this.playerId);
        if (rank < NET.maxPlayers) {
            this.announcedFull = false;
            return;
        }
        if (this.announcedFull)
            return;
        this.announcedFull = true;
        this.events.emit('roomFull', { capacity: NET.maxPlayers });
    }
    /** Sort the alive ids, take the front. Every client reaches the same answer. */
    evaluateHost(reason) {
        // The overflow never hosts: it is on its way out.
        const winner = this.aliveIds.slice(0, NET.maxPlayers)[0] ?? this.playerId;
        const becameHost = winner === this.playerId;
        if (becameHost && !this._isHost) {
            this._isHost = true;
            this._hostId = this.playerId;
            this.lastHostBeat = this.clock.now();
            this.events.emit('hostChange', { hostId: this.playerId, isHost: true, reason });
            this.announcePresence();
            this.beat();
            return;
        }
        if (becameHost)
            return;
        const wasHost = this._isHost;
        if (!wasHost && this._hostId === winner)
            return;
        this._isHost = false;
        this._hostId = winner;
        this.events.emit('hostChange', { hostId: winner, isHost: false, reason });
        if (wasHost)
            this.announcePresence();
    }
}
//# sourceMappingURL=RoomSession.js.map