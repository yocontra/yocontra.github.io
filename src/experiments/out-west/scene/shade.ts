import { MeshStandardMaterial, ShaderChunk, type Texture } from 'three'
import { type Floor, RIM, SKIN_FLAG } from './style.ts'

/**
 * The one material a baked character draws with: the shared character atlas (scene/atlas.ts:
 * albedo, OpenGL normal, ARM = recolour mask / roughness / metalness), a per-vertex tint
 * (attribute `color`), per-vertex roughness multiplier and rim strength (attribute `styMat`) and
 * the luminance of the garment's main fabric (attribute `styLum`), with the same fresnel rim and
 * contact darkening as the rest of the stylized cast (see style.ts).
 *
 * Tinting keeps the texture's detail:
 * - `styLum > 0` (a recoloured garment or a procedural garment on a fabric swatch): the texel's
 *   luminance, normalised by the fabric's mean, times the tint, blended in by the ARM mask, so a
 *   shirt changes colour and its leather straps and buttons don't;
 * - `styLum == 0` (skin, hair, eyes, untinted garments): texel × tint (white = unchanged).
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

/** The shared character atlas (engine/assets.ts sets it once at load). */
export interface CharacterMaps {
  map: Texture
  normal: Texture
  arm: Texture
}

let maps: CharacterMaps | null = null

export function setCharacterMaps(m: CharacterMaps): void {
  maps = m
}

export function characterMaps(): CharacterMaps | null {
  return maps
}

/**
 * The atlas recolour (see above) as a fragment snippet, after `map_fragment`; needs varyings
 * `vStyTint` and `vStyLum`. Shared with the Frontier's VAT crowd so far players match near ones.
 */
export const RECOLOR_GLSL = `{
#if defined( USE_MAP ) && defined( USE_ROUGHNESSMAP )
  float styMask = texture2D( roughnessMap, vRoughnessMapUv ).r;
  float styL = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  vec3 styRe = vStyTint * min( styL / max( vStyLum, 1e-3 ), 1.7 );
  diffuseColor.rgb = vStyLum > 0.0 ? mix( diffuseColor.rgb, styRe, styMask ) : diffuseColor.rgb * vStyTint;
#else
  diffuseColor.rgb *= vStyTint;
#endif
}`

/**
 * After `normal_fragment_maps`: a derivative tangent frame on a tiny, far triangle can blow up
 * (Inf × 0) into a NaN normal, and one NaN pixel turns into a black block in the bloom chain.
 * Fall back to the unperturbed normal (NaN fails every comparison, so it's caught too).
 */
export const NORMAL_GUARD_GLSL = `#include <normal_fragment_maps>
if ( !( dot( normal, normal ) > 1e-8 ) ) {
  normal = ( dot( nonPerturbedNormal, nonPerturbedNormal ) > 1e-8 ) ? nonPerturbedNormal : vec3( 0.0, 0.0, 1.0 );
}`

export function characterMaterial(floor: Floor, name = 'Character'): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ roughness: 1, metalness: 1, name })
  if (maps) {
    mat.map = maps.map
    mat.normalMap = maps.normal
    mat.roughnessMap = maps.arm
    mat.metalnessMap = maps.arm
  } else {
    mat.metalness = 0
  }
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.styRim = RIM.color
    shader.uniforms.styRimK = RIM.strength
    shader.uniforms.styFloor = floor
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 styMat;
attribute float styLum;
attribute vec3 color;
varying vec2 vStyMat;
varying float vStyLum;
varying vec3 vStyTint;
varying float vStyY;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vStyMat = styMat;
vStyLum = styLum;
vStyTint = color;
vStyY = (modelMatrix * vec4(transformed, 1.0)).y;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 styRim;
uniform float styRimK;
uniform float styFloor;
varying vec2 vStyMat;
varying float vStyLum;
varying vec3 vStyTint;
varying float vStyY;
float styWrap = 0.2;
vec3 styWrapTint = vec3(1.0);`,
      )
      .replace('#include <lights_physical_pars_fragment>', LIGHTS_WITH_WRAP)
      .replace('#include <normal_fragment_maps>', NORMAL_GUARD_GLSL)
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor * vStyMat.x, 0.04, 1.0);',
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
${RECOLOR_GLSL}
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
  mat.customProgramCacheKey = () => `ow-character-3${maps ? '-tex' : ''}`
  return mat
}
