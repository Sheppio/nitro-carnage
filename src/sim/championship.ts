/**
 * A championship (#8): a list of tracks the host plans in the lobby, raced in
 * order, with points for every finishing position. The points are the room's,
 * not one client's: the host adds each race's to the heartbeat, so a player
 * who reloads, joins late or takes over as host sees the same table, and it
 * lasts until the last player leaves.
 */

/** One planned race: a built-in track, or a generated one by its seed. */
export interface CupRace {
  /** Built-in track index; ignored when `seed` is set. */
  track: number;
  /** 0 for a built-in. */
  seed: number;
}

/** A car's points in the room, and how many races it has won. */
export interface Score {
  id: string;
  points: number;
  wins: number;
}

/** Points by finishing position: 10 for a win down to 1 for sixth, the last on a full grid. */
export const POINTS = [10, 6, 4, 3, 2, 1] as const;

/** The most races a championship can plan. */
export const CUP_MAX = 10;

/** The most cars the score keeps: players come and go over an evening, and it rides every heartbeat. */
export const SCORE_MAX = 12;

/** The score after a race, given its finishing order (every car on the grid, first to last). */
export function award(score: readonly Score[], order: readonly string[]): Score[] {
  const out = new Map(score.map((s) => [s.id, { ...s }]));
  order.forEach((id, i) => {
    const s = out.get(id) ?? { id, points: 0, wins: 0 };
    s.points += POINTS[i] ?? 0;
    if (i === 0) s.wins++;
    out.set(id, s);
  });
  return ranked([...out.values()]).slice(0, SCORE_MAX);
}

/** Best first: points, then wins, then id so every client agrees. */
export function ranked(score: readonly Score[]): Score[] {
  return [...score].sort((a, b) => b.points - a.points || b.wins - a.wins || (a.id < b.id ? -1 : 1));
}

/** Races scored so far: every race has exactly one winner. */
export function racesScored(score: readonly Score[]): number {
  return score.reduce((n, s) => n + s.wins, 0);
}

export interface CupProgress {
  /** The race being run, or just run, 1-based; 0 when no championship is on. */
  race: number;
  cup: readonly CupRace[];
}

/** Whether a championship is under way. */
export function cupOn(s: CupProgress): boolean {
  return s.race > 0 && s.race <= s.cup.length;
}

/** The race after the current one, or null when the current one is the last (or none is on). */
export function nextCupRace(s: CupProgress): CupRace | null {
  return s.race > 0 && s.race < s.cup.length ? s.cup[s.race]! : null;
}
