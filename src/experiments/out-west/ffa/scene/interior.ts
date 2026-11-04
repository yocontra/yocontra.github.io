// biome-ignore-all lint/style/noMagicNumbers: light radii, strengths and lamp proportions, tuned by eye inside the rooms
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the mask bake is flat loops over the layout
/**
 * Perdition's interiors, lit without real lights: one small mask baked from the layout, read by
 * every town material.
 *
 * - R: indoors (under a hollow building's ceiling), with the corners and the foot of every wall
 *   darkened: the sky's fill (IBL and hemisphere) drops inside, more so in the corners.
 * - G: daylight spilling in: a soft pool inside every wall, strongest under the window band.
 * - B: warm practical light: an oil lamp over every table, bar and desk, the glow of each stove.
 * - A: the ceiling height (so the light stops at the ceiling, and the window panes know a camera
 *   is indoors).
 *
 * The lamps themselves are one merged, emissive mesh (glass chimneys and their wicks) hung from
 * the ceilings: they bloom. Window glass reads dark and reflective from the street, warm at dusk,
 * and bright (the day outside) from indoors. Plank walls and floors vary board by board.
 */
import {
  type BufferGeometry,
  Color,
  CylinderGeometry,
  DataTexture,
  Float32BufferAttribute,
  LinearFilter,
  type Material,
  Mesh,
  MeshStandardMaterial,
  RGBAFormat,
  SphereGeometry,
  Uniform,
  UnsignedByteType,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { ATMOS } from '../../scene/atmos.ts'
import type { Building, TownLayout } from '../sim/layout.ts'

/** Mask texels per metre. */
const RES = 3
/** Cover pieces that get a lamp hung over them, and stoves that glow. */
const LAMP_OVER = new Set([
  'counter',
  'table',
  'workbench',
  'piano',
  'safe',
  'shelves',
  'bed',
  'forge',
])
const GLOW = new Set(['stove', 'forge'])

const ceilingOf = (b: Building): number => (b.floors > 1 ? 3.3 : b.height - 0.05)

export interface Interior {
  mask: DataTexture
  /** Uniforms shared by every patched material. */
  uniforms: Record<string, Uniform>
  /** The lamps (one merged emissive mesh), or null with no interiors. */
  lamps: Mesh | null
}

/** Bake the interior mask and the lamp mesh from the layout. */
export function buildInterior(layout: TownLayout, glow: number): Interior {
  const n = Math.ceil(layout.size * RES)
  const data = new Uint8Array(n * n * 4)
  const r = new Float32Array(n * n)
  const g = new Float32Array(n * n)
  const bl = new Float32Array(n * n)
  const ceil = new Float32Array(n * n)
  const hollow = layout.buildings.filter((b) => b.hollow)
  // R: inside, darkened toward the walls; A: the ceiling
  for (const b of hollow) {
    const c = ceilingOf(b)
    for (let j = Math.floor(b.z * RES); j < Math.ceil((b.z + b.d) * RES); j++) {
      for (let i = Math.floor(b.x * RES); i < Math.ceil((b.x + b.w) * RES); i++) {
        if (i < 0 || j < 0 || i >= n || j >= n) {
          continue
        }
        const x = (i + 0.5) / RES
        const z = (j + 0.5) / RES
        const edge = Math.min(x - b.x, b.x + b.w - x, z - b.z, b.z + b.d - z)
        const corner =
          Math.min(x - b.x, b.x + b.w - x) + Math.min(z - b.z, b.z + b.d - z) - 2 * edge
        const ao =
          Math.min(1, 0.55 + 0.45 * Math.min(1, edge / 1.4)) *
          (corner < 1.2 ? 0.85 + 0.15 * (corner / 1.2) : 1)
        // the walls themselves (0.5 m) stay outdoor: their street faces must not darken
        r[j * n + i] = edge < 0.4 ? 0 : Math.max(0.02, ao)
        ceil[j * n + i] = c
        // G: daylight pools along every wall (the window band), fading 2.5 m in
        g[j * n + i] = Math.max(0, 1 - Math.max(0, edge - 0.5) / 2.2) * 0.85
      }
    }
  }
  // B: lamp and stove pools
  const lamps: { x: number; z: number; y: number }[] = []
  const pool = (cx: number, cz: number, rad: number, k: number) => {
    for (let j = Math.floor((cz - rad) * RES); j <= Math.ceil((cz + rad) * RES); j++) {
      for (let i = Math.floor((cx - rad) * RES); i <= Math.ceil((cx + rad) * RES); i++) {
        if (i < 0 || j < 0 || i >= n || j >= n || r[j * n + i] === 0) {
          continue
        }
        const d = Math.hypot((i + 0.5) / RES - cx, (j + 0.5) / RES - cz) / rad
        bl[j * n + i] = Math.min(1, (bl[j * n + i] ?? 0) + k * Math.exp(-d * d * 3))
      }
    }
  }
  for (const c of layout.cover) {
    const cx = c.x + c.w / 2
    const cz = c.z + c.d / 2
    const b = hollow.find((h) => cx > h.x && cx < h.x + h.w && cz > h.z && cz < h.z + h.d)
    if (!b) {
      continue
    }
    if (GLOW.has(c.kind)) {
      pool(cx, cz, 2.6, 0.8)
    }
    if (LAMP_OVER.has(c.kind) && !lamps.some((l) => Math.hypot(l.x - cx, l.z - cz) < 2.5)) {
      lamps.push({ x: cx, z: cz, y: ceilingOf(b) - 0.9 })
      pool(cx, cz, 4.2, 0.85)
    }
  }
  // every room gets at least one lamp, in its middle
  for (const b of hollow) {
    const cx = b.x + b.w / 2
    const cz = b.z + b.d / 2
    if (!lamps.some((l) => l.x > b.x && l.x < b.x + b.w && l.z > b.z && l.z < b.z + b.d)) {
      lamps.push({ x: cx, z: cz, y: ceilingOf(b) - 0.9 })
      pool(cx, cz, 4.5, 0.7)
    }
  }
  for (let k = 0; k < n * n; k++) {
    data[k * 4] = Math.round((r[k] ?? 0) * 255)
    data[k * 4 + 1] = Math.round((g[k] ?? 0) * 255)
    data[k * 4 + 2] = Math.round((bl[k] ?? 0) * 255)
    data[k * 4 + 3] = Math.round(Math.min(1, (ceil[k] ?? 0) / 10) * 255)
  }
  const mask = new DataTexture(data, n, n, RGBAFormat, UnsignedByteType)
  mask.magFilter = LinearFilter
  mask.minFilter = LinearFilter
  mask.flipY = false
  mask.needsUpdate = true
  if (!import.meta.env.DEV) {
    // once uploaded, the CPU copy is dead weight
    mask.onUpdate = () => {
      mask.image.data = null
    }
  }
  const uniforms = {
    inMask: new Uniform(mask),
    inSize: new Uniform(layout.size),
    inLamp: new Uniform(new Color(1.0, 0.56, 0.24)),
    inLampK: new Uniform(4),
    inDayK: new Uniform(0.9),
    /** Lit windows: 0 by day, 1 at night. */
    inGlow: new Uniform(glow),
    ...ATMOS,
  }
  return { mask, uniforms, lamps: lampMesh(lamps) }
}

/** Hanging oil lamps: a chain, a brass font, a glowing glass chimney. One merged emissive mesh. */
function lampMesh(spots: readonly { x: number; z: number; y: number }[]): Mesh | null {
  if (spots.length === 0) {
    return null
  }
  const parts: BufferGeometry[] = []
  for (const s of spots) {
    const chain = new CylinderGeometry(0.012, 0.012, 0.85, 4, 1).translate(s.x, s.y + 0.55, s.z)
    const font = new CylinderGeometry(0.09, 0.07, 0.1, 8, 1).translate(s.x, s.y - 0.05, s.z)
    const glass = new SphereGeometry(0.075, 8, 6).scale(1, 1.6, 1).translate(s.x, s.y + 0.08, s.z)
    // vertex colour: the chain and font dark brass, the chimney white-hot
    for (const [geo, c] of [
      [chain, [0.08, 0.06, 0.04]],
      [font, [0.25, 0.17, 0.07]],
      [glass, [1, 1, 1]],
    ] as const) {
      const cnt = geo.getAttribute('position').count
      const col = new Float32Array(cnt * 3)
      for (let i = 0; i < cnt; i++) {
        col.set(c, i * 3)
      }
      geo.setAttribute('color', new Float32BufferAttribute(col, 3))
      parts.push(geo.index ? geo.toNonIndexed() : geo)
    }
  }
  const geo = mergeGeometries(parts)
  if (!geo) {
    return null
  }
  const mat = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.4,
    metalness: 0.3,
    emissive: new Color(1.0, 0.6, 0.28),
    emissiveIntensity: 3.2,
  })
  mat.userData.procedural = true
  // the glow only where the vertex colour is bright (the chimney), not the brass
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      // biome-ignore lint/security/noSecrets: a GLSL line, not a credential
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= smoothstep(0.5, 0.9, vColor.r);',
    )
  }
  mat.customProgramCacheKey = () => 'ffa-lamps'
  const m = new Mesh(geo, mat)
  m.name = 'lamps'
  m.matrixAutoUpdate = false
  return m
}

