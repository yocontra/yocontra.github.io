// biome-ignore-all lint/style/noMultiAssign: canvas dimension setup (w = h = n) is clearer chained
/**
 * The clock tower's materials.
 *
 * - **Masonry**: one draw for brick, dressed sandstone, cedar shingles and sheet tin. The four
 *   Poly Haven sets share one 2x2 atlas (scene/civic-atlas.ts); geometry picks a cell through a
 *   U offset, and the shader wraps the world-scale UV inside the cell with `textureGrad`, so the
 *   tiles repeat seamlessly and mip selection follows the unwrapped UV. Weathering is procedural
 *   on top: desert dust and damp at the foot of the walls, rain streaks, broad colour drift.
 * - **Iron and bronze**: bell, hands, bezels, finial and vane in one draw. Hands and bell carry
 *   a pivot, an axis and a kind per vertex; the vertex shader turns them by the clock's angles,
 *   so the hands on all four dials move without a single extra draw (shadow pass included).
 * - **Dial**: the enamel face, painted once on a canvas (numerals, minute track, age stains),
 *   lit from behind at night through its emissive map.
 */
import {
  CanvasTexture,
  Color,
  type IUniform,
  MeshDepthMaterial,
  MeshStandardMaterial,
  RGBADepthPacking,
  ShaderChunk,
  SRGBColorSpace,
  type Texture,
  Vector3,
  type WebGLProgramParametersWithUniforms,
} from 'three'
import { FONT } from '../ui/type.ts'
import { CIVIC_CELL_U, CIVIC_GUTTER } from './civic-atlas.ts'
import { markFlat, markSlot, SLOT } from './roles.ts'
import { loadTex } from './textures.ts'

const ROOT = '/experiments/out-west/3d/tex'

const NOISE = /* glsl */ `
float civH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float civN(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(civH(i), civH(i + vec2(1.0, 0.0)), f.x), mix(civH(i + vec2(0.0, 1.0)), civH(i + vec2(1.0, 1.0)), f.x), f.y);
}
`

const CIVIC_FRAG = /* glsl */ `
varying vec3 vCivP;
varying vec3 vCivN;
float civAO = 1.0;
${NOISE}
vec4 civicTex(sampler2D t, vec2 uv) {
  float cell = floor(uv.x / ${CIVIC_CELL_U.toFixed(1)});
  vec2 l = vec2(uv.x - cell * ${CIVIC_CELL_U.toFixed(1)}, uv.y);
  float g = ${(CIVIC_GUTTER * 0.5).toFixed(6)};
  float span = 0.5 - 2.0 * g;
  vec2 org = vec2(mod(cell, 2.0), 1.0 - floor(cell * 0.5)) * 0.5;
  return textureGrad(t, org + g + fract(l) * span, dFdx(l) * span, dFdy(l) * span);
}
vec3 civicGrime(vec3 p, vec3 n) {
  float vert = 1.0 - abs(n.y);
  float along = abs(n.x) > abs(n.z) ? p.z : p.x;
  float wob = civN(vec2(along * 1.3, 7.0));
  float foot = 1.0 - smoothstep(0.0, 0.9 + wob * 0.9, p.y);
  float streak = civN(vec2(along * 4.0, p.y * 0.22 + wob * 3.0));
  streak = smoothstep(0.62, 0.95, streak) * vert;
  float macro = civN(p.xz * 0.21 + vec2(p.y * 0.17, 0.0));
  vec3 c = vec3(mix(0.88, 1.07, macro));
  c *= 1.0 - streak * 0.22;
  c = mix(c, c * vec3(0.8, 0.68, 0.55), foot * 0.75);
  return c;
}
`

