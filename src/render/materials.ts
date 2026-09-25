import * as THREE from 'three';

/** How many cars the cut-away tracks at once — the room cap. */
export const MAX_CUT_CARS = 6;

/**
 * Shared uniforms for the occlusion cut-away. One set for the whole scene:
 * every tall-occluder material reads the same car positions, so updating them
 * once a frame updates every building, tree and lamp.
 */
export const cutawayUniforms = {
  /** Per car: NDC x, NDC y, view depth (metres), strength 0..1. */
  uCutCars: { value: Array.from({ length: MAX_CUT_CARS }, () => new THREE.Vector4(0, 0, 0, 0)) },
  /** Per car: hole radius, in NDC-height units. */
  uCutRadius: { value: new Array<number>(MAX_CUT_CARS).fill(0) },
  /** Drawing-buffer size in device pixels, to turn gl_FragCoord into NDC. */
  uCutRes: { value: new THREE.Vector2(1, 1) },
  uCutAspect: { value: 1 },
  /** Global switch, for the pixel test's "without" half. */
  uCutEnabled: { value: 1 },
};

type Patcher = (shader: THREE.WebGLProgramParametersWithUniforms) => void;

/**
 * Compose several `onBeforeCompile` patches on one material. three.js allows
 * one hook per material; the building shader needs two (windows and the
 * cut-away), and the cache key has to name both or three would share one
 * compiled program between differently patched materials.
 */
function patch(material: THREE.Material, key: string, fn: Patcher): void {
  const prev = material.onBeforeCompile.bind(material);
  const prevKey = material.customProgramCacheKey.bind(material);
  const had = (material.userData.patches as string[] | undefined) ?? [];
  material.userData.patches = [...had, key];
  material.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    fn(shader);
  };
  material.customProgramCacheKey = () => `${prevKey()}|${key}`;
}

/**
 * The occlusion cut-away.
 *
 * Tall things between the camera and a car must never hide it. Rather than
 * fading whole buildings — which pops a big tower out of existence because
 * one corner of it covers a car — each fragment asks: am I nearer the camera
 * than a car, and close to that car on screen? If so it is discarded through a
 * 4x4 ordered-dither pattern whose density falls off with screen distance.
 *
 * That is screen-door transparency: no sorting, depth stays correct, and the
 * hole is continuous in every input — car position, camera position, depth —
 * so nothing ever pops. Shadows are untouched, because the shadow pass uses
 * its own depth material: the tower still shades the car it has been cut away
 * over, which is exactly right.
 */