const COMMON = /* glsl */ `
uniform sampler2D inMask;
uniform float inSize;
uniform vec3 inLamp;
uniform float inLampK;
uniform float inDayK;
uniform float inGlow;
varying vec3 vInW;
vec4 inSample(vec2 xz) {
  vec2 uv = xz / inSize;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
    return vec4(0.0);
  }
  return texture2D(inMask, uv);
}
`

const VERT = /* glsl */ `
{
  vec4 inW4 = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    inW4 = instanceMatrix * inW4;
  #endif
  vInW = (modelMatrix * inW4).xyz;
}
`

/** Interior light on a lit town surface (walls, floors, furniture, props). */
function lightPatch(shader: WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vInW;')
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT}`)
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${COMMON}\nuniform vec3 atmSunColor;`)
    .replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
{
  vec4 m = inSample(vInW.xz);
  float ceilY = m.a * 10.0;
  // indoors: under the ceiling (not its top side, not the roof)
  float inside = step(0.01, m.r) * (1.0 - smoothstep(ceilY - 0.05, ceilY + 0.15, vInW.y));
  if (inside > 0.0) {
    // the sky's fill drops inside, darkest in the corners and at the foot of the walls
    float fill = mix(1.0, m.r * 0.5, inside);
    reflectedLight.indirectDiffuse *= fill;
    reflectedLight.indirectSpecular *= fill;
    // lamp light: strongest under the lamp's height, gently flickering
    float fl = 0.9 + 0.06 * sin(atmTime * 7.0 + vInW.x) + 0.04 * sin(atmTime * 17.0 + vInW.z * 1.3);
    float lampH = 1.0 - smoothstep(0.6, 1.0, vInW.y / max(ceilY, 1.0)) * 0.4;
    reflectedLight.directDiffuse += diffuseColor.rgb * inLamp * (m.b * inLampK * fl * lampH * inside);
    // daylight spilling through the windows, on the floor and the lower walls
    float low = 1.0 - smoothstep(0.4, 2.6, vInW.y);
    reflectedLight.directDiffuse += diffuseColor.rgb * atmSunColor * (m.g * inDayK * low * inside);
  }
}`,
    )
}

/** Board-by-board tone on plank surfaces (by the texture's board rows). */
function boardsPatch(shader: WebGLProgramParametersWithUniforms): void {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <map_fragment>',
    `#include <map_fragment>
