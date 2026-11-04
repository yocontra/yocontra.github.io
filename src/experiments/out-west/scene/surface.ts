/**
 * Surface detail for the shared props that shipped flat-coloured (a palette swatch or a plain
 * colour): rocks get the ground's photographic texture triplanar-mapped over their sandstone
 * colour plus strata bands, hay and straw get fibres, the old GLB cactus gets ribs. No new
 * textures: the ground set is already resident in both scenes. Every patched material is flagged
 * `userData.procedural` so the texture audit counts it as textured.
 */
import {
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  RepeatWrapping,
  type Texture,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three'
import { withCloudShadow } from './atmos.ts'

const WORLD_NORMAL = /* glsl */ `
{
  vec3 wn = objectNormal;
  #ifdef USE_INSTANCING
    wn = mat3(instanceMatrix) * wn;
  #endif
  vSurfN = normalize(mat3(modelMatrix) * wn);
}
`

function patch(
  mat: MeshStandardMaterial,
  key: string,
  frag: string,
  uniforms: Record<string, { value: unknown }>,
): void {
  mat.userData.procedural = true
  const prev = mat.onBeforeCompile.bind(mat)
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, r: WebGLRenderer) => {
    prev(shader, r)
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurfN;')
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${WORLD_NORMAL}`)
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vSurfN;\nuniform sampler2D surfTex;',
      )
      .replace('#include <color_fragment>', `#include <color_fragment>\n${frag}`)
  }
  mat.customProgramCacheKey = () => `ow-surf-${key}`
  // cloud shadows chain after (they provide vAtmW, the world position, and the noise)
  withCloudShadow(mat)
}

const ROCK_GLSL = /* glsl */ `
{
  vec3 n = normalize(vSurfN);
  vec3 w = pow(abs(n), vec3(4.0));
  w /= w.x + w.y + w.z;
  vec3 p = vAtmW * 0.55;
  vec3 t = texture2D(surfTex, p.zy).rgb * w.x + texture2D(surfTex, p.xz).rgb * w.y + texture2D(surfTex, p.xy).rgb * w.z;
  // the dirt photo's mean, so the rock keeps its own hue and takes only the grain
  float lum = dot(t, vec3(0.3, 0.5, 0.2)) / 0.12;
  float strata = 0.86 + 0.14 * sin(vAtmW.y * 9.0 + atmNoise(vAtmW.xz * 1.3) * 3.0);
  diffuseColor.rgb *= clamp(lum, 0.55, 1.35) * strata;
  // dust settles on the tops
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.15, 1.0, 0.85), smoothstep(0.6, 0.95, n.y) * 0.5);
}
`

const STRAW_GLSL = /* glsl */ `
{
  vec3 n = normalize(vSurfN);
  vec2 q = abs(n.y) > 0.7 ? vAtmW.xz * 30.0 : vec2((vAtmW.x + vAtmW.z) * 55.0, vAtmW.y * 2.5);
  float f = atmNoise(q) * 0.6 + atmNoise(q * vec2(2.3, 1.7) + 4.0) * 0.4;
  diffuseColor.rgb *= 0.7 + 0.5 * f;
  diffuseColor.rgb *= mix(vec3(1.0), vec3(0.92, 0.86, 0.7), atmNoise(vAtmW.xz * 3.0 + vAtmW.y));
}
`

const RIBS_GLSL = /* glsl */ `
{
  float a = atan(vSurfN.z, vSurfN.x);
  diffuseColor.rgb *= 0.78 + 0.3 * smoothstep(-0.2, 0.6, sin(a * 7.0)) + 0.1 * atmNoise(vAtmW.xz * 40.0 + vAtmW.y * 30.0);
}
`

