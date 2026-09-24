import * as THREE from 'three';
import type { CarState } from '../sim/car.js';
import { SIM } from '../config.js';
import { Surface } from '../sim/surfaces.js';

const MARK_LIFE = 14;
const MARK_WIDTH = 0.28;

/**
 * Tyre marks: a fixed ring buffer of quads in one geometry.
 *
 * New marks overwrite the oldest, so the cost is constant however long a
 * race runs, and each quad remembers when it was laid so the shader can fade
 * it out. Only the slots written this frame are re-uploaded, not the buffer.
 */
class TyreMarks {
  readonly mesh: THREE.Mesh;
  private positions: Float32Array;
  private births: Float32Array;
  private posAttr: THREE.BufferAttribute;
  private birthAttr: THREE.BufferAttribute;
  private next = 0;
  private readonly capacity: number;
  private uTime = { value: 0 };

  constructor(capacity: number) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 4 * 3);
    this.births = new Float32Array(capacity * 4).fill(-1e6);
    const index = new Uint32Array(capacity * 6);
    for (let k = 0; k < capacity; k++) {
      const v = k * 4;
      index.set([v, v + 2, v + 1, v, v + 3, v + 2], k * 6);
    }
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.birthAttr = new THREE.BufferAttribute(this.births, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aBirth', this.birthAttr);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    const mat = new THREE.MeshBasicMaterial({
      color: 0x0c0c10, transparent: true, opacity: 0.55, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aBirth;\nuniform float uTime;\nvarying float vFade;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>\nvFade = clamp(1.0 - (uTime - aBirth) / ${MARK_LIFE.toFixed(1)}, 0.0, 1.0);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFade;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vFade;');
    };
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'tyre-marks';
  }

  setTime(t: number): void {
    this.uTime.value = t;
  }

  /** Lay one segment of mark from a to b. */
  add(ax: number, az: number, bx: number, bz: number, time: number): void {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return;
    const px = (-dz / len) * (MARK_WIDTH / 2);
    const pz = (dx / len) * (MARK_WIDTH / 2);
    const slot = this.next;
    this.next = (this.next + 1) % this.capacity;
    const y = 0.045;
    const o = slot * 12;
    this.positions.set([ax + px, y, az + pz, ax - px, y, az - pz, bx - px, y, bz - pz, bx + px, y, bz + pz], o);
    this.births.fill(time, slot * 4, slot * 4 + 4);
    this.posAttr.addUpdateRange(o, 12);
    this.birthAttr.addUpdateRange(slot * 4, 4);
    this.posAttr.needsUpdate = true;
    this.birthAttr.needsUpdate = true;
  }
}

export type ParticleKind = 'smoke' | 'dust' | 'spark' | 'fire' | 'flash' | 'soot';

interface KindDef {
  colour: THREE.Color;
  life: number;
  size0: number;
  size1: number;
  alpha: number;
  gravity: number;
  drag: number;
}

const KINDS: Record<ParticleKind, KindDef> = {
  smoke: { colour: new THREE.Color(0xd8d6de), life: 1.3, size0: 1.2, size1: 4.2, alpha: 0.42, gravity: -0.6, drag: 1.6 },
  dust: { colour: new THREE.Color(0xa08a64), life: 1.0, size0: 1.0, size1: 3.4, alpha: 0.5, gravity: -0.3, drag: 1.8 },
  spark: { colour: new THREE.Color(0xffc14a), life: 0.35, size0: 0.35, size1: 0.12, alpha: 1, gravity: 14, drag: 0.6 },
  fire: { colour: new THREE.Color(0xff7a1c), life: 0.55, size0: 1.6, size1: 0.6, alpha: 0.95, gravity: -4, drag: 2.2 },
  flash: { colour: new THREE.Color(0xfff2c0), life: 0.18, size0: 7, size1: 11, alpha: 1, gravity: 0, drag: 0 },
  soot: { colour: new THREE.Color(0x2c2a2e), life: 1.8, size0: 1.4, size1: 5.2, alpha: 0.55, gravity: -1.2, drag: 1.4 },
};

/**
 * Pooled particles, drawn as one `Points` call.
 *
 * The pool is a fixed size from the quality preset. When it is full the
 * oldest particle is recycled rather than the new one being refused: a fresh
 * spark at a crash is worth more than the tail of old smoke.
 */
class Particles {
  readonly points: THREE.Points;
  private n: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private kind: Uint8Array;
  private next = 0;
  private alive = 0;
  readonly uScale = { value: 1 };
  private kinds = Object.values(KINDS);
  private kindIndex: Record<ParticleKind, number> = { smoke: 0, dust: 1, spark: 2, fire: 3, flash: 4, soot: 5 };

