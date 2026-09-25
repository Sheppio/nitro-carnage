import * as THREE from 'three';
import { MeshBuilder } from './geometry.js';
import { flatMaterial } from './materials.js';
import { Surface } from '../sim/surfaces.js';
const KERB = 0.8;
const Y_ROAD = 0.02;
const Y_MARK = 0.04;
/**
 * The road surface, built straight from the centreline table: asphalt,
 * red-and-white kerbs, pavement out to the wall, lane markings and the start
 * grid. One draw call for the surface and one for the markings.
 *
 * The asphalt is faintly banded every few metres. At 70 m up a perfectly
 * uniform road gives the eye nothing to measure speed against, and a car doing
 * 45 m/s looks parked.
 */
export function buildTrackMesh(track, theme) {
    const group = new THREE.Group();
    group.name = 'track';
    const n = track.n;
    const hw = track.halfWidth;
    const wo = track.wallOffset;
    const road = new MeshBuilder();
    const at = (i, d, y) => {
        const [x, z] = track.offsetPoint(i % n, d);
        return { x, y, z };
    };
    const shade = (hex, f) => new THREE.Color(hex).multiplyScalar(f).getHex();
    const roadA = theme.road;
    const roadB = shade(theme.road, 0.93);
    const spacing = track.length / n;
    // Gravel spans colour the road itself; a grass verge is grass, not pavement.
    const dirtAt = (i) => track.def.surfaces.some((z) => {
        if (z.shape !== 'span' || z.surface !== Surface.Dirt)
            return false;
        const s0 = z.from * track.length, s1 = z.to * track.length, s = i * spacing;
        return s0 <= s1 ? s >= s0 && s <= s1 : s >= s0 || s <= s1;
    });
    const verge = track.def.verge.surface === Surface.Grass ? theme.grass : theme.pavement;
    for (let i = 0; i < n; i++) {
        const j = i + 1;
        const dirt = dirtAt(i);
        const band = dirt ? shade(theme.dirt, Math.floor(i / 4) % 2 === 0 ? 1 : 0.92) : Math.floor(i / 4) % 2 === 0 ? roadA : roadB;
        // Left of travel is +d. Quads wind counter-clockwise seen from above:
        // from the right edge to the left edge, then forward.
        road.quad(at(i, -hw, Y_ROAD), at(j, -hw, Y_ROAD), at(j, hw, Y_ROAD), at(i, hw, Y_ROAD), band);
        const kerb = Math.floor(i / 3) % 2 === 0 ? theme.kerbA : theme.kerbB;
        road.quad(at(i, hw, Y_ROAD), at(j, hw, Y_ROAD), at(j, hw + KERB, Y_ROAD), at(i, hw + KERB, Y_ROAD), kerb);
        road.quad(at(i, -hw - KERB, Y_ROAD), at(j, -hw - KERB, Y_ROAD), at(j, -hw, Y_ROAD), at(i, -hw, Y_ROAD), kerb);
        road.quad(at(i, hw + KERB, Y_ROAD), at(j, hw + KERB, Y_ROAD), at(j, wo, Y_ROAD), at(i, wo, Y_ROAD), verge);
        road.quad(at(i, -wo, Y_ROAD), at(j, -wo, Y_ROAD), at(j, -hw - KERB, Y_ROAD), at(i, -hw - KERB, Y_ROAD), verge);
    }
    const surface = new THREE.Mesh(road.build(), flatMaterial());
    surface.receiveShadow = true;
    surface.name = 'road';
    group.add(surface);
    // Markings: a dashed centre line, solid edge lines, and a chequered start.
    const marks = new MeshBuilder();
    const strip = (i0, i1, d0, d1, hex) => marks.quad(at(i0, d0, Y_MARK), at(i1, d0, Y_MARK), at(i1, d1, Y_MARK), at(i0, d1, Y_MARK), hex);
    // The lines stop at the chequers (segments n-1 and 0): drawn at the same
    // height, they would fight the checks for the same pixels and show through.
    const onChecks = (i) => i === 0 || i === n - 1;
    for (let i = 0; i < n; i += 8)
        if (!dirtAt(i))
            strip(i === 0 ? 1 : i, i + 4, -0.15, 0.15, theme.line);
    for (let i = 0; i < n; i++) {
        if (dirtAt(i) || onChecks(i))
            continue;
        strip(i, i + 1, hw - 0.5, hw - 0.3, theme.line);
        strip(i, i + 1, -hw + 0.3, -hw + 0.5, theme.line);
    }
    // Start line: two rows of checks across the road at s = 0.
    const checks = 8;
    const cw = (hw * 2) / checks;
    for (let row = 0; row < 2; row++) {
        for (let c = 0; c < checks; c++) {
            const hex = (row + c) % 2 === 0 ? 0xf5f5f5 : 0x1a1a1a;
            const d0 = -hw + c * cw;
            strip(n - 1 + row, n + row, d0, d0 + cw, hex);
        }
    }
    // Grid boxes behind the line.
    for (let slot = 0; slot < 6; slot++) {
        const p = track.gridSlot(slot);
        const proj = track.project(p.x, p.z);
        const i = proj.i;
        const d = proj.d;
        strip(i + 2, i + 3, d - 1.2, d + 1.2, theme.line);
        strip(i - 3, i + 3, d - 1.3, d - 1.1, theme.line);
        strip(i - 3, i + 3, d + 1.1, d + 1.3, theme.line);
    }
    const markMesh = new THREE.Mesh(marks.build(), flatMaterial());
    markMesh.receiveShadow = true;
    markMesh.name = 'markings';
    group.add(markMesh);
    // Ramps: a wedge rising along the direction of travel, then a drop.
    const ramps = new MeshBuilder();
    for (const r of track.ramps) {
        const i0 = Math.floor(track.wrapS(r.s0) / spacing);
        const steps = Math.max(2, Math.round((r.s1 - r.s0) / spacing));
        for (let k = 0; k < steps; k++) {
            const y0 = Y_ROAD + (r.lift * k) / steps;
            const y1 = Y_ROAD + (r.lift * (k + 1)) / steps;
            const hex = Math.floor(k / 2) % 2 === 0 ? 0xf0b429 : 0x26262c;
            ramps.quad(at(i0 + k, -hw, y0), at(i0 + k + 1, -hw, y1), at(i0 + k + 1, hw, y1), at(i0 + k, hw, y0), hex);
            // Side skirts.
            ramps.quad(at(i0 + k, hw, 0), at(i0 + k, hw, y0), at(i0 + k + 1, hw, y1), at(i0 + k + 1, hw, 0), 0x3a3a40);
            ramps.quad(at(i0 + k + 1, -hw, 0), at(i0 + k + 1, -hw, y1), at(i0 + k, -hw, y0), at(i0 + k, -hw, 0), 0x3a3a40);
        }
        const end = i0 + steps;
        ramps.quad(at(end, hw, 0), at(end, hw, r.lift + Y_ROAD), at(end, -hw, r.lift + Y_ROAD), at(end, -hw, 0), 0x3a3a40);
    }
    if (track.ramps.length) {
        const rampMesh = new THREE.Mesh(ramps.build(), flatMaterial());
        rampMesh.castShadow = true;
        rampMesh.receiveShadow = true;
        rampMesh.name = 'ramps';
        group.add(rampMesh);
    }
    // Oil: dark, faintly iridescent pools on the road.
    const oils = track.def.surfaces.filter((z) => z.shape === 'circle' && z.surface === Surface.Oil);
    if (oils.length) {
        const ob = new MeshBuilder();
        for (const z of oils) {
            if (z.shape !== 'circle')
                continue;
            const [cx, cz] = z.at;
            const k = 14;
            for (let a = 0; a < k; a++) {
                // A wobbly blob, not a perfect disc.
                const r0 = z.r * (0.8 + 0.2 * Math.sin(a * 2.3 + cx));
                const r1 = z.r * (0.8 + 0.2 * Math.sin((a + 1) * 2.3 + cx));
                const a0 = (a / k) * Math.PI * 2, a1 = ((a + 1) / k) * Math.PI * 2;
                ob.tri({ x: cx, y: Y_MARK + 0.01, z: cz }, { x: cx + Math.sin(a1) * r1, y: Y_MARK + 0.01, z: cz + Math.cos(a1) * r1 }, { x: cx + Math.sin(a0) * r0, y: Y_MARK + 0.01, z: cz + Math.cos(a0) * r0 }, a % 3 === 0 ? 0x1c1a2a : 0x101014);
            }
        }
        const oilMesh = new THREE.Mesh(ob.build(), new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 90, specular: 0x6a5a8a }));
        oilMesh.name = 'oil';
        group.add(oilMesh);
    }
    // Water: the harbour and the creek, just above the ground and under the road.
    for (const [wx0, wz0, wx1, wz1] of track.def.water ?? []) {
        const water = new THREE.Mesh(new THREE.PlaneGeometry(wx1 - wx0, wz1 - wz0), new THREE.MeshPhongMaterial({ color: theme.water, shininess: 25, specular: 0x2a3a4a }));
        water.rotation.x = -Math.PI / 2;
        water.position.set((wx0 + wx1) / 2, 0.008, (wz0 + wz1) / 2);
        water.receiveShadow = true;
        water.name = 'water';
        group.add(water);
    }
    // The railway: sleepers and two rails, over the road where they cross it.
    const rail = track.rail;
    if (rail) {
        const rb = new MeshBuilder();
        const px = -rail.dz, pz = rail.dx; // across the rails
        const pt = (u, side, y) => ({ x: rail.ax + rail.dx * u + px * side, y, z: rail.az + rail.dz * u + pz * side });
        for (let u = 0; u < rail.length; u += 1.2) {
            rb.quad(pt(u, -1.3, 0.05), pt(u, 1.3, 0.05), pt(u + 0.5, 1.3, 0.05), pt(u + 0.5, -1.3, 0.05), 0x4a3c30);
        }
        for (const side of [-0.72, 0.72]) {
            rb.quad(pt(0, side - 0.07, 0.09), pt(0, side + 0.07, 0.09), pt(rail.length, side + 0.07, 0.09), pt(rail.length, side - 0.07, 0.09), 0xb8bcc4);
        }
        // Ballast bed.
        rb.quad(pt(0, -2.2, 0.03), pt(0, 2.2, 0.03), pt(rail.length, 2.2, 0.03), pt(rail.length, -2.2, 0.03), 0x6a645c);
        // Double-sided: the rail direction decides the winding, and it is data.
        const railMat = flatMaterial().clone();
        railMat.side = THREE.DoubleSide;
        const railMesh = new THREE.Mesh(rb.build(), railMat);
        railMesh.receiveShadow = true;
        railMesh.name = 'railway';
        group.add(railMesh);
    }
    // Ground: a big plane under everything, sized to the scenery.
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
        x0 = Math.min(x0, track.line.px[i]);
        x1 = Math.max(x1, track.line.px[i]);
        z0 = Math.min(z0, track.line.pz[i]);
        z1 = Math.max(z1, track.line.pz[i]);
    }
    const pad = 600;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 + pad * 2, z1 - z0 + pad * 2), new THREE.MeshLambertMaterial({ color: theme.ground }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
    ground.receiveShadow = true;
    ground.name = 'ground';
    group.add(ground);
    return group;
}
//# sourceMappingURL=TrackMesh.js.map