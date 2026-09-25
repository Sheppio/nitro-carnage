import { mulberry32 } from '../util.js';
/**
 * Bot drivers' names: made-up racing drivers, a first name and a surname,
 * short enough for a name tag and a HUD row (12 characters at most) and
 * distinct at a glance. The first version was one word each (VOLTA, RAZOR)
 * and, in a room, "BOT 1": play-testing asked for better.
 */
export const BOT_NAMES = [
    'ACE RIVERA', 'DUKE NITRO', 'ROXY BLAZE', 'ZED KRUGER', 'VIV SPARKS', 'OTTO REVS',
    'JUNO VANCE', 'MAC SKIDDS', 'LOLA TORQUE', 'RIKKI BOLT', 'SAL VOLKOV', 'NINA DRIFT',
    'BUCK HALLER', 'KIT COBALT', 'MO FENWICK', 'TESS GRIDLEY', 'GUS PISTON', 'IDA KESTREL',
    'REX DUNLAP', 'SUKI RAZOR',
];
/**
 * The names for a grid of bots, dealt from the pool without repeats. The
 * same `seed` deals the same names, so every client in a room agrees.
 */
export function botNames(seed, count) {
    const pool = [...BOT_NAMES];
    const rand = mulberry32(seed);
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return Array.from({ length: count }, (_, i) => pool[i % pool.length]);
}
//# sourceMappingURL=bots.js.map