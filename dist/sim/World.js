import { SIM, STEP } from '../config.js';
import { IDLE_INTENT } from '../types.js';
import { autopilot, createAutopilot } from './autopilot.js';
import { CAR_SHAPE, createCar, stepCar, STOCK } from './car.js';
import { resolveCarPair } from './collide.js';
import { createLapState, stepLaps } from './race.js';
import { racingLine } from './racingLine.js';
import { Armoury } from './weapons.js';
import { closestSegSeg } from './collide.js';
import { Surface } from './surfaces.js';
import { crossingBusy, TRAIN_HALF_WIDTH, trainAt, trainSegment } from './train.js';
import { Track } from './track/buildTrack.js';
/** Seconds a car may crawl while its driver is trying to go before it is put back on the road. */
export const STUCK_RESPAWN = 3;
/** Seconds off the course before a respawn. */
export const OFF_COURSE_RESPAWN = 1;
/** Seconds a respawned car passes through others. */
export const GHOST_TIME = 2;
/** How far back from its last good spot a respawned car is placed, metres. */
const RESPAWN_BACK = 12;
const W = SIM.weapons;
/**
 * One race's worth of simulation, advanced in fixed 60 Hz steps.
 *
 * Wall-clock time goes in; whole steps come out; the remainder carries over.
 * That separation is the whole point: the physics sees exactly the same
 * sequence of `STEP`-sized steps whether the screen runs at 30 Hz, 144 Hz or
 * not at all, so two clients with different hardware simulate the same race,
 * and the Node tests can replay one exactly.
 */
