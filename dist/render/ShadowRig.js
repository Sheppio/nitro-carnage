import * as THREE from 'three';
/** Half-width of the shadow camera's box, metres. */
const EXTENT = 75;
/**
 * The sun, and a shadow camera that follows the player.
 *
 * One directional light lights the whole scene, but its shadow map only
 * covers a box around the local car — a whole-city shadow map would spread
 * 2048 texels over 600 m and every shadow would be a blur. The box follows the
 * car in steps of exactly one shadow-map texel, measured in the light's own
 * frame; a box that slides smoothly re-samples every shadow edge each frame,
 * and they crawl and shimmer as you drive.
 */
export class ShadowRig {
    sun;
    hemi;
    dir = new THREE.Vector3();
    right = new THREE.Vector3();
    up = new THREE.Vector3();
    texel = 1;
    constructor(theme, mapSize, soft) {
        this.hemi = new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, theme.hemiIntensity);
        this.sun = new THREE.DirectionalLight(theme.sun, theme.sunIntensity);
        const az = THREE.MathUtils.degToRad(theme.sunAzimuth);
        const el = THREE.MathUtils.degToRad(theme.sunElevation);
        // Direction the light travels, from the sun towards the ground.
        this.dir.set(-Math.cos(el) * Math.sin(az), -Math.sin(el), -Math.cos(el) * Math.cos(az)).normalize();
        this.right.crossVectors(this.dir, new THREE.Vector3(0, 1, 0)).normalize();
        this.up.crossVectors(this.right, this.dir).normalize();
        if (mapSize > 0) {
            this.sun.castShadow = true;
            this.sun.shadow.mapSize.set(mapSize, mapSize);
            const cam = this.sun.shadow.camera;
            cam.left = -EXTENT;
            cam.right = EXTENT;
            cam.top = EXTENT;
            cam.bottom = -EXTENT;
            cam.near = 1;
            cam.far = 400;
            cam.updateProjectionMatrix();
            this.sun.shadow.bias = -0.0006;
            this.sun.shadow.normalBias = 0.04;
            this.sun.shadow.radius = soft ? 2 : 1;
            this.texel = (EXTENT * 2) / mapSize;
        }
    }
    /** Centre the shadow box on a point, snapped to the texel grid in light space. */
    follow(x, z) {
        const p = new THREE.Vector3(x, 0, z);
        // Snap the components across the light's view; leave depth alone.
        const r = Math.round(p.dot(this.right) / this.texel) * this.texel;
        const u = Math.round(p.dot(this.up) / this.texel) * this.texel;
        const d = p.dot(this.dir);
        const snapped = new THREE.Vector3()
            .addScaledVector(this.right, r)
            .addScaledVector(this.up, u)
            .addScaledVector(this.dir, d);
        this.sun.target.position.copy(snapped);
        this.sun.position.copy(snapped).addScaledVector(this.dir, -200);
        this.sun.target.updateMatrixWorld();
    }
}
//# sourceMappingURL=ShadowRig.js.map