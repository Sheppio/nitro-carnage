import { hashString, mulberry32 } from '../../util.js';
import { Surface } from '../surfaces.js';
import { Track } from './buildTrack.js';
import { validateTrack } from './validate.js';
import { GRID_RADIUS, gridBend } from './gridStart.js';
import { sweepCorners } from './sweep.js';
/**
 * A candidate is kept if it validates and its whole grid is on a straight:
 * shortened to 30 s laps, one seed in 25 put the back rows on a bend.
 */
function fits(def) {
    const t = new Track({ ...def, props: [] });
    return validateTrack(t) === null && gridBend(t) <= 1 / GRID_RADIUS;
}
/**
 * Tracks from a seed (PLAN.md M7): the track of the day, and any track a
 * player can name.
 *
 * The same seed must give the same track on every computer, so the
 * generator deals only in integers until it hands over a `TrackDef`:
 * - the random numbers are mulberry32, which is integer arithmetic, and its
 *   draws are turned into choices by exact integer maths;
 * - angles are whole degrees, looked up in a table of cosines and sines
 *   rounded to integers, so no two JavaScript engines can disagree in the
 *   last bit of a `Math.sin`;
 * - corners are whole metres.
 * So the `TrackDef` — the thing that decides the track — is identical
 * everywhere, and a test pins a table of seeds to their exact output.
 *
 * A candidate that fails `validateTrack` is thrown away and the generator
 * draws again from the same stream, so the retries are part of the
 * determinism too.
 */
/** cos and sin of whole degrees, times 10000, rounded: integer trigonometry. */
const COS = Array.from({ length: 360 }, (_, d) => Math.round(Math.cos((d * Math.PI) / 180) * 10000));
const SIN = Array.from({ length: 360 }, (_, d) => Math.round(Math.sin((d * Math.PI) / 180) * 10000));
const THEMES = ['dusk', 'park', 'overcast'];
const FIRST = ['Copper', 'Harbour', 'Neon', 'Rust', 'Velvet', 'Iron', 'Silver', 'Sunset', 'Midnight', 'Amber', 'Cobalt', 'Granite', 'Hollow', 'Signal', 'Static', 'Ember'];
const SECOND = ['Loop', 'Ring', 'Circuit', 'Run', 'Sprint', 'Bends', 'Mile', 'Park', 'Yard', 'Heights', 'Cross', 'Reach'];
/** The seed of any text a player types: case and spacing do not matter. */
export function seedOf(text) {
    return hashString(text.trim().toUpperCase().replace(/\s+/g, ' ')) || 1;
}
/** Today's date in UTC as YYYY-MM-DD: the same string everywhere on Earth at the same instant. */
export function utcDay(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}
/** The track of the day's seed. */
export function daySeed(ms) {
    return seedOf(utcDay(ms));
}
/**
 * The day's seed is its date: `2026-09-28` typed as a seed is that day's
 * Track of the Day, so a past day can be raced again. A day after today (UTC) is `locked`, so nobody practises
 * tomorrow's track. Null when the text isn't a real date: then it's just a word.
 */
export function dateSeed(text, nowMs) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/i.exec(text.trim());
    if (!m)
        return null;
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    // 2026-02-30 rolls over to March: not a date.
    if (!Number.isFinite(ms) || utcDay(ms) !== day)
        return null;
    return { day, seed: seedOf(day), locked: day > utcDay(nowMs) };
}
/** A name for a seed, drawn from its own stream, so a shared seed is a shared name. */
export function trackName(seed) {
    const rand = mulberry32(seed ^ 0x6e616d65);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    return `${pick(FIRST)} ${pick(SECOND)}`;
}
const cache = new Map();
/**
 * The track for a seed. Memoised: a race builds its `Track` from this, and
 * the racing line is cached per track.
 */
