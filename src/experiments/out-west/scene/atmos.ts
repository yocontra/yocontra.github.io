/**
 * The shared atmosphere: one set of uniforms that the sky dome, the aerial-perspective post pass,
 * the cloud shadows on the ground and town, and the plants' wind sway all read, so the clouds that
 * drift across the sky are the same clouds whose shadows slide over the street, and the haze the
 * town fades into is the sky's own horizon colour.
 *
 * Each scene sets these once per time of day (World.apply, the Frontier's setup) and advances
 * `time` every frame. Nothing here allocates per frame.
 */
import type { Material, WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three'
import { Color, Uniform, Vector2, Vector3 } from 'three'

/** Altitude of the cumulus layer (m): the sky samples it, the ground's cloud shadows project onto it. */
export const CLOUD_ALTITUDE = 700

export const ATMOS = {
  /** Seconds since load (wraps at an hour so float precision never shows in the noise). */
  atmTime: new Uniform(0),
  /** Cloud drift, m/s, over the ground. */
  atmWind: new Uniform(new Vector2(7.5, 2.5)),
  /** How much of the sky the cumulus covers, 0..1. */
  atmCover: new Uniform(0.42),
  /** How much a cloud's shadow takes off the direct sun, 0..1. */
  atmShadowK: new Uniform(0.38),
  /** Toward the sun (or the moon at night), world space, normalised. */
  atmSunDir: new Uniform(new Vector3(0, 1, 0)),
  atmSunColor: new Uniform(new Color(1, 0.95, 0.85)),
  /** The horizon / haze colour and the zenith colour (linear). */
  atmHorizon: new Uniform(new Color(0.8, 0.7, 0.55)),
  atmZenith: new Uniform(new Color(0.1, 0.25, 0.6)),
  /** Warm in-scatter around the sun in the haze (0 at night). */
  atmGlow: new Uniform(0.5),
  /** Foliage wind: strength (0..1.5) and direction (xz). */
  atmGust: new Uniform(0.6),
  atmGustDir: new Uniform(new Vector2(0.9, 0.42)),
}

/** Advance the clock (call once a frame). */
export function tickAtmos(dt: number): void {
  ATMOS.atmTime.value = (ATMOS.atmTime.value + dt) % 3600
}

/** Noise and the cloud field, shared by every shader that needs the clouds. */
export const CLOUD_GLSL = /* glsl */ `
uniform float atmTime;
uniform vec2 atmWind;
uniform float atmCover;
uniform float atmShadowK;
uniform vec3 atmSunDir;
float atmHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float atmNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(atmHash(i), atmHash(i + vec2(1.0, 0.0)), f.x),
    mix(atmHash(i + vec2(0.0, 1.0)), atmHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float atmFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * atmNoise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return s;
}
// cumulus density (0..1) over a point on the ground plane (metres), drifting with the wind
float atmCloudAt(vec2 xz) {
  vec2 p = (xz - atmWind * atmTime) * 0.0021;
  vec2 w = vec2(atmNoise(p * 0.7 + 3.1), atmNoise(p * 0.7 - 7.3));
  float n = atmFbm(p + w * 0.6);
  float lo = 0.78 - atmCover * 0.42;
  return smoothstep(lo, lo + 0.2, n);
}
// how much direct sun reaches this world point through the clouds
float atmCloudShadow(vec3 wp) {
  vec3 s = normalize(atmSunDir);
  vec2 xz = wp.xz + s.xz * ((${CLOUD_ALTITUDE.toFixed(1)} - wp.y) / max(s.y, 0.25));
  return 1.0 - atmShadowK * atmCloudAt(xz);
}
`

/**
 * The haze colour seen along a direction: the horizon colour, a touch of the zenith higher up, and
 * the sun's warm in-scatter toward it. The sky dome's horizon and the aerial-perspective pass both
 * use it, so the town fades into exactly the sky behind it.
 */
export const HAZE_GLSL = /* glsl */ `
uniform vec3 atmSunColor;
uniform vec3 atmHorizon;
uniform vec3 atmZenith;
uniform float atmGlow;
vec3 atmHaze(vec3 d, vec3 sunDir) {
  float h = clamp(d.y, 0.0, 1.0);
  vec3 c = mix(atmHorizon, atmZenith, smoothstep(0.0, 0.5, h) * 0.6);
  float s = max(dot(d, sunDir), 0.0);
  vec2 dh = normalize(d.xz + vec2(1e-5));
  vec2 sh = normalize(sunDir.xz + vec2(1e-5));
  float az = max(dot(dh, sh), 0.0);
  float low = 1.0 - smoothstep(0.05, 0.55, sunDir.y);
  c += atmSunColor * atmGlow * (pow(s, 6.0) * 0.45 + pow(az, 3.0) * low * 0.35 * exp(-h * 5.0));
  return c;
}
`

/** Add the atmosphere uniforms to a patched material's shader. */
export function bindAtmos(shader: WebGLProgramParametersWithUniforms): void {
  Object.assign(shader.uniforms, ATMOS)
}

/**
 * Patch a lit material so moving cloud shadows dim its direct sun light (never the sky fill). Chains
 * onto the material's own onBeforeCompile; the program cache key gains `-cs`.
 */
export function withCloudShadow(mat: Material): void {
  if (mat.userData.cloudShadow) {
    return
  }
  mat.userData.cloudShadow = true
  const prev = mat.onBeforeCompile.bind(mat)
  const prevKey = mat.customProgramCacheKey.bind(mat)
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, r: WebGLRenderer) => {
    prev(shader, r)
    bindAtmos(shader)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vAtmW;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
{
  vec4 atmW = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    atmW = batchingMatrix * atmW;
  #endif
  #ifdef USE_INSTANCING
    atmW = instanceMatrix * atmW;
  #endif
  vAtmW = (modelMatrix * atmW).xyz;
}`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vAtmW;\n${CLOUD_GLSL}`)
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
{
  float atmCs = atmCloudShadow(vAtmW);
  reflectedLight.directDiffuse *= atmCs;
  reflectedLight.directSpecular *= atmCs;
}`,
      )
  }
  mat.customProgramCacheKey = () => `${prevKey()}-cs`
  mat.needsUpdate = true
}
