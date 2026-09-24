/**
 * Wire codec. Every message is a short delimited base36 string, never JSON.
 *
 * Fields are comma-separated; lists inside a field use `.`; records in an
 * event batch use `|` with a one-letter tag. Numbers are base36, signed with
 * a leading `-`. Decoders tolerate truncation — a malformed message is
 * dropped, never thrown — and new fields only ever go on the end, so a
 * client on an older cached build still decodes what it understands.
 *
 * Byte counts are in PLAN.md §5.9 and asserted by `test/net.test.mjs`.
 */
const FLD = ',';
const LIST = '.';
const REC = '|';
const i = (n) => (Number.isFinite(n) ? Math.round(n) : 0);
export const b36 = (n) => i(n).toString(36);
export const un36 = (s) => {
    if (!s)
        return 0;
    const v = parseInt(s, 36);
    return Number.isFinite(v) ? v : 0;
};
/** Timestamps travel as room milliseconds modulo 36^4 — four characters, a 28-minute wrap. */
export const STAMP_WRAP = 36 ** 4;
export function encodeStamp(roomMs) {
    return b36(((i(roomMs) % STAMP_WRAP) + STAMP_WRAP) % STAMP_WRAP);
}
/** The full room time a wrapped stamp most plausibly means, given the time now. */
export function decodeStamp(s, nowRoomMs) {
    const v = un36(s);
    return v + STAMP_WRAP * Math.round((nowRoomMs - v) / STAMP_WRAP);
}
/* ------------------------------------------------------------ car state */
export const CAR_FLAG = {
    throttle: 1,
    brake: 2,
    handbrake: 4,
    boost: 8,
    drift: 16,
    airborne: 32,
    ghost: 64,
    finished: 128,
};
const TURN = Math.PI * 2;
const MAX_STEER = 0.6;
/**
 * `t,x,z,yaw,vx,vz,w,steer,y,vy,flags,hp,lap,s` — the car's id is in the topic.
 *
 * Positions and speeds in decimetres (and dm/s): peers dead-reckon and blend,
 * so 5 cm of quantisation is invisible. Yaw in 1/1296 of a turn (two
 * characters, 0.28°). Steering as one character, 0-35.
 */