export function generateTrack(seed) {
    const s = seed >>> 0 || 1;
    const hit = cache.get(s);
    if (hit)
        return hit;
    const rand = mulberry32(s);
    const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
    const style = pickStyle(int, s);
    for (let attempt = 0; attempt < 400; attempt++) {
        try {
            const def = candidate(s, int, attempt, style);
            // Checked bare: scattering a city round a candidate only to throw it away is most of the cost.
            if (fits(def)) {
                cache.set(s, def);
                return def;
            }
        }
        catch {
            // A corner radius that does not fit between its neighbours, or a lap still round: draw again.
        }
    }
    throw new Error(`no valid track for seed ${s}`);
}
/** How many candidates a seed took, for tests and tuning. */
export function attemptsFor(seed) {
    const s = seed >>> 0 || 1;
    const rand = mulberry32(s);
    const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
    const style = pickStyle(int, s);
    for (let attempt = 0; attempt < 400; attempt++) {
        try {
            if (fits(candidate(s, int, attempt, style)))
                return attempt + 1;
        }
        catch {
            /* next */
        }
    }
    return Infinity;
}
/** The longest a loop or straights may run round its corners, in metres: about a 36 s lap. */
const LONGEST = 1120;
/** Layout styles, and how each reads on the menu. */
const LAYOUTS = ['loop', 'grid', 'straights'];
const LAYOUT_NAMES = { loop: 'Flowing loop', grid: 'City grid', straights: 'Long straights' };
/**
 * A seed's look and shape, drawn once before any candidate: a layout that
 * fails validation more often is retried until it passes, not swapped for
 * an easier one, so each layout gets its fair third of the seeds.
 */
