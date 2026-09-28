import { NET, STEP } from '../config.js';
import { createAutopilot, autopilot, skillFor } from '../sim/autopilot.js';
import { botNames, isBotId } from '../sim/bots.js';
import { COLOUR_ORDER, DEFAULT_COLOUR } from '../sim/palette.js';
import { standings } from '../sim/race.js';
import { generateTrack } from '../sim/track/generate.js';
import { botLook, decodeLook } from '../sim/look.js';
import { racingLine } from '../sim/racingLine.js';
import { World } from '../sim/World.js';
import { IDLE_INTENT } from '../types.js';
import { Emitter, hashString } from '../util.js';
import { CarPublisher } from './CarPublisher.js';
import { ClockSync } from './ClockSync.js';
import { HostDirector } from './HostDirector.js';
import { RemoteFleet } from './RemoteFleet.js';
import { LOBBY_STATE, RoomSession } from './RoomSession.js';
import { Topics, segment } from './topics.js';
/**
 * One client's view of a networked room and its races — the whole of M3's
 * networking, with no renderer and no DOM, so the Node tests can run a room of
 * six clients through a race, a failover and a frozen tab in milliseconds.
 *
 * This is the glue: the room's lifecycle, the lobby, the world, and failover.
 * The parts live alongside it — `CarPublisher` sends our cars and their
 * events, `RemoteFleet` follows everyone else's, and `HostDirector` decides
 * the phase and the finish order while this client is host.
 *
 * Authority, as PLAN.md §5.1:
 * - **Your car is yours.** You simulate it and publish it at 20 Hz, and early
 *   whenever the dead-reckoned version peers are drawing drifts too far.
 * - **Everyone else's car is a prediction.** Each is a `RemoteCar`, extrapolated
 *   to now and posed into the world every step, so your car collides with where
 *   it really is rather than where it was 100 ms ago.
 * - **Bumps are split.** You move only your own car, and send the other car's
 *   share to its owner, who applies it unless it already felt the contact itself.
 * - **The host owns the race:** phase, grid, GO, and the finish order (by the
 *   finishers' own time stamps, not by when their messages arrived), plus the
 *   bots, which it drives and publishes like any other car.
 *
 * Failover: every client keeps the last heartbeat. A promoted host adopts the
 * race from it, takes the bots over from their dead-reckoned positions, and
 * carries on — the clock sync keeps GO meaning the same instant.
 */
