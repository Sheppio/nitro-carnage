import * as THREE from 'three';
import type { CarLook } from '../sim/look.js';
import { CarMesh } from './CarMesh.js';
import { createCar } from '../sim/car.js';
import type { CarState } from '../sim/car.js';

export interface PodiumCar {
  look: CarLook;
  colour: number;
}

/**
 * Where each place stands: which side (times the spread), and the plinth's
 * height. First in the middle and highest.
 */
const PLACES = [
  { side: 0, h: 1.3, colour: 0xffc233 },
  { side: -1, h: 0.85, colour: 0xc9ccd6 },
  { side: 1, h: 0.5, colour: 0xcd7f45 },
] as const;
/** The least distance between plinths, so they never touch. */
const MIN_SPREAD = 4.8;
const FOV = 30;

/**
 * The results' podium: the first three cars, in their own colours and
 * liveries, turning on gold, silver and bronze plinths. Like the Garage's
 * turntable it is its own small renderer, made on first use and drawing only
 * while the results are up.
 */
export class PodiumView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  private plinths: THREE.Mesh[] = [];
  /** Distance between plinths: set by `fit` so each car stands over its name. */
  private spread = MIN_SPREAD;
  private cars: { mesh: CarMesh; state: CarState; y: number }[] = [];
  private raf = 0;
  private last = 0;
  private time = 0;
  private resize: ResizeObserver;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.domElement.className = 'podium-canvas';
    host.prepend(this.renderer.domElement);
    this.scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x2a2233, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(3, 9, 6);
    this.scene.add(sun);
    for (const p of PLACES) {
      const plinth = new THREE.Mesh(
        new THREE.CylinderGeometry(2.1, 2.2, p.h, 32),
        new THREE.MeshLambertMaterial({ color: p.colour, emissive: p.colour, emissiveIntensity: 0.12 }),
      );
      plinth.position.set(p.side * this.spread, p.h / 2, 0);
      this.scene.add(plinth);
      this.plinths.push(plinth);
    }
    this.camera.position.set(0, 5, 11);
    this.camera.lookAt(0, 1.1, 0);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
  }

  /** Put the first three (fewer, in a short race) on their plinths. */
  show(cars: readonly PodiumCar[]): void {
    // Last race's cars, off the plinths and out of GPU memory.
    for (const c of this.cars) {
      this.scene.remove(c.mesh.root, c.mesh.blob);
      c.mesh.root.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) x.dispose();
      });
      c.mesh.blob.geometry.dispose();
    }
    this.cars = cars.slice(0, 3).map((c, i) => {
      const mesh = new CarMesh(c.colour, false, c.look);
      // The blob shadow belongs on a road, not on a plinth top.
      mesh.blob.visible = false;
      this.scene.add(mesh.root);
      // Each faces a little differently to start, so they don't turn in step.
      const state = createCar(PLACES[i]!.side * this.spread, 0, 0.9 + i * 2.1);
      return { mesh, state, y: PLACES[i]!.h };
    });
  }

  start(): void {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number): void => {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.time += dt;
      for (const [i, c] of this.cars.entries()) {
        c.state.yaw += dt * (0.7 - i * 0.12);
        c.mesh.update(c.state, dt);
        // The winner bobs, just a little.
        c.mesh.root.position.y = c.y + (i === 0 ? Math.abs(Math.sin(this.time * 2.2)) * 0.18 : 0);
      }
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private fit(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Narrow boxes pull back so the outer plinths stay in frame.
    const back = Math.max(1, 3.2 / this.camera.aspect);
    this.camera.position.set(0, 5 * back, 11 * back);
    this.camera.lookAt(0, 1.1, 0);
    this.camera.updateProjectionMatrix();
    // The names are in thirds of the box, their centres a third of its width
    // apart: spread the plinths to match, measured across the view where they
    // stand, so a wide landscape box doesn't leave the cars huddled mid-screen.
    const dist = this.camera.position.distanceTo(new THREE.Vector3(0, 1.1, 0));
    const halfWidth = dist * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * this.camera.aspect;
    this.spread = Math.max(MIN_SPREAD, (halfWidth * 2) / 3);
    this.plinths.forEach((p, i) => (p.position.x = PLACES[i]!.side * this.spread));
    this.cars.forEach((c, i) => (c.state.x = PLACES[i]!.side * this.spread));
  }
}