export function encodeCar(p) {
    const yaw = ((Math.round((p.yaw / TURN) * 1296) % 1296) + 1296) % 1296;
    const steer = Math.max(0, Math.min(35, Math.round(((p.steer / MAX_STEER + 1) / 2) * 35)));
    return [
        encodeStamp(p.t),
        b36(p.x * 10),
        b36(p.z * 10),
        b36(yaw),
        b36(p.vx * 10),
        b36(p.vz * 10),
        b36(p.w * 100),
        steer.toString(36),
        b36(p.y * 100),
        b36(p.vy * 10),
        b36(p.flags),
        b36(p.hp),
        b36(p.lap + 1),
        b36(p.s),
    ].join(FLD);
}
export function decodeCar(payload, nowRoomMs) {
    const f = payload.split(FLD);
    if (f.length < 14)
        return null;
    return {
        t: decodeStamp(f[0], nowRoomMs),
        x: un36(f[1]) / 10,
        z: un36(f[2]) / 10,
        yaw: (un36(f[3]) / 1296) * TURN,
        vx: un36(f[4]) / 10,
        vz: un36(f[5]) / 10,
        w: un36(f[6]) / 100,
        steer: ((un36(f[7]) / 35) * 2 - 1) * MAX_STEER,
        y: un36(f[8]) / 100,
        vy: un36(f[9]) / 10,
        flags: un36(f[10]),
        hp: un36(f[11]),
        lap: un36(f[12]) - 1,
        s: un36(f[13]),
    };
}
export function encodeEvents(events) {
    const parts = [];
    for (const e of events) {
        switch (e.k) {
            case 'lap':
                parts.push(`K:${b36(e.lap)},${b36(e.t)}`);
                break;
            case 'finish':
                parts.push(`X:${b36(e.t)}`);
                break;
            case 'respawn':
                parts.push(`R:${b36(e.x * 10)},${b36(e.z * 10)},${b36((e.yaw / TURN) * 1296)}`);
                break;
            case 'bump':
                parts.push(`B:${b36(e.slot)},${b36(e.dvx * 100)},${b36(e.dvz * 100)}`);
                break;
        }
    }
    return parts.join(REC);
}
export function decodeEvents(payload) {
    const out = [];
    for (const raw of payload.split(REC)) {
        const colon = raw.indexOf(':');
        if (colon < 1)
            continue;
        const tag = raw.slice(0, colon);
        const f = raw.slice(colon + 1).split(FLD);
        if (tag === 'K' && f.length >= 2)
            out.push({ k: 'lap', lap: un36(f[0]), t: un36(f[1]) });
        else if (tag === 'X' && f.length >= 1)
            out.push({ k: 'finish', t: un36(f[0]) });
        else if (tag === 'R' && f.length >= 3)
            out.push({ k: 'respawn', x: un36(f[0]) / 10, z: un36(f[1]) / 10, yaw: (un36(f[2]) / 1296) * TURN });
        else if (tag === 'B' && f.length >= 3)
            out.push({ k: 'bump', slot: un36(f[0]), dvx: un36(f[1]) / 100, dvz: un36(f[2]) / 100 });
    }
    return out;
}
const PHASES = ['L', 'C', 'R', 'F', 'X'];
export function encodeHeartbeat(h) {
    return [
        h.hostId,
        b36(h.seq),
        b36(h.roomT),
        h.phase,
        b36(h.race),
        b36(h.of),
        b36(h.track),
        b36(h.laps),
        b36(h.goAt),
        h.grid.join(LIST),
        h.finish.map((f) => `${b36(f.slot)}:${b36(f.t)}`).join(LIST),
        b36(h.cars),
    ].join(FLD);
}
export function decodeHeartbeat(payload) {
    const f = payload.split(FLD);
    if (f.length < 12)
        return null;
    const phase = f[3];
    if (!PHASES.includes(phase))
        return null;
    return {
        hostId: f[0],
        seq: un36(f[1]),
        roomT: un36(f[2]),
        phase,
        race: un36(f[4]),
        of: un36(f[5]),
        track: un36(f[6]),
        laps: un36(f[7]),
        goAt: un36(f[8]),
        grid: f[9] ? f[9].split(LIST) : [],
        finish: f[10]
            ? f[10].split(LIST).map((r) => {
                const [slot, t] = r.split(':');
                return { slot: un36(slot), t: un36(t) };
            })
            : [],
        cars: un36(f[11]),
    };
}
/** Names go inside a comma-delimited record, so they must not contain one. */
export function sanitizeName(name) {
    return (name || 'DRIVER').toUpperCase().replace(/[^A-Z0-9_\- ]/g, '').slice(0, 12).trim() || 'DRIVER';
}
export function encodePresence(p) {
    return [sanitizeName(p.name), p.colour, p.host, p.alive, p.ready, p.ver].join(FLD);
}
export function decodePresence(payload) {
    const f = payload.split(FLD);
    if (f.length < 4)
        return null;
    return {
        name: f[0],
        colour: f[1],
        host: un36(f[2]),
        alive: un36(f[3]),
        ready: un36(f[4]),
        ver: f[5] ?? '',
    };
}
/* ---------------------------------------------------------------- clock */
/** Client -> host: the client's local time when it sent the ping. */
export const encodePing = (t0) => b36(t0);
export const decodePing = (payload) => un36(payload);
/** Host -> client: the ping's t0 echoed, and the room time at the host on receipt. */
export const encodePong = (t0, t1) => `${b36(t0)},${b36(t1)}`;
export function decodePong(payload) {
    const f = payload.split(FLD);
    if (f.length < 2)
        return null;
    return { t0: un36(f[0]), t1: un36(f[1]) };
}
//# sourceMappingURL=codec.js.map