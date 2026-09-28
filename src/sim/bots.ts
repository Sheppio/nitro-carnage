import { mulberry32 } from '../util.js';

/** A bot's car id in a room: `b` and its grid slot. Players' ids are longer. */
export const isBotId = (id: string): boolean => /^b\d+$/.test(id);

/**
 * Bot drivers' names: made-up racing drivers, a first name and a surname,
 * distinct at a glance. Up to 18 characters: the name tags size to their
 * text, and the lobby and results let a long one wrap or clip. The first version was one word each (VOLTA, RAZOR)
 * and, in a room, "BOT 1": play-testing asked for better.
 */
export const BOT_NAMES: readonly string[] = [
  'ACE RIVERA', 'DUKE NITRO', 'ROXY BLAZE', 'ZED KRUGER', 'VIV SPARKS', 'OTTO REVS',
  'JUNO VANCE', 'MAC SKIDDS', 'LOLA TORQUE', 'RIKKI BOLT', 'SAL VOLKOV', 'NINA DRIFT',
  'BUCK HALLER', 'KIT COBALT', 'MO FENWICK', 'TESS GRIDLEY', 'GUS PISTON', 'IDA KESTREL',
  'REX DUNLAP', 'SUKI RAZOR',
  // Added by request, from play-testing.
  'LANDO FLORIST', 'GEORGE RUSTHILL', 'DAVID COLDHEART', 'JENSON BELLYBUTTON', 'DAMON HILLSTART',
  'JOHNNY HUBCAP', 'MAX CRASHTAPPEN', 'MICHAEL SHOEMAKER', 'CHARLES LECRASH', 'SEBASTIAN KETTLE',
];

/**
 * The names for a grid of bots, dealt from the pool without repeats. The
 * same `seed` deals the same names, so every client in a room agrees.
 */
export function botNames(seed: number, count: number): string[] {
  const pool = [...BOT_NAMES];
  const rand = mulberry32(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return Array.from({ length: count }, (_, i) => pool[i % pool.length]!);
}
