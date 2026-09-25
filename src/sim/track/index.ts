import { CIRCUITS } from './circuits.js';
import { DOCKS } from './docks.js';
import { DOWNTOWN, DOWNTOWN_DAY } from './downtown.js';
import { GREENBELT } from './greenbelt.js';
import type { TrackDef } from './TrackDef.js';

/**
 * Every track, in championship rotation order. New tracks go on the end: a
 * room's heartbeat names a built-in track by its index here.
 */
export const TRACKS: readonly TrackDef[] = [DOWNTOWN, GREENBELT, DOCKS, DOWNTOWN_DAY, ...CIRCUITS];

export function trackById(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0]!;
}
