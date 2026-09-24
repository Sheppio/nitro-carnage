import * as THREE from 'three';
import type { Track } from '../sim/track/buildTrack.js';
import { MeshBuilder } from './geometry.js';
import { flatMaterial } from './materials.js';
import type { Theme } from './themes.js';

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
export function buildTrackMesh(track: Track, theme: Theme): THREE.Group {
  const group = new THREE.Group();
  group.name = 'track';
  const n = track.n;
  const hw = track.halfWidth;
  const wo = track.wallOffset;

  const road = new MeshBuilder();
  const at = (i: number, d: number, y: number): THREE.Vector3Like => {
    const [x, z] = track.offsetPoint(i % n, d);
    return { x, y, z };
  };
  const shade = (hex: number, f: number): number => new THREE.Color(hex).multiplyScalar(f).getHex();
  const roadA = theme.road;
  const roadB = shade(theme.road, 0.93);

  for (let i = 0; i < n; i++) {
    const j = i + 1;
    const band = Math.floor(i / 4) % 2 === 0 ? roadA : roadB;
    // Left of travel is +d. Quads wind counter-clockwise seen from above:
    // from the right edge to the left edge, then forward.
    road.quad(at(i, -hw, Y_ROAD), at(j, -hw, Y_ROAD), at(j, hw, Y_ROAD), at(i, hw, Y_ROAD), band);
    const kerb = Math.floor(i / 3) % 2 === 0 ? theme.kerbA : theme.kerbB;
    road.quad(at(i, hw, Y_ROAD), at(j, hw, Y_ROAD), at(j, hw + KERB, Y_ROAD), at(i, hw + KERB, Y_ROAD), kerb);
    road.quad(at(i, -hw - KERB, Y_ROAD), at(j, -hw - KERB, Y_ROAD), at(j, -hw, Y_ROAD), at(i, -hw, Y_ROAD), kerb);
    road.quad(at(i, hw + KERB, Y_ROAD), at(j, hw + KERB, Y_ROAD), at(j, wo, Y_ROAD), at(i, wo, Y_ROAD), theme.pavement);
    road.quad(at(i, -wo, Y_ROAD), at(j, -wo, Y_ROAD), at(j, -hw - KERB, Y_ROAD), at(i, -hw - KERB, Y_ROAD), theme.pavement);
  }
  const surface = new THREE.Mesh(road.build(), flatMaterial());
  surface.receiveShadow = true;
  surface.name = 'road';
  group.add(surface);

  // Markings: a dashed centre line, solid edge lines, and a chequered start.
  const marks = new MeshBuilder();
  const strip = (i0: number, i1: number, d0: number, d1: number, hex: number) =>
    marks.quad(at(i0, d0, Y_MARK), at(i1, d0, Y_MARK), at(i1, d1, Y_MARK), at(i0, d1, Y_MARK), hex);
  for (let i = 0; i < n; i += 8) strip(i, i + 4, -0.15, 0.15, theme.line);
  for (let i = 0; i < n; i++) {
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
  const spacing = track.length / n;
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

  // Ground: a big plane under everything, sized to the scenery.
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, track.line.px[i]!);
    x1 = Math.max(x1, track.line.px[i]!);
    z0 = Math.min(z0, track.line.pz[i]!);
    z1 = Math.max(z1, track.line.pz[i]!);
  }
  const pad = 600;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(x1 - x0 + pad * 2, z1 - z0 + pad * 2),
    new THREE.MeshLambertMaterial({ color: theme.ground }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
  ground.receiveShadow = true;
  ground.name = 'ground';
  group.add(ground);

  return group;
}