export class World {
    track;
    entrants = [];
    laps;
    /** Race time at which the lights go green. */
    goTime;
    weapons;
    flyingStart;
    /** Fixed steps taken since the world was created. */
    steps = 0;
    /** Time handed to `advance` after the stall clamp: what the world was asked to simulate. */
    clockTime = 0;
    /** Events since the last `drain`, for the HUD and (M3) the network. */
    events = [];
    accumulator = 0;
    wentGreen = false;
    /** When each pair of cars last touched, world seconds, keyed `a|b` with a < b. */
    contacts = new Map();
    /** Every missile and mine in the race. */
    armoury;
    /**
     * Called at the start of every step with the world time the step will end
     * at, after the previous poses are saved: the moment to pose remote cars.
     */
    onStep = null;
    constructor(def, opts = { laps: 0, countdown: 0 }) {
        this.track = def instanceof Track ? def : new Track(def);
        this.laps = opts.laps;
        this.goTime = opts.countdown;
        this.weapons = opts.weapons ?? true;
        this.flyingStart = opts.flyingStart ?? 0;
        this.steps = Math.round((opts.elapsed ?? 0) / STEP);
        this.armoury = new Armoury(this.track);
    }
    /** Simulated seconds since the world began. */
    get time() {
        return this.steps * STEP;
    }
    get started() {
        return this.time >= this.goTime;
    }
    /** Seconds until GO, or 0 once racing. */
    get countdown() {
        return Math.max(0, this.goTime - this.time);
    }
    /** Put a car on the grid. */
    addCar(id, slot, drive, stats = STOCK) {
        // On the grid, or for a flying start a stretch of lap back from the line.
        const pose = this.flyingStart > 0 ? this.track.poseAt(this.track.length * (1 - this.flyingStart)) : this.track.gridSlot(slot);
        const car = createCar(pose.x, pose.z, pose.yaw);
        const p = this.track.project(car.x, car.z);
        car.hint = p.i;
        const entrant = {
            id, car, prev: { ...car }, stats, drive,
            lap: createLapState(this.track, p.s, this.goTime),
            s: p.s, d: p.d, ghost: 0, respawns: 0, safeS: p.s, stuck: 0, offCourse: 0, intent: { ...IDLE_INTENT }, remote: false,
            hp: W.health, ammo: { ...W.loadout }, wrecked: 0, wrecks: 0, kills: 0, seq: 0, cooldown: { front: 0, rear: 0 },
            lastAttacker: null, lastAttackAt: -Infinity,
        };
        this.entrants.push(entrant);
        return entrant;
    }
    /** Put a car driven by another client on the grid. */
    addRemote(id, slot) {
        const e = this.addCar(id, slot, () => IDLE_INTENT);
        e.remote = true;
        return e;
    }
    /** Did these two cars touch within the last `seconds`? */
    touchedRecently(a, b, seconds) {
        const at = this.contacts.get(a < b ? `${a}|${b}` : `${b}|${a}`);
        return at !== undefined && this.time - at <= seconds;
    }
    /** Put a self-driving car on the grid. */
    addBot(id, slot, skill, seed, stats = STOCK) {
        const state = createAutopilot(seed, skill);
        const line = racingLine(this.track);
        const entrant = this.addCar(id, slot, () => IDLE_INTENT, stats);
        entrant.drive = () => autopilot(state, entrant.car, this.track, line, this.rivalsOf(entrant.id), this.time, STEP, this.stopLine(entrant));
        return entrant;
    }
    /** Every other car, as the autopilot sees them. */
    rivalsOf(id) {
        const out = [];
        for (const e of this.entrants) {
            if (e.id === id || e.ghost > 0 || e.wrecked > 0)
                continue;
            out.push({ id: e.id, x: e.car.x, z: e.car.z, vx: e.car.vx, vz: e.car.vz, s: e.s, d: e.d, target: !e.lap.finished });
        }
        return out;
    }
    /**
     * Where a car driven by the autopilot should stop, if anywhere: short of
     * the level crossing when the train will be across it by the time the car
     * gets there. Null when the way is clear.
     */
    stopLine(e) {
        const rail = this.track.rail;
        if (!rail)
            return null;
        const line = rail.s - this.track.wallOffset - 3;
        const dist = this.track.deltaS(e.s, line);
        if (dist < -2 || dist > 160)
            return null;
        const v = Math.max(4, Math.hypot(e.car.vx, e.car.vz));
        const now = this.time - this.goTime;
        // Busy from now until a little after we would be over the rails?
        return crossingBusy(this.track, now, now + (dist + 2 * this.track.wallOffset + 10) / v + 1) ? line : null;
    }
    /**
     * Report something that happened elsewhere — another client's shot or mine,
     * copied into this world — so it is heard and seen like a local one.
     */
    announce(ev) {
        this.events.push(ev);
    }
    /** Take the events since the last call. */
    drain() {
        const out = this.events;
        this.events = [];
        return out;
    }
    /**
     * Advance by real elapsed time.
     *
     * @returns interpolation alpha in [0, 1): how far between the last two
     *   steps "now" is, for the renderer.
     */
    advance(dtSec) {
        // A tab that was asleep for ten seconds must not wake up and simulate ten
        // seconds in one frame: that is a frozen screen followed by a teleport.
        const dt = Math.min(dtSec, 0.25);
        this.clockTime += dt;
        this.accumulator += dt;
        while (this.accumulator >= STEP) {
            this.step();
            this.accumulator -= STEP;
        }
        return this.accumulator / STEP;
    }
    /** Exactly one fixed step. */
    step() {
        const racing = this.started;
        if (racing && !this.wentGreen) {
            this.wentGreen = true;
            this.events.push({ kind: 'go', time: this.goTime });
        }
        const end = (this.steps + 1) * STEP;
        const track = this.track;
        for (const e of this.entrants)
            Object.assign(e.prev, e.car);
        this.onStep?.(end);
        const armed = this.weapons && racing && this.time - this.goTime >= W.startGrace;
        for (const e of this.entrants) {
            if (e.remote)
                continue;
            if (e.wrecked > 0) {
                // Burning: nobody at the wheel, sliding to a stop.
                e.intent = { ...IDLE_INTENT, brake: 1, handbrake: true };
                stepCar(e.car, e.intent, track, STEP, e.stats);
                e.wrecked -= STEP;
                if (e.wrecked <= 0) {
                    e.wrecked = 0;
                    this.respawn(e);
                    e.hp = W.respawnHealth;
                }
                continue;
            }
            // Before GO the cars sit on the grid; nobody's driver is asked anything.
            e.intent = racing ? e.drive() : { ...IDLE_INTENT };
            stepCar(e.car, e.intent, track, STEP, e.stats);
            if (e.ghost > 0)
                e.ghost = Math.max(0, e.ghost - STEP);
            e.cooldown.front = Math.max(0, e.cooldown.front - STEP);
            e.cooldown.rear = Math.max(0, e.cooldown.rear - STEP);
            if (armed && !e.lap.finished)
                this.fire(e, end);
            if (e.car.peakImpact > SIM.car.impactDamageSpeed) {
                const by = end - e.lastAttackAt <= W.creditWindow ? e.lastAttacker : null;
                this.damage(e, (e.car.peakImpact - SIM.car.impactDamageSpeed) * SIM.car.impactDamage, by, false);
            }
        }
        this.collideCars();
        this.collideTrain(end);
        this.stepWeapons(end - STEP, end);
        for (const e of this.entrants) {
            const c = e.car;
            const p = track.project(c.x, c.z, c.hint);
            c.hint = p.i;
            e.s = p.s;
            e.d = p.d;
            if (e.remote)
                continue;
            const tx = track.line.tx[p.i], tz = track.line.tz[p.i];
            const along = c.vx * tx + c.vz * tz;
            const ev = stepLaps(e.lap, track, p.s, end, STEP, along, this.laps, false, this.flyingStart > 0);
            if (ev?.kind === 'lap') {
                this.events.push({ kind: 'lap', id: e.id, lap: ev.lap, time: ev.time, lapTime: e.lap.lapTimes[e.lap.lapTimes.length - 1] });
            }
            else if (ev?.kind === 'finish') {
                this.events.push({ kind: 'lap', id: e.id, lap: ev.lap, time: ev.time, lapTime: e.lap.lapTimes[e.lap.lapTimes.length - 1] });
                this.events.push({ kind: 'finish', id: e.id, time: ev.time });
            }
            else if (ev?.kind === 'cooldown') {
                this.events.push({ kind: 'cooldown', id: e.id, time: ev.time });
            }
            if (!racing || e.wrecked > 0)
                continue;
            const speed = Math.hypot(c.vx, c.vz);
            if (Math.abs(p.d) < track.halfWidth && along > 3 && !c.airborne)
                e.safeS = p.s;
            // Off the quay (or into the creek): straight back to the road.
            if (c.surfaceFront === Surface.Water || c.surfaceRear === Surface.Water || track.surfaceAt(c.x, c.z, c.hint) === Surface.Water) {
                e.offCourse = Math.max(e.offCourse, OFF_COURSE_RESPAWN - 0.25);
            }
            const trying = e.intent.throttle > 0.1 || e.intent.brake > 0.1;
            e.stuck = speed < 1 && trying ? e.stuck + STEP : 0;
            e.offCourse = Math.abs(p.d) > track.wallOffset + 3 || e.offCourse > OFF_COURSE_RESPAWN - 0.3 ? e.offCourse + STEP : 0;
            if (e.stuck >= STUCK_RESPAWN || e.offCourse >= OFF_COURSE_RESPAWN)
                this.respawn(e);
        }
        this.steps++;
    }
    /**
     * Put a car back on the centreline a little behind where it was last
     * doing well, pointing the right way, stationary, and briefly a ghost so it
     * cannot be respawned into somebody.
     */
    respawn(e) {
        const pose = this.track.poseAt(e.safeS - RESPAWN_BACK);
        const fresh = createCar(pose.x, pose.z, pose.yaw);
        const c = e.car;
        // Keep the counters and the turbo: a respawn is a penalty, not a pit stop.
        Object.assign(c, fresh, {
            turbo: c.turbo, landings: c.landings, lastLanding: c.lastLanding, impacts: c.impacts, lastImpact: c.lastImpact, hint: pose.i,
        });
        Object.assign(e.prev, c);
        e.ghost = GHOST_TIME;
        e.respawns++;
        e.stuck = 0;
        e.offCourse = 0;
        const p = this.track.project(c.x, c.z, c.hint);
        stepLaps(e.lap, this.track, p.s, this.time, STEP, 0, this.laps, true);
        e.s = p.s;
        e.d = p.d;
        this.events.push({ kind: 'respawn', id: e.id, time: this.time });
    }
    /* -------------------------------------------------------------- weapons */
    /** Act on this step's trigger presses, if the car has the ammo and the gun is ready. */
    fire(e, t) {
        const c = e.car;
        if (e.intent.fireFront && e.cooldown.front <= 0 && e.ammo.front > 0) {
            e.ammo.front--;
            e.cooldown.front = W.front.cooldown;
            this.launch(e, 'front', t);
        }
        if (e.intent.fireRear && e.cooldown.rear <= 0) {
            // Mines first, then rear missiles once the mines are gone.
            if (e.ammo.mines > 0) {
                e.ammo.mines--;
                e.cooldown.rear = W.mine.cooldown;
                const seq = ++e.seq;
                const m = this.armoury.drop(e.id, seq, c.x, c.z, c.yaw, t);
                this.events.push({ kind: 'mine', id: e.id, seq, x: m.x, z: m.z, time: t });
            }
            else if (e.ammo.rear > 0) {
                e.ammo.rear--;
                e.cooldown.rear = W.rear.cooldown;
                this.launch(e, 'rear', t);
            }
        }
    }
    launch(e, kind, t) {
        const c = e.car;
        const seq = ++e.seq;
        this.armoury.launch(e.id, seq, kind, c.x, c.z, c.yaw, t, true);
        this.events.push({ kind: 'fire', id: e.id, seq, weapon: kind, x: c.x, z: c.z, yaw: c.yaw, time: t });
    }
    targets() {
        return this.entrants.map((e) => ({
            id: e.id, x: e.car.x, z: e.car.z, yaw: e.car.yaw, y: e.car.y,
            hittable: e.ghost <= 0 && e.wrecked <= 0 && !e.lap.finished,
        }));
    }
    /**
     * Move every shot on by one step and settle what it hit.
     *
     * Live missiles (this client's own) are tested against every car; a hit on
     * a car this world drives is applied here, a hit on a remote car is only
     * reported, for its owner to apply. Mines are the other way round: any mine
     * is tested, but only against the cars this world drives — the car that
     * drives over a mine is the one that notices (§5.4).
     */
    stepWeapons(t0, t1) {
        const arm = this.armoury;
        if (!arm.missiles.length && !arm.mines.length)
            return;
        const targets = this.targets();
        for (const m of arm.missiles) {
            if (m.done)
                continue;
            if (m.live && t1 > m.t0) {
                const hit = arm.sweep(m, Math.max(t0, m.t0), Math.min(t1, m.end), targets);
                if (hit) {
                    m.done = true;
                    this.hit(hit.target.id, m.owner, m.seq, m.kind, W[m.kind].damage, hit.x, hit.z);
                    continue;
                }
            }
            if (t1 >= m.end) {
                m.done = true;
                if (m.wall) {
                    const at = { x: m.x0 + m.dx * m.speed * (m.end - m.t0), z: m.z0 + m.dz * m.speed * (m.end - m.t0) };
                    this.events.push({ kind: 'blast', x: at.x, z: at.z });
                }
            }
        }
        for (const mine of arm.mines) {
            if (mine.done)
                continue;
            if (t1 >= mine.expires) {
                mine.done = true;
                continue;
            }
            if (t1 < mine.armAt)
                continue;
            for (const e of this.entrants) {
                if (e.remote)
                    continue;
                const target = targets.find((x) => x.id === e.id);
                if (!Armoury.onMine(mine, target))
                    continue;
                mine.done = true;
                this.hit(e.id, mine.owner, mine.seq, 'mine', W.mine.damage, mine.x, mine.z);
                break;
            }
        }
        arm.prune();
    }
    /**
     * A shot or mine found a car. Reported always; applied only if this world
     * drives the victim. The network calls this too, for hits other clients'
     * shots made.
     */
    hit(victim, by, seq, weapon, damage, x, z) {
        const e = this.entrants.find((x) => x.id === victim);
        if (!e)
            return;
        this.events.push({ kind: 'hit', id: victim, by, seq, weapon, damage, x, z, remote: e.remote });
        if (e.remote)
            return;
        this.damage(e, damage, by, true);
        // A missile shoves as well as hurts: along its flight, or up and out of a mine.
        const m = weapon === 'mine' ? null : this.armoury.findMissile(by, seq);
        const kick = weapon === 'mine' ? 0 : 3.5;
        if (m) {
            e.car.vx += m.dx * kick;
            e.car.vz += m.dz * kick;
        }
        e.car.w += (seq % 2 ? 1 : -1) * (weapon === 'mine' ? 2.2 : 1.2);
    }
    /**
     * Take health off a car this world drives. Anything that brings it to zero
     * wrecks it; the credit goes to whoever caused it, or to whoever hurt it
     * last if a wall finished the job within a few seconds.
     *
     * Applies to this world's own cars only — a remote car's health is its
     * owner's, which is why a hit on one is only ever reported.
     */
    damage(e, amount, by, attack) {
        if (e.remote || e.wrecked > 0 || e.lap.finished || amount <= 0)
            return;
        const taken = amount * e.stats.armour;
        e.hp = Math.max(0, e.hp - taken);
        if (attack && by && by !== e.id) {
            e.lastAttacker = by;
            e.lastAttackAt = this.time;
        }
        this.events.push({ kind: 'damage', id: e.id, amount: taken, hp: e.hp, by });
        if (e.hp <= 0)
            this.wreck(e, by === e.id ? null : by);
    }
    wreck(e, by) {
        e.hp = 0;
        e.wrecked = W.wreckTime;
        e.wrecks++;
        e.stuck = 0;
        e.offCourse = 0;
        const killer = by ? this.entrants.find((x) => x.id === by) : undefined;
        if (killer)
            killer.kills++;
        this.events.push({ kind: 'wreck', id: e.id, by, x: e.car.x, z: e.car.z, time: this.time });
    }
    /**
     * A wreck reported by a remote car's owner: count it for the killer here
     * too, so every screen's tallies agree.
     */
    creditWreck(victim, by) {
        const e = this.entrants.find((x) => x.id === victim);
        if (e)
            e.wrecks++;
        const killer = by ? this.entrants.find((x) => x.id === by) : undefined;
        if (killer)
            killer.kills++;
        if (e)
            this.events.push({ kind: 'wreck', id: victim, by, x: e.car.x, z: e.car.z, time: this.time });
    }
    /* ---------------------------------------------------------------- train */
    /**
     * The train against the cars this world drives. It is an immovable,
     * unstoppable capsule: a car in its way is shoved clear, dragged along with
     * it, and badly hurt. Each client does this for its own cars only, against
     * a train every client computes identically.
     */
    collideTrain(end) {
        const tr = trainAt(this.track, end - this.goTime);
        if (!tr)
            return;
        const seg = trainSegment(this.track, tr);
        if (!seg)
            return;
        const rail = this.track.rail;
        const reach = SIM.car.radius + TRAIN_HALF_WIDTH;
        const half = SIM.car.capsuleHalf;
        const tmp = { ax: 0, az: 0, bx: 0, bz: 0 };
        for (const e of this.entrants) {
            if (e.remote || e.ghost > 0)
                continue;
            const c = e.car;
            const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
            const d2 = closestSegSeg(c.x + fx * half, c.z + fz * half, c.x - fx * half, c.z - fz * half, seg.ax, seg.az, seg.bx, seg.bz, tmp);
            if (d2 >= reach * reach)
                continue;
            const d = Math.sqrt(d2);
            // Out of the train sideways, the way the car already was.
            let nx = tmp.ax - tmp.bx, nz = tmp.az - tmp.bz;
            if (d > 1e-6) {
                nx /= d;
                nz /= d;
            }
            else {
                nx = -rail.dz;
                nz = rail.dx;
            }
            c.x += nx * (reach - d);
            c.z += nz * (reach - d);
            const tvx = rail.dx * tr.dir * tr.speed, tvz = rail.dz * tr.dir * tr.speed;
            const closing = (tvx - c.vx) * nx + (tvz - c.vz) * nz;
            if (closing > 0) {
                // Leave at the train's speed along the normal, plus a bounce.
                c.vx += nx * closing * 1.3;
                c.vz += nz * closing * 1.3;
                c.w += (e.id.length % 2 ? 1 : -1) * Math.min(3, closing * 0.2);
                if (e.wrecked <= 0 && closing > 2) {
                    this.events.push({ kind: 'train', id: e.id, closing });
                    this.damage(e, 20 + closing * 2, null, false);
                }
            }
        }
    }
    /* ----------------------------------------------------------- car contact */
    collideCars() {
        const list = this.entrants;
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            if (a.ghost > 0 || a.wrecked > 0)
                continue;
            for (let j = i + 1; j < list.length; j++) {
                const b = list[j];
                if (b.ghost > 0 || b.wrecked > 0)
                    continue;
                const dx = a.car.x - b.car.x, dz = a.car.z - b.car.z;
                if (dx * dx + dz * dz > 36)
                    continue;
                if (Math.abs(a.car.y - b.car.y) > 1.2)
                    continue; // one is flying over the other
                if (a.remote && b.remote)
                    continue; // their owners settle that between them
                // Each client moves only the cars it drives; the other side's share
                // goes to its owner as an event (see NetRace).
                const hit = resolveCarPair(a.car, b.car, CAR_SHAPE, !a.remote, !b.remote);
                if (!hit)
                    continue;
                this.contacts.set(a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`, this.time);
                const remote = a.remote ? a : b.remote ? b : null;
                // The impulse returned acts on A; the remote car's share is its negation if it is B.
                const sign = remote === b ? -1 : 1;
                if (hit.closing > 0.5) {
                    this.events.push({
                        kind: 'bump', a: a.id, b: b.id, closing: hit.closing, remote: remote?.id ?? null,
                        dvx: remote ? (sign * hit.jx) / CAR_SHAPE.mass : 0, dvz: remote ? (sign * hit.jz) / CAR_SHAPE.mass : 0,
                    });
                }
            }
        }
    }
}
//# sourceMappingURL=World.js.map