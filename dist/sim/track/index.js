import { DOCKS } from './docks.js';
import { DOWNTOWN } from './downtown.js';
import { GREENBELT } from './greenbelt.js';
/** Every track, in championship rotation order. */
export const TRACKS = [DOWNTOWN, GREENBELT, DOCKS];
export function trackById(id) {
    return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}
//# sourceMappingURL=index.js.map