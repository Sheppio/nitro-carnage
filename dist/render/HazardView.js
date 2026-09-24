import * as THREE from 'three';
import { CAR_LENGTH, COUPLING, crossingWarning, trainAt, TRAIN_HALF_WIDTH } from '../sim/train.js';
import { MeshBuilder } from './geometry.js';
import { applyCutaway, flatMaterial } from './materials.js';
/**
 * The level crossing and its train, posed each frame from race time.
 *
 * Nothing here decides anything: `sim/train.ts` says where the train is and
 * whether the lights are on, as a function of race time, and this draws it.
 * Wagons past either end of the rails are hidden — that is the train inside
 * its shed, or gone off the edge of the map.
 */
export class HazardView {
    track;
    group = new THREE.Group();
    wagons = null;
    lights = [];
    booms = [];
    m = new THREE.Matrix4();
    q = new THREE.Quaternion();
    v = new THREE.Vector3();
    one = new THREE.Vector3(1, 1, 1);
    lowered = 0;
    cars = 0;
    c = new THREE.Color();
    constructor(track) {
        this.track = track;
        this.group.name = 'hazards';
        const rail = track.rail;
        const rw = track.def.railway;
        if (!rail || !rw)
            return;
        this.cars = rw.cars;
        // A wagon, nose along +Z: a long box with a darker roof; the loco gets a cab.
        const w = TRAIN_HALF_WIDTH * 2;
        const wagon = new MeshBuilder()
            .box(0, 1.9, 0, w, 2.8, CAR_LENGTH, 0xffffff, { skipBottom: true, top: 0xb0b0b0 })
            .box(0, 0.35, 0, w * 0.8, 0.7, CAR_LENGTH * 0.9, 0x303030, { skipBottom: true })
            .build();
        const mat = flatMaterial();
        applyCutaway(mat);
        this.wagons = new THREE.InstancedMesh(wagon, mat, rw.cars);
        this.wagons.castShadow = true;
        this.wagons.frustumCulled = false;
        this.wagons.name = 'train';
        const c = new THREE.Color();
        for (let k = 0; k < rw.cars; k++)
            this.wagons.setColorAt(k, c.setHex(k === 0 ? 0xc8332a : [0x3a5a8a, 0x5a6a4a, 0x8a6a3a][k % 3]));
        this.wagons.count = 0;
        this.group.add(this.wagons);
        // Crossing gear, one each side of the rails on opposite verges: a post,
        // two red lights, and a boom that swings down across its half of the road.
        for (const side of [-1, 1]) {
            const pose = track.poseAt(rail.s + side * (TRAIN_HALF_WIDTH + 3));
            const [px, pz] = track.offsetPoint(pose.i, -side * (track.wallOffset + 0.8));
            const post = new THREE.Group();
            post.position.set(px, 0, pz);
            post.rotation.y = pose.yaw;
            const pole = new THREE.Mesh(new MeshBuilder().box(0, 1.6, 0, 0.25, 3.2, 0.25, 0xe8e8e8, { skipBottom: true }).build(), flatMaterial());
            post.add(pole);
            for (const lx of [-0.35, 0.35]) {
                const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshBasicMaterial({ color: 0x3a0a0a }));
                lamp.position.set(lx, 2.8, 0.2);
                post.add(lamp);
                this.lights.push(lamp);
            }
            // The boom pivots at the post and reaches across the carriageway.
            const pivot = new THREE.Group();
            pivot.position.set(0, 1.1, 0);
            const arm = new THREE.Mesh(new MeshBuilder().box(side * track.halfWidth * 0.5 + side * 0.4, 0, 0, track.halfWidth + 0.8, 0.18, 0.18, 0xf2f2f2).build(), flatMaterial());
            // Red bands on the boom.
            for (let b = 1; b < 5; b++) {
                const band = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.2), new THREE.MeshBasicMaterial({ color: 0xd02020 }));
                band.position.set(side * (b * (track.halfWidth / 5) + 0.4), 0, 0);
                arm.add(band);
            }
            pivot.add(arm);
            pivot.userData.side = side;
            post.add(pivot);
            this.booms.push(pivot);
            this.group.add(post);
        }
    }
    /**
     * @param raceTime seconds since GO, at the renderer's interpolated moment
     * @param dt real seconds since the last frame, for the boom's swing
     */
    update(raceTime, dt) {
        const rail = this.track.rail;
        if (!rail || !this.wagons)
            return;
        const tr = trainAt(this.track, raceTime);
        let n = 0;
        if (tr) {
            this.q.setFromAxisAngle(this.v.set(0, 1, 0), Math.atan2(rail.dx * tr.dir, rail.dz * tr.dir));
            for (let k = 0; k < this.cars; k++) {
                // Wagon centres, from the head back.
                const u = tr.head - tr.dir * (k * (CAR_LENGTH + COUPLING) + CAR_LENGTH / 2);
                if (u < CAR_LENGTH / 2 || u > rail.length - CAR_LENGTH / 2)
                    continue;
                this.m.compose(this.v.set(rail.ax + rail.dx * u, 0, rail.az + rail.dz * u), this.q, this.one);
                this.wagons.setMatrixAt(n, this.m);
                // Instance colours go by slot, so the wagon's own colour moves with it.
                this.wagons.setColorAt(n, this.c.setHex(k === 0 ? 0xc8332a : [0x3a5a8a, 0x5a6a4a, 0x8a6a3a][k % 3]));
                n++;
            }
        }
        this.wagons.count = n;
        this.wagons.instanceMatrix.needsUpdate = true;
        if (this.wagons.instanceColor)
            this.wagons.instanceColor.needsUpdate = true;
        // Lights alternate at 1.5 Hz while the train is due; the booms follow.
        const warn = crossingWarning(this.track, raceTime);
        const phase = Math.floor(raceTime * 3) % 2;
        this.lights.forEach((l, i) => l.material.color.setHex(warn && i % 2 === phase ? 0xff2a1a : 0x3a0a0a));
        this.lowered += ((warn ? 1 : 0) - this.lowered) * Math.min(1, dt * 2.5);
        // Raised, a boom stands upright: towards +Y from whichever way it reaches.
        for (const b of this.booms)
            b.rotation.z = (1 - this.lowered) * (Math.PI / 2) * b.userData.side;
    }
}
//# sourceMappingURL=HazardView.js.map