import * as THREE from 'three';
import { CarMesh } from './CarMesh.js';
import { createCar } from '../sim/car.js';
/**
 * The Garage's turntable: one car, the real `CarMesh`, slowly turning under
 * a studio light. Its own small renderer, so the Garage works from the menu
 * with no race loaded; it only draws while the Garage is open.
 */
export class GaragePreview {
    host;
    renderer;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    car = null;
    state = createCar(0, 0, 0);
    raf = 0;
    last = 0;
    resize;
    constructor(host) {
        this.host = host;
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        this.renderer.domElement.className = 'garage-canvas';
        host.appendChild(this.renderer.domElement);
        this.scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x2a2233, 1.6));
        const sun = new THREE.DirectionalLight(0xffffff, 2.2);
        sun.position.set(4, 8, 5);
        this.scene.add(sun);
        const floor = new THREE.Mesh(new THREE.CircleGeometry(3.4, 40), new THREE.MeshLambertMaterial({ color: 0x2a2838 }));
        floor.rotation.x = -Math.PI / 2;
        this.scene.add(floor);
        this.camera.position.set(0, 5.2, 7.4);
        this.camera.lookAt(0, 0.5, 0);
        this.resize = new ResizeObserver(() => this.fit());
        this.resize.observe(host);
        this.fit();
    }
    /** Show a look in a colour. */
    show(look, colour) {
        if (this.car) {
            this.scene.remove(this.car.root, this.car.blob);
        }
        this.car = new CarMesh(colour, false, look);
        this.scene.add(this.car.root, this.car.blob);
    }
    /** The car on the turntable, for tests. */
    get mesh() {
        return this.car;
    }
    start() {
        if (this.raf)
            return;
        this.last = performance.now();
        const loop = (now) => {
            const dt = Math.min(0.1, (now - this.last) / 1000);
            this.last = now;
            this.state.yaw += dt * 0.6;
            this.car?.update(this.state, dt);
            this.renderer.render(this.scene, this.camera);
            this.raf = requestAnimationFrame(loop);
        };
        this.raf = requestAnimationFrame(loop);
    }
    stop() {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
    }
    fit() {
        const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }
}
//# sourceMappingURL=GaragePreview.js.map