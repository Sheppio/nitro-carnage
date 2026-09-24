import { Music } from './Music.js';

/**
 * Every sound in the game, synthesised: oscillators, filtered noise and
 * envelopes on the Web Audio graph. There are no sound files, in keeping with
 * the rest of the game — and nothing to download before the first engine note.
 *
 * Shape of the graph:
 *
 *     engines ─┐
 *     sfx ─────┼─ sfx bus ─┐
 *     music ───── music bus ┴─ compressor ─ destination
 *
 * Volumes are squared on the way to the gain nodes (a slider at half sounds
 * like half), and a bus at zero builds nothing: `play*` returns early rather
 * than wiring up oscillators nobody can hear. Both habits are glitchburst's.
 *
 * Browsers only let audio start from a user gesture, so the context is made
 * on the first key, click or touch (`unlock`). A controller press does not
 * count as a gesture in every browser; on those the game is silent until the
 * player presses something else once.
 */

export interface EngineVoiceInput {
  id: string;
  /** Speed, m/s, and throttle 0..1. */
  speed: number;
  throttle: number;
  boosting: boolean;
  /** Distance from the listener (the followed car), metres. */
  distance: number;
  /** Tyres screaming: body slip beyond grip, 0..1. */
  slide: number;
}

/** Gear top speeds, m/s: the engine note climbs through each and drops at the change. */
const GEARS = [9, 17, 26, 35, 46, 70];
/** Only the nearest few engines are voiced; the rest would be mud. */
export const MAX_ENGINES = 3;

interface EngineVoice {
  a: OscillatorNode;
  b: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  squeal: GainNode;
  squealSrc: AudioBufferSourceNode;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master: DynamicsCompressorNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private voices = new Map<string, EngineVoice>();
  private lastPlayed = new Map<string, number>();
  private sfx = 1;
  private musicLevel = 0.8;
  readonly music = new Music();
  /** Oscillators and sources started, for tests (a muted bus must start none). */
  started = 0;

  /** Create the context. Safe to call on every gesture: only the first does anything. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createDynamicsCompressor();
    this.master.threshold.value = -14;
    this.master.ratio.value = 6;
    this.master.connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.musicBus.connect(this.master);
    // One second of white noise, reused by every noisy sound.
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = (seed / 0x3fffffff) - 1;
    }
    this.applyVolumes();
    this.music.attach(ctx, this.musicBus, () => this.musicLevel > 0, () => this.count());
  }

  /** 0..1 each, as the settings sliders give them. */
  setVolumes(sfx: number, music: number): void {
    this.sfx = sfx;
    this.musicLevel = music;
    this.applyVolumes();
    if (sfx <= 0) this.silenceEngines();
  }

  private applyVolumes(): void {
    const t = this.ctx?.currentTime ?? 0;
    this.sfxBus?.gain.setTargetAtTime(this.sfx * this.sfx * 0.9, t, 0.03);
    this.musicBus?.gain.setTargetAtTime(this.musicLevel * this.musicLevel * 0.45, t, 0.03);
  }

  private count(): void {
    this.started++;
  }

  /** Can a sound on the effects bus be heard at all right now? */
  private live(): AudioContext | null {
    return this.ctx && this.sfx > 0 && this.ctx.state !== 'closed' ? this.ctx : null;
  }

  /** Rate limit: at most one of `kind` every `ms`. Crashes and beeps stack into noise otherwise. */
  private gate(kind: string, ms: number): boolean {
    const now = performance.now();
    if (now - (this.lastPlayed.get(kind) ?? -Infinity) < ms) return false;
    this.lastPlayed.set(kind, now);
    return true;
  }

  /* ------------------------------------------------------------- engines */

  /**
   * Once a frame: the cars to voice, nearest first. The nearest
   * `MAX_ENGINES` get an engine each; anybody further away falls silent.
   */
  engines(cars: readonly EngineVoiceInput[]): void {
    const ctx = this.live();
    if (!ctx) return;
    const near = [...cars].sort((a, b) => a.distance - b.distance).slice(0, MAX_ENGINES);
    const keep = new Set(near.map((c) => c.id));
    for (const [id, v] of this.voices) if (!keep.has(id)) this.stopVoice(id, v);
    const t = ctx.currentTime;
    for (const c of near) {
      const v = this.voices.get(c.id) ?? this.startVoice(ctx, c.id);
      // Gear and revs from speed: the note climbs through a gear and drops at the change.
      const speed = Math.abs(c.speed);
      let lo = 0;
      let hi = GEARS[0]!;
      for (const g of GEARS) {
        hi = g;
        if (speed <= g) break;
        lo = g;
      }
      const rev = Math.min(1, (speed - lo) / (hi - lo));
      const f = 48 + rev * 70 + (c.boosting ? 18 : 0) + c.throttle * 6;
      v.a.frequency.setTargetAtTime(f, t, 0.04);
      v.b.frequency.setTargetAtTime(f * 1.505, t, 0.04);
      v.filter.frequency.setTargetAtTime(380 + c.throttle * 1400 + rev * 500, t, 0.05);
      const near1 = 1 / (1 + (c.distance / 25) ** 2);
      v.gain.gain.setTargetAtTime((0.05 + c.throttle * 0.07 + (c.boosting ? 0.03 : 0)) * near1, t, 0.05);
      v.squeal.gain.setTargetAtTime(Math.min(1, c.slide) * 0.09 * near1, t, 0.04);
    }
  }

