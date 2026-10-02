import * as THREE from 'three';
import { QUALITY } from '../config.js';
import { CameraRig } from './CameraRig.js';
import { CarMesh } from './CarMesh.js';
import { createCar } from '../sim/car.js';
import { Fx } from './Fx.js';
import { cutawayUniforms, MAX_CUT_CARS } from './materials.js';
import { Scenery } from './Scenery.js';
import { ShadowRig } from './ShadowRig.js';
import { themeFor } from './themes.js';
import { buildTrackMesh } from './TrackMesh.js';
import { WeaponView } from './WeaponView.js';
import { HazardView } from './HazardView.js';
import { PickupView } from './PickupView.js';
import { PhotoCamera } from './PhotoCamera.js';
/**
 * One renderer, and so one WebGL context, for every race. A new one per race
 * left the last race's context and its GPU memory alive until the garbage
 * collector got round to the canvas, which a small heap rarely asks it to:
 * an Xbox ran the first race at 60 fps and the next ones at 52-56, with
 * judder, until a reload. A context is only replaced when the antialias
 * setting changes, which WebGL fixes at creation, and the old one is then
 * released at once.
 */
let shared = null;
function rendererFor(antialias) {
    if (shared && shared.antialias === antialias)
        return shared.renderer;
    if (shared) {
        shared.renderer.dispose();
        shared.renderer.forceContextLoss();
    }
    const renderer = new THREE.WebGLRenderer({ antialias, powerPreference: 'high-performance' });
    shared = { renderer, antialias };
    return renderer;
}
/** Free a material's GPU copy and every texture it uses. */
function disposeMaterial(m) {
    for (const v of Object.values(m))
        if (v instanceof THREE.Texture)
            v.dispose();
    m.dispose();
}
import { missileAt } from '../sim/weapons.js';
/** How far out the cut-away hole reaches around a car, in metres at the car. */
const CUT_RADIUS_M = 6.5;
/**
 * Everything three.js, for one race.
 *
 * The rest of the game hands this a `Track` and, each frame, the car states
 * to draw. It never reads input, never steps physics and never touches the
 * network; `render/` is the only directory that imports three, which keeps
 * the renderer swappable and the simulation runnable in Node.
 */
