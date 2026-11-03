import { MeshStandardMaterial, ShaderChunk } from 'three'
import { type Floor, RIM, SKIN_FLAG } from './style.ts'

/**
 * The one material a baked character draws with: vertex colour, and per-vertex
 * roughness and rim strength (attribute `styMat`), with the same fresnel rim
 * and contact darkening as the rest of the stylized cast (see style.ts).
 *
 * Lighting is clean and smooth (no noise, nothing that can alias):
 * - wrap diffuse: light bends a little past the terminator, so cloth reads
 *   soft instead of plastic;
 * - skin (flagged through styMat.y, see style.ts SKIN_FLAG) wraps further and
 *   the wrapped band is tinted warm red: a cheap subsurface-scattering look;
 * - the fresnel rim, tinted per time of day;
 * - contact darkening toward the boots.
 */

/** The physical lights chunk with a wrap-diffuse term after the Lambert one. */
const LIGHTS_WITH_WRAP = ShaderChunk.lights_physical_pars_fragment.replace(
  'reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );',
  `reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );
	{
		float ndlRaw = dot( geometryNormal, directLight.direction );
		float wrapped = saturate( ( ndlRaw + styWrap ) / ( 1.0 + styWrap ) );
		// only the band around the terminator: lit faces keep their Lambert value
		float extra = max( wrapped - saturate( ndlRaw ), 0.0 ) * smoothstep( 0.6, 0.0, ndlRaw );
		reflectedLight.directDiffuse += extra * directLight.color * diffuseBRDF * styWrapTint;
	}`,
)

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
varying float vStyY;
float styWrap = 0.2;
vec3 styWrapTint = vec3(1.0);`,
      )
      .replace('#include <lights_physical_pars_fragment>', LIGHTS_WITH_WRAP)
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = vStyMat.x;',
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
float stySkin = step(${(SKIN_FLAG / 2).toFixed(1)}, vStyMat.y);
float styRimMat = vStyMat.y - ${SKIN_FLAG.toFixed(1)} * stySkin;
styWrap = mix(0.2, 0.55, stySkin);
styWrapTint = mix(vec3(1.0), vec3(1.0, 0.45, 0.32), stySkin);
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
  mat.customProgramCacheKey = () => 'ow-character-2'
  return mat
}
