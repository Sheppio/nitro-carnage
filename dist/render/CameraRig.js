import * as THREE from 'three';
import { CAMERA, SIM } from '../config.js';
/**
 * The race camera: high overhead, perspective, fixed north-up.
 *
 * Perspective rather than orthographic is the whole trick. With the lens 56 m
 * up and towers up to 34 m tall, a roof sits well over halfway to the camera,
 * so as you drive past a building it visibly leans away from the middle of the
 * screen — parallax you get for free from the projection, not from any effect.
 *
 * The screen does not rotate with the car. Everyone in a race sees the same
 * map, the minimap agrees with the world, and a rival's arrow on the edge of
 * the screen points the way the rival actually is.
 */
export class CameraRig {
    camera;
    /** Look-at point on the ground, including the lead. */
    focus = new THREE.Vector3();
    lead = new THREE.Vector2();
    leadVel = new THREE.Vector2();
    speedFrac = 0;
    trauma = 0;
    time = 0;
    started = false;
    /** Scales shake; 0.25 under "reduce motion". */
    shakeScale = 1;
    constructor(aspect) {
        this.camera = new THREE.PerspectiveCamera(CAMERA.fov, aspect, 5, 600);
    }
    /** Add shake. Trauma is 0..1 and the shake is its square, so small knocks stay small. */
    addTrauma(amount) {
        this.trauma = Math.min(1, this.trauma + amount);
    }
    setAspect(aspect) {
        this.camera.aspect = aspect;
    }
    setFar(far) {
        this.camera.far = far;
    }
    update(car, dt) {
        this.time += dt;
        const speed = Math.hypot(car.vx, car.vz);
        const frac = Math.min(1, speed / SIM.car.topSpeed);
        // Lead: look ahead along the velocity, through a critically damped spring
        // so a sudden spin does not whip the whole screen round.
        const cap = CAMERA.leadMax;
        let tx = car.vx * CAMERA.leadSeconds;
        let tz = car.vz * CAMERA.leadSeconds;
        const len = Math.hypot(tx, tz);
        if (len > cap) {
            tx *= cap / len;
            tz *= cap / len;
        }
        if (!this.started) {
            this.lead.set(tx, tz);
            this.speedFrac = frac;
            this.started = true;
        }
        const omega = 3.2;
        const h = Math.min(dt, 1 / 20);
        const ax = omega * omega * (tx - this.lead.x) - 2 * omega * this.leadVel.x;
        const az = omega * omega * (tz - this.lead.y) - 2 * omega * this.leadVel.y;
        this.leadVel.x += ax * h;
        this.leadVel.y += az * h;
        this.lead.x += this.leadVel.x * h;
        this.lead.y += this.leadVel.y * h;
        // Speed pulls the camera up and widens the lens a little, framerate-independently.
        this.speedFrac += (frac - this.speedFrac) * (1 - Math.exp(-dt * 1.5));
        const height = CAMERA.height + (CAMERA.heightFast - CAMERA.height) * this.speedFrac;
        let fov = CAMERA.fov + (CAMERA.fovFast - CAMERA.fov) * this.speedFrac;
        // A phone in portrait: widen until the narrow axis still shows `minSpan`
        // metres of ground, or the screen is a keyhole.
        const aspect = this.camera.aspect;
        if (aspect < 1) {
            const hHalf = Math.atan(CAMERA.minSpan / 2 / height);
            const vNeeded = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hHalf) / aspect));
            fov = Math.min(95, Math.max(fov, vNeeded));
        }
        if (Math.abs(this.camera.fov - fov) > 1e-3) {
            this.camera.fov = fov;
            this.camera.updateProjectionMatrix();
        }
        // Shake: trauma squared times smooth noise. Decays linearly.
        this.trauma = Math.max(0, this.trauma - CAMERA.traumaDecay * dt);
        const shake = this.trauma * this.trauma * CAMERA.shakeMetres * this.shakeScale;
        const t = this.time * 22;
        const sx = shake * noise(t, 1.3);
        const sz = shake * noise(t, 7.1);
        this.focus.set(car.x + this.lead.x + sx, 0, car.z + this.lead.y + sz);
        const tilt = THREE.MathUtils.degToRad(CAMERA.tiltDeg);
        this.camera.position.set(this.focus.x, height, this.focus.z + height * Math.tan(tilt));
        this.camera.lookAt(this.focus);
        if (shake > 0)
            this.camera.rotateZ(shake * 0.012 * noise(t, 3.7));
    }
}
/** Cheap smooth 1D noise from a few incommensurate sines, in about -1..1. */
function noise(t, seed) {
    return (Math.sin(t * 1.0 + seed) + Math.sin(t * 2.3 + seed * 1.7) * 0.5 + Math.sin(t * 4.1 + seed * 2.9) * 0.25) / 1.75;
}
//# sourceMappingURL=CameraRig.js.map