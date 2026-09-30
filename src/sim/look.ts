import { PALETTE } from './palette.js';

/**
 * How a car looks (PLAN.md §4.5b, M6). Cosmetic only: every body drives the
 * same and shares one collision capsule, so choosing one is never a
 * competitive decision. The body colour is not in here — it is the room
 * colour, unique per room, which is how cars are told apart.
 *
 * Pure data, no three: the codec runs in Node, and the lobby's 2D icons
 * draw from it too.
 */

/** New bodies go on the end: a look travels as each list's index. */
export const BODIES = ['coupe', 'hatch', 'muscle', 'wedge', 'buggy', 'tractor', 'forklift', 'f1'] as const;
export type BodyId = (typeof BODIES)[number];
export const BODY_NAMES: Record<BodyId, string> = {
  coupe: 'Coupé', hatch: 'Hatch', muscle: 'Muscle', wedge: 'Wedge', buggy: 'Buggy', tractor: 'Tractor', forklift: 'Forklift', f1: 'Formula 1',
};

export const PATTERNS = ['none', 'twin', 'offset', 'flash', 'chequer', 'roundel'] as const;
export type PatternId = (typeof PATTERNS)[number];
export const PATTERN_NAMES: Record<PatternId, string> = {
  none: 'None', twin: 'Twin stripes', offset: 'Offset stripe', flash: 'Side flash', chequer: 'Chequered bonnet', roundel: 'Number roundel',
};

export const RIMS = ['silver', 'black', 'gold', 'body'] as const;
export type RimId = (typeof RIMS)[number];
export const RIM_NAMES: Record<RimId, string> = { silver: 'Silver', black: 'Black', gold: 'Gold', body: 'Body colour' };
export const RIM_COLOURS: Record<Exclude<RimId, 'body'>, number> = { silver: 0xc8ccd2, black: 0x1c1d22, gold: 0xd9a531 };

export interface CarLook {
  body: BodyId;
  pattern: PatternId;
  /** Palette id of the stripe; need not be unique in the room. */
  stripe: string;
  rims: RimId;
  /** Race number, 0-99. */
  number: number;
}

/** The stock car: what a bad packet, an old client or a first run gets. */
export const DEFAULT_LOOK: Readonly<CarLook> = Object.freeze({ body: 'coupe', pattern: 'twin', stripe: 'white', rims: 'silver', number: 7 });

const b36 = (n: number): string => n.toString(36);

/**
 * Six base-36 characters: body, pattern, stripe colour, rims, and two for the
 * number. It rides on presence, which goes out once a second, never on the
 * 20 Hz car packets.
 */
export function encodeLook(look: CarLook): string {
  const n = Math.max(0, Math.min(99, Math.round(look.number)));
  return [
    b36(Math.max(0, BODIES.indexOf(look.body))),
    b36(Math.max(0, PATTERNS.indexOf(look.pattern))),
    b36(Math.max(0, PALETTE.findIndex((c) => c.id === look.stripe))),
    b36(Math.max(0, RIMS.indexOf(look.rims))),
    b36(n).padStart(2, '0'),
  ].join('');
}

/**
 * Read a look back, field by field, falling back to the stock look for
 * anything out of range. A malformed look from the wire can never reach the
 * renderer as something it cannot build: it becomes the stock car.
 */
export function decodeLook(s: string | undefined | null): CarLook {
  if (typeof s !== 'string' || !/^[0-9a-z]{6}$/.test(s)) return { ...DEFAULT_LOOK };
  const at = (i: number): number => parseInt(s[i]!, 36);
  const body = BODIES[at(0)];
  const pattern = PATTERNS[at(1)];
  const stripe = PALETTE[at(2)]?.id;
  const rims = RIMS[at(3)];
  const number = parseInt(s.slice(4), 36);
  if (!body || !pattern || !stripe || !rims || !(number >= 0 && number <= 99)) return { ...DEFAULT_LOOK };
  return { body, pattern, stripe, rims, number };
}

/**
 * A race's car-type lock, as it travels: 0 for any body, else the body's
 * index in BODIES plus one. `lockedLook` puts every car in that body and
 * leaves the rest of its look alone.
 */
