import * as THREE from 'three';
import { mulberry32 } from '../util.js';
import { MeshBuilder, mergeGeometries } from './geometry.js';
import { applyCutaway, flatMaterial, towerMaterial } from './materials.js';
/** Side of a scenery chunk, metres. */
const CHUNK = 160;
/**
 * Everything around the road, instanced and chunked.
 *
 * One `InstancedMesh` per kind of thing per 160 m square, not one per kind
 * for the whole track. A single track-wide InstancedMesh has a bounding sphere
 * the size of the city, so it is never frustum-culled and every tower is drawn
 * every frame; chunked, only the handful of squares near the camera are.
 */
export class Scenery {
    group = new THREE.Group();
    /** Tall things the cut-away applies to, for the occlusion probe. */
    towers = [];
    constructor(track, theme) {
        this.group.name = 'scenery';
        const rand = mulberry32(track.def.seed ^ 0x5eed);
        // --- Towers, with setback tiers and rooftop clutter. ---
        const towerGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
        const towerMat = towerMaterial({ roof: theme.roof, warm: theme.windowWarm, cool: theme.windowCool, lit: theme.windowsLit });
        applyCutaway(towerMat);
        const roofBits = [];
        for (const p of track.props) {
            if (p.kind !== 'tower')
                continue;
            const colour = theme.towerPalette[Math.floor(p.seed * theme.towerPalette.length)];
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
        const barriers = [];
        const w = track.walls;
        for (let k = 0; k < track.wallCount; k++) {
            const o = k * 6;
            const ax = w[o], az = w[o + 1], bx = w[o + 2], bz = w[o + 3], nx = w[o + 4], nz = w[o + 5];
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
        const lamps = track.props.filter((p) => p.kind === 'lamp');
        const poleGeo = new MeshBuilder()
            .box(0, 3.5, 0, 0.22, 7, 0.22, 0x2e3038, { skipBottom: true })
            .box(0, 6.95, 1.1, 0.14, 0.12, 2.4, 0x2e3038)
            .build();
        const poleMat = flatMaterial();
        applyCutaway(poleMat);
        this.add('lamp-poles', poleGeo, poleMat, lamps.map((p) => ({ x: p.x, z: p.z, rot: p.rot, sx: 1, sy: 1, sz: 1, colour: 0xffffff })), { cast: true });
        const headGeo = new MeshBuilder().box(0, 6.82, 2.15, 0.45, 0.14, 0.7, 0xffffff).build();
        const headMat = new THREE.MeshBasicMaterial({ color: 0xffe2a8, fog: true });
        applyCutaway(headMat);
        this.add('lamp-heads', headGeo, headMat, lamps.map((p) => ({ x: p.x, z: p.z, rot: p.rot, sx: 1, sy: 1, sz: 1, colour: 0xffffff })), {});
        this.trees(track, theme);
        this.containers(track, theme);
        this.cranes(track, theme);
    }
    /**
     * Trees: a trunk and a two-tier crown of low-poly cones. Crowns are the
     * tall things of the park, so they take the cut-away like buildings do and
     * join the occluder list the pixel test probes.
     */
    trees(track, theme) {
        const trees = track.props.filter((p) => p.kind === 'tree');
        if (!trees.length)
            return;
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
            colour: theme.foliage[Math.floor(p.seed * theme.foliage.length)],
        }));
        this.towers.push(...crowns);
        this.add('tree-crowns', crownGeo, crownMat, crowns, { cast: true, receive: true });
    }
    /** Containers: one box each, the top a shade lighter, stacked in their lot. */
    containers(track, theme) {
        const boxes = track.props.filter((p) => p.kind === 'container');
        if (!boxes.length)
            return;
        const geo = new MeshBuilder()
            .box(0, 0.5, 0, 1, 1, 1, 0xffffff, { skipBottom: true, sides: 0xc4c4c4 })
            // Corrugation: a darker band round the middle reads as ribbing from above.
            .box(0, 0.5, 0, 1.02, 0.12, 0.98, 0x9a9a9a, { skipBottom: true })
            .build();
        const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
        applyCutaway(mat);
        const items = boxes.map((p) => ({
            x: p.x, y: p.y ?? 0, z: p.z, rot: p.rot, sx: p.w, sy: p.h, sz: p.d,
            colour: theme.containers[Math.floor(p.seed * theme.containers.length)],
        }));
        this.towers.push(...items);
        this.add('containers', geo, mat, items, { cast: true, receive: true });
    }
    /** Dockside cranes: four legs, a portal beam, and a boom out over the water. */
    cranes(track, theme) {
        const cranes = track.props.filter((p) => p.kind === 'crane');
        if (!cranes.length)
            return;
        const c = theme.crane;
        const b = new MeshBuilder();
        for (const [lx, lz] of [[-6, -4], [6, -4], [-6, 4], [6, 4]])
            b.box(lx, 12, lz, 0.9, 24, 0.9, c, { skipBottom: true });
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
    /** Split instances into chunks and build one InstancedMesh per chunk. */
    add(name, geometry, material, items, opts) {
        const chunks = new Map();
        for (const it of items) {
            const key = `${Math.floor(it.x / CHUNK)},${Math.floor(it.z / CHUNK)}`;
            let list = chunks.get(key);
            if (!list)
                chunks.set(key, (list = []));
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
                if (seeds)
                    seeds[i] = it.seed ?? 0;
            });
            if (seeds)
                geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
            mesh.castShadow = opts.cast ?? false;
            mesh.receiveShadow = opts.receive ?? false;
            mesh.computeBoundingSphere();
            this.group.add(mesh);
        }
    }
}
//# sourceMappingURL=Scenery.js.map