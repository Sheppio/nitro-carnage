import * as THREE from 'three';
import { colourOf } from '../../sim/palette.js';
import type { BodyId, CarLook } from '../../sim/look.js';
import { MeshBuilder } from '../geometry.js';

/**
 * The five body styles (PLAN.md §4.5b), as procedural geometry. Each is a
 * handful of chamfered boxes, a few hundred triangles, built in code like
 * everything else — no model files.
 *
 * Local frame as in `CarMesh`: +Z is the nose, +X the car's left, +Y up.
 * Every body fits the shared collision footprint (4.4 m by 2.0 m, see
 * `SIM.car`): cosmetic means cosmetic, and a test measures each one.
 */

const tint = (hex: number, f: number): number => new THREE.Color(hex).multiplyScalar(f).getHex();

/** Where a body's flat top surfaces are, for laying stripes on them. */
interface Deck {
  /** Top height and length span of the bonnet, the roof and the boot. */
  bonnet: readonly [y: number, z0: number, z1: number, halfW: number];
  roof: readonly [y: number, z0: number, z1: number, halfW: number];
  boot: readonly [y: number, z0: number, z1: number, halfW: number] | null;
  /** Height and length of the door panels, and how far out they are. */
  side: readonly [y: number, z0: number, z1: number, x: number];
}

interface BodyBuild {
  deck: Deck;
  /** Head- and tail-light centres (left side; mirrored), on the body's own nose and tail. */
  lights: { front: readonly [x: number, y: number, z: number]; rear: readonly [x: number, y: number, z: number] };
}

const GLASS = 0x1b2230;
const TRIM = 0x202228;

function coupe(b: MeshBuilder, c: number): BodyBuild {
  const dark = tint(c, 0.55);
  b.box(0, 0.58, 0, 1.92, 0.5, 4.3, c, { insetX: 0.08, insetZFront: 0.35, insetZBack: 0.1, skipBottom: true, sides: dark });
  b.box(0, 1.03, -0.3, 1.58, 0.42, 2.0, GLASS, { insetX: 0.16, insetZFront: 0.45, insetZBack: 0.2, skipBottom: true, top: c });
  b.box(0, 0.4, 2.1, 1.9, 0.22, 0.25, TRIM, { skipBottom: true });
  b.box(0, 0.42, -2.12, 1.9, 0.26, 0.22, TRIM, { skipBottom: true });
  b.box(0.6, 0.98, -1.9, 0.08, 0.3, 0.12, TRIM, { skipBottom: true });
  b.box(-0.6, 0.98, -1.9, 0.08, 0.3, 0.12, TRIM, { skipBottom: true });
  b.box(0, 1.16, -1.95, 1.8, 0.07, 0.42, c, { top: tint(c, 1.15), sides: dark });
  return { deck: { bonnet: [0.84, 0.75, 1.8, 0.8], roof: [1.25, -0.95, 0.3, 0.6], boot: [0.84, -1.75, -1.35, 0.8], side: [0.6, -1.1, 1.1, 0.97] }, lights: { front: [0.62, 0.62, 2.16], rear: [0.66, 0.66, -2.16] } };
}

function hatch(b: MeshBuilder, c: number): BodyBuild {
  const dark = tint(c, 0.55);
  b.box(0, 0.6, 0.05, 1.86, 0.52, 3.9, c, { insetX: 0.08, insetZFront: 0.4, insetZBack: 0.05, skipBottom: true, sides: dark });
  // A tall glasshouse running right to the tail.
  b.box(0, 1.14, -0.55, 1.62, 0.56, 2.5, GLASS, { insetX: 0.12, insetZFront: 0.55, insetZBack: 0.05, skipBottom: true, top: c });
  b.box(0, 0.42, 2.0, 1.84, 0.22, 0.2, TRIM, { skipBottom: true });
  b.box(0, 0.44, -1.93, 1.84, 0.26, 0.2, TRIM, { skipBottom: true });
  // A little roof spoiler over the hatch.
  b.box(0, 1.44, -1.72, 1.4, 0.06, 0.3, c, { sides: dark });
  return { deck: { bonnet: [0.87, 0.9, 1.7, 0.78], roof: [1.43, -1.5, 0.15, 0.62], boot: null, side: [0.62, -1.2, 1.0, 0.94] }, lights: { front: [0.62, 0.64, 2.03], rear: [0.64, 0.72, -1.96] } };
}

