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
 */
/** A minor, F, C, G: two bars each. */
const ROOTS = [57, 53, 48, 55];
const STEPS_PER_BAR = 16;
const LOOKAHEAD = 0.15;
const TICK_MS = 25;
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
export class Music {
    ctx = null;
    out = null;
    audible = () => false;
    onStart = () => { };
    timer = 0;
    cue = 'off';
    step = 0;
    nextTime = 0;
    noise = null;
    attach(ctx, out, audible, onStart) {
        this.ctx = ctx;
        this.out = out;
        this.audible = audible;
        this.onStart = onStart;
        this.noise = ctx.createBuffer(1, ctx.sampleRate / 4, ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < d.length; i++)
            d[i] = Math.random() * 2 - 1;
        if (this.cue !== 'off')
            this.run();
    }
    play(cue) {
        if (cue === this.cue)
            return;
        this.cue = cue;
        if (cue === 'off') {
            clearInterval(this.timer);
            this.timer = 0;
            return;
        }
        this.run();
    }
    get playing() {
        return this.cue;
    }
    run() {
        if (!this.ctx || this.timer)
            return;
        this.step = 0;
        this.nextTime = this.ctx.currentTime + 0.1;
        this.timer = window.setInterval(() => this.schedule(), TICK_MS);
    }
    schedule() {
        const ctx = this.ctx;
        if (!ctx || this.cue === 'off')
            return;
        const bpm = this.cue === 'race' ? 132 : 96;
        const dt = 60 / bpm / 4;
        // Fell far behind (a hidden tab): skip ahead rather than play a burst.
        if (this.nextTime < ctx.currentTime - 0.3)
            this.nextTime = ctx.currentTime + 0.05;
        while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
            if (this.audible())
                this.note(this.step, this.nextTime, dt);
            this.step = (this.step + 1) % (STEPS_PER_BAR * 8);
            this.nextTime += dt;
        }
    }
    note(step, t, dt) {
        const bar = Math.floor(step / STEPS_PER_BAR);
        const s = step % STEPS_PER_BAR;
        const root = ROOTS[Math.floor(bar / 2) % ROOTS.length];
        const race = this.cue === 'race';
        // Bass: eighths in the race, a pulse on the beat in the menu.
        if (race ? s % 2 === 0 : s % 4 === 0)
            this.voice(mtof(root - 24 + (s % 8 === 6 ? 7 : 0)), t, dt * 1.8, 'sawtooth', 0.22, 600);
        // Arpeggio: root, third, fifth, octave.
        const arp = [0, 3, 7, 12, 7, 3, 0, 10];
        const third = root === 53 || root === 48 || root === 55 ? 4 : 3;
        if (s % 2 === 1 || !race) {
            const n = arp[(s >> (race ? 0 : 1)) % arp.length];
            this.voice(mtof(root + (n === 3 ? third : n)), t, dt * 0.9, 'square', race ? 0.07 : 0.05, 2600);
        }
        // Pad chord on the bar.
        if (s === 0)
            for (const n of [0, third, 7])
                this.voice(mtof(root + n), t, dt * STEPS_PER_BAR * 0.95, 'triangle', 0.045, 1800);
        if (!race)
            return;
        // Drums: kick on the beat, snare on 2 and 4, hats on the off-beats.
        if (s % 4 === 0)
            this.kick(t);
        if (s === 4 || s === 12)
            this.snare(t);
        if (s % 2 === 1)
            this.hat(t);
    }
    voice(freq, t, dur, type, level, cutoff) {
        const ctx = this.ctx;
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
        o.connect(f).connect(g).connect(this.out);
        o.start(t);
        o.stop(t + dur + 0.05);
        this.onStart();
    }
    kick(t) {
        const ctx = this.ctx;
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(140, t);
        o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.5, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        o.connect(g).connect(this.out);
        o.start(t);
        o.stop(t + 0.2);
        this.onStart();
    }
    noiseHit(t, dur, level, type, freq) {
        const ctx = this.ctx;
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(level, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        src.connect(f).connect(g).connect(this.out);
        src.start(t);
        src.stop(t + dur + 0.02);
        this.onStart();
    }
    snare(t) {
        this.noiseHit(t, 0.16, 0.28, 'bandpass', 1800);
    }
    hat(t) {
        this.noiseHit(t, 0.04, 0.12, 'highpass', 7000);
    }
}
//# sourceMappingURL=Music.js.map