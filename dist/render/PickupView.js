import * as THREE from 'three';
/** Each kind's colour: warm for ammo, green for a repair, the turbo bar's cyan for turbo. */
const COLOURS = { ammo: 0xff7a1a, repair: 0x3ddc6a, turbo: 0x00d5ef };
/**
 * The symbol on a box's faces, drawn once per kind: a missile's triangle for
 * ammo, a cross for a repair, a double chevron for turbo. Drawn as paths, not
 * text, so every browser shows the same thing.
 */
function faceTexture(kind) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = `#${COLOURS[kind].toString(16).padStart(6, '0')}`;
    g.fillRect(0, 0, 64, 64);
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 4;
    g.strokeRect(4, 4, 56, 56);
    g.fillStyle = '#fff';
    g.beginPath();
    if (kind === 'ammo') {
        g.moveTo(32, 12);
        g.lineTo(50, 50);
        g.lineTo(14, 50);
    }
    else if (kind === 'repair') {
        g.rect(26, 12, 12, 40);
        g.rect(12, 26, 40, 12);
    }
    else {
        for (const x of [14, 32]) {
            g.moveTo(x, 14);
            g.lineTo(x + 18, 32);
            g.lineTo(x, 50);
            g.lineTo(x + 8, 50);
            g.lineTo(x + 26, 32);
            g.lineTo(x + 8, 14);
            g.closePath();
        }
    }
    g.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}
/**
 * The pickup boxes: spinning, bobbing cubes over the road, gone while taken
 * and popping back in when they return. Reads `Pickups`; decides nothing.
 */
export class PickupView {
    pickups;
    group = new THREE.Group();
    boxes = [];
    rings = [];
    scale = [];
    time = 0;
    constructor(pickups) {
        this.pickups = pickups;
        this.group.name = 'pickups';
        if (!pickups)
            return;
        const geo = new THREE.BoxGeometry(2, 2, 2);
        // A glowing ring on the road under each box: the box alone is small from the race camera.
        const ringGeo = new THREE.RingGeometry(1.5, 2.1, 32);
        ringGeo.rotateX(-Math.PI / 2);
        const mats = new Map();
        const ringMats = new Map();
        for (const spot of pickups.spots) {
            let mat = mats.get(spot.kind);
            if (!mat) {
                mat = new THREE.MeshLambertMaterial({ map: faceTexture(spot.kind), emissive: COLOURS[spot.kind], emissiveIntensity: 0.6 });
                mats.set(spot.kind, mat);
                ringMats.set(spot.kind, new THREE.MeshBasicMaterial({
                    color: COLOURS[spot.kind], transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false,
                }));
            }
            const ring = new THREE.Mesh(ringGeo, ringMats.get(spot.kind));
            ring.position.set(spot.x, 0.06, spot.z);
            this.group.add(ring);
            this.rings.push(ring);
            const box = new THREE.Mesh(geo, mat);
            box.position.set(spot.x, 1.6, spot.z);
            box.castShadow = true;
            this.group.add(box);
            this.boxes.push(box);
            this.scale.push(1);
        }
    }
    /** Pose every box at world time `t`. */
    update(t, dt) {
        const pk = this.pickups;
        if (!pk)
            return;
        this.time += dt;
        for (let i = 0; i < this.boxes.length; i++) {
            const box = this.boxes[i];
            const here = pk.here(i, t);
            // Taken: gone at once. Back: grows in over a third of a second.
            const k = here ? Math.min(1, this.scale[i] + dt * 3) : 0;
            this.scale[i] = k;
            box.visible = k > 0;
            const ring = this.rings[i];
            ring.visible = box.visible;
            ring.scale.setScalar(0.85 + 0.15 * Math.sin(this.time * 4 + i));
            if (!box.visible)
                continue;
            const ease = 1 - (1 - k) ** 3;
            box.scale.setScalar(ease);
            box.rotation.set(0.5, this.time * 1.6 + i, 0.3);
            box.position.y = 1.6 + Math.sin(this.time * 2.4 + i * 1.3) * 0.25;
        }
    }
}
//# sourceMappingURL=PickupView.js.map