  private startVoice(ctx: AudioContext, id: string): EngineVoice {
    const a = ctx.createOscillator();
    const b = ctx.createOscillator();
    a.type = 'sawtooth';
    b.type = 'square';
    b.detune.value = 7;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 3;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    a.connect(filter);
    b.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxBus!);
    // Tyre squeal: band-passed noise, gated by how much the car slides.
    const squealSrc = ctx.createBufferSource();
    squealSrc.buffer = this.noise;
    squealSrc.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1900;
    band.Q.value = 8;
    const squeal = ctx.createGain();
    squeal.gain.value = 0;
    squealSrc.connect(band).connect(squeal).connect(this.sfxBus!);
    a.start();
    b.start();
    squealSrc.start();
    this.started += 3;
    const v = { a, b, filter, gain, squeal, squealSrc };
    this.voices.set(id, v);
    return v;
  }

  private stopVoice(id: string, v: EngineVoice): void {
    const t = this.ctx!.currentTime;
    v.gain.gain.setTargetAtTime(0, t, 0.05);
    v.squeal.gain.setTargetAtTime(0, t, 0.05);
    v.a.stop(t + 0.3);
    v.b.stop(t + 0.3);
    v.squealSrc.stop(t + 0.3);
    this.voices.delete(id);
  }

  /** Every engine off: the race is over, or paused. */
  silenceEngines(): void {
    for (const [id, v] of this.voices) this.stopVoice(id, v);
  }

  get engineVoices(): number {
    return this.voices.size;
  }

  /* ------------------------------------------------------------ one-shots */

  /** A pitched blip with an envelope. */
  private tone(freq: number, dur: number, type: OscillatorType, level: number, delay = 0, slideTo?: number): void {
    const ctx = this.live();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo !== undefined) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(this.sfxBus!);
    o.start(t);
    o.stop(t + dur + 0.05);
    this.started++;
  }

  /** A burst of filtered noise. */
  private hiss(dur: number, level: number, filter: BiquadFilterType, freq: number, freqTo?: number, delay = 0): void {
    const ctx = this.live();
    if (!ctx || !this.noise) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, t);
    if (freqTo !== undefined) f.frequency.exponentialRampToValueAtTime(freqTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f).connect(g).connect(this.sfxBus!);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
    this.started++;
  }

  /** Volume by distance from the listener: full within 15 m, gone by about 120. */
  private static near(distance: number): number {
    return 1 / (1 + Math.max(0, distance - 15) / 25);
  }

  fire(distance: number, rear: boolean): void {
    if (!this.gate('fire', 60)) return;
    const k = AudioEngine.near(distance);
    this.hiss(0.35, 0.35 * k, 'bandpass', rear ? 1500 : 2400, 500);
    this.tone(rear ? 520 : 760, 0.3, 'sawtooth', 0.08 * k, 0, 180);
  }

  mineDrop(distance: number): void {
    if (!this.gate('mine', 80)) return;
    const k = AudioEngine.near(distance);
    this.tone(180, 0.12, 'square', 0.12 * k, 0, 90);
    this.tone(1320, 0.06, 'sine', 0.06 * k, 0.6);
  }

  explosion(distance: number, size = 1): void {
    if (!this.gate('boom', 45)) return;
    const k = AudioEngine.near(distance) * Math.min(1.4, size);
    this.hiss(0.9 * size, 0.7 * k, 'lowpass', 2400, 120);
    this.tone(110, 0.6 * size, 'sine', 0.5 * k, 0, 32);
  }

  crash(strength: number): void {
    if (!this.gate('crash', 90)) return;
    this.hiss(0.25, 0.5 * strength, 'lowpass', 900, 150);
    this.tone(70, 0.22, 'triangle', 0.4 * strength, 0, 40);
  }

  landing(strength: number): void {
    if (!this.gate('land', 150)) return;
    this.tone(60, 0.18, 'sine', 0.35 * strength, 0, 35);
  }

  /** Countdown: three pips and a higher GO. */
  countdown(go: boolean): void {
    this.tone(go ? 880 : 440, go ? 0.5 : 0.18, 'square', 0.12);
  }

  lap(final: boolean): void {
    this.tone(660, 0.12, 'triangle', 0.14);
    this.tone(final ? 990 : 880, 0.2, 'triangle', 0.14, 0.12);
  }

  finish(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.35, 'triangle', 0.14, i * 0.13));
  }

  respawn(): void {
    this.tone(300, 0.35, 'sine', 0.1, 0, 900);
  }

  /** The level-crossing bell, while its lights are on. */
  bell(distance: number): void {
    if (!this.gate('bell', 480)) return;
    const k = AudioEngine.near(distance);
    this.tone(1250, 0.4, 'triangle', 0.12 * k);
    this.tone(1875, 0.3, 'sine', 0.05 * k);
  }

  /** The train horn: a two-note chord, once as it nears the crossing. */
  horn(distance: number): void {
    if (!this.gate('horn', 6000)) return;
    const k = AudioEngine.near(distance) * 1.5;
    for (const f of [277, 349]) {
      this.tone(f, 1.4, 'sawtooth', 0.07 * k);
      this.tone(f * 2, 1.4, 'square', 0.02 * k);
    }
  }

  /** A soft tick for menu focus. */
  blip(): void {
    if (!this.gate('blip', 40)) return;
    this.tone(1400, 0.035, 'sine', 0.04);
  }
}
