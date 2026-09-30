import { STEP } from './config.js';
import type { QualityId } from './config.js';
import { HAPTIC } from './input/settings.js';
import type { SettingsStore } from './input/settings.js';
import type { InputManager } from './input/InputManager.js';
import type { NetRace } from './net/NetRace.js';
import { GameView } from './render/GameView.js';
import type { AudioEngine, Ground, Heard, MissileVoiceInput } from './audio/AudioEngine.js';
import { crossingWarning, trainAt } from './sim/train.js';
import { ghostAt, LapTrace } from './sim/ghost.js';
import { SIM } from './config.js';
import { autopilot, createAutopilot, skillFor, SKILLS } from './sim/autopilot.js';
import { botNames, isBotId } from './sim/bots.js';
import { createCar } from './sim/car.js';
import { Surface } from './sim/surfaces.js';
import { missileAt } from './sim/weapons.js';
import type { CarState } from './sim/car.js';
import { interpolateCar } from './sim/interpolate.js';
import { COLOUR_ORDER, colourOf } from './sim/palette.js';
import { bodyCode, botLook, DEFAULT_LOOK, lockedLook } from './sim/look.js';
import type { BodyId, CarLook } from './sim/look.js';
import { displayLap, standings } from './sim/race.js';
import { RaceLog } from './sim/raceLog.js';
import type { WreckEntry } from './sim/raceLog.js';
import { racingLine } from './sim/racingLine.js';
import type { TrackDef } from './sim/track/TrackDef.js';
import { World } from './sim/World.js';
import type { Entrant, RaceEvent } from './sim/World.js';
import type { DriveIntent } from './types.js';
import { IDLE_INTENT } from './types.js';

/** Seconds the camera takes to drop from above the grid at the start. */
const INTRO = 2.6;
/** Seconds of lights before GO, offline. */
const COUNTDOWN = 3;
/** After the player finishes an offline race, how long the others get. */
/** Seconds after the first car home before the race ends regardless. */
const FINISH_GRACE = 60;

/** Offline race, free drive, or a race in a networked room. */
/** An offline race, a solo hotlap (M7: replaces free drive), or a race in a room. */
export type SessionMode = 'race' | 'hotlap' | 'net';

/** A best lap worth beating: its time and the split at each checkpoint. */
export interface LapRecord {
  time: number;
  splits: number[];
  /** The lap's recorded path, for the ghost (see `sim/ghost.ts`). */
  ghost?: number[];
}

export interface CarInfo {
  id: string;
  name: string;
  look: CarLook;
  colour: number;
  css: string;
  you: boolean;
}

export interface HudSnapshot {
  mode: SessionMode;
  speedKmh: number;
  turbo: number;
  fps: number;
  drawCalls: number;
  /** For the debug readout: how each other player's car reaches us, and the round trip. Empty offline. */
  links: string;
  /** Seconds until GO; 0 once racing. */
  countdown: number;
  /** Seconds since GO (negative during the countdown). */
  raceTime: number;
  lap: number;
  laps: number;
  position: number;
  of: number;
  lastLap: number | null;
  bestLap: number | null;
  wrongWay: boolean;
  finished: boolean;
  autopilot: boolean;
  spectating: boolean;
  paused: boolean;
  /** Seconds into the lap being driven (hotlap). */
  lapTime: number;
  /** The all-time best on this track, kept by the page (hotlap). */
  record: number | null;
  /** The latest checkpoint split against the record: seconds up (negative) or down, and how long ago. */
  split: { delta: number; age: number } | null;
  /** Weapons in this race at all (off in a hotlap or a race-only room). */
  weapons: boolean;
  /** Turbo in this race at all; off, the meter is not shown. */
  turboOn: boolean;
  /** The followed car's health (0-100), ammo, and whether it is wrecked. */
  hp: number;
  ammo: { front: number; rear: number; mines: number };
  wrecked: boolean;
}

