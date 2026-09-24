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

const i = (n: number): number => (Number.isFinite(n) ? Math.round(n) : 0);
export const b36 = (n: number): string => i(n).toString(36);
export const un36 = (s: string | undefined): number => {
  if (!s) return 0;
  const v = parseInt(s, 36);
  return Number.isFinite(v) ? v : 0;
};

/** Timestamps travel as room milliseconds modulo 36^4 — four characters, a 28-minute wrap. */
export const STAMP_WRAP = 36 ** 4;

export function encodeStamp(roomMs: number): string {
  return b36(((i(roomMs) % STAMP_WRAP) + STAMP_WRAP) % STAMP_WRAP);
}

/** The full room time a wrapped stamp most plausibly means, given the time now. */
export function decodeStamp(s: string, nowRoomMs: number): number {
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
  wrecked: 256,
} as const;

export interface CarPacket {
  /** Room time the state was sampled at, ms. */
  t: number;
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  w: number;
  /** Front wheel angle, radians. */
  steer: number;
  y: number;
  vy: number;
  flags: number;
  hp: number;
  /** Laps completed; -1 on the grid. */
  lap: number;
  /** Arc length along the centreline, metres. */
  s: number;
}

const TURN = Math.PI * 2;
const MAX_STEER = 0.6;

/**
 * `t,x,z,yaw,vx,vz,w,steer,y,vy,flags,hp,lap,s` — the car's id is in the topic.
 *
 * Positions and speeds in decimetres (and dm/s): peers dead-reckon and blend,
 * so 5 cm of quantisation is invisible. Yaw in 1/1296 of a turn (two
 * characters, 0.28°). Steering as one character, 0-35.
 */
