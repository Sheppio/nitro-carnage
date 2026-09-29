import * as THREE from 'three';
import type { CarLook } from '../sim/look.js';
import { colourOf } from '../sim/palette.js';
import { createCar } from '../sim/car.js';
import { CarMesh } from './CarMesh.js';
import { carIcon } from '../ui/carIcon.js';

/**
 * A still of the player's own car, the real `CarMesh` seen from the front
 * three-quarter, for the main menu's Garage button (#7): the plan-view icon
 * read as a coloured box. The renderer lives just long enough for one frame
 * and gives its context straight back, so the menu holds no WebGL of its own.
 * Without WebGL it falls back to the plan-view icon.
 */
export function carPortrait(look: CarLook, colourId: string, width: number, height: number): HTMLCanvasElement {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return carIcon(look, colourId, width, height);
  }
  try {
    // Drawn at twice the size and scaled down: smoother edges than MSAA alone at this size.
    renderer.setPixelRatio(1);
    renderer.setSize(width * dpr * 2, height * dpr * 2, false);
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
    renderer.render(scene, camera);

    const out = document.createElement('canvas');
    out.width = width * dpr;
    out.height = height * dpr;
    out.style.width = `${width}px`;
    out.style.height = `${height}px`;
    out.className = 'car-icon';
    out.dataset.body = look.body;
    const g = out.getContext('2d');
    g?.drawImage(renderer.domElement, 0, 0, out.width, out.height);
    return out;
  } catch {
    return carIcon(look, colourId, width, height);
  } finally {
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
