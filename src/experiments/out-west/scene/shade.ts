import { MeshStandardMaterial } from 'three'
import { type Floor, RIM } from './style.ts'

/**
 * The one material a baked character draws with: vertex colour, and per-vertex
 * roughness and rim strength (attribute `styMat`), with the same fresnel rim
 * and contact darkening as the rest of the stylized cast (see style.ts).
 */
export function characterMaterial(floor: Floor, name = 'Character'): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, name })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.styRim = RIM.color
    shader.uniforms.styRimK = RIM.strength
    shader.uniforms.styFloor = floor
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec2 styMat;\nvarying vec2 vStyMat;\nvarying float vStyY;',
      )
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvStyMat = styMat;\nvStyY = (modelMatrix * vec4(transformed, 1.0)).y;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 styRim;
uniform float styRimK;
uniform float styFloor;
varying vec2 vStyMat;
varying float vStyY;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = vStyMat.x;',
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
diffuseColor.rgb *= mix(0.72, 1.0, smoothstep(0.0, 0.85, vStyY - styFloor));`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float ndv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
  float fr = smoothstep(0.35, 1.0, 1.0 - ndv);
  totalEmissiveRadiance += styRim * (styRimK * vStyMat.y * fr) * (0.55 + 0.45 * diffuseColor.rgb);
}`,
      )
  }
  mat.customProgramCacheKey = () => 'ow-character'
  return mat
}