export class GameView {
    host;
    track;
    renderer;
    scene = new THREE.Scene();
    rig;
    cars = new Map();
    scenery;
    shadows;
    fx;
    weapons = new WeaponView();
    hazards;
    ghost = null;
    ghostState = createCar(0, 0, 0);
    /** The cut-away as the camera view last set it: on for the overhead view. */
    cutawayByView = true;
    clock = 0;
    quality;
    resizeObserver;
    v = new THREE.Vector3();
    v2 = new THREE.Vector3();
    right = new THREE.Vector3();
    size = new THREE.Vector2();
    /** The car the camera follows. */
    focusId = null;
    /** Fired with a 0..1 strength when the focused car lands or hits a wall, for haptics. */
    onJolt = null;
    /**
     * Photo mode: the free camera flies instead of the race camera following,
     * and the frame is drawn through the depth of field. Null while racing.
     */
    photo = null;
    photoCam = new PhotoCamera();
    dof = null;
    constructor(host, track, quality) {
        this.host = host;
        this.track = track;
        this.quality = quality;
        const preset = QUALITY[quality];
        this.renderer = rendererFor(preset.antialias);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, preset.pixelRatioCap));
        this.renderer.shadowMap.enabled = preset.shadowMapSize > 0;
        this.renderer.shadowMap.type = preset.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
        this.renderer.domElement.className = 'game-canvas';
        host.appendChild(this.renderer.domElement);
        const theme = themeFor(track.def.theme);
        this.scene.background = new THREE.Color(theme.sky);
        this.scene.fog = new THREE.Fog(theme.fog, preset.drawDistance * 0.45, preset.drawDistance);
        this.shadows = new ShadowRig(theme, preset.shadowMapSize, preset.softShadows);
        this.scene.add(this.shadows.hemi, this.shadows.sun, this.shadows.sun.target);
        this.scene.add(buildTrackMesh(track, theme));
        this.scenery = new Scenery(track, theme, preset.sceneryDetail);
        this.scene.add(this.scenery.group);
        this.fx = new Fx(preset.tyreMarks, preset.particles);
        this.hazards = new HazardView(track);
        this.scene.add(this.fx.group, this.weapons.group, this.hazards.group);
        this.rig = new CameraRig(1);
        this.rig.setFar(preset.drawDistance + 60);
        // The cut-away's switch is shared by every race: the last may have left it off.
        this.setCutaway(true);
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(host);
        this.resize();
    }
    get qualityId() {
        return this.quality;
    }
    addCar(id, colour, look) {
        const mesh = new CarMesh(colour, QUALITY[this.quality].shadowMapSize > 0, look);
        this.scene.add(mesh.root, mesh.blob);
        const view = { id, mesh, landings: 0, impacts: 0, hp: 100, wrecked: false, ghost: false };
        this.cars.set(id, view);
        this.focusId ??= id;
        return view;
    }
    /** A car's health and state, for smoke, fire and the ghost blink. */
    setCondition(id, hp, wrecked, ghost) {
        const view = this.cars.get(id);
        if (!view)
            return;
        view.hp = hp;
        view.wrecked = wrecked;
        view.ghost = ghost;
    }
    /**
     * Missiles and mines, drawn at world time `time` — the same interpolated
     * moment the cars are drawn at — with exhaust trails.
     */
    drawWeapons(armoury, time, dt, cars) {
        this.weapons.update(armoury, time, cars);
        for (const m of armoury.missiles) {
            if (m.done || time < m.t0 || time > m.end)
                continue;
            const p = missileAt(m, time);
            this.fx.trail(m, p.x - m.dx * 1.4, p.z - m.dz * 1.4, m.dx, m.dz, m.speed, dt);
        }
    }
    /**
     * The hotlap ghost: a see-through copy of the followed car, posed on the
     * record lap's path, or hidden when there is none. Drawn only — the world
     * never hears of it, so nothing can hit it.
     */
    drawGhost(pose) {
        if (!pose) {
            if (this.ghost)
                this.ghost.root.visible = false;
            return;
        }
        if (!this.ghost)
            this.prepareGhost();
        if (!this.ghost)
            return;
        const st = this.ghostState;
        st.x = pose.x;
        st.z = pose.z;
        st.yaw = pose.yaw;
        st.forward = pose.speed;
        this.ghost.root.visible = true;
        this.ghost.update(st, 1 / 60);
    }
    /**
     * Build the ghost ahead of time, hidden, and get its see-through shaders
     * ready now: made on the spot, at the end of the first lap, the new shader
     * programs stalled the game for a moment just as the ghost appeared.
     * `compile()` alone only starts them; the browser finishes linking a
     * program the first time it is used, so the ghost is also drawn once,
     * unseen, while the track loads.
     */
    prepareGhost() {
        if (this.ghost)
            return;
        const me = this.focusId ? this.cars.get(this.focusId) : undefined;
        if (!me)
            return;
        const g = new CarMesh(me.mesh.colour, false, me.mesh.look);
        g.root.name = 'ghost';
        g.root.traverse((o) => {
            const mesh = o;
            if (!mesh.material)
                return;
            const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => {
                const c = m.clone();
                c.transparent = true;
                c.opacity = 0.38;
                c.depthWrite = false;
                return c;
            });
            mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
            mesh.castShadow = false;
        });
        this.scene.add(g.root);
        this.ghost = g;
        // compile() skips hidden objects: show it for the compile, then hide it.
        g.root.visible = true;
        this.renderer.compile(this.scene, this.rig.camera);
        // The draw that finishes them: the whole scene, so the lights and fog pick
        // the same programs as a race does; the ghost clear (opacity is only a
        // uniform) and drawn wherever the camera points.
        const mats = [];
        const culled = [];
        g.root.traverse((o) => {
            const mesh = o;
            if (!mesh.material)
                return;
            culled.push([mesh, mesh.frustumCulled]);
            mesh.frustumCulled = false;
            mats.push(...(Array.isArray(mesh.material) ? mesh.material : [mesh.material]));
        });
        for (const m of mats)
            m.opacity = 0;
        this.renderer.render(this.scene, this.rig.camera);
        for (const m of mats)
            m.opacity = 0.38;
        for (const [o, c] of culled)
            o.frustumCulled = c;
        g.root.visible = false;
    }
    pickupView = null;
    /** Show a race's pickup boxes. */
    setPickups(pickups) {
        if (this.pickupView)
            this.scene.remove(this.pickupView.group);
        this.pickupView = new PickupView(pickups);
        this.scene.add(this.pickupView.group);
    }
    /** The pickup boxes, at a world time. */
    drawPickups(t, dt) {
        this.pickupView?.update(t, dt);
    }
    /** The train and the crossing, at a race time (seconds since GO). */
    drawHazards(raceTime, dt) {
        this.hazards.update(raceTime, dt);
    }
    /** The winner is home (#23): fireworks and confetti over the line. Returns when each firework goes off. */
    celebrate(x, z) {
        return this.fx.celebrate(x, z);
    }
    /**
     * An explosion at a world point. The camera shakes with it, by how close
     * it is to the car being followed.
     */
    explode(x, z, size, focus) {
        this.fx.explode(x, z, size);
        if (focus) {
            const d = Math.hypot(x - focus.x, z - focus.z);
            this.rig.addTrauma(Math.max(0, 0.55 * size * (1 - d / 40)));
        }
    }
    resize() {
        const w = Math.max(1, this.host.clientWidth);
        const h = Math.max(1, this.host.clientHeight);
        this.renderer.setSize(w, h, false);
        this.rig.setAspect(w / h);
        this.rig.camera.updateProjectionMatrix();
    }
    /**
     * Draw one frame.
     * @param states car id -> the state to draw it in (already interpolated)
     * @param dt real seconds since the last frame
     */
    render(states, dt) {
        for (const [id, state] of states) {
            const view = this.cars.get(id);
            if (!view)
                continue;
            view.mesh.condition(view.wrecked, view.ghost, this.clock);
            view.mesh.update(state, dt);
            this.fx.car(state, dt);
            this.fx.condition(state, view.hp, view.wrecked, dt, view);
            if (id === this.focusId)
                this.jolts(view, state);
        }
        this.fx.update(dt);
        this.clock += dt;
        this.scenery.update(this.clock);
        const focus = this.focusId ? states.get(this.focusId) : undefined;
        // In photo mode the free camera is already posed (see `photoCam`).
        if (focus && !this.photo) {
            this.rig.update(focus, dt);
        }
        this.viewChanged(focus);
        const cam = this.rig.camera;
        cam.updateMatrixWorld();
        if (focus)
            this.shadows.follow(cam);
        this.renderer.getDrawingBufferSize(this.size);
        this.fx.setPointScale(this.size.y / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)));
        this.updateCutaway(states);
        if (this.photo && this.photo.blur > 0) {
            this.dof ??= new DepthOfField(QUALITY[this.quality].antialias);
            this.dof.render(this.renderer, this.scene, cam, this.size, this.photo);
        }
        else {
            this.renderer.render(this.scene, cam);
        }
    }
    /**
     * How far in front of the camera the followed car is, in metres: photo
     * mode's "focus on the car". View depth, not straight-line distance, as the
     * depth of field measures it, so a car near the edge of the frame is sharp too.
     */
    focusDistance(states) {
        const car = this.focusId ? states.get(this.focusId) : undefined;
        if (!car)
            return 20;
        const cam = this.rig.camera;
        cam.updateMatrixWorld();
        return -this.v.set(car.x, car.y + 0.6, car.z).applyMatrix4(cam.matrixWorldInverse).z;
    }
    /**
     * The view depth of whatever is drawn at a point on the screen (CSS
     * pixels, as a click reports them), or null for the sky: photo mode's
     * click to focus. A ray from the lens, through every visible solid mesh;
     * particles, lines and see-through things (the hotlap ghost) are passed through.
     */
    focusAt(clientX, clientY) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0)
            return null;
        const cam = this.rig.camera;
        cam.updateMatrixWorld();
        const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, cam);
        const forward = cam.getWorldDirection(new THREE.Vector3());
        const along = ray.ray.direction.dot(forward);
        for (const hit of ray.intersectObject(this.scene, true)) {
            const mesh = hit.object;
            if (!mesh.isMesh || !shown(mesh))
                continue;
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            const mat = hit.face && Array.isArray(mesh.material) ? mats[hit.face.materialIndex] : mats[0];
            if (!mat || !mat.visible || (mat.transparent && mat.opacity < 0.5))
                continue;
            return hit.distance * along;
        }
        return null;
    }
    /**
     * Draw a frame and hand it back as a PNG. Read in the same task as the
     * render, before the browser presents and clears the drawing buffer, as
     * `samplePixels` does, so no `preserveDrawingBuffer`.
     */
    snapshot(states) {
        this.render(states, 0);
        return new Promise((resolve) => this.renderer.domElement.toBlob(resolve, 'image/png'));
    }
    /**
     * What the experimental views change in the scene: the followed car (and a
     * hotlap ghost on top of it) hidden from a camera inside it, and the
     * cut-away off, which opens buildings around cars for a camera overhead and
     * would cut holes in the street ahead of one behind the car.
     */
    viewChanged(focus) {
        const me = this.focusId ? this.cars.get(this.focusId) : undefined;
        // A photo is taken from outside the car, whatever the race view was.
        if (me && this.rig.hidesOwnCar && !this.photo) {
            me.mesh.root.visible = false;
            me.mesh.blob.visible = false;
            if (this.ghost && focus && Math.hypot(this.ghostState.x - focus.x, this.ghostState.z - focus.z) < 3)
                this.ghost.root.visible = false;
        }
        else if (me) {
            me.mesh.blob.visible = true;
        }
        // The cut-away is for a camera overhead: a photo shows the buildings whole.
        const overhead = this.rig.view === 'overhead' && !this.photo;
        if (overhead !== this.cutawayByView) {
            this.cutawayByView = overhead;
            this.setCutaway(overhead);
        }
    }
    jolts(view, state) {
        if (state.landings !== view.landings) {
            view.landings = state.landings;
            const k = Math.min(1, state.lastLanding / 10);
            if (k > 0.15) {
                this.rig.addTrauma(k * 0.5);
                this.onJolt?.('landing', k);
            }
        }
        if (state.impacts !== view.impacts) {
            view.impacts = state.impacts;
            const k = Math.min(1, state.lastImpact / 25);
            if (k > 0.12) {
                this.rig.addTrauma(k * 0.6);
                this.onJolt?.('crash', k);
            }
        }
    }
    /** Project every car to the screen for the cut-away shader. */
    updateCutaway(states) {
        const cam = this.rig.camera;
        const u = cutawayUniforms;
        u.uCutRes.value.copy(this.size);
        u.uCutAspect.value = cam.aspect;
        this.right.setFromMatrixColumn(cam.matrixWorld, 0);
        let k = 0;
        for (const state of states.values()) {
            if (k >= MAX_CUT_CARS)
                break;
            this.v.set(state.x, state.y + 0.8, state.z);
            const depth = -this.v.clone().applyMatrix4(cam.matrixWorldInverse).z;
            this.v2.copy(this.v).addScaledVector(this.right, CUT_RADIUS_M).project(cam);
            this.v.project(cam);
            const radius = Math.abs(this.v2.x - this.v.x) * cam.aspect;
            u.uCutCars.value[k].set(this.v.x, this.v.y, depth, 1);
            u.uCutRadius.value[k] = radius;
            k++;
        }
        for (; k < MAX_CUT_CARS; k++)
            u.uCutCars.value[k].w = 0;
    }
    /* ---------------------------------------------------------------- debug */
    /**
     * Where a car's name tag goes: a point just past the car's roof toward the
     * top of the screen, whichever way the camera faces, so the tag clears the
     * car at any heading.
     */
    overCar(x, z) {
        const up = new THREE.Vector3().setFromMatrixColumn(this.rig.camera.matrixWorld, 1);
        return this.toScreen(x + up.x * 2.6, 1.5 + up.y * 2.6, z + up.z * 2.6);
    }
    /** Where a world point lands on screen, in CSS pixels from the canvas's top left. */
    toScreen(x, y, z) {
        const p = new THREE.Vector3(x, y, z).project(this.rig.camera);
        const rect = this.renderer.domElement.getBoundingClientRect();
        // Behind a camera that turns with the car, a point projects mirrored
        // through the middle of the screen: turn it back, so a rival's arrow
        // points the way they are, and push it out past the edge.
        if (p.z > 1) {
            p.x = -p.x * 1e3;
            p.y = Math.min(-2, -p.y * 1e3);
        }
        return {
            x: ((p.x + 1) / 2) * rect.width,
            y: ((1 - p.y) / 2) * rect.height,
            onScreen: Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1,
        };
    }
    /**
     * Render now and read back a square of pixels centred on a world point.
     * Reading straight after `render` in the same task means the drawing buffer
     * has not been presented and cleared yet, so no `preserveDrawingBuffer`.
     */
    samplePixels(states, x, y, z, half = 4) {
        this.render(states, 0);
        const p = new THREE.Vector3(x, y, z).project(this.rig.camera);
        const px = Math.round(((p.x + 1) / 2) * this.size.x);
        const py = Math.round(((p.y + 1) / 2) * this.size.y);
        const side = half * 2 + 1;
        const buf = new Uint8Array(side * side * 4);
        const gl = this.renderer.getContext();
        gl.readPixels(px - half, py - half, side, side, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const out = [];
        for (let i = 0; i < side * side; i++)
            out.push([buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2]]);
        return out;
    }
    /** Draw calls in the last frame, including the shadow pass. */
    get drawCalls() {
        return this.renderer.info.render.calls;
    }
    setCutaway(on) {
        cutawayUniforms.uCutEnabled.value = on ? 1 : 0;
    }
    /**
     * Give back everything this race put on the GPU: geometry, materials,
     * textures and the shadow map. The renderer itself is kept for the next
     * race (see `rendererFor`), so its canvas only leaves the page.
     */
    dispose() {
        this.resizeObserver.disconnect();
        this.dof?.dispose();
        this.dof = null;
        this.renderer.domElement.remove();
        for (const view of this.cars.values()) {
            const blob = view.mesh.blob;
            blob.removeFromParent();
            blob.geometry.dispose();
            disposeMaterial(blob.material);
        }
        this.scene.traverse((o) => {
            const mesh = o;
            mesh.geometry?.dispose?.();
            const mat = mesh.material;
            if (Array.isArray(mat))
                mat.forEach(disposeMaterial);
            else if (mat)
                disposeMaterial(mat);
            o.shadow?.dispose();
        });
        if (this.scene.background instanceof THREE.Texture)
            this.scene.background.dispose();
        this.renderer.renderLists.dispose();
    }
}
/** Whether an object is drawn: it and every parent visible. A ray, unlike the renderer, ignores `visible`. */
function shown(o) {
    for (; o; o = o.parent)
        if (!o.visible)
            return false;
    return true;
}
/** Taps in the blur: a spiral out to the widest blur, the same count whatever the screen's size. */
const DOF_TAPS = 96;
/** The widest blur, as a fraction of the screen's height. */
const DOF_MAX = 0.018;
/**
 * Depth of field, for photo mode only: the scene is drawn to a texture with
 * its depth, then onto the screen through a gather blur whose size at each
 * pixel grows with how far it is from the focus (its circle of confusion).
 * A tap from further back only blurs over a nearer pixel as far as that
 * pixel's own blur reaches, so a sharp car does not bleed into a blurred
 * background, nor a blurred background over a sharp car.
 *
 * Built here rather than from three's examples: the page loads three alone
 * from its CDN, and the test rig serves the same one file.
 */
