import * as THREE from 'three';
import type { Theme } from './themes.js';

/** Smallest half-width of the shadow camera's box, metres. */
const MIN_EXTENT = 60;
/** Largest: the high, swung-round start camera sees about this far. */
const MAX_EXTENT = 240;
/** The box grows and shrinks in steps this big, so its texels stay put between steps. */
const STEP = 15;
/** Tallest shadow caster (towers, crane booms), metres: roofs up there must be in the box too. */
const CEILING = 36;
/** Longest stretch of a frustum ray that counts, metres, for rays near the horizon. */
const REACH = 400;

/**
 * The sun, and a shadow camera that covers what the race camera sees.
 *
 * One directional light lights the whole scene, but its shadow map only
 * covers a box around the view — a whole-city shadow map would spread 2048
 * texels over 600 m and every shadow would be a blur. Each frame the box is
 * fitted to the race camera's frustum, measured in the light's own frame, so
 * a wide screen or the look-ahead never shows ground past its edge, where
 * shadows would stop short (#10).
 *
 * The box moves in steps of exactly one shadow-map texel, and changes size
 * only in coarse steps; a box that slides or scales smoothly re-samples every
 * shadow edge each frame, and they crawl and shimmer as you drive.
 */
export class ShadowRig {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private dir = new THREE.Vector3();
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();
  private elevation: number;
  private mapSize: number;
  private extent = 0;
  private texel = 1;
  private depth = 200;
  private ndc = new THREE.Vector3();
  private near = new THREE.Vector3();
  private far = new THREE.Vector3();
  private p = new THREE.Vector3();

  constructor(theme: Theme, mapSize: number, soft: boolean) {
    this.hemi = new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, theme.hemiIntensity);
    this.sun = new THREE.DirectionalLight(theme.sun, theme.sunIntensity);
    const az = THREE.MathUtils.degToRad(theme.sunAzimuth);
    this.elevation = THREE.MathUtils.degToRad(theme.sunElevation);
    const el = this.elevation;
    // Direction the light travels, from the sun towards the ground.
    this.dir.set(-Math.cos(el) * Math.sin(az), -Math.sin(el), -Math.cos(el) * Math.cos(az)).normalize();
    this.right.crossVectors(this.dir, new THREE.Vector3(0, 1, 0)).normalize();
    this.up.crossVectors(this.right, this.dir).normalize();
    this.mapSize = mapSize;

    if (mapSize > 0) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(mapSize, mapSize);
      this.sun.shadow.bias = -0.0006;
      this.sun.shadow.normalBias = 0.04;
      this.sun.shadow.radius = soft ? 2 : 1;
      this.resize(MIN_EXTENT);
    }
  }

  /**
   * Fit the shadow box around what `camera` sees, snapped to the texel grid in light space.
   *
   * `sizing`, when given, is the camera the box is sized for: the race camera
   * at top speed (#36). The box then keeps one size whatever the speed, and
   * only its position follows `camera`. A change of size changes every texel,
   * and every shadow on screen jumps with it.
   */
  follow(camera: THREE.PerspectiveCamera, sizing: THREE.PerspectiveCamera | null = null): void {
    const view = this.footprint(camera);
    if (this.mapSize > 0) {
      const steady = sizing ? this.footprint(sizing).need : 0;
      if (steady >= view.need) {
        // The top-speed size holds still, so it is taken exactly: no step to spare.
        this.resize(steady);
      } else if (view.need > this.extent || view.need < this.extent - 2 * STEP) {
        // Wider than that (the high start view): grow at once, and shrink only
        // once well clear, so it does not flicker between steps.
        this.resize(view.need);
      }
    }

    // Snap the components across the light's view; the depth is only where
    // the sun stands back from.
    const r = Math.round(view.r / this.texel) * this.texel;
    const u = Math.round(view.u / this.texel) * this.texel;
    const d = view.d;
    this.sun.target.position.set(0, 0, 0)
      .addScaledVector(this.right, r)
      .addScaledVector(this.up, u)
      .addScaledVector(this.dir, d);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.dir, -this.depth);
    this.sun.target.updateMatrixWorld();
  }

  /**
   * Where the frustum's corner rays meet the ground and the rooftops, in
   * light space: the centre across the light, the mean depth along it, and the
   * half-width a box needs. Casters and their shadows share light-space x/y,
   * so a box around the visible receivers takes in everything that shades them.
   */
  private footprint(camera: THREE.PerspectiveCamera): { r: number; u: number; d: number; need: number } {
    let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity, sumD = 0;
    for (const h of [0, CEILING]) {
      for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        this.near.copy(this.ndc.set(x, y, -1)).unproject(camera);
        this.far.copy(this.ndc.set(x, y, 1)).unproject(camera);
        const dy = this.far.y - this.near.y;
        // A ray that never comes down stops at REACH, not at the far plane.
        const reach = REACH / this.near.distanceTo(this.far);
        const t = dy < 0 ? Math.min(reach, Math.max(0, (h - this.near.y) / dy)) : reach;
        this.p.lerpVectors(this.near, this.far, Math.min(1, t));
        const r = this.p.dot(this.right);
        const u = this.p.dot(this.up);
        minR = Math.min(minR, r); maxR = Math.max(maxR, r);
        minU = Math.min(minU, u); maxU = Math.max(maxU, u);
        sumD += this.p.dot(this.dir);
      }
    }
    return { r: (minR + maxR) / 2, u: (minU + maxU) / 2, d: sumD / 8, need: Math.max(maxR - minR, maxU - minU) / 2 + 4 };
  }

  private resize(need: number): void {
    const extent = Math.min(MAX_EXTENT, Math.max(MIN_EXTENT, Math.ceil(need / STEP) * STEP));
    if (extent === this.extent) return;
    this.extent = extent;
    this.texel = (extent * 2) / this.mapSize;
    // Flat ground across the box spans this much depth in the light's view,
    // more the lower the sun; the tallest caster adds its height on top.
    this.depth = extent / Math.tan(this.elevation) + CEILING + 60;
    const cam = this.sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = this.depth * 2;
    cam.updateProjectionMatrix();
  }
}
