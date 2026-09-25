import { NET, STEP } from '../config.js';
import { createAutopilot, autopilot, skillFor } from '../sim/autopilot.js';
import { botNames } from '../sim/bots.js';
import { COLOUR_ORDER, DEFAULT_COLOUR } from '../sim/palette.js';
import { standings } from '../sim/race.js';
import { generateTrack } from '../sim/track/generate.js';
import { botLook, decodeLook } from '../sim/look.js';
import { racingLine } from '../sim/racingLine.js';
import { World } from '../sim/World.js';
import { IDLE_INTENT } from '../types.js';
import { Emitter, hashString } from '../util.js';
import { ClockSync } from './ClockSync.js';
import { CAR_FLAG, decodeCar, decodeEvents, encodeCar, encodeEvents } from './codec.js';
import { RemoteCar } from './deadReckoning.js';
import { LOBBY_STATE, RoomSession } from './RoomSession.js';
import { Topics, segment } from './topics.js';
/**
 * One client's view of a networked room and its races — the whole of M3's
 * networking, with no renderer and no DOM, so the Node tests can run a room of
 * six clients through a race, a failover and a frozen tab in milliseconds.
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
    remotes = new Map();
    owned = new Map();
    unsubs = [];
    lastUpdate = 0;
    /** Room time at world time 0, ms. */
    worldZero = 0;
    raceGoAt = 0;
    resultsSent = false;
    /** Host only: finish stamps in race ms, by car id. */
    finishes = new Map();
    /** Host only: cars that have driven their cool-down lap. The first ends the race. */
    cooled = new Set();
    phaseSince = 0;
    started = false;
    /** Hits this client has already taken, keyed `shooter:seq`, so a repeated `H` never hurts twice. */
    taken = new Set();
    /** Highest shot/mine counter seen from each car, so a host adopting a bot carries on from it. */
    lastSeq = new Map();
    constructor(opts) {
        this.net = opts.transport;
        this.clock = opts.clock;
        this.tracks = opts.tracks;
        this.playerId = opts.playerId;
        this.room = new RoomSession(opts.transport, opts.clock, opts.roomId, opts.playerId, opts.name, opts.colour, opts.ver);
        this.sync = new ClockSync(opts.transport, opts.clock, opts.roomId, opts.playerId);
        this.room.roomNow = () => this.sync.now();
        this.room.stateProvider = () => this.state;
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
        this.unsubs.push(this.net.subscribe(Topics.carStateAll(r), (topic, payload) => this.onCarState(segment(topic, 0), payload)), this.net.subscribe(Topics.carEventsAll(r), (topic, payload) => this.onCarEvents(segment(topic, 0), payload)));
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
        const humans = this.room.aliveIds.slice(0, NET.maxPlayers);
        const grid = [...humans];
        for (let slot = grid.length; slot < Math.max(this.state.cars, humans.length); slot++)
            grid.push(`b${slot}`);
        this.finishes.clear();
        this.cooled.clear();
        this.setState({ ...this.state, phase: 'C', goAt: Math.round(this.roomNow + NET.countdownMs), grid, finish: [] });
    }
    /** Name and resolved colour for every car on the grid (or in the room, in the lobby). */
    carInfo(id) {
        const you = id === this.playerId;
        const colours = this.room.resolvedColours();
        if (/^b\d+$/.test(id)) {
            const slot = Number(id.slice(1));
            // Bots take the colours nobody human is wearing, in palette order.
            const taken = new Set(Object.values(colours));
            const free = COLOUR_ORDER.filter((c) => !taken.has(c));
            const bots = this.state.grid.filter((g) => /^b\d+$/.test(g));
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
    /**
     * Drive everything: the world, publishing, and (as host) the race director.
     * Call every frame, or every tick while the tab is hidden.
     *
     * @returns render interpolation alpha for the world, as `World.advance`
     */
    update() {
        if (!this.started)
            return 0;
        const now = this.clock.now();
        const dt = Math.max(0, (now - this.lastUpdate) / 1000);
        this.lastUpdate = now;
        if (this.isHost)
            this.direct();
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
        void dt;
        const alpha = w.advanceTo((this.roomNow - this.worldZero) / 1000, 5);
        for (const ev of w.drain())
            this.onWorldEvent(ev);
        this.publishOwned();
        return alpha;
    }
    /** Room time at a world time, ms. */
    roomAt(worldTime) {
        return this.worldZero + worldTime * 1000;
    }
    /* ------------------------------------------------------ host director */
    setState(next) {
        const phaseChanged = next.phase !== this.state.phase;
        this.state = next;
        if (phaseChanged)
            this.phaseSince = this.roomNow;
        this.apply(next);
        this.room.beatNow();
    }
    /** The host's race director: move the phase on when its time comes. */
    direct() {
        const s = this.state;
        const now = this.roomNow;
        if (s.phase === 'C' && now >= s.goAt) {
            this.setState({ ...s, phase: 'R' });
            return;
        }
        if (s.phase === 'R' || s.phase === 'F') {
            const finish = [...this.finishes.entries()]
                .map(([id, t]) => ({ slot: s.grid.indexOf(id), t }))
                .filter((f) => f.slot >= 0)
                .sort((a, b) => a.t - b.t || a.slot - b.slot);
            const changed = finish.length !== s.finish.length;
            // Still racing: every bot, and every human still in the room.
            const alive = new Set(this.room.aliveIds);
            const running = s.grid.filter((id, slot) => (id.startsWith('b') || alive.has(id)) && !finish.some((f) => f.slot === slot));
            const first = finish[0];
            const graceUp = first !== undefined && now >= s.goAt + first.t + NET.finishGraceMs;
            // Whichever comes first: all home, someone's cool-down lap done, or the grace after the first finish.
            if (running.length === 0 || graceUp || this.cooled.size > 0) {
                this.setState({ ...s, finish, phase: 'X' });
            }
            else if (changed) {
                this.setState({ ...s, finish, phase: 'F' });
            }
            return;
        }
        if (s.phase === 'X' && now - this.phaseSince >= NET.resultsMs) {
            this.finishes.clear();
            this.cooled.clear();
            this.setState({ ...s, phase: 'L', goAt: 0, grid: [], finish: [] });
        }
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
                this.finishes.clear();
                this.cooled.clear();
                for (const f of state.finish) {
                    const id = state.grid[f.slot];
                    if (id)
                        this.finishes.set(id, f.t);
                }
            }
            this.phaseSince = this.roomNow;
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
            if (!e.remote || !/^b\d+$/.test(e.id))
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
            e.seq = Math.max(e.seq, this.lastSeq.get(e.id) ?? 0);
            this.owned.set(e.id, { entrant: e, last: null, lastSentAt: 0, nextAt: 0, pending: [], lastFlushAt: 0 });
            this.remotes.delete(e.id);
        }
    }
    /** No longer host (a split healed): stop driving the bots and watch them instead. */
    releaseBots() {
        const w = this.world;
        if (!w)
            return;
        for (const [id, o] of this.owned) {
            if (id === this.playerId)
                continue;
            o.entrant.remote = true;
            o.entrant.drive = () => IDLE_INTENT;
            this.owned.delete(id);
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
        this.taken.clear();
        this.lastSeq.clear();
        const line = racingLine(w.track);
        s.grid.forEach((id, slot) => {
            if (id === this.playerId) {
                const e = w.addCar(id, slot, () => this.drive());
                this.me = e;
                this.owned.set(id, { entrant: e, last: null, lastSentAt: 0, nextAt: 0, pending: [], lastFlushAt: 0 });
            }
            else if (/^b\d+$/.test(id) && this.isHost) {
                const pilot = createAutopilot(hashString(`${s.goAt}:${id}`), skillFor(slot, this.botLevel));
                const e = w.addCar(id, slot, () => IDLE_INTENT);
                e.drive = () => autopilot(pilot, e.car, w.track, line, w.rivalsOf(id), w.time, STEP, w.stopLine(e));
                this.owned.set(id, { entrant: e, last: null, lastSentAt: 0, nextAt: 0, pending: [], lastFlushAt: 0 });
            }
            else {
                const e = w.addRemote(id, slot);
                const rc = this.remotes.get(id) ?? new RemoteCar();
                // Until its first packet, a remote car sits where the grid put it.
                rc.receive(this.packetFrom(e, s.goAt - 1e6), now, this.clock.now(), true);
                this.remotes.set(id, rc);
            }
        });
        w.onStep = (end) => this.poseRemotes(end);
        this.world = w;
        this.events.emit('raceStart', { world: w, spectating: this.me === null });
    }
    endRace() {
        if (!this.world)
            return;
        this.world = null;
        this.me = null;
        this.owned.clear();
        this.remotes.clear();
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
    /* ------------------------------------------------------------ remotes */
    poseRemotes(endWorldTime) {
        const w = this.world;
        if (!w)
            return;
        const at = this.roomAt(endWorldTime);
        const L = w.track.length;
        for (const e of w.entrants) {
            if (!e.remote)
                continue;
            const rc = this.remotes.get(e.id);
            const p = rc?.packet;
            if (!rc || !p)
                continue;
            const pose = rc.display(at);
            const c = e.car;
            c.x = pose.x;
            c.z = pose.z;
            c.yaw = pose.yaw;
            c.vx = pose.vx;
            c.vz = pose.vz;
            c.y = pose.y;
            c.w = p.w;
            c.steer = p.steer;
            c.forward = pose.vx * Math.sin(pose.yaw) + pose.vz * Math.cos(pose.yaw);
            c.airborne = (p.flags & CAR_FLAG.airborne) !== 0;
            c.drifting = (p.flags & CAR_FLAG.drift) !== 0;
            c.braking = (p.flags & CAR_FLAG.brake) !== 0;
            c.handbrake = (p.flags & CAR_FLAG.handbrake) !== 0;
            c.boosting = (p.flags & CAR_FLAG.boost) !== 0;
            e.ghost = (p.flags & CAR_FLAG.ghost) !== 0 ? 0.1 : 0;
            e.wrecked = (p.flags & CAR_FLAG.wrecked) !== 0 ? 0.1 : 0;
            e.hp = p.hp;
            // Its lap count is its owner's word; distance is ours to compute.
            e.lap.completed = p.lap;
            e.lap.s = p.s;
            e.lap.progress = p.lap < 0 ? p.s - L : p.lap * L + p.s;
        }
    }
    packetFrom(e, t) {
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
    onCarState(id, payload) {
        if (!this.world || this.owned.has(id))
            return;
        const p = decodeCar(payload, this.roomNow);
        if (!p)
            return;
        let rc = this.remotes.get(id);
        if (!rc) {
            // A car we did not know was on the grid (a spectator's first packets).
            if (!this.world.entrants.some((e) => e.id === id))
                return;
            rc = new RemoteCar();
            this.remotes.set(id, rc);
        }
        rc.receive(p, this.roomNow, this.clock.now());
    }
    onCarEvents(id, payload) {
        if (this.owned.has(id))
            return;
        const w = this.world;
        for (const ev of decodeEvents(payload)) {
            if (ev.k === 'finish') {
                if (this.isHost)
                    this.finishes.set(id, ev.t);
            }
            else if (ev.k === 'cooldown') {
                if (this.isHost)
                    this.cooled.add(id);
            }
            else if (ev.k === 'respawn' && w) {
                const rc = this.remotes.get(id);
                const e = w.entrants.find((x) => x.id === id);
                if (rc && e) {
                    // A teleport: snap, do not slide the car back along the track.
                    const p = { ...(rc.packet ?? this.packetFrom(e, this.roomNow)), x: ev.x, z: ev.z, yaw: ev.yaw, vx: 0, vz: 0, w: 0, t: this.roomNow };
                    rc.receive(p, this.roomNow, this.clock.now(), true);
                }
            }
            else if (ev.k === 'bump' && w) {
                const target = this.state.grid[ev.slot];
                const o = target ? this.owned.get(target) : undefined;
                // Felt it ourselves already? Then our own resolution stands.
                if (o && !w.touchedRecently(target, id, 0.2)) {
                    o.entrant.car.vx += ev.dvx;
                    o.entrant.car.vz += ev.dvz;
                }
            }
            else if (w) {
                this.onWeaponEvent(w, id, ev);
            }
        }
    }
    /**
     * Somebody else's weapons (§5.4). Their shots and mines are copied into this
     * world as scenery; their hits are applied here only if the victim is a car
     * this client drives, once per shot however often the message is repeated.
     */
    onWeaponEvent(w, id, ev) {
        const time = (ms) => w.goTime + ms / 1000;
        if (ev.k === 'fire' || ev.k === 'mine') {
            this.lastSeq.set(id, Math.max(this.lastSeq.get(id) ?? 0, ev.seq));
        }
        if (ev.k === 'fire') {
            if (w.armoury.findMissile(id, ev.seq))
                return;
            // Fired a moment ago on the shooter's screen: the flight is a function
            // of time, so spawning it late puts it exactly where it now is.
            w.armoury.launch(id, ev.seq, ev.weapon === 1 ? 'rear' : 'front', ev.x, ev.z, ev.yaw, time(ev.t), false);
            w.announce({ kind: 'fire', id, seq: ev.seq, weapon: ev.weapon === 1 ? 'rear' : 'front', x: ev.x, z: ev.z, yaw: ev.yaw, time: time(ev.t) });
        }
        else if (ev.k === 'mine') {
            if (w.armoury.findMine(id, ev.seq))
                return;
            w.armoury.place(id, ev.seq, ev.x, ev.z, time(ev.t));
            w.announce({ kind: 'mine', id, seq: ev.seq, x: ev.x, z: ev.z, time: time(ev.t) });
        }
        else if (ev.k === 'hit') {
            const victim = this.state.grid[ev.slot];
            if (!victim)
                return;
            const m = w.armoury.findMissile(id, ev.seq);
            const key = `${id}:${ev.seq}`;
            const mine = this.owned.has(victim);
            if (mine && this.taken.has(key))
                return;
            if (mine)
                this.taken.add(key);
            w.hit(victim, id, ev.seq, ev.weapon === 1 ? 'rear' : 'front', ev.dmg, ev.x, ev.z);
            if (m)
                m.done = true;
        }
        else if (ev.k === 'trigger') {
            const owner = this.state.grid[ev.slot];
            const m = owner ? w.armoury.findMine(owner, ev.seq) : undefined;
            if (!owner || !m || m.done)
                return;
            m.done = true;
            w.hit(id, owner, ev.seq, 'mine', 0, m.x, m.z);
        }
        else if (ev.k === 'wreck') {
            const by = ev.slot >= 0 ? (this.state.grid[ev.slot] ?? null) : null;
            w.creditWreck(id, by);
        }
    }
    /* ----------------------------------------------------------- publishing */
    onWorldEvent(ev) {
        const w = this.world;
        const toMs = (t) => Math.round((t - w.goTime) * 1000);
        if (ev.kind === 'lap' || ev.kind === 'finish' || ev.kind === 'respawn' || ev.kind === 'cooldown') {
            const o = this.owned.get(ev.id);
            if (o) {
                if (ev.kind === 'lap')
                    o.pending.push({ k: 'lap', lap: ev.lap, t: toMs(ev.time) });
                if (ev.kind === 'finish') {
                    o.pending.push({ k: 'finish', t: toMs(ev.time) });
                    if (this.isHost)
                        this.finishes.set(ev.id, toMs(ev.time));
                }
                if (ev.kind === 'respawn')
                    o.pending.push({ k: 'respawn', x: o.entrant.car.x, z: o.entrant.car.z, yaw: o.entrant.car.yaw });
                if (ev.kind === 'cooldown') {
                    o.pending.push({ k: 'cooldown' });
                    if (this.isHost)
                        this.cooled.add(ev.id);
                }
            }
        }
        else if (ev.kind === 'fire' || ev.kind === 'mine') {
            const o = this.owned.get(ev.id);
            if (o && ev.kind === 'fire') {
                o.pending.push({ k: 'fire', seq: ev.seq, weapon: ev.weapon === 'rear' ? 1 : 0, x: ev.x, z: ev.z, yaw: ev.yaw, t: toMs(ev.time) });
            }
            else if (o && ev.kind === 'mine') {
                o.pending.push({ k: 'mine', seq: ev.seq, x: ev.x, z: ev.z, t: toMs(ev.time) });
            }
            this.flushSoon(o);
        }
        else if (ev.kind === 'hit') {
            const slot = this.state.grid.indexOf(ev.id);
            if (ev.weapon === 'mine') {
                // The victim reports a mine it drove over, so every screen clears it.
                const o = this.owned.get(ev.id);
                const ownerSlot = this.state.grid.indexOf(ev.by);
                if (o && ownerSlot >= 0)
                    o.pending.push({ k: 'trigger', slot: ownerSlot, seq: ev.seq });
                this.flushSoon(o);
            }
            else {
                // The shooter reports every hit its own shots make — on a remote car
                // for its owner to apply, on one of its own so the others see it land.
                const o = this.owned.get(ev.by);
                if (o && slot >= 0) {
                    o.pending.push({ k: 'hit', seq: ev.seq, slot, weapon: ev.weapon === 'rear' ? 1 : 0, dmg: Math.round(ev.damage), x: ev.x, z: ev.z });
                }
                this.flushSoon(o);
            }
        }
        else if (ev.kind === 'wreck') {
            const o = this.owned.get(ev.id);
            if (o)
                o.pending.push({ k: 'wreck', slot: ev.by ? this.state.grid.indexOf(ev.by) : -1 });
        }
        else if (ev.kind === 'bump' && ev.remote) {
            const local = ev.remote === ev.a ? ev.b : ev.a;
            const o = this.owned.get(local);
            const slot = this.state.grid.indexOf(ev.remote);
            if (o && slot >= 0)
                o.pending.push({ k: 'bump', slot, dvx: ev.dvx, dvz: ev.dvz });
        }
        this.events.emit('race', { ev });
    }
    /**
     * Weapons go out on the next update rather than waiting out the event
     * batching interval: a shot is worth its 50 ms.
     */
    flushSoon(o) {
        if (o)
            o.lastFlushAt = -Infinity;
    }
    publishOwned() {
        const w = this.world;
        if (!w)
            return;
        const now = this.clock.now();
        const stamp = this.roomAt(w.time);
        const minGap = 1000 / NET.carMaxHz;
        const every = 1000 / NET.carHz;
        for (const o of this.owned.values()) {
            const e = o.entrant;
            // A schedule, not "is it 50 ms since the last one?": checked once a
            // frame, that waits for the frame *after* 50 ms, and on 16 ms frames
            // quietly sends every 64 ms — 15.6 Hz, not 20.
            const since = now - o.lastSentAt;
            let send = now >= o.nextAt;
            if (!send && since >= minGap && o.last) {
                // Would a peer drawing our last packet have us in the wrong place by now?
                const err = RemoteCar.error(o.last, (stamp - o.last.t) / 1000, e.car.x, e.car.z, e.car.yaw);
                const flags = this.packetFrom(e, stamp).flags;
                send = err.pos > NET.drPositionError || err.yaw > NET.drYawError || flags !== o.last.flags;
            }
            if (send) {
                const p = this.packetFrom(e, stamp);
                this.net.publish(Topics.carState(this.room.roomId, e.id), encodeCar(p));
                o.last = p;
                o.lastSentAt = now;
                // Catch up by at most one period after a stall rather than bursting.
                o.nextAt = Math.max(o.nextAt + every, now - every / 2);
                if (o.nextAt <= now)
                    o.nextAt = now + every;
            }
            if (o.pending.length && now - o.lastFlushAt >= NET.eventFlushMs) {
                this.net.publish(Topics.carEvents(this.room.roomId, e.id), encodeEvents(o.pending));
                o.pending = [];
                o.lastFlushAt = now;
            }
        }
    }
}
//# sourceMappingURL=NetRace.js.map