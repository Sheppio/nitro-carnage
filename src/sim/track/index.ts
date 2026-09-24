import { DOCKS } from './docks.js';
import { DOWNTOWN } from './downtown.js';
import { GREENBELT } from './greenbelt.js';
import type { TrackDef } from './TrackDef.js';

/** Every track, in championship rotation order. */
export const TRACKS: readonly TrackDef[] = [DOWNTOWN, GREENBELT, DOCKS];

export function trackById(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0]!;
}
