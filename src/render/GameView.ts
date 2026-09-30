import * as THREE from 'three';
import { QUALITY } from '../config.js';
import type { QualityId } from '../config.js';
import type { CarState } from '../sim/car.js';
import type { Track } from '../sim/track/buildTrack.js';
import { CameraRig } from './CameraRig.js';
import { CarMesh } from './CarMesh.js';
import { createCar } from '../sim/car.js';
import type { CarLook } from '../sim/look.js';
import { Fx } from './Fx.js';
import { cutawayUniforms, MAX_CUT_CARS } from './materials.js';
import { Scenery } from './Scenery.js';
import { ShadowRig } from './ShadowRig.js';
import { themeFor } from './themes.js';
import { buildTrackMesh } from './TrackMesh.js';
import { WeaponView } from './WeaponView.js';
import { HazardView } from './HazardView.js';
import { PickupView } from './PickupView.js';
import type { Pickups } from '../sim/pickups.js';
import type { Armoury } from '../sim/weapons.js';

/**
 * One renderer, and so one WebGL context, for every race. A new one per race
 * left the last race's context and its GPU memory alive until the garbage
 * collector got round to the canvas, which a small heap rarely asks it to:
 * an Xbox ran the first race at 60 fps and the next ones at 52-56, with
 * judder, until a reload. A context is only replaced when the antialias
 * setting changes, which WebGL fixes at creation, and the old one is then
 * released at once.
 */
let shared: { renderer: THREE.WebGLRenderer; antialias: boolean } | null = null;
function rendererFor(antialias: boolean): THREE.WebGLRenderer {
  if (shared && shared.antialias === antialias) return shared.renderer;
  if (shared) {
    shared.renderer.dispose();
    shared.renderer.forceContextLoss();
  }
  const renderer = new THREE.WebGLRenderer({ antialias, powerPreference: 'high-performance' });
  shared = { renderer, antialias };
  return renderer;
}

/** Free a material's GPU copy and every texture it uses. */
function disposeMaterial(m: THREE.Material): void {
  for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
  m.dispose();
}
import { missileAt } from '../sim/weapons.js';

/** How far out the cut-away hole reaches around a car, in metres at the car. */
const CUT_RADIUS_M = 6.5;

export interface CarView {
  id: string;
  mesh: CarMesh;
  /** Last seen event counters, for one-shot effects. */
  landings: number;
  impacts: number;
  hp: number;
  wrecked: boolean;
  ghost: boolean;
}

/**
 * Everything three.js, for one race.
 *
 * The rest of the game hands this a `Track` and, each frame, the car states
 * to draw. It never reads input, never steps physics and never touches the
 * network; `render/` is the only directory that imports three, which keeps
 * the renderer swappable and the simulation runnable in Node.
 */
