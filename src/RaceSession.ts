import { STEP } from './config.js';
import type { QualityId } from './config.js';
import { HAPTIC } from './input/settings.js';
import type { SettingsStore } from './input/settings.js';
import type { InputManager } from './input/InputManager.js';
import type { NetRace } from './net/NetRace.js';
import { GameView } from './render/GameView.js';
import { autopilot, createAutopilot, SKILLS } from './sim/autopilot.js';
import { BOT_NAMES } from './sim/bots.js';
import { createCar } from './sim/car.js';
import type { CarState } from './sim/car.js';
import { interpolateCar } from './sim/interpolate.js';
import { COLOUR_ORDER, colourOf } from './sim/palette.js';
import { displayLap, standings } from './sim/race.js';
import { racingLine } from './sim/racingLine.js';
import type { TrackDef } from './sim/track/TrackDef.js';
import { World } from './sim/World.js';
import type { Entrant, RaceEvent } from './sim/World.js';
import type { DriveIntent } from './types.js';
import { IDLE_INTENT } from './types.js';

/** Seconds of lights before GO, offline. */
const COUNTDOWN = 3;
/** After the player finishes an offline race, how long the others get. */
const FINISH_GRACE = 25;

/** Offline race, free drive, or a race in a networked room. */
export type SessionMode = 'race' | 'free' | 'net';

export interface CarInfo {
  id: string;
  name: string;
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
  private playerFinishedAt: number | null = null;
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

  constructor(host: HTMLElement, opts: SessionOptions, private input: InputManager, settings: SettingsStore, net: NetRace | null = null) {
    this.mode = opts.mode;
    this.net = net;
    this.autopilot = settings.current.autopilot;

    if (net && net.world) {
      this.world = net.world;
      this.player = net.me;
      this.playerId = net.playerId;
      for (const e of this.world.entrants) {
        const info = net.carInfo(e.id);
        this.addInfo(e.id, info.you ? 'YOU' : info.name, info.colour, info.you);
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
      this.world = new World(opts.track, { laps: race ? opts.laps : 0, countdown: race ? COUNTDOWN : 0 });
      this.playerId = 'you';
      // The player starts mid-grid in a race — there is somebody to catch and
      // somebody to hold off — and on pole in a free drive.
      const bots = race ? Math.min(5, opts.bots) : 0;
      const playerSlot = race ? Math.min(bots, 3) : 0;
      const colours = COLOUR_ORDER.filter((c) => c !== opts.colourId);
      this.player = this.world.addCar('you', playerSlot, () => this.playerIntent());
      this.addInfo('you', 'YOU', opts.colourId, true);
      let slot = 0;
      for (let b = 0; b < bots; b++) {
        if (slot === playerSlot) slot++;
        const id = `b${b}`;
        this.world.addBot(id, slot, SKILLS[b % SKILLS.length]!, 1000 + b);
        this.addInfo(id, BOT_NAMES[b % BOT_NAMES.length]!, colours[b % colours.length]!, false);
        slot++;
      }
    }

    this.view = new GameView(host, this.world.track, opts.quality);
    for (const e of this.world.entrants) {
      this.view.addCar(e.id, this.cars.get(e.id)!.colour);
      this.drawn.set(e.id, createCar(e.car.x, e.car.z, e.car.yaw));
    }
    this.view.focusId = this.player?.id ?? this.world.entrants[0]?.id ?? null;
    this.view.rig.shakeScale = settings.current.reduceMotion ? 0.25 : 1;
    this.view.onJolt = (kind, k) => {
      const p = kind === 'landing' ? HAPTIC.landing : HAPTIC.crash;
      this.input.rumble(p.weak * k, p.strong * k, p.ms);
    };
  }

  get spectating(): boolean {
    return this.player === null;
  }

  private addInfo(id: string, name: string, colourId: string, you: boolean): void {
    const c = colourOf(colourId);
    this.cars.set(id, { id, name, colour: c.colour, css: c.cssColour, you });
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
      return autopilot(this.pilot, me.car, this.world.track, line, this.world.rivalsOf(me.id), this.world.time, STEP);
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
    for (const e of this.world.entrants) interpolateCar(e.prev, e.car, alpha, this.drawn.get(e.id)!);
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

  private handle(ev: RaceEvent): void {
    if (ev.kind === 'go') this.input.rumble(HAPTIC.go.weak, HAPTIC.go.strong, HAPTIC.go.ms);
    if (ev.kind === 'finish' && ev.id === this.playerId) this.playerFinishedAt = ev.time;
    this.onEvent?.(ev);
    if (!this.net) this.checkOver();
  }

  private checkOver(): void {
    if (this.over || this.mode !== 'race') return;
    const all = this.world.entrants.every((e) => e.lap.finished);
    const graceUp = this.playerFinishedAt !== null && this.world.time - this.playerFinishedAt > FINISH_GRACE;
    if (all || graceUp) {
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

  hud(): HudSnapshot {
    const w = this.world;
    const order = standings(w.entrants);
    const e = this.player ?? order[0]!;
    const car = e.car;
    const last = e.lap.lapTimes.length ? e.lap.lapTimes[e.lap.lapTimes.length - 1]! : null;
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
    };
  }

  /** Interpolated states as last drawn, for the minimap, the arrows and the debug hooks. */
  get drawnStates(): ReadonlyMap<string, CarState> {
    return this.drawn;
  }
}