/** Give the props GLB's flat rock, hay and cactus materials real surface detail (both scenes). */
export function surfaceProps(scenes: readonly Object3D[], ground: Texture): void {
  const tex = ground.clone()
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.needsUpdate = true
  const done = new Map<Material, MeshStandardMaterial>()
  const kinds: Record<string, [string, string]> = {
    rock: ['rock', ROCK_GLSL],
    hay: ['straw', STRAW_GLSL],
    cactus: ['ribs', RIBS_GLSL],
  }
  // by node (rocks share the palette atlas with other props) or by material name
  const byMat: Record<string, [string, string]> = {
    Hay: ['straw', STRAW_GLSL],
    Green: ['ribs', RIBS_GLSL],
  }
  for (const s of scenes) {
    s.traverse((o) => {
      const m = o as Mesh
      const matName = ((m as { material?: Material }).material as Material | undefined)?.name ?? ''
      const kind = kinds[o.name] ?? kinds[o.parent?.name ?? ''] ?? byMat[matName]
      if (!(kind && (m as { isMesh?: boolean }).isMesh)) {
        return
      }
      const src = m.material as Material
      let mat = done.get(src)
      if (!mat) {
        mat = (src as MeshStandardMaterial).clone()
        mat.name = src.name
        patch(mat, kind[0], kind[1], { surfTex: { value: tex } })
        done.set(src, mat)
      }
      m.material = mat
    })
  }
}

const GLASS_GLSL = /* glsl */ `
{
  // dust and grime gather in streaks down each pane
  float grime = atmNoise(vec2(vAtmW.x * 9.0 + vAtmW.z * 9.0, vAtmW.y * 2.0)) * 0.6
    + atmNoise((vAtmW.xz + vAtmW.y) * 23.0) * 0.4;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.13, 0.1), grime * 0.45);
  surfGrime = grime;
}
`

/**
 * Old window glass: a dark, slightly reflective pane (it picks up the sky probe), dulled by grime
 * and dust streaks. Night glow comes from the scenes' own lit-window material.
 */
export function glassLook(mat: MeshStandardMaterial): void {
  mat.userData.procedural = true
  mat.roughness = 0.1
  mat.metalness = 0.35
  mat.envMapIntensity = 1.4
  const prev = mat.onBeforeCompile.bind(mat)
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, r: WebGLRenderer) => {
    prev(shader, r)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nfloat surfGrime = 0.0;')
      .replace('#include <color_fragment>', `#include <color_fragment>\n${GLASS_GLSL}`)
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.6, surfGrime * 0.7);',
      )
  }
  mat.customProgramCacheKey = () => 'ow-surf-glass'
  withCloudShadow(mat)
}

/** Sandstone on any lit material (the mesas): the ground photo triplanar, strata, dusty tops. */
export function rockLook(mat: MeshStandardMaterial, ground: Texture): void {
  const tex = ground.clone()
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.needsUpdate = true
  patch(mat, 'rock', ROCK_GLSL, { surfTex: { value: tex } })
}

const SACK_GLSL = /* glsl */ `
{
  // a coarse hessian weave
  vec2 q = (vAtmW.xz + vAtmW.y) * 140.0;
  float weave = abs(sin(q.x)) * abs(sin(q.y));
  diffuseColor.rgb *= 0.78 + 0.3 * weave + 0.12 * atmNoise(vAtmW.xz * 30.0 + vAtmW.y * 20.0);
}
`

/** Hessian sacking (the money bags). */
export function sackLook(mat: MeshStandardMaterial): void {
  patch(mat, 'sack', SACK_GLSL, {})
}

const STRONGBOX_GLSL = /* glsl */ `
{
  // oak boards with grain, bound by two iron straps
  vec3 n = normalize(vSurfN);
  float along = abs(n.x) > 0.5 ? vAtmW.z : vAtmW.x;
  float board = fract(vAtmW.y * 6.5 + (abs(n.y) > 0.5 ? along * 6.5 : 0.0));
  float seam = smoothstep(0.0, 0.06, board) * smoothstep(1.0, 0.94, board);
  float grain = 0.82 + 0.25 * atmNoise(vec2(along * 3.0, vAtmW.y * 60.0));
  diffuseColor.rgb *= mix(0.55, 1.0, seam) * grain;
  float y = fract(vAtmW.y);
  float strap = step(0.08, y) * step(y, 0.16) + step(0.52, y) * step(y, 0.6);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.05, 0.055), strap);
}
`

/** The Frontier strongbox: banded oak boards and iron straps. */
export function strongboxLook(mat: MeshStandardMaterial): void {
  patch(mat, 'strongbox', STRONGBOX_GLSL, {})
}
