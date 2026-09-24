import { DOWNTOWN } from './downtown.js';
import type { TrackDef } from './TrackDef.js';

/** Every track, in championship rotation order. */
export const TRACKS: readonly TrackDef[] = [DOWNTOWN];

export function trackById(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0]!;
}
