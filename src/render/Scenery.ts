import * as THREE from 'three';
import type { Prop, Track } from '../sim/track/buildTrack.js';
import { mulberry32 } from '../util.js';
import { MeshBuilder, mergeGeometries } from './geometry.js';
import { applyCutaway, flatMaterial, towerMaterial } from './materials.js';
import { fenceModel, fieldModel, flowerBedModel, model, pondModel, sailsModel, warehouseModel } from './props.js';
import type { Theme } from './themes.js';

/** Side of a scenery chunk, metres. */
const CHUNK = 160;

export interface Instance {
  x: number;
  y?: number;
  z: number;
  rot: number;
  sx: number;
  sy: number;
  sz: number;
  colour: number;
  seed?: number;
}

/**
 * Everything around the road, instanced and chunked.
 *
 * One `InstancedMesh` per kind of thing per 160 m square, not one per kind
 * for the whole track. A single track-wide InstancedMesh has a bounding sphere
 * the size of the city, so it is never frustum-culled and every tower is drawn
 * every frame; chunked, only the handful of squares near the camera are.
 */
export class Scenery {
  readonly group = new THREE.Group();
  /** Tall things the cut-away applies to, for the occlusion probe. */
  readonly towers: Instance[] = [];

  /** The windmills' sails (M10), turned every frame. */
  private sails: THREE.InstancedMesh | null = null;
  private readonly hubs: { x: number; z: number; yaw: number; phase: number; speed: number }[] = [];

  /**
   * @param detail how much small clutter to draw (M10): 2 all of it, 1 every
   *   other piece, 0 none (the animals, bales, flowers, crates and drums).
   */
  constructor(track: Track, theme: Theme, detail = 2) {
    this.group.name = 'scenery';
    const rand = mulberry32(track.def.seed ^ 0x5eed);

    // --- Towers, with setback tiers and rooftop clutter. ---
    const towerGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const towerMat = towerMaterial({
      roof: theme.roof, warm: theme.windowWarm, cool: theme.windowCool, lit: theme.windowsLit, glass: theme.windowGlass, glassMix: theme.glassMix,
    });
    applyCutaway(towerMat);
    const roofBits: Instance[] = [];
    for (const p of track.props) {
      if (p.kind !== 'tower') continue;
      const colour = theme.towerPalette[Math.floor(p.seed * theme.towerPalette.length)]!;
      this.towers.push({ x: p.x, z: p.z, rot: p.rot, sx: p.w, sy: p.h, sz: p.d, colour, seed: p.seed });
      if (p.h > 24 && rand() < 0.6) {
        const tier = 0.3 + rand() * 0.25;
        this.towers.push({
          x: p.x, y: p.h, z: p.z, rot: p.rot, sx: p.w * 0.62, sy: p.h * tier, sz: p.d * 0.62, colour, seed: (p.seed * 7.3) % 1,
        });
      }
      const bits = Math.floor(rand() * 3);
      for (let b = 0; b < bits; b++) {
        roofBits.push({
          x: p.x + (rand() - 0.5) * p.w * 0.5, y: p.h, z: p.z + (rand() - 0.5) * p.d * 0.5,
          rot: 0, sx: 1.5 + rand() * 2, sy: 1 + rand() * 1.8, sz: 1.5 + rand() * 2, colour: 0x8a8d99,
        });
      }
    }
    this.add('towers', towerGeo, towerMat, this.towers, { cast: true, receive: true, seeded: true });
    const bitMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    applyCutaway(bitMat);
    this.add('roof-bits', towerGeo, bitMat, roofBits, { cast: true, receive: true });

    // --- Barriers along every wall segment. ---
    const barriers: Instance[] = [];
    const w = track.walls;
    for (let k = 0; k < track.wallCount; k++) {
      const o = k * 6;
      const ax = w[o]!, az = w[o + 1]!, bx = w[o + 2]!, bz = w[o + 3]!, nx = w[o + 4]!, nz = w[o + 5]!;
      const len = Math.hypot(bx - ax, bz - az);
      barriers.push({
        x: (ax + bx) / 2 - nx * 0.3, z: (az + bz) / 2 - nz * 0.3,
        rot: Math.atan2(bx - ax, bz - az),
        sx: 0.6, sy: 0.9, sz: len + 0.05,
        colour: Math.floor(k / 3) % 4 === 0 ? theme.barrierB : theme.barrierA,
      });
    }
    const barrierGeo = new MeshBuilder()
      .box(0, 0.45, 0, 1, 0.9, 1, 0xffffff, { insetX: 0.25, skipBottom: true })
      .build();
    this.add('barriers', barrierGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), barriers, { cast: true, receive: true });