  constructor(n: number) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n).fill(0);
    this.kind = new Uint8Array(n);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: this.uScale },
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
          vColor = aColor;
          vAlpha = aAlpha;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5 || vAlpha <= 0.0) discard;
          gl_FragColor = vec4(vColor, vAlpha * smoothstep(0.5, 0.15, d));
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.name = 'particles';
  }

  emit(kind: ParticleKind, x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    const def = KINDS[kind];
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([def.colour.r, def.colour.g, def.colour.b], i * 3);
    this.age[i] = 0;
    this.life[i] = def.life * (0.8 + ((i * 7919) % 100) / 250);
    this.kind[i] = this.kindIndex[kind];
    this.alive = Math.max(this.alive, 1);
  }

  update(dt: number): void {
    if (this.alive === 0) return;
    let alive = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i]! <= 0) continue;
      const def = this.kinds[this.kind[i]!]!;
      const age = (this.age[i]! += dt);
      const t = age / this.life[i]!;
      if (t >= 1) {
        this.life[i] = 0;
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      alive++;
      const damp = Math.exp(-def.drag * dt);
      const o = i * 3;
      this.vel[o] = this.vel[o]! * damp;
      this.vel[o + 1] = this.vel[o + 1]! * damp - def.gravity * dt;
      this.vel[o + 2] = this.vel[o + 2]! * damp;
      this.pos[o] = this.pos[o]! + this.vel[o]! * dt;
      this.pos[o + 1] = Math.max(0.05, this.pos[o + 1]! + this.vel[o + 1]! * dt);
      this.pos[o + 2] = this.pos[o + 2]! + this.vel[o + 2]! * dt;
      this.size[i] = def.size0 + (def.size1 - def.size0) * t;
      this.alpha[i] = def.alpha * (1 - t) * Math.min(1, t * 8);
    }
    this.alive = alive;
    const geo = this.points.geometry;
    for (const name of ['position', 'aColor', 'aSize', 'aAlpha']) geo.getAttribute(name).needsUpdate = true;
  }
}

/** Last mark point per wheel, per car. */
interface WheelTrail {
  x: number;
  z: number;
  on: boolean;
}

/**
 * Car effects: tyre marks from drifting, braking and handbraking; smoke off
 * the rear tyres; dust off the verge; sparks off the walls.
 */
export class Fx {
  readonly group = new THREE.Group();
  private marks: TyreMarks;
  private particles: Particles;
  private trails = new Map<object, WheelTrail[]>();
  private impacts = new Map<object, number>();
  private time = 0;
  private emitCarry = new Map<object, number>();
  private damageCarry = new WeakMap<object, number>();

  constructor(tyreMarks: number, particles: number) {
    this.group.name = 'fx';
    this.marks = new TyreMarks(tyreMarks);
    this.particles = new Particles(particles);
    this.group.add(this.marks.mesh, this.particles.points);
  }

  setPointScale(scale: number): void {
    this.particles.uScale.value = scale;
  }

  emit(kind: ParticleKind, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): void {
    this.particles.emit(kind, x, y, z, vx, vy, vz);
  }

  /**
   * A car's damage, as smoke: grey from under the bonnet below 30% health,
   * thicker with sparks below 15%, and a wreck burns — fire and black smoke —
   * until it is put back on the road.
   */
  condition(car: CarState, hp: number, wrecked: boolean, dt: number, key: object): void {
    const rate = wrecked ? 40 : hp < 15 ? 16 : hp < 30 ? 7 : 0;
    if (!rate) return;
    let carry = (this.damageCarry.get(key) ?? 0) + rate * dt;
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    while (carry >= 1) {
      carry -= 1;
      const x = car.x + fx * 1.3 + (Math.random() - 0.5) * 0.8;
      const z = car.z + fz * 1.3 + (Math.random() - 0.5) * 0.8;
      if (wrecked) {
        this.emit(Math.random() < 0.55 ? 'fire' : 'soot', car.x + (Math.random() - 0.5) * 1.6, 0.9, car.z + (Math.random() - 0.5) * 2.4,
          (Math.random() - 0.5) * 1.5, 2 + Math.random() * 2, (Math.random() - 0.5) * 1.5);
      } else {
        this.emit(hp < 15 ? 'soot' : 'smoke', x, 1, z, car.vx * 0.3, 1.5, car.vz * 0.3);
        if (hp < 15 && Math.random() < 0.15) this.emit('spark', x, 1, z, (Math.random() - 0.5) * 6, 4, (Math.random() - 0.5) * 6);
      }
    }
    this.damageCarry.set(key, carry);
  }