function pickStyle(int, seed) {
    const theme = THEMES[int(0, THEMES.length - 1)];
    const layout = LAYOUTS[int(0, LAYOUTS.length - 1)];
    // A city is by day or at dusk, half and half (M10). Drawn from a stream of
    // its own, so the choice leaves every other draw — the shape — as it was.
    const day = theme === 'dusk' && mulberry32(seed ^ 0x64617921)() < 0.5;
    // The infield feature, also from a stream of its own, and drawn once per
    // seed: a retry keeps it. Rolled afresh on every candidate, it was the
    // plain shapes that passed validation most, so retries quietly chose ovals.
    // Always a pocket, and half the time a kidney as well: a kidney alone is
    // too shallow a dent to take a lap out of the round, and it took twenty
    // candidates a seed to find one that was.
    const kidney = mulberry32(seed ^ 0x706f636b)() < 0.5;
    return { theme: day ? 'day' : theme, layout, feature: { pocket: true, kidney } };
}
function candidate(seed, int, attempt, { theme, layout, feature }) {
    // The tightest corner a theme allows: the park's wide grass verge puts its wall further in.
    const tight = theme === 'park' ? 16 : 14;
    let corners = layout === 'grid' ? grid(int, tight) : layout === 'straights' ? straights(int, tight) : loop(int, theme);
    // Either way round.
    if (int(0, 1))
        corners = corners.reverse();
    fit(corners);
    // Shrunk to about a 30 s lap. The layouts were drawn for 1.2-1.8 km, and
    // their spacing rules (notches, dents, sweepers) are in those metres, so
    // they draw as they did and the whole shape scales, in integers so every
    // client rounds alike, by what a lap of each costs: a city grid, all right
    // angles, to 3/5 (its points are on a 5 m grid, which 3/5 keeps exact, so
    // its right angles and diagonals stay true); long straights to 17/20; a
    // flowing loop, the fastest per metre, to 9/10. A radius keeps room for the
    // inside wall.
    const [num, den] = layout === 'grid' ? [3, 5] : layout === 'straights' ? [17, 20] : [9, 10];
    corners = corners.map(([x, z, r]) => [Math.round((x * num) / den), Math.round((z * num) / den), Math.max(Math.round((r * num) / den), tight)]);
    // A pocket into the infield adds a long way round: a loop or straights
    // whose corners run to more than LONGEST is shrunk to it, so its lap stays
    // near 30 s. Per mille, in integers (the perimeter is a sum of exact square
    // roots, the same everywhere). Not the grid: its lap is short already.
    if (layout !== 'grid') {
        let around = 0;
        for (let i = 0; i < corners.length; i++)
            around += dist(corners[i], corners[(i + 1) % corners.length]);
        const k = Math.floor((LONGEST * 1000) / around);
        if (k < 1000)
            corners = corners.map(([x, z, r]) => [Math.round((x * k) / 1000), Math.round((z * k) / 1000), Math.max(Math.round((r * k) / 1000), tight)]);
        // Into the infield, in the metres the track is raced at: drawn before the
        // shrink, a pocket's hairpin came out too tight and its arms too close,
        // and most failed validation.
        corners = infield(corners, int, tight, feature);
        fit(corners);
        // Still a blob (the dents too shallow to show), or a corner squeezed
        // tighter than the validator allows: draw again, before building a Track.
        if (!dented(corners))
            throw new Error('no infield');
        const least = theme === 'park' ? 16 : theme === 'overcast' ? 12 : 13;
        if (corners.some((c) => c[2] > 0 && c[2] < least))
            throw new Error('too tight');
    }
    fit(corners);
    // Rounder (#20): drawn as a handful of points, a flowing loop read as short
    // straights between tight arcs. Its corners grow into most of the room
    // their edges leave, so its bends run into one another as one sweep; long
    // straights' corners into half of it, so the straights stay. A city grid
    // keeps its right angles.
    if (layout !== 'grid')
        corners = sweepCorners(corners, { share: layout === 'loop' ? 900 : 500 });
    const n = corners.length;
    // The longest edge is the main straight: the start line goes on it.
    let longest = 0;
    let best = -1;
    for (let i = 0; i < n; i++) {
        const [ax, az] = corners[i];
        const [bx, bz] = corners[(i + 1) % n];
        const len2 = (bx - ax) * (bx - ax) + (bz - az) * (bz - az);
        if (len2 > best) {
            best = len2;
            longest = i;
        }
    }
    const [sx0, sz0] = corners[longest];
    const [sx1, sz1] = corners[(longest + 1) % n];
    // A third of the way along it, so the grid behind the line is on the straight too.
    const start = [Math.round(sx0 + ((sx1 - sx0) * 2) / 3), Math.round(sz0 + ((sz1 - sz0) * 2) / 3)];
    // A jump on the second-longest edge, sometimes.
    let second = -1;
    let secondLen = -1;
    for (let i = 0; i < n; i++) {
        if (i === longest)
            continue;
        const [ax, az] = corners[i];
        const [bx, bz] = corners[(i + 1) % n];
        const len2 = (bx - ax) * (bx - ax) + (bz - az) * (bz - az);
        if (len2 > secondLen) {
            secondLen = len2;
            second = i;
        }
    }
    const jump = int(0, 2) > 0 && secondLen > 110 * 110;
    const [jx0, jz0] = corners[second];
    const [jx1, jz1] = corners[(second + 1) % n];
    const props = [];
    const area = [-340, -340, 340, 340];
    let water;
    if (theme === 'dusk' || theme === 'day') {
        props.push({ kind: 'city', area, lot: 20, clearance: 0.5, footprint: [12, 18], height: [10, 34], gaps: 0.06, tallness: 0.9 });
        props.push({ kind: 'lamps', spacing: 28 });
    }
    else if (theme === 'park') {
        // Farmland (M10), before the trees so they keep off it.
        props.push({ kind: 'farms', count: 2, clearance: 3 });
        props.push({ kind: 'windmills', count: 2, clearance: 3 });
        props.push({ kind: 'fields', count: 6, clearance: 2 });
        props.push({ kind: 'herds', count: 4, clearance: 2 });
        props.push({ kind: 'ponds', count: 3, clearance: 3 });
        props.push({ kind: 'flowers', spacing: 36 });
        props.push({ kind: 'trees', area, count: 2100, clearance: 2.5, height: [7, 17] });
    }
    else {
        const port = harbour(corners, sx0, sz0, sx1, sz1, seed);
        water = [port.water];
        props.push({ kind: 'warehouses', count: 4, clearance: 3 });
        props.push({ kind: 'containers', area, clearance: 1.5, stack: 4, gaps: 0.1, yards: 0.2 });
        props.push(...port.props);
    }
    return {
        id: `seed-${seed.toString(36)}`,
        name: trackName(seed),
        laps: 3,
        seed: (seed ^ Math.imul(attempt + 1, 0x9e3779b1)) >>> 0,
        theme,
        layout: LAYOUT_NAMES[layout],
        corners,
        // A quarter wider than the first tracks' 13 and 14 m, from play-testing.
        width: theme === 'park' ? 16.25 : 17.5,
        verge: theme === 'park' ? { width: 6, surface: Surface.Grass } : { width: theme === 'overcast' ? 2 : 3, surface: Surface.Kerb },
        walls: true,
        start,
        checkpoints: [0.25, 0.5, 0.75],
        ...(water ? { water } : {}),
        surfaces: [],
        ramps: jump ? [{ at: [Math.round((jx0 + jx1) / 2), Math.round((jz0 + jz1) / 2)], len: 14, lift: 1.4 }] : [],
        props,
    };
}
/**
 * A loose star: evenly spread bearings, jittered, at jittered distances, with
 * open corners. The flowing sort of circuit.
 */