export class GameView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly cars = new Map<string, CarView>();
  readonly scenery: Scenery;
  private shadows: ShadowRig;
  private fx: Fx;
  private weapons = new WeaponView();
  private hazards: HazardView;
  private ghost: CarMesh | null = null;
  private ghostState = createCar(0, 0, 0);
  private clock = 0;
  private quality: QualityId;
  private resizeObserver: ResizeObserver;
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private right = new THREE.Vector3();
  private size = new THREE.Vector2();
  /** The car the camera follows. */
  focusId: string | null = null;
  /** Fired with a 0..1 strength when the focused car lands or hits a wall, for haptics. */
  onJolt: ((kind: 'landing' | 'crash', strength: number) => void) | null = null;

  constructor(private host: HTMLElement, readonly track: Track, quality: QualityId) {
    this.quality = quality;
    const preset = QUALITY[quality];
    this.renderer = rendererFor(preset.antialias);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, preset.pixelRatioCap));
    this.renderer.shadowMap.enabled = preset.shadowMapSize > 0;
    this.renderer.shadowMap.type = preset.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.renderer.domElement.className = 'game-canvas';
    host.appendChild(this.renderer.domElement);

    const theme = themeFor(track.def.theme);
    this.scene.background = new THREE.Color(theme.sky);
    this.scene.fog = new THREE.Fog(theme.fog, preset.drawDistance * 0.45, preset.drawDistance);

    this.shadows = new ShadowRig(theme, preset.shadowMapSize, preset.softShadows);
    this.scene.add(this.shadows.hemi, this.shadows.sun, this.shadows.sun.target);

    this.scene.add(buildTrackMesh(track, theme));
    this.scenery = new Scenery(track, theme, preset.sceneryDetail);
    this.scene.add(this.scenery.group);

    this.fx = new Fx(preset.tyreMarks, preset.particles);
    this.hazards = new HazardView(track);
    this.scene.add(this.fx.group, this.weapons.group, this.hazards.group);

    this.rig = new CameraRig(1);
    this.rig.setFar(preset.drawDistance + 60);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  get qualityId(): QualityId {
    return this.quality;
  }

  addCar(id: string, colour: number, look?: CarLook): CarView {
    const mesh = new CarMesh(colour, QUALITY[this.quality].shadowMapSize > 0, look);
    this.scene.add(mesh.root, mesh.blob);
    const view: CarView = { id, mesh, landings: 0, impacts: 0, hp: 100, wrecked: false, ghost: false };
    this.cars.set(id, view);
    this.focusId ??= id;
    return view;
  }

  /** A car's health and state, for smoke, fire and the ghost blink. */
  setCondition(id: string, hp: number, wrecked: boolean, ghost: boolean): void {
    const view = this.cars.get(id);
    if (!view) return;
    view.hp = hp;
    view.wrecked = wrecked;
    view.ghost = ghost;
  }

  /**
   * Missiles and mines, drawn at world time `time` — the same interpolated
   * moment the cars are drawn at — with exhaust trails.
   */
  drawWeapons(armoury: Armoury, time: number, dt: number, cars: Iterable<{ x: number; z: number }>): void {
    this.weapons.update(armoury, time, cars);
    for (const m of armoury.missiles) {
      if (m.done || time < m.t0 || time > m.end) continue;
      const p = missileAt(m, time);
      this.fx.trail(m, p.x - m.dx * 1.4, p.z - m.dz * 1.4, m.dx, m.dz, m.speed, dt);
    }
  }

  /**
   * The hotlap ghost: a see-through copy of the followed car, posed on the
   * record lap's path, or hidden when there is none. Drawn only — the world
   * never hears of it, so nothing can hit it.
   */
  drawGhost(pose: { x: number; z: number; yaw: number; speed: number } | null): void {
    if (!pose) {
      if (this.ghost) this.ghost.root.visible = false;
      return;
    }
    if (!this.ghost) this.prepareGhost();
    if (!this.ghost) return;
    const st = this.ghostState;
    st.x = pose.x;
    st.z = pose.z;
    st.yaw = pose.yaw;
    st.forward = pose.speed;
    this.ghost.root.visible = true;
    this.ghost.update(st, 1 / 60);
  }

  /**
   * Build the ghost ahead of time, hidden, and compile its see-through
   * shaders now: made on the spot, at the end of the first lap, the new
   * shader programs stalled the game for a moment just as the ghost appeared.
   */
  prepareGhost(): void {
    if (this.ghost) return;
    const me = this.focusId ? this.cars.get(this.focusId) : undefined;
    if (!me) return;
    const g = new CarMesh(me.mesh.colour, false, me.mesh.look);
    g.root.name = 'ghost';
    g.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.material) return;
      const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => {
        const c = m.clone();
        c.transparent = true;
        c.opacity = 0.38;
        c.depthWrite = false;
        return c;
      });
      mesh.material = Array.isArray(mesh.material) ? mats : mats[0]!;
      mesh.castShadow = false;
    });
    this.scene.add(g.root);
    this.ghost = g;
    // compile() skips hidden objects: show it for the compile, then hide it.
    g.root.visible = true;
    this.renderer.compile(this.scene, this.rig.camera);
    g.root.visible = false;
  }

  private pickupView: PickupView | null = null;

  /** Show a race's pickup boxes. */
  setPickups(pickups: Pickups | null): void {
    if (this.pickupView) this.scene.remove(this.pickupView.group);
    this.pickupView = new PickupView(pickups);
    this.scene.add(this.pickupView.group);
  }

  /** The pickup boxes, at a world time. */
  drawPickups(t: number, dt: number): void {
    this.pickupView?.update(t, dt);
  }

  /** The train and the crossing, at a race time (seconds since GO). */
  drawHazards(raceTime: number, dt: number): void {
    this.hazards.update(raceTime, dt);
  }

  /** The winner is home (#23): fireworks and confetti over the line. Returns when each firework goes off. */
  celebrate(x: number, z: number): number[] {
    return this.fx.celebrate(x, z);
  }

  /**
   * An explosion at a world point. The camera shakes with it, by how close
   * it is to the car being followed.
   */
  explode(x: number, z: number, size: number, focus: { x: number; z: number } | undefined): void {
    this.fx.explode(x, z, size);
    if (focus) {
      const d = Math.hypot(x - focus.x, z - focus.z);
      this.rig.addTrauma(Math.max(0, 0.55 * size * (1 - d / 40)));
    }
  }

  resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.rig.setAspect(w / h);
    this.rig.camera.updateProjectionMatrix();
  }

  /**
   * Draw one frame.
   * @param states car id -> the state to draw it in (already interpolated)
   * @param dt real seconds since the last frame
   */
  render(states: ReadonlyMap<string, CarState>, dt: number): void {
    for (const [id, state] of states) {
      const view = this.cars.get(id);
      if (!view) continue;
      view.mesh.condition(view.wrecked, view.ghost, this.clock);
      view.mesh.update(state, dt);
      this.fx.car(state, dt);
      this.fx.condition(state, view.hp, view.wrecked, dt, view);
      if (id === this.focusId) this.jolts(view, state);
    }
    this.fx.update(dt);
    this.clock += dt;
    this.scenery.update(this.clock);

    const focus = this.focusId ? states.get(this.focusId) : undefined;
    if (focus) {
      this.rig.update(focus, dt);
    }
    const cam = this.rig.camera;
    cam.updateMatrixWorld();
    if (focus) this.shadows.follow(cam);

    this.renderer.getDrawingBufferSize(this.size);
    this.fx.setPointScale(this.size.y / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)));
    this.updateCutaway(states);
    this.renderer.render(this.scene, cam);
  }

  private jolts(view: CarView, state: CarState): void {
    if (state.landings !== view.landings) {
      view.landings = state.landings;
      const k = Math.min(1, state.lastLanding / 10);
      if (k > 0.15) {
        this.rig.addTrauma(k * 0.5);
        this.onJolt?.('landing', k);
      }
    }
    if (state.impacts !== view.impacts) {
      view.impacts = state.impacts;
      const k = Math.min(1, state.lastImpact / 25);
      if (k > 0.12) {
        this.rig.addTrauma(k * 0.6);
        this.onJolt?.('crash', k);
      }
    }
  }

  /** Project every car to the screen for the cut-away shader. */
  private updateCutaway(states: ReadonlyMap<string, CarState>): void {
    const cam = this.rig.camera;
    const u = cutawayUniforms;
    u.uCutRes.value.copy(this.size);
    u.uCutAspect.value = cam.aspect;
    this.right.setFromMatrixColumn(cam.matrixWorld, 0);
    let k = 0;
    for (const state of states.values()) {
      if (k >= MAX_CUT_CARS) break;
      this.v.set(state.x, state.y + 0.8, state.z);
      const depth = -this.v.clone().applyMatrix4(cam.matrixWorldInverse).z;
      this.v2.copy(this.v).addScaledVector(this.right, CUT_RADIUS_M).project(cam);
      this.v.project(cam);
      const radius = Math.abs(this.v2.x - this.v.x) * cam.aspect;
      u.uCutCars.value[k]!.set(this.v.x, this.v.y, depth, 1);
      u.uCutRadius.value[k] = radius;
      k++;
    }
    for (; k < MAX_CUT_CARS; k++) u.uCutCars.value[k]!.w = 0;
  }

  /* ---------------------------------------------------------------- debug */

  /**
   * Where a car's name tag goes: a point just past the car's roof toward the
   * top of the screen, whichever way the camera faces, so the tag clears the
   * car at any heading.
   */
  overCar(x: number, z: number): { x: number; y: number; onScreen: boolean } {
    const up = new THREE.Vector3().setFromMatrixColumn(this.rig.camera.matrixWorld, 1);
    return this.toScreen(x + up.x * 2.6, 1.5 + up.y * 2.6, z + up.z * 2.6);
  }

  /** Where a world point lands on screen, in CSS pixels from the canvas's top left. */
  toScreen(x: number, y: number, z: number): { x: number; y: number; onScreen: boolean } {
    const p = new THREE.Vector3(x, y, z).project(this.rig.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: ((p.x + 1) / 2) * rect.width,
      y: ((1 - p.y) / 2) * rect.height,
      onScreen: Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1,
    };
  }

  /**
   * Render now and read back a square of pixels centred on a world point.
   * Reading straight after `render` in the same task means the drawing buffer
   * has not been presented and cleared yet, so no `preserveDrawingBuffer`.
   */
  samplePixels(states: ReadonlyMap<string, CarState>, x: number, y: number, z: number, half = 4): number[][] {
    this.render(states, 0);
    const p = new THREE.Vector3(x, y, z).project(this.rig.camera);
    const px = Math.round(((p.x + 1) / 2) * this.size.x);
    const py = Math.round(((p.y + 1) / 2) * this.size.y);
    const side = half * 2 + 1;
    const buf = new Uint8Array(side * side * 4);
    const gl = this.renderer.getContext();
    gl.readPixels(px - half, py - half, side, side, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out: number[][] = [];
    for (let i = 0; i < side * side; i++) out.push([buf[i * 4]!, buf[i * 4 + 1]!, buf[i * 4 + 2]!]);
    return out;
  }

  /** Draw calls in the last frame, including the shadow pass. */
  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  setCutaway(on: boolean): void {
    cutawayUniforms.uCutEnabled.value = on ? 1 : 0;
  }

  /**
   * Give back everything this race put on the GPU: geometry, materials,
   * textures and the shadow map. The renderer itself is kept for the next
   * race (see `rendererFor`), so its canvas only leaves the page.
   */
  dispose(): void {
    this.resizeObserver.disconnect();
    this.renderer.domElement.remove();
    for (const view of this.cars.values()) {
      const blob = view.mesh.blob;
      blob.removeFromParent();
      blob.geometry.dispose();
      disposeMaterial(blob.material as THREE.Material);
    }
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach(disposeMaterial);
      else if (mat) disposeMaterial(mat);
      (o as THREE.DirectionalLight).shadow?.dispose();
    });
    if (this.scene.background instanceof THREE.Texture) this.scene.background.dispose();
    this.renderer.renderLists.dispose();
  }
}
