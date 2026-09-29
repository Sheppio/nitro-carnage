import { racesScored } from './championship.js';
import { standings } from './race.js';
/**
 * One race's story, from its events: who wrecked whom and with what, who hit
 * the wall, who landed shots, and where everybody started. Every client sees
 * the same wrecks and hits (the network announces them into every world), so
 * every screen tells the same story.
 */
export class RaceLog {
    /** Grid position at GO, 1-based. Empty for a client that arrived after GO. */
    start = new Map();
    kills = new Map();
    wrecked = new Map();
    /** Wrecks nobody was credited with: walls, a train, driving into your own mine. */
    selfWrecks = new Map();
    hits = new Map();
    /** Wrecks by killer and victim, keyed `killer>victim`. */
    pairs = new Map();
    feed = [];
    /** The last weapon to hit each car, and who fired it. */
    lastHit = new Map();
    onEvent(ev, entrants) {
        if (ev.kind === 'go') {
            standings(entrants).forEach((e, i) => this.start.set(e.id, i + 1));
        }
        else if (ev.kind === 'hit') {
            if (ev.by !== ev.id)
                bump(this.hits, ev.by);
            this.lastHit.set(ev.id, { by: ev.by, weapon: ev.weapon });
        }
        else if (ev.kind === 'wreck') {
            bump(this.wrecked, ev.id);
            const last = this.lastHit.get(ev.id);
            this.lastHit.delete(ev.id);
            let cause = 'wall';
            if (ev.by) {
                bump(this.kills, ev.by);
                bump(this.pairs, `${ev.by}>${ev.id}`);
                // A wall that finishes a car off credits whoever hurt it last: the weapon did the work.
                if (last && last.by === ev.by)
                    cause = last.weapon;
            }
            else {
                bump(this.selfWrecks, ev.id);
            }
            const entry = { by: ev.by, id: ev.id, cause, time: ev.time };
            this.feed.push(entry);
            return entry;
        }
        return null;
    }
}
function bump(m, k, by = 1) {
    m.set(k, (m.get(k) ?? 0) + by);
}
/** The largest value in a map, and whose it is; ties go to the earlier key in `order`. */
function top(m, order) {
    let best = null;
    const rank = (id) => {
        const i = order.indexOf(id);
        return i < 0 ? order.length : i;
    };
    for (const [id, n] of m) {
        if (!best || n > best[1] || (n === best[1] && rank(id) < rank(best[0])))
            best = [id, n];
    }
    return best;
}
const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
/**
 * Up to `max` awards for the results screen, most interesting first. Each is
 * given only when it means something (one wreck is not a rampage), and nobody
 * gets two.
 *
 * @param order finishing order, by id
 */
export function awards(log, order, name, max = 3) {
    const out = [];
    const has = (id) => out.some((a) => a.id === id);
    const add = (a) => {
        if (out.length < max && !has(a.id))
            out.push(a);
    };
    const pair = top(log.pairs, []);
    if (pair && pair[1] >= 2) {
        const [by, id] = pair[0].split('>');
        add({ title: 'Grudge match', id: by, text: `${name(by)} wrecked ${name(id)} ${times(pair[1])}` });
    }
    const killer = top(log.kills, order);
    if (killer && killer[1] >= 2)
        add({ title: 'Wrecking ball', id: killer[0], text: `${name(killer[0])}: ${killer[1]} wrecks` });
    let comeback = { id: '', gained: 1 };
    order.forEach((id, i) => {
        const from = log.start.get(id);
        const gained = from === undefined ? 0 : from - (i + 1);
        if (gained > comeback.gained)
            comeback = { id, gained };
    });
    if (comeback.id) {
        const { id, gained } = comeback;
        add({ title: 'Comeback', id, text: `${name(id)}: ${log.start.get(id)} → ${order.indexOf(id) + 1}, up ${gained} places` });
    }
    const walls = top(log.selfWrecks, order);
    if (walls)
        add({ title: 'Kamikaze', id: walls[0], text: `${name(walls[0])} wrecked themselves ${times(walls[1])}` });
    // Nobody laid a finger on them, in a race where plenty of others were wrecked.
    const total = [...log.wrecked.values()].reduce((a, b) => a + b, 0);
    const clean = order.find((id) => !log.wrecked.has(id));
    if (clean && total >= 3)
        add({ title: 'Untouchable', id: clean, text: `${name(clean)} was never wrecked` });
    const shooter = top(log.hits, order);
    if (shooter && shooter[1] >= 3)
        add({ title: 'Sharpshooter', id: shooter[0], text: `${name(shooter[0])}: ${shooter[1]} hits` });
    return out;
}
/**
 * A room's running score across races: points and wins as the room keeps them
 * (`sync`, from the heartbeat), and the wrecks this client saw, with who has
 * wrecked whom the most. The wrecks are this client's own memory, so one who
 * joined late has a shorter one; the points are everyone's.
 */
export class Tally {
    rows = new Map();
    pairs = new Map();
    /** Races the room has scored. */
    races = 0;
    /** Add a finished race's wrecks. */
    add(order, log, name, bot) {
        for (const id of order) {
            const r = this.row(id, name, bot);
            r.kills += log.kills.get(id) ?? 0;
            r.wrecked += log.wrecked.get(id) ?? 0;
        }
        for (const [k, n] of log.pairs)
            bump(this.pairs, k, n);
    }
    /** Take the room's points and wins: whoever is not on its table has none. */
    sync(score, name, bot) {
        const races = racesScored(score);
        // Fewer races than before: a championship has started a clean table, and the wrecks start again with it.
        if (races < this.races) {
            this.rows.clear();
            this.pairs.clear();
        }
        for (const r of this.rows.values())
            r.points = r.wins = 0;
        for (const s of score) {
            const r = this.row(s.id, name, bot);
            r.points = s.points;
            r.wins = s.wins;
        }
        this.races = races;
    }
    row(id, name, bot) {
        let r = this.rows.get(id);
        if (!r) {
            r = { id, name: name(id), bot: bot(id), wins: 0, points: 0, kills: 0, wrecked: 0 };
            this.rows.set(id, r);
        }
        // A player who has left keeps the name they raced under.
        const now = name(id);
        if (now !== '—')
            r.name = now;
        return r;
    }
    /** Everyone who has scored or raced, best first: points, then wins, then wrecks dealt. */
    standings() {
        return [...this.rows.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || b.kills - a.kills || (a.id < b.id ? -1 : 1));
    }
    /** Who has wrecked this car the most across the races, if anyone has done it twice. */
    nemesis(id) {
        let best = null;
        for (const [k, n] of this.pairs) {
            const [by, victim] = k.split('>');
            if (victim === id && n >= 2 && (!best || n > best.count))
                best = { id: by, count: n };
        }
        return best;
    }
    /** A tallied car's name, as it last raced. */
    name(id) {
        return this.rows.get(id)?.name ?? '—';
    }
}
//# sourceMappingURL=raceLog.js.map