function muscle(b: MeshBuilder, c: number): BodyBuild {
  const dark = tint(c, 0.5);
  b.box(0, 0.6, 0, 1.96, 0.56, 4.34, c, { insetX: 0.05, insetZFront: 0.12, insetZBack: 0.12, skipBottom: true, sides: dark });
  // Cabin set well back behind a long bonnet.
  b.box(0, 1.09, -0.75, 1.56, 0.44, 1.6, GLASS, { insetX: 0.14, insetZFront: 0.42, insetZBack: 0.3, skipBottom: true, top: c });
  // Bonnet scoop.
  b.box(0, 0.94, 1.05, 0.5, 0.14, 0.8, TRIM, { insetZFront: 0.2, skipBottom: true });
  b.box(0, 0.42, 2.12, 1.94, 0.26, 0.2, 0xb8bcc4, { skipBottom: true });
  b.box(0, 0.44, -2.12, 1.94, 0.26, 0.2, 0xb8bcc4, { skipBottom: true });
  // Ducktail.
  b.box(0, 0.95, -2.0, 1.86, 0.08, 0.3, c, { sides: dark });
  return { deck: { bonnet: [0.89, 0.2, 2.05, 0.82], roof: [1.32, -1.25, -0.4, 0.6], boot: [0.89, -2.0, -1.65, 0.82], side: [0.62, -1.3, 1.3, 0.99] }, lights: { front: [0.66, 0.66, 2.2], rear: [0.66, 0.68, -2.2] } };
}

function wedge(b: MeshBuilder, c: number): BodyBuild {
  const dark = tint(c, 0.5);
  // Low and pointed: a steep front inset makes the nose a wedge.
  b.box(0, 0.5, 0, 1.94, 0.4, 4.3, c, { insetX: 0.1, insetZFront: 1.1, insetZBack: 0.05, skipBottom: true, sides: dark });
  b.box(0, 0.84, -0.1, 1.5, 0.3, 1.7, GLASS, { insetX: 0.2, insetZFront: 0.55, insetZBack: 0.25, skipBottom: true, top: c });
  // Engine deck louvres behind the cabin.
  for (let k = 0; k < 4; k++) b.box(0, 0.72, -1.05 - k * 0.2, 1.2, 0.04, 0.08, TRIM);
  // A big rear wing on tall posts.
  b.box(0.55, 0.95, -1.95, 0.08, 0.5, 0.12, TRIM, { skipBottom: true });
  b.box(-0.55, 0.95, -1.95, 0.08, 0.5, 0.12, TRIM, { skipBottom: true });
  b.box(0, 1.24, -2.0, 1.96, 0.07, 0.46, c, { top: tint(c, 1.15), sides: dark });
  return { deck: { bonnet: [0.71, 0.2, 1.05, 0.8], roof: [1.0, -0.7, 0.25, 0.5], boot: null, side: [0.5, -1.4, 0.9, 0.97] }, lights: { front: [0.6, 0.46, 2.16], rear: [0.62, 0.6, -2.16] } };
}

function buggy(b: MeshBuilder, c: number): BodyBuild {
  const dark = tint(c, 0.5);
  const tube = 0x2c2e34;
  // Floor pan, nose cone and engine box; wheels stand proud of the body.
  b.box(0, 0.42, 0, 1.3, 0.2, 3.6, dark, { skipBottom: true });
  b.box(0, 0.6, 1.45, 1.1, 0.35, 1.1, c, { insetZFront: 0.35, insetX: 0.1, skipBottom: true });
  b.box(0, 0.7, -1.5, 1.2, 0.5, 0.9, TRIM, { skipBottom: true, top: 0x3a3c44 });
  // Side pods in the body colour.
  b.box(0.62, 0.6, 0, 0.3, 0.3, 1.6, c, { skipBottom: true });
  b.box(-0.62, 0.6, 0, 0.3, 0.3, 1.6, c, { skipBottom: true });
  // Seat.
  b.box(0, 0.75, -0.35, 0.6, 0.5, 0.6, 0x141418, { skipBottom: true });
  // Roll cage: four posts, two hoops, a roof.
  for (const [x, z] of [[0.55, 0.45], [-0.55, 0.45], [0.55, -0.85], [-0.55, -0.85]] as const) b.box(x, 1.05, z, 0.09, 1.1, 0.09, tube);
  b.box(0, 1.62, 0.45, 1.2, 0.09, 0.09, tube).box(0, 1.62, -0.85, 1.2, 0.09, 0.09, tube);
  b.box(0.55, 1.62, -0.2, 0.09, 0.09, 1.4, tube).box(-0.55, 1.62, -0.2, 0.09, 0.09, 1.4, tube);
  b.box(0, 1.68, -0.2, 1.1, 0.03, 1.3, c, { sides: dark });
  return { deck: { bonnet: [0.78, 1.1, 1.85, 0.4], roof: [1.7, -0.8, 0.4, 0.5], boot: null, side: [0.6, -0.7, 0.7, 0.78] }, lights: { front: [0.33, 0.62, 2.02], rear: [0.42, 0.78, -1.97] } };
}

