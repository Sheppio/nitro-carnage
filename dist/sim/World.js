import { STEP } from '../config.js';
import { IDLE_INTENT } from '../types.js';
import { autopilot, createAutopilot } from './autopilot.js';
import { CAR_SHAPE, createCar, stepCar, STOCK } from './car.js';
import { resolveCarPair } from './collide.js';
import { createLapState, stepLaps } from './race.js';
import { racingLine } from './racingLine.js';
import { Track } from './track/buildTrack.js';
/** Seconds a car may crawl while its driver is trying to go before it is put back on the road. */
export const STUCK_RESPAWN = 3;
/** Seconds off the course before a respawn. */
export const OFF_COURSE_RESPAWN = 1;
/** Seconds a respawned car passes through others. */
export const GHOST_TIME = 2;
/** How far back from its last good spot a respawned car is placed, metres. */
const RESPAWN_BACK = 12;
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
    /**
     * Called at the start of every step with the world time the step will end
     * at, after the previous poses are saved: the moment to pose remote cars.
     */
    onStep = null;
    constructor(def, opts = { laps: 0, countdown: 0 }) {
        this.track = def instanceof Track ? def : new Track(def);
        this.laps = opts.laps;
        this.goTime = opts.countdown;
        this.steps = Math.round((opts.elapsed ?? 0) / STEP);
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
        const pose = this.track.gridSlot(slot);
        const car = createCar(pose.x, pose.z, pose.yaw);
        const p = this.track.project(car.x, car.z);
        car.hint = p.i;
        const entrant = {
            id, car, prev: { ...car }, stats, drive,
            lap: createLapState(this.track, p.s, this.goTime),
            s: p.s, d: p.d, ghost: 0, respawns: 0, safeS: p.s, stuck: 0, offCourse: 0, intent: { ...IDLE_INTENT }, remote: false,
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
        entrant.drive = () => autopilot(state, entrant.car, this.track, line, this.rivalsOf(entrant.id), this.time, STEP);
        return entrant;
    }
    /** Every other car, as the autopilot sees them. */
    rivalsOf(id) {
        const out = [];
        for (const e of this.entrants) {
            if (e.id === id || e.ghost > 0)
                continue;
            out.push({ id: e.id, x: e.car.x, z: e.car.z, vx: e.car.vx, vz: e.car.vz, s: e.s, d: e.d });
        }
        return out;
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
        for (const e of this.entrants) {
            if (e.remote)
                continue;
            // Before GO the cars sit on the grid; nobody's driver is asked anything.
            e.intent = racing ? e.drive() : { ...IDLE_INTENT };
            stepCar(e.car, e.intent, track, STEP, e.stats);
            if (e.ghost > 0)
                e.ghost = Math.max(0, e.ghost - STEP);
        }
        this.collideCars();
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
            const ev = stepLaps(e.lap, track, p.s, end, STEP, along, this.laps);
            if (ev?.kind === 'lap') {
                this.events.push({ kind: 'lap', id: e.id, lap: ev.lap, time: ev.time, lapTime: e.lap.lapTimes[e.lap.lapTimes.length - 1] });
            }
            else if (ev?.kind === 'finish') {
                this.events.push({ kind: 'lap', id: e.id, lap: ev.lap, time: ev.time, lapTime: e.lap.lapTimes[e.lap.lapTimes.length - 1] });
                this.events.push({ kind: 'finish', id: e.id, time: ev.time });
            }
            if (!racing)
                continue;
            const speed = Math.hypot(c.vx, c.vz);
            if (Math.abs(p.d) < track.halfWidth && along > 3 && !c.airborne)
                e.safeS = p.s;
            const trying = e.intent.throttle > 0.1 || e.intent.brake > 0.1;
            e.stuck = speed < 1 && trying ? e.stuck + STEP : 0;
            e.offCourse = Math.abs(p.d) > track.wallOffset + 3 ? e.offCourse + STEP : 0;
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
    collideCars() {
        const list = this.entrants;
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            if (a.ghost > 0)
                continue;
            for (let j = i + 1; j < list.length; j++) {
                const b = list[j];
                if (b.ghost > 0)
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