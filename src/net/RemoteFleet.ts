import type { Clock } from '../clock.js';
import type { Entrant, World } from '../sim/World.js';
import { packetOf } from './CarPublisher.js';
import { CAR_FLAG, decodeCars } from './codec.js';
import type { CarEvent, CarPacket } from './codec.js';
import { RemoteCar } from './deadReckoning.js';

/** What the fleet needs to know about the race it is watching, and whom to tell. */
export interface FleetRace {
  readonly world: World | null;
  /** Car ids in grid-slot order, for the slots events name. */
  readonly grid: readonly string[];
  readonly isHost: boolean;
  /** Room time now, ms. */
  roomNow(): number;
  /** A car this client drives, or undefined. */
  owned(id: string): Entrant | undefined;
  /** Host only: a car reports its finish, at race ms `t`. */
  finished(id: string, t: number): void;
  /** Host only: a car has driven its cool-down lap. */
  cooledDown(id: string): void;
}

/**
 * Everybody else's cars, as this client hears and shows them.
 *
 * Each is a `RemoteCar`, extrapolated to now and posed into the world every
 * step, so our cars collide with where it really is rather than where it was
 * 100 ms ago. Their events — shots, mines, hits, bumps, finishes — are acted
 * on here once each, however often the sender repeats them.
 */
export class RemoteFleet {
  private cars = new Map<string, RemoteCar>();
  /** Events already acted on, so a repeat never fires, hurts or credits twice. */
  private heard = new Set<string>();
  /** Highest shot/mine counter seen from each car, so a host adopting a bot carries on from it. */
  private seqs = new Map<string, number>();
  /** Highest wreck count seen from each car, for the same reason. */
  private wrecks = new Map<string, number>();

  constructor(private clock: Clock, private race: FleetRace) {}

  /** A new race: nobody heard from yet. */
  reset(): void {
    this.cars.clear();
    this.heard.clear();
    this.seqs.clear();
    this.wrecks.clear();
  }

  /** Watch a car on the grid; until its first packet it sits where the grid put it. */
  watch(e: Entrant, goAt: number): void {
    const rc = this.cars.get(e.id) ?? new RemoteCar();
    rc.receive(packetOf(e, goAt - 1e6), this.race.roomNow(), this.clock.now(), true);
    this.cars.set(e.id, rc);
  }

  /** Stop watching a car: this client drives it now. */
  forget(id: string): void {
    this.cars.delete(id);
  }

  /** The highest shot or mine number heard from this car. */
  lastSeq(id: string): number {
    return this.seqs.get(id) ?? 0;
  }

  /** The highest wreck count heard from this car. */
  lastWreck(id: string): number {
    return this.wrecks.get(id) ?? 0;
  }

  /** One client's car message: each car's state, then the events riding with it. */
  receive(publisher: string, payload: string): void {
    if (!this.race.world) return;
    const now = this.race.roomNow();
    for (const r of decodeCars(publisher, payload, now)) {
      if (this.race.owned(r.id)) continue;
      this.onState(r.id, r.car);
      if (r.events.length) this.onEvents(r.id, r.events);
    }
  }

  /** Put every remote car where it is at world time `end` (room time `at`, ms). */
  pose(w: World, at: number): void {
    const L = w.track.length;
    for (const e of w.entrants) {
      if (!e.remote) continue;
      const rc = this.cars.get(e.id);
      const p = rc?.packet;
      if (!rc || !p) continue;
      const pose = rc.display(at);
      const c = e.car;
      c.x = pose.x;
      c.z = pose.z;
      c.yaw = pose.yaw;
      c.vx = pose.vx;
      c.vz = pose.vz;
      c.y = pose.y;
      c.w = p.w;
      c.steer = p.steer;
      c.forward = pose.vx * Math.sin(pose.yaw) + pose.vz * Math.cos(pose.yaw);
      c.airborne = (p.flags & CAR_FLAG.airborne) !== 0;
      c.drifting = (p.flags & CAR_FLAG.drift) !== 0;
      c.braking = (p.flags & CAR_FLAG.brake) !== 0;
      c.handbrake = (p.flags & CAR_FLAG.handbrake) !== 0;
      c.boosting = (p.flags & CAR_FLAG.boost) !== 0;
      e.ghost = (p.flags & CAR_FLAG.ghost) !== 0 ? 0.1 : 0;
      e.wrecked = (p.flags & CAR_FLAG.wrecked) !== 0 ? 0.1 : 0;
      e.hp = p.hp;
      // Its lap count is its owner's word; distance is ours to compute.
      e.lap.completed = p.lap;
      e.lap.s = p.s;
      e.lap.progress = p.lap < 0 ? p.s - L : p.lap * L + p.s;
    }
  }

