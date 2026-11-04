import { BackSide, DoubleSide, MeshStandardMaterial, ShaderChunk, type Texture } from 'three'
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
 * Lighting is physically based (three's standard GGX + IBL from the town probe) with a few
 * stylized terms, all clean and smooth (no noise, nothing that can alias):
 * - wrap diffuse: light bends a little past the terminator, so cloth reads
 *   soft instead of plastic;
 * - skin (flagged through styMat.y, see style.ts SKIN_FLAG) wraps further and
 *   the wrapped band is tinted warm: a cheap subsurface-scattering look;
 * - a rim from every direct light, computed inside the light loop: it takes the light's colour
 *   and its shadow, is strongest on the silhouette edge that faces the light and when the man is
 *   backlit, and is gone on the side the light can't reach (a view-only fresnel glow on every edge
 *   read as a flat cel outline). A faint sky-tinted fresnel stays for the shadow side;
 * - horizon specular occlusion: a normal-mapped texel can't reflect the environment from behind
 *   its own surface, so crevices and folds stop glowing with sky;
 * - a silhouette falloff on the diffuse (FORM_GLSL), so a front-lit figure rounds off;
 * - contact darkening toward the boots, which also occludes the environment's specular.
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
		// the rim: this light's colour and shadow, on the silhouette edge facing it, strongest backlit
		float fr = pow( 1.0 - saturate( dot( geometryNormal, geometryViewDir ) ), 3.0 );
		float facing = smoothstep( -0.4, 0.3, ndlRaw );
		float back = saturate( dot( -geometryViewDir, directLight.direction ) );
		reflectedLight.directSpecular += directLight.color * ( styRimG * fr * facing * ( 0.3 + 0.7 * back ) * RECIPROCAL_PI )
			* ( 0.45 + 0.55 * material.diffuseColor / max( max3( material.diffuseColor ), 0.04 ) );
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

/**
 * After `lights_fragment_maps`: horizon occlusion of the environment's specular (a reflection
 * vector bent below the geometric surface by the normal map sees the inside of the body, not the
 * sky) and the contact darkening (`styOcc`) as specular occlusion. Needs `styOcc` declared.
 */
export const SPEC_OCCLUSION_GLSL = `#include <lights_fragment_maps>
{
  float styHor = saturate( 1.0 + 1.2 * dot( reflect( -geometryViewDir, geometryNormal ), nonPerturbedNormal ) );
  radiance *= styHor * styHor * styOcc;
}`

/** Strength of the silhouette falloff (FORM_GLSL); 0 = plain Lambert. */
const FORM_POWER = 0.4

/** Character normal-map strength (the Quaternius maps are shallow). */
const NORMAL_STRENGTH = 1.4

/**
 * After `lights_fragment_end`: a view-dependent falloff on the diffuse (Minnaert-style, the
 * darkening rough cloth and skin show toward their silhouette). A front-lit figure is otherwise
 * one even Lambert value from edge to edge and reads as a cut-out; with it the chest, arms and
 * legs round off. Half strength on the ambient, so the shadow side keeps some form too. The rim
 * (directSpecular) is untouched, so a backlit edge still glows.
 */
export const FORM_GLSL = `#include <lights_fragment_end>
{
  float styNv = saturate( dot( geometryNormal, geometryViewDir ) );
  float styForm = pow( max( styNv, 0.02 ), ${FORM_POWER.toFixed(2)} );
  reflectedLight.directDiffuse *= styForm;
  reflectedLight.indirectDiffuse *= mix( 1.0, styForm, 0.5 );
}`

/** Light-loop rim gain over the old emissive rim (it's now multiplied by the light's irradiance). */
const RIM_GAIN = 1.6

/** What's left of the view-only fresnel rim: a faint sky sheen for the shadow side. */
const SKY_RIM = 0.22

/** A glow uniform: 0 = none. One per actor, so his body and hat pulse together. */
export interface Glow {
  value: number
}

/**
 * The character material. `glow` (0..1) adds a warm emissive fresnel pulse on top of the lit
 * surface (Frontier spawn protection): opaque, no blending, so nothing turns see-through.
 */
export function characterMaterial(
  floor: Floor,
  name = 'Character',
  glow: Glow = { value: 0 },
): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ roughness: 1, metalness: 1, name })
  // Opaque, and both faces drawn: the source garments are single sheets (collars, cuffs, hems,
  // hair) and the fitted coats and ponchos are open shells, so with back faces culled you saw
  // through the inside of a coat, a sleeve or a collar to the street behind. A back face is lit
  // with its normal flipped (three's DOUBLE_SIDED path). On the tile-based iPhone GPU the hidden
  // back faces of a closed body cost no shading. Shadows keep casting from the back faces, as
  // before, so no new self-shadow acne.
  mat.side = DoubleSide
  mat.shadowSide = BackSide
  mat.transparent = false
  mat.alphaTest = 0
  if (maps) {
    mat.map = maps.map
    mat.normalMap = maps.normal
    mat.roughnessMap = maps.arm
    mat.metalnessMap = maps.arm
    // the source normal maps are soft; at game distance they need a push to read
    mat.normalScale.setScalar(NORMAL_STRENGTH)
  } else {
    mat.metalness = 0
  }
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.styRim = RIM.color
    shader.uniforms.styRimK = RIM.strength
    shader.uniforms.styFloor = floor
    shader.uniforms.styGlow = glow
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
uniform float styGlow;
varying vec2 vStyMat;
varying float vStyLum;
varying vec3 vStyTint;
varying float vStyY;
float styWrap = 0.2;
vec3 styWrapTint = vec3(1.0);
float styRimG = 0.0;
float styOcc = 1.0;`,
      )
      .replace('#include <lights_physical_pars_fragment>', LIGHTS_WITH_WRAP)
      .replace('#include <normal_fragment_maps>', NORMAL_GUARD_GLSL)
      .replace('#include <lights_fragment_maps>', SPEC_OCCLUSION_GLSL)
      .replace('#include <lights_fragment_end>', FORM_GLSL)
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
styWrap = mix(0.2, 0.45, stySkin);
styWrapTint = mix(vec3(1.0), vec3(1.0, 0.58, 0.45), stySkin);
// rim strength for the light loop: per material (styMat.y) times the time of day's (RIM)
styRimG = styRimK * styRimMat * ${RIM_GAIN.toFixed(2)};
styOcc = mix(0.72, 1.0, smoothstep(0.0, 0.85, vStyY - styFloor));
diffuseColor.rgb *= styOcc;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float ndv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
  float fr = smoothstep(0.35, 1.0, 1.0 - ndv);
  // the faint sky sheen on the shadow side (the lit rim comes from the lights, above)
  totalEmissiveRadiance += styRim * (styRimK * styRimMat * fr * ${SKY_RIM.toFixed(2)}) * (0.55 + 0.45 * diffuseColor.rgb);
  totalEmissiveRadiance += vec3(1.0, 0.78, 0.42) * styGlow * (0.3 + 2.2 * fr);
}`,
      )
  }
  mat.customProgramCacheKey = () => `ow-character-5${maps ? '-tex' : ''}`
  return mat
}
