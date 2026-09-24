import { SIM } from '../config.js';
import type { HudSnapshot, RaceSession, ResultRow } from '../RaceSession.js';
import type { RaceEvent } from '../sim/World.js';
import { Minimap } from './Minimap.js';
import { RivalArrows } from './RivalArrows.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/** m:ss.cc */
export function formatTime(t: number | null): string {
  if (t === null || !Number.isFinite(t)) return '—';
  const neg = t < 0;
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  return `${neg ? '-' : ''}${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export function ordinal(n: number): string {
  const s = ['TH', 'ST', 'ND', 'RD'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * The race HUD: position, lap and times, the countdown, banners, minimap and
 * rival arrows, plus the results table. Reads snapshots; owns no game state.
 */
export class Hud {
  private minimap: Minimap;
  private arrows: RivalArrows;
  private textAt = 0;
  private bannerUntil = 0;
  private bannerText = '';
  private bannerWarn = false;

  constructor(private session: RaceSession, debug: boolean) {
    this.minimap = new Minimap($<HTMLCanvasElement>('hud-minimap'), session.world.track);
    this.arrows = new RivalArrows($('hud-arrows'));
    const race = session.mode === 'race';
    $('hud-race').hidden = !race;
    $('hud-minimap').hidden = !race;
    $('hud-debug').hidden = !debug;
    this.banner('', 0);
  }

  update(hud: HudSnapshot): void {
    const now = performance.now();
    $('hud-turbo').style.transform = `scaleX(${Math.max(0, hud.turbo / SIM.car.turboCapacity)})`;

    // Countdown: 3, 2, 1, GO — GO lingers for a second after the lights.
    const cd = $('hud-countdown');
    if (hud.mode === 'race' && hud.countdown > 0) {
      cd.textContent = String(Math.ceil(hud.countdown));
      cd.classList.remove('go');
    } else if (hud.mode === 'race' && hud.raceTime < 1) {
      cd.textContent = 'GO';
      cd.classList.add('go');
    } else {
      cd.textContent = '';
    }

    const bannerEl = $('hud-banner');
    if (hud.wrongWay) {
      bannerEl.textContent = 'WRONG WAY';
      bannerEl.classList.add('warn');
    } else if (now < this.bannerUntil) {
      bannerEl.textContent = this.bannerText;
      bannerEl.classList.toggle('warn', this.bannerWarn);
    } else {
      bannerEl.textContent = '';
    }

    // Cars: minimap every frame (it is cheap), arrows every frame (they move).
    const s = this.session;
    const cars: { id: string; x: number; z: number; css: string; you: boolean }[] = [];
    const screen: { id: string; css: string; x: number; y: number; onScreen: boolean }[] = [];
    for (const [id, st] of s.drawnStates) {
      const info = s.cars.get(id);
      if (!info) continue;
      cars.push({ id, x: st.x, z: st.z, css: info.css, you: info.you });
      if (!info.you) {
        const p = s.view.toScreen(st.x, 1, st.z);
        screen.push({ id, css: info.css, ...p });
      }
    }
    if (hud.mode === 'race') this.minimap.draw(cars);
    const rect = s.view.renderer.domElement.getBoundingClientRect();
    this.arrows.update(screen, rect.width, rect.height);

    // Text at 10 Hz: nobody reads faster, and the DOM is not free.
    if (now - this.textAt < 100) return;
    this.textAt = now;
    $('hud-speed').textContent = String(Math.round(hud.speedKmh));
    $('hud-auto').hidden = !hud.autopilot;
    if (hud.mode === 'race') {
      $('hud-pos').textContent = String(hud.position);
      $('hud-of').textContent = `/${hud.of}`;
      $('hud-lap').textContent = String(hud.lap);
      $('hud-laps').textContent = `/${hud.laps}`;
      $('hud-time').textContent = formatTime(Math.max(0, hud.raceTime));
      $('hud-last').textContent = formatTime(hud.lastLap);
      $('hud-best').textContent = formatTime(hud.bestLap);
    }
    $('hud-debug').textContent = `${hud.fps.toFixed(0)} fps\n${hud.drawCalls} draws`;
  }

  /** React to a race event: lap banners, the final lap, the finish. */
  event(ev: RaceEvent): void {
    const w = this.session.world;
    if (ev.kind === 'lap' && ev.id === 'you') {
      const next = ev.lap + 1;
      if (next === w.laps) this.banner('FINAL LAP', 2.2);
      else if (next < w.laps) this.banner(`LAP ${next}  ·  ${formatTime(ev.lapTime)}`, 2.2);
    } else if (ev.kind === 'finish' && ev.id === 'you') {
      const pos = this.session.results().findIndex((r) => r.car.you) + 1;
      this.banner(`FINISHED ${ordinal(pos)}`, 8);
    } else if (ev.kind === 'finish') {
      const info = this.session.cars.get(ev.id);
      const done = w.entrants.filter((e) => e.lap.finished).length;
      if (info && done === 1) this.banner(`${info.name} WINS`, 2.5);
    } else if (ev.kind === 'respawn' && ev.id === 'you') {
      this.banner('BACK ON TRACK', 1.5, true);
    }
  }

  private banner(text: string, seconds: number, warn = false): void {
    this.bannerText = text;
    this.bannerWarn = warn;
    this.bannerUntil = performance.now() + seconds * 1000;
  }

  /** Fill the results table. */
  static results(rows: readonly ResultRow[]): void {
    const winner = rows[0]?.time ?? null;
    const body = $('results-body');
    body.innerHTML = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      if (r.car.you) tr.className = 'you';
      const gap = r.time === null ? `${r.laps} lap${r.laps === 1 ? '' : 's'}` : r.position === 1 || winner === null ? formatTime(r.time) : `+${(r.time - winner).toFixed(2)}`;
      const cells = [ordinal(r.position), r.car.name, gap, formatTime(r.best)];
      cells.forEach((text, i) => {
        const td = document.createElement('td');
        if (i === 1) {
          const sw = document.createElement('span');
          sw.className = 'swatch';
          sw.style.background = r.car.css;
          td.appendChild(sw);
        }
        td.appendChild(document.createTextNode(text));
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }
    const you = rows.find((r) => r.car.you);
    $('results-title').textContent = you ? `You finished ${ordinal(you.position).toLowerCase()}` : 'Results';
  }

  dispose(): void {
    this.arrows.clear();
  }
}
