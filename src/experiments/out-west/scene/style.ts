// biome-ignore-all lint/style/useNamingConvention: keys mirror source asset material names (e.g. Brown_02) and Turnstile/three.js option names
import { Color, type MeshStandardMaterial } from 'three'
import type { Swatch } from './atlas.ts'

/**
 * Clean stylized character shading (replaces the old triplanar fabric pass):
 * a fresnel rim light tinted by the time of day, and a soft contact darkening
 * toward the feet that grounds the low-poly figures. No textures, no
 * derivatives, nothing that can alias.
 */

/** Shared by every stylized material; World.apply() drives it per time of day. */
export const RIM = {
  color: { value: new Color(0xff_e2_b0) },
  strength: { value: 0.25 },
}

/**
 * Skin is flagged by adding this to its per-vertex rim strength (styMat.y);
 * shade.ts decodes it for the warm subsurface wrap. Rim strengths stay < 5.
 */
export const SKIN_FLAG = 10

export interface Floor {
  value: number
}

export type Fabric = 'leather' | 'wool' | 'linen' | 'denim' | 'hessian' | 'skin'

/**
 * Surface response per kind of material: roughness (on untextured surfaces), how much rim it
 * catches, and the atlas swatch a procedural garment of that kind is woven from.
 */
export const FABRIC: Record<Fabric, { roughness: number; rim: number; swatch: Swatch }> = {
  leather: { roughness: 0.55, rim: 1.15, swatch: 'leather' },
  wool: { roughness: 0.92, rim: 0.85, swatch: 'wool' },
  linen: { roughness: 0.86, rim: 1.0, swatch: 'linen' },
  denim: { roughness: 0.8, rim: 0.95, swatch: 'linen' },
  hessian: { roughness: 0.95, rim: 0.8, swatch: 'hessian' },
  skin: { roughness: 0.62, rim: 1.0, swatch: 'plain' },
}

/** Which kind of surface each source material is. */
export const FABRIC_BY_MATERIAL: Record<string, Fabric> = {
  Suit: 'wool',
  Tie: 'wool',
  White: 'linen',
  Black: 'leather',
  Grey: 'leather',
  Green: 'wool',
  LightGreen: 'linen',
  Brown: 'hessian',
  Brown2: 'leather',
  Brown_02: 'leather',
  LightBrown: 'linen',
  LightBlue: 'denim',
  Worker_Vest: 'leather',
  Red_Dark: 'leather',
  Beige: 'linen',
  DarkBrown: 'leather',
  Coat: 'wool',
  Poncho: 'hessian',
  Felt: 'wool',
  Skin: 'skin',
  // the textured bases (tools/build-characters.ts garment names)
  Shirt: 'linen',
  Sleeves: 'linen',
  Pants: 'denim',
  Boots: 'leather',
  Belt: 'leather',
  Bracer: 'leather',
  Pauldron: 'leather',
  Hair: 'wool',
  Brows: 'wool',
  Beard: 'wool',
}

/**
 * Roughness multiplier on the character atlas's own roughness, per kind of surface. The source
 * maps put skin at ~0.78 and leather at ~0.77, which reads as chalk: skin wants ~0.55 (an oily
 * sheen on the nose, brow and cheekbones) and worn leather ~0.62. Cloth keeps the map's value.
 */
const ATLAS_ROUGHNESS: Partial<Record<Fabric, number>> = { skin: 0.72, leather: 0.8 }

/** Roughness multiplier (styMat.x) for an atlas-textured part named after its source material. */
export function atlasRoughness(materialName: string): number {
  const kind = FABRIC_BY_MATERIAL[materialName]
  return (kind && ATLAS_ROUGHNESS[kind]) ?? 1
}

/** Small deterministic hash of a string to 0..1. */
export function hash01(s: string): number {
  let h = 2_166_136_261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16_777_619)
  }
  return ((h >>> 0) % 10_007) / 10_007
}

/**
 * Subtle per-material variation: a nudge of lightness and warmth, and a
 * roughness that depends on the kind of surface. `seed` keeps it stable for a
 * given outlaw so he looks the same every time.
 */
export function vary(mat: MeshStandardMaterial, seed: string): void {
  const kind = FABRIC_BY_MATERIAL[mat.name]
  const f = kind ? FABRIC[kind] : null
  const r = hash01(`${seed}:${mat.name}`)
  const r2 = hash01(`${mat.name}:${seed}`)
  const hsl = { h: 0, s: 0, l: 0 }
  mat.color.getHSL(hsl)
  mat.color.setHSL(
    (hsl.h + (r2 - 0.5) * 0.012 + 1) % 1,
    Math.min(1, hsl.s * (0.94 + r * 0.1)),
    Math.min(1, hsl.l * (0.95 + r * 0.1)),
  )
  mat.roughness = f ? f.roughness + (r - 0.5) * 0.08 : Math.max(0.6, mat.roughness)
  mat.metalness = 0
  mat.userData.rim = (f ? f.rim : 1) + (kind === 'skin' ? SKIN_FLAG : 0)
}

/** Install the rim + grounding shader on a character material. */
export function stylize(mat: MeshStandardMaterial, floor: Floor): void {
  if (mat.userData.stylized) {
    return
  }
  mat.userData.stylized = true
  const rimK = (mat.userData.rim as number | undefined) ?? 1
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.styRim = RIM.color
    shader.uniforms.styRimK = RIM.strength
    shader.uniforms.styRimMat = { value: rimK }
    shader.uniforms.styFloor = floor
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vStyY;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvStyY = (modelMatrix * vec4(transformed, 1.0)).y;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 styRim;
uniform float styRimK;
uniform float styRimMat;
uniform float styFloor;
varying float vStyY;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
// soft contact darkening toward the boots
diffuseColor.rgb *= mix(0.72, 1.0, smoothstep(0.0, 0.85, vStyY - styFloor));`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float ndv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
  float fr = smoothstep(0.35, 1.0, 1.0 - ndv);
  totalEmissiveRadiance += styRim * (styRimK * styRimMat * fr) * (0.55 + 0.45 * diffuseColor.rgb);
}`,
      )
  }
  mat.customProgramCacheKey = () => 'ow-stylized'
  mat.needsUpdate = true
}