#ifdef USE_MAP
{
  vec2 bu = vMapUv;
  float row = floor(bu.y * 6.0);
  float run = floor(bu.x * 0.5 + fract(row * 0.37) * 3.0);
  float h = fract(sin(row * 12.9898 + run * 78.233) * 43758.5453);
  float h2 = fract(h * 91.7);
  diffuseColor.rgb *= mix(0.78, 1.14, h) * mix(vec3(1.0), vec3(1.05, 0.96, 0.88), h2);
}
#endif`,
  )
}

/** Window panes: dark and reflective from the street, warm at night, the bright day from indoors. */
function glassPatch(shader: WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vInW;')
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT}`)
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>\n${COMMON}\nuniform vec3 atmHorizon;\nuniform vec3 atmZenith;\nuniform vec3 atmSunColor;`,
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
// panes are dark glass (the vertex colour is the frame's paint elsewhere on this material)
diffuseColor.rgb = vec3(0.02, 0.022, 0.025) + diffuseColor.rgb * 0.015;`,
    )
    .replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
// old glass from the street: a dim sheen of the sky, mostly dark (the probe's bright sky
// otherwise turns every pane into a pale mirror)
reflectedLight.indirectSpecular *= 0.3;
reflectedLight.directSpecular *= 0.5;
reflectedLight.directDiffuse *= 0.4;`,
    )
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
{
  // the lamps behind the glass show only as the light goes
  totalEmissiveRadiance *= inGlow * 8.0;
  vec4 cam = inSample(cameraPosition.xz);
  float camIn = step(0.01, cam.r) * step(cameraPosition.y, cam.a * 10.0 + 0.3);
  // from indoors: the bright day outside, hazed by the grime on the glass
  vec3 day = mix(atmHorizon, atmZenith, 0.25) * 1.25 + atmSunColor * 0.25;
  totalEmissiveRadiance = mix(totalEmissiveRadiance, day, camIn * 0.92);
}`,
    )
}

/** Patch a town material for interior light (plus boards on planks, or the glass look). */
export function withInterior(
  mat: Material,
  kind: 'surface' | 'boards' | 'glass',
  it: Interior,
): void {
  if (mat.userData.interior) {
    return
  }
  mat.userData.interior = true
  const prev = mat.onBeforeCompile.bind(mat)
  const prevKey = mat.customProgramCacheKey.bind(mat)
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, r: WebGLRenderer) => {
    prev(shader, r)
    Object.assign(shader.uniforms, it.uniforms)
    if (kind === 'glass') {
      glassPatch(shader)
      return
    }
    if (kind === 'boards') {
      boardsPatch(shader)
    }
    lightPatch(shader)
  }
  mat.customProgramCacheKey = () => `${prevKey()}-in-${kind}`
  mat.needsUpdate = true
}