class DepthOfField {
    target;
    material;
    quad;
    scene = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    constructor(antialias) {
        this.target = new THREE.WebGLRenderTarget(1, 1, { samples: antialias ? 4 : 0 });
        this.target.texture.colorSpace = THREE.SRGBColorSpace;
        this.target.depthTexture = new THREE.DepthTexture(1, 1);
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                tColor: { value: this.target.texture },
                tDepth: { value: this.target.depthTexture },
                uNear: { value: 0.1 },
                uFar: { value: 600 },
                uFocus: { value: 10 },
                uAperture: { value: 0 },
                uMaxBlur: { value: 20 },
                uPixel: { value: new THREE.Vector2() },
            },
            vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
            fragmentShader: /* glsl */ `
        #include <packing>
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform float uNear;
        uniform float uFar;
        uniform float uFocus;
        uniform float uAperture;
        uniform float uMaxBlur;
        uniform vec2 uPixel;
        varying vec2 vUv;
        const float GOLDEN = 2.39996323;
        float dist(vec2 uv) {
          return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar);
        }
        // Circle of confusion, in pixels.
        float coc(float d) {
          return clamp(uAperture * abs(d - uFocus) / max(d, 0.05) * uMaxBlur * 1.5, 0.0, uMaxBlur);
        }
        void main() {
          float centreDepth = dist(vUv);
          float centreSize = coc(centreDepth);
          vec3 colour = texture2D(tColor, vUv).rgb;
          float total = 1.0;
          float grow = uMaxBlur * uMaxBlur / (2.0 * float(${DOF_TAPS}));
          float radius = grow;
          // Each pixel's spiral starts at its own angle: too few taps for a wide blur then read as grain, not ghosts.
          float angle = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
          for (int i = 0; i < ${DOF_TAPS}; i++) {
            vec2 uv = vUv + vec2(cos(angle), sin(angle)) * uPixel * radius;
            vec3 sampleColour = texture2D(tColor, uv).rgb;
            float sampleDepth = dist(uv);
            float sampleSize = coc(sampleDepth);
            if (sampleDepth > centreDepth) sampleSize = clamp(sampleSize, 0.0, centreSize * 2.0);
            float m = smoothstep(radius - 0.5, radius + 0.5, sampleSize);
            colour += mix(colour / total, sampleColour, m);
            total += 1.0;
            radius += grow / radius;
            angle += GOLDEN;
          }
          gl_FragColor = linearToOutputTexel(vec4(colour / total, 1.0));
        }`,
            depthTest: false,
            depthWrite: false,
        });
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this.quad.frustumCulled = false;
        this.scene.add(this.quad);
    }
    render(renderer, scene, camera, size, photo) {
        if (this.target.width !== size.x || this.target.height !== size.y)
            this.target.setSize(size.x, size.y);
        const u = this.material.uniforms;
        u.uNear.value = camera.near;
        u.uFar.value = camera.far;
        u.uFocus.value = photo.focus;
        u.uAperture.value = photo.blur;
        u.uMaxBlur.value = Math.max(4, size.y * DOF_MAX);
        u.uPixel.value.set(1 / size.x, 1 / size.y);
        renderer.setRenderTarget(this.target);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        renderer.render(this.scene, this.camera);
    }
    dispose() {
        this.target.depthTexture?.dispose();
        this.target.dispose();
        this.material.dispose();
        this.quad.geometry.dispose();
    }
}
//# sourceMappingURL=GameView.js.map