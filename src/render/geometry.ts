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

  /** Add one triangle with a flat normal. Winding is counter-clockwise seen from the front. */
  tri(a: THREE.Vector3Like, b: THREE.Vector3Like, c: THREE.Vector3Like, hex: number): this {
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

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}