export function bodyCode(body: BodyId | '' | null | undefined): number {
  return body ? BODIES.indexOf(body) + 1 : 0;
}

export function lockedLook(look: CarLook, code: number): CarLook {
  const body = BODIES[code - 1];
  return body ? { ...look, body } : look;
}

/**
 * A race's Car type (#17): how the grid's bodies are chosen. Its index is
 * what travels and is stored, so new ones go on the end.
 * - any: everybody drives the body they picked;
 * - single: every car in the host's body (offline, the player's);
 * - distinct: everybody's own, but no two alike: a body already taken goes to
 *   whoever is senior (joined the room first), and the other gets a free one;
 * - random: all different, dealt out afresh for every race.
 */
export const CAR_MODES = ['any', 'single', 'distinct', 'random'] as const;
export type CarMode = (typeof CAR_MODES)[number];
export const CAR_MODE_NAMES: Record<CarMode, string> = { any: 'Any', single: 'Single', distinct: 'Distinct', random: 'Random' };

/** A Car type from its index, as it travels; anything else is `any`. */
export function carModeOf(code: number): CarMode {
  return CAR_MODES[code] ?? 'any';
}

/**
 * Every car's body under a Car type. `wanted` is each car's own body, most
 * senior first (humans in join order, then bots); `lead` is the car whose
 * body `single` gives everyone. `seed` deals `random`, and the free bodies
 * `distinct` hands out, so every client that is given it deals the same.
 * With more cars than bodies, `distinct` and `random` start again from the top.
 */
export function assignBodies(wanted: readonly BodyId[], mode: CarMode, seed: number, lead = 0): BodyId[] {
  if (mode === 'any') return [...wanted];
  if (mode === 'single') {
    const body = wanted[lead] ?? wanted[0] ?? DEFAULT_LOOK.body;
    return wanted.map(() => body);
  }
  // A shuffle of every body, from the seed.
  let h = seed >>> 0 || 1;
  const next = (n: number): number => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    h >>>= 0;
    return h % n;
  };
  const deck: BodyId[] = [...BODIES];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = next(i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  if (mode === 'random') return wanted.map((_, i) => deck[i % deck.length]!);
  // Distinct: the senior car keeps a body; the rest take what is left, in the deck's order.
  const taken = new Set<BodyId>();
  const out: (BodyId | null)[] = wanted.map((b) => {
    if (taken.has(b) || taken.size >= BODIES.length) return null;
    taken.add(b);
    return b;
  });
  return out.map((b) => {
    if (b) return b;
    const free = deck.find((d) => !taken.has(d));
    if (!free) return deck[next(deck.length)]!;
    taken.add(free);
    return free;
  });
}

/** Coerce anything (stored JSON, a URL) into a valid look. */
export function sanitizeLook(look: Partial<CarLook> | null | undefined): CarLook {
  const l = look ?? {};
  return {
    body: BODIES.includes(l.body as BodyId) ? (l.body as BodyId) : DEFAULT_LOOK.body,
    pattern: PATTERNS.includes(l.pattern as PatternId) ? (l.pattern as PatternId) : DEFAULT_LOOK.pattern,
    stripe: PALETTE.some((c) => c.id === l.stripe) ? l.stripe! : DEFAULT_LOOK.stripe,
    rims: RIMS.includes(l.rims as RimId) ? (l.rims as RimId) : DEFAULT_LOOK.rims,
    number: Number.isInteger(l.number) && l.number! >= 0 && l.number! <= 99 ? l.number! : DEFAULT_LOOK.number,
  };
}

/**
 * A bot's look, from a seed every client shares (the room and the grid
 * slot), so every screen dresses the bots the same way.
 */
export function botLook(seed: number): CarLook {
  let h = seed >>> 0 || 1;
  const next = (n: number): number => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    h >>>= 0;
    return h % n;
  };
  return {
    body: BODIES[next(BODIES.length)]!,
    pattern: PATTERNS[next(PATTERNS.length)]!,
    stripe: PALETTE[next(PALETTE.length)]!.id,
    rims: RIMS[next(RIMS.length)]!,
    number: next(100),
  };
}
