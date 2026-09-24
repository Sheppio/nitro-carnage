import * as THREE from 'three';
import type { CarState } from '../sim/car.js';
import { SIM } from '../config.js';
import { MeshBuilder } from './geometry.js';
import { flatMaterial } from './materials.js';

const WHEEL_R = 0.36;
const WHEEL_W = 0.3;
const TRACK_HALF = 0.86;
const AXLE_F = SIM.car.cgToFront;
const AXLE_R = -SIM.car.cgToRear;

/** Darken or lighten a hex colour. */
const tint = (hex: number, f: number): number => new THREE.Color(hex).multiplyScalar(f).getHex();

/**
 * Local frame: +Z is the nose, +X is the car's LEFT, +Y up. That matches the
 * simulation's conventions exactly (see `car.ts`), so `rotation.y = yaw` and a
 * positive wheel angle both mean the same thing on screen as in the physics.
 */
function bodyGeometry(colour: number): THREE.BufferGeometry {
  const dark = tint(colour, 0.55);
  const glass = 0x1b2230;
  const trim = 0x202228;
  const b = new MeshBuilder();
  // Hull, with the nose and tail tapered in.
  b.box(0, 0.58, 0, 1.92, 0.5, 4.3, colour, { insetX: 0.08, insetZFront: 0.35, insetZBack: 0.1, skipBottom: true, sides: dark });
  // Cabin: a trapezoid set back from centre.
  b.box(0, 1.03, -0.3, 1.58, 0.42, 2.0, glass, { insetX: 0.16, insetZFront: 0.45, insetZBack: 0.2, skipBottom: true, top: colour });
  // Side skirts and bumpers.
  b.box(0, 0.4, 2.1, 1.9, 0.22, 0.25, trim, { skipBottom: true });
  b.box(0, 0.42, -2.12, 1.9, 0.26, 0.22, trim, { skipBottom: true });
  // Spoiler: two posts and a wing.
  b.box(0.6, 0.98, -1.9, 0.08, 0.3, 0.12, trim, { skipBottom: true });
  b.box(-0.6, 0.98, -1.9, 0.08, 0.3, 0.12, trim, { skipBottom: true });
  b.box(0, 1.16, -1.95, 1.8, 0.07, 0.42, colour, { top: tint(colour, 1.15), sides: dark });
  // A racing stripe, so which way a stationary car faces is readable at a glance.
  b.box(0, 0.84, 0.9, 0.36, 0.02, 2.2, 0xf4f1ea, { skipBottom: true });
  return b.build();
}

function lightsGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.box(0.62, 0.62, 2.16, 0.42, 0.14, 0.06, 0xfff4d6);
  b.box(-0.62, 0.62, 2.16, 0.42, 0.14, 0.06, 0xfff4d6);
  b.box(0.66, 0.66, -2.16, 0.4, 0.12, 0.06, 0xff2a3c);
  b.box(-0.66, 0.66, -2.16, 0.4, 0.12, 0.06, 0xff2a3c);
  return b.build();
}

let wheelGeo: THREE.BufferGeometry | null = null;
let blobTexture: THREE.Texture | null = null;

function blob(): THREE.Texture {
  if (blobTexture) return blobTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.75)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  blobTexture = new THREE.CanvasTexture(c);
  return blobTexture;
}

/**
 * One car on screen. Owns no simulation state: every frame it is posed from a
 * `CarState` (interpolated for the local car, dead-reckoned for remotes), and
 * the purely visual extras — body roll and pitch, wheel spin — are integrated
 * here, because nobody else needs them and they never go on the wire.
 */
export class CarMesh {
  readonly root = new THREE.Group();
  readonly colour: number;
  private body = new THREE.Group();
  private wheels: THREE.InstancedMesh;
  private shadow: THREE.Mesh;
  private spin = 0;
  private roll = 0;
  private rollVel = 0;
  private pitch = 0;
  private pitchVel = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly v = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(colour: number, shadowMaps: boolean) {
    this.colour = colour;
    this.root.name = 'car';
    const hull = new THREE.Mesh(bodyGeometry(colour), flatMaterial());
    hull.castShadow = true;
    hull.name = 'car-body';
    const lights = new THREE.Mesh(lightsGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true }));
    this.body.add(hull, lights);
    this.root.add(this.body);

    wheelGeo ??= new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, 10).rotateZ(Math.PI / 2);
    this.wheels = new THREE.InstancedMesh(wheelGeo, new THREE.MeshLambertMaterial({ color: 0x17181c, flatShading: true }), 4);
    this.wheels.castShadow = true;
    this.wheels.frustumCulled = false;
    this.root.add(this.wheels);

    // A soft blob under the car: the whole shadow on low quality, and on every
    // quality the thing that grows and fades while the car is in the air, so
    // the height of a jump reads from straight above.
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.8, 5.2),
      new THREE.MeshBasicMaterial({ map: blob(), transparent: true, depthWrite: false, opacity: shadowMaps ? 0.55 : 0.85 }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 1;
    this.shadow.name = 'car-blob';
  }

  /** The blob lives at ground level, outside the car's own transform. */
  get blob(): THREE.Mesh {
    return this.shadow;
  }

  /**
   * Pose from a car state.
   * @param dt real seconds since the last frame, for the visual springs
   */
  update(car: CarState, dt: number): void {
    this.root.position.set(car.x, car.y, car.z);
    this.root.rotation.y = car.yaw;

    // Body roll and pitch: a damped spring driven by the physics' own
    // acceleration. Leaning out of corners and squatting under power is most
    // of what makes a top-down car feel heavy.
    const step = Math.min(dt, 1 / 30);
    const rollTarget = car.airborne ? 0 : Math.max(-0.09, Math.min(0.09, car.accelLat * 0.0075));
    const pitchTarget = car.airborne ? -0.04 : Math.max(-0.06, Math.min(0.06, -car.accelLong * 0.004));
    this.rollVel += ((rollTarget - this.roll) * 160 - this.rollVel * 16) * step;
    this.roll += this.rollVel * step;
    this.pitchVel += ((pitchTarget - this.pitch) * 160 - this.pitchVel * 16) * step;
    this.pitch += this.pitchVel * step;
    this.body.rotation.set(this.pitch, 0, this.roll, 'YXZ');

    this.spin += (car.forward * dt) / WHEEL_R;
    const place = (i: number, x: number, z: number, steer: number): void => {
      this.e.set(this.spin, steer, 0);
      this.q.setFromEuler(this.e);
      this.m.compose(this.v.set(x, WHEEL_R, z), this.q, this.one);
      this.wheels.setMatrixAt(i, this.m);
    };
    place(0, TRACK_HALF, AXLE_F, car.steer);
    place(1, -TRACK_HALF, AXLE_F, car.steer);
    place(2, TRACK_HALF, AXLE_R, 0);
    place(3, -TRACK_HALF, AXLE_R, 0);
    this.wheels.instanceMatrix.needsUpdate = true;

    const lift = Math.max(0, car.y);
    const grow = 1 + lift * 0.18;
    this.shadow.position.set(car.x, 0.06, car.z);
    this.shadow.rotation.z = car.yaw;
    this.shadow.scale.set(grow, grow, 1);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.2, 0.8 - lift * 0.12);
  }
}
