import { STEP } from './config.js';
import { HAPTIC } from './input/settings.js';
import { GameView } from './render/GameView.js';
import { crossingWarning, trainAt } from './sim/train.js';
import { autopilot, createAutopilot, SKILLS } from './sim/autopilot.js';
import { BOT_NAMES } from './sim/bots.js';
import { createCar } from './sim/car.js';
import { interpolateCar } from './sim/interpolate.js';
import { COLOUR_ORDER, colourOf } from './sim/palette.js';
import { botLook, DEFAULT_LOOK } from './sim/look.js';
import { displayLap, standings } from './sim/race.js';
import { racingLine } from './sim/racingLine.js';
import { World } from './sim/World.js';
import { IDLE_INTENT } from './types.js';
/** Seconds of lights before GO, offline. */
const COUNTDOWN = 3;
/** After the player finishes an offline race, how long the others get. */
const FINISH_GRACE = 25;
/**
 * One race on screen: an offline race or free drive this client simulates
 * alone, or a race in a networked room (M3), where a `NetRace` owns the world
 * and this only reads input and draws.
 *
 * Owns the frame loop. Input is read once per frame; the world takes as many
 * fixed steps as fit; the view draws every car interpolated between its last
 * two steps.
 */
export class RaceSession {
    input;
    world;
    view;
    /** This client's car, or null while spectating. */
    player;
    playerId;
    cars = new Map();
    mode;
    raf = 0;
    last = 0;
    intent = { ...IDLE_INTENT };
    drawn = new Map();
    frames = 0;
    fpsAt = 0;
    fps = 0;
    running = false;
    playerFinishedAt = null;
    over = false;
    pilot = createAutopilot(7, SKILLS[0]);
    net;
    offNet = [];
    /** Set by tests: when true the loop keeps rendering but stops stepping. */
    frozen = false;
    /** The pause menu is open: offline that stops the world; online it only holds our car. */
    paused = false;
    /** Drive the player's car with the autopilot (real input still wins). */
    autopilot;
    onHud = null;
    onEvent = null;
    onOver = null;
    /** Sound, if the page has it. Set by the page after construction. */
    audio = null;
    lastPip = -1;
    warned = false;
    constructor(host, opts, input, settings, net = null) {
        this.input = input;
        this.mode = opts.mode;
        this.net = net;
        this.autopilot = settings.current.autopilot;
        if (net && net.world) {
            this.world = net.world;
            this.player = net.me;
            this.playerId = net.playerId;
            for (const e of this.world.entrants) {
                const info = net.carInfo(e.id);
                this.addInfo(e.id, info.you ? 'YOU' : info.name, info.colour, info.you, info.look);
            }
            net.drive = () => this.playerIntent();
            this.offNet.push(net.events.on('race', ({ ev }) => this.handle(ev)), net.events.on('results', ({ rows }) => {
                if (this.over)
                    return;
                this.over = true;
                this.onOver?.(rows.map((r) => this.row(r.position, r.id, r.time, r.laps)));
            }));
        }
        else {
            const race = opts.mode === 'race';
            this.world = new World(opts.track, { laps: race ? opts.laps : 0, countdown: race ? COUNTDOWN : 0 });
            this.playerId = 'you';
            // The player starts mid-grid in a race — there is somebody to catch and
            // somebody to hold off — and on pole in a free drive.
            const bots = race ? Math.min(5, opts.bots) : 0;
            const playerSlot = race ? Math.min(bots, 3) : 0;
            const colours = COLOUR_ORDER.filter((c) => c !== opts.colourId);
            this.player = this.world.addCar('you', playerSlot, () => this.playerIntent());
            this.addInfo('you', 'YOU', opts.colourId, true, opts.look ?? DEFAULT_LOOK);
            let slot = 0;
            for (let b = 0; b < bots; b++) {
                if (slot === playerSlot)
                    slot++;
                const id = `b${b}`;
                this.world.addBot(id, slot, SKILLS[b % SKILLS.length], 1000 + b);
                this.addInfo(id, BOT_NAMES[b % BOT_NAMES.length], colours[b % colours.length], false, botLook(1000 + b));
                slot++;
            }
        }
        this.view = new GameView(host, this.world.track, opts.quality);
        for (const e of this.world.entrants) {
            const info = this.cars.get(e.id);
            this.view.addCar(e.id, info.colour, info.look);
            this.drawn.set(e.id, createCar(e.car.x, e.car.z, e.car.yaw));
        }
        this.view.focusId = this.player?.id ?? this.world.entrants[0]?.id ?? null;
        this.view.rig.shakeScale = settings.current.reduceMotion ? 0.25 : 1;
        this.view.onJolt = (kind, k) => {
            const p = kind === 'landing' ? HAPTIC.landing : HAPTIC.crash;
            this.input.rumble(p.weak * k, p.strong * k, p.ms);
            if (kind === 'landing')
                this.audio?.landing(k);
            else
                this.audio?.crash(k);
        };
    }
    get spectating() {
        return this.player === null;
    }
    addInfo(id, name, colourId, you, look) {
        const c = colourOf(colourId);
        this.cars.set(id, { id, name, colour: c.colour, css: c.cssColour, you, look });
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        this.input.setInRace(true);
        this.last = performance.now();
        this.fpsAt = this.last;
        this.raf = requestAnimationFrame(this.frame);
    }
    stop() {
        this.running = false;
        cancelAnimationFrame(this.raf);
        this.audio?.silenceEngines();
        this.input.setInRace(false);
        for (const off of this.offNet)
            off();
        this.offNet = [];
        if (this.net)
            this.net.drive = () => IDLE_INTENT;
        this.view.dispose();
    }
    /**
     * What the player's car does this step. Edge-triggered inputs are consumed
     * by the first step that sees them. With the pause menu open online, the car
     * is held on the brakes — a race with other people in it cannot stop. Once
     * the player has finished, or with the autopilot on and nobody touching the
     * controls, the autopilot drives.
     */
    playerIntent() {
        const me = this.player;
        if (!me)
            return IDLE_INTENT;
        if (this.paused)
            return { ...IDLE_INTENT, brake: me.car.forward > 0.5 ? 1 : 0 };
        const human = { ...this.intent };
        this.intent.fireFront = false;
        this.intent.fireRear = false;
        const touched = Math.abs(human.steer) > 0.05 || human.throttle > 0 || human.brake > 0 || human.handbrake;
        if (me.lap.finished || (this.autopilot && !touched)) {
            const line = racingLine(this.world.track);
            const auto = autopilot(this.pilot, me.car, this.world.track, line, this.world.rivalsOf(me.id), this.world.time, STEP, this.world.stopLine(me));
            // The autopilot drives, but the trigger is still yours.
            return { ...auto, fireFront: auto.fireFront || human.fireFront, fireRear: auto.fireRear || human.fireRear };
        }
        return human;
    }
    frame = (now) => {
        if (!this.running)
            return;
        // performance.now(), not a framework delta: a starved renderer must not
        // slow the simulation's clock down with it.
        const dt = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
        this.last = now;
        const read = this.input.read(dt);
        this.intent = {
            ...read,
            fireFront: this.intent.fireFront || read.fireFront,
            fireRear: this.intent.fireRear || read.fireRear,
        };
        let alpha;
        if (this.net) {
            // The room drives the world; frozen/paused never stop a shared race.
            alpha = this.net.update();
        }
        else {
            alpha = this.frozen || this.paused ? 1 : this.world.advance(dt);
            for (const ev of this.world.drain())
                this.handle(ev);
        }
        for (const e of this.world.entrants) {
            interpolateCar(e.prev, e.car, alpha, this.drawn.get(e.id));
            this.view.setCondition(e.id, e.hp, e.wrecked > 0, e.ghost > 0);
        }
        // The cars are drawn `1 - alpha` of a step behind the latest one; the shots are drawn at the same moment.
        const drawTime = this.world.time - (1 - alpha) * STEP;
        this.view.drawWeapons(this.world.armoury, drawTime, this.paused && !this.net ? 0 : dt, this.drawn.values());
        this.view.drawHazards(drawTime - this.world.goTime, dt);
        this.sound(drawTime - this.world.goTime);
        // Spectating: follow whoever is leading.
        if (!this.player)
            this.view.focusId = standings(this.world.entrants)[0]?.id ?? this.view.focusId;
        this.view.render(this.drawn, this.paused && !this.net ? 0 : dt);
        this.frames++;
        if (now - this.fpsAt >= 500) {
            this.fps = (this.frames * 1000) / (now - this.fpsAt);
            this.frames = 0;
            this.fpsAt = now;
        }
        this.onHud?.(this.hud());
        this.raf = requestAnimationFrame(this.frame);
    };
    /** Distance from the car being followed, for how loud something is. */
    hear(x, z) {
        const f = this.view.focusId ? this.drawn.get(this.view.focusId) : undefined;
        return f ? Math.hypot(x - f.x, z - f.z) : 0;
    }
    /** Once a frame: engines for the nearest cars, the countdown, the crossing. */
    sound(raceTime) {
        const a = this.audio;
        if (!a)
            return;
        if (this.paused && !this.net) {
            a.silenceEngines();
            return;
        }
        const voices = [];
        for (const e of this.world.entrants) {
            const c = this.drawn.get(e.id);
            voices.push({
                id: e.id, speed: Math.hypot(c.vx, c.vz), throttle: e.remote ? (c.boosting ? 1 : 0.6) : c.throttle,
                boosting: c.boosting, distance: this.hear(c.x, c.z),
                slide: c.airborne || e.wrecked > 0 ? 0 : Math.max(0, Math.abs(c.slip) - 0.12) * 3 + (c.handbrake && Math.hypot(c.vx, c.vz) > 6 ? 0.5 : 0),
            });
        }
        a.engines(voices);
        // Pips on 3, 2, 1; GO has its own tone, from the go event.
        const cd = this.world.countdown;
        const pip = Math.ceil(cd);
        if (cd > 0 && pip <= 3 && pip !== this.lastPip) {
            this.lastPip = pip;
            a.countdown(false);
        }
        // The crossing: a bell while the lights flash, and the horn once per train.
        const rail = this.world.track.rail;
        if (rail) {
            const warn = crossingWarning(this.world.track, raceTime);
            if (warn)
                a.bell(this.hear(rail.x, rail.z));
            const tr = trainAt(this.world.track, raceTime);
            if (warn && !this.warned && tr)
                a.horn(this.hear(rail.x, rail.z));
            this.warned = warn;
        }
    }
    handle(ev) {
        if (ev.kind === 'go')
            this.input.rumble(HAPTIC.go.weak, HAPTIC.go.strong, HAPTIC.go.ms);
        this.soundFor(ev);
        const focus = this.view.focusId ? this.drawn.get(this.view.focusId) : undefined;
        if (ev.kind === 'hit') {
            this.view.explode(ev.x, ev.z, ev.weapon === 'mine' ? 1.4 : 1, focus);
            if (ev.id === this.playerId)
                this.input.rumble(HAPTIC.damage.weak, HAPTIC.damage.strong, HAPTIC.damage.ms);
        }
        else if (ev.kind === 'blast') {
            this.view.explode(ev.x, ev.z, 0.6, focus);
        }
        else if (ev.kind === 'wreck') {
            this.view.explode(ev.x, ev.z, 2, focus);
            if (ev.id === this.playerId)
                this.input.rumble(HAPTIC.wreck.weak, HAPTIC.wreck.strong, HAPTIC.wreck.ms);
        }
        else if (ev.kind === 'fire' && ev.id === this.playerId) {
            this.input.rumble(HAPTIC.fire.weak, HAPTIC.fire.strong, HAPTIC.fire.ms);
        }
        if (ev.kind === 'finish' && ev.id === this.playerId)
            this.playerFinishedAt = ev.time;
        this.onEvent?.(ev);
        if (!this.net)
            this.checkOver();
    }
    soundFor(ev) {
        const a = this.audio;
        if (!a)
            return;
        const at = (id) => {
            const c = this.drawn.get(id);
            return c ? this.hear(c.x, c.z) : 50;
        };
        switch (ev.kind) {
            case 'go':
                a.countdown(true);
                break;
            case 'fire':
                a.fire(at(ev.id), ev.weapon === 'rear');
                break;
            case 'mine':
                a.mineDrop(this.hear(ev.x, ev.z));
                break;
            case 'hit':
                a.explosion(this.hear(ev.x, ev.z), ev.weapon === 'mine' ? 1.3 : 1);
                break;
            case 'blast':
                a.explosion(this.hear(ev.x, ev.z), 0.6);
                break;
            case 'wreck':
                a.explosion(this.hear(ev.x, ev.z), 1.8);
                break;
            case 'train':
                a.crash(1);
                break;
            case 'lap':
                if (ev.id === this.playerId && ev.lap + 1 <= this.world.laps)
                    a.lap(ev.lap + 1 === this.world.laps);
                break;
            case 'finish':
                if (ev.id === this.playerId)
                    a.finish();
                break;
            case 'respawn':
                if (ev.id === this.playerId)
                    a.respawn();
                break;
        }
    }
    checkOver() {
        if (this.over || this.mode !== 'race')
            return;
        const all = this.world.entrants.every((e) => e.lap.finished);
        const graceUp = this.playerFinishedAt !== null && this.world.time - this.playerFinishedAt > FINISH_GRACE;
        if (all || graceUp) {
            this.over = true;
            this.onOver?.(this.results());
        }
    }
    row(position, id, time, laps) {
        const e = this.world.entrants.find((x) => x.id === id);
        return { position, car: this.cars.get(id), time, best: e?.lap.best ?? null, laps };
    }
    /** Current race order, as table rows. */
    results() {
        return standings(this.world.entrants).map((e, i) => this.row(i + 1, e.id, e.lap.finishTime === null ? null : e.lap.finishTime - this.world.goTime, Math.max(0, e.lap.completed)));
    }
    hud() {
        const w = this.world;
        const order = standings(w.entrants);
        const e = this.player ?? order[0];
        const car = e.car;
        const last = e.lap.lapTimes.length ? e.lap.lapTimes[e.lap.lapTimes.length - 1] : null;
        return {
            mode: this.mode,
            speedKmh: Math.hypot(car.vx, car.vz) * 3.6,
            turbo: car.turbo,
            fps: this.fps,
            drawCalls: this.view.drawCalls,
            countdown: w.countdown,
            raceTime: (e.lap.finishTime ?? w.time) - w.goTime,
            lap: displayLap(e.lap, w.laps),
            laps: w.laps,
            position: order.indexOf(e) + 1,
            of: order.length,
            lastLap: last,
            bestLap: e.lap.best,
            wrongWay: e.lap.wrongWay && !e.lap.finished && !this.spectating,
            finished: e.lap.finished,
            autopilot: this.autopilot,
            spectating: this.spectating,
            paused: this.paused,
            hp: e.hp,
            ammo: { ...e.ammo },
            wrecked: e.wrecked > 0,
        };
    }
    /** Interpolated states as last drawn, for the minimap, the arrows and the debug hooks. */
    get drawnStates() {
        return this.drawn;
    }
}
//# sourceMappingURL=RaceSession.js.map