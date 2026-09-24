import { DOWNTOWN } from './downtown.js';
/** Every track, in championship rotation order. */
export const TRACKS = [DOWNTOWN];
export function trackById(id) {
    return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}
//# sourceMappingURL=index.js.map