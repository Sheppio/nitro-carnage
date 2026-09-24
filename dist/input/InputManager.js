import { Emitter } from '../util.js';
import { GamepadSource } from './GamepadSource.js';
import { KeyboardSource } from './KeyboardSource.js';
import { EMPTY_SAMPLE } from './sources.js';
import { TouchSource } from './TouchSource.js';
/**
 * The one thing every other system reads input from.
 *
 * Three devices go in; one `DriveIntent` comes out. Whichever device reported
 * activity most recently owns the car, so picking up a controller mid-race
 * just works, and so does putting it down and reaching for the keyboard.
 */
export class InputManager {
    settings;
    events = new Emitter();
    keyboard;
    gamepad;
    touch;
    sources;
    lastActive = new Map();
    scheme = 'keys';
    frontWas = false;
    rearWas = false;
    inRace = false;
    constructor(host, settings) {
        this.settings = settings;
        this.keyboard = new KeyboardSource();
        this.gamepad = new GamepadSource();
        this.touch = new TouchSource(host);
        this.sources = [this.keyboard, this.gamepad, this.touch];
        settings.events.on('change', () => this.syncTouch());
        this.syncTouch();
    }
    /** Called when a race starts and ends. Gates the touch overlay. */
    setInRace(inRace) {
        this.inRace = inRace;
        this.syncTouch();
    }
    get activeScheme() {
        return this.scheme;
    }
    /** Poll every device and produce this frame's intent. */
    read(dt) {
        const now = performance.now();
        let chosen = null;
        for (const source of this.sources) {
            if (!source.available())
                continue;
            const sample = source.poll(dt, this.settings.current);
            if (sample.active)
                this.lastActive.set(source.id, now);
            if (source.id === this.scheme)
                chosen = sample;
            else if (sample.active && this.shouldSwitch(source.id, now)) {
                this.setScheme(source.id);
                chosen = sample;
            }
        }
        const s = chosen ?? EMPTY_SAMPLE;
        const fireFront = s.front && !this.frontWas;
        const fireRear = s.rear && !this.rearWas;
        this.frontWas = s.front;
        this.rearWas = s.rear;
        return {
            throttle: s.throttle,
            brake: s.brake,
            steer: s.steer,
            handbrake: s.handbrake,
            fireFront,
            fireRear,
            turbo: s.turbo,
        };
    }
    /** Routes to the pad's motors, or the phone's vibrator on touch. */
    rumble(weak, strong, ms) {
        if (!this.settings.current.vibration)
            return;
        if (this.gamepad.connected)
            this.gamepad.triggerRumble(weak, strong, ms);
        if (this.scheme === 'touch')
            navigator.vibrate?.(Math.round(ms));
    }
    destroy() {
        for (const source of this.sources)
            source.destroy();
        this.events.clear();
    }
    syncTouch() {
        const mode = this.settings.current.touchControls;
        const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
        this.touch.setEnabled(this.inRace && (mode === 'on' || (mode === 'auto' && coarse)));
    }
    /** Debounced so a drifting stick can't fight the keyboard for control. */
    shouldSwitch(candidate, now) {
        const currentActivity = this.lastActive.get(this.scheme) ?? 0;
        return candidate !== this.scheme && now - currentActivity > 250;
    }
    setScheme(scheme) {
        if (this.scheme === scheme)
            return;
        this.scheme = scheme;
        const label = this.sources.find((s) => s.id === scheme)?.label ?? scheme;
        this.events.emit('schemeChange', { scheme, label });
    }
}
//# sourceMappingURL=InputManager.js.map