export function applyCutaway(material: THREE.Material): void {
  patch(material, 'cutaway', (shader) => {
    Object.assign(shader.uniforms, cutawayUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vCutDepth;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCutDepth = -mvPosition.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vCutDepth;
uniform vec4 uCutCars[${MAX_CUT_CARS}];
uniform float uCutRadius[${MAX_CUT_CARS}];
uniform vec2 uCutRes;
uniform float uCutAspect;
uniform float uCutEnabled;
float cutBayer4(vec2 p) {
  const float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  ivec2 q = ivec2(mod(p, 4.0));
  return (m[q.x + q.y * 4] + 0.5) / 16.0;
}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
if (uCutEnabled > 0.5) {
  vec2 cutNdc = gl_FragCoord.xy / uCutRes * 2.0 - 1.0;
  float cut = 0.0;
  for (int i = 0; i < ${MAX_CUT_CARS}; i++) {
    vec4 c = uCutCars[i];
    if (c.w <= 0.0) continue;
    // Only what is in front of the car: fades in over 1.5-4 m of depth so the
    // boundary where a wall passes the car's depth is soft, not a seam.
    float inFront = smoothstep(1.5, 4.0, c.z - vCutDepth);
    if (inFront <= 0.0) continue;
    vec2 dd = vec2((cutNdc.x - c.x) * uCutAspect, cutNdc.y - c.y);
    float r = uCutRadius[i];
    float k = 1.0 - smoothstep(r * 0.5, r, length(dd));
    cut = max(cut, k * c.w * inFront);
  }
  // Capped just short of fully clear: a faint dotted ghost of the building
  // stays, so the hole reads as "you are behind this" rather than as a
  // missing building.
  if (cut > 0.0 && cutBayer4(gl_FragCoord.xy) < cut * 0.94) discard;
}`,
      );
  });
}

/**
 * Towers: flat Lambert with procedural windows.
 *
 * The geometry is a unit box standing on its base; each instance scales it to
 * the building's footprint and height. The shader recovers those scales from
 * the instance matrix so that windows come out a constant size in metres
 * whatever the building's shape — floors every 3.2 m, bays every 2.8 m — and
 * lights a hashed subset of them per building, so the city glows at dusk with
 * no textures at all.
 */
export function towerMaterial(opts: { roof: number; warm: number; cool: number; lit: number; glass?: number; glassMix?: number }): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  patch(mat, 'tower', (shader) => {
    shader.uniforms.uRoof = { value: new THREE.Color(opts.roof) };
    shader.uniforms.uWarm = { value: new THREE.Color(opts.warm) };
    shader.uniforms.uCool = { value: new THREE.Color(opts.cool) };
    shader.uniforms.uLit = { value: opts.lit };
    shader.uniforms.uGlass = { value: new THREE.Color(opts.glass ?? 0x000000) };
    shader.uniforms.uGlassMix = { value: opts.glassMix ?? 0 };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aSeed;
varying vec3 vBuild;
varying vec3 vBuildN;
varying float vBuildH;
varying float vSeed;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 bScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
#else
  vec3 bScale = vec3(1.0);
#endif
vBuild = position * bScale;
vBuildN = normal;
vBuildH = bScale.y;
vSeed = aSeed;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uRoof;
uniform vec3 uWarm;
uniform vec3 uCool;
uniform float uLit;
uniform vec3 uGlass;
uniform float uGlassMix;
varying vec3 vBuild;
varying vec3 vBuildN;
varying float vBuildH;
varying float vSeed;
// A hash of whole numbers that stays whole-pane steady: no sin() of big
// arguments, whose last bits differ from pixel to pixel on some GPUs.
float bHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  if (vBuildN.y > 0.5) {
    // Roof: the building's own colour, knocked back and mixed towards the
    // theme's roof tone, so low blocks still read against the street.
    diffuseColor.rgb = mix(diffuseColor.rgb * 0.8, uRoof, 0.35);
  } else {
    float along = abs(vBuildN.x) > 0.5 ? vBuild.z : vBuild.x;
    float face = abs(vBuildN.x) > 0.5 ? sign(vBuildN.x) : 2.0 * sign(vBuildN.z);
    float floorY = floor(vBuild.y / 3.2);
    float bay = floor(along / 2.8);
    vec2 cell = vec2(fract(along / 2.8), fract(vBuild.y / 3.2));
    bool isWin = cell.x > 0.18 && cell.x < 0.82 && cell.y > 0.28 && cell.y < 0.78
      && floorY >= 1.0 && vBuild.y < vBuildH - 1.4;
    // Darker at street level: a cheap stand-in for ambient occlusion.
    diffuseColor.rgb *= mix(0.55, 1.0, clamp(vBuild.y / 14.0, 0.0, 1.0));
    if (isWin) {
      // The seed is per building but arrives interpolated: round it to a whole
    // number so every pixel of a pane hashes the same.
    float h = bHash(vec3(floorY, bay + face * 17.0, floor(vSeed * 97.0 + 0.5)));
      // Dark at dusk; by day, sky-tinted glass, a little different per pane.
      diffuseColor.rgb = mix(diffuseColor.rgb * 0.45, uGlass * (0.85 + 0.3 * fract(h * 3.7)), uGlassMix);
      if (h < uLit) {
        vec3 glow = vSeed > 0.5 ? uWarm : uCool;
        totalEmissiveRadiance += glow * (0.55 + 0.45 * fract(h * 7.31));
      }
    }
  }
}`,
      );
  });
  return mat;
}

/** Plain flat-shaded vertex-coloured Lambert, for everything else solid. */
export function flatMaterial(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
}
