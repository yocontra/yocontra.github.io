/**
 * See-through buildings for the top-down camera. Any town fragment that is nearer the camera than
 * the player, above knee height and inside a screen-space circle around the player is dithered
 * away (soft edge, no sorting, no transparency, works on merged geometry). Roofs also carry a
 * per-vertex building id: the roof of the building the player stands in fades to 15 % (spec §3.1).
 */
import type { Material, MeshStandardMaterial } from 'three'
import { Vector3 } from 'three'

/** Shared by every cutaway material; the game writes it once per frame. */
export const CUT = {
  /** Player in render-target pixels (x, y from the bottom-left) and view depth (m). */
  screen: { value: new Vector3(-9999, -9999, 0) },
  /** Radius in render-target pixels. */
  radius: { value: 0 },
  /** Building id whose roof hides (−1 none). */
  bid: { value: -1 },
}

const IGN = 'fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))'

export function cutaway(mat: MeshStandardMaterial, roof: boolean): Material {
  const prev = mat.onBeforeCompile
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer)
    shader.uniforms.cutScreen = CUT.screen
    shader.uniforms.cutRadius = CUT.radius
    shader.uniforms.cutBid = CUT.bid
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vCutY;
${roof ? 'attribute float bid;\nvarying float vBid;' : ''}`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vCutY = (modelMatrix * vec4(transformed, 1.0)).y;
${roof ? 'vBid = bid;' : ''}`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 cutScreen;
uniform float cutRadius;
uniform float cutBid;
varying float vCutY;
${roof ? 'varying float vBid;' : ''}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
{
  float ign = ${IGN};
  float d = distance(gl_FragCoord.xy, cutScreen.xy);
  float inside = 1.0 - smoothstep(cutRadius * 0.62, cutRadius, d);
  float nearer = step(vViewPosition.z, cutScreen.z - 0.6) * step(0.45, vCutY);
  if (inside * nearer * 0.93 > ign) discard;
  ${roof ? 'if (abs(vBid - cutBid) < 0.5 && ign < 0.85) discard;' : ''}
}`,
      )
  }
  const key = mat.customProgramCacheKey()
  mat.customProgramCacheKey = () => `${key}-cut${roof ? 'r' : ''}`
  return mat
}
