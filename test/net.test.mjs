/**
 * Networking suite, in Node: codecs and their byte budgets, dead reckoning,
 * clock sync, and whole rooms of clients racing through an in-memory broker
 * on a fake clock. `net/` imports neither three nor the DOM, and the clock is
 * injected, so a room can be taken through a race, a host crash and a frozen
 * tab in milliseconds — no browser, and no sleeping.
 */
import { FakeClock } from '../dist/clock.js';
import { STEP, NET } from '../dist/config.js';
import { MemoryBroker } from '../dist/net/MemoryBroker.js';
import { NetRace } from '../dist/net/NetRace.js';
import { RoomSession } from '../dist/net/RoomSession.js';
import {
  encodeCar, decodeCar, encodeEvents, decodeEvents, encodeHeartbeat, decodeHeartbeat,
  encodePresence, decodePresence, encodeStamp, decodeStamp, STAMP_WRAP,
} from '../dist/net/codec.js';
import { predict, RemoteCar } from '../dist/net/deadReckoning.js';
import { TRACKS } from '../dist/sim/track/index.js';
import { autopilot, createAutopilot, SKILLS } from '../dist/sim/autopilot.js';
import { racingLine } from '../dist/sim/racingLine.js';
import { World } from '../dist/sim/World.js';
import { mulberry32, wrapAngle } from '../dist/util.js';
import { SIM } from '../dist/config.js';
import { trainAt } from '../dist/sim/train.js';
import { generateTrack, seedOf } from '../dist/sim/track/generate.js';
import { encodeLook, decodeLook, botLook, DEFAULT_LOOK, BODIES, PATTERNS } from '../dist/sim/look.js';

