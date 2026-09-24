/** Tiny shared helpers. No dependencies, no three, no DOM. */
/** Minimal typed event emitter — the seam between the simulation and everything that watches it. */
export class Emitter {
    map = new Map();
    on(event, fn) {
        let set = this.map.get(event);
        if (!set) {
            set = new Set();
            this.map.set(event, set);
        }
        set.add(fn);
        return () => this.off(event, fn);
    }
    off(event, fn) {
        this.map.get(event)?.delete(fn);
    }
    emit(event, payload) {
        const set = this.map.get(event);
        if (!set)
            return;
        // Copy so a handler may unsubscribe during dispatch.
        for (const fn of [...set])
            fn(payload);
    }
    clear() {
        this.map.clear();
    }
}
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
    const TAU = Math.PI * 2;
    a = ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
    return a === -Math.PI ? Math.PI : a;
}
/** Shortest-path interpolation between two angles in radians. */
export const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;
/**
 * Framerate-independent exponential smoothing factor.
 *
 * `pos += (target - pos) * 0.2` converges twice as fast at 120 Hz as at 60,
 * so two players would literally see different games. This returns the factor
 * that gives the same convergence per unit of *time* whatever the frame rate:
 * `base` is the fraction covered in one 60 Hz frame.
 */
export const smoothing = (base, dtSec) => 1 - (1 - base) ** (dtSec * 60);
/**
 * Seeded PRNG (mulberry32). The simulation never calls `Math.random`: every
 * client must scatter the same scenery and fly the same projectile, and they
 * share nothing but a seed.
 */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** Deterministic 32-bit hash of a string (FNV-1a). */
export function hashString(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Human-typeable room code — no visually ambiguous characters. */
export function makeRoomCode(len = 4) {
    let s = '';
    for (let n = 0; n < len; n++)
        s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
}
/**
 * Player ids double as the host-election key: the room sorts them and the
 * lowest wins, so they must be unique and comparable. A time prefix means an
 * earlier arrival sorts first, which makes the first player to join the host.
 */
export function makePlayerId() {
    const t = Date.now().toString(36).padStart(9, '0');
    const r = Math.floor(Math.random() * 36 ** 4)
        .toString(36)
        .padStart(4, '0');
    return `${t}${r}`;
}
//# sourceMappingURL=util.js.map