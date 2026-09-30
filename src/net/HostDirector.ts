import { NET } from '../config.js';
import { isBotId } from '../sim/bots.js';
import { nextCupRace } from '../sim/championship.js';
import type { RoomState } from './RoomSession.js';

/**
 * The host's side of a race: when the phase moves on, and who finished in
 * what order — by the finishers' own time stamps, not by when their messages
 * arrived. Bookkeeping only: `NetRace` applies and broadcasts what `next`
 * returns.
 */
export class HostDirector {
  /** Finish stamps in race ms, by car id. */
  private finishes = new Map<string, number>();
  /** Cars that have driven their cool-down lap. The first ends the race. */
  private cooled = new Set<string>();
  /** Room time the phase last changed, ms. */
  private phaseSince = 0;

  /** A new race, or back to the lobby: nobody has finished. */
  reset(): void {
    this.finishes.clear();
    this.cooled.clear();
  }

  finished(id: string, raceMs: number): void {
    this.finishes.set(id, raceMs);
  }

  cooledDown(id: string): void {
    this.cooled.add(id);
  }

  phaseChanged(nowRoomMs: number): void {
    this.phaseSince = nowRoomMs;
  }

  /** Take a race over as the last heartbeat described it (a failover). */
  adopt(s: RoomState, nowRoomMs: number): void {
    this.reset();
    for (const f of s.finish) {
      const id = s.grid[f.slot];
      if (id) this.finishes.set(id, f.t);
    }
    this.phaseSince = nowRoomMs;
  }

  /**
   * The room state to move on to, or null while nothing is due.
   *
   * @param alive the humans still in the room: one who left is not waited for.
   */
  next(s: RoomState, nowRoomMs: number, alive: ReadonlySet<string>): RoomState | null {
    if (s.phase === 'C' && nowRoomMs >= s.goAt) return { ...s, phase: 'R' };
    if (s.phase === 'R' || s.phase === 'F') {
      const finish = [...this.finishes.entries()]
        .map(([id, t]) => ({ slot: s.grid.indexOf(id), t }))
        .filter((f) => f.slot >= 0)
        .sort((a, b) => a.t - b.t || a.slot - b.slot);
      // Still racing: every bot, and every human still in the room.
      const running = s.grid.filter((id, slot) => (isBotId(id) || alive.has(id)) && !finish.some((f) => f.slot === slot));
      const first = finish[0];
      const graceUp = first !== undefined && nowRoomMs >= s.goAt + first.t + NET.finishGraceMs;
      // Whichever comes first: all home, someone's cool-down lap done, or the grace after the first finish.
      if (running.length === 0 || graceUp || this.cooled.size > 0) return { ...s, finish, phase: 'X' };
      if (finish.length !== s.finish.length) return { ...s, finish, phase: 'F' };
      return null;
    }
    if (s.phase === 'X' && nowRoomMs - this.phaseSince >= NET.resultsMs) {
      this.reset();
      // Mid-championship, the lobby shows the next track; after its last race, the championship is over.
      const next = nextCupRace(s);
      return { ...s, phase: 'L', goAt: 0, grid: [], finish: [], bodies: '', ...(next ?? { race: 0 }) };
    }
    return null;
  }
}