function swap(chunk: string): string {
  return chunk.replace(/texture2D\( (?<tex>\w+), /gu, 'civicTex( $<tex>, ')
}

/** The masonry material; its atlas streams in (flat colour until then). */
export function civicMaterial(anisotropy: number, onReady: () => void): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    name: 'Civic',
  })
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCivP;\nvarying vec3 vCivN;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vCivP = (modelMatrix * vec4(transformed, 1.0)).xyz;
vCivN = normalize(mat3(modelMatrix) * objectNormal);`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CIVIC_FRAG}`)
      .replace(
        '#include <map_fragment>',
        `${swap(ShaderChunk.map_fragment)}\ndiffuseColor.rgb *= civicGrime(vCivP, normalize(vCivN));`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        swap(ShaderChunk.roughnessmap_fragment).replace(
          'roughnessFactor *= texelRoughness.g;',
          'roughnessFactor *= texelRoughness.g;\n\tcivAO = texelRoughness.r;',
        ),
      )
      .replace('#include <metalnessmap_fragment>', swap(ShaderChunk.metalnessmap_fragment))
      .replace(
        '#include <normal_fragment_maps>',
        `${swap(ShaderChunk.normal_fragment_maps)}
if ( !( dot( normal, normal ) > 1e-8 ) ) { normal = nonPerturbedNormal; }`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
reflectedLight.indirectDiffuse *= civAO;
reflectedLight.indirectSpecular *= civAO * civAO;`,
      )
  }
  mat.customProgramCacheKey = () => 'ow-civic'
  Promise.all([
    loadTex(`${ROOT}/civic_diff.webp`, true, anisotropy),
    loadTex(`${ROOT}/civic_nor.webp`, false, anisotropy),
    loadTex(`${ROOT}/civic_arm.webp`, false, anisotropy),
  ])
    .then(([map, nor, arm]) => {
      mat.map = map
      mat.normalMap = nor
      mat.roughnessMap = arm
      mat.metalnessMap = arm
      mat.roughness = 1
      mat.metalness = 1
      mat.needsUpdate = true
      onReady()
    })
    .catch(() => undefined)
  return mat
}

/** Kinds of moving metal: the vertex's `owSpin.w`. */
export const SPIN = { none: 0, hour: 1, minute: 2, bell: 3 } as const

/** Hour, minute and bell angles (radians), shared by the colour and shadow programs. */
export interface SpinUniforms {
  owAngles: IUniform<Vector3>
}

const SPIN_VERT = /* glsl */ `
attribute vec4 owSpin;
attribute vec3 owAxis;
uniform vec3 owAngles;
float owAngle() {
  float k = owSpin.w;
  return k < 0.5 ? 0.0 : (k < 1.5 ? owAngles.x : (k < 2.5 ? owAngles.y : owAngles.z));
}
vec3 owRot(vec3 v, vec3 k, float a) {
  float c = cos(a);
  float s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
`

function spinPatch(u: SpinUniforms, normals: boolean) {
  return (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.owAngles = u.owAngles
    let v = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SPIN_VERT}`)
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\ntransformed = owRot(transformed - owSpin.xyz, owAxis, owAngle()) + owSpin.xyz;',
      )
    if (normals) {
      v = v.replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\nobjectNormal = owRot(objectNormal, owAxis, owAngle());',
      )
    }
    shader.vertexShader = v
  }
}

/** Wrought iron and bell bronze (tinted per vertex), with the hands and bell turned in-shader. */
export function ironMaterials(): {
  mat: MeshStandardMaterial
  depth: MeshDepthMaterial
  uniforms: SpinUniforms
} {
  const uniforms: SpinUniforms = { owAngles: { value: new Vector3() } }
  const mat = new MeshStandardMaterial({
    vertexColors: true,
    metalness: 0.85,
    roughness: 0.42,
    name: 'Iron',
  })
  mat.onBeforeCompile = spinPatch(uniforms, true)
  mat.customProgramCacheKey = () => 'ow-iron'
  markFlat(mat)
  markSlot(mat, SLOT.Iron)
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking })
  depth.onBeforeCompile = spinPatch(uniforms, false)
  depth.customProgramCacheKey = () => 'ow-iron-depth'
  return { mat, depth, uniforms }
}