const BUILDERS: Record<BodyId, (b: MeshBuilder, c: number) => BodyBuild> = { coupe, hatch, muscle, wedge, buggy };

/**
 * The stripe colour against the body: if the two are too alike to tell apart,
 * the stripe goes darker, so a pearl stripe on a pearl car still reads.
 */
export function stripeColour(body: number, stripe: number): number {
  const a = new THREE.Color(body), b = new THREE.Color(stripe);
  const d = Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
  return d < 0.35 ? tint(stripe, 0.45) : stripe;
}

function stripes(b: MeshBuilder, look: CarLook, deck: Deck, colour: number): void {
  const s = stripeColour(colour, colourOf(look.stripe).colour);
  const lay = (x: number, w: number): void => {
    for (const part of [deck.bonnet, deck.roof, deck.boot]) {
      if (!part) continue;
      const [y, z0, z1, hw] = part;
      if (Math.abs(x) + w / 2 > hw) continue;
      b.box(x, y + 0.012, (z0 + z1) / 2, w, 0.02, z1 - z0, s);
    }
  };
  switch (look.pattern) {
    case 'twin':
      lay(0.2, 0.18);
      lay(-0.2, 0.18);
      break;
    case 'offset':
      lay(0.3, 0.34);
      break;
    case 'flash': {
      const [y, z0, z1, x] = deck.side;
      for (const side of [1, -1]) {
        // A tapering flash along the doors: three steps.
        for (let k = 0; k < 3; k++) {
          const len = (z1 - z0) * (1 - k * 0.25);
          b.box(side * (x + 0.012), y - 0.08 + k * 0.08, z0 + len / 2 + (z1 - z0 - len), 0.02, 0.07, len, s);
        }
      }
      break;
    }
    case 'chequer': {
      const [y, z0, z1, hw] = deck.bonnet;
      const nx = 6, nz = 4;
      const cw = (hw * 2) / nx, cl = (z1 - z0) / nz;
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          b.box(-hw + cw * (i + 0.5), y + 0.012, z0 + cl * (j + 0.5), cw, 0.02, cl, (i + j) % 2 ? s : 0x141414);
        }
      }
      break;
    }
    case 'roundel':
    case 'none':
      break;
  }
}

const numberTextures = new Map<number, THREE.CanvasTexture>();

/** A white disc with the race number on it, drawn once per number. */
function numberTexture(n: number): THREE.CanvasTexture {
  let t = numberTextures.get(n);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f2ec';
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#111';
  g.font = 'bold 38px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), 32, 34);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  numberTextures.set(n, t);
  return t;
}

export interface BuiltBody {
  geometry: THREE.BufferGeometry;
  /** Head- and tail-lights, unlit so they glow. */
  lights: THREE.BufferGeometry;
  /** Race-number discs: on the roof always, on the doors for the roundel pattern. */
  decals: THREE.Mesh[];
}

/** Build one car's body in its look and colour. */
export function buildBody(look: CarLook, colour: number): BuiltBody {
  const b = new MeshBuilder();
  const { deck, lights } = BUILDERS[look.body](b, colour);
  const lb = new MeshBuilder();
  for (const side of [1, -1]) {
    const [fx, fy, fz] = lights.front;
    const [rx, ry, rz] = lights.rear;
    lb.box(side * fx, fy, fz, 0.4, 0.14, 0.06, 0xfff4d6);
    lb.box(side * rx, ry, rz, 0.38, 0.12, 0.06, 0xff2a3c);
  }
  stripes(b, look, deck, colour);
  const decals: THREE.Mesh[] = [];
  const mat = new THREE.MeshBasicMaterial({ map: numberTexture(look.number), transparent: true, alphaTest: 0.5 });
  const disc = (size: number): THREE.Mesh => new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  const [ry, rz0, rz1] = deck.roof;
  const roof = disc(0.62);
  roof.rotation.x = -Math.PI / 2;
  // Readable from the camera above and behind: the top of the number faces the nose.
  roof.rotation.z = Math.PI;
  roof.position.set(0, ry + 0.02, (rz0 + rz1) / 2);
  decals.push(roof);
  if (look.pattern === 'roundel') {
    const [y, z0, z1, x] = deck.side;
    for (const side of [1, -1]) {
      const d = disc(0.55);
      d.rotation.y = (side * Math.PI) / 2;
      d.position.set(side * (x + 0.02), y, (z0 + z1) / 2);
      decals.push(d);
    }
  }
  return { geometry: b.build(), lights: lb.build(), decals };
}
