import type { MeshStandardMaterial, Texture } from 'three'

export type ClothKey = 'denim' | 'leather' | 'wool' | 'linen' | 'hessian'

export interface ClothSpec {
  tex: Texture
  /** Texture repeats per object-space unit (bind pose). */
  scale: number
  /** Albedo modulation 0..1. */
  amount: number
  /** Bump strength. */
  bump: number
  roughness: number
}

/**
 * Real fabric/leather detail on the untextured low-poly characters: a
 * triplanar sample of a Poly Haven scan in bind-pose object space (so it sticks
 * to the cloth when skinned), used for albedo variation, roughness and a
 * derivative bump. No UVs needed.
 */
export function applyCloth(mat: MeshStandardMaterial, c: ClothSpec): void {
  mat.roughness = c.roughness
  mat.onBeforeCompile = (shader) => {
    shader.uniforms['clothMap'] = { value: c.tex }
    shader.uniforms['clothScale'] = { value: c.scale }
    shader.uniforms['clothAmt'] = { value: c.amount }
    shader.uniforms['clothBump'] = { value: c.bump }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vClothP;\nvarying vec3 vClothN;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvClothP = position;\nvClothN = normal;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D clothMap;
uniform float clothScale;
uniform float clothAmt;
uniform float clothBump;
varying vec3 vClothP;
varying vec3 vClothN;
float clothH() {
  vec3 bw = pow(abs(normalize(vClothN)), vec3(4.0));
  bw /= (bw.x + bw.y + bw.z + 1e-5);
  vec3 p = vClothP * clothScale;
  return texture2D(clothMap, p.yz).r * bw.x + texture2D(clothMap, p.xz).r * bw.y + texture2D(clothMap, p.xy).r * bw.z;
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
float clothHeight = clothH();
// fade the detail out with distance so it never shimmers when minified
float clothNear = 1.0 - smoothstep(2.5, 9.0, length(vViewPosition));
diffuseColor.rgb *= mix(1.0, 0.8 + clothHeight * 0.4, clothAmt * (0.35 + 0.65 * clothNear));`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor * (0.85 + (1.0 - clothHeight) * 0.3), 0.0, 1.0);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  vec2 dH = vec2(dFdx(clothHeight), dFdy(clothHeight)) * clothBump * clothNear;
  vec3 sx = dFdx(-vViewPosition);
  vec3 sy = dFdy(-vViewPosition);
  vec3 r1 = cross(sy, normal);
  vec3 r2 = cross(normal, sx);
  float det = dot(sx, r1);
  vec3 grad = sign(det) * (dH.x * r1 + dH.y * r2);
  normal = normalize(abs(det) * normal - grad);
}`,
      )
  }
  mat.customProgramCacheKey = () => `cloth-${c.tex.uuid}`
  mat.needsUpdate = true
}