  /** An explosion: a flash, a fireball, debris and a column of smoke. `size` 1 is a missile. */
  explode(x: number, z: number, size: number): void {
    this.emit('flash', x, 1.2, z);
    const n = Math.round(14 * size);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (3 + Math.random() * 7) * size;
      this.emit('fire', x, 0.8, z, Math.cos(a) * v, 2 + Math.random() * 4, Math.sin(a) * v);
      this.emit('spark', x, 0.8, z, Math.cos(a) * v * 2, 4 + Math.random() * 8, Math.sin(a) * v * 2);
    }
    for (let i = 0; i < Math.round(8 * size); i++) {
      this.emit('soot', x + (Math.random() - 0.5) * 2, 1, z + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3, 2.5, (Math.random() - 0.5) * 3);
    }
  }

  /** A missile's exhaust trail, laid at a rate so the trail is as dense at 30 fps as at 144. */
  trail(key: object, x: number, z: number, dx: number, dz: number, speed: number, dt: number): void {
    let carry = (this.damageCarry.get(key) ?? 0) + 70 * dt;
    const count = Math.floor(carry);
    carry -= count;
    for (let k = 0; k < count; k++) {
      // Spread back along the stretch flown this frame, not heaped at the nose.
      const back = (k / Math.max(1, count)) * speed * dt;
      this.emit('smoke', x - dx * back, 0.75, z - dz * back, (Math.random() - 0.5) * 1.2, 0.6, (Math.random() - 0.5) * 1.2);
    }
    this.damageCarry.set(key, carry);
  }

  /** Per-car effects from its current state. */
  car(car: CarState, dt: number): void {
    let trails = this.trails.get(car);
    if (!trails) {
      trails = [0, 1, 2, 3].map(() => ({ x: 0, z: 0, on: false }));
      this.trails.set(car, trails);
    }
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    const lx = fz, lz = -fx;
    const speed = Math.hypot(car.vx, car.vz);
    const hardBrake = car.braking && speed > 12;
    const marking = !car.airborne && (car.drifting || hardBrake || (car.handbrake && speed > 4));
    const wheels = [
      [SIM.car.cgToFront, 0.86], [SIM.car.cgToFront, -0.86],
      [-SIM.car.cgToRear, 0.86], [-SIM.car.cgToRear, -0.86],
    ] as const;
    for (let k = 0; k < 4; k++) {
      // Front tyres only mark under hard braking; a drift is the rear stepping out.
      const on = marking && (k >= 2 || hardBrake);
      const [a, b] = wheels[k]!;
      const x = car.x + fx * a + lx * b;
      const z = car.z + fz * a + lz * b;
      const t = trails[k]!;
      if (on && t.on && Math.hypot(x - t.x, z - t.z) > 0.35) {
        this.marks.add(t.x, t.z, x, z, this.time);
        t.x = x;
        t.z = z;
      } else if (on && !t.on) {
        t.x = x;
        t.z = z;
      }
      t.on = on;
    }

    // Smoke and dust, at a rate rather than per frame, so 144 Hz is not 2.4x smokier.
    const offRoad = car.surfaceRear === Surface.Grass || car.surfaceRear === Surface.Dirt;
    const rate = car.airborne ? 0 : (car.drifting ? 26 : 0) + (offRoad && speed > 6 ? 18 : 0);
    let carry = (this.emitCarry.get(car) ?? 0) + rate * dt;
    while (carry >= 1) {
      carry -= 1;
      const side = Math.random() < 0.5 ? 0.86 : -0.86;
      const x = car.x - fx * SIM.car.cgToRear + lx * side;
      const z = car.z - fz * SIM.car.cgToRear + lz * side;
      this.emit(offRoad ? 'dust' : 'smoke', x, 0.4, z, car.vx * 0.15 + (Math.random() - 0.5) * 2, 1.2, car.vz * 0.15 + (Math.random() - 0.5) * 2);
    }
    this.emitCarry.set(car, carry);

    // Sparks on a new wall impact.
    const seen = this.impacts.get(car) ?? car.impacts;
    if (car.impacts !== seen && car.lastImpact > 4) {
      const n = Math.min(24, Math.round(car.lastImpact));
      for (let i = 0; i < n; i++) {
        this.emit('spark', car.x + fx * 1.8, 0.6, car.z + fz * 1.8,
          (Math.random() - 0.5) * 16 + car.vx * 0.3, 3 + Math.random() * 5, (Math.random() - 0.5) * 16 + car.vz * 0.3);
      }
    }
    this.impacts.set(car, car.impacts);
  }

  update(dt: number): void {
    this.time += dt;
    this.marks.setTime(this.time);
    this.particles.update(dt);
  }
}