export interface ResultRow {
  position: number;
  car: CarInfo;
  /** Race time at the finish, from GO; null for a car still running. */
  time: number | null;
  best: number | null;
  laps: number;
}

export interface SessionOptions {
  mode: SessionMode;
  track: TrackDef;
  quality: QualityId;
  colourId: string;
  bots: number;
  laps: number;
  /** The player's own look (offline; online it comes from the room). */
  look?: CarLook;
  /** The player's name (offline; online it comes from the room). Unset, YOU. */
  name?: string;
  /** Weapons on; off makes a race-only race (M7). A hotlap never has them. */
  weapons?: boolean;
  /** Boxes on the road in a race (the default). */
  pickups?: boolean;
  /** Turbo on (the default). */
  turbo?: boolean;
  /** Every car on the grid in this body; unset, everybody drives their own. */
  body?: BodyId;
}

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
  readonly world: World;
  readonly view: GameView;
  /** This client's car, or null while spectating. */
  readonly player: Entrant | null;
  readonly playerId: string;
  readonly cars = new Map<string, CarInfo>();
  readonly mode: SessionMode;
  private raf = 0;
  private last = 0;
  private intent: DriveIntent = { ...IDLE_INTENT };
  private drawn = new Map<string, CarState>();
  private frames = 0;
  private fpsAt = 0;
  private fps = 0;
  private running = false;
  private over = false;
  private pilot = createAutopilot(7, SKILLS[0]!);
  private net: NetRace | null;
  private offNet: Array<() => void> = [];
  /** Set by tests: when true the loop keeps rendering but stops stepping. */
  frozen = false;
  /** The pause menu is open: offline that stops the world; online it only holds our car. */
  paused = false;
  /** Drive the player's car with the autopilot (real input still wins). */
  autopilot: boolean;
  onHud: ((hud: HudSnapshot) => void) | null = null;
  onEvent: ((ev: RaceEvent) => void) | null = null;
  onOver: ((rows: ResultRow[]) => void) | null = null;
  /** A car was wrecked: the kill feed. */
  onWreck: ((w: WreckEntry) => void) | null = null;
  /** This race's story so far: wrecks, hits and the grid, for the feed, the awards and the room's tally. */
  readonly log = new RaceLog();
  /** Sound, if the page has it. Set by the page after construction. */
  audio: AudioEngine | null = null;
  /** The best lap on record for this track (hotlap); the page loads and saves it. */
  record: LapRecord | null = null;
  /** The lap being recorded (hotlap), and the recording of the lap just finished. */
  private trace = new LapTrace();
  lastTrace: number[] = [];
  private splitAt = -1;
  private splitDelta = 0;
  private seenSplits = 0;
  private lastPip = -1;
  private lastLight = -1;
  private warned = false;
  /** The player's place last frame, for the last-lap overtakes. */
  private lastPlace = 0;
  /** Remote cars' throttle, guessed from how they speed up: the network does not carry it. */
  private revs = new Map<string, { speed: number; throttle: number }>();

  constructor(host: HTMLElement, opts: SessionOptions, private input: InputManager, readonly settings: SettingsStore, net: NetRace | null = null) {
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
      this.offNet.push(
        net.events.on('race', ({ ev }) => this.handle(ev)),
        net.events.on('results', ({ rows }) => {
          if (this.over) return;
          this.over = true;
          this.onOver?.(rows.map((r) => this.row(r.position, r.id, r.time, r.laps)));
        }),
      );
    } else {
      const race = opts.mode === 'race';
      this.world = new World(opts.track, {
        laps: race ? opts.laps : 0, countdown: race ? COUNTDOWN : 0, weapons: race && opts.weapons !== false,
        pickups: opts.pickups !== false, turbo: opts.turbo !== false,
        // A hotlap starts a quarter of a lap back, so the first timed lap is a flying one.
        flyingStart: race ? 0 : 0.25,
      });
      this.playerId = 'you';
      // The player starts mid-grid in a race — there is somebody to catch and
      // somebody to hold off — and on pole in a free drive.
      const bots = race ? Math.min(5, opts.bots) : 0;
      const playerSlot = race ? Math.min(bots, 3) : 0;
      const colours = COLOUR_ORDER.filter((c) => c !== opts.colourId);
      this.player = this.world.addCar('you', playerSlot, () => this.playerIntent());
      const lock = race ? bodyCode(opts.body) : 0;
      this.addInfo('you', opts.name || 'YOU', opts.colourId, true, lockedLook(opts.look ?? DEFAULT_LOOK, lock));
      let slot = 0;
      // New names every race: a quick race has no room to agree with.
      const names = botNames(Math.floor(Math.random() * 2 ** 31), bots);
      for (let b = 0; b < bots; b++) {
        if (slot === playerSlot) slot++;
        const id = `b${b}`;
        this.world.addBot(id, slot, skillFor(b, settings.current.botLevel), 1000 + b);
        this.addInfo(id, names[b]!, colours[b % colours.length]!, false, lockedLook(botLook(1000 + b), lock));
        slot++;
      }
    }

    this.view = new GameView(host, this.world.track, opts.quality);
    this.view.setPickups(this.world.pickups);
    for (const e of this.world.entrants) {
      const info = this.cars.get(e.id)!;
      this.view.addCar(e.id, info.colour, info.look);
      this.drawn.set(e.id, createCar(e.car.x, e.car.z, e.car.yaw));
    }
    this.view.focusId = this.player?.id ?? this.world.entrants[0]?.id ?? null;
    // The hotlap ghost, built now so its first appearance does not stall the game.
    if (this.mode === 'hotlap' && this.player) this.view.prepareGhost();
    this.view.rig.shakeScale = settings.current.reduceMotion ? 0.25 : 1;
    this.view.rig.baseFov = settings.current.fov;
    this.view.onJolt = (kind, k) => {
      const p = kind === 'landing' ? HAPTIC.landing : HAPTIC.crash;
      this.input.rumble(p.weak * k, p.strong * k, p.ms);
      if (kind === 'landing') this.audio?.landing(k);
      else this.audio?.crash(k);
    };
  }

  get spectating(): boolean {
    return this.player === null;
  }

  private addInfo(id: string, name: string, colourId: string, you: boolean, look: CarLook): void {
    const c = colourOf(colourId);
    this.cars.set(id, { id, name, colour: c.colour, css: c.cssColour, you, look });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.input.setInRace(true);
    this.last = performance.now();
    this.fpsAt = this.last;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.audio?.silenceEngines();
    this.audio?.mood(null);
    this.input.setInRace(false);
    for (const off of this.offNet) off();
    this.offNet = [];
    if (this.net) this.net.drive = () => IDLE_INTENT;
    this.view.dispose();
  }

  /**
   * What the player's car does this step. Edge-triggered inputs are consumed
   * by the first step that sees them. With the pause menu open online, the car
   * is held on the brakes — a race with other people in it cannot stop. Once
   * the player has finished, or with the autopilot on and nobody touching the
   * controls, the autopilot drives.
   */
  private playerIntent(): DriveIntent {
    const me = this.player;
    if (!me) return IDLE_INTENT;
    if (this.paused) return { ...IDLE_INTENT, brake: me.car.forward > 0.5 ? 1 : 0 };
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

  private frame = (now: number): void => {
    if (!this.running) return;
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

    let alpha: number;
    if (this.net) {
      // The room drives the world; frozen/paused never stop a shared race.
      alpha = this.net.update();
    } else {
      alpha = this.frozen || this.paused ? 1 : this.world.advance(dt);
      for (const ev of this.world.drain()) this.handle(ev);
    }
    // The race can end inside this frame: a finish runs `onOver`, which stops
    // the session and frees the scene. Drawing on would upload the whole
    // scene again to a renderer the next race shares, and nothing would ever
    // free it: a race's worth of GPU memory lost per race, and the judder
    // that came with it on an Xbox by the second race.
    if (!this.running) return;
    for (const e of this.world.entrants) {
      interpolateCar(e.prev, e.car, alpha, this.drawn.get(e.id)!);
      this.view.setCondition(e.id, e.hp, e.wrecked > 0, e.ghost > 0);
    }
    // The cars are drawn `1 - alpha` of a step behind the latest one; the shots are drawn at the same moment.
    const drawTime = this.world.time - (1 - alpha) * STEP;
    this.view.drawWeapons(this.world.armoury, drawTime, this.paused && !this.net ? 0 : dt, this.drawn.values());
    this.view.drawHazards(drawTime - this.world.goTime, dt);
    this.view.drawPickups(drawTime, this.paused && !this.net ? 0 : dt);
    if (this.mode === 'hotlap') this.hotlapFrame(drawTime);
    this.sound(drawTime - this.world.goTime, drawTime, dt);
    this.startFrame();
    // Spectating: follow whoever is leading.
    if (!this.player) this.view.focusId = standings(this.world.entrants)[0]?.id ?? this.view.focusId;
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
  private startFrame(): void {
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
   * Where a sound is from the car being followed: how far, for how loud, and
   * how far to the side. The camera is north-up, so screen right is +x.
   */
  private hear(x: number, z: number): Heard {
    const f = this.view.focusId ? this.drawn.get(this.view.focusId) : undefined;
    if (!f) return { d: 0, pan: 0 };
    const dx = x - f.x;
    return { d: Math.hypot(dx, z - f.z), pan: Math.max(-1, Math.min(1, dx / 30)) * 0.85 };
  }

  /** How fast something at (x, z) moving at (vx, vz) closes on the followed car, m/s. */
  private closing(x: number, z: number, vx: number, vz: number): number {
    const f = this.view.focusId ? this.drawn.get(this.view.focusId) : undefined;
    if (!f) return 0;
    const dx = f.x - x;
    const dz = f.z - z;
    const d = Math.hypot(dx, dz);
    return d < 0.5 ? 0 : ((vx - f.vx) * dx + (vz - f.vz) * dz) / d;
  }

  /**
   * Once a frame: engines for the nearest cars, the missiles in the
   * air, the countdown, the crossing, and the music's mood.
   */
  private sound(raceTime: number, drawTime: number, dt: number): void {
    const a = this.audio;
    if (!a) return;
    // Stopped mid-frame: the race ending runs `onOver`, which stops the
    // session, in the middle of this frame. Voicing engines after that
    // started ones nothing would ever stop, and they droned under the menus.
    if (!this.running) return;
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
    if (racing && lastLap && this.lastPlace > 0 && place !== this.lastPlace) a.place(place < this.lastPlace);
    this.lastPlace = racing ? place : 0;
    a.lowHealth(me && racing && me.wrecked <= 0 ? me.hp / SIM.weapons.health : 1);
    const voices = [];
    for (const e of this.world.entrants) {
      const c = this.drawn.get(e.id)!;
      const speed = Math.hypot(c.vx, c.vz);
      const heard = this.hear(c.x, c.z);
      voices.push({
        id: e.id, speed, throttle: e.remote ? this.guessThrottle(e.id, speed, c.boosting, dt) : c.throttle,
        boosting: c.boosting, distance: heard.d, pan: heard.pan, closing: this.closing(c.x, c.z, c.vx, c.vz),
        ground: e.wrecked > 0 || c.airborne ? 'tarmac' as Ground : ground(c.surfaceFront, c.surfaceRear),
        slide: c.airborne || e.wrecked > 0 ? 0 : Math.max(0, Math.abs(c.slip) - 0.12) * 3 + (c.handbrake && speed > 6 ? 0.5 : 0),
      });
    }
    a.engines(voices);
    const shots: MissileVoiceInput[] = [];
    for (const m of this.world.armoury.missiles) {
      if (m.done || drawTime < m.t0 || drawTime > m.end) continue;
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
      if (warn) a.bell(this.hear(rail.x, rail.z));
      const tr = trainAt(this.world.track, raceTime);
      if (warn && !this.warned && tr) a.horn(this.hear(rail.x, rail.z));
      this.warned = warn;
    }
  }

  /**
   * Hotlap, once a frame: record this lap's path, and pose the ghost of the
   * record lap at the same moment into its own lap.
   */
  private hotlapFrame(drawTime: number): void {
    const me = this.player;
    if (!me) return;
    const lap = me.lap;
    const t = drawTime - lap.lapStart;
    if (lap.completed >= 0) this.trace.offer(this.world.time - lap.lapStart, me.car.x, me.car.z, me.car.yaw);
    // Ahead by the player's chosen lead, so it shows the line before you reach it.
    const lead = this.settings.current.ghostLead;
    // Near the line a lead runs past the end of the recorded lap: the ghost
    // is already on its next one, from the start of the recording.
    const rec = this.record;
    let at = t + lead;
    if (rec && at > rec.time) at -= rec.time;
    const g = rec?.ghost && lead >= 0 && lap.completed >= 0 && !lap.finished ? ghostAt(rec.ghost, at) : null;
    this.view.drawGhost(g);
  }

  private handle(ev: RaceEvent): void {
    if (ev.kind === 'go') this.input.rumble(HAPTIC.go.weak, HAPTIC.go.strong, HAPTIC.go.ms);
    if (this.mode === 'hotlap' && ev.kind === 'lap' && ev.id === this.playerId && this.player) {
      // A new lap: the recording of the last one is handed over, and the car
      // is made whole — every hotlap starts from full health and a full turbo
      // (when there is one: the Track of the Day has none).
      this.lastTrace = this.trace.data;
      this.trace = new LapTrace();
      if (this.player.wrecked <= 0) this.player.hp = SIM.weapons.health;
      if (this.world.turbo) this.player.car.turbo = SIM.car.turboCapacity;
    }
    this.soundFor(ev);
    const wreck = this.log.onEvent(ev, this.world.entrants);
    if (wreck) this.onWreck?.(wreck);
    const focus = this.view.focusId ? this.drawn.get(this.view.focusId) : undefined;
    if (ev.kind === 'hit') {
      this.view.explode(ev.x, ev.z, ev.weapon === 'mine' ? 1.4 : 1, focus);
      if (ev.id === this.playerId) this.input.rumble(HAPTIC.damage.weak, HAPTIC.damage.strong, HAPTIC.damage.ms);
    } else if (ev.kind === 'blast') {
      this.view.explode(ev.x, ev.z, 0.6, focus);
    } else if (ev.kind === 'wreck') {
      this.view.explode(ev.x, ev.z, 2, focus);
      if (ev.id === this.playerId) this.input.rumble(HAPTIC.wreck.weak, HAPTIC.wreck.strong, HAPTIC.wreck.ms);
    } else if (ev.kind === 'fire' && ev.id === this.playerId) {
      this.input.rumble(HAPTIC.fire.weak, HAPTIC.fire.strong, HAPTIC.fire.ms);
    } else if (ev.kind === 'pickup' && ev.id === this.playerId) {
      this.input.rumble(HAPTIC.pickup.weak, HAPTIC.pickup.strong, HAPTIC.pickup.ms);
    }
    this.onEvent?.(ev);
    if (!this.net) this.checkOver();
  }

  /** A remote car's throttle, from how it gathers speed, smoothed over a few frames. */
  private guessThrottle(id: string, speed: number, boosting: boolean, dt: number): number {
    const r = this.revs.get(id) ?? { speed, throttle: 0.5 };
    const accel = dt > 0 ? (speed - r.speed) / dt : 0;
    const target = boosting ? 1 : Math.max(0, Math.min(1, 0.3 + accel / 7));
    r.throttle += (target - r.throttle) * (1 - Math.exp(-dt * 6));
    r.speed = speed;
    this.revs.set(id, r);
    return r.throttle;
  }

  private soundFor(ev: RaceEvent): void {
    const a = this.audio;
    if (!a) return;
    const at = (id: string): Heard => {
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
        if (ev.id === this.playerId && ev.lap + 1 <= this.world.laps) a.lap(ev.lap + 1 === this.world.laps);
        break;
      case 'finish':
        if (ev.id === this.playerId) a.finish();
        else if (this.player && !this.spectating) a.rivalHome();
        break;
      case 'bump': {
        const p = this.drawn.get(ev.a);
        const q = this.drawn.get(ev.b);
        if (p && q) a.bump(this.hear((p.x + q.x) / 2, (p.z + q.z) / 2), ev.closing);
        break;
      }
      case 'damage':
        if (ev.id === this.playerId) a.damage(ev.amount);
        break;
      case 'respawn':
        if (ev.id === this.playerId) a.respawn();
        break;
      case 'pickup':
        if (ev.id === this.playerId) a.pickup(ev.pick);
        break;
    }
  }

  /**
   * The race ends at whichever comes first: every car home; any car home
   * finishing its cool-down lap (not necessarily the winner's); or a minute
   * after the first car home.
   */
  private checkOver(): void {
    if (this.over || this.mode !== 'race') return;
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

  private row(position: number, id: string, time: number | null, laps: number): ResultRow {
    const e = this.world.entrants.find((x) => x.id === id);
    return { position, car: this.cars.get(id)!, time, best: e?.lap.best ?? null, laps };
  }

  /** Current race order, as table rows. */
  results(): ResultRow[] {
    return standings(this.world.entrants).map((e, i) =>
      this.row(i + 1, e.id, e.lap.finishTime === null ? null : e.lap.finishTime - this.world.goTime, Math.max(0, e.lap.completed)),
    );
  }

  private linkLines(): string {
    const links = this.net?.links;
    if (!links) return '';
    return this.world.entrants
      .filter((e) => e.remote && !isBotId(e.id))
      .map((e) => {
        const { link, rtt } = links(e.id);
        return `${this.cars.get(e.id)?.name ?? e.id}: ${link}${rtt !== null ? ` ${rtt.toFixed(0)} ms` : ''}`;
      })
      .join('\n');
  }

  hud(): HudSnapshot {
    const w = this.world;
    const order = standings(w.entrants);
    const e = this.player ?? order[0]!;
    const car = e.car;
    const last = e.lap.lapTimes.length ? e.lap.lapTimes[e.lap.lapTimes.length - 1]! : null;
    // Hotlap: the latest checkpoint against the record's split there.
    const splits = e.lap.splits;
    if (splits.length !== this.seenSplits) {
      this.seenSplits = splits.length;
      const k = splits.length - 1;
      const ref = this.record?.splits[k];
      if (k >= 0 && ref !== undefined) {
        this.splitDelta = splits[k]! - ref;
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
  get drawnStates(): ReadonlyMap<string, CarState> {
    return this.drawn;
  }
}

/** What the ear hears of the two axles' surfaces: the rougher one. */
function ground(front: Surface, rear: Surface): Ground {
  const rank: Ground[] = ['oil', 'tarmac', 'kerb', 'dirt', 'grass', 'water'];
  const of = (x: Surface): Ground => (x === Surface.Dirt ? 'dirt' : x === Surface.Grass ? 'grass' : x === Surface.Oil ? 'oil'
    : x === Surface.Kerb ? 'kerb' : x === Surface.Water ? 'water' : 'tarmac');
  const a = of(front);
  const b = of(rear);
  return rank.indexOf(a) >= rank.indexOf(b) ? a : b;
}