    // --- Lamp posts: a pole with an arm, and a glowing head. ---
    const lamps = track.props.filter((p): p is Prop => p.kind === 'lamp');
    const poleGeo = new MeshBuilder()
      .box(0, 3.5, 0, 0.22, 7, 0.22, 0x2e3038, { skipBottom: true })
      .box(0, 6.95, 1.1, 0.14, 0.12, 2.4, 0x2e3038)
      .build();
    const poleMat = flatMaterial();
    applyCutaway(poleMat);
    this.add('lamp-poles', poleGeo, poleMat, lamps.map((p) => ({ x: p.x, z: p.z, rot: p.rot, sx: 1, sy: 1, sz: 1, colour: 0xffffff })), { cast: true });
    const headGeo = new MeshBuilder().box(0, 6.82, 2.15, 0.45, 0.14, 0.7, 0xffffff).build();
    // Glowing at dusk; by day just a grey lamp housing.
    const headMat = theme.lampsLit === false
      ? new THREE.MeshLambertMaterial({ color: 0x9a9ca4 })
      : new THREE.MeshBasicMaterial({ color: 0xffe2a8, fog: true });
    applyCutaway(headMat);
    this.add('lamp-heads', headGeo, headMat, lamps.map((p) => ({ x: p.x, z: p.z, rot: p.rot, sx: 1, sy: 1, sz: 1, colour: 0xffffff })), {});