export function encodeCar(p: CarPacket): string {
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

export function decodeCar(payload: string, nowRoomMs: number): CarPacket | null {
  const f = payload.split(FLD);
  if (f.length < 14) return null;
  return {
    t: decodeStamp(f[0]!, nowRoomMs),
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

/* ----------------------------------------------------------- car events */

export type CarEvent =
  /** Lap `lap` completed at race time `t` (ms since GO). */
  | { k: 'lap'; lap: number; t: number }
  /** Finished at race time `t` (ms since GO). */
  | { k: 'finish'; t: number }
  /** Respawned: a teleport, so peers snap instead of sliding. */
  | { k: 'respawn'; x: number; z: number; yaw: number }
  /** Bumped the car in grid slot `slot`, which should receive this velocity change (m/s). */
  | { k: 'bump'; slot: number; dvx: number; dvz: number }
  /** Fired shot `seq` (0 front, 1 rear) from the car's centre and heading, at race time `t` ms. */
  | { k: 'fire'; seq: number; weapon: 0 | 1; x: number; z: number; yaw: number; t: number }
  /** Dropped mine `seq` at (x, z), race time `t` ms. */
  | { k: 'mine'; seq: number; x: number; z: number; t: number }
  /** My shot `seq` hit the car in grid slot `slot` for `dmg`, at (x, z). */
  | { k: 'hit'; seq: number; slot: number; weapon: 0 | 1; dmg: number; x: number; z: number }
  /** I drove over mine `seq` of the car in grid slot `slot`. */
  | { k: 'trigger'; slot: number; seq: number }
  /** I was wrecked, by the car in grid slot `slot` (-1: nobody). */
  | { k: 'wreck'; slot: number };

const yaw36 = (yaw: number): string => b36(((Math.round((yaw / TURN) * 1296) % 1296) + 1296) % 1296);

export function encodeEvents(events: readonly CarEvent[]): string {
  const parts: string[] = [];
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
      case 'fire':
        parts.push(`F:${b36(e.seq)},${e.weapon},${b36(e.x * 10)},${b36(e.z * 10)},${yaw36(e.yaw)},${b36(e.t)}`);
        break;
      case 'mine':
        parts.push(`M:${b36(e.seq)},${b36(e.x * 10)},${b36(e.z * 10)},${b36(e.t)}`);
        break;
      case 'hit':
        parts.push(`H:${b36(e.seq)},${b36(e.slot)},${e.weapon},${b36(e.dmg)},${b36(e.x * 10)},${b36(e.z * 10)}`);
        break;
      case 'trigger':
        parts.push(`T:${b36(e.slot)},${b36(e.seq)}`);
        break;
      case 'wreck':
        parts.push(`D:${b36(e.slot)}`);
        break;
    }
  }
  return parts.join(REC);
}

export function decodeEvents(payload: string): CarEvent[] {
  const out: CarEvent[] = [];
  for (const raw of payload.split(REC)) {
    const colon = raw.indexOf(':');
    if (colon < 1) continue;
    const tag = raw.slice(0, colon);
    const f = raw.slice(colon + 1).split(FLD);
    if (tag === 'K' && f.length >= 2) out.push({ k: 'lap', lap: un36(f[0]), t: un36(f[1]) });
    else if (tag === 'X' && f.length >= 1) out.push({ k: 'finish', t: un36(f[0]) });
    else if (tag === 'R' && f.length >= 3) out.push({ k: 'respawn', x: un36(f[0]) / 10, z: un36(f[1]) / 10, yaw: (un36(f[2]) / 1296) * TURN });
    else if (tag === 'B' && f.length >= 3) out.push({ k: 'bump', slot: un36(f[0]), dvx: un36(f[1]) / 100, dvz: un36(f[2]) / 100 });
    else if (tag === 'F' && f.length >= 6) {
      out.push({ k: 'fire', seq: un36(f[0]), weapon: f[1] === '1' ? 1 : 0, x: un36(f[2]) / 10, z: un36(f[3]) / 10, yaw: (un36(f[4]) / 1296) * TURN, t: un36(f[5]) });
    } else if (tag === 'M' && f.length >= 4) out.push({ k: 'mine', seq: un36(f[0]), x: un36(f[1]) / 10, z: un36(f[2]) / 10, t: un36(f[3]) });
    else if (tag === 'H' && f.length >= 6) {
      out.push({ k: 'hit', seq: un36(f[0]), slot: un36(f[1]), weapon: f[2] === '1' ? 1 : 0, dmg: un36(f[3]), x: un36(f[4]) / 10, z: un36(f[5]) / 10 });
    } else if (tag === 'T' && f.length >= 2) out.push({ k: 'trigger', slot: un36(f[0]), seq: un36(f[1]) });
    else if (tag === 'D' && f.length >= 1) out.push({ k: 'wreck', slot: un36(f[0]) });
  }
  return out;
}

/* ------------------------------------------------------------ heartbeat */

/** L lobby · C countdown · R racing · F finishing (someone is home) · X results. */
export type Phase = 'L' | 'C' | 'R' | 'F' | 'X';
const PHASES: readonly Phase[] = ['L', 'C', 'R', 'F', 'X'];

export interface Heartbeat {
  hostId: string;
  seq: number;
  /** The host's room time as it sent this, ms. */
  roomT: number;
  phase: Phase;
  /** Race number, and how many are planned (the championship, M8). */
  race: number;
  of: number;
  /** Track index and race length. */
  track: number;
  laps: number;
  /** Room time of GO, ms (0 in the lobby). */
  goAt: number;
  /** Car ids in grid-slot order: player ids and `b<slot>` bots. */
  grid: string[];
  /** Finishers in order: grid slot and race time in ms. */
  finish: { slot: number; t: number }[];
  /** Lobby setting: fill the grid with bots up to this many cars. */
  cars: number;
}

export function encodeHeartbeat(h: Heartbeat): string {
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

export function decodeHeartbeat(payload: string): Heartbeat | null {
  const f = payload.split(FLD);
  if (f.length < 12) return null;
  const phase = f[3] as Phase;
  if (!PHASES.includes(phase)) return null;
  return {
    hostId: f[0]!,
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

/* ------------------------------------------------------------- presence */

export interface Presence {
  name: string;
  /** Palette id asked for; the room resolves clashes. */
  colour: string;
  /** 1 while claiming to be host. */
  host: number;
  /** 0 means "I am leaving" (also the Last Will). */
  alive: number;
  ready: number;
  /** Build version, so a mixed room can be diagnosed. */
  ver: string;
}

/** Names go inside a comma-delimited record, so they must not contain one. */
export function sanitizeName(name: string): string {
  return (name || 'DRIVER').toUpperCase().replace(/[^A-Z0-9_\- ]/g, '').slice(0, 12).trim() || 'DRIVER';
}

export function encodePresence(p: Presence): string {
  return [sanitizeName(p.name), p.colour, p.host, p.alive, p.ready, p.ver].join(FLD);
}

export function decodePresence(payload: string): Presence | null {
  const f = payload.split(FLD);
  if (f.length < 4) return null;
  return {
    name: f[0]!,
    colour: f[1]!,
    host: un36(f[2]),
    alive: un36(f[3]),
    ready: un36(f[4]),
    ver: f[5] ?? '',
  };
}

/* ---------------------------------------------------------------- clock */

/** Client -> host: the client's local time when it sent the ping. */
export const encodePing = (t0: number): string => b36(t0);
export const decodePing = (payload: string): number => un36(payload);

/** Host -> client: the ping's t0 echoed, and the room time at the host on receipt. */
export const encodePong = (t0: number, t1: number): string => `${b36(t0)},${b36(t1)}`;
export function decodePong(payload: string): { t0: number; t1: number } | null {
  const f = payload.split(FLD);
  if (f.length < 2) return null;
  return { t0: un36(f[0]), t1: un36(f[1]) };
}