export class NetRace {
    room;
    sync;
    events = new Emitter();
    playerId;
    world = null;
    /** This client's car in the current race, or null when spectating. */
    me = null;
    /** The room and race as this client understands it. */
    state = { ...LOBBY_STATE };
    /** What drives this client's own car. The session sets it (input, or the autopilot). */
    drive = () => IDLE_INTENT;
    /** How good the bots this client drives are, as host: its own Settings. */
    botLevel = 'expert';
    net;
    clock;
    tracks;
    /** The cars this client drives: its own, and the bots while it is host. */
    publisher;
    /** Everybody else's cars. */
    fleet;
    director = new HostDirector();
    unsubs = [];
    lastUpdate = 0;
    /** Room time at world time 0, ms. */
    worldZero = 0;
    raceGoAt = 0;
    resultsSent = false;
    started = false;
    constructor(opts) {
        this.net = opts.transport;
        this.clock = opts.clock;
        this.tracks = opts.tracks;
        this.playerId = opts.playerId;
        this.room = new RoomSession(opts.transport, opts.clock, opts.roomId, opts.playerId, opts.name, opts.colour, opts.ver);
        this.sync = new ClockSync(opts.transport, opts.clock, opts.roomId, opts.playerId);
        this.room.roomNow = () => this.sync.now();
        this.room.stateProvider = () => this.state;
        this.publisher = new CarPublisher(opts.transport, opts.clock, Topics.cars(opts.roomId, opts.playerId), opts.playerId);
        const self = this;
        this.fleet = new RemoteFleet(opts.clock, {
            get world() { return self.world; },
            get grid() { return self.state.grid; },
            get isHost() { return self.isHost; },
            roomNow: () => this.roomNow,
            owned: (id) => this.publisher.entrant(id),
            finished: (id, t) => this.director.finished(id, t),
            cooledDown: (id) => this.director.cooledDown(id),
        });
    }
    get isHost() {
        return this.room.isHost;
    }
    get roomNow() {
        return this.sync.now();
    }
    get phase() {
        return this.state.phase;
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        const r = this.room.roomId;
        this.unsubs.push(this.net.subscribe(Topics.carsAll(r), (topic, payload) => this.fleet.receive(segment(topic, 0), payload)));
        this.room.events.on('heartbeat', ({ hb }) => {
            if (this.isHost)
                return;
            const { hostId: _h, seq: _s, roomT: _t, ...state } = hb;
            this.apply(state);
        });
        this.room.events.on('hostChange', ({ isHost }) => this.onHostChange(isHost));
        this.room.events.on('roster', ({ peers }) => {
            this.events.emit('roster', { peers });
            this.events.emit('state', { state: this.state });
        });
        this.room.events.on('roomFull', (e) => this.events.emit('roomFull', e));
        this.sync.start();
        this.room.join();
        this.lastUpdate = this.clock.now();
    }
    stop() {
        if (!this.started)
            return;
        this.started = false;
        this.endRace();
        this.room.leave();
        this.sync.stop();
        for (const u of this.unsubs)
            u();
        this.unsubs = [];
    }
    /* ------------------------------------------------------------ the lobby */
    /** Host: change the lobby settings (cars on the grid, laps). */
    configure(cars, laps, track = this.state.track, seed = this.state.seed, arms = this.state.arms) {
        if (!this.isHost || this.state.phase !== 'L')
            return;
        track = Math.max(0, Math.min(this.tracks.length - 1, Math.round(track) || 0));
        this.state = {
            ...this.state, cars: Math.max(1, Math.min(6, cars)), laps: Math.max(1, Math.min(9, laps)), track,
            seed: seed >>> 0, arms: arms ? 1 : 0,
        };
        this.room.beatNow();
        this.events.emit('state', { state: this.state });
    }
    /** Host: freeze the grid and start the countdown. */
    startRace() {
        if (!this.isHost || this.state.phase !== 'L')
            return;
        this.launch();
    }
    /**
     * Host: another race from the results, on the same track with the same
     * settings, without the trip back to the lobby. Whoever is in the room now
     * is on the grid, like any start.
     */
    rematch() {
        if (!this.isHost || this.state.phase !== 'X')
            return;
        this.launch();
    }
    launch() {
        const humans = this.room.aliveIds.slice(0, NET.maxPlayers);
        const grid = [...humans];
        for (let slot = grid.length; slot < Math.max(this.state.cars, humans.length); slot++)
            grid.push(`b${slot}`);
        this.director.reset();
        this.setState({ ...this.state, phase: 'C', goAt: Math.round(this.roomNow + NET.countdownMs), grid, finish: [] });
    }
    /** Name and resolved colour for every car on the grid (or in the room, in the lobby). */
    carInfo(id) {
        const you = id === this.playerId;
        const colours = this.room.resolvedColours();
        if (isBotId(id)) {
            const slot = Number(id.slice(1));
            // Bots take the colours nobody human is wearing, in palette order.
            const taken = new Set(Object.values(colours));
            const free = COLOUR_ORDER.filter((c) => !taken.has(c));
            const bots = this.state.grid.filter(isBotId);
            const k = Math.max(0, bots.indexOf(id));
            // Dressed from the room and the slot, which every client knows.
            const look = botLook(hashString(`${this.room.roomId}:${id}`));
            return { id, name: botNames(hashString(`${this.room.roomId}:names`), slot + 1)[slot], colour: free[k % free.length] ?? DEFAULT_COLOUR, bot: true, you: false, look };
        }
        const peer = this.room.peers.get(id);
        const look = decodeLook(you ? this.room.look : peer?.look);
        return { id, name: you ? this.room.displayName : (peer?.name ?? '—'), colour: colours[id] ?? DEFAULT_COLOUR, bot: false, you, look };
    }
    /* -------------------------------------------------------------- update */
    /** When `update` last ran, clock ms: the page's ticker drives it when nothing else has. */
    get lastUpdateAt() {
        return this.lastUpdate;
    }
    /**
     * Drive everything: the world, publishing, and (as host) the race director.
     * Call every frame, or every tick while the tab is hidden.
     *
     * @returns render interpolation alpha for the world, as `World.advance`
     */
    update() {
        if (!this.started)
            return 0;
        this.lastUpdate = this.clock.now();
        if (this.isHost) {
            const next = this.director.next(this.state, this.roomNow, new Set(this.room.aliveIds));
            if (next)
                this.setState(next);
        }
        const w = this.world;
        if (!w)
            return 0;
        // The world keeps to the room clock, not to this tab's frames. Stepping by
        // frame time with the stall clamp, a tab lost a quarter of a second or more
        // on every long frame (building the scene at the start, a hitch) and never
        // made it up. Its car packets are stamped in world time, so everyone else
        // saw them arrive already old, past the 0.3 s the dead reckoning will
        // extrapolate: every remote car stood still between packets and jumped at
        // each one, twenty times a second. Found in play; a host measured 4.5 s behind.
        const alpha = w.advanceTo((this.roomNow - this.worldZero) / 1000, 5);
        for (const ev of w.drain())
            this.onWorldEvent(ev);
        this.publisher.publish(w, this.roomAt(w.time), (id) => !this.isHost && !this.state.finish.some((f) => this.state.grid[f.slot] === id));
        return alpha;
    }
    /** Room time at a world time, ms. */
    roomAt(worldTime) {
        return this.worldZero + worldTime * 1000;
    }
    /* ------------------------------------------------------ host director */
    setState(next) {
        if (next.phase !== this.state.phase)
            this.director.phaseChanged(this.roomNow);
        this.state = next;
        this.apply(next);
        this.room.beatNow();
    }
    onHostChange(isHost) {
        this.sync.setHost(isHost);
        if (isHost) {
            // Adopt the room as the last heartbeat described it — a race in
            // progress carries on rather than ending with its host.
            const hb = this.room.lastHeartbeat;
            if (hb) {
                const { hostId: _h, seq: _s, roomT: _t, ...state } = hb;
                this.state = state;
                this.director.adopt(state, this.roomNow);
            }
            else {
                this.director.phaseChanged(this.roomNow);
            }
            this.adoptBots();
            this.apply(this.state);
            this.room.beatNow();
        }
        else {
            this.releaseBots();
        }
        this.events.emit('hostChange', { isHost });
        this.events.emit('state', { state: this.state });
    }
    /** New host: the bots it was watching become bots it drives, from where they are. */
    adoptBots() {
        const w = this.world;
        if (!w)
            return;
        const line = racingLine(w.track);
        for (const e of w.entrants) {
            if (!e.remote || !isBotId(e.id))
                continue;
            const slot = Number(e.id.slice(1));
            const pilot = createAutopilot(hashString(`${this.raceGoAt}:${e.id}`), skillFor(slot, this.botLevel));
            e.remote = false;
            e.drive = () => autopilot(pilot, e.car, w.track, line, w.rivalsOf(e.id), w.time, STEP, w.stopLine(e));
            // Its lap count came from its packets; checkpoints are inferred from where it is.
            e.lap.s = e.s;
            e.lap.nextCp = e.lap.completed < 0 ? w.track.checkpoints.length : w.track.checkpoints.filter((c) => c < e.s).length;
            e.safeS = e.s;
            // Carry on the bot's shot numbering: reusing a number would make its
            // next mine look like one everybody already has.
            e.seq = Math.max(e.seq, this.fleet.lastSeq(e.id));
            // And its wreck count, which is how a repeated wreck is told from a new one.
            e.wrecks = Math.max(e.wrecks, this.fleet.lastWreck(e.id));
            this.publisher.own(e);
            this.fleet.forget(e.id);
        }
    }
    /** No longer host (a split healed): stop driving the bots and watch them instead. */
    releaseBots() {
        const w = this.world;
        if (!w)
            return;
        for (const id of this.publisher.ids()) {
            const e = this.publisher.entrant(id);
            if (id === this.playerId)
                continue;
            e.remote = true;
            e.drive = () => IDLE_INTENT;
            this.publisher.release(id);
        }
    }
    /* --------------------------------------------------- following the room */
    /** Bring this client's world in line with a room state (the host's own, or a heartbeat). */
    apply(next) {
        const prevPhase = this.state.phase;
        this.state = next;
        const racing = next.phase !== 'L' && next.goAt > 0 && next.grid.length > 0;
        if (racing && next.goAt !== this.raceGoAt)
            this.beginRace(next);
        if (!racing && this.world)
            this.endRace();
        if (this.world) {
            // Finishers as the host decided them.
            const w = this.world;
            for (const f of next.finish) {
                const id = next.grid[f.slot];
                const e = id ? w.entrants.find((x) => x.id === id) : undefined;
                if (!e)
                    continue;
                e.lap.finished = true;
                e.lap.finishTime = w.goTime + f.t / 1000;
            }
        }
        if (next.phase === 'X' && !this.resultsSent && this.world) {
            this.resultsSent = true;
            this.events.emit('results', { rows: this.results() });
        }
        if (prevPhase !== next.phase || !racing)
            this.events.emit('state', { state: next });
    }
    beginRace(s) {
        this.endRace();
        const def = s.seed ? generateTrack(s.seed) : (this.tracks[s.track] ?? this.tracks[0]);
        const now = this.roomNow;
        const countdown = Math.max(0, (s.goAt - now) / 1000);
        // A late arrival (a failover, or a spectator) starts its world part-way
        // through, so world time and room time still line up.
        const elapsed = Math.max(0, (now - s.goAt) / 1000);
        const w = new World(def, { laps: s.laps, countdown, elapsed, weapons: s.arms !== 0 });
        this.worldZero = s.goAt - w.goTime * 1000;
        this.raceGoAt = s.goAt;
        this.resultsSent = false;
        this.fleet.reset();
        const line = racingLine(w.track);
        s.grid.forEach((id, slot) => {
            if (id === this.playerId) {
                const e = w.addCar(id, slot, () => this.drive());
                this.me = e;
                this.publisher.own(e);
            }
            else if (isBotId(id) && this.isHost) {
                const pilot = createAutopilot(hashString(`${s.goAt}:${id}`), skillFor(slot, this.botLevel));
                const e = w.addCar(id, slot, () => IDLE_INTENT);
                e.drive = () => autopilot(pilot, e.car, w.track, line, w.rivalsOf(id), w.time, STEP, w.stopLine(e));
                this.publisher.own(e);
            }
            else {
                this.fleet.watch(w.addRemote(id, slot), s.goAt);
            }
        });
        w.onStep = (end) => this.fleet.pose(w, this.roomAt(end));
        this.world = w;
        this.events.emit('raceStart', { world: w, spectating: this.me === null });
    }
    endRace() {
        if (!this.world)
            return;
        this.world = null;
        this.me = null;
        this.publisher.clear();
        this.fleet.reset();
        this.raceGoAt = 0;
        this.events.emit('raceEnd', {});
    }
    /** Current race order, finish times from GO. */
    results() {
        const w = this.world;
        if (!w)
            return [];
        return standings(w.entrants).map((e, i) => ({
            position: i + 1,
            id: e.id,
            time: e.lap.finishTime === null ? null : e.lap.finishTime - w.goTime,
            laps: Math.max(0, e.lap.completed),
        }));
    }
    /* ----------------------------------------------------------- publishing */
    onWorldEvent(ev) {
        const w = this.world;
        const toMs = (t) => Math.round((t - w.goTime) * 1000);
        if (ev.kind === 'lap') {
            this.publisher.say(ev.id, { k: 'lap', lap: ev.lap, t: toMs(ev.time) });
        }
        else if (ev.kind === 'finish') {
            this.publisher.say(ev.id, { k: 'finish', t: toMs(ev.time) });
            if (this.isHost && this.publisher.owns(ev.id))
                this.director.finished(ev.id, toMs(ev.time));
        }
        else if (ev.kind === 'respawn') {
            const c = this.publisher.entrant(ev.id)?.car;
            if (c)
                this.publisher.say(ev.id, { k: 'respawn', x: c.x, z: c.z, yaw: c.yaw });
        }
        else if (ev.kind === 'cooldown') {
            this.publisher.say(ev.id, { k: 'cooldown' });
            if (this.isHost && this.publisher.owns(ev.id))
                this.director.cooledDown(ev.id);
        }
        else if (ev.kind === 'fire') {
            this.publisher.say(ev.id, { k: 'fire', seq: ev.seq, weapon: ev.weapon === 'rear' ? 1 : 0, x: ev.x, z: ev.z, yaw: ev.yaw, t: toMs(ev.time) });
        }
        else if (ev.kind === 'mine') {
            this.publisher.say(ev.id, { k: 'mine', seq: ev.seq, x: ev.x, z: ev.z, t: toMs(ev.time) });
        }
        else if (ev.kind === 'hit') {
            const slot = this.state.grid.indexOf(ev.id);
            if (ev.weapon === 'mine') {
                // The victim reports a mine it drove over, so every screen clears it.
                const ownerSlot = this.state.grid.indexOf(ev.by);
                if (ownerSlot >= 0)
                    this.publisher.say(ev.id, { k: 'trigger', slot: ownerSlot, seq: ev.seq });
            }
            else if (slot >= 0) {
                // The shooter reports every hit its own shots make — on a remote car
                // for its owner to apply, on one of its own so the others see it land.
                this.publisher.say(ev.by, { k: 'hit', seq: ev.seq, slot, weapon: ev.weapon === 'rear' ? 1 : 0, dmg: Math.round(ev.damage), x: ev.x, z: ev.z });
            }
        }
        else if (ev.kind === 'wreck') {
            const e = this.publisher.entrant(ev.id);
            if (e)
                this.publisher.say(ev.id, { k: 'wreck', slot: ev.by ? this.state.grid.indexOf(ev.by) : -1, n: e.wrecks });
        }
        else if (ev.kind === 'bump' && ev.remote) {
            const slot = this.state.grid.indexOf(ev.remote);
            if (slot >= 0)
                this.publisher.say(ev.remote === ev.a ? ev.b : ev.a, { k: 'bump', slot, dvx: ev.dvx, dvz: ev.dvz });
        }
        this.events.emit('race', { ev });
    }
}
//# sourceMappingURL=NetRace.js.map