import { DOCKS } from './docks.js';
import { DOWNTOWN, DOWNTOWN_DAY } from './downtown.js';
import { GREENBELT } from './greenbelt.js';
/**
 * Every track, in championship rotation order. New tracks go on the end: a
 * room's heartbeat names a built-in track by its index here.
 */
export const TRACKS = [DOWNTOWN, GREENBELT, DOCKS, DOWNTOWN_DAY];
export function trackById(id) {
    return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}
//# sourceMappingURL=index.js.map