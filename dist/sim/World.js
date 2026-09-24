import { STEP } from '../config.js';
import { createCar, stepCar, STOCK } from './car.js';
import { Track } from './track/buildTrack.js';
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
    /** Fixed steps taken since the world was created. */
    steps = 0;
    /** Time handed to `advance` after the stall clamp: what the world was asked to simulate. */
    clockTime = 0;
    accumulator = 0;
    constructor(def) {
        this.track = def instanceof Track ? def : new Track(def);
    }
    /** Put a car on the grid. */
    addCar(id, slot, drive, stats = STOCK) {
        const pose = this.track.gridSlot(slot);
        const car = createCar(pose.x, pose.z, pose.yaw);
        car.hint = this.track.project(car.x, car.z).i;
        const entrant = { id, car, prev: { ...car }, stats, drive };
        this.entrants.push(entrant);
        return entrant;
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
        for (const e of this.entrants) {
            Object.assign(e.prev, e.car);
            stepCar(e.car, e.drive(), this.track, STEP, e.stats);
        }
        this.steps++;
    }
}
//# sourceMappingURL=World.js.map