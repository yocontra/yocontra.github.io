/**
 * Quick Draw street materials: real PBR from the Poly Haven sets (ARM =
 * ambient occlusion, roughness, metalness) plus a "town AO" term, the stand-in
 * for a Blender lightmap bake while the Blender pipeline is unavailable.
 *
 * Town AO darkens only INDIRECT light (the IBL probe and the hemisphere fill),
 * exactly as a baked AO/sky-visibility map would: under the porch roofs, at
 * the foot of every wall, and on the street toward the boardwalks. Direct sun
 * and its real-time shadow are untouched, so nothing double-darkens.
 */
import type { MeshStandardMaterial, WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three'
import { loadTex } from './textures.ts'

const ROOT = '/experiments/out-west/3d/tex'

const TOWN_AO = /* glsl */ `
varying vec3 vTownP;
varying vec3 vTownN;
float townAO(vec3 p, vec3 n) {
  float ax = abs(p.x);
  float inTown = step(-56.0, p.z) * step(p.z, 44.0);
  // under the porch roofs: street side of the facades, below the awnings
  float porch = smoothstep(8.7, 9.3, ax) * (1.0 - smoothstep(11.3, 11.7, ax))
    * (1.0 - smoothstep(2.95, 3.2, p.y)) * inTown;
  // contact: the foot of every vertical face
  float vertical = 1.0 - abs(n.y);
  float foot = vertical * (1.0 - smoothstep(0.0, 1.4, p.y));
  // the street falls into the facades' shade toward the boardwalks
  float lane = step(0.5, n.y) * smoothstep(5.5, 9.0, ax) * inTown * (1.0 - smoothstep(0.4, 0.6, p.y));
  return clamp(1.0 - porch * 0.5 - foot * 0.35 - lane * 0.3, 0.3, 1.0);
}
`

function patch(shader: WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vTownP;\nvarying vec3 vTownN;')
    .replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
vTownP = (modelMatrix * vec4(transformed, 1.0)).xyz;
vTownN = normalize(mat3(modelMatrix) * objectNormal);`,
    )
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${TOWN_AO}`)
    .replace(
      '#include <aomap_fragment>',
      `#include <aomap_fragment>
{
  float tao = townAO(vTownP, normalize(vTownN));
  reflectedLight.indirectDiffuse *= tao;
  reflectedLight.indirectSpecular *= tao * tao;
}`,
    )
}

/** Chain the town-AO patch onto a material's own onBeforeCompile (if any). */
export function withTownAO(mat: MeshStandardMaterial, key: string): void {
  const prev = mat.onBeforeCompile.bind(mat)
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, r: WebGLRenderer) => {
    prev(shader, r)
    patch(shader)
  }
  mat.customProgramCacheKey = () => `ow-town-${key}`
  mat.needsUpdate = true
}

/**
 * Load the ARM maps and attach them (AO in R, roughness in G). Loads in the
 * background: the street renders with flat roughness until they arrive.
 */
export function attachArm(mat: MeshStandardMaterial, name: string, aoIntensity: number): void {
  loadTex(`${ROOT}/${name}_arm.webp`, false, 4)
    .then((arm) => {
      const src = mat.map
      if (src) {
        arm.repeat.copy(src.repeat)
        arm.offset.copy(src.offset)
      }
      mat.aoMap = arm
      mat.aoMapIntensity = aoIntensity
      mat.roughnessMap = arm
      mat.roughness = 1
      mat.needsUpdate = true
    })
    .catch(() => undefined)
}