    this.trees(track, theme);
    this.containers(track, theme);
    this.cranes(track, theme);
    this.countryside(track, theme, detail);
  }

  /** Turn the windmills' sails: `time` in seconds, any clock. */
  update(time: number): void {
    if (!this.sails) return;
    const m = new THREE.Matrix4();
    // Tilted well back — a real windshaft tilts a little, these a lot — so
    // from a camera looking down the turning cross shows, not an edge.
    const tilt = new THREE.Matrix4().makeRotationX(-0.95);
    const spin = new THREE.Matrix4();
    this.hubs.forEach((h, i) => {
      m.makeRotationY(h.yaw).setPosition(h.x + Math.sin(h.yaw) * 3.4, 15, h.z + Math.cos(h.yaw) * 3.4);
      m.multiply(tilt).multiply(spin.makeRotationZ(time * h.speed + h.phase));
      this.sails!.setMatrixAt(i, m);
    });
    this.sails.instanceMatrix.needsUpdate = true;
  }

  /**
   * The M10 scenery: farm and port. Static, so it is baked — every piece in
   * a 160 m square merged into one mesh per material — rather than
   * instanced: a dozen new kinds of thing cost two or three draw calls per
   * square, not a dozen. Only the sails move, and they are instanced.
   */
  private countryside(track: Track, theme: Theme, detail: number): void {
    const solid = new Baker();
    const ground = new Baker();
    const water = new Baker();
    const small = new Set(['cow', 'sheep', 'bale', 'bales', 'pallets', 'crates', 'drums', 'reeds', 'flowers']);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const place = (x: number, z: number, rot: number, sx = 1, sy = 1, sz = 1, y = 0): THREE.Matrix4 =>
      m.compose(new THREE.Vector3(x, y, z), q.setFromAxisAngle(up, rot), new THREE.Vector3(sx, sy, sz));
    const pick = (seed: number, n: number): number => Math.min(n - 1, Math.floor(seed * n));
    const tall = (p: Prop, colour: number): void => {
      this.towers.push({ x: p.x, z: p.z, rot: p.rot, sx: p.w, sy: p.h, sz: p.d, colour });
    };
    let smallIndex = 0;
    for (const p of track.props) {
      if (small.has(p.kind)) {
        smallIndex++;
        if (detail <= 0 || (detail === 1 && smallIndex % 2 === 0)) continue;
      }
      const at = place(p.x, p.z, p.rot);
      switch (p.kind) {
        case 'farmhouse': solid.add(model('farmhouse', pick(p.seed, 3)), at); tall(p, 0xefe6d2); break;
        case 'barn': solid.add(model('barn', pick(p.seed, 3)), at); tall(p, 0xa8322a); break;
        case 'silo': solid.add(model('silo', pick(p.seed, 3)), at); tall(p, 0xc8ccd0); break;
        case 'bale': solid.add(model('bale', pick(p.seed, 3)), at); break;
        case 'bales': solid.add(model('bales', pick(p.seed, 2)), at); break;
        case 'tractor': solid.add(model('tractor', pick(p.seed, 3)), at); break;
        case 'combine': solid.add(model('combine', pick(p.seed, 2)), at); tall(p, 0x3f8a3a); break;
        case 'cow': solid.add(model('cow', pick((p.seed % 0.5) * 2, 3) + (p.seed >= 0.5 ? 3 : 0)), at); break;
        case 'sheep': solid.add(model('sheep', p.seed >= 0.5 ? 1 : 0), at); break;
        case 'windmill':
          solid.add(model('windmill'), at);
          tall(p, 0xeee8da);
          this.hubs.push({ x: p.x, z: p.z, yaw: p.rot, phase: p.seed * 6.28, speed: 0.5 + p.seed * 0.4 });
          break;
        case 'field': {
          const f = fieldModel(p.w, p.d, pick(p.seed, 4));
          ground.add(f.ground, at);
          if (f.standing) solid.add(f.standing, at);
          break;
        }
        case 'fence': solid.add(fenceModel(p.w, p.d), at); break;
        case 'flowers': {
          const f = flowerBedModel(p.d, p.seed);
          ground.add(f.ground, at);
          solid.add(f.standing, at);
          break;
        }
        case 'pond': {
          const f = pondModel(p.w);
          ground.add(f.bank, at);
          water.add(f.water, at);
          break;
        }
        case 'reeds': solid.add(model('reeds', pick(p.seed, 4)), at); break;
        case 'warehouse': solid.add(warehouseModel(p.w, p.d, p.h, pick(p.seed, 5)), at); tall(p, 0x8a9aa8); break;
        case 'forklift': solid.add(model('forklift', pick(p.seed, 3)), at); break;
        case 'flatbed': solid.add(model('flatbed', pick(p.seed, 12)), at); break;
        case 'pallets': solid.add(model('pallets', pick(p.seed, 4)), at); break;
        case 'crates': solid.add(model('crates', pick(p.seed, 6)), at); break;
        case 'drums': solid.add(model('drums', pick(p.seed, 30)), at); break;
        case 'ship': solid.add(model('ship', pick(p.seed, 12)), at); tall(p, 0x2a3a5a); break;
        case 'yacht': solid.add(model('yacht', pick(p.seed, 8)), at); break;
        case 'pontoon': solid.add(model('pontoon'), place(p.x, p.z, p.rot, p.w / 2, 1, p.d)); break;
        default: break;
      }
    }
    const solidMat = flatMaterial();
    applyCutaway(solidMat);
    solid.build('props', solidMat, this.group, { cast: true, receive: true });
    // Laid flat on the ground: pulled towards the camera in depth so the grass never shows through.
    const groundMat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    ground.build('ground-patches', groundMat, this.group, { receive: true });
    const waterMat = new THREE.MeshPhongMaterial({ color: theme.water, shininess: 25, specular: 0x2a3a4a, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    water.build('ponds', waterMat, this.group, { receive: true });

    if (this.hubs.length) {
      const mat = flatMaterial();
      applyCutaway(mat);
      this.sails = new THREE.InstancedMesh(sailsModel(), mat, this.hubs.length);
      this.sails.name = 'windmill-sails';
      this.sails.castShadow = true;
      this.sails.frustumCulled = false;
      this.update(0);
      this.group.add(this.sails);
    }
  }

  /**
   * Trees: a trunk and a two-tier crown of low-poly cones. Crowns are the
   * tall things of the park, so they take the cut-away like buildings do and
   * join the occluder list the pixel test probes.
   */
  private trees(track: Track, theme: Theme): void {
    const trees = track.props.filter((p) => p.kind === 'tree');
    if (!trees.length) return;
    const trunkGeo = new MeshBuilder().box(0, 0.5, 0, 1, 1, 1, 0xffffff, { skipBottom: true }).build();
    const trunkMat = flatMaterial();
    applyCutaway(trunkMat);
    this.add('tree-trunks', trunkGeo, trunkMat, trees.map((p) => ({
      x: p.x, z: p.z, rot: p.rot, sx: 0.5, sy: p.h * 0.35, sz: 0.5, colour: theme.trunk,
    })), { cast: true });
    const crown = new THREE.ConeGeometry(0.5, 1, 7).translate(0, 0.5, 0);
    const upper = new THREE.ConeGeometry(0.36, 0.7, 7).translate(0, 0.95, 0);
    const crownGeo = mergeGeometries(crown, upper);
    const crownMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    applyCutaway(crownMat);
    const crowns = trees.map((p) => ({
      x: p.x, y: p.h * 0.25, z: p.z, rot: p.rot, sx: p.w, sy: p.h * 0.8, sz: p.w,
      colour: theme.foliage[Math.floor(p.seed * theme.foliage.length)]!,
    }));
    this.towers.push(...crowns);
    this.add('tree-crowns', crownGeo, crownMat, crowns, { cast: true, receive: true });
  }

  /** Containers: one box each, the top a shade lighter, stacked in their lot. */
  private containers(track: Track, theme: Theme): void {
    const boxes = track.props.filter((p) => p.kind === 'container');
    if (!boxes.length) return;
    const geo = new MeshBuilder()
      .box(0, 0.5, 0, 1, 1, 1, 0xffffff, { skipBottom: true, sides: 0xc4c4c4 })
      // Corrugation: a darker band round the middle reads as ribbing from above.
      .box(0, 0.5, 0, 1.02, 0.12, 0.98, 0x9a9a9a, { skipBottom: true })
      .build();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    applyCutaway(mat);
    const items = boxes.map((p) => ({
      x: p.x, y: p.y ?? 0, z: p.z, rot: p.rot, sx: p.w, sy: p.h, sz: p.d,
      colour: theme.containers[Math.floor(p.seed * theme.containers.length)]!,
    }));
    this.towers.push(...items);
    this.add('containers', geo, mat, items, { cast: true, receive: true });
  }

  /** Dockside cranes: four legs, a portal beam, and a boom out over the water. */
  private cranes(track: Track, theme: Theme): void {
    const cranes = track.props.filter((p) => p.kind === 'crane');
    if (!cranes.length) return;
    const c = theme.crane;
    const b = new MeshBuilder();
    for (const [lx, lz] of [[-6, -4], [6, -4], [-6, 4], [6, 4]] as const) b.box(lx, 12, lz, 0.9, 24, 0.9, c, { skipBottom: true });
    b.box(0, 24.5, -4, 13, 1.4, 1, c).box(0, 24.5, 4, 13, 1.4, 1, c);
    b.box(0, 27, 0, 3, 4, 9, c);
    // The boom, reaching out over the water (-Z in the crane's frame).
    b.box(0, 30, -22, 1.6, 1.6, 44, c).box(0, 25.5, 6, 4, 3, 6, 0x4a4e56);
    const mat = flatMaterial();
    applyCutaway(mat);
    const items = cranes.map((p) => ({ x: p.x, z: p.z, rot: p.rot, sx: 1, sy: 1, sz: 1, colour: 0xffffff }));
    this.towers.push(...cranes.map((p) => ({ x: p.x, z: p.z, rot: p.rot, sx: 13, sy: 32, sz: 9, colour: c })));
    this.add('cranes', b.build(), mat, items, { cast: true });
  }

  /** Split instances into chunks and build one InstancedMesh per chunk. */
  private add(
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    items: readonly Instance[],
    opts: { cast?: boolean; receive?: boolean; seeded?: boolean },
  ): void {
    const chunks = new Map<string, Instance[]>();
    for (const it of items) {
      const key = `${Math.floor(it.x / CHUNK)},${Math.floor(it.z / CHUNK)}`;
      let list = chunks.get(key);
      if (!list) chunks.set(key, (list = []));
      list.push(it);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const colour = new THREE.Color();
    for (const [key, list] of chunks) {
      // Per-instance attributes live on the geometry, so a seeded kind needs
      // its own copy per chunk. The base geometry is a dozen triangles.
      const geo = opts.seeded ? geometry.clone() : geometry;
      const mesh = new THREE.InstancedMesh(geo, material, list.length);
      mesh.name = `${name}:${key}`;
      const seeds = opts.seeded ? new Float32Array(list.length) : null;
      list.forEach((it, i) => {
        q.setFromAxisAngle(up, it.rot);
        m.compose(pos.set(it.x, it.y ?? 0, it.z), q, scale.set(it.sx, it.sy, it.sz));
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, colour.setHex(it.colour));
        if (seeds) seeds[i] = it.seed ?? 0;
      });
      if (seeds) geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
      mesh.castShadow = opts.cast ?? false;
      mesh.receiveShadow = opts.receive ?? false;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }
  }
}

/**
 * Static scenery merged per chunk: add a model with its placement, and
 * `build` makes one mesh per 160 m square holding everything added in it.
 */
class Baker {
  private readonly chunks = new Map<string, { geo: THREE.BufferGeometry; m: THREE.Matrix4 }[]>();

  add(geo: THREE.BufferGeometry, m: THREE.Matrix4): void {
    const key = `${Math.floor(m.elements[12]! / CHUNK)},${Math.floor(m.elements[14]! / CHUNK)}`;
    let list = this.chunks.get(key);
    if (!list) this.chunks.set(key, (list = []));
    list.push({ geo, m: m.clone() });
  }

  build(name: string, material: THREE.Material, into: THREE.Group, opts: { cast?: boolean; receive?: boolean }): void {
    const v = new THREE.Vector3();
    const nm = new THREE.Matrix3();
    for (const [key, list] of this.chunks) {
      let count = 0;
      for (const { geo } of list) count += geo.getAttribute('position').count;
      const pos = new Float32Array(count * 3);
      const nrm = new Float32Array(count * 3);
      const col = new Float32Array(count * 3);
      let o = 0;
      for (const { geo, m } of list) {
        const p = geo.getAttribute('position');
        const n = geo.getAttribute('normal');
        const c = geo.getAttribute('color');
        nm.getNormalMatrix(m);
        for (let i = 0; i < p.count; i++, o += 3) {
          v.fromBufferAttribute(p, i).applyMatrix4(m);
          pos[o] = v.x; pos[o + 1] = v.y; pos[o + 2] = v.z;
          v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
          nrm[o] = v.x; nrm[o + 1] = v.y; nrm[o + 2] = v.z;
          if (c) {
            col[o] = c.getX(i); col[o + 1] = c.getY(i); col[o + 2] = c.getZ(i);
          } else {
            col[o] = col[o + 1] = col[o + 2] = 1;
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, material);
      mesh.name = `${name}:${key}`;
      mesh.castShadow = opts.cast ?? false;
      mesh.receiveShadow = opts.receive ?? false;
      into.add(mesh);
    }
  }
}
