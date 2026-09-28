import { packetOf } from './CarPublisher.js';
import { CAR_FLAG, decodeCars } from './codec.js';
import { RemoteCar } from './deadReckoning.js';
/**
 * Everybody else's cars, as this client hears and shows them.
 *
 * Each is a `RemoteCar`, extrapolated to now and posed into the world every
 * step, so our cars collide with where it really is rather than where it was
 * 100 ms ago. Their events — shots, mines, hits, bumps, finishes — are acted
 * on here once each, however often the sender repeats them.
 */
export class RemoteFleet {
    clock;
    race;
    cars = new Map();
    /** Events already acted on, so a repeat never fires, hurts or credits twice. */
    heard = new Set();
    /** Highest shot/mine counter seen from each car, so a host adopting a bot carries on from it. */
    seqs = new Map();
    /** Highest wreck count seen from each car, for the same reason. */
    wrecks = new Map();
    constructor(clock, race) {
        this.clock = clock;
        this.race = race;
    }
    /** A new race: nobody heard from yet. */
    reset() {
        this.cars.clear();
        this.heard.clear();
        this.seqs.clear();
        this.wrecks.clear();
    }
    /** Watch a car on the grid; until its first packet it sits where the grid put it. */
    watch(e, goAt) {
        const rc = this.cars.get(e.id) ?? new RemoteCar();
        rc.receive(packetOf(e, goAt - 1e6), this.race.roomNow(), this.clock.now(), true);
        this.cars.set(e.id, rc);
    }
    /** Stop watching a car: this client drives it now. */
    forget(id) {
        this.cars.delete(id);
    }
    /** The highest shot or mine number heard from this car. */
    lastSeq(id) {
        return this.seqs.get(id) ?? 0;
    }
    /** The highest wreck count heard from this car. */
    lastWreck(id) {
        return this.wrecks.get(id) ?? 0;
    }
    /** One client's car message: each car's state, then the events riding with it. */
    receive(publisher, payload) {
        if (!this.race.world)
            return;
        const now = this.race.roomNow();
        for (const r of decodeCars(publisher, payload, now)) {
            if (this.race.owned(r.id))
                continue;
            this.onState(r.id, r.car);
            if (r.events.length)
                this.onEvents(r.id, r.events);
        }
    }
    /** Put every remote car where it is at world time `end` (room time `at`, ms). */
    pose(w, at) {
        const L = w.track.length;
        for (const e of w.entrants) {
            if (!e.remote)
                continue;
            const rc = this.cars.get(e.id);
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
    onState(id, p) {
        let rc = this.cars.get(id);
        if (!rc) {
            // A car we did not know was on the grid (a spectator's first packets).
            if (!this.race.world?.entrants.some((e) => e.id === id))
                return;
            rc = new RemoteCar();
            this.cars.set(id, rc);
        }
        rc.receive(p, this.race.roomNow(), this.clock.now());
    }
    /** The key a repeated event is recognised by, or null for one that is safe to act on twice. */
    static once(id, ev) {
        switch (ev.k) {
            case 'fire':
            case 'mine':
                return `s:${id}:${ev.seq}`;
            case 'hit':
                return `h:${id}:${ev.seq}`;
            case 'trigger':
                return `t:${id}:${ev.slot}:${ev.seq}`;
            case 'wreck':
                return `w:${id}:${ev.n}`;
            case 'pick':
                return `p:${id}:${ev.i}:${ev.t}`;
            default:
                return null;
        }
    }
    onEvents(id, events) {
        const race = this.race;
        const w = race.world;
        if (!w)
            return;
        for (const ev of events) {
            const key = RemoteFleet.once(id, ev);
            if (key !== null) {
                if (this.heard.has(key))
                    continue;
                this.heard.add(key);
            }
            if (ev.k === 'finish') {
                if (race.isHost)
                    race.finished(id, ev.t);
            }
            else if (ev.k === 'cooldown') {
                if (race.isHost)
                    race.cooledDown(id);
            }
            else if (ev.k === 'respawn') {
                const rc = this.cars.get(id);
                const e = w.entrants.find((x) => x.id === id);
                if (rc && e) {
                    // A teleport: snap, do not slide the car back along the track.
                    const now = race.roomNow();
                    const p = { ...(rc.packet ?? packetOf(e, now)), x: ev.x, z: ev.z, yaw: ev.yaw, vx: 0, vz: 0, w: 0, t: now };
                    rc.receive(p, now, this.clock.now(), true);
                }
            }
            else if (ev.k === 'pick') {
                // Somebody else's car took a box: gone here too, until it comes back.
                w.pickups?.take(ev.i, w.goTime + ev.t / 1000);
            }
            else if (ev.k === 'bump') {
                const target = race.grid[ev.slot];
                const mine = target ? race.owned(target) : undefined;
                // Felt it ourselves already? Then our own resolution stands.
                if (mine && !w.touchedRecently(target, id, 0.2)) {
                    mine.car.vx += ev.dvx;
                    mine.car.vz += ev.dvz;
                }
            }
            else {
                this.onWeapon(w, id, ev);
            }
        }
    }
    /**
     * Somebody else's weapons (§5.4). Their shots and mines are copied into this
     * world as scenery; their hits are applied here only if the victim is a car
     * this client drives (`World.hit` leaves a remote car's health to its owner).
     */
    onWeapon(w, id, ev) {
        const time = (ms) => w.goTime + ms / 1000;
        if (ev.k === 'fire' || ev.k === 'mine') {
            this.seqs.set(id, Math.max(this.lastSeq(id), ev.seq));
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
            const victim = this.race.grid[ev.slot];
            if (!victim)
                return;
            const m = w.armoury.findMissile(id, ev.seq);
            w.hit(victim, id, ev.seq, ev.weapon === 1 ? 'rear' : 'front', ev.dmg, ev.x, ev.z);
            if (m)
                m.done = true;
        }
        else if (ev.k === 'trigger') {
            const owner = this.race.grid[ev.slot];
            const m = owner ? w.armoury.findMine(owner, ev.seq) : undefined;
            if (!owner || !m || m.done)
                return;
            m.done = true;
            w.hit(id, owner, ev.seq, 'mine', 0, m.x, m.z);
        }
        else if (ev.k === 'wreck') {
            this.wrecks.set(id, Math.max(this.lastWreck(id), ev.n));
            const by = ev.slot >= 0 ? (this.race.grid[ev.slot] ?? null) : null;
            w.creditWreck(id, by);
        }
    }
}
//# sourceMappingURL=RemoteFleet.js.map