/** Paint the enamel dial (no hands: those are iron). Repainted once the dial font loads. */
function paintDial(c: HTMLCanvasElement): void {
  const ctx = c.getContext('2d')
  if (!ctx) {
    return
  }
  const s = c.width
  const r = s / 2
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  // aged enamel: warm cream, yellowed toward the rim
  const g = ctx.createRadialGradient(r, r * 0.92, s * 0.05, r, r, r)
  g.addColorStop(0, '#f4ead0')
  g.addColorStop(0.75, '#eadcb6')
  g.addColorStop(1, '#cdb88c')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, s, s)
  // a deterministic scatter of speckle and rust-water stains
  let seed = 7
  const rnd = () => {
    seed = (seed * 16_807) % 2_147_483_647
    return seed / 2_147_483_647
  }
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(90,70,40,${rnd() * 0.08})`
    ctx.fillRect(rnd() * s, rnd() * s, 1 + rnd() * 2, 1 + rnd() * 2)
  }
  for (let i = 0; i < 14; i++) {
    const x = r + (rnd() - 0.5) * s * 0.8
    const y = r + (rnd() - 0.7) * s * 0.7
    const len = s * (0.05 + rnd() * 0.22)
    const sg = ctx.createLinearGradient(x, y, x, y + len)
    sg.addColorStop(0, 'rgba(120,80,40,0.2)')
    sg.addColorStop(1, 'rgba(120,80,40,0)')
    ctx.fillStyle = sg
    ctx.fillRect(x, y, 2 + rnd() * 5, len)
  }
  ctx.translate(r, r)
  const ink = '#1c1a17'
  const ring = (rad: number, w: number) => {
    ctx.beginPath()
    ctx.arc(0, 0, rad, 0, Math.PI * 2)
    ctx.lineWidth = w
    ctx.strokeStyle = ink
    ctx.stroke()
  }
  // chapter ring and minute track
  ring(r * 0.965, s * 0.02)
  ring(r * 0.9, s * 0.004)
  ring(r * 0.8, s * 0.004)
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2
    const five = i % 5 === 0
    ctx.save()
    ctx.rotate(a)
    ctx.fillStyle = ink
    if (five) {
      ctx.beginPath()
      ctx.arc(0, -r * 0.85, s * 0.012, 0, Math.PI * 2)
      ctx.fill()
    } else {
      ctx.fillRect(-s * 0.002, -r * 0.9, s * 0.004, r * 0.1)
    }
    ctx.restore()
  }
  // Roman numerals, set radially (bases toward the centre), with the clockmaker's IIII
  const nums = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI']
  ctx.font = `600 ${Math.round(s * 0.105)}px ${FONT.text}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = ink
  nums.forEach((n, i) => {
    ctx.save()
    ctx.rotate((i / 12) * Math.PI * 2)
    ctx.translate(0, -r * 0.665)
    const w = ctx.measureText(n).width
    const max = s * 0.2
    if (w > max) {
      ctx.scale(max / w, 1)
    }
    ctx.fillText(n, 0, 0)
    ctx.restore()
  })
  ring(r * 0.52, s * 0.003)
  ctx.font = `italic 500 ${Math.round(s * 0.034)}px ${FONT.text}`
  ctx.fillText('Tempus Fugit', 0, r * 0.37)
  ctx.font = `500 ${Math.round(s * 0.026)}px ${FONT.text}`
  ctx.fillText('A.D. 1879', 0, r * 0.45)
}

export function dialMaterial(): MeshStandardMaterial {
  const c = document.createElement('canvas')
  c.width = c.height = 512
  paintDial(c)
  const tex: Texture = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 4
  document.fonts?.ready
    .then(() => {
      paintDial(c)
      tex.needsUpdate = true
    })
    .catch(() => undefined)
  return new MeshStandardMaterial({
    map: tex,
    emissiveMap: tex,
    emissive: new Color(0xff_d8_96),
    emissiveIntensity: 0,
    roughness: 0.38,
    name: 'Dial',
  })
}
