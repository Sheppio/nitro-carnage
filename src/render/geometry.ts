import * as THREE from 'three';

/**
 * A little builder for flat-shaded, vertex-coloured, non-indexed geometry.
 *
 * Every mesh in the game is generated in code, and nearly all of it is boxes,
 * wedges and ribbons with hard edges. Non-indexed triangles give each face its
 * own normals and colour for free, which is exactly the low-poly look, and
 * merging parts into one buffer means one draw call per object rather than
 * one per part.
 */
export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  private colour = new THREE.Color();
  /** The current placement, for building a part in its own frame (`at`). */
  private frame: THREE.Matrix4 | null = null;
  private readonly va = new THREE.Vector3();
  private readonly vb = new THREE.Vector3();
  private readonly vc = new THREE.Vector3();

  /**
   * Build a part in a frame of its own: moved to (x, y, z), turned `yaw`
   * about the vertical, then `roll` about its own Z (a wheel lies on its
   * side with roll = π/2). Frames nest.
   */
  at(x: number, y: number, z: number, yaw: number, roll: number, fn: (b: this) => void): this {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, roll, 'YXZ')),
      new THREE.Vector3(1, 1, 1),
    );
    const outer = this.frame;
    this.frame = outer ? outer.clone().multiply(m) : m;
    fn(this);
    this.frame = outer;
    return this;
  }

  /** Add one triangle with a flat normal. Winding is counter-clockwise seen from the front. */
  tri(a: THREE.Vector3Like, b: THREE.Vector3Like, c: THREE.Vector3Like, hex: number): this {
    if (this.frame) {
      a = this.va.copy(a).applyMatrix4(this.frame);
      b = this.vb.copy(b).applyMatrix4(this.frame);
      c = this.vc.copy(c).applyMatrix4(this.frame);
    }
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    this.colour.setHex(hex);
    for (const p of [a, b, c]) {
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(nx, ny, nz);
      this.col.push(this.colour.r, this.colour.g, this.colour.b);
    }
    return this;
  }

  /** A quad a-b-c-d, counter-clockwise from the front. */
  quad(a: THREE.Vector3Like, b: THREE.Vector3Like, c: THREE.Vector3Like, d: THREE.Vector3Like, hex: number): this {
    return this.tri(a, b, c, hex).tri(a, c, d, hex);
  }

  /**
   * An axis-aligned box centred at (cx, cy, cz). `inset` pulls the top face in
   * on X and Z, which turns a box into a cabin or a bonnet. `skipBottom` drops
   * the face nobody can see from a top-down camera.
   */
  box(
    cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, hex: number,
    opts: { insetX?: number; insetZFront?: number; insetZBack?: number; skipBottom?: boolean; top?: number; sides?: number } = {},
  ): this {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const ix = opts.insetX ?? 0;
    const izf = opts.insetZFront ?? 0;
    const izb = opts.insetZBack ?? 0;
    const v = (x: number, y: number, z: number) => ({ x: cx + x, y: cy + y, z: cz + z });
    // Bottom corners.
    const b0 = v(-hx, -hy, -hz), b1 = v(hx, -hy, -hz), b2 = v(hx, -hy, hz), b3 = v(-hx, -hy, hz);
    // Top corners, inset.
    const t0 = v(-hx + ix, hy, -hz + izb), t1 = v(hx - ix, hy, -hz + izb), t2 = v(hx - ix, hy, hz - izf), t3 = v(-hx + ix, hy, hz - izf);
    const top = opts.top ?? hex;
    const sides = opts.sides ?? hex;
    this.quad(t0, t3, t2, t1, top);
    this.quad(b3, b2, t2, t3, sides); // +Z face
    this.quad(b1, b0, t0, t1, sides); // -Z face
    this.quad(b2, b1, t1, t2, sides); // +X face
    this.quad(b0, b3, t3, t0, sides); // -X face
    if (!opts.skipBottom) this.quad(b0, b1, b2, b3, hex);
    return this;
  }

  /**
   * A vertical frustum: radius r0 at the bottom, r1 at the top, centred at
   * (cx, cy, cz), with `sides` flat faces. r1 = 0 makes a cone. Laid on its
   * side inside `at(…, roll = π/2)` it is a wheel, a bale or a drum.
   */
  cylinder(
    cx: number, cy: number, cz: number, r0: number, r1: number, h: number, sides: number, hex: number,
    opts: { top?: number; skipBottom?: boolean } = {},
  ): this {
    const y0 = cy - h / 2, y1 = cy + h / 2;
    const top = opts.top ?? hex;
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const b0 = { x: cx + c0 * r0, y: y0, z: cz + s0 * r0 }, b1 = { x: cx + c1 * r0, y: y0, z: cz + s1 * r0 };
      const t0 = { x: cx + c0 * r1, y: y1, z: cz + s0 * r1 }, t1 = { x: cx + c1 * r1, y: y1, z: cz + s1 * r1 };
      if (r1 > 0) this.quad(b1, b0, t0, t1, hex);
      else this.tri(b1, b0, t0, hex);
      if (r1 > 0) this.tri({ x: cx, y: y1, z: cz }, t1, t0, top);
      if (!opts.skipBottom) this.tri({ x: cx, y: y0, z: cz }, b0, b1, hex);
    }
    return this;
  }

  /**
   * A convex outline (x, z pairs, counter-clockwise as seen on screen from
   * above, with +Z down the screen: the order `box` uses for its top)
   * extruded from y0 to y1: hulls with a pointed bow, gables, anything boxy
   * that is not a box.
   */
  prism(outline: readonly (readonly [number, number])[], y0: number, y1: number, hex: number, opts: { top?: number } = {}): this {
    const n = outline.length;
    const top = opts.top ?? hex;
    for (let i = 0; i < n; i++) {
      const [ax, az] = outline[i]!;
      const [bx, bz] = outline[(i + 1) % n]!;
      this.quad({ x: ax, y: y0, z: az }, { x: bx, y: y0, z: bz }, { x: bx, y: y1, z: bz }, { x: ax, y: y1, z: az }, hex);
    }
    const [ox, oz] = outline[0]!;
    for (let i = 1; i < n - 1; i++) {
      const [ax, az] = outline[i]!;
      const [bx, bz] = outline[i + 1]!;
      this.tri({ x: ox, y: y1, z: oz }, { x: ax, y: y1, z: az }, { x: bx, y: y1, z: bz }, top);
    }
    return this;
  }

  /** Triangles so far. */
  get triangles(): number {
    return this.pos.length / 9;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Merge a few non-indexed-able geometries (position and normal only) into one,
 * for instancing a compound shape as a single mesh.
 */
export function mergeGeometries(...parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  for (const part of parts) {
    const g = part.index ? part.toNonIndexed() : part;
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nrm.push(...(g.getAttribute('normal').array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.computeBoundingSphere();
  return out;
}