function loop(int, theme) {
    const n = int(7, 11);
    const corners = [];
    const spread = Math.floor(360 / n);
    const base = int(0, 359);
    // Stretched along a bearing of its own, by up to half as long again, so not every loop is round.
    const stretch = int(100, 150);
    const turn = int(0, 359);
    const radius = int(140, 210);
    for (let i = 0; i < n; i++) {
        const deg = (base + i * spread + int(-Math.floor(spread / 3), Math.floor(spread / 3)) + 720) % 360;
        const r = radius + int(-60, 50);
        const x = Math.round((r * stretch * COS[deg]) / 1000000);
        const z = Math.round((r * SIN[deg]) / 10000);
        corners.push([Math.round((x * COS[turn] - z * SIN[turn]) / 10000), Math.round((x * SIN[turn] + z * COS[turn]) / 10000), int(theme === 'park' ? 30 : 16, theme === 'park' ? 60 : 40)]);
    }
    return corners;
}
/**
 * What the real circuits have and a star does not (#3): road that dives into
 * the infield and comes back out. The seed's feature says which:
 * - a pocket: one long edge has a notch cut into the infield, in, across and
 *   back out, square like the city grid's notches, so every turn is a right
 *   angle that fits the room it has (at a corner, the turn into the pocket
 *   was 120-150° and too tight for its arms). The arms are 56-76 m apart,
 *   comfortably over the validator's 40 m;
 * - a kidney: a corner pushed in past the line between its neighbours, so
 *   the lap bends inwards there however thin the track is (pulled towards the
 *   middle instead, a long thin track's corner barely moved off that line).
 * Works on the corners as raced, after the shrink to a 30 s lap.
 */
