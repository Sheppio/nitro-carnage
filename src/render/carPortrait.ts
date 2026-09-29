import * as THREE from 'three';
import { encodeLook } from '../sim/look.js';
import type { CarLook } from '../sim/look.js';
import { colourOf } from '../sim/palette.js';
import { createCar } from '../sim/car.js';
import { CarMesh } from './CarMesh.js';
import { carIcon } from '../ui/carIcon.js';

/** Stills already drawn, by look, colour and size. */
const drawn = new Map<string, HTMLCanvasElement>();

/**
 * A still of a car, the real `CarMesh` seen from the front three-quarter, for
 * the main menu's Garage button (#7) and the lobby's roster: the plan-view
 * icon read as a coloured box. The renderer is given back soon after, so the
 * menu holds no WebGL of its own. Without WebGL it falls back to the
 * plan-view icon.
 *
 * Each still is drawn once and handed out as a copy: the lobby redraws its
 * roster twice a second, and a WebGL context each time would be a lot.
 */
export function carPortrait(look: CarLook, colourId: string, width: number, height: number): HTMLCanvasElement {
  const key = `${encodeLook(look)}:${colourId}:${width}x${height}`;
  let still = drawn.get(key);
  if (!still) {
    if (drawn.size >= 64) drawn.clear();
    still = render(look, colourId, width, height);
    drawn.set(key, still);
  }
  // A copy: one canvas can only be in one place on the page.
  const out = document.createElement('canvas');
  out.width = still.width;
  out.height = still.height;
  out.style.cssText = still.style.cssText;
  out.className = still.className;
  Object.assign(out.dataset, still.dataset);
  out.getContext('2d')?.drawImage(still, 0, 0);
  return out;
}

/**
 * One renderer for every still, kept while they are being asked for: a roster
 * of six cars made a context each, and compiled the car's shaders six times,
 * which stalled the lobby. Given back a moment after the last one.
 */
let shared: THREE.WebGLRenderer | null = null;
let release = 0;
function renderer(): THREE.WebGLRenderer {
  clearTimeout(release);
  release = window.setTimeout(() => {
    shared?.dispose();
    shared?.forceContextLoss();
    shared = null;
  }, 2000);
  return (shared ??= new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }));
}

function render(look: CarLook, colourId: string, width: number, height: number): HTMLCanvasElement {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  try {
    const gl = renderer();
    // Drawn at twice the size and scaled down: smoother edges than MSAA alone at this size.
    gl.setPixelRatio(1);
    gl.setSize(width * dpr * 2, height * dpr * 2, false);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x2a2233, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(5, 8, -3);
    scene.add(sun);
    const car = new CarMesh(colourOf(colourId).colour, false, look);
    // Nose to the right, turned a little towards the viewer.
    car.update(createCar(0, 0, Math.PI - 0.55), 0);
    scene.add(car.root);
    const half = 2.9, aspect = width / height;
    const camera = new THREE.OrthographicCamera(-half, half, half / aspect, -half / aspect, 0.1, 50);
    camera.position.set(8, 3.4, 0);
    camera.lookAt(0, 0.6, 0);
    gl.render(scene, camera);

    const out = document.createElement('canvas');
    out.width = width * dpr;
    out.height = height * dpr;
    out.style.width = `${width}px`;
    out.style.height = `${height}px`;
    out.className = 'car-icon';
    out.dataset.body = look.body;
    const g = out.getContext('2d');
    g?.drawImage(gl.domElement, 0, 0, out.width, out.height);
    return out;
  } catch {
    // No WebGL: the plan-view icon.
    return carIcon(look, colourId, width, height);
  }
}
