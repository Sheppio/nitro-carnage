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
    constructor(host, track, quality) {
        this.host = host;
        this.track = track;
        this.quality = quality;
        const preset = QUALITY[quality];
        this.renderer = new THREE.WebGLRenderer({ antialias: preset.antialias, powerPreference: 'high-performance' });
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
        this.scenery = new Scenery(track, theme);
        this.scene.add(this.scenery.group);
        this.fx = new Fx(preset.tyreMarks, preset.particles);
        this.hazards = new HazardView(track);
        this.scene.add(this.fx.group, this.weapons.group, this.hazards.group);
        this.rig = new CameraRig(1);
        this.rig.setFar(preset.drawDistance + 60);
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
        if (!this.ghost) {
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
        }
        const st = this.ghostState;
        st.x = pose.x;
        st.z = pose.z;
        st.yaw = pose.yaw;
        st.forward = pose.speed;
        this.ghost.root.visible = true;
        this.ghost.update(st, 1 / 60);
    }
    /** The train and the crossing, at a race time (seconds since GO). */
    drawHazards(raceTime, dt) {
        this.hazards.update(raceTime, dt);
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
        const focus = this.focusId ? states.get(this.focusId) : undefined;
        if (focus) {
            this.rig.update(focus, dt);
            this.shadows.follow(focus.x, focus.z);
        }
        const cam = this.rig.camera;
        cam.updateMatrixWorld();
        this.renderer.getDrawingBufferSize(this.size);
        this.fx.setPointScale(this.size.y / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)));
        this.updateCutaway(states);
        this.renderer.render(this.scene, cam);
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
    /** Where a world point lands on screen, in CSS pixels from the canvas's top left. */
    toScreen(x, y, z) {
        const p = new THREE.Vector3(x, y, z).project(this.rig.camera);
        const rect = this.renderer.domElement.getBoundingClientRect();
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
    dispose() {
        this.resizeObserver.disconnect();
        this.renderer.dispose();
        this.renderer.domElement.remove();
        for (const view of this.cars.values())
            view.mesh.blob.removeFromParent();
        this.scene.traverse((o) => {
            const mesh = o;
            mesh.geometry?.dispose?.();
        });
    }
}
//# sourceMappingURL=GameView.js.map