import * as THREE from 'three';
import type { Armoury } from '../sim/weapons.js';
import { mineArmed, missileAt } from '../sim/weapons.js';

const MAX_MISSILES = 64;
const MAX_MINES = 48;
const MISSILE_Y = 0.75;

/**
 * Missiles and mines on screen. Each is one `InstancedMesh`, so a race full
 * of shots costs a handful of draw calls however many are in the air.
 *
 * Like the rest of `render/`, it owns no state that matters: every frame it
 * is handed the armoury and a time, and poses everything from that. A
 * missile's position is a function of time (see `sim/weapons.ts`), so it is
 * drawn at the renderer's interpolated time and moves as smoothly as the cars.
 */
export class WeaponView {
  readonly group = new THREE.Group();
  private missiles: THREE.InstancedMesh;
  private flames: THREE.InstancedMesh;
  private mineBodies: THREE.InstancedMesh;
  private mineLights: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private c = new THREE.Color();

  constructor() {
    this.group.name = 'weapons';
    const body = new THREE.CylinderGeometry(0.24, 0.3, 1.9, 8).rotateX(Math.PI / 2);
    this.missiles = new THREE.InstancedMesh(body, new THREE.MeshLambertMaterial({ color: 0xe8e4da, flatShading: true }), MAX_MISSILES);
    const flame = new THREE.ConeGeometry(0.34, 1.5, 8).rotateX(-Math.PI / 2).translate(0, 0, -1.6);
    this.flames = new THREE.InstancedMesh(flame, new THREE.MeshBasicMaterial({ color: 0xffb040 }), MAX_MISSILES);

    const disc = new THREE.CylinderGeometry(0.62, 0.7, 0.2, 10);
    this.mineBodies = new THREE.InstancedMesh(disc, new THREE.MeshLambertMaterial({ color: 0x2a2d33, flatShading: true }), MAX_MINES);
    const light = new THREE.SphereGeometry(0.22, 8, 6);
    this.mineLights = new THREE.InstancedMesh(light, new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_MINES);
    this.mineLights.setColorAt(0, this.c.set(0xff2a2a));

    for (const mesh of [this.missiles, this.flames, this.mineBodies, this.mineLights]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    this.missiles.name = 'missiles';
    this.mineBodies.name = 'mines';
  }

  /**
   * @param time world time to draw at (interpolated between steps)
   * @param cars where the cars are, for the mines' proximity beacons
   */
  update(armoury: Armoury, time: number, cars: Iterable<{ x: number; z: number }>): void {
    let n = 0;
    for (const m of armoury.missiles) {
      if (m.done || time < m.t0 || time > m.end || n >= MAX_MISSILES) continue;
      const p = missileAt(m, time);
      this.e.set(0, m.yaw, 0);
      this.q.setFromEuler(this.e);
      this.m.compose(this.v.set(p.x, MISSILE_Y, p.z), this.q, this.s);
      this.missiles.setMatrixAt(n, this.m);
      // The exhaust flickers: a flame that holds still looks like a paper cone.
      const f = 0.8 + 0.4 * Math.abs(Math.sin(time * 47 + m.seq));
      this.m.compose(this.v, this.q, this.v2.set(1, 1, f));
      this.flames.setMatrixAt(n, this.m);
      n++;
    }
    this.missiles.count = n;
    this.flames.count = n;
    this.missiles.instanceMatrix.needsUpdate = true;
    this.flames.instanceMatrix.needsUpdate = true;

    const near: { x: number; z: number }[] = [...cars];
    let k = 0;
    for (const mine of armoury.mines) {
      if (mine.done || k >= MAX_MINES) continue;
      this.m.compose(this.v.set(mine.x, 0.1, mine.z), this.q.identity(), this.s);
      this.mineBodies.setMatrixAt(k, this.m);
      this.m.compose(this.v.set(mine.x, 0.28, mine.z), this.q, this.s);
      this.mineLights.setMatrixAt(k, this.m);
      // Beacon: amber while arming, then red, pulsing at 2 Hz — faster with a car close.
      let colour: number;
      if (!mineArmed(mine, time)) {
        colour = 0xffb020;
      } else {
        const close = near.some((c) => (c.x - mine.x) ** 2 + (c.z - mine.z) ** 2 < 144);
        const rate = close ? 7 : 2;
        const on = Math.sin((time - mine.armAt) * rate * Math.PI * 2) > -0.2;
        colour = on ? 0xff2020 : 0x4a0a0a;
      }
      this.mineLights.setColorAt(k, this.c.set(colour));
      k++;
    }
    this.mineBodies.count = k;
    this.mineLights.count = k;
    this.mineBodies.instanceMatrix.needsUpdate = true;
    this.mineLights.instanceMatrix.needsUpdate = true;
    if (this.mineLights.instanceColor) this.mineLights.instanceColor.needsUpdate = true;
  }

  private v2 = new THREE.Vector3();

}
