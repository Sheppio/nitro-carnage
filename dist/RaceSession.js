import { FEATURES, STEP } from './config.js';
import { HAPTIC } from './input/settings.js';
import { GameView } from './render/GameView.js';
import { crossingWarning, trainAt } from './sim/train.js';
import { ghostAt, LapTrace } from './sim/ghost.js';
import { SIM } from './config.js';
import { autopilot, createAutopilot, skillFor, SKILLS } from './sim/autopilot.js';
import { botNames, isBotId } from './sim/bots.js';
import { createCar } from './sim/car.js';
import { Surface } from './sim/surfaces.js';
import { missileAt } from './sim/weapons.js';
import { interpolateCar } from './sim/interpolate.js';
import { COLOUR_ORDER, colourOf } from './sim/palette.js';
import { assignBodies, botLook, DEFAULT_LOOK } from './sim/look.js';
import { displayLap, standings } from './sim/race.js';
import { RaceLog } from './sim/raceLog.js';
import { racingLine } from './sim/racingLine.js';
import { World } from './sim/World.js';
import { IDLE_INTENT } from './types.js';
/** Seconds the camera takes to drop from above the grid at the start. */
const INTRO = 2.6;
/** Seconds of lights before GO, offline. */
const COUNTDOWN = 3;
/** After the player finishes an offline race, how long the others get. */
/** Seconds after the first car home before the race ends regardless. */
const FINISH_GRACE = 60;
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
    settings;
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
    over = false;
    pilot = createAutopilot(7, SKILLS[0]);
    net;
    offNet = [];
    /** Set by tests: when true the loop keeps rendering but stops stepping. */
    frozen = false;
    /** The pause menu is open: offline that stops the world; online it only holds our car. */
    paused = false;
    /** Photo mode's input, read every frame while it is on; null while racing. See `ui/PhotoMode.ts`. */
    photoInput = null;
    /** Drive the player's car with the autopilot (real input still wins). */
    autopilot;
    onHud = null;
    onEvent = null;
    onOver = null;
    /** A car was wrecked: the kill feed. */
    onWreck = null;
    /** This race's story so far: wrecks, hits and the grid, for the feed, the awards and the room's tally. */
    log = new RaceLog();
    /** Sound, if the page has it. Set by the page after construction. */
    audio = null;
    /** The best lap on record for this track (hotlap); the page loads and saves it. */
    record = null;
    /** The lap being recorded (hotlap), and the recording of the lap just finished. */
    trace = new LapTrace();
    lastTrace = [];
    splitAt = -1;
    splitDelta = 0;
    seenSplits = 0;
    lastPip = -1;
    lastLight = -1;
    warned = false;
    /** The player's place last frame, for the last-lap overtakes. */
    lastPlace = 0;
    /** Remote cars' throttle, guessed from how they speed up: the network does not carry it. */
    revs = new Map();
    constructor(host, opts, input, settings, net = null) {
        this.input = input;
        this.settings = settings;
        this.mode = opts.mode;
        this.net = net;
        this.autopilot = settings.current.autopilot;
        if (net && net.world) {
            this.world = net.world;
            this.player = net.me;
            this.playerId = net.playerId;
            for (const e of this.world.entrants) {
                const info = net.carInfo(e.id);
                this.addInfo(e.id, info.name, info.colour, info.you, info.look);
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
            this.world = new World(opts.track, {
                laps: race ? opts.laps : 0, countdown: race ? COUNTDOWN : 0, weapons: race && opts.weapons !== false,
                pickups: opts.pickups !== false, turbo: FEATURES.turbo && opts.turbo !== false,
                // A hotlap starts a quarter of a lap back, so the first timed lap is a flying one.
                flyingStart: race ? 0 : 0.25,
            });
            this.playerId = 'you';
            // The player starts anywhere on a race's grid, and on pole in a free drive.
            const bots = race ? Math.min(5, opts.bots) : 0;
            // Anywhere on the grid, afresh every race (#21): Race again is not the same start.
            const playerSlot = race ? Math.floor(Math.random() * (bots + 1)) : 0;
            const colours = COLOUR_ORDER.filter((c) => c !== opts.colourId);
            this.player = this.world.addCar('you', playerSlot, () => this.playerIntent());
            // The Car type: the player is the senior car, whose body a Single grid copies.
            const own = [opts.look ?? DEFAULT_LOOK, ...Array.from({ length: bots }, (_, b) => botLook(1000 + b))];
            const bodies = assignBodies(own.map((l) => l.body), race ? (opts.carMode ?? 'any') : 'any', Math.floor(Math.random() * 2 ** 31));
            this.addInfo('you', opts.name || 'YOU', opts.colourId, true, { ...own[0], body: bodies[0] });
            let slot = 0;
            // New names every race: a quick race has no room to agree with.
            const names = botNames(Math.floor(Math.random() * 2 ** 31), bots);
            for (let b = 0; b < bots; b++) {
                if (slot === playerSlot)
                    slot++;
                const id = `b${b}`;
                this.world.addBot(id, slot, skillFor(b, settings.current.botLevel), 1000 + b);
                this.addInfo(id, names[b], colours[b % colours.length], false, { ...own[b + 1], body: bodies[b + 1] });
                slot++;
            }
        }
        this.view = new GameView(host, this.world.track, opts.quality);
        this.view.setPickups(this.world.pickups);
        for (const e of this.world.entrants) {
            const info = this.cars.get(e.id);
            this.view.addCar(e.id, info.colour, info.look);
            this.drawn.set(e.id, createCar(e.car.x, e.car.z, e.car.yaw));
        }
        this.view.focusId = this.player?.id ?? this.world.entrants[0]?.id ?? null;
        // The hotlap ghost, built now so its first appearance does not stall the game.
        if (this.mode === 'hotlap' && this.player)
            this.view.prepareGhost();
        this.applyCamera();
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
        this.input.setInRace(true, this.world.weapons);
        this.last = performance.now();
        this.fpsAt = this.last;
        this.raf = requestAnimationFrame(this.frame);
    }
    stop() {
        this.running = false;
        cancelAnimationFrame(this.raf);
        this.audio?.silenceEngines();
        this.audio?.mood(null);
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
        // An always-on throttle is not somebody driving: the autopilot still takes over when nothing else is touched.
        const pressing = human.throttle > 0 && !this.settings.current.autoThrottle;
        const touched = Math.abs(human.steer) > 0.05 || pressing || human.brake > 0 || human.handbrake;
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
        // Paused, a shot is not saved up for later: Y and RB mean other things in photo mode.
        this.intent = {
            ...read,
            fireFront: !this.paused && (this.intent.fireFront || read.fireFront),
            fireRear: !this.paused && (this.intent.fireRear || read.fireRear),
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
        // The race can end inside this frame: a finish runs `onOver`, which stops
        // the session and frees the scene. Drawing on would upload the whole
        // scene again to a renderer the next race shares, and nothing would ever
        // free it: a race's worth of GPU memory lost per race, and the judder
        // that came with it on an Xbox by the second race.
        if (!this.running)
            return;
        for (const e of this.world.entrants) {
            interpolateCar(e.prev, e.car, alpha, this.drawn.get(e.id));
            this.view.setCondition(e.id, e.hp, e.wrecked > 0, e.ghost > 0);
        }
        // The cars are drawn `1 - alpha` of a step behind the latest one; the shots are drawn at the same moment.
        const drawTime = this.world.time - (1 - alpha) * STEP;
        this.view.drawWeapons(this.world.armoury, drawTime, this.paused && !this.net ? 0 : dt, this.drawn.values());
        this.view.drawHazards(drawTime - this.world.goTime, dt);
        this.view.drawPickups(drawTime, this.paused && !this.net ? 0 : dt);
        if (this.mode === 'hotlap')
            this.hotlapFrame(drawTime);
        this.sound(drawTime - this.world.goTime, drawTime, dt);
        this.startFrame();
        // Spectating: follow whoever is leading.
        if (!this.player)
            this.view.focusId = standings(this.world.entrants)[0]?.id ?? this.view.focusId;
        if (this.photoInput)
            this.view.photoCam.update(this.view.rig.camera, this.photoInput(dt), dt);
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
    /**
     * The race start: the camera's drop from above the grid (seconds of it,
     * ending just before GO), and a rumble on each light, whatever the audio.
     */
    startFrame() {
        const cd = this.world.countdown;
        const race = this.mode !== 'hotlap';
        this.view.rig.intro = race && cd > 0 ? Math.min(1, Math.max(0, (cd - 0.4) / INTRO)) : 0;
        const light = Math.ceil(cd);
        if (race && cd > 0 && light <= 3 && light !== this.lastLight) {
            this.lastLight = light;
            this.input.rumble(HAPTIC.count.weak, HAPTIC.count.strong, HAPTIC.count.ms);
        }
    }
    /**
     * Photo mode, from the pause menu, offline only: the world stays stopped
     * and a free camera takes over from where the race camera is, reading
     * `read` every frame. `photo` is the depth of field, changed in place.
     */
    startPhoto(read, photo) {
        if (this.net)
            return;
        const rig = this.view.rig;
        const car = this.view.focusId ? this.drawn.get(this.view.focusId) : undefined;
        this.view.photoCam.begin(rig.camera, car ?? rig.camera.position);
        this.view.photo = photo;
        this.photoInput = read;
    }
    /** Back to the race camera. */
    stopPhoto() {
        this.view.photo = null;
        this.photoInput = null;
    }
    get photographing() {
        return this.photoInput !== null;
    }
    /** The frame as it is now, as a PNG. */
    snapshot() {
        return this.view.snapshot(this.drawn);
    }
    /** The followed car's distance from the camera: photo mode's "focus on the car". */
    carDistance() {
        return this.view.focusDistance(this.drawn);
    }
    /** The depth of whatever is on screen at a point (CSS pixels), or null for the sky: photo mode's click to focus. */
    pointDistance(clientX, clientY) {
        return this.view.focusAt(clientX, clientY);
    }
    /** The camera settings, at the start and whenever they change: the view, its Custom offset, the zoom and the shake. */
    applyCamera() {
        const c = this.settings.current;
        const rig = this.view.rig;
        rig.shakeScale = c.reduceMotion ? 0.25 : 1;
        rig.baseFov = c.fov;
        rig.view = c.cameraView;
        Object.assign(rig.custom, { x: c.camX, y: c.camY, z: c.camZ, pitch: c.camPitch });
    }
    /**
     * Where a sound is from the car being followed: how far, for how loud, and
     * how far to the side. Screen right is the camera's right: +x for the
     * north-up camera, and turning with the car in the experimental views.
     */
    hear(x, z) {
        const f = this.view.focusId ? this.drawn.get(this.view.focusId) : undefined;
        if (!f)
            return { d: 0, pan: 0 };
        const dx = x - f.x;
        const dz = z - f.z;
        const e = this.view.rig.camera.matrixWorld.elements;
        // The camera's right, flattened onto the ground.
        const rl = Math.hypot(e[0], e[2]) || 1;
        const side = (dx * e[0] + dz * e[2]) / rl;
        return { d: Math.hypot(dx, dz), pan: Math.max(-1, Math.min(1, side / 30)) * 0.85 };
    }
    /** How fast something at (x, z) moving at (vx, vz) closes on the followed car, m/s. */
    closing(x, z, vx, vz) {
        const f = this.view.focusId ? this.drawn.get(this.view.focusId) : undefined;
        if (!f)
            return 0;
        const dx = f.x - x;
        const dz = f.z - z;
        const d = Math.hypot(dx, dz);
        return d < 0.5 ? 0 : ((vx - f.vx) * dx + (vz - f.vz) * dz) / d;
    }
    /**
     * Once a frame: engines for the nearest cars, the missiles in the
     * air, the countdown, the crossing, and the music's mood.
     */
    sound(raceTime, drawTime, dt) {
        const a = this.audio;
        if (!a)
            return;
        // Stopped mid-frame: the race ending runs `onOver`, which stops the
        // session, in the middle of this frame. Voicing engines after that
        // started ones nothing would ever stop, and they droned under the menus.
        if (!this.running)
            return;
        const me = this.player;
        const order = standings(this.world.entrants);
        const place = me ? order.indexOf(me) + 1 : 0;
        const lastLap = me !== null && this.mode !== 'hotlap' && this.world.laps > 1 && displayLap(me.lap, this.world.laps) >= this.world.laps;
        const racing = Boolean(me && this.world.started && !me.lap.finished);
        a.mood({
            muffled: (this.paused && !this.net) || (me !== null && me.wrecked > 0),
            finalLap: racing && lastLap,
            leading: racing && place === 1 && order.length > 1,
        });
        if (this.paused && !this.net) {
            a.silenceEngines();
            return;
        }
        // A place won or lost on the last lap is worth hearing.
        if (racing && lastLap && this.lastPlace > 0 && place !== this.lastPlace)
            a.place(place < this.lastPlace);
        this.lastPlace = racing ? place : 0;
        a.lowHealth(me && racing && me.wrecked <= 0 ? me.hp / SIM.weapons.health : 1);
        const voices = [];
        for (const e of this.world.entrants) {
            const c = this.drawn.get(e.id);
            const speed = Math.hypot(c.vx, c.vz);
            const heard = this.hear(c.x, c.z);
            voices.push({
                id: e.id, speed, throttle: e.remote ? this.guessThrottle(e.id, speed, c.boosting, dt) : c.throttle,
                boosting: c.boosting, distance: heard.d, pan: heard.pan, closing: this.closing(c.x, c.z, c.vx, c.vz),
                ground: e.wrecked > 0 || c.airborne ? 'tarmac' : ground(c.surfaceFront, c.surfaceRear),
                slide: c.airborne || e.wrecked > 0 ? 0 : Math.max(0, Math.abs(c.slip) - 0.12) * 3 + (c.handbrake && speed > 6 ? 0.5 : 0),
            });
        }
        a.engines(voices);
        const shots = [];
        for (const m of this.world.armoury.missiles) {
            if (m.done || drawTime < m.t0 || drawTime > m.end)
                continue;
            const p = missileAt(m, drawTime);
            shots.push({ key: `${m.owner}:${m.seq}`, heard: this.hear(p.x, p.z), closing: this.closing(p.x, p.z, m.dx * m.speed, m.dz * m.speed) });
        }
        a.missiles(shots);
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
    /**
     * Hotlap, once a frame: record this lap's path, and pose the ghost of the
     * record lap at the same moment into its own lap.
     */
    hotlapFrame(drawTime) {
        const me = this.player;
        if (!me)
            return;
        const lap = me.lap;
        const t = drawTime - lap.lapStart;
        if (lap.completed >= 0)
            this.trace.offer(this.world.time - lap.lapStart, me.car.x, me.car.z, me.car.yaw);
        // Ahead by the player's chosen lead, so it shows the line before you reach it.
        const lead = this.settings.current.ghostLead;
        // Near the line a lead runs past the end of the recorded lap: the ghost
        // is already on its next one, from the start of the recording.
        const rec = this.record;
        let at = t + lead;
        if (rec && at > rec.time)
            at -= rec.time;
        const g = rec?.ghost && lead >= 0 && lap.completed >= 0 && !lap.finished ? ghostAt(rec.ghost, at) : null;
        this.view.drawGhost(g);
    }
    handle(ev) {
        if (ev.kind === 'go')
            this.input.rumble(HAPTIC.go.weak, HAPTIC.go.strong, HAPTIC.go.ms);
        if (this.mode === 'hotlap' && ev.kind === 'lap' && ev.id === this.playerId && this.player) {
            // A new lap: the recording of the last one is handed over, and the car
            // is made whole — every hotlap starts from full health and a full turbo
            // (when there is one: the Track of the Day has none).
            this.lastTrace = this.trace.data;
            this.trace = new LapTrace();
            if (this.player.wrecked <= 0)
                this.player.hp = SIM.weapons.health;
            if (this.world.turbo)
                this.player.car.turbo = SIM.car.turboCapacity;
        }
        // The winner home (#23): fireworks over the line, confetti on it, and the crowd, in place of the finish's own notes.
        const won = ev.kind === 'finish' && this.mode !== 'hotlap' && this.world.entrants.filter((e) => e.lap.finished).length === 1;
        if (won) {
            const c = this.drawn.get(ev.id);
            const pops = c ? this.view.celebrate(c.x, c.z) : [];
            this.audio?.celebrate(pops, ev.id === this.playerId);
        }
        else {
            this.soundFor(ev);
        }
        const wreck = this.log.onEvent(ev, this.world.entrants);
        if (wreck)
            this.onWreck?.(wreck);
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
        else if (ev.kind === 'pickup' && ev.id === this.playerId) {
            this.input.rumble(HAPTIC.pickup.weak, HAPTIC.pickup.strong, HAPTIC.pickup.ms);
        }
        this.onEvent?.(ev);
        if (!this.net)
            this.checkOver();
    }
    /** A remote car's throttle, from how it gathers speed, smoothed over a few frames. */
    guessThrottle(id, speed, boosting, dt) {
        const r = this.revs.get(id) ?? { speed, throttle: 0.5 };
        const accel = dt > 0 ? (speed - r.speed) / dt : 0;
        const target = boosting ? 1 : Math.max(0, Math.min(1, 0.3 + accel / 7));
        r.throttle += (target - r.throttle) * (1 - Math.exp(-dt * 6));
        r.speed = speed;
        this.revs.set(id, r);
        return r.throttle;
    }
    soundFor(ev) {
        const a = this.audio;
        if (!a)
            return;
        const at = (id) => {
            const c = this.drawn.get(id);
            return c ? this.hear(c.x, c.z) : { d: 50, pan: 0 };
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
                else if (this.player && !this.spectating)
                    a.rivalHome();
                break;
            case 'bump': {
                const p = this.drawn.get(ev.a);
                const q = this.drawn.get(ev.b);
                if (p && q)
                    a.bump(this.hear((p.x + q.x) / 2, (p.z + q.z) / 2), ev.closing);
                break;
            }
            case 'damage':
                if (ev.id === this.playerId)
                    a.damage(ev.amount);
                break;
            case 'respawn':
                if (ev.id === this.playerId)
                    a.respawn();
                break;
            case 'pickup':
                if (ev.id === this.playerId)
                    a.pickup(ev.pick);
                break;
        }
    }
    /**
     * The race ends at whichever comes first: every car home; any car home
     * finishing its cool-down lap (not necessarily the winner's); or a minute
     * after the first car home.
     */
    checkOver() {
        if (this.over || this.mode !== 'race')
            return;
        const es = this.world.entrants;
        const all = es.every((e) => e.lap.finished);
        const cooled = es.some((e) => e.lap.cooledDown);
        const first = Math.min(...es.map((e) => e.lap.finishTime ?? Infinity));
        const graceUp = this.world.time - first > FINISH_GRACE;
        if (all || cooled || graceUp) {
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
    linkLines() {
        const links = this.net?.links;
        if (!links)
            return '';
        return this.world.entrants
            .filter((e) => e.remote && !isBotId(e.id))
            .map((e) => {
            const { link, rtt } = links(e.id);
            return `${this.cars.get(e.id)?.name ?? e.id}: ${link}${rtt !== null ? ` ${rtt.toFixed(0)} ms` : ''}`;
        })
            .join('\n');
    }
    hud() {
        const w = this.world;
        const order = standings(w.entrants);
        const e = this.player ?? order[0];
        const car = e.car;
        const last = e.lap.lapTimes.length ? e.lap.lapTimes[e.lap.lapTimes.length - 1] : null;
        // Hotlap: the latest checkpoint against the record's split there.
        const splits = e.lap.splits;
        if (splits.length !== this.seenSplits) {
            this.seenSplits = splits.length;
            const k = splits.length - 1;
            const ref = this.record?.splits[k];
            if (k >= 0 && ref !== undefined) {
                this.splitDelta = splits[k] - ref;
                this.splitAt = w.time;
            }
        }
        const lapTime = e.lap.completed >= 0 ? w.time - e.lap.lapStart : 0;
        return {
            mode: this.mode,
            lapTime,
            record: this.record?.time ?? null,
            split: this.splitAt >= 0 && w.time - this.splitAt < 3 ? { delta: this.splitDelta, age: w.time - this.splitAt } : null,
            weapons: w.weapons,
            turboOn: w.turbo,
            speedKmh: Math.hypot(car.vx, car.vz) * 3.6,
            turbo: car.turbo,
            fps: this.fps,
            drawCalls: this.view.drawCalls,
            links: this.linkLines(),
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
/** What the ear hears of the two axles' surfaces: the rougher one. */
function ground(front, rear) {
    const rank = ['oil', 'tarmac', 'kerb', 'dirt', 'grass', 'water'];
    const of = (x) => (x === Surface.Dirt ? 'dirt' : x === Surface.Grass ? 'grass' : x === Surface.Oil ? 'oil'
        : x === Surface.Kerb ? 'kerb' : x === Surface.Water ? 'water' : 'tarmac');
    const a = of(front);
    const b = of(rear);
    return rank.indexOf(a) >= rank.indexOf(b) ? a : b;
}
//# sourceMappingURL=RaceSession.js.map