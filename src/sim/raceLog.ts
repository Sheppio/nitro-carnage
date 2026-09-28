import { standings } from './race.js';
import type { WeaponKind } from './weapons.js';
import type { Entrant, RaceEvent } from './World.js';

/** How a wreck happened, for the kill feed: a weapon, or a wall nobody gets credit for. */
export type WreckCause = WeaponKind | 'wall';

export interface WreckEntry {
  /** Who gets the credit; null for a wreck nobody caused. */
  by: string | null;
  id: string;
  cause: WreckCause;
  time: number;
}

/**
 * One race's story, from its events: who wrecked whom and with what, who hit
 * the wall, who landed shots, and where everybody started. Every client sees
 * the same wrecks and hits (the network announces them into every world), so
 * every screen tells the same story.
 */
export class RaceLog {
  /** Grid position at GO, 1-based. Empty for a client that arrived after GO. */
  readonly start = new Map<string, number>();
  readonly kills = new Map<string, number>();
  readonly wrecked = new Map<string, number>();
  /** Wrecks nobody was credited with: walls, a train, driving into your own mine. */
  readonly selfWrecks = new Map<string, number>();
  readonly hits = new Map<string, number>();
  /** Wrecks by killer and victim, keyed `killer>victim`. */
  readonly pairs = new Map<string, number>();
  readonly feed: WreckEntry[] = [];
  /** The last weapon to hit each car, and who fired it. */
  private lastHit = new Map<string, { by: string; weapon: WeaponKind }>();

  onEvent(ev: RaceEvent, entrants: readonly Entrant[]): WreckEntry | null {
    if (ev.kind === 'go') {
      standings(entrants).forEach((e, i) => this.start.set(e.id, i + 1));
    } else if (ev.kind === 'hit') {
      if (ev.by !== ev.id) bump(this.hits, ev.by);
      this.lastHit.set(ev.id, { by: ev.by, weapon: ev.weapon });
    } else if (ev.kind === 'wreck') {
      bump(this.wrecked, ev.id);
      const last = this.lastHit.get(ev.id);
      this.lastHit.delete(ev.id);
      let cause: WreckCause = 'wall';
      if (ev.by) {
        bump(this.kills, ev.by);
        bump(this.pairs, `${ev.by}>${ev.id}`);
        // A wall that finishes a car off credits whoever hurt it last: the weapon did the work.
        if (last && last.by === ev.by) cause = last.weapon;
      } else {
        bump(this.selfWrecks, ev.id);
      }
      const entry: WreckEntry = { by: ev.by, id: ev.id, cause, time: ev.time };
      this.feed.push(entry);
      return entry;
    }
    return null;
  }
}

function bump(m: Map<string, number>, k: string, by = 1): void {
  m.set(k, (m.get(k) ?? 0) + by);
}

/** The largest value in a map, and whose it is; ties go to the earlier key in `order`. */
function top(m: ReadonlyMap<string, number>, order: readonly string[]): [string, number] | null {
  let best: [string, number] | null = null;
  const rank = (id: string): number => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  for (const [id, n] of m) {
    if (!best || n > best[1] || (n === best[1] && rank(id) < rank(best[0]))) best = [id, n];
  }
  return best;
}

export interface Award {
  title: string;
  /** Who won it. */
  id: string;
  /** The line under the title, with names already in it. */
  text: string;
}

const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/**
 * Up to `max` awards for the results screen, most interesting first. Each is
 * given only when it means something (one wreck is not a rampage), and nobody
 * gets two.
 *
 * @param order finishing order, by id
 */
export function awards(log: RaceLog, order: readonly string[], name: (id: string) => string, max = 3): Award[] {
  const out: Award[] = [];
  const has = (id: string): boolean => out.some((a) => a.id === id);
  const add = (a: Award): void => {
    if (out.length < max && !has(a.id)) out.push(a);
  };

  const pair = top(log.pairs, []);
  if (pair && pair[1] >= 2) {
    const [by, id] = pair[0].split('>') as [string, string];
    add({ title: 'Grudge match', id: by, text: `${name(by)} wrecked ${name(id)} ${times(pair[1])}` });
  }
  const killer = top(log.kills, order);
  if (killer && killer[1] >= 2) add({ title: 'Wrecking ball', id: killer[0], text: `${name(killer[0])}: ${killer[1]} wrecks` });

  let comeback = { id: '', gained: 1 };
  order.forEach((id, i) => {
    const from = log.start.get(id);
    const gained = from === undefined ? 0 : from - (i + 1);
    if (gained > comeback.gained) comeback = { id, gained };
  });
  if (comeback.id) {
    const { id, gained } = comeback;
    add({ title: 'Comeback', id, text: `${name(id)}: ${log.start.get(id)} → ${order.indexOf(id) + 1}, up ${gained} places` });
  }

  const walls = top(log.selfWrecks, order);
  if (walls) add({ title: 'Kamikaze', id: walls[0], text: `${name(walls[0])} wrecked themselves ${times(walls[1])}` });

  // Nobody laid a finger on them, in a race where plenty of others were wrecked.
  const total = [...log.wrecked.values()].reduce((a, b) => a + b, 0);
  const clean = order.find((id) => !log.wrecked.has(id));
  if (clean && total >= 3) add({ title: 'Untouchable', id: clean, text: `${name(clean)} was never wrecked` });

  const shooter = top(log.hits, order);
  if (shooter && shooter[1] >= 3) add({ title: 'Sharpshooter', id: shooter[0], text: `${name(shooter[0])}: ${shooter[1]} hits` });
  return out;
}

/** Points by finishing position. */
export const POINTS = [10, 6, 4, 3, 2, 1] as const;

export interface TallyRow {
  id: string;
  name: string;
  bot: boolean;
  races: number;
  wins: number;
  points: number;
  kills: number;
  wrecked: number;
}

/**
 * A room's running score across races: points, wins and wrecks for everyone
 * who has raced, and who has wrecked whom the most. Each client keeps its own,
 * from the races it saw, so one who joined late has a shorter memory.
 */
export class Tally {
  private rows = new Map<string, TallyRow>();
  private pairs = new Map<string, number>();
  races = 0;

  /** Add a finished race. */
  add(order: readonly string[], log: RaceLog, name: (id: string) => string, bot: (id: string) => boolean): void {
    this.races++;
    order.forEach((id, i) => {
      const r = this.rows.get(id) ?? { id, name: name(id), bot: bot(id), races: 0, wins: 0, points: 0, kills: 0, wrecked: 0 };
      r.name = name(id);
      r.races++;
      if (i === 0) r.wins++;
      r.points += POINTS[i] ?? 0;
      r.kills += log.kills.get(id) ?? 0;
      r.wrecked += log.wrecked.get(id) ?? 0;
      this.rows.set(id, r);
    });
    for (const [k, n] of log.pairs) bump(this.pairs, k, n);
  }

  /** Everyone, best first: points, then wins, then wrecks dealt. */
  standings(): TallyRow[] {
    return [...this.rows.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || b.kills - a.kills || (a.id < b.id ? -1 : 1));
  }

  /** Who has wrecked this car the most across the races, if anyone has done it twice. */
  nemesis(id: string): { id: string; count: number } | null {
    let best: { id: string; count: number } | null = null;
    for (const [k, n] of this.pairs) {
      const [by, victim] = k.split('>') as [string, string];
      if (victim === id && n >= 2 && (!best || n > best.count)) best = { id: by, count: n };
    }
    return best;
  }

  /** A tallied car's name, as it last raced. */
  name(id: string): string {
    return this.rows.get(id)?.name ?? '—';
  }
}