let pass = 0;
let fail = 0;
function check(label, ok, note = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${note ? ` — ${note}` : ''}`);
  ok ? pass++ : fail++;
}

/** A client's own clock: the shared fake time plus a fixed skew, like two machines' uptimes. */
class SkewClock {
  constructor(base, skew) {
    this.base = base;
    this.skew = skew;
  }
  now() { return this.base.now() + this.skew; }
  setInterval(fn, ms) { return this.base.setInterval(fn, ms); }
  clearInterval(id) { this.base.clearInterval(id); }
  setTimeout(fn, ms) { return this.base.setTimeout(fn, ms); }
  clearTimeout(id) { this.base.clearTimeout(id); }
}

/** Build a room of racing clients, each driving its own car on autopilot. */
function makeRoom(n, { latency = 40, loss = 0, seed = 1 } = {}) {
  const base = new FakeClock();
  const broker = new MemoryBroker(base);
  broker.latency = latency;
  broker.loss = loss;
  broker.rand = mulberry32(seed);
  const clients = [];
  const add = (i, skew = i * 7919 + 1234) => {
    const clock = new SkewClock(base, skew);
    const t = broker.connect(`c${i}`);
    // Time-prefixed ids, as makePlayerId makes them: a later joiner sorts later.
    const id = (1e12 + i * 1000 + base.now()).toString(36).padStart(9, '0') + String(i).padStart(4, '0');
    const net = new NetRace({ transport: t, clock, roomId: 'TEST', playerId: id, name: `P${i}`, colour: 'vermilion', ver: 't', tracks: TRACKS });
    const pilot = createAutopilot(100 + i, SKILLS[i % SKILLS.length]);
    net.drive = () => {
      const w = net.world;
      return autopilot(pilot, net.me.car, w.track, racingLine(w.track), w.rivalsOf(net.me.id), w.time, STEP);
    };
    net.start();
    const c = { net, t, clock, alive: true };
    clients.push(c);
    return c;
  };
  for (let i = 0; i < n; i++) add(i);
  const run = (ms, until = null) => {
    for (let k = 0; k < ms / 16; k++) {
      base.tick(16);
      for (const c of clients) if (c.alive) c.net.update();
      if (until && until()) return true;
    }
    return false;
  };
  return { base, broker, clients, add, run };
}

const hostOf = (room) => room.clients.find((c) => c.alive && c.net.isHost);

console.log('\nnet.test\n\ncodecs');

/* ----------------------------------------------------------------- codecs */

{
  const p = { t: 1234567.8, x: 336.21, z: -12.34, yaw: -2.5, vx: -45.3, vz: 30.1, w: -1.23, steer: 0.31, y: 0, vy: 0, flags: 17, hp: 100, lap: 2, s: 1421.7 };
  const enc = encodeCar(p);
  const d = decodeCar(enc, 1234600);
  const ok = Math.abs(d.x - p.x) <= 0.05 && Math.abs(d.z - p.z) <= 0.05 && Math.abs(d.vx - p.vx) <= 0.05 && Math.abs(d.w - p.w) <= 0.005
    && Math.abs(((d.yaw - p.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.003 && Math.abs(d.steer - p.steer) < 0.02
    && d.flags === 17 && d.lap === 2 && Math.abs(d.s - 1422) < 1 && Math.abs(d.t - 1234568) < 1;
  check('car state round-trips to decimetre and 0.3° precision', ok, `"${enc}" (${enc.length} bytes)`);

  // Worst case: far corner, flat out in reverse, airborne, every flag, lap 9.
  const worst = encodeCar({ t: STAMP_WRAP - 1, x: -9999, z: -9999, yaw: 6.2, vx: -60, vz: -60, w: -9.99, steer: -0.6, y: 9.99, vy: -30, flags: 511, hp: 100, lap: 9, s: 1799 });
  check('a car state packet is at most 54 bytes', worst.length <= 54, `worst ${worst.length} bytes`);
  const topic = `nc/room/ABCD/c/${'0'.repeat(13)}`;
  check('and a whole publish, topic included, stays under 90 bytes', topic.length + worst.length + 4 <= 90, `${topic.length + worst.length + 4} bytes`);

  check('a truncated car packet is dropped, not thrown', decodeCar(enc.split(',').slice(0, 9).join(','), 0) === null);

  const events = [{ k: 'lap', lap: 2, t: 68382 }, { k: 'finish', t: 204011 }, { k: 'respawn', x: 12.3, z: -4.5, yaw: 1.2 }, { k: 'bump', slot: 4, dvx: -1.23, dvz: 0.5 }, { k: 'cooldown' }];
  const back = decodeEvents(encodeEvents(events));
  check('car events round-trip, the cool-down lap among them', back.length === 5 && back[0].lap === 2 && back[1].t === 204011 && back[2].x === 12.3 && back[3].slot === 4 && back[3].dvx === -1.23 && back[4].k === 'cooldown',
    `"${encodeEvents(events)}"`);

  const weapons = [
    { k: 'fire', seq: 1295, weapon: 1, x: 4095.9, z: 4095.9, yaw: 6.2, t: 36 ** 5 - 1 },
    { k: 'mine', seq: 1295, x: 4095.9, z: 4095.9, t: 36 ** 5 - 1 },
    { k: 'hit', seq: 1295, slot: 5, weapon: 0, dmg: 30, x: 4095.9, z: 4095.9 },
    { k: 'trigger', slot: 5, seq: 1295 },
    { k: 'wreck', slot: -1 },
  ];
  const wb = decodeEvents(encodeEvents(weapons));
  const sizes = weapons.map((e) => encodeEvents([e]).length);
  check('weapon events (fire, mine, hit, mine trigger, wreck) round-trip', wb.length === 5 && wb[0].weapon === 1 && Math.abs(wb[0].yaw - 6.2) < 0.005
    && wb[1].x === 4095.9 && wb[2].slot === 5 && wb[2].dmg === 30 && wb[3].seq === 1295 && wb[4].slot === -1);
  // PLAN §5.9 budgets them at 22, 18, 16, 6 and 4 bytes typical; these are the worst cases.
  check('and stay small at their worst', sizes[0] <= 26 && sizes[1] <= 22 && sizes[2] <= 22 && sizes[3] <= 8 && sizes[4] <= 5, sizes.join(' / ') + ' bytes');

  const grid = Array.from({ length: 6 }, (_, i) => 'mfy2k3x9a' + String(i).padStart(4, '0'));
  const hb = { hostId: grid[0], seq: 1295, roomT: 36 ** 6 - 1, phase: 'F', race: 9, of: 9, track: 2, laps: 9, goAt: 36 ** 6 - 1, grid,
    finish: grid.map((_, slot) => ({ slot, t: STAMP_WRAP - 1 })), cars: 6, seed: 0xffffffff, arms: 1 };
  const enc2 = encodeHeartbeat(hb);
  const d2 = decodeHeartbeat(enc2);
  const withSeed = decodeHeartbeat(encodeHeartbeat({ ...hb, seed: 0xffffffff, arms: 0 }));
  const legacy = decodeHeartbeat(encodeHeartbeat(hb).split(',').slice(0, 12).join(','));
  check('the heartbeat carries a track seed and the weapons switch; an older one means built-in track, weapons on',
    withSeed.seed === 0xffffffff && withSeed.arms === 0 && legacy.seed === 0 && legacy.arms === 1);
  check('a full heartbeat (six humans, all finished) round-trips', d2.grid.length === 6 && d2.finish.length === 6 && d2.finish[5].t === STAMP_WRAP - 1 && d2.phase === 'F');
  // 184 since M7: a track seed (up to 7 characters) and the weapons switch joined the heartbeat.
  check('and is at most 184 bytes, as budgeted', enc2.length <= 184, `${enc2.length} bytes`);

  const pres = encodePresence({ name: 'A LONG NAME,WITH,COMMAS', colour: 'vermilion', host: 1, alive: 1, ready: 0, ver: '0.1.99', look: '000000' });
  const dp = decodePresence(pres);
  check('presence sanitises names that would break the record', dp.name === 'A LONG NAMEW' && dp.colour === 'vermilion' && pres.length <= 47, `"${pres}"`);

  // Looks (M6): six characters on presence, and junk becomes the stock car.
  const look = { body: 'buggy', pattern: 'roundel', stripe: 'jade', rims: 'gold', number: 99 };
  const lk = encodeLook(look);
  const round = decodeLook(lk);
  const everyOne = BODIES.every((b) => PATTERNS.every((pt) => {
    const l = { ...look, body: b, pattern: pt, number: 42 };
    return JSON.stringify(decodeLook(encodeLook(l))) === JSON.stringify(l);
  }));
  check('a car look round-trips in six characters, every body and livery', lk.length === 6 && JSON.stringify(round) === JSON.stringify(look) && everyOne, `"${lk}"`);
  const junk = ['', 'zzzzzz', '0000zz', '99', null, undefined, '0,0,0', '5a0000', '000000x'];
  check('a malformed look falls back to the stock car, never throws', junk.every((j) => JSON.stringify(decodeLook(j)) === JSON.stringify(DEFAULT_LOOK) || JSON.stringify(decodeLook(j)) === JSON.stringify(decodeLook('000000'))) && decodeLook('zzzzzz').body === 'coupe');
  const withLook = encodePresence({ name: 'LOOKER', colour: 'cyan', host: 0, alive: 1, ready: 0, ver: '0.1.99', look: lk });
  const old = decodePresence('OLDTIMER,cyan,0,1,0,0.1.3');
  check('the look rides on presence, and a presence from an older build still decodes', decodePresence(withLook).look === lk && old.name === 'OLDTIMER' && decodeLook(old.look).body === DEFAULT_LOOK.body,
    `presence ${withLook.length} bytes`);
  check('a bot\'s look is the same from the same seed, and varies between seeds',
    JSON.stringify(botLook(123)) === JSON.stringify(botLook(123)) && new Set([1, 2, 3, 4, 5, 6, 7, 8].map((k) => encodeLook(botLook(k)))).size >= 6);

  const now = 5 * STAMP_WRAP + 1000;
  check('wrapped time stamps decode to the nearest real time', decodeStamp(encodeStamp(now - 3000), now) === now - 3000 && decodeStamp(encodeStamp(now + 500), now) === now + 500);
}

/* ------------------------------------------------------- dead reckoning */

console.log('\ndead reckoning');

{
  // A car on a 30 m circle at 20 m/s: predicting 0.25 s ahead along the arc
  // lands on the circle; the straight-line guess lands 0.4 m wide — and that
  // grows with the square of the gap.
  const r = 30, v = 20, w = v / r;
  const p = { t: 0, x: 0, z: 0, yaw: 0, vx: 0, vz: v, w, steer: 0, y: 0, vy: 0, flags: 0, hp: 100, lap: 0, s: 0 };
  const out = predict(p, 0.25, {});
  // Turning left (positive w) from heading +Z: the centre is at (r, 0).
  const onCircle = Math.abs(Math.hypot(out.x - r, out.z) - r);
  const straight = Math.abs(Math.hypot(0 - r, v * 0.25) - r);
  check('prediction follows the arc, not the tangent', onCircle < 0.01 && straight > 0.3, `${onCircle.toFixed(3)} m off the circle vs ${straight.toFixed(2)} m for a straight line`);

  // Record real laps, send them through a jittery lossy link, and measure
  // what a peer would draw against where the car really was.
  const w0 = new World(TRACKS[0], { laps: 1, countdown: 0 });
  const bot = w0.addBot('b', 0, SKILLS[0], 5);
  const truth = [];
  while (!bot.lap.finished && w0.steps < 60 * 120) {
    w0.step();
    const c = bot.car;
    truth.push({ t: w0.time * 1000, x: c.x, z: c.z, yaw: c.yaw, vx: c.vx, vz: c.vz, w: c.w, steer: c.steer, y: c.y, vy: c.vy, flags: 0, hp: 100, lap: 0, s: 0 });
  }
  const rand = mulberry32(42);
  const rc = new RemoteCar();
  const arrivals = [];
  // 20 Hz sends, 60-150 ms latency, 5% loss.
  for (let k = 0; k < truth.length; k += 3) {
    if (rand() < 0.05) continue;
    arrivals.push({ at: truth[k].t + 60 + rand() * 90, p: decodeCar(encodeCar(truth[k]), truth[k].t) });
  }
  arrivals.sort((a, b) => a.at - b.at);
  const errs = [];
  let yawMax = 0;
  const yaws = [];
  let next = 0;
  for (const s of truth) {
    while (next < arrivals.length && arrivals[next].at <= s.t) rc.receive(arrivals[next].p, arrivals[next++].at, 0);
    if (!rc.packet) continue;
    const d = rc.display(s.t);
    errs.push(Math.hypot(d.x - s.x, d.z - s.z));
    const ye = Math.abs(((d.yaw - s.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    yawMax = Math.max(yawMax, ye);
    yaws.push(ye);
  }
  errs.sort((a, b) => a - b);
  const p95 = errs[Math.floor(errs.length * 0.95)];
  check('over a whole lap through a 60-150 ms, 5%-loss link, a peer draws the car within 0.8 m (p95)', p95 < 0.8,
    `p95 ${p95.toFixed(2)} m, max ${errs[errs.length - 1].toFixed(2)} m, ${arrivals.length} packets`);
  // Heading: within 6° 99% of the time, and never past 12°. It was "never
  // past 8°" on the 1.6 km Downtown; on the 30 s one the corners are tighter
  // at the same speeds, and the worst moment (a turn-in, mid-way between
  // packets) reached 9.2° for 5 samples in 1,923. p99 is 4.6°.
  yaws.sort((a, b) => a - b);
  const p99 = yaws[Math.floor(yaws.length * 0.99)];
  check('and its heading within 6° (p99), never past 12°', p99 < (6 * Math.PI) / 180 && yawMax < (12 * Math.PI) / 180,
    `p99 ${(p99 * 180 / Math.PI).toFixed(1)}°, max ${(yawMax * 180 / Math.PI).toFixed(1)}°`);

  // A late packet must not drag the car backwards.
  const late = new RemoteCar();
  late.receive({ ...truth[300] }, truth[300].t, 0);
  late.receive({ ...truth[240] }, truth[300].t + 10, 0);
  check('an out-of-order packet is ignored', late.packet.t === truth[300].t);
}

/* ------------------------------------------------------------ clock sync */

console.log('\nclock sync');

{
  const room = makeRoom(3, { latency: 35 });
  room.run(4000);
  const host = hostOf(room);
  const errs = room.clients.map((c) => Math.abs(c.net.roomNow - host.net.roomNow));
  check('clients with clocks minutes apart agree on room time within 5 ms', Math.max(...errs) < 5,
    `errors ${errs.map((e) => e.toFixed(1)).join(' / ')} ms, skews ${room.clients.map((c) => c.clock.skew).join(' / ')} ms`);

  // Jitter: an asymmetric link (fast out, slow back) biases one sample; the
  // lowest-round-trip filter sees through it.
  room.broker.latency = 20;
  room.run(6000);
  const errs2 = room.clients.map((c) => Math.abs(c.net.roomNow - host.net.roomNow));
  check('and hold it when the latency changes', Math.max(...errs2) < 5, `errors ${errs2.map((e) => e.toFixed(1)).join(' / ')} ms`);

  // Failover continuity: room time does not jump when the host changes.
  const others = room.clients.filter((c) => c !== host);
  const before = others.map((c) => c.net.roomNow);
  host.t.disconnect(false);
  host.alive = false;
  room.run(4000);
  const newHost = hostOf(room);
  const jump = others.map((c, i) => c.net.roomNow - before[i] - 4000);
  check('when the host dies, room time carries on without a jump', newHost && Math.max(...jump.map(Math.abs)) < 5,
    `drift ${jump.map((e) => e.toFixed(1)).join(' / ')} ms across the handover`);
}

/* ------------------------------------------------------------------ rooms */

console.log('\nrooms');

{
  const room = makeRoom(3);
  room.run(3000);
  const hosts = room.clients.filter((c) => c.net.isHost);
  const lowest = [...room.clients].sort((a, b) => (a.net.playerId < b.net.playerId ? -1 : 1))[0];
  check('the lowest id is host, and everyone agrees', hosts.length === 1 && hosts[0] === lowest && room.clients.every((c) => c.net.room.hostId === lowest.net.playerId));
  check('everyone sees everyone', room.clients.every((c) => c.net.room.peers.size === 2));

  // Last Will: a crash de-lists at once, not after the 15 s backstop.
  const gone = room.clients[2];
  gone.t.disconnect(false);
  gone.alive = false;
  room.run(300);
  check('a crashed client is de-listed at once by its Last Will', room.clients.slice(0, 2).every((c) => !c.net.room.peers.has(gone.net.playerId)));
}

{
  const room = makeRoom(6);
  room.run(2500);
  const full = [];
  const seventh = room.add(6);
  seventh.net.room.events.on('roomFull', () => full.push(true));
  room.run(3000);
  check('a seventh arrival works out it is the overflow', full.length === 1 && !seventh.net.isHost);
  check('and the six already in are undisturbed', room.clients.slice(0, 6).filter((c) => c.net.isHost).length === 1);
}

{
  // Split brain, healed over presence alone: the heartbeats are silenced.
  const room = makeRoom(2);
  room.run(2000);
  const [a, b] = room.clients;
  // Force B to claim host too, as a partition healing would leave it.
  b.net.room._isHost = true;
  b.net.room._hostId = b.net.playerId;
  const beat = a.net.room.beat;
  a.net.room.beat = () => {};
  b.net.room.beat = () => {};
  room.run(2500);
  a.net.room.beat = beat;
  const hosts = room.clients.filter((c) => c.net.isHost);
  check('two hosts at once heal over presence, lower id wins', hosts.length === 1 && hosts[0].net.playerId < (hosts[0] === a ? b : a).net.playerId);
}

{
  // A frozen tab: its clock ran on for a minute while nothing did.
  const room = makeRoom(3);
  room.run(3000);
  const sleeper = room.clients[2];
  sleeper.t.deaf = true;
  room.base.jump(60000);
  sleeper.t.deaf = false;
  room.run(1000);
  check('a tab that slept for a minute keeps its peers', sleeper.net.room.peers.size === 2);
  check('and does not promote itself over a host that never went away', !sleeper.net.isHost && room.clients.filter((c) => c.net.isHost).length === 1);
}

/* ------------------------------------------------------------------ races */

console.log('\nraces');

/** Drive a room to the results; returns false on timeout. */
const toResults = (room, ms = 200000) => room.run(ms, () => room.clients.filter((c) => c.alive).every((c) => c.net.phase === 'X'));

{
  const room = makeRoom(3, { latency: 45, loss: 0.02 });
  room.run(2500);
  const host = hostOf(room);
  // Weapons off: this is about everyone agreeing on the race. Armed, a client
  // shot to pieces on a 30 s lap can fall a lap behind, and the race ends
  // (rightly) on the leader's cool-down lap before it is home.
  host.net.configure(5, 1, 0, 0, 0);
  room.run(500);
  host.net.startRace();
  room.run(1500);
  const grids = room.clients.map((c) => c.net.state.grid.join('.'));
  check('the host freezes one grid for everyone: humans first, bots to fill', new Set(grids).size === 1 && host.net.state.grid.length === 5 && host.net.state.grid.slice(3).every((g) => g.startsWith('b')));
  const goAts = room.clients.map((c) => c.net.state.goAt);
  const gos = room.clients.map((c) => c.net.roomAt(c.net.world.goTime));
  check('and one GO: every client\'s world starts at the same room time', new Set(goAts).size === 1 && Math.max(...gos) - Math.min(...gos) < 20,
    `spread ${(Math.max(...gos) - Math.min(...gos)).toFixed(1)} ms`);

  const done = toResults(room);
  const orders = room.clients.map((c) => c.net.state.finish.map((f) => f.slot).join(''));
  check('three clients and two bots race a lap to the results', done && host.net.state.finish.length === 5,
    `${host.net.state.finish.length} finished: ${JSON.stringify(host.net.state.finish)}; grid ${host.net.state.grid.join(',')}`);
  check('and every client ends with the same finish order', new Set(orders).size === 1, orders[0]);
  const rows = room.clients.map((c) => c.net.results().map((r) => `${r.id}:${r.time?.toFixed(2)}`).join(' '));
  check('and the same finish times', new Set(rows).size === 1);

  room.run(NET.resultsMs + 2000);
  check('then the room goes back to its lobby', room.clients.every((c) => c.net.phase === 'L' && c.net.world === null));
}

{
  // A finish lost on the way to the host is said again until the host lists it.
  const room = makeRoom(2, { latency: 40 });
  room.run(2500);
  const host = hostOf(room);
  const guest = room.clients.find((c) => c !== host);
  host.net.configure(2, 1, 0, 0, 0);
  room.run(500);
  host.net.startRace();
  room.run(1500, () => false);
  // Lose everything from just short of the guest's finish line until just
  // after it crosses: its one finish message goes nowhere.
  const L = guest.net.world.track.length;
  room.run(120000, () => guest.net.me?.lap.completed === 0 && guest.net.me.s > L - 12);
  room.broker.loss = 1;
  room.run(5000, () => guest.net.me.lap.finished);
  room.run(300);
  room.broker.loss = 0;
  const heard = room.run(5000, () => host.net.state.finish.some((f) => host.net.state.grid[f.slot] === guest.net.playerId));
  check('a finish lost on the way is sent again until the host counts the car home', heard);
}

{
  // Failover mid-race: the host crashes half a lap in.
  const room = makeRoom(3, { latency: 40 });
  room.run(2500);
  const host = hostOf(room);
  host.net.configure(4, 1);
  host.net.startRace();
  room.run(NET.countdownMs + 25000);
  const goAt = host.net.state.goAt;
  const others = room.clients.filter((c) => c !== host);
  const botBefore = others[0].net.world.entrants.find((e) => e.id.startsWith('b')).lap.progress;
  host.t.disconnect(false);
  host.alive = false;
  room.run(5000);
  const newHost = hostOf(room);
  check('when the host crashes mid-race another client takes over within 3 s', Boolean(newHost) && others.every((c) => c.net.room.hostId === newHost.net.playerId));
  check('the race carries on: same GO, same phase', others.every((c) => c.net.state.goAt === goAt && ['R', 'F'].includes(c.net.phase)));
  const bot = newHost.net.world.entrants.find((e) => e.id.startsWith('b'));
  check('the new host drives the bot on from where it was', bot && !bot.remote && bot.lap.progress > botBefore + 50,
    bot ? `${(bot.lap.progress - botBefore).toFixed(0)} m further on` : 'no bot');
  const done = toResults(room);
  check('and the race still reaches the results', done && newHost.net.state.finish.length >= 3,
    `${newHost.net.state.finish.length} finishers (the crashed host is not one)`);
}

{
  // A late joiner lands in the race as a spectator, then races the next one.
  const room = makeRoom(2);
  room.run(2500);
  const host = hostOf(room);
  host.net.configure(2, 1);
  host.net.startRace();
  room.run(NET.countdownMs + 10000);
  const late = room.add(5);
  room.run(3000);
  check('a late joiner lands mid-race as a spectator, not on the grid', late.net.world !== null && late.net.me === null && !late.net.state.grid.includes(late.net.playerId));
  const spectated = late.net.world.entrants.map((e) => e.id).sort().join();
  check('and sees every car in the race', spectated === host.net.state.grid.slice().sort().join());
  toResults(room);
  room.run(NET.resultsMs + 1500);
  host.net.startRace();
  room.run(1500);
  check('then races the next one', late.net.me !== null && host.net.state.grid.includes(late.net.playerId));
}

{
  // Bumps: each side moves its own car; the other side's share goes by event
  // and is applied once — never on top of a contact the receiver felt itself.
  const room = makeRoom(2, { latency: 30 });
  room.run(2500);
  const host = hostOf(room);
  host.net.configure(2, 1);
  host.net.startRace();
  room.run(NET.countdownMs + 3000);
  const [a, b] = room.clients;
  let applied = 0;
  let felt = 0;
  for (const c of [a, b]) {
    c.net.events.on('race', ({ ev }) => {
      if (ev.kind === 'bump') felt++;
    });
  }
  // Park A dead ahead of B, and drive B straight into it.
  const bme = b.net.me.car;
  const fx = Math.sin(bme.yaw), fz = Math.cos(bme.yaw);
  Object.assign(a.net.me.car, { x: bme.x + fx * 14, z: bme.z + fz * 14, yaw: bme.yaw, vx: 0, vz: 0, w: 0 });
  a.net.drive = () => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, fireFront: false, fireRear: false, turbo: false });
  b.net.drive = () => ({ throttle: 1, brake: 0, steer: 0, handbrake: false, fireFront: false, fireRear: false, turbo: false });
  let maxV = 0;
  let rammer = 0;
  room.run(2500, () => {
    maxV = Math.max(maxV, Math.hypot(a.net.me.car.vx, a.net.me.car.vz));
    rammer = Math.max(rammer, Math.hypot(bme.vx, bme.vz));
    return false;
  });
  applied = maxV;
  // Shoved, but only once: a car that took both its own resolution and the
  // rammer's impulse would leave faster than the rammer arrived.
  check('a parked car rammed from behind is shoved forward, once', felt > 0 && applied > 3 && applied < rammer,
    `parked car reached ${applied.toFixed(1)} m/s, rammer ${rammer.toFixed(1)} m/s, ${felt} contacts`);
}

{
  // The bandwidth budget with six cars: three humans and three bots.
  const room = makeRoom(3, { latency: 40 });
  room.run(2500);
  const host = hostOf(room);
  host.net.configure(6, 2);
  host.net.startRace();
  room.run(NET.countdownMs);
  const from = room.broker.log.length;
  const t0 = room.base.now();
  room.run(30000);
  const log = room.broker.log.slice(from);
  const secs = (room.base.now() - t0) / 1000;
  const bytes = log.reduce((s, m) => s + m.topic.length + m.payload.length + 4, 0);
  const car = log.filter((m) => m.topic.includes('/c/'));
  const perCar = car.length / 6 / secs;
  // Every message fans out to every client in the room (6 at most).
  const egress = (bytes * 6) / secs / 1024;
  check('six racing cars publish 20-30 packets a second each', perCar >= 19 && perCar <= 30, `${perCar.toFixed(1)} per car per second`);
  check('and the whole room stays inside the budget (under 90 KB/s out of the broker)', egress < 90,
    `${(bytes / secs / 1024).toFixed(1)} KB/s in, ${egress.toFixed(1)} KB/s out at six subscribers`);
}

{
  // The host picks the docks: every client races there, and — with no train
  // messages at all — every client has the train in the same place.
  const room = makeRoom(3, { latency: 50 });
  room.run(2500);
  const host = hostOf(room);
  const docks = TRACKS.findIndex((t) => t.id === 'docks');
  host.net.configure(3, 1, docks);
  host.net.startRace();
  room.run(NET.countdownMs + 24000);
  const ids = room.clients.map((c) => c.net.world?.track.def.id);
  const trains = room.clients.map((c) => {
    const w = c.net.world;
    return trainAt(w.track, w.time - w.goTime);
  });
  const heads = trains.map((t) => t?.head ?? NaN);
  const spread = Math.max(...heads) - Math.min(...heads);
  check('a room on the docks: every client on that track, and the train within a metre everywhere',
    ids.every((id) => id === 'docks') && trains.every(Boolean) && spread < 1, `train heads ${heads.map((h) => h.toFixed(1)).join(' / ')}`);
}

{
  // A room on a seed, race only: every client builds the same generated
  // track from the seed alone, and not one shot goes on the wire.
  const room = makeRoom(3, { latency: 40 });
  room.run(2500);
  const host = hostOf(room);
  const seed = seedOf('ROOM TEST');
  host.net.configure(4, 1, 0, seed, 0);
  host.net.startRace();
  const from = room.broker.log.length;
  room.run(NET.countdownMs + 20000);
  const ids = room.clients.map((c) => c.net.world?.track.def.id);
  const shots = room.broker.log.slice(from).filter((m) => m.topic.includes('/e/') && /(^|\|)[FM]:/.test(m.payload)).length;
  check('a race-only room on a seed: every client on the generated track, no shots on the wire',
    ids.every((id) => id === generateTrack(seed).id) && room.clients.every((c) => c.net.world?.weapons === false) && shots === 0,
    `${generateTrack(seed).name}, ${shots} shots`);
}

/* -------------------------------------------------------------- weapons */

console.log('\nweapons');

/** Where on a track the road runs straightest for `len` metres. */
function straightAt(track, len = 80) {
  let best = 0, bestTurn = Infinity;
  for (let s = 0; s < track.length; s += 5) {
    let turn = 0;
    for (let a = 0; a < len; a += 5) turn += Math.abs(wrapAngle(track.poseAt(s + a + 5).yaw - track.poseAt(s + a).yaw));
    if (turn < bestTurn) { bestTurn = turn; best = s; }
  }
  return best;
}

const idle = () => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, fireFront: false, fireRear: false, turbo: false });

/** Two clients on a straight, parked `gap` metres apart (A behind), weapons live. */
function duel(gap = 30, opts = {}) {
  const room = makeRoom(2, { latency: 40, ...opts });
  room.run(2500);
  const host = hostOf(room);
  host.net.configure(2, 3);
  host.net.startRace();
  const [a, b] = room.clients;
  for (const c of [a, b]) c.net.drive = idle;
  room.run(NET.countdownMs + SIM.weapons.startGrace * 1000 + 500);
  const track = a.net.world.track;
  const s0 = straightAt(track);
  const put = (c, s) => {
    const pose = track.poseAt(s);
    Object.assign(c.net.me.car, { x: pose.x, z: pose.z, yaw: pose.yaw, vx: 0, vz: 0, w: 0, hint: pose.i });
    Object.assign(c.net.me.prev, c.net.me.car);
  };
  put(a, s0);
  put(b, s0 + gap);
  room.run(600);
  const once = (c, what) => {
    let n = 0;
    c.net.drive = () => (n++ === 0 ? { ...idle(), [what]: true } : idle());
  };
  const view = (c, id) => c.net.world.entrants.find((e) => e.id === id);
  return { room, a, b, once, view, put, s0 };
}

{
  const { room, a, b, once, view } = duel(30);
  const aId = a.net.playerId, bId = b.net.playerId;
  once(a, 'fireFront');
  let copy = null;
  room.run(700, () => {
    copy ??= b.net.world.armoury.missiles.find((m) => m.owner === aId) ?? null;
    return false;
  });
  check('a shot fired on one screen flies on the other, as scenery', copy !== null && copy.live === false);
  room.run(800);
  check('the shooter\'s hit is applied once, by the victim: 20 off, on both screens',
    view(b, bId).hp === 80 && view(a, bId).hp === 80, `victim sees ${view(b, bId).hp}, shooter sees ${view(a, bId).hp}`);
  check('and the missile is gone everywhere', a.net.world.armoury.missiles.length === 0 && b.net.world.armoury.missiles.length === 0);

  // The same hit delivered again (a duplicate on the wire) changes nothing.
  const dup = encodeEvents([{ k: 'hit', seq: copy.seq, slot: b.net.state.grid.indexOf(bId), weapon: 0, dmg: 20, x: 0, z: 0 }]);
  b.net['onCarEvents'](aId, dup);
  room.run(300);
  check('a repeated hit message is not a second hit', view(b, bId).hp === 80);
}

{
  // A mine dropped on one screen is placed on the other; the car that drives
  // over it is the one that notices, and every screen clears it.
  const { room, a, b, once, view, put, s0 } = duel(40);
  const aId = a.net.playerId, bId = b.net.playerId;
  once(b, 'fireRear');
  room.run(400);
  const mb = b.net.world.armoury.mines[0];
  const ma = a.net.world.armoury.mines.find((m) => m.owner === bId);
  check('a mine appears on the other screen where it was dropped', mb && ma && Math.hypot(ma.x - mb.x, ma.z - mb.z) < 0.1);
  room.run(700);
  Object.assign(a.net.me.car, { x: ma.x, z: ma.z, vx: 0, vz: 0 });
  room.run(600);
  check('the car on it takes 30, seen on both screens', view(a, aId).hp === 70 && view(b, aId).hp === 70,
    `${view(a, aId).hp} / ${view(b, aId).hp}`);
  check('and the mine is gone on both', a.net.world.armoury.mines.length === 0 && b.net.world.armoury.mines.length === 0);
}

{
  // A wreck: the victim's owner decides it and says who did it; every screen credits the kill.
  const { room, a, b, once, view } = duel(25);
  const aId = a.net.playerId, bId = b.net.playerId;
  b.net.me.hp = 10;
  room.run(200);
  once(a, 'fireFront');
  room.run(1500);
  const credited = [a, b].every((c) => view(c, aId).kills === 1 && view(c, bId).wrecks === 1);
  check('a car shot to zero is wrecked and the kill is credited on every screen', credited && b.net.me.wrecked > 0,
    [a, b].map((c) => `${view(c, aId).kills}/${view(c, bId).wrecks}`).join(' '));
  room.run(SIM.weapons.wreckTime * 1000 + 600);
  check('and it comes back with full health, seen by both', view(b, bId).hp === SIM.weapons.respawnHealth && view(a, bId).hp === SIM.weapons.respawnHealth);
}

{
  // A whole armed race on a lossy link: three humans and three bots on
  // autopilot, shooting at each other, to the results.
  const room = makeRoom(3, { latency: 60, loss: 0.03, seed: 7 });
  room.run(2500);
  const host = hostOf(room);
  host.net.configure(6, 2);
  host.net.startRace();
  const tally = { fire: 0, hit: 0, wreck: 0 };
  host.net.events.on('race', ({ ev }) => {
    if (ev.kind in tally) tally[ev.kind]++;
  });
  let drift = 0;
  const done = room.run(300000, () => {
    // Each car's health as its owner has it, against every other screen's copy.
    for (const c of room.clients) {
      if (!c.net.me) continue;
      for (const o of room.clients) {
        const seen = o.net.world?.entrants.find((e) => e.id === c.net.playerId);
        if (seen && Math.abs(seen.hp - Math.round(c.net.me.hp)) > 0) drift++;
      }
    }
    return room.clients.every((c) => c.net.phase === 'X');
  });
  check('an armed six-car race on a 3% lossy link reaches the results', done && tally.fire > 10 && tally.hit > 3,
    `${tally.fire} shots by the host's own cars, ${tally.hit} hits and ${tally.wreck} wrecks among all`);
  // Frames where some screen still shows an old health: a packet in flight, not a disagreement.
  const frames = 300000 / 16;
  check('and every screen agrees on every car\'s health, bar a packet in flight', drift / frames < 0.3, `${(100 * drift / frames).toFixed(1)}% of frame-pairs behind`);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail) process.exitCode = 1;