  private onState(id: string, p: CarPacket): void {
    let rc = this.cars.get(id);
    if (!rc) {
      // A car we did not know was on the grid (a spectator's first packets).
      if (!this.race.world?.entrants.some((e) => e.id === id)) return;
      rc = new RemoteCar();
      this.cars.set(id, rc);
    }
    rc.receive(p, this.race.roomNow(), this.clock.now());
  }

  /** The key a repeated event is recognised by, or null for one that is safe to act on twice. */
  private static once(id: string, ev: CarEvent): string | null {
    switch (ev.k) {
      case 'fire':
      case 'mine':
        return `s:${id}:${ev.seq}`;
      case 'hit':
        return `h:${id}:${ev.seq}`;
      case 'trigger':
        return `t:${id}:${ev.slot}:${ev.seq}`;
      case 'wreck':
        return `w:${id}:${ev.n}`;
      default:
        return null;
    }
  }

  private onEvents(id: string, events: readonly CarEvent[]): void {
    const race = this.race;
    const w = race.world;
    if (!w) return;
    for (const ev of events) {
      const key = RemoteFleet.once(id, ev);
      if (key !== null) {
        if (this.heard.has(key)) continue;
        this.heard.add(key);
      }
      if (ev.k === 'finish') {
        if (race.isHost) race.finished(id, ev.t);
      } else if (ev.k === 'cooldown') {
        if (race.isHost) race.cooledDown(id);
      } else if (ev.k === 'respawn') {
        const rc = this.cars.get(id);
        const e = w.entrants.find((x) => x.id === id);
        if (rc && e) {
          // A teleport: snap, do not slide the car back along the track.
          const now = race.roomNow();
          const p = { ...(rc.packet ?? packetOf(e, now)), x: ev.x, z: ev.z, yaw: ev.yaw, vx: 0, vz: 0, w: 0, t: now };
          rc.receive(p, now, this.clock.now(), true);
        }
      } else if (ev.k === 'bump') {
        const target = race.grid[ev.slot];
        const mine = target ? race.owned(target) : undefined;
        // Felt it ourselves already? Then our own resolution stands.
        if (mine && !w.touchedRecently(target!, id, 0.2)) {
          mine.car.vx += ev.dvx;
          mine.car.vz += ev.dvz;
        }
      } else {
        this.onWeapon(w, id, ev);
      }
    }
  }

  /**
   * Somebody else's weapons (§5.4). Their shots and mines are copied into this
   * world as scenery; their hits are applied here only if the victim is a car
   * this client drives (`World.hit` leaves a remote car's health to its owner).
   */
  private onWeapon(w: World, id: string, ev: CarEvent): void {
    const time = (ms: number): number => w.goTime + ms / 1000;
    if (ev.k === 'fire' || ev.k === 'mine') {
      this.seqs.set(id, Math.max(this.lastSeq(id), ev.seq));
    }
    if (ev.k === 'fire') {
      if (w.armoury.findMissile(id, ev.seq)) return;
      // Fired a moment ago on the shooter's screen: the flight is a function
      // of time, so spawning it late puts it exactly where it now is.
      w.armoury.launch(id, ev.seq, ev.weapon === 1 ? 'rear' : 'front', ev.x, ev.z, ev.yaw, time(ev.t), false);
      w.announce({ kind: 'fire', id, seq: ev.seq, weapon: ev.weapon === 1 ? 'rear' : 'front', x: ev.x, z: ev.z, yaw: ev.yaw, time: time(ev.t) });
    } else if (ev.k === 'mine') {
      if (w.armoury.findMine(id, ev.seq)) return;
      w.armoury.place(id, ev.seq, ev.x, ev.z, time(ev.t));
      w.announce({ kind: 'mine', id, seq: ev.seq, x: ev.x, z: ev.z, time: time(ev.t) });
    } else if (ev.k === 'hit') {
      const victim = this.race.grid[ev.slot];
      if (!victim) return;
      const m = w.armoury.findMissile(id, ev.seq);
      w.hit(victim, id, ev.seq, ev.weapon === 1 ? 'rear' : 'front', ev.dmg, ev.x, ev.z);
      if (m) m.done = true;
    } else if (ev.k === 'trigger') {
      const owner = this.race.grid[ev.slot];
      const m = owner ? w.armoury.findMine(owner, ev.seq) : undefined;
      if (!owner || !m || m.done) return;
      m.done = true;
      w.hit(id, owner, ev.seq, 'mine', 0, m.x, m.z);
    } else if (ev.k === 'wreck') {
      this.wrecks.set(id, Math.max(this.lastWreck(id), ev.n));
      const by = ev.slot >= 0 ? (this.race.grid[ev.slot] ?? null) : null;
      w.creditWreck(id, by);
    }
  }
}
