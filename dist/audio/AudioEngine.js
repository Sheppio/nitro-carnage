import { hash, Music } from './Music.js';
/** Right in the listener's ears: the player's own car, the HUD. */
const HERE = { d: 0, pan: 0 };
/** Gear top speeds, m/s: the engine note climbs through each and drops at the change. */
const GEARS = [9, 17, 26, 35, 46, 70];
/** Only the nearest few engines are voiced; the rest would be mud. */
export const MAX_ENGINES = 3;
/** And the nearest few missiles. */
export const MAX_MISSILES = 4;
/** The speed of sound, m/s, for the Doppler shift. Closing speeds are clamped well under it. */
const SOUND = 343;
/**
 * Each car's own engine: the same power (every car performs the same), a
 * different voice, so you can tell who is behind you by ear.
 */
const TIMBRES = [
    { base: 48, ratio: 1.505, b: 'square', detune: 7, q: 3 },
    { base: 44, ratio: 2.01, b: 'sawtooth', detune: 11, q: 4.5 },
    { base: 52, ratio: 1.26, b: 'triangle', detune: 5, q: 2.2 },
    { base: 46, ratio: 1.5, b: 'sawtooth', detune: -9, q: 5.5 },
];
/** How each ground sounds under the tyres: filtered noise, louder with speed. */
const GROUNDS = {
    tarmac: { type: 'lowpass', freq: 320, q: 0.7, level: 0.025 },
    dirt: { type: 'bandpass', freq: 950, q: 0.9, level: 0.11 },
    grass: { type: 'lowpass', freq: 520, q: 1.4, level: 0.13 },
    kerb: { type: 'bandpass', freq: 230, q: 5, level: 0.16 },
    oil: { type: 'highpass', freq: 5000, q: 0.7, level: 0.01 },
    water: { type: 'highpass', freq: 1400, q: 0.8, level: 0.2 },
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export class AudioEngine {
    ctx = null;
    master = null;
    sfxBus = null;
    musicBus = null;
    duckGain = null;
    muffleFilter = null;
    muffled = false;
    noise = null;
    voices = new Map();
    shots = new Map();
    lastPlayed = new Map();
    lastBeat = -Infinity;
    sfx = 1;
    musicLevel = 0.8;
    music = new Music();
    /** Oscillators and sources started, for tests (a muted bus must start none). */
    started = 0;
    /** Create the context. Safe to call on every gesture: only the first does anything. */
    unlock() {
        if (this.ctx) {
            if (this.ctx.state === 'suspended')
                void this.ctx.resume();
            return;
        }
        const Ctx = window.AudioContext ?? window.webkitAudioContext;
        if (!Ctx)
            return;
        const ctx = new Ctx();
        this.ctx = ctx;
        this.master = ctx.createDynamicsCompressor();
        this.master.threshold.value = -14;
        this.master.ratio.value = 6;
        this.master.connect(ctx.destination);
        this.sfxBus = ctx.createGain();
        this.musicBus = ctx.createGain();
        this.duckGain = ctx.createGain();
        this.muffleFilter = ctx.createBiquadFilter();
        this.muffleFilter.type = 'lowpass';
        this.muffleFilter.frequency.value = 20000;
        this.sfxBus.connect(this.master);
        this.musicBus.connect(this.duckGain).connect(this.muffleFilter).connect(this.master);
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
    setVolumes(sfx, music) {
        this.sfx = sfx;
        this.musicLevel = music;
        this.applyVolumes();
        if (sfx <= 0)
            this.silenceEngines();
    }
    applyVolumes() {
        const t = this.ctx?.currentTime ?? 0;
        this.sfxBus?.gain.setTargetAtTime(this.sfx * this.sfx * 0.9, t, 0.03);
        this.musicBus?.gain.setTargetAtTime(this.musicLevel * this.musicLevel * 0.45, t, 0.03);
    }
    count() {
        this.started++;
    }
    /** Can a sound on the effects bus be heard at all right now? */
    live() {
        return this.ctx && this.sfx > 0 && this.ctx.state !== 'closed' ? this.ctx : null;
    }
    /**
     * Rate limit: at most one of `kind` every `ms`. Crashes and beeps stack into
     * noise otherwise. A much louder one gets through anyway, so a distant
     * explosion cannot swallow the one right beside you.
     */
    gate(kind, ms, level = 1) {
        const now = performance.now();
        const last = this.lastPlayed.get(kind);
        if (last && now - last.at < ms && level <= last.level * 1.5)
            return false;
        this.lastPlayed.set(kind, { at: now, level });
        return true;
    }
    /** Where a sound goes: through its own panner when it is off to one side. */
    outFor(ctx, pan) {
        if (Math.abs(pan) < 0.02)
            return this.sfxBus;
        const p = ctx.createStereoPanner();
        p.pan.value = clamp(pan, -1, 1);
        p.connect(this.sfxBus);
        return p;
    }
    /** Doppler: the pitch multiplier for a source closing at `closing` m/s. */
    static doppler(closing) {
        return SOUND / (SOUND - clamp(closing, -80, 80));
    }
    /* ------------------------------------------------------------- engines */
    /**
     * Once a frame: the cars to voice, nearest first. The nearest
     * `MAX_ENGINES` get an engine each; anybody further away falls silent.
     */
    engines(cars) {
        const ctx = this.live();
        if (!ctx)
            return;
        const near = [...cars].sort((a, b) => a.distance - b.distance).slice(0, MAX_ENGINES);
        const keep = new Set(near.map((c) => c.id));
        for (const [id, v] of this.voices)
            if (!keep.has(id))
                this.stopVoice(id, v);
        const t = ctx.currentTime;
        for (const c of near) {
            const fresh = !this.voices.has(c.id);
            const v = this.voices.get(c.id) ?? this.startVoice(ctx, c.id);
            // Gear and revs from speed: the note climbs through a gear and drops at the change.
            const speed = Math.abs(c.speed);
            let lo = 0;
            let hi = GEARS[0];
            let gear = 0;
            for (const g of GEARS) {
                hi = g;
                if (speed <= g)
                    break;
                lo = g;
                gear++;
            }
            const rev = Math.min(1, (speed - lo) / (hi - lo));
            const near1 = 1 / (1 + (c.distance / 25) ** 2);
            // An upshift under throttle: the note dips for a beat, with the click of the box.
            if (!fresh && gear > v.gear && c.throttle > 0.3) {
                v.shift.gain.cancelScheduledValues(t);
                v.shift.gain.setValueAtTime(1, t);
                v.shift.gain.linearRampToValueAtTime(0.3, t + 0.03);
                v.shift.gain.linearRampToValueAtTime(1, t + 0.14);
                if (near1 > 0.2)
                    this.tone(2300, 0.025, 'square', 0.025 * near1, 0, undefined, c.pan);
            }
            v.gear = gear;
            // The turbo: a whoosh as it lights, a blow-off as it lets go.
            if (!fresh && c.boosting !== v.boosting && near1 > 0.1) {
                const at = { d: c.distance, pan: c.pan };
                if (c.boosting)
                    this.hiss(0.45, 0.2 * near1, 'bandpass', 350, 2600, 0, at);
                else
                    this.hiss(0.3, 0.13 * near1, 'highpass', 3200, 900, 0, at);
            }
            v.boosting = c.boosting;
            const f = (v.base + rev * 70 + (c.boosting ? 18 : 0) + c.throttle * 6) * AudioEngine.doppler(c.closing);
            v.a.frequency.setTargetAtTime(f, t, 0.04);
            v.b.frequency.setTargetAtTime(f * v.ratio, t, 0.04);
            v.filter.frequency.setTargetAtTime(380 + c.throttle * 1400 + rev * 500, t, 0.05);
            v.pan.pan.setTargetAtTime(clamp(c.pan, -1, 1), t, 0.05);
            v.gain.gain.setTargetAtTime((0.05 + c.throttle * 0.07 + (c.boosting ? 0.03 : 0)) * near1, t, 0.05);
            v.squeal.gain.setTargetAtTime(Math.min(1, c.slide) * 0.09 * near1, t, 0.04);
            // What the tyres roll on: gravel hiss, grass rumble, the kerb's buzz.
            const g = GROUNDS[c.ground];
            if (v.road.type !== g.type)
                v.road.type = g.type;
            v.road.frequency.setTargetAtTime(g.freq * (c.ground === 'kerb' ? 0.7 + Math.min(1, speed / 40) : 1), t, 0.05);
            v.road.Q.setTargetAtTime(g.q, t, 0.05);
            v.roadGain.gain.setTargetAtTime(g.level * Math.min(1, speed / 25) * near1, t, 0.06);
        }
    }
    startVoice(ctx, id) {
        const tb = TIMBRES[hash(id) % TIMBRES.length];
        const a = ctx.createOscillator();
        const b = ctx.createOscillator();
        a.type = 'sawtooth';
        b.type = tb.b;
        b.detune.value = tb.detune;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = tb.q;
        const shift = ctx.createGain();
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const pan = ctx.createStereoPanner();
        pan.connect(this.sfxBus);
        a.connect(filter);
        b.connect(filter);
        filter.connect(shift).connect(gain).connect(pan);
        // Tyre squeal: band-passed noise, gated by how much the car slides.
        const squealSrc = this.loop(ctx);
        const band = ctx.createBiquadFilter();
        band.type = 'bandpass';
        band.frequency.value = 1900;
        band.Q.value = 8;
        const squeal = ctx.createGain();
        squeal.gain.value = 0;
        squealSrc.connect(band).connect(squeal).connect(pan);
        // Road noise, shaped by the ground under the tyres.
        const roadSrc = this.loop(ctx);
        const road = ctx.createBiquadFilter();
        const roadGain = ctx.createGain();
        roadGain.gain.value = 0;
        roadSrc.connect(road).connect(roadGain).connect(pan);
        a.start();
        b.start();
        this.started += 2;
        const v = {
            a, b, ratio: tb.ratio, base: tb.base, filter, shift, gain, squeal, road, roadGain, pan,
            noises: [squealSrc, roadSrc], gear: 0, boosting: false,
        };
        this.voices.set(id, v);
        return v;
    }
    /** Looping noise, started at a random point so two voices never phase. */
    loop(ctx) {
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        src.loop = true;
        src.start(ctx.currentTime, Math.random());
        this.started++;
        return src;
    }
    stopVoice(id, v) {
        const t = this.ctx.currentTime;
        v.gain.gain.setTargetAtTime(0, t, 0.05);
        v.squeal.gain.setTargetAtTime(0, t, 0.05);
        v.roadGain.gain.setTargetAtTime(0, t, 0.05);
        v.a.stop(t + 0.3);
        v.b.stop(t + 0.3);
        for (const n of v.noises)
            n.stop(t + 0.3);
        this.voices.delete(id);
    }
    /**
     * Once a frame: the missiles in the air, nearest first. Each whines, pitched
     * up as it comes at you and down as it goes.
     */
    missiles(shots) {
        const ctx = this.live();
        if (!ctx)
            return;
        const near = [...shots].sort((a, b) => a.heard.d - b.heard.d).slice(0, MAX_MISSILES);
        const keep = new Set(near.map((s) => s.key));
        for (const [key, v] of this.shots)
            if (!keep.has(key))
                this.stopShot(key, v);
        const t = ctx.currentTime;
        for (const s of near) {
            let v = this.shots.get(s.key);
            if (!v) {
                const o = ctx.createOscillator();
                o.type = 'sawtooth';
                const f = ctx.createBiquadFilter();
                f.type = 'bandpass';
                f.frequency.value = 1500;
                f.Q.value = 2;
                const gain = ctx.createGain();
                gain.gain.value = 0;
                const pan = ctx.createStereoPanner();
                o.connect(f).connect(gain).connect(pan).connect(this.sfxBus);
                o.start();
                this.started++;
                v = { o, gain, pan };
                this.shots.set(s.key, v);
            }
            v.o.frequency.setTargetAtTime(720 * AudioEngine.doppler(s.closing), t, 0.03);
            v.pan.pan.setTargetAtTime(clamp(s.heard.pan, -1, 1), t, 0.03);
            v.gain.gain.setTargetAtTime(0.05 * AudioEngine.near(s.heard.d), t, 0.03);
        }
    }
    stopShot(key, v) {
        const t = this.ctx.currentTime;
        v.gain.gain.setTargetAtTime(0, t, 0.03);
        v.o.stop(t + 0.2);
        this.shots.delete(key);
    }
    /** Every engine off, and the missiles with them: the race is over, or paused. */
    silenceEngines() {
        for (const [id, v] of this.voices)
            this.stopVoice(id, v);
        for (const [key, v] of this.shots)
            this.stopShot(key, v);
    }
    get engineVoices() {
        return this.voices.size;
    }
    get missileVoices() {
        return this.shots.size;
    }
    /* -------------------------------------------------------------- mood */
    /**
     * Once a frame in a race, and `null` when it ends: the music builds on the
     * final lap and in the lead, and goes muffled while paused or wrecked.
     */
    mood(m) {
        this.music.intensity = m ?? { finalLap: false, leading: false };
        const muffled = m?.muffled ?? false;
        if (muffled === this.muffled || !this.ctx || !this.muffleFilter)
            return;
        this.muffled = muffled;
        this.muffleFilter.frequency.setTargetAtTime(muffled ? 650 : 20000, this.ctx.currentTime, 0.12);
    }
    /** The music ducks under a big bang, then swells back. `amount` 0..1. */
    duck(amount) {
        const ctx = this.ctx;
        if (!ctx || !this.duckGain || amount < 0.05)
            return;
        const t = ctx.currentTime;
        const g = this.duckGain.gain;
        g.cancelScheduledValues(t);
        g.setTargetAtTime(1 - Math.min(0.75, amount), t, 0.01);
        g.setTargetAtTime(1, t + 0.15, 0.4);
    }
    get musicDuck() {
        return this.duckGain?.gain.value ?? 1;
    }
    /* ------------------------------------------------------------ one-shots */
    /** A pitched blip with an envelope. */
    tone(freq, dur, type, level, delay = 0, slideTo, pan = 0) {
        const ctx = this.live();
        if (!ctx || level <= 0.0005)
            return;
        const t = ctx.currentTime + delay;
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(freq, t);
        if (slideTo !== undefined)
            o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(level, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
        o.connect(g).connect(this.outFor(ctx, pan));
        o.start(t);
        o.stop(t + dur + 0.05);
        this.started++;
    }
    /** A burst of filtered noise. */
    hiss(dur, level, filter, freq, freqTo, delay = 0, at = HERE) {
        const ctx = this.live();
        if (!ctx || !this.noise || level <= 0.0005)
            return;
        const t = ctx.currentTime + delay;
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        const f = ctx.createBiquadFilter();
        f.type = filter;
        f.frequency.setValueAtTime(freq, t);
        if (freqTo !== undefined)
            f.frequency.exponentialRampToValueAtTime(freqTo, t + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(level, t);
        g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
        src.connect(f).connect(g).connect(this.outFor(ctx, at.pan));
        src.start(t, Math.random() * 0.5);
        src.stop(t + dur + 0.05);
        this.started++;
    }
    /** Volume by distance from the listener: full within 15 m, gone by about 120. */
    static near(distance) {
        return 1 / (1 + Math.max(0, distance - 15) / 25);
    }
    fire(at, rear) {
        const k = AudioEngine.near(at.d);
        if (!this.gate('fire', 60, k))
            return;
        this.hiss(0.35, 0.35 * k, 'bandpass', rear ? 1500 : 2400, 500, 0, at);
        this.tone(rear ? 520 : 760, 0.3, 'sawtooth', 0.08 * k, 0, 180, at.pan);
    }
    mineDrop(at) {
        const k = AudioEngine.near(at.d);
        if (!this.gate('mine', 80, k))
            return;
        this.tone(180, 0.12, 'square', 0.12 * k, 0, 90, at.pan);
        this.tone(1320, 0.06, 'sine', 0.06 * k, 0.6, undefined, at.pan);
    }
    explosion(at, size = 1) {
        const k = AudioEngine.near(at.d) * Math.min(1.4, size);
        if (!this.gate('boom', 45, k))
            return;
        this.hiss(0.9 * size, 0.7 * k, 'lowpass', 2400, 120, 0, at);
        this.tone(110, 0.6 * size, 'sine', 0.5 * k, 0, 32, at.pan);
        this.duck(0.45 * k);
    }
    /** The player's car hit a wall (or landed hard: see `landing`). */
    crash(strength) {
        if (!this.gate('crash', 90, strength))
            return;
        this.hiss(0.25, 0.5 * strength, 'lowpass', 900, 150);
        this.tone(70, 0.22, 'triangle', 0.4 * strength, 0, 40);
    }
    /** Two cars touched, closing at `closing` m/s: a crunch of panels. */
    bump(at, closing) {
        // Cars leaning on each other touch every step; only a real knock is heard.
        if (closing < 2)
            return;
        const k = AudioEngine.near(at.d) * clamp(closing / 14, 0.15, 1);
        if (k < 0.04 || !this.gate('bump', 80, k))
            return;
        this.hiss(0.18, 0.45 * k, 'bandpass', 1400, 250, 0, at);
        this.tone(95, 0.16, 'triangle', 0.3 * k, 0, 48, at.pan);
        this.tone(430 + Math.random() * 120, 0.09, 'square', 0.04 * k, 0.01, 300, at.pan);
    }
    /** The player's car took damage: a clang, bigger with the hit. */
    damage(amount) {
        const k = clamp(amount / 25, 0.2, 1);
        if (!this.gate('damage', 120, k))
            return;
        this.tone(520, 0.2, 'sine', 0.1 * k);
        this.tone(1370, 0.14, 'sine', 0.06 * k);
        this.tone(2210, 0.08, 'triangle', 0.03 * k);
    }
    /**
     * Once a frame: the player's health, 0..1. Under a third, a heartbeat,
     * quicker as it gets worse. Wrecked (0) or healthy, nothing.
     */
    lowHealth(frac) {
        if (frac <= 0 || frac >= 0.34)
            return;
        const now = performance.now();
        if (now - this.lastBeat < 450 + frac * 2400)
            return;
        this.lastBeat = now;
        this.tone(58, 0.14, 'sine', 0.3, 0, 40);
        this.tone(52, 0.14, 'sine', 0.22, 0.16, 36);
    }
    landing(strength) {
        if (!this.gate('land', 150, strength))
            return;
        this.tone(60, 0.18, 'sine', 0.35 * strength, 0, 35);
    }
    /** Countdown: three pips and a higher GO. */
    countdown(go) {
        this.tone(go ? 880 : 440, go ? 0.5 : 0.18, 'square', 0.12);
    }
    lap(final) {
        this.tone(660, 0.12, 'triangle', 0.14);
        this.tone(final ? 990 : 880, 0.2, 'triangle', 0.14, 0.12);
    }
    finish() {
        [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.35, 'triangle', 0.14, i * 0.13));
    }
    /**
     * The winner crosses the line (#23): the crowd roars and whoops, a firework
     * pops at each of `pops` (seconds from now), and brass plays a fanfare, the
     * whole way if it's you who won.
     */
    celebrate(pops, you) {
        const ctx = this.live();
        if (!ctx || !this.sfxBus)
            return;
        const t = ctx.currentTime;
        // The crowd: noise where voices are, swelling, held, and dying away, with the wobble of many people.
        if (this.noise) {
            for (const [freq, q, level] of [[450, 0.7, 0.1], [950, 0.9, 0.2], [1900, 1.3, 0.09]]) {
                const src = ctx.createBufferSource();
                src.buffer = this.noise;
                src.loop = true;
                const f = ctx.createBiquadFilter();
                f.type = 'bandpass';
                f.frequency.value = freq;
                f.Q.value = q;
                const g = ctx.createGain();
                g.gain.setValueAtTime(0.0008, t);
                g.gain.exponentialRampToValueAtTime(level, t + 0.5);
                g.gain.setValueAtTime(level, t + 2);
                g.gain.exponentialRampToValueAtTime(0.0008, t + 4);
                const lfo = ctx.createOscillator();
                lfo.frequency.value = 2.5 + Math.random() * 3;
                const depth = ctx.createGain();
                depth.gain.value = level * 0.35;
                lfo.connect(depth).connect(g.gain);
                src.connect(f).connect(g).connect(this.sfxBus);
                src.start(t, Math.random() * 0.5);
                src.stop(t + 4.1);
                lfo.start(t);
                lfo.stop(t + 4.1);
                this.started++;
            }
            // Whistles over it.
            for (let i = 0; i < 4; i++) {
                const f0 = 1500 + Math.random() * 900;
                this.tone(f0, 0.4, 'sine', 0.025, 0.4 + Math.random() * 1.8, f0 * 1.35, (Math.random() - 0.5) * 1.2);
            }
        }
        // The fireworks: a thump as each goes off, and the crackle after.
        for (const d of pops) {
            this.tone(160, 0.25, 'sine', 0.12, d, 60);
            this.hiss(0.5, 0.1, 'highpass', 2500, 5000, d + 0.05);
        }
        // The fanfare: G C E G, E, G held, with the chord under the end.
        const level = you ? 0.07 : 0.035;
        const notes = [[392, 0, 0.14], [523, 0.14, 0.14], [659, 0.28, 0.14], [784, 0.42, 0.34], [659, 0.78, 0.14], [784, 0.92, 1.1]];
        for (const [f, at, dur] of notes) {
            this.tone(f, dur, 'sawtooth', level, at);
            this.tone(f * 2, dur, 'triangle', level * 0.4, at);
        }
        for (const f of [523, 659])
            this.tone(f, 1.1, 'sawtooth', level * 0.6, 0.92);
    }
    /** Somebody else crossed the line: two soft falling notes. */
    rivalHome() {
        if (!this.gate('rival', 400))
            return;
        this.tone(784, 0.18, 'triangle', 0.06);
        this.tone(587, 0.26, 'triangle', 0.06, 0.14);
    }
    /** On the last lap, a place won or lost. */
    place(gained) {
        if (!this.gate('place', 250))
            return;
        if (gained) {
            this.tone(880, 0.1, 'square', 0.05, 0, 1320);
            this.tone(1320, 0.14, 'sine', 0.05, 0.08);
        }
        else {
            this.tone(660, 0.16, 'square', 0.05, 0, 400);
        }
    }
    respawn() {
        this.tone(300, 0.35, 'sine', 0.1, 0, 900);
    }
    /** Took a pickup box: each kind has its own call, so you know what you got without looking. */
    pickup(kind) {
        if (kind === 'ammo') {
            // Rounds going in: two metallic clacks.
            this.tone(240, 0.05, 'square', 0.09, 0, 160);
            this.hiss(0.04, 0.12, 'highpass', 3000);
            this.tone(320, 0.06, 'square', 0.09, 0.09, 200);
            this.hiss(0.04, 0.12, 'highpass', 3500, undefined, 0.09);
        }
        else if (kind === 'repair') {
            // Patched up: a bright major arpeggio.
            [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.14, 'sine', 0.07, i * 0.05));
        }
        else {
            // Topped up: a rising rush.
            this.hiss(0.3, 0.14, 'bandpass', 500, 3500);
            this.tone(400, 0.28, 'sawtooth', 0.05, 0, 1600);
        }
    }
    /** The level-crossing bell, while its lights are on. */
    bell(at) {
        if (!this.gate('bell', 480))
            return;
        const k = AudioEngine.near(at.d);
        this.tone(1250, 0.4, 'triangle', 0.12 * k, 0, undefined, at.pan);
        this.tone(1875, 0.3, 'sine', 0.05 * k, 0, undefined, at.pan);
    }
    /** The train horn: a two-note chord, once as it nears the crossing. */
    horn(at) {
        if (!this.gate('horn', 6000))
            return;
        const k = AudioEngine.near(at.d) * 1.5;
        for (const f of [277, 349]) {
            this.tone(f, 1.4, 'sawtooth', 0.07 * k, 0, undefined, at.pan);
            this.tone(f * 2, 1.4, 'square', 0.02 * k, 0, undefined, at.pan);
        }
    }
    /** A soft tick for menu focus. */
    blip() {
        if (!this.gate('blip', 40))
            return;
        this.tone(1400, 0.035, 'sine', 0.04);
    }
}
//# sourceMappingURL=AudioEngine.js.map