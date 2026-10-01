import * as THREE from 'three';
/** Metres a second, and how much faster the fast move is. */
const SPEED = 18;
const FAST = 3.5;
/** The lowest the lens goes, metres above the ground. */
const FLOOR = 0.35;
/** The highest, and how far from the car it may wander: no further than the map is worth seeing. */
const CEILING = 160;
const TETHER = 220;
const PITCH_LIMIT = THREE.MathUtils.degToRad(88);
/**
 * Photo mode's camera: a drone that starts where the race camera was and
 * then goes wherever the player flies it. Forward and sideways are along the
 * ground the way it faces, up is straight up, so a level shot stays level
 * whatever the tilt. Kept above the ground and within reach of the car.
 */
export class PhotoCamera {
    pos = new THREE.Vector3();
    yaw = 0;
    pitch = 0;
    anchor = new THREE.Vector3();
    fov = 50;
    /** Take over from the race camera, looking the way it looks. */
    begin(camera, anchor) {
        camera.updateMatrixWorld();
        this.pos.copy(camera.position);
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        this.yaw = Math.atan2(dir.x, dir.z);
        this.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
        this.fov = camera.fov;
        this.anchor.set(anchor.x, anchor.y, anchor.z);
    }
    /** Move by a frame's input and pose `camera` there. */
    update(camera, move, dt) {
        this.yaw -= move.yaw;
        this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + move.pitch));
        const step = SPEED * (move.fast ? FAST : 1) * dt;
        const n = move.nudge;
        const right = move.x * step + (n?.x ?? 0);
        const ahead = move.z * step + (n?.z ?? 0);
        // Forward is (sin yaw, cos yaw); the camera's right is (-cos yaw, sin yaw).
        const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
        this.pos.x += fx * ahead - fz * right;
        this.pos.z += fz * ahead + fx * right;
        this.pos.y += move.y * step + (n?.y ?? 0);
        this.pos.y = Math.max(FLOOR, Math.min(CEILING, this.pos.y));
        const dx = this.pos.x - this.anchor.x, dz = this.pos.z - this.anchor.z;
        const d = Math.hypot(dx, dz);
        if (d > TETHER) {
            this.pos.x = this.anchor.x + (dx * TETHER) / d;
            this.pos.z = this.anchor.z + (dz * TETHER) / d;
        }
        this.pose(camera);
    }
    /** Widen (+) or close in the lens, in degrees. */
    zoom(deg) {
        this.fov = Math.max(15, Math.min(100, this.fov + deg));
    }
    pose(camera) {
        camera.position.copy(this.pos);
        const c = Math.cos(this.pitch);
        camera.lookAt(this.pos.x + Math.sin(this.yaw) * c, this.pos.y + Math.sin(this.pitch), this.pos.z + Math.cos(this.yaw) * c);
        // Close to the ground and to the cars, the race camera's near plane would clip them.
        if (camera.near !== 0.1 || Math.abs(camera.fov - this.fov) > 1e-3) {
            camera.near = 0.1;
            camera.fov = this.fov;
            camera.updateProjectionMatrix();
        }
    }
}
//# sourceMappingURL=PhotoCamera.js.map