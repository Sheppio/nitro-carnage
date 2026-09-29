/**
 * Driving music: a small synth band on a lookahead scheduler.
 *
 * A 25 ms timer schedules every note that falls in the next 150 ms, on the
 * audio clock. JavaScript timers wander by tens of milliseconds, and a note
 * started from one sounds late and uneven; the audio clock does not wander,
 * so notes scheduled on it land exactly. (Ported from glitchburst.)
 *
 * Two cues share the machinery: `menu`, sparse and slow, and `race`, with the
 * drums in. Everything is written here as numbers — there are no files.
 *
 * Each track has a theme of its own (a chord progression and a tempo, picked
 * from its id), and the race cue builds as the race does: a lead line joins
 * when you lead or reach the last lap, and the last lap pushes the tempo and
 * doubles the hats.
 */

export type Cue = 'menu' | 'race' | 'off';

/** What the race cue should add, set once a frame by the race. */
export interface Intensity {
  finalLap: boolean;
  leading: boolean;
}

/** A chord: its root (MIDI) and whether it is minor. */
type Chord = readonly [number, boolean];

interface Theme {
  chords: readonly Chord[];
  bpm: number;
}

/** Two bars on each chord. The first is the menu's, and the default. */
const THEMES: readonly Theme[] = [
  { chords: [[57, true], [53, false], [48, false], [55, false]], bpm: 132 }, // Am F C G
  { chords: [[52, true], [48, false], [55, false], [50, false]], bpm: 136 }, // Em C G D
  { chords: [[50, true], [58, false], [53, false], [48, false]], bpm: 128 }, // Dm Bb F C
  { chords: [[48, true], [56, false], [51, false], [58, false]], bpm: 140 }, // Cm Ab Eb Bb
  { chords: [[54, true], [50, false], [57, false], [52, false]], bpm: 134 }, // F#m D A E
];
const STEPS_PER_BAR = 16;
const LOOKAHEAD = 0.15;
const TICK_MS = 25;

/** The lead line: which steps of a bar it plays on, and the notes over the chord's root. */
const LEAD_STEPS = [0, 3, 6, 8, 10, 12, 14];
const LEAD = [12, 10, 7, 12, 15, 14, 12, 7, 3];

/** A stable number from a string (FNV-1a): a track's theme, a car's engine voice. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const mtof = (m: number): number => 440 * 2 ** ((m - 69) / 12);

export class Music {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private audible: () => boolean = () => false;
  private onStart: () => void = () => {};
  private timer = 0;
  private cue: Cue = 'off';
  private step = 0;
  private nextTime = 0;
  private noise: AudioBuffer | null = null;
  private theme: Theme = THEMES[0]!;
  /** Set by the race each frame; calm outside one. */
  intensity: Intensity = { finalLap: false, leading: false };

  attach(ctx: AudioContext, out: GainNode, audible: () => boolean, onStart: () => void): void {
    this.ctx = ctx;
    this.out = out;
    this.audible = audible;
    this.onStart = onStart;
    this.noise = ctx.createBuffer(1, ctx.sampleRate / 4, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    if (this.cue !== 'off') this.run();
  }

  play(cue: Cue): void {
    if (cue === this.cue) return;
    this.cue = cue;
    if (cue === 'off') {
      clearInterval(this.timer);
      this.timer = 0;
      return;
    }
    this.run();
  }

  /** The theme for a track, by its id, or the menu's with `null`. The same track always gets the same one. */
  setTheme(key: string | null): void {
    this.theme = THEMES[key ? hash(key) % THEMES.length : 0]!;
  }

  get themeIndex(): number {
    return THEMES.indexOf(this.theme);
  }

  get playing(): Cue {
    return this.cue;
  }

  private run(): void {
    if (!this.ctx || this.timer) return;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || this.cue === 'off') return;
    const bpm = this.cue === 'race' ? this.theme.bpm + (this.intensity.finalLap ? 10 : 0) : 96;
    const dt = 60 / bpm / 4;
    // Fell far behind (a hidden tab): skip ahead rather than play a burst.
    if (this.nextTime < ctx.currentTime - 0.3) this.nextTime = ctx.currentTime + 0.05;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
      if (this.audible()) this.note(this.step, this.nextTime, dt);
      this.step = (this.step + 1) % (STEPS_PER_BAR * 8);
      this.nextTime += dt;
    }
  }

  private note(step: number, t: number, dt: number): void {
    const bar = Math.floor(step / STEPS_PER_BAR);
    const s = step % STEPS_PER_BAR;
    const chords = this.cue === 'race' ? this.theme.chords : THEMES[0]!.chords;
    const [root, minor] = chords[Math.floor(bar / 2) % chords.length]!;
    const race = this.cue === 'race';
    const { finalLap, leading } = race ? this.intensity : { finalLap: false, leading: false };
    // Bass: eighths in the race, a pulse on the beat in the menu.
    if (race ? s % 2 === 0 : s % 4 === 0) this.voice(mtof(root - 24 + (s % 8 === 6 ? 7 : 0)), t, dt * 1.8, 'sawtooth', 0.22, 600);
    // Arpeggio: root, third, fifth, octave.
    const arp = [0, 3, 7, 12, 7, 3, 0, 10];
    const third = minor ? 3 : 4;
    if (s % 2 === 1 || !race) {
      const n = arp[(s >> (race ? 0 : 1)) % arp.length]!;
      this.voice(mtof(root + (n === 3 ? third : n)), t, dt * 0.9, 'square', race ? 0.07 : 0.05, 2600);
    }
    // Pad chord on the bar.
    if (s === 0) for (const n of [0, third, 7]) this.voice(mtof(root + n), t, dt * STEPS_PER_BAR * 0.95, 'triangle', 0.045, 1800);
    if (!race) return;
    // Drums: kick on the beat, snare on 2 and 4, hats on the off-beats.
    if (s % 4 === 0) this.kick(t);
    if (s === 4 || s === 12) this.snare(t);
    if (s % 2 === 1 || (finalLap && s % 4 === 2)) this.hat(t);
    // The last lap: a crash cymbal at the top of every two bars.
    if (finalLap && s === 0 && bar % 2 === 0) this.noiseHit(t, 0.9, 0.16, 'highpass', 4500);
    // In the lead, or on the last lap: a lead line over the top.
    if (leading || finalLap) {
      const at = LEAD_STEPS.indexOf(s);
      if (at >= 0) {
        const n = LEAD[(at + (bar % 2) * 3) % LEAD.length]!;
        this.voice(mtof(root + 12 + (n === 3 ? third : n === 15 ? 12 + third : n)), t, dt * 1.6, 'square', 0.045, 3400);
      }
    }
  }

  private voice(freq: number, t: number, dur: number, type: OscillatorType, level: number, cutoff: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(f).connect(g).connect(this.out!);
    o.start(t);
    o.stop(t + dur + 0.05);
    this.onStart();
  }

  private kick(t: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(g).connect(this.out!);
    o.start(t);
    o.stop(t + 0.2);
    this.onStart();
  }

  private noiseHit(t: number, dur: number, level: number, type: BiquadFilterType, freq: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.out!);
    src.start(t);
    src.stop(t + dur + 0.02);
    this.onStart();
  }

  private snare(t: number): void {
    this.noiseHit(t, 0.16, 0.28, 'bandpass', 1800);
  }

  private hat(t: number): void {
    this.noiseHit(t, 0.04, 0.12, 'highpass', 7000);
  }
}
