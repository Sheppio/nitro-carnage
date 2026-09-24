import type { QualityId } from './config.js';
import { HAPTIC } from './input/settings.js';
import type { SettingsStore } from './input/settings.js';
import type { InputManager } from './input/InputManager.js';
import { GameView } from './render/GameView.js';
import { createCar } from './sim/car.js';
import type { CarState } from './sim/car.js';
import { interpolateCar } from './sim/interpolate.js';
import { colourOf } from './sim/palette.js';
import type { TrackDef } from './sim/track/TrackDef.js';
import { World } from './sim/World.js';
import type { Entrant } from './sim/World.js';
import type { DriveIntent } from './types.js';
import { IDLE_INTENT } from './types.js';

export interface HudSnapshot {
  speedKmh: number;
  turbo: number;
  fps: number;
  drawCalls: number;
}

/**
 * One car on one track: the M1 free drive.
 *
 * Owns the frame loop. Input is read once per frame; the world takes as many
 * fixed steps as fit; the view draws the car interpolated between its last
 * two steps. Later milestones grow this into a race with rivals, but the
 * shape — read, step, draw — stays.
 */
export class DriveSession {
  readonly world: World;
  readonly view: GameView;
  readonly player: Entrant;
  private raf = 0;
  private last = 0;
  private intent: DriveIntent = { ...IDLE_INTENT };
  private drawn = new Map<string, CarState>();
  private frames = 0;
  private fpsAt = 0;
  private fps = 0;
  private running = false;
  /** Set by tests: when true the loop keeps rendering but stops stepping. */
  frozen = false;
  onHud: ((hud: HudSnapshot) => void) | null = null;

  constructor(
    host: HTMLElement,
    def: TrackDef,
    private input: InputManager,
    settings: SettingsStore,
    quality: QualityId,
    colourId: string,
  ) {
    this.world = new World(def);
    this.player = this.world.addCar('you', 0, () => this.takeIntent());
    this.view = new GameView(host, this.world.track, quality);
    this.view.addCar('you', colourOf(colourId).colour);
    this.drawn.set('you', createCar(0, 0, 0));
    this.view.rig.shakeScale = settings.current.reduceMotion ? 0.25 : 1;
    this.view.onJolt = (kind, k) => {
      const p = kind === 'landing' ? HAPTIC.landing : HAPTIC.crash;
      this.input.rumble(p.weak * k, p.strong * k, p.ms);
    };
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
    this.view.dispose();
  }

  /** Edge-triggered inputs are consumed by the first step that sees them. */
  private takeIntent(): DriveIntent {
    const out = { ...this.intent };
    this.intent.fireFront = false;
    this.intent.fireRear = false;
    return out;
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

    const alpha = this.frozen ? 1 : this.world.advance(dt);
    for (const e of this.world.entrants) {
      interpolateCar(e.prev, e.car, alpha, this.drawn.get(e.id)!);
    }
    this.view.render(this.drawn, dt);

    this.frames++;
    if (now - this.fpsAt >= 500) {
      this.fps = (this.frames * 1000) / (now - this.fpsAt);
      this.frames = 0;
      this.fpsAt = now;
    }
    const car = this.player.car;
    this.onHud?.({
      speedKmh: Math.hypot(car.vx, car.vz) * 3.6,
      turbo: car.turbo,
      fps: this.fps,
      drawCalls: this.view.drawCalls,
    });

    this.raf = requestAnimationFrame(this.frame);
  };

  /** Interpolated states as last drawn, for the debug hooks. */
  get drawnStates(): ReadonlyMap<string, CarState> {
    return this.drawn;
  }
}
