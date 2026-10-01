import * as THREE from 'three';
import { CAMERA, CAMERA_VIEWS, SIM } from '../config.js';
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
 *
 * The experimental views (Settings → Experimental) are the exception: chase,
 * bonnet, cockpit and the rest sit at an offset from the car and turn with it.
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
    /** The player's field of view at rest (the Settings slider and the mouse wheel). */
    baseFov = CAMERA.fov;
    /** Scales shake; 0.25 under "reduce motion". */
    shakeScale = 1;
    /**
     * The race start, 1 down to 0 over the countdown: the camera starts high and
     * swung round, showing the whole grid, and drops in behind the lights.
     */
    intro = 0;
    /** Which view; see `CAMERA_VIEWS`. */
    view = 'overhead';
    /** The Custom view's offset (metres right, up, behind the car) and pitch in degrees. */
    custom = { x: 0, y: 4.5, z: 11, pitch: -12, near: 0.1, follow: 6, label: 'Custom' };
    /** The heading the turning views look along, chasing the car's through a spring. */
    heading = 0;
    headingVel = 0;
    turning = false;
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
    /** The settings for the view in use, or null for the overhead one. */
    get preset() {
        if (this.view === 'overhead')
            return null;
        return this.view === 'custom' ? this.custom : CAMERA_VIEWS[this.view];
    }
    /**
     * Whether the followed car is drawn: not from a camera inside it (the
     * cockpit, the bumper, or a Custom offset inside its body), which would
     * see the inside of its panels.
     */
    get hidesOwnCar() {
        const p = this.preset;
        if (!p)
            return false;
        if (this.view === 'cockpit' || this.view === 'bumper')
            return true;
        return this.view === 'custom' && Math.abs(p.x) < 1.1 && Math.abs(p.z) < 2.4 && p.y < 1.6;
    }
    update(car, dt) {
        const preset = this.preset;
        if (preset) {
            this.turningView(car, dt, preset);
            return;
        }
        this.turning = false;
        if (this.camera.near !== 5) {
            this.camera.near = 5;
            this.camera.updateProjectionMatrix();
        }
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
        // Speed widens the lens by the same few degrees whatever the player's zoom.
        let fov = this.baseFov + (CAMERA.fovFast - CAMERA.fov) * this.speedFrac;
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
        // The start: higher, tilted further and swung round to one side, easing to
        // the usual north-up view as the intro runs down.
        const k = this.intro * this.intro * (3 - 2 * this.intro);
        const up = height * (1 + 0.7 * k);
        const back = up * Math.tan(tilt + k * 0.35);
        const swing = k * 0.7;
        this.camera.position.set(this.focus.x + back * Math.sin(swing), up, this.focus.z + back * Math.cos(swing));
        this.camera.lookAt(this.focus);
        if (shake > 0)
            this.camera.rotateZ(shake * 0.012 * noise(t, 3.7));
    }
    /**
     * A view that turns with the car: the preset's offset in the car's frame,
     * looking along its heading at the preset's pitch. Views on the car are
     * fixed to it; the chase and helicopter views swing round after it through
     * a critically damped spring, so a spin does not whip the screen round.
     */
    turningView(car, dt, p) {
        this.time += dt;
        if (!this.turning) {
            this.heading = car.yaw;
            this.headingVel = 0;
            this.turning = true;
        }
        if (p.follow > 0) {
            const h = Math.min(dt, 1 / 20);
            // The shortest way round to the car's heading.
            const err = Math.atan2(Math.sin(car.yaw - this.heading), Math.cos(car.yaw - this.heading));
            const a = p.follow * p.follow * err - 2 * p.follow * this.headingVel;
            this.headingVel += a * h;
            this.heading += this.headingVel * h;
        }
        else {
            this.heading = car.yaw;
            this.headingVel = 0;
        }
        const speed = Math.hypot(car.vx, car.vz);
        const frac = Math.min(1, speed / SIM.car.topSpeed);
        this.speedFrac += (frac - this.speedFrac) * (1 - Math.exp(-dt * 1.5));
        const fov = this.baseFov + (CAMERA.fovFast - CAMERA.fov) * this.speedFrac;
        if (Math.abs(this.camera.fov - fov) > 1e-3 || this.camera.near !== p.near) {
            this.camera.fov = fov;
            this.camera.near = p.near;
            this.camera.updateProjectionMatrix();
        }
        // Forward is (sin yaw, cos yaw); the car's right is (-cos yaw, sin yaw).
        const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
        const rx = -fz, rz = fx;
        // The race start: the camera rises up and back over the grid, as the overhead one does.
        const k = this.intro * this.intro * (3 - 2 * this.intro);
        const back = p.z + k * 30;
        const up = p.y + k * 25;
        this.camera.position.set(car.x + rx * p.x - fx * back, car.y + up, car.z + rz * p.x - fz * back);
        // Shake: as overhead, but smaller, as the camera is close to the car.
        this.trauma = Math.max(0, this.trauma - CAMERA.traumaDecay * dt);
        const shake = this.trauma * this.trauma * this.shakeScale;
        const t = this.time * 22;
        const pitch = THREE.MathUtils.degToRad(p.pitch) - k * 0.5 + shake * 0.02 * noise(t, 1.3);
        const yawShake = shake * 0.02 * noise(t, 7.1);
        const c = Math.cos(pitch);
        this.camera.lookAt(this.camera.position.x + (fx + rx * yawShake) * c, this.camera.position.y + Math.sin(pitch), this.camera.position.z + (fz + rz * yawShake) * c);
        if (shake > 0)
            this.camera.rotateZ(shake * 0.012 * noise(t, 3.7));
    }
}
/** Cheap smooth 1D noise from a few incommensurate sines, in about -1..1. */
function noise(t, seed) {
    return (Math.sin(t * 1.0 + seed) + Math.sin(t * 2.3 + seed * 1.7) * 0.5 + Math.sin(t * 4.1 + seed * 2.9) * 0.25) / 1.75;
}
//# sourceMappingURL=CameraRig.js.map