function infield(corners, int, tight, feature) {
    const n = corners.length;
    // The pocket goes in one of the two longest edges long enough to take it.
    let pocket = -1;
    if (feature.pocket) {
        const long = corners.map((c, k) => [dist(c, corners[(k + 1) % n]), k]).filter(([d]) => d >= 170).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
        if (!long.length)
            throw new Error('no edge for the pocket');
        pocket = long[Math.min(int(0, 1), long.length - 1)][1];
    }
    // The kidney's corner is not at either end of the pocket's edge.
    let kidney = -1;
    if (feature.kidney) {
        kidney = int(0, n - 1);
        if (pocket >= 0 && (kidney === pocket || kidney === (pocket + 1) % n))
            kidney = (pocket + 2) % n;
    }
    // Inward is to the left of the way round when the lap runs anticlockwise (positive shoelace sum), else to the right.
    let sum = 0;
    for (let k = 0; k < n; k++)
        sum += corners[k][0] * corners[(k + 1) % n][1] - corners[(k + 1) % n][0] * corners[k][1];
    const left = sum > 0 ? 1 : -1;
    const out = [];
    for (let i = 0; i < n; i++) {
        const c = corners[i];
        const [x, z] = c;
        if (i === kidney) {
            // The foot of the corner on the line between its neighbours, and the corner pushed through it by a quarter to nearly half again.
            const p = corners[(i + n - 1) % n];
            const q = corners[(i + 1) % n];
            const lx = q[0] - p[0], lz = q[1] - p[1];
            const len2 = lx * lx + lz * lz;
            const t = len2 === 0 ? 0 : ((x - p[0]) * lx + (z - p[1]) * lz) / len2;
            const fx = p[0] + lx * t, fz = p[1] + lz * t;
            const push = int(125, 145);
            out.push([Math.round(x + ((fx - x) * push) / 100), Math.round(z + ((fz - z) * push) / 100), int(tight, tight + 14)]);
        }
        else {
            out.push(c);
        }
        if (i !== pocket)
            continue;
        // Along the edge, per mille, and inward, square to it.
        const q = corners[(i + 1) % n];
        const len = dist(c, q);
        const ux = Math.round(((q[0] - x) * 1000) / len);
        const uz = Math.round(((q[1] - z) * 1000) / len);
        const ix = -uz * left;
        const iz = ux * left;
        const gap = int(56, 76);
        // Somewhere near the middle of the edge, clear of the corners at its ends.
        const mid = Math.round(len / 2) + int(-Math.floor((len - gap - 110) / 2), Math.floor((len - gap - 110) / 2));
        const a = mid - Math.round(gap / 2);
        const b = a + gap;
        const pt = (along, down) => [Math.round(x + (ux * along + ix * down) / 1000), Math.round(z + (uz * along + iz * down) / 1000)];
        // As deep as it will go, up to 130 m, while its far side stays 50 m clear of the rest of the lap.
        let depth = int(90, 130);
        while (depth >= 50 && !clear([pt(a, depth), pt(b, depth), pt(mid, depth)], corners, i))
            depth -= 10;
        // No room (a track too thin to take it): this candidate has no pocket, and is drawn again.
        if (depth < 50)
            throw new Error('no room for the pocket');
        const r = () => int(tight, tight + 8);
        out.push([...pt(a, 0), r()], [...pt(a, depth), Math.floor(gap / 2)], [...pt(b, depth), Math.floor(gap / 2)], [...pt(b, 0), r()]);
    }
    return out;
}
/**
 * Are these points of a pocket's far side all at least 50 m from every edge
 * of the lap but the one the pocket is cut into? Its road would otherwise
 * come within the validator's 40 m of another stretch.
 */
function clear(pts, corners, cut) {
    const n = corners.length;
    for (let k = 0; k < n; k++) {
        if (k === cut)
            continue;
        const a = corners[k], b = corners[(k + 1) % n];
        const lx = b[0] - a[0], lz = b[1] - a[1];
        const len2 = lx * lx + lz * lz;
        for (const [px, pz] of pts) {
            const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * lx + (pz - a[1]) * lz) / len2));
            const dx = px - (a[0] + lx * t), dz = pz - (a[1] + lz * t);
            if (dx * dx + dz * dz < 50 * 50)
                return false;
        }
    }
    return true;
}
/**
 * Does the lap really bend into its middle? Its area is at most 88% of its
 * convex hull's: a plain star or oval is 92-100%. Both areas are exact
 * integers (twice the shoelace sum, of whole-metre corners), so every engine
 * agrees.
 */
function dented(corners) {
    const pts = corners.map(([x, z]) => [x, z]);
    return 100 * area2(pts) <= 88 * area2(hull(pts));
}
/** Twice a polygon's area, by the shoelace formula. */
function area2(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
        a += x1 * z2 - x2 * z1;
    }
    return Math.abs(a);
}
/** The convex hull, by the monotone chain: integer cross products only. */
function hull(pts) {
    const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    const upper = [];
    for (const q of p) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0)
            lower.pop();
        lower.push(q);
    }
    for (const q of p.reverse()) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0)
            upper.pop();
        upper.push(q);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
}
/**
 * City blocks, like Neon Downtown and the Docks: a rectangle whose sides have
 * square notches cut in or pushed out, and now and then a corner cut off on
 * the diagonal. Right angles and tight radii; every point on a 10 m grid.
 */
function grid(int, tight) {
    const w = int(28, 40) * 10;
    const h = int(20, 32) * 10;
    // Clockwise on screen from the top-left: along the top, down the right, back along the bottom, up the left.
    const sides = [
        { from: [0, 0], dir: [1, 0], len: w },
        { from: [w, 0], dir: [0, 1], len: h },
        { from: [w, h], dir: [-1, 0], len: w },
        { from: [0, h], dir: [0, -1], len: h },
    ];
    const corners = [];
    const at = (x, z, r) => {
        corners.push([x, z, r]);
    };
    const r = () => int(tight, tight + 10);
    for (const side of sides) {
        const [fx, fz] = side.from;
        const [dx, dz] = side.dir;
        // Inward is the direction turned right (clockwise on screen, +Z down): (dx, dz) -> (-dz, dx).
        const ix = -dz;
        const iz = dx;
        const across = side.len === w ? h : w;
        // The corner at the start of this side: square, or cut on the diagonal.
        if (int(0, 3) === 0) {
            const c = int(3, 5) * 10;
            at(fx + ix * c, fz + iz * c, r() + 6);
            at(fx + dx * c, fz + dz * c, r() + 6);
        }
        else {
            at(fx, fz, r());
        }
        // Up to two notches along the side, clear of its ends and of each other.
        const notches = side.len >= 320 ? int(0, 2) : int(0, 1);
        let pos = 90;
        for (let k = 0; k < notches; k++) {
            const room = side.len - 90 - pos - (notches - k - 1) * 130;
            if (room < 60)
                break;
            const span = int(6, Math.min(12, Math.floor(room / 10))) * 10;
            const a = pos + int(0, Math.floor((room - span) / 10)) * 10;
            const b = a + span;
            // In is into the block the circuit goes round; out pushes a block onto the outside.
            const inward = int(0, 2) > 0;
            const depth = (inward ? Math.min(int(6, 12), Math.floor((across - 90) / 10)) : int(6, 10)) * 10;
            if (depth < 50)
                break;
            const s = inward ? 1 : -1;
            at(fx + dx * a, fz + dz * a, r());
            at(fx + dx * a + ix * depth * s, fz + dz * a + iz * depth * s, r());
            at(fx + dx * b + ix * depth * s, fz + dz * b + iz * depth * s, r());
            at(fx + dx * b, fz + dz * b, r());
            pos = b + 70;
        }
    }
    // Centred on the origin, so the scenery's square is round it.
    return corners.map(([x, z, rr]) => [x - Math.round(w / 2), z - Math.round(h / 2), rr]);
}
/**
 * A long, thin circuit: a stretched star with few corners, deep dents that
 * make hairpins at the ends, and radii from a crawl to flat out. Turned to
 * any whole-degree bearing.
 */
function straights(int, tight) {
    const n = int(6, 9);
    const spread = Math.floor(360 / n);
    const base = int(0, 359);
    const turn = int(0, 359);
    const long = int(330, 430);
    const short = int(150, 210);
    // One corner pulled well in: a dent in a long side, and a hairpin into and out of it.
    const dent = int(0, n - 1);
    const corners = [];
    for (let i = 0; i < n; i++) {
        const deg = (base + i * spread + int(-Math.floor(spread / 4), Math.floor(spread / 4)) + 720) % 360;
        const pull = i === dent ? int(25, 50) : int(60, 100);
        const x = Math.round((long * pull * COS[deg]) / 1000000);
        const z = Math.round((short * pull * SIN[deg]) / 1000000);
        const rx = Math.round((x * COS[turn] - z * SIN[turn]) / 10000);
        const rz = Math.round((x * SIN[turn] + z * COS[turn]) / 10000);
        corners.push([rx, rz, int(tight, tight + 12)]);
    }
    // The gentle ones — under about 45° — may be fast sweepers instead.
    for (let i = 0; i < n; i++) {
        const t = tanHalf(corners[(i + n - 1) % n], corners[i], corners[(i + 1) % n]);
        if (int(0, 1) === 0 && t < 0.41)
            corners[i][2] = int(30, 50);
    }
    return corners;
}
/**
 * Shrink any corner too round for its edges: a fillet of radius r turning
 * through angle θ runs r·tan(θ/2) along each edge, and may have half of each.
 * tan(θ/2) comes from the edges as |a×b| / (|a||b| + a·b), which needs only
 * square roots, and IEEE square roots are exact: the same on every engine.
 */
