import { SIM } from '../config.js';
import { wrapAngle } from '../util.js';
import type { CarPacket } from './codec.js';

/** Never extrapolate further than this past the last packet, seconds. */
export const MAX_EXTRAPOLATION = 0.3;
/** Correction error decays with this time constant, seconds. */
export const BLEND_TAU = 0.1;
/** An error bigger than this is a teleport: snap rather than slide. */
export const SNAP_DISTANCE = 10;

export interface Pose {
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  y: number;
}

/**
 * Where a car will be `dt` seconds after a packet, assuming it keeps its
 * speed and its rate of turn (the "constant turn rate and velocity" model).
 *
 * A car mid-corner is predicted along its arc, not off the tangent into the
 * wall — at 45 m/s and a 100 ms gap that difference is several metres. The
 * velocity rotates with the yaw rate, the position is the integral of that
 * rotating velocity, and airborne cars follow a ballistic height.
 *
 * Rotation convention as in `car.ts`: positive yaw rate turns towards the
 * car's left, rotating a vector (x, z) to (x cos θ + z sin θ, −x sin θ + z cos θ).
 */
export function predict(p: CarPacket, dtSec: number, out: Pose): Pose {
  const dt = Math.max(0, Math.min(MAX_EXTRAPOLATION, dtSec));
  const th = p.w * dt;
  const c = Math.cos(th);
  const s = Math.sin(th);
  if (Math.abs(p.w) < 1e-4) {
    out.x = p.x + p.vx * dt;
    out.z = p.z + p.vz * dt;
  } else {
    out.x = p.x + (p.vx * s + p.vz * (1 - c)) / p.w;
    out.z = p.z + (-p.vx * (1 - c) + p.vz * s) / p.w;
  }
  out.vx = p.vx * c + p.vz * s;
  out.vz = -p.vx * s + p.vz * c;
  out.yaw = p.yaw + th;
  const airborne = (p.flags & 32) !== 0;
  out.y = airborne ? Math.max(0, p.y + p.vy * dt - 0.5 * SIM.gravity * dt * dt) : p.y;
  return out;
}

/**
 * A car driven by somebody else, as this client shows it.
 *
 * Not interpolated — interpolation draws cars 100-150 ms in the past, which at
 * racing speed is more than a car length, and you would be shooting at cars
 * that are no longer there. Instead every frame extrapolates the latest
 * packet to *now*.
 *
 * When a new packet arrives the prediction usually disagrees a little with
 * what was on screen. Rather than jump, the difference is kept as an error
 * offset that decays over ~100 ms, framerate-independently: the car glides
 * onto its corrected path. Past `SNAP_DISTANCE`, or on an explicit respawn,
 * it snaps — that far a jump means a teleport really happened.
 */
export class RemoteCar {
  packet: CarPacket | null = null;
  /** When the latest packet arrived, local ms, for staleness. */
  heardAt = 0;
  private ex = 0;
  private ez = 0;
  private eyaw = 0;
  /** Room time the error offsets were taken at, ms. */
  private errAt = 0;
  private shown: Pose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, y: 0 };
  private tmp: Pose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, y: 0 };

  /**
   * A new packet. Out-of-order ones (QoS 0 over a public broker guarantees
   * nothing) are dropped by their stamp.
   */
  receive(p: CarPacket, nowRoomMs: number, heardAt: number, teleport = false): void {
    if (this.packet && p.t <= this.packet.t && !teleport) return;
    if (this.packet && !teleport) {
      // Error = what was on screen minus what the new packet predicts, now.
      const was = this.display(nowRoomMs);
      const next = predict(p, (nowRoomMs - p.t) / 1000, this.tmp);
      const ex = was.x - next.x;
      const ez = was.z - next.z;
      if (Math.hypot(ex, ez) < SNAP_DISTANCE) {
        this.ex = ex;
        this.ez = ez;
        this.eyaw = wrapAngle(was.yaw - next.yaw);
        this.errAt = nowRoomMs;
      } else {
        this.ex = this.ez = this.eyaw = 0;
      }
    } else {
      this.ex = this.ez = this.eyaw = 0;
    }
    this.packet = p;
    this.heardAt = heardAt;
  }

  /** The pose to draw at room time `nowRoomMs`. */
  display(nowRoomMs: number): Pose {
    const p = this.packet;
    if (!p) return this.shown;
    predict(p, (nowRoomMs - p.t) / 1000, this.shown);
    const k = Math.exp(-Math.max(0, nowRoomMs - this.errAt) / 1000 / BLEND_TAU);
    this.shown.x += this.ex * k;
    this.shown.z += this.ez * k;
    this.shown.yaw += this.eyaw * k;
    return this.shown;
  }

  /** How far the packet's own prediction is from `truth` — the sender-side resend test. */
  static error(p: CarPacket, dtSec: number, x: number, z: number, yaw: number): { pos: number; yaw: number } {
    const at = predict(p, dtSec, { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, y: 0 });
    return { pos: Math.hypot(at.x - x, at.z - z), yaw: Math.abs(wrapAngle(at.yaw - yaw)) };
  }
}