function fit(corners) {
    const n = corners.length;
    for (let i = 0; i < n; i++) {
        const p = corners[(i + n - 1) % n];
        const c = corners[i];
        const q = corners[(i + 1) % n];
        const t = tanHalf(p, c, q);
        if (t === 0)
            continue;
        const most = Math.floor(Math.min(dist(p, c), dist(c, q)) / 2 / t);
        if (c[2] > most)
            c[2] = most;
    }
}
/** Straight-line distance between two corners, by an exact square root. */
function dist(a, b) {
    return Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
}
/** tan of half the angle the road turns through at `c`, coming from `p` and going on to `q`; 0 if it runs straight on. */
function tanHalf(p, c, q) {
    const ax = c[0] - p[0], az = c[1] - p[1], bx = q[0] - c[0], bz = q[1] - c[1];
    const den = dist(p, c) * dist(c, q) + ax * bx + az * bz;
    const cross = Math.abs(ax * bz - az * bx);
    return cross === 0 || den <= 0 ? 0 : cross / den;
}
/**
 * A harbour for a generated port (M10): water beyond the side of the track's
 * bounding box nearest the main straight, so it is seen every lap; quay
 * cranes along its edge, two ships under their booms, and on some seeds a
 * marina. All whole metres, and no draws from the stream, so the track's
 * shape is the same as it would be without it. The walls keep every car out
 * of the water: the wall is at least 7 m short of it.
 */
function harbour(corners, sx0, sz0, sx1, sz1, seed) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of corners) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
    }
    // The straight's middle, doubled to stay in integers.
    const mx = sx0 + sx1, mz = sz0 + sz1;
    const gaps = [mz - 2 * minZ, 2 * maxX - mx, 2 * maxZ - mz, mx - 2 * minX];
    const side = gaps.indexOf(Math.min(...gaps)); // 0 north, 1 east, 2 south, 3 west
    const Q = 18; // apron between the outermost corner and the water: the wall is at most 10.75 m out
    const far = 420;
    // The quay line runs so that the water is on its right (negative `out` puts ships on its left).
    let water;
    let from, to;
    if (side === 0) {
        water = [minX - 200, minZ - Q - far, maxX + 200, minZ - Q];
        from = [minX, minZ - Q];
        to = [maxX, minZ - Q];
    }
    else if (side === 1) {
        water = [maxX + Q, minZ - 200, maxX + Q + far, maxZ + 200];
        from = [maxX + Q, minZ];
        to = [maxX + Q, maxZ];
    }
    else if (side === 2) {
        water = [minX - 200, maxZ + Q, maxX + 200, maxZ + Q + far];
        from = [maxX, maxZ + Q];
        to = [minX, maxZ + Q];
    }
    else {
        water = [minX - Q - far, minZ - 200, minX - Q, maxZ + 200];
        from = [minX - Q, maxZ];
        to = [minX - Q, minZ];
    }
    // Along the quay, the water is on the left of from→to: out is negative.
    const len = Math.abs(to[0] - from[0]) + Math.abs(to[1] - from[1]);
    const dx = Math.sign(to[0] - from[0]), dz = Math.sign(to[1] - from[1]);
    // Cranes 11 m out, booms over the water: yaw so the crane's -Z points away from the land.
    const yaw = [0, -Math.PI / 2, Math.PI, Math.PI / 2][side];
    // The left of from→to on screen (+Z is down): towards the water.
    const lx = dz, lz = -dx;
    const cranes = [];
    for (let s = 40; s < len - 20 && cranes.length < 4; s += 75)
        cranes.push([from[0] + dx * s + lx * 11, from[1] + dz * s + lz * 11, yaw]);
    const props = [
        { kind: 'cranes', at: cranes },
        { kind: 'ships', from, to, out: -42, count: len > 300 ? 2 : 1 },
    ];
    if ((seed >>> 3) & 1) {
        // A marina past the end of the quay.
        const s0 = Math.max(0, len - 20);
        props.push({ kind: 'marina', from: [from[0] + dx * s0, from[1] + dz * s0], to: [from[0] + dx * (s0 + 150), from[1] + dz * (s0 + 150)], out: -14 });
    }
    return { water, props };
}
//# sourceMappingURL=generate.js.map