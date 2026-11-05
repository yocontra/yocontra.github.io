// biome-ignore-all lint/style/noNestedTernary: stair/door directions read as small switches
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: buildTown wires the layers (structure, detail tiles, far batch, rooms) and their culling in one pass
// biome-ignore-all lint/style/noExcessiveLinesPerFile: one town builder; the paint table and the per-feature builders share private helpers
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: array lookups narrowed by the layout's types
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: addBuilding assembles walls, windows, roof, front and porch per building kind
// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
/**
 * Perdition, built from `town.layout.json` (the same file the server builds its collision grid
 * from, so what you see is what blocks you). Everything static merges into a handful of draws:
 * painted plank walls, stone walls (bank, jail), roofs (with a building id for the roof fade),
 * wood (boardwalks, porches, floors, the bridge, boxcars), windows and signs.
 *
 * Third person sees the whole town, so the detail is layered and culled by the camera:
 * - kit pieces (windows, frames, fences, barrels, crates, hay, rocks) merge by 36 m tile, drawn
 *   only within ~30–46 m of the camera;
 * - beyond that, one far batch per material stands in (clustered fences, doors and rocks, flat
 *   painted windows), each vertex tagged with its tile so the shader folds away tiles showing
 *   full detail; small props have inset stand-ins in the always-drawn wood batch instead;
 * - each walk-in building's furniture, ceiling and inside windows draw only when the camera is in
 *   it or within ~12–18 m;
 * - the floor and legacy tiers also drop facade trim and ceiling joists.
 */
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  type Camera,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  type InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Assets } from '../../engine/assets.ts'
import type { Quality } from '../../engine/tiers.ts'
import { GeoBuilder } from '../../scene/geo.ts'
import { mergePlaced, type PropDef, placeMatrix, propDef, propsLibrary } from '../../scene/props.ts'
import { glassLook } from '../../scene/surface.ts'
import { signAtlas } from '../../scene/textures.ts'
import { attachArm } from '../../scene/town-pbr.ts'
import {
  type Building,
  buildingWallSpans,
  type Cover,
  type Rect,
  type Side,
  type TownLayout,
} from '../sim/layout.ts'
import { ROOF_WALKS } from '../sim/roofwalks.ts'
import {
  DOOR_FRAME_DEPTH,
  DOOR_HEAD,
  DOOR_JAMB,
  doorTop,
  SHOP_WINDOW_SCALE,
  STOREY_H,
  WALL_T,
  WINDOW_LIFT,
  WINDOW_SASH,
  WINDOW_SCALE,
  WINDOW_SILL,
} from './building-rules.ts'
import { addClockTower } from './clock-tower.ts'
import {
  decks,
  floorHeight,
  frontOf,
  PLATFORM_DEPTH,
  PORCH_DECK,
  PORCH_DEPTH,
  PORCH_ROOF,
  PORCHED,
  sideStrip,
} from './cover-kinds.ts'
import { cutaway } from './cutaway.ts'
import { dressCover } from './dressing.ts'
import { bakeGroundMask, groundMesh } from './ground.ts'
import { farDef } from './lod.ts'
import { OUTSKIRTS_SEED, outskirtsGeometry } from './outskirts.ts'
import { buildRoof, RK_PLAIN, roofSkin, roofSkins, tinColor } from './roofs.ts'

interface Paint {
  wall: number
  trim: number
  roof: number
  sign: string | null
  signBg: string
  stone: boolean
  falseFront: boolean
  gable: boolean
}

const PAINT: Record<string, Paint> = {
  saloon: {
    wall: 0x9a_4a_32,
    trim: 0xe8_d8_b0,
    roof: 0x5a_3a_2a,
    sign: 'SALOON',
    signBg: '#2a1810',
    stone: false,
    falseFront: true,
    gable: false,
  },
  hotel: {
    wall: 0x6f_86_8a,
    trim: 0xf0_e6_cc,
    roof: 0x4a_44_40,
    sign: 'HOTEL',
    signBg: '#efe2c0',
    stone: false,
    falseFront: true,
    gable: false,
  },
  assay: {
    wall: 0xb8_9a_6a,
    trim: 0x5a_3c_24,
    roof: 0x5a_48_38,
    sign: 'ASSAY OFFICE',
    signBg: '#3a2414',
    stone: false,
    falseFront: true,
    gable: false,
  },
  church: {
    wall: 0xe8_e0_cc,
    trim: 0x7a_5a_3a,
    roof: 0x4a_3a_30,
    sign: null,
    signBg: '',
    stone: false,
    falseFront: false,
    gable: true,
  },
  tower: {
    wall: 0xe8_e0_cc,
    trim: 0x7a_5a_3a,
    roof: 0x4a_3a_30,
    sign: null,
    signBg: '',
    stone: false,
    falseFront: false,
    gable: false,
  },
  stable: {
    wall: 0x8a_5a_3a,
    trim: 0xe0_d0_b0,
    roof: 0x6a_4a_30,
    sign: 'LIVERY',
    signBg: '#e8dcc0',
    stone: false,
    falseFront: false,
    gable: true,
  },
  stage_line: {
    wall: 0x3e_5a_44,
    trim: 0xe8_c8_70,
    roof: 0x3a_32_2a,
    sign: 'STAGE LINE',
    signBg: '#e8c870',
    stone: false,
    falseFront: true,
    gable: false,
  },
  general_store: {
    wall: 0xc8_a8_70,
    trim: 0x4a_30_1c,
    roof: 0x5e_4a_38,
    sign: 'GENERAL STORE',
    signBg: '#4a301c',
    stone: false,
    falseFront: true,
    gable: false,
  },
  bank: {
    wall: 0xb8_a8_90,
    trim: 0x2e_3a_30,
    roof: 0x3e_3a_36,
    sign: 'BANK',
    signBg: '#1e2a22',
    stone: true,
    falseFront: true,
    gable: false,
  },
  undertaker: {
    wall: 0x3a_34_32,
    trim: 0xb8_b0_a0,
    roof: 0x2a_26_24,
    sign: 'UNDERTAKER',
    signBg: '#141010',
    stone: false,
    falseFront: true,
    gable: false,
  },
  jail: {
    wall: 0xa0_94_82,
    trim: 0x3a_30_28,
    roof: 0x44_3c_34,
    sign: 'SHERIFF',
    signBg: '#2a2018',
    stone: true,
    falseFront: true,
    gable: false,
  },
  depot: {
    wall: 0x8a_3a_2a,
    trim: 0xe8_d0_a0,
    roof: 0x3a_34_30,
    sign: 'DEPOT',
    signBg: '#e8d0a0',
    stone: false,
    falseFront: false,
    gable: true,
  },
  shed: {
    wall: 0x8a_70_54,
    trim: 0x5a_44_30,
    roof: 0x6a_5a_48,
    sign: null,
    signBg: '',
    stone: false,
    falseFront: false,
    gable: true,
  },
  outhouse: {
    wall: 0x7a_5e_42,
    trim: 0x5a_44_30,
    roof: 0x5a_4a_3a,
    sign: null,
    signBg: '',
    stone: false,
    falseFront: false,
    gable: true,
  },
  smithy: {
    wall: 0x5a_4a_40,
    trim: 0xd0_a0_60,
    roof: 0x3a_32_2c,
    sign: 'SMITHY',
    signBg: '#d0a060',
    stone: false,
    falseFront: false,
    gable: true,
  },
  water_tower: {
    wall: 0x7a_5a_3c,
    trim: 0x5a_44_30,
    roof: 0x4a_3a_2c,
    sign: null,
    signBg: '',
    stone: false,
    falseFront: false,
    gable: false,
  },
  barn: {
    wall: 0x8a_2e_22,
    trim: 0xe8_dc_c0,
    roof: 0x5a_4a_3c,
    sign: null,
    signBg: '',
    stone: false,
    falseFront: false,
    gable: true,
  },
}
const DEFAULT_PAINT: Paint = PAINT.shed ?? (Object.values(PAINT)[0] as Paint)

const WOOD = 0xb0_8a_60
const DARK_WOOD = 0x6a_4c_34
/** Furniture that stands against a wall and hides the inside of a window there. */
const AGAINST_WALL = new Set(['shelves', 'stairs', 'piano', 'safe'])

/** Roofs are most of what the top-down camera sees: sun-bleached, never near-black. */
function bleach(hex: number): number {
  const ch = (shift: number) => Math.min(255, Math.round(((hex >> shift) & 255) * 1.9 + 40))
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

export interface TownMaterials {
  wall: MeshStandardMaterial
  stone: MeshStandardMaterial
  roof: MeshStandardMaterial
  wood: MeshStandardMaterial
  windows: MeshStandardMaterial
  signs: MeshStandardMaterial
  /** Wagon bonnets and laundry: woven canvas. */
  cloth: MeshStandardMaterial
  /** Kit doors, windows and rails (the props' trim atlas, with the cutaway). */
  kit: MeshStandardMaterial
}

export interface Town {
  root: Group
  /** Building rects by roof id, for the roof fade. */
  roofs: Building[]
  sun: Vector3
  /**
   * Show the detail the camera can use and hide the rest: small-prop tiles near the camera, the
   * interiors of the buildings it is in or beside. The town also calls it itself from the
   * ground's onBeforeRender (main camera only), so callers needn't; one frame of lag is fine.
   */
  update: (camera: Camera) => void
  dispose: () => void
}

/** A tiny seeded hash (the masonry must look the same for everyone). */
function hashAt(i: number, j: number): number {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43_758.5453
  return s - Math.floor(s)
}

/**
 * Dressed sandstone for the bank and the jail: coursed ashlar (long and short blocks, two
 * course heights), each block its own warm tint with a chisel-dragged face and darker,
 * weathered edges, in recessed mortar. Drawn once on a canvas (512², one 2 m tile) with a
 * matching normal map from the same height field, so the joints catch the low sun.
 */
function masonryTextures(): { map: CanvasTexture; normal: CanvasTexture } {
  const N = 512
  const color = document.createElement('canvas')
  color.width = N
  color.height = N
  const height = new Float32Array(N * N)
  const ctx = color.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#8a7e6c'
    ctx.fillRect(0, 0, N, N)
    const courses = [70, 58, 70, 58, 70, 58, 70, 58]
    let y = 0
    for (const [row, ch] of courses.entries()) {
      let x = -Math.floor(hashAt(row, 0) * 120)
      let k = 0
      while (x < N) {
        const w = 90 + Math.floor(hashAt(row, ++k) * 110)
        const tint = 0.86 + hashAt(row, k + 50) * 0.22
        const r = Math.round(214 * tint)
        const g = Math.round(188 * tint)
        const b = Math.round(150 * tint)
        // the block, inset for the mortar; edges weathered darker
        const x0 = x + 4
        const y0 = y + 4
        const bw = w - 8
        const bh = ch - 8
        const grad = ctx.createLinearGradient(0, y0, 0, y0 + bh)
        grad.addColorStop(0, `rgb(${r - 10},${g - 10},${b - 10})`)
        grad.addColorStop(0.5, `rgb(${r},${g},${b})`)
        grad.addColorStop(1, `rgb(${r - 26},${g - 24},${b - 22})`)
        ctx.fillStyle = grad
        for (const dx of [0, N]) {
          ctx.fillRect(x0 - dx, y0, bw, bh)
          ctx.fillRect(x0 + dx, y0, bw, bh)
        }
        // chisel drag: faint diagonal strokes across the face
        ctx.strokeStyle = 'rgba(80,60,40,0.07)'
        ctx.lineWidth = 1
        for (let s = 0; s < bw; s += 5) {
          for (const dx of [0, N, -N]) {
            ctx.beginPath()
            ctx.moveTo(x0 + s + dx, y0)
            ctx.lineTo(x0 + s + dx + bh * 0.4, y0 + bh)
            ctx.stroke()
          }
        }
        for (let py = Math.max(0, y0); py < Math.min(N, y0 + bh); py++) {
          for (let px = x0; px < x0 + bw; px++) {
            const wx = ((px % N) + N) % N
            const edge = Math.min(px - x0, x0 + bw - px, py - y0, y0 + bh - py)
            height[py * N + wx] = Math.min(1, edge / 6) * (0.92 + hashAt(px, py) * 0.08)
          }
        }
        x += w
      }
      y += ch
    }
  }
  const normal = document.createElement('canvas')
  normal.width = N
  normal.height = N
  const nctx = normal.getContext('2d')
  if (nctx) {
    const img = nctx.createImageData(N, N)
    const h = (x: number, yy: number) => height[((yy + N) % N) * N + ((x + N) % N)] ?? 0
    for (let yy = 0; yy < N; yy++) {
      for (let x = 0; x < N; x++) {
        const dx = (h(x + 1, yy) - h(x - 1, yy)) * 2.5
        const dy = (h(x, yy + 1) - h(x, yy - 1)) * 2.5
        const len = Math.hypot(dx, dy, 1)
        const o = (yy * N + x) * 4
        img.data[o] = Math.round((-dx / len) * 127 + 128)
        img.data[o + 1] = Math.round((dy / len) * 127 + 128)
        img.data[o + 2] = Math.round((1 / len) * 127 + 128)
        img.data[o + 3] = 255
      }
    }
    nctx.putImageData(img, 0, 0)
  }
  const wrap = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new CanvasTexture(c)
    t.wrapS = RepeatWrapping
    t.wrapT = RepeatWrapping
    if (srgb) {
      t.colorSpace = SRGBColorSpace
    }
    return t
  }
  return { map: wrap(color, true), normal: wrap(normal, false) }
}

function makeMaterials(assets: Assets): TownMaterials {
  const tiled = (t: Texture) => {
    const c = t.clone()
    c.wrapS = RepeatWrapping
    c.wrapT = RepeatWrapping
    c.needsUpdate = true
    return c
  }
  const wall = new MeshStandardMaterial({
    map: tiled(assets.tex.vplanks),
    normalMap: tiled(assets.tex.vplanksN),
    normalScale: new Vector2(0.7, 0.7),
    vertexColors: true,
    roughness: 0.86,
    // the plank photo is dark: lift it like the duel street's siding, so paint reads as paint
    // (not near-black) at eye level
    color: new Color(1.55, 1.48, 1.4),
  })
  const masonry = masonryTextures()
  const stone = new MeshStandardMaterial({
    map: masonry.map,
    normalMap: masonry.normal,
    normalScale: new Vector2(0.9, 0.9),
    vertexColors: true,
    roughness: 0.9,
    color: new Color(1.25, 1.2, 1.15),
  })
  const roof = new MeshStandardMaterial({
    map: tiled(assets.tex.planks),
    normalMap: tiled(assets.tex.planksN),
    vertexColors: true,
    roughness: 0.9,
    color: new Color(1.35, 1.3, 1.25),
  })
  const wood = new MeshStandardMaterial({
    map: tiled(assets.tex.planks),
    normalMap: tiled(assets.tex.planksN),
    vertexColors: true,
    roughness: 0.82,
    color: new Color(1.6, 1.52, 1.44),
  })
  const windows = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.18,
    metalness: 0.2,
    emissive: 0xff_b0_60,
    emissiveIntensity: 0.12,
  })
  glassLook(windows)
  const signs = new MeshStandardMaterial({ roughness: 0.75 })
  // the props' trim-atlas material, with the see-through cut like every town surface
  const kitSrc = propsLibrary()
    ?.scenes.flatMap((sc) => {
      const found: MeshStandardMaterial[] = []
      sc.traverse((o) => {
        const m = (o as Mesh).material as MeshStandardMaterial | undefined
        if (m?.name === 'Kit') {
          found.push(m)
        }
      })
      return found
    })
    .at(0)
  const kit = kitSrc ? kitSrc.clone() : new MeshStandardMaterial({ color: WOOD })
  if (kitSrc) {
    // clone() doesn't carry the shader patch (the NaN-normal guard); cutaway chains onto it
    kit.onBeforeCompile = kitSrc.onBeforeCompile
  }
  // the duel street's surface treatment: Poly Haven ARM maps (plank grooves in the AO, real
  // roughness) and the contact shade at wall feet and under the porch roofs
  attachArm(wall, 'vplanks', 1)
  attachArm(wood, 'planks', 1)
  attachArm(roof, 'planks', 0.8)
  withWeathering(wall, 'wall', 0.19)
  withWeathering(stone, 'stone', 0)
  withContactShade(wall, 'wall')
  withContactShade(stone, 'stone')
  withContactShade(wood, 'wood')
  withContactShade(kit, 'kit')
  cutaway(kit, false)
  cutaway(wall, false)
  cutaway(stone, false)
  roofSkins(roof)
  cutaway(roof, true)
  cutaway(wood, false)
  cutaway(windows, false)
  cutaway(signs, false)
  const cloth = new MeshStandardMaterial({
    map: canvasTexture(),
    vertexColors: true,
    roughness: 0.95,
    side: DoubleSide,
  })
  cutaway(cloth, false)
  // names the atmosphere pass (wilds.ts) dispatches on
  wall.name = 'town-wall'
  stone.name = 'town-stone'
  roof.name = 'town-roof'
  wood.name = 'town-wood'
  windows.name = 'town-windows'
  return { wall, stone, roof, wood, windows, signs, kit, cloth }
}

/** How many porch and platform rects the contact-shade patch carries. */
const SHADE_RECTS = 16
/** Porch and platform rects (x, z, w, d) for the contact shade, set once by buildTown. */
const SHADE = {
  rects: { value: Array.from({ length: SHADE_RECTS }, () => new Vector4(0, 0, 0, 0)) },
}

/**
 * The duel street's "town AO" for Perdition: indirect light only (the sky probe and the fill),
 * as a baked sky-visibility map would. Darkens the foot of every vertical face (contact
 * shadow), and everything under a porch roof (the facade, the deck, the posts), so fronts read
 * as built into the ground and shaded by their awnings. Direct sun and real shadows untouched.
 */
function withContactShade(mat: MeshStandardMaterial, key: string): void {
  const prev = mat.onBeforeCompile
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer)
    shader.uniforms.shadeRects = SHADE.rects
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vShadeP;\nvarying vec3 vShadeN;',
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vShadeP = (modelMatrix * vec4(transformed, 1.0)).xyz;
vShadeN = normalize(mat3(modelMatrix) * objectNormal);`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vShadeP;
varying vec3 vShadeN;
uniform vec4 shadeRects[${SHADE_RECTS}];
float contactShade(vec3 p, vec3 n) {
  float vertical = 1.0 - abs(n.y);
  float foot = vertical * (1.0 - smoothstep(0.0, 1.3, p.y));
  float porch = 0.0;
  for (int i = 0; i < ${SHADE_RECTS}; i++) {
    vec4 r = shadeRects[i];
    // the deck, plus half a metre into the wall behind it, below the porch roof
    vec2 lo = r.xy - 0.55;
    vec2 hi = r.xy + r.zw + 0.55;
    float inside = step(lo.x, p.x) * step(p.x, hi.x) * step(lo.y, p.z) * step(p.z, hi.y);
    porch = max(porch, inside * (1.0 - smoothstep(2.9, 3.2, p.y)));
  }
  return clamp(1.0 - foot * 0.35 - porch * 0.45, 0.35, 1.0);
}`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
{
  float cs = contactShade(vShadeP, normalize(vShadeN));
  reflectedLight.indirectDiffuse *= cs;
  reflectedLight.indirectSpecular *= cs * cs;
}`,
      )
  }
  const k = mat.customProgramCacheKey()
  mat.customProgramCacheKey = () => `${k}-shade-${key}`
}

/**
 * Weathering, in the shader so it costs no geometry or textures (the duel street's decal pass,
 * procedurally): on vertical faces only,
 * - board-to-board tone variation (no two planks quite the same paint),
 * - rain streaks running down from the eaves and from window sills, fading toward the ground,
 * - red street dust kicked up the bottom half-metre and a little higher by the doors,
 * - sun-bleaching on the faces that catch the afternoon sun (south and west), and chalky, rubbed
 *   paint high on those walls.
 * `planks` is the board width in metres (0 for masonry: no plank variation).
 */
function withWeathering(mat: MeshStandardMaterial, key: string, planks: number): void {
  const prev = mat.onBeforeCompile
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWxP;\nvarying vec3 vWxN;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vWxP = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWxN = normalize(mat3(modelMatrix) * objectNormal);`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWxP;
varying vec3 vWxN;
float wxH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wxN(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wxH(i), wxH(i + vec2(1.0, 0.0)), f.x), mix(wxH(i + vec2(0.0, 1.0)), wxH(i + vec2(1.0, 1.0)), f.x), f.y);
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
{
  vec3 n = normalize(vWxN);
  float vertical = smoothstep(0.6, 0.85, 1.0 - abs(n.y));
  // position along the wall, and height
  float along = abs(n.x) > abs(n.z) ? vWxP.z : vWxP.x;
  float y = vWxP.y;
  vec3 c = diffuseColor.rgb;
  ${
    planks > 0
      ? `float board = wxH(vec2(floor(along / ${planks.toFixed(3)}), floor(vWxP.x * 0.13 + vWxP.z * 0.07)));
  c *= mix(0.9, 1.08, board);`
      : ''
  }
  // rain streaks: thin vertical runs, strongest just under the eaves and sills, fading down
  float streak = smoothstep(0.55, 0.95, wxN(vec2(along * 3.1, y * 0.12 + 11.0)));
  float fromTop = smoothstep(0.0, 2.5, mod(y, 3.2));
  c *= 1.0 - streak * 0.16 * (1.0 - fromTop * 0.6);
  // street dust up the foot of the wall
  float dust = (1.0 - smoothstep(0.05, 0.75, y)) * (0.7 + 0.3 * wxN(vec2(along * 1.7, 3.0)));
  c = mix(c, vec3(0.55, 0.38, 0.25), dust * 0.4);
  // the afternoon sun bleaches the south and west faces, chalkier toward the top
  float sunny = clamp(dot(n, normalize(vec3(-0.55, 0.0, 0.85))), 0.0, 1.0);
  float chalk = sunny * (0.5 + 0.5 * smoothstep(1.5, 5.0, y)) * (0.6 + 0.4 * wxN(vec2(along * 0.6, y * 0.4)));
  c = mix(c, c * vec3(1.1, 1.08, 1.04) + vec3(0.05, 0.045, 0.04), chalk * 0.45);
  diffuseColor.rgb = mix(diffuseColor.rgb, c, vertical);
}`,
      )
  }
  const k = mat.customProgramCacheKey()
  mat.customProgramCacheKey = () => `${k}-wx-${key}`
}

/** Woven canvas: a fine warp-and-weft grain with a few darker stains (wagon bonnets, laundry). */
function canvasTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 128
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#d8d0c0'
    ctx.fillRect(0, 0, 128, 128)
    for (let i = 0; i < 128; i += 2) {
      ctx.fillStyle = `rgba(90,70,40,${0.05 + ((i * 37) % 7) / 100})`
      ctx.fillRect(i, 0, 1, 128)
      ctx.fillStyle = `rgba(255,250,235,${0.05 + ((i * 53) % 5) / 100})`
      ctx.fillRect(0, i, 128, 1)
    }
    for (const [x, y, r] of [
      [30, 90, 18],
      [96, 40, 12],
    ] as const) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, 'rgba(110,80,40,0.18)')
      g.addColorStop(1, 'rgba(110,80,40,0)')
      ctx.fillStyle = g
      ctx.fillRect(x - r, y - r, r * 2, r * 2)
    }
  }
  const t = new CanvasTexture(c)
  t.wrapS = RepeatWrapping
  t.wrapT = RepeatWrapping
  t.colorSpace = SRGBColorSpace
  return t
}

interface Builders {
  wall: GeoBuilder
  stone: GeoBuilder
  cloth: GeoBuilder
  wood: GeoBuilder
  windows: GeoBuilder
  roofs: BufferGeometry[]
  signs: { text: string; bg: string; fg: string; quad: Vector3[] }[]
  extra: BufferGeometry[]
  /** Textured kit pieces (windows, door frames, porch rails), merged at the end. */
  kit: { def: PropDef; at: Matrix4 }[]
  /** A building's interior set: drawn only when the camera is in or beside it. */
  room: (id: string) => Builders
  /** Floor and legacy tiers: no facade trim or joists. */
  lean: boolean
}

/** Kit +Z turned to face out of a side. */
const SIDE_RY: Record<Side, number> = { s: 0, n: Math.PI, e: Math.PI / 2, w: -Math.PI / 2 }

const kitDef = (name: string): PropDef | null => {
  const lib = propsLibrary()
  return lib ? propDef(lib, name, 1, 'y', true) : null
}

/** A kit piece on a building's side, `a` metres along it, its origin on the wall face. */
function onSide(b: Building, side: Side, a: number, y: number, out = 0): Matrix4 {
  const [p] = faceQuad(b, side, a, a, y, y, out)
  return placeMatrix(p?.x ?? 0, y, p?.z ?? 0, SIDE_RY[side])
}

/** The four corners of a vertical quad on side `side` of rect, at heights y0..y1, from a to b along it. */
function faceQuad(
  b: Building,
  side: Side,
  a: number,
  c: number,
  y0: number,
  y1: number,
  out: number,
): Vector3[] {
  const V = (x: number, y: number, z: number) => new Vector3(x, y, z)
  switch (side) {
    case 's':
      return [
        V(b.x + a, y0, b.z + b.d + out),
        V(b.x + c, y0, b.z + b.d + out),
        V(b.x + c, y1, b.z + b.d + out),
        V(b.x + a, y1, b.z + b.d + out),
      ]
    case 'n':
      return [
        V(b.x + c, y0, b.z - out),
        V(b.x + a, y0, b.z - out),
        V(b.x + a, y1, b.z - out),
        V(b.x + c, y1, b.z - out),
      ]
    case 'e':
      return [
        V(b.x + b.w + out, y0, b.z + c),
        V(b.x + b.w + out, y0, b.z + a),
        V(b.x + b.w + out, y1, b.z + a),
        V(b.x + b.w + out, y1, b.z + c),
      ]
    default:
      return [
        V(b.x - out, y0, b.z + a),
        V(b.x - out, y0, b.z + c),
        V(b.x - out, y1, b.z + c),
        V(b.x - out, y1, b.z + a),
      ]
  }
}

const sideLength = (b: Building, side: Side) => (side === 'n' || side === 's' ? b.w : b.d)

/** Shopfronts: big display windows either side of the door on the street face. */
const SHOPFRONT = new Set([
  'saloon',
  'hotel',
  'general_store',
  'stage_line',
  'assay',
  'undertaker',
  'bank',
  'jail',
])

function addWindows(
  bs: Builders,
  b: Building,
  side: Side,
  floors: number,
  front: Side,
  against: readonly Cover[],
): void {
  const len = sideLength(b, side)
  const doors = b.doors.filter((d) => d.side === side)
  const glass = 0x1a_22_2a
  const thin = kitDef('k_window_thin')
  const shutter = kitDef('k_shutters_thin')
  const wide = kitDef('k_window_wide')
  for (let f = 0; f < floors; f++) {
    // sills at a rider's waist on the ground floor (windows sized to a 3.2 m storey, not a doll's)
    const sill = WINDOW_SILL + f * STOREY_H
    const shop = f === 0 && side === front && SHOPFRONT.has(b.kind) && wide
    const step = shop ? 3.8 : 3.0
    const span = shop ? 2.0 : 1.3
    for (let a = 1.2; a + span < len - 0.7; a += step) {
      if (f === 0 && doors.some((d) => a + span > d.at - 0.7 && a < d.at + d.width + 0.7)) {
        continue
      }
      const win = shop ? wide : thin
      if (win) {
        // the kit's sash sits `WINDOW_SASH` above its origin; scale it to the storey
        const s = shop ? SHOP_WINDOW_SCALE : WINDOW_SCALE
        const y = sill - WINDOW_SASH * s + WINDOW_LIFT
        const at = onSide(b, side, a + span / 2, y)
        at.multiply(new Matrix4().makeScale(s, s, 1))
        bs.kit.push({ def: win, at })
        if (!bs.lean) {
          // A proud sill and lintel give the flat wall a shadow line and depth at eye level.
          const along = side === 'n' || side === 's'
          const [q] = faceQuad(b, side, a + span / 2, a + span / 2, 0, 1, 0.075)
          if (q) {
            const bottom = y + 0.975 * s
            const top = y + 2.533 * s
            for (const yy of [bottom - 0.04, top + 0.04]) {
              bs.wood.box(
                q.x,
                yy,
                q.z,
                along ? span + 0.32 : 0.11,
                0.08,
                along ? 0.11 : span + 0.32,
                DARK_WOOD,
              )
            }
          }
        }
        // shutters, as on the duel street's upper windows: on every upper floor, and round the
        // houses' and barns' windows (never a shopfront's display glass)
        if (shutter && !shop && (f > 0 || !SHOPFRONT.has(b.kind)) && !bs.lean) {
          const st = onSide(b, side, a + span / 2, y, -0.12)
          st.multiply(new Matrix4().makeScale(s, s, 1))
          bs.kit.push({ def: shutter, at: st })
        }
        if (b.hollow && sill < b.height - 0.2) {
          // the same window seen from inside the room (the wall itself is solid)
          const [q] = faceQuad(b, side, a + span / 2, 0, 0, 1, -WALL_T)
          const hidden = against.some(
            (c) =>
              q &&
              q.x > c.x - span / 2 - 0.3 &&
              q.x < c.x + c.w + span / 2 + 0.3 &&
              q.z > c.z - span / 2 - 0.3 &&
              q.z < c.z + c.d + span / 2 + 0.3,
          )
          if (q && !hidden) {
            const inner = placeMatrix(q.x, y, q.z, SIDE_RY[side] + Math.PI)
            inner.multiply(new Matrix4().makeScale(s, s, 1))
            if (bs.lean) {
              // floor tier: the inside of a window is two flat quads
              flatWindow(bs.room(b.id).windows, win, inner)
            } else {
              bs.room(b.id).kit.push({ def: win, at: inner })
            }
          }
        }
        continue
      }
      const q = faceQuad(b, side, a, a + span, sill, sill + 1.5, 0.04)
      const [p0, p1, p2, p3] = q
      if (p0 && p1 && p2 && p3) {
        bs.windows.quad(p0, p1, p2, p3, glass)
      }
    }
  }
}

/**
 * A dark-wood frame round every doorway. Built from jambs and a lintel rather than stretching the
 * 2.30 m kit frame over a 2.45 m opening: the frame now reaches the wall over the door exactly,
 * on every side and every door width.
 */
function addDoorFrames(bs: Builders, b: Building, porch: Side | null): void {
  for (const d of b.doors) {
    // A hair above the floor/wall sole: a jamb foot coplanar with the wall's bottom face is a
    // z-fight the float audit sees even though it is underfoot.
    const base = (d.side === porch ? PORCH_DECK : 0) + 0.012
    const top = doorTop(d.width)
    const along = d.side === 'n' || d.side === 's'
    const cx = along ? b.x + d.at + d.width / 2 : b.x + b.w / 2
    const cz = along ? b.z + b.d / 2 : b.z + d.at + d.width / 2
    // Centred on the wall, not tucked inside it: the frame protrudes a few centimetres on both
    // faces, so it reads from the street and from the room.
    const zWall = d.side === 'n' ? b.z + WALL_T / 2 : b.z + b.d - WALL_T / 2
    const xWall = d.side === 'w' ? b.x + WALL_T / 2 : b.x + b.w - WALL_T / 2
    // jambs, one each side, nudged 12 mm into the opening so their faces are not coplanar with
    // the wall's cut faces at the door edges.
    for (const a of [d.at - DOOR_JAMB / 2 + 0.012, d.at + d.width + DOOR_JAMB / 2 - 0.012]) {
      bs.wood.box(
        along ? b.x + a : xWall,
        (base + top) / 2,
        along ? zWall : b.z + a,
        along ? DOOR_JAMB : DOOR_FRAME_DEPTH,
        top - base,
        along ? DOOR_FRAME_DEPTH : DOOR_JAMB,
        DARK_WOOD,
      )
    }
    // lintel: its underside is the opening's top, so there is no gap
    bs.wood.box(
      along ? cx : xWall,
      top + DOOR_HEAD / 2,
      along ? zWall : cz,
      along ? d.width + DOOR_JAMB * 2 : DOOR_FRAME_DEPTH,
      DOOR_HEAD,
      along ? DOOR_FRAME_DEPTH : d.width + DOOR_JAMB * 2,
      DARK_WOOD,
    )
  }
}

/** Where a hollow building's ceiling sits: the first storey's on two-storey fronts. */
export function ceilingHeight(b: Building): number {
  return b.floors > 1 ? 3.3 : b.height - 0.05
}

/**
 * A plank ceiling inside every walk-in building, so a third-person camera inside sees a room,
 * not sky. Only its underside is built: from above (the top-down camera, and with the roof faded
 * over you) back-face culling hides it, so the top-down view is unchanged. Joists run across.
 */
function addCeiling(bs: Builders, b: Building): void {
  const room = bs.room(b.id)
  const cx = b.x + b.w / 2
  const cz = b.z + b.d / 2
  const iw = b.w - WALL_T * 2
  const id = b.d - WALL_T * 2
  const only = { skip: ['top', 'px', 'nx', 'pz', 'nz'] }
  if (b.floors > 1 && b.upperFloor && b.upperFloor.length > 0) {
    // A real second floor: boards you can walk on, a ceiling above, and the stair opening.
    for (const f of b.upperFloor) {
      room.wood.box(f.x + f.w / 2, f.y - 0.05, f.z + f.d / 2, f.w, 0.1, f.d, 0x9a_7a_58, {
        skip: ['bottom'],
      })
    }
    addStairs(bs, b)
    addFlatCeiling(room, b, b.height - 0.05, iw, id, cx, cz, bs.lean)
    return
  }
  addFlatCeiling(room, b, ceilingHeight(b), iw, id, cx, cz, bs.lean, only)
}

/** The plank ceiling (and its joists) at one height. */
function addFlatCeiling(
  room: Builders,
  b: Building,
  y: number,
  iw: number,
  id: number,
  cx: number,
  cz: number,
  lean: boolean,
  only: { skip?: string[] } = {},
): void {
  room.wood.box(cx, y, cz, iw, 0.02, id, 0x8a_6a_4a, only)
  if (lean) {
    return
  }
  const alongX = iw <= id
  const span = alongX ? id : iw
  for (let a = 1.2; a < span - 0.6; a += 1.8) {
    const jx = alongX ? cx : b.x + WALL_T + a
    const jz = alongX ? b.z + WALL_T + a : cz
    room.wood.box(jx, y - 0.1, jz, alongX ? iw : 0.14, 0.18, alongX ? 0.14 : id, DARK_WOOD, {
      skip: ['top'],
    })
  }
}

/** Steps and a handrail for a real second floor. */
function addStairs(bs: Builders, b: Building): void {
  const room = bs.room(b.id)
  for (const st of b.stairs ?? []) {
    const rise = st.toY - st.fromY
    const steps = Math.max(4, Math.ceil(Math.abs(rise) / 0.22))
    const along = st.dir === 'n' || st.dir === 's'
    const run = along ? st.d : st.w
    const depth = run / steps
    const width = along ? st.w : st.d
    const stepRise = rise / steps
    const at = (t: number): { x: number; z: number } => {
      const u = Math.max(0, Math.min(1, t))
      if (along) {
        return {
          x: st.x + st.w / 2,
          z: st.dir === 's' ? st.z + run * u : st.z + run * (1 - u),
        }
      }
      return {
        x: st.dir === 'e' ? st.x + run * u : st.x + run * (1 - u),
        z: st.z + st.d / 2,
      }
    }
    // A solid staircase: treads with risers, two side stringers, a handrail and newels.
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps
      const p = at(t)
      const y = st.fromY + stepRise * (i + 1)
      const h = stepRise + 0.08
      room.wood.box(
        p.x,
        y - h / 2,
        p.z,
        along ? width : depth,
        h,
        along ? depth : width,
        0x9a_7a_58,
      )
      // stringers under the treads, one each side
      for (const s of [-1, 1] as const) {
        room.wood.box(
          along ? p.x + (s * (width - 0.08)) / 2 : p.x,
          y - h / 2 - 0.14,
          along ? p.z : p.z + (s * (width - 0.08)) / 2,
          along ? 0.1 : depth + 0.05,
          0.28,
          along ? depth + 0.05 : 0.1,
          0x6a_4c_34,
        )
      }
      // the rail and its balusters on the open side
      const railSide = 1
      const railX = along ? p.x + (railSide * (width - 0.1)) / 2 : p.x
      const railZ = along ? p.z : p.z + (railSide * (width - 0.1)) / 2
      room.wood.box(
        railX,
        y + 0.95,
        railZ,
        along ? 0.07 : depth + 0.02,
        0.07,
        along ? depth + 0.02 : 0.07,
        DARK_WOOD,
      )
      room.wood.box(railX, y + 0.48, railZ, 0.05, 0.9, 0.05, 0x6a_4c_34)
    }
    const foot = at(0)
    const head = at(1)
    room.wood.box(foot.x, st.fromY + 0.58, foot.z, 0.12, 1.16, 0.12, DARK_WOOD)
    room.wood.box(head.x, st.toY + 0.58, head.z, 0.12, 1.16, 0.12, DARK_WOOD)
    // A low rail round the stairwell opening on the upper floor, so the hole reads safely.
    const railY = st.toY + 0.9
    if (along) {
      for (const x of [st.x, st.x + st.w]) {
        room.wood.box(x, railY, st.z + st.d / 2, 0.08, 0.08, st.d, DARK_WOOD)
        room.wood.box(x, st.toY + 0.45, st.z, 0.08, 0.9, 0.08, 0x6a_4c_34)
        room.wood.box(x, st.toY + 0.45, st.z + st.d, 0.08, 0.9, 0.08, 0x6a_4c_34)
      }
    } else {
      for (const z of [st.z, st.z + st.d]) {
        room.wood.box(st.x + st.w / 2, railY, z, st.w, 0.08, 0.08, DARK_WOOD)
        room.wood.box(st.x, st.toY + 0.45, z, 0.08, 0.9, 0.08, 0x6a_4c_34)
        room.wood.box(st.x + st.w, st.toY + 0.45, z, 0.08, 0.9, 0.08, 0x6a_4c_34)
      }
    }
  }
}

/** Rugs and wall pictures: the cheap, non-colliding detail that makes a room read as lived-in. */
function addRoomDressing(bs: Builders, b: Building): void {
  const room = bs.room(b.id)
  const cx = b.x + b.w / 2
  const cz = b.z + b.d / 2
  const big = b.w * b.d > 180
  const rug =
    b.kind === 'church'
      ? [0x5a_1e_18, 0x7a_3a_2a]
      : b.kind === 'saloon'
        ? [0x5a_2a_24, 0x74_40_38]
        : b.kind === 'hotel'
          ? [0x2a_3a_42, 0x3e_4e_56]
          : b.kind === 'bank'
            ? [0x2e_3a_28, 0x46_54_3a]
            : [0x3a_2e_24, 0x55_45_38]
  const rw = b.kind === 'church' ? 2.2 : big ? 4.2 : 2.8
  const rd = b.kind === 'church' ? b.d - 5 : big ? 2.8 : 1.9
  room.cloth.box(cx, 0.045, cz, rw, 0.02, rd, rug[0] ?? 0x3a_2a_20, { skip: ['bottom'] })
  room.cloth.box(cx, 0.056, cz, rw - 0.35, 0.012, rd - 0.3, rug[1] ?? 0x5a_40_30, {
    skip: ['bottom'],
  })
}

/** The solid stretches of one side between its doorways, as [from, to] metres along it. */
function solidRuns(b: Building, side: Side): [number, number][] {
  const len = sideLength(b, side)
  const gaps = b.doors
    .filter((d) => d.side === side)
    .map((d) => [d.at, d.at + d.width] as const)
    .toSorted((p, q) => p[0] - q[0])
  const out: [number, number][] = []
  let start = 0
  for (const [g0, g1] of gaps) {
    if (g0 > start) {
      out.push([start, g0])
    }
    start = Math.max(start, g1)
  }
  if (start < len) {
    out.push([start, len])
  }
  return out
}

/**
 * What makes a plank wall read as built at eye level: corner boards up every corner, a skirting
 * board along the foot (stopping at doorways), and on two-storey fronts a belt course where the
 * floors meet. Brick buildings get a stone plinth instead of the skirting.
 */
function addFacadeTrim(bs: Builders, b: Building, p: Paint, front: Side): void {
  if (bs.lean) {
    // floor tier: the planks and the paint carry the facade
    return
  }
  const decked = PORCHED.has(b.kind) || b.kind === 'depot'
  const h = b.height
  const out = 0.04
  if (!p.stone) {
    for (const [x, z] of [
      [b.x, b.z],
      [b.x + b.w, b.z],
      [b.x, b.z + b.d],
      [b.x + b.w, b.z + b.d],
    ] as const) {
      bs.wood.box(x, (h - 0.3) / 2, z, 0.26, h - 0.3, 0.26, p.trim)
    }
  }
  for (const side of ['n', 's', 'e', 'w'] as const) {
    const along = side === 'n' || side === 's'
    if (decked && side === front) {
      // the porch deck runs along this foot
      continue
    }
    for (const [a0, a1] of solidRuns(b, side)) {
      const [q0, q1] = faceQuad(b, side, a0 + 0.13, a1 - 0.13, 0, 1, out / 2)
      if (!(q0 && q1) || a1 - a0 < 0.4) {
        continue
      }
      const cx = (q0.x + q1.x) / 2
      const cz = (q0.z + q1.z) / 2
      const len = a1 - a0 - 0.26
      const base = p.stone ? bs.stone : bs.wood
      const baseH = p.stone ? 0.45 : 0.24
      base.box(
        cx,
        baseH / 2,
        cz,
        along ? len : out,
        baseH,
        along ? out : len,
        p.stone ? 0x8a_80_74 : DARK_WOOD,
      )
      if (b.floors > 1) {
        bs.wood.box(cx, 3.2, cz, along ? len : out * 1.5, 0.16, along ? out * 1.5 : len, p.trim)
      }
    }
  }
}

/** A closed plank door on the front of a building you can't go into, so it never reads as a box. */
function addClosedDoor(bs: Builders, b: Building, front: Side): void {
  const door = kitDef('k_door_plank')
  if (!door) {
    return
  }
  const width = 1.4
  const a = sideLength(b, front) / 2 - width / 2
  addDoorFrames(bs, { ...b, doors: [{ side: front, at: a, width }] }, null)
  // Fit the native 1.118 × 2.092 leaf to the opening.
  const at = onSide(b, front, a + width / 2, -0.01, 0.04)
  at.multiply(new Matrix4().makeScale(width / 1.118, (doorTop(width) - 0.12) / 2.092, 1))
  bs.kit.push({ def: door, at })
}

function addBuilding(bs: Builders, b: Building, layout: TownLayout, id: number): void {
  const p = PAINT[b.kind] ?? DEFAULT_PAINT
  const g = p.stone ? bs.stone : bs.wall
  const front = frontOf(b, layout)
  const h = b.height
  if (b.kind === 'water_tower') {
    addWaterTower(bs, b)
    return
  }
  if (b.kind === 'tower') {
    addClockTower(bs, b, id, layout.buildings)
    return
  }
  for (const w of buildingWallSpans(b)) {
    const y0 = w.y0 ?? 0
    const y1 = w.y1 ?? h
    g.box(w.x + w.w / 2, (y0 + y1) / 2, w.z + w.d / 2, w.w, y1 - y0, w.d, p.wall)
  }
  // the wall over every doorway (the collision gap runs full height; the opening doesn't)
  for (const d of b.doors) {
    const [q0, q1] = faceQuad(b, d.side, d.at, d.at + d.width, 0, 1, -WALL_T / 2)
    if (q0 && q1) {
      const along = d.side === 'n' || d.side === 's'
      // Start the wall above the lintel's top, not the opening's top: otherwise the lintel's
      // bottom face and the wall's bottom face are coplanar (the z-fight the float audit finds).
      const y0 = doorTop(d.width) + DOOR_HEAD
      g.box(
        (q0.x + q1.x) / 2,
        (y0 + h) / 2,
        (q0.z + q1.z) / 2,
        along ? d.width : WALL_T,
        h - y0,
        along ? WALL_T : d.width,
        p.wall,
      )
    }
  }
  addFacadeTrim(bs, b, p, front)
  if (b.hollow) {
    bs.wood.box(
      b.x + b.w / 2,
      0.015,
      b.z + b.d / 2,
      b.w - WALL_T * 2,
      0.03,
      b.d - WALL_T * 2,
      0x9a_7a_58,
      { skip: ['bottom'] },
    )
    addCeiling(bs, b)
    addRoomDressing(bs, b)
  }
  // Trim: a band round the top of the walls, flush on their faces (an open-bottomed shell 6 cm
  // out left a slot of air between the band and the wall)
  const t = 0.06
  for (const [x, z, w, d] of [
    [b.x + b.w / 2, b.z - t / 2, b.w + 2 * t, t],
    [b.x + b.w / 2, b.z + b.d + t / 2, b.w + 2 * t, t],
    [b.x - t / 2, b.z + b.d / 2, t, b.d],
    [b.x + b.w + t / 2, b.z + b.d / 2, t, b.d],
  ] as const) {
    bs.wood.box(x, h - 0.15, z, w, 0.3, d, p.trim, { skip: ['top'] })
  }
  for (const side of ['n', 's', 'e', 'w'] as const) {
    if (b.kind !== 'tower') {
      addWindows(
        bs,
        b,
        side,
        b.floors,
        front,
        layout.cover.filter((c) => AGAINST_WALL.has(c.kind)),
      )
    }
  }
  // Roof: pitched, shingled or tin, with ridge and edge trim (see roofs.ts).
  const skin = roofSkin(b.kind, id)
  const span = front === 'n' || front === 's' ? b.w : b.d
  const bays = p.falseFront && span > 13 ? 2 : 1
  const built = buildRoof(
    p.falseFront
      ? {
          b,
          // the western roof: a low gable running back from the street, under the false front
          axis: front === 'n' || front === 's' ? 'z' : 'x',
          rise: Math.min(1.45, (span / bays / 2) * 0.55),
          bays,
          overhang: 0.35,
          front,
          skin,
          color: skin === 'tin' ? tinColor(b.kind, id) : bleach(p.roof),
          trim: p.trim,
          wallColor: p.wall,
        }
      : {
          b,
          axis: b.w >= b.d ? 'x' : 'z',
          rise: Math.min(b.w, b.d) * 0.32,
          bays: 1,
          overhang: 0.5,
          front: null,
          skin,
          color: skin === 'tin' ? tinColor(b.kind, id) : bleach(p.roof),
          trim: p.trim,
          wallColor: p.wall,
        },
    g,
  )
  const rg = built.geometry
  rg.setAttribute(
    'bid',
    new BufferAttribute(new Float32Array(rg.getAttribute('position').count).fill(id), 1),
  )
  bs.roofs.push(rg)
  addDoorFrames(bs, b, PORCHED.has(b.kind) || b.kind === 'depot' ? front : null)
  if (b.doors.length === 0) {
    addClosedDoor(bs, b, front)
  }
  if (p.falseFront) {
    addFalseFront(bs, b, front, p, built.heightAt)
  }
  if (PORCHED.has(b.kind)) {
    addPorch(bs, b, front)
  }
  if (b.kind === 'depot') {
    addPlatform(bs, b, front)
  }
  if (p.sign && !p.falseFront) {
    const q = faceQuad(
      b,
      front,
      sideLength(b, front) / 2 - 2.2,
      sideLength(b, front) / 2 + 2.2,
      h - 1.3,
      h - 0.3,
      0.06,
    )
    bs.signs.push({ text: p.sign, bg: p.signBg, fg: '#2a1a10', quad: q })
  }
}

function addFalseFront(
  bs: Builders,
  b: Building,
  front: Side,
  p: Paint,
  roofAt: (x: number, z: number) => number,
): void {
  const len = sideLength(b, front)
  const top = b.height + 1.8
  const g = p.stone ? bs.stone : bs.wall
  const [q0, q1, q2, q3] = faceQuad(b, front, 0, len, b.height, top, 0)
  if (!(q0 && q1 && q2 && q3)) {
    return
  }
  const cx = (q0.x + q1.x) / 2
  const cz = (q0.z + q1.z) / 2
  const along = front === 'n' || front === 's'
  g.box(cx, (b.height + top) / 2, cz, along ? len : 0.3, top - b.height, along ? 0.3 : len, p.wall)
  bs.wood.box(cx, top + 0.1, cz, along ? len + 0.3 : 0.5, 0.2, along ? 0.5 : len + 0.3, p.trim)
  // the duel street's false-front joinery: a cornice band under the cap on a row of brackets,
  // and pilasters at both ends
  const at = (a: number, out: number) => faceQuad(b, front, a, a, 0, 1, out)[0] ?? new Vector3()
  const mid = at(len / 2, 0.25)
  bs.wood.box(
    mid.x,
    top - 0.28,
    mid.z,
    along ? len + 0.2 : 0.2,
    0.16,
    along ? 0.2 : len + 0.2,
    p.trim,
  )
  if (!bs.lean) {
    const n = Math.max(2, Math.round(len / 1.1))
    for (let k = 0; k <= n; k++) {
      const q = at(0.2 + ((len - 0.4) * k) / n, 0.22)
      bs.wood.box(q.x, top - 0.47, q.z, along ? 0.12 : 0.14, 0.22, along ? 0.14 : 0.12, p.trim)
    }
  }
  for (const a of [0.14, len - 0.14]) {
    const q = at(a, 0.2)
    bs.wood.box(
      q.x,
      (b.height - 0.2 + top - 0.36) / 2,
      q.z,
      along ? 0.28 : 0.1,
      top - b.height - 0.16,
      along ? 0.1 : 0.28,
      p.trim,
    )
  }
  if (p.sign) {
    const fg = p.signBg === '#e8c870' || p.signBg.startsWith('#e') ? '#2a1a10' : '#f0e2c0'
    // a dark frame stands the painted board off the front
    const fr = at(len / 2, 0.17)
    const fh = top - b.height - 0.85
    bs.wood.box(
      fr.x,
      b.height + 0.1 + fh / 2,
      fr.z,
      along ? 6.3 : 0.04,
      fh + 0.16,
      along ? 0.04 : 6.3,
      0x2a_1d_14,
    )
    // On the street face; and for fronts facing away from the camera, a board on the roof too.
    bs.signs.push({
      text: p.sign,
      bg: p.signBg,
      fg,
      quad: faceQuad(
        b,
        front,
        len / 2 - 3,
        len / 2 + 3,
        b.height + 0.18,
        b.height + 0.02 + fh,
        0.2,
      ),
    })
    if (front !== 's') {
      const z = b.z + b.d / 2
      const x0 = b.x + b.w / 2 - 3
      const x1 = b.x + b.w / 2 + 3
      // the board stands on two legs over the pitched roof, clear of every ridge under it
      let roofTop = 0
      for (let x = x0; x <= x1; x += 0.25) {
        roofTop = Math.max(roofTop, roofAt(x, z - 0.2), roofAt(x, z + 0.9))
      }
      roofTop += 0.15
      const y = Math.max(top - 0.4, roofTop + 1.2)
      for (const lx of [x0 + 0.6, x1 - 0.6]) {
        const foot = roofAt(lx, z - 0.27) - 0.05
        bs.wood.box(lx, (foot + y) / 2, z - 0.27, 0.12, y - foot, 0.12, DARK_WOOD)
      }
      bs.signs.push({
        text: p.sign,
        bg: p.signBg,
        fg,
        quad: [
          new Vector3(x0, roofTop, z + 0.9),
          new Vector3(x1, roofTop, z + 0.9),
          new Vector3(x1, y, z - 0.2),
          new Vector3(x0, y, z - 0.2),
        ],
      })
    }
  }
}

/**
 * Catwalks on the porch roofs the sim lets a rider walk (ffa/sim/roofwalks.ts): a plank layer on
 * the existing roof, a ladder at the eave, and a low handrail on one-storey fronts (two-storey
 * fronts already have their balcony rail).
 */
function addRoofWalks(bs: Builders): void {
  for (const w of ROOF_WALKS) {
    const cx = w.x + w.w / 2
    const cz = w.z + w.d / 2
    bs.wood.box(cx, w.height - 0.02, cz, w.w, 0.04, w.d, 0x9a_7a_58, { skip: ['bottom'] })
    // the ladder: rails and rungs on the eave's face, from the street to the boards
    const rungs = Math.max(4, Math.round(w.height / 0.38))
    const along = w.side === 'n' || w.side === 's'
    const railH = w.height - 0.06
    for (const d of [-0.24, 0.24] as const) {
      bs.wood.box(
        w.ladderX + (along ? d : 0),
        railH / 2,
        w.ladderZ + (along ? 0 : d),
        0.05,
        railH,
        0.05,
        0x8a_6a_48,
      )
    }
    for (let i = 1; i < rungs; i++) {
      const y = (i / rungs) * railH
      bs.wood.box(
        w.ladderX,
        y,
        w.ladderZ,
        along ? 0.48 : 0.05,
        0.04,
        along ? 0.05 : 0.48,
        0x8a_6a_48,
      )
    }
    if (w.floors > 1) {
      continue
    }
    // a low rail on the open side, split round the ladder's top
    const railY = w.height + 0.55
    const post = 0.07
    const runs: [number, number][] =
      w.side === 'n' || w.side === 's'
        ? [
            [w.x, w.ladderX - 0.5],
            [w.ladderX + 0.5, w.x + w.w],
          ]
        : [
            [w.z, w.ladderZ - 0.5],
            [w.ladderZ + 0.5, w.z + w.d],
          ]
    for (const [a0, a1] of runs) {
      if (a1 - a0 < 0.3) {
        continue
      }
      const mid = (a0 + a1) / 2
      const len = a1 - a0
      if (w.side === 'n' || w.side === 's') {
        const z = w.side === 'n' ? w.z : w.z + w.d
        bs.wood.box(mid, railY, z, len, post, post, 0x8a_6a_48)
        bs.wood.box(a0, w.height + 0.27, z, post, 0.54, post, 0x8a_6a_48)
        bs.wood.box(a1, w.height + 0.27, z, post, 0.54, post, 0x8a_6a_48)
      } else {
        const x = w.side === 'e' ? w.x + w.w : w.x
        bs.wood.box(x, railY, mid, post, post, len, 0x8a_6a_48)
        bs.wood.box(x, w.height + 0.27, a0, post, 0.54, post, 0x8a_6a_48)
        bs.wood.box(x, w.height + 0.27, a1, post, 0.54, post, 0x8a_6a_48)
      }
    }
  }
}

function addPorch(bs: Builders, b: Building, front: Side): void {
  const len = sideLength(b, front)
  const depth = PORCH_DEPTH
  const y = PORCH_ROOF
  const [q0, q1] = faceQuad(b, front, 0, len, 0, 1, depth / 2)
  if (!(q0 && q1)) {
    return
  }
  const along = front === 'n' || front === 's'
  const cx = (q0.x + q1.x) / 2
  const cz = (q0.z + q1.z) / 2
  bs.wood.box(cx, PORCH_DECK / 2, cz, along ? len : depth, PORCH_DECK, along ? depth : len, WOOD, {
    skip: ['bottom'],
  })
  bs.wood.box(
    cx,
    y,
    cz,
    along ? len + 0.2 : depth + 0.2,
    0.12,
    along ? depth + 0.2 : len + 0.2,
    DARK_WOOD,
  )
  // A deep fascia beam under the roof's outer edge: the porch reads as built, not a flat slab.
  const outer = { x: cx, z: cz }
  if (along) {
    outer.z += front === 's' ? depth / 2 : -depth / 2
  } else {
    outer.x += front === 'e' ? depth / 2 : -depth / 2
  }
  bs.wood.box(
    outer.x,
    y - 0.17,
    outer.z,
    along ? len + 0.25 : 0.18,
    0.18,
    along ? 0.18 : len + 0.25,
    DARK_WOOD,
  )
  // a balcony rail along the porch roof (two-storey fronts)
  if (b.floors > 1) {
    addBalconyRail(bs, b, front, y + 0.06, depth)
  }
}

/**
 * A balcony rail round the porch roof of a two-storey front: handrail, bottom rail, square
 * balusters and posts, returning to the wall at both ends. Built into the wood batch (about a
 * tenth of the kit balcony's triangles, which the whole street saw from 100 m off).
 */
function addBalconyRail(bs: Builders, b: Building, front: Side, y: number, depth: number): void {
  const len = sideLength(b, front)
  const out = depth - 0.12
  const runs: [number, number, number, number][] = [
    [0.1, len - 0.1, out, out],
    [0.1, 0.1, 0.1, out],
    [len - 0.1, len - 0.1, 0.1, out],
  ]
  for (const [a0, a1, o0, o1] of runs) {
    const [p0] = faceQuad(b, front, a0, a0, 0, 1, o0)
    const [p1] = faceQuad(b, front, a1, a1, 0, 1, o1)
    if (!(p0 && p1)) {
      continue
    }
    const dx = p1.x - p0.x
    const dz = p1.z - p0.z
    const L = Math.hypot(dx, dz)
    const cx = (p0.x + p1.x) / 2
    const cz = (p0.z + p1.z) / 2
    const alongX = Math.abs(dx) >= Math.abs(dz)
    for (const [yy, hh] of [
      [y + 0.95, 0.08],
      [y + 0.12, 0.06],
    ] as const) {
      bs.wood.box(cx, yy, cz, alongX ? L + 0.08 : 0.08, hh, alongX ? 0.08 : L + 0.08, DARK_WOOD)
    }
    const n = Math.max(1, Math.round(L / 0.22))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      const post = k % 9 === 0 || k === n
      const s = post ? 0.1 : 0.045
      bs.wood.box(
        p0.x + dx * t,
        y + (post ? 0.5 : 0.53),
        p0.z + dz * t,
        s,
        post ? 1.0 : 0.76,
        s,
        DARK_WOOD,
        {
          skip: post ? [] : ['top', 'bottom'],
        },
      )
    }
  }
}

function addWaterTower(bs: Builders, b: Building): void {
  const cx = b.x + b.w / 2
  const cz = b.z + b.d / 2
  for (const [dx, dz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    // up to the platform's underside, not flush with its top (z-fighting)
    bs.wood.box(cx + dx * 1.86, 3.9, cz + dz * 1.86, 0.26, 7.8, 0.26, DARK_WOOD)
  }
  // the pump house under the tank fills the footprint (what blocks you is what you see)
  bs.wall.box(cx, 1.3, cz, b.w - 0.5, 2.6, b.d - 0.5, 0x6a_4e_36)
  bs.wood.gable(cx, 2.6, cz, b.w - 0.5, b.d - 0.5, 0.6, 'x', 0x5a_4a_3a, 0.12)
  addClosedDoor(bs, { ...b, x: b.x + 0.25, z: b.z + 0.25, w: b.w - 0.5, d: b.d - 0.5 }, 's')
  bs.wood.box(cx, 7.9, cz, 4.4, 0.2, 4.4, DARK_WOOD)
  const tank = new CylinderGeometry(2.1, 2.1, 3.6, 16, 1, false).toNonIndexed()
  tank.translate(cx, 9.8, cz)
  const cap = new CylinderGeometry(0.2, 2.4, 1.4, 16, 1, false).toNonIndexed()
  cap.translate(cx, 12.3, cz)
  for (const [geo, color] of [
    [tank, 0x7a_5a_3c],
    [cap, 0x4a_3a_2c],
  ] as const) {
    const n = geo.getAttribute('position').count
    const c = new Float32Array(n * 3)
    const col = new Vector3(
      ((color >> 16) & 255) / 255,
      ((color >> 8) & 255) / 255,
      (color & 255) / 255,
    )
    for (let i = 0; i < n; i++) {
      c.set([col.x ** 2.2, col.y ** 2.2, col.z ** 2.2], i * 3)
    }
    geo.setAttribute('color', new Float32BufferAttribute(c, 3))
    bs.extra.push(geo)
  }
}

/**
 * The bank's deposit windows: a teller cage at each one on the lobby partition (a counter ledge,
 * brass bars, a lamp) under a DEPOSITS board, so the four spots read from the doorways. The
 * stage-line counter is a cover piece of its own.
 */
function addBank(bs: Builders, layout: TownLayout): void {
  const windows = layout.zones.filter((z) => z.kind === 'bank')
  if (windows.length === 0) {
    return
  }
  // the partition's north face sits 1.5 m behind each window's centre
  const face = (windows[0]?.z ?? 0) + 1.5
  for (const z of windows) {
    // counter front a hand proud of the partition, its ledge at waist height
    bs.wood.box(z.x, 0.52, face - 0.12, 1.9, 1.04, 0.24, 0x4a_2e_1c)
    bs.wood.box(z.x, 1.07, face - 0.16, 2.0, 0.06, 0.32, 0x8a_5a_34)
    // brass bars and an arched brass top
    for (let k = 0; k < 9; k++) {
      bs.windows.box(z.x - 0.8 + k * 0.2, 1.65, face - 0.03, 0.03, 1.1, 0.03, 0xc8_a0_50)
    }
    bs.windows.box(z.x, 2.24, face - 0.03, 1.7, 0.08, 0.05, 0xd8_b0_58)
    bs.windows.box(z.x, 1.12, face - 0.03, 1.7, 0.05, 0.05, 0xd8_b0_58)
    // a green-shaded teller lamp glows on the ledge
    bs.windows.box(z.x + 0.6, 1.16, face - 0.2, 0.22, 0.12, 0.16, 0x2a_6a_3a)
  }
  const x0 = Math.min(...windows.map((z) => z.x)) - 1
  const x1 = Math.max(...windows.map((z) => z.x)) + 1
  bs.signs.push({
    text: 'DEPOSITS',
    bg: '#1e2a22',
    fg: '#e8c870',
    quad: [
      // wound to face north, into the lobby
      new Vector3(x1 - 2, 2.45, face - 0.01),
      new Vector3(x0 + 2, 2.45, face - 0.01),
      new Vector3(x0 + 2, 3.05, face - 0.01),
      new Vector3(x1 - 2, 3.05, face - 0.01),
    ],
  })
}

/** A plank bridge at grade over the dry creek (riders walk at ground level): deck and sills. */
function addCreek(bs: Builders, layout: TownLayout): void {
  const br = layout.creek.bridge
  const deck = PORCH_DECK
  bs.wood.box(br.x + br.w / 2, deck / 2, br.z + br.d / 2, br.w, deck, br.d, WOOD, {
    skip: ['bottom'],
  })
  // stringers along each edge, under the rails
  for (const x of [br.x + 0.25, br.x + br.w - 0.25]) {
    bs.wood.box(x, deck + 0.04, br.z + br.d / 2, 0.5, 0.08, br.d, DARK_WOOD)
  }
}

/** The depot's platform: a plank deck out to the track, with a timber edge. */
/** Handbills by the doors. */
const BILLS = ['WANTED', 'REWARD', 'DEAD OR ALIVE', 'LAND FOR SALE']

/** Painted advertisements high on the side walls that face the alleys and the street's ends. */
const WALL_ADS: Record<string, { side: Side; text: string; bg: string; fg: string }> = {
  livery: { side: 'e', text: 'FEED & SEED', bg: '#3a2a1e', fg: '#e8dcc0' },
  saloon: { side: 'w', text: 'BEER · WHISKEY', bg: '#2a1810', fg: '#e8c870' },
  hotel: { side: 'e', text: 'ROOMS & BATHS', bg: '#e8dcc0', fg: '#3a2a1e' },
  general_store: { side: 'w', text: 'DRY GOODS · HARDWARE', bg: '#3a2414', fg: '#f0e2c0' },
  undertaker: { side: 'e', text: 'COFFINS · EMBALMING', bg: '#141010', fg: '#c8c0b0' },
  stage_line: { side: 'e', text: 'WELLS & CO EXPRESS', bg: '#2a3a2e', fg: '#e8c870' },
  assay: { side: 'e', text: 'GOLD BOUGHT', bg: '#3a2414', fg: '#e8c870' },
  depot: { side: 'e', text: 'PERDITION', bg: '#e8d0a0', fg: '#3a2414' },
  hay_barn: { side: 's', text: 'HAY & GRAIN', bg: '#e8dcc0', fg: '#6a2a1e' },
}

/**
 * The ads: a painted board above the ground-floor windows (above the upper ones on a two-storey
 * wall), about two thirds of the wall wide. Two triangles each, in the shared sign atlas.
 */
function addWallAds(bs: Builders, layout: TownLayout): void {
  for (const b of layout.buildings) {
    const ad = WALL_ADS[b.id]
    if (!ad) {
      continue
    }
    const len = sideLength(b, ad.side)
    const w = Math.min(9, len * 0.66)
    const y0 = b.floors > 1 ? 5.95 : 2.85
    const y1 = Math.min(b.height - 0.35, y0 + Math.min(1.2, w * 0.16))
    bs.signs.push({
      text: ad.text,
      bg: ad.bg,
      fg: ad.fg,
      quad: faceQuad(b, ad.side, len / 2 - w / 2, len / 2 + w / 2, y0, y1, 0.012),
    })
  }
}

/** Plank crossings over main street at the alley mouths, flush in the dirt (walk-through decks). */
function addCrossings(bs: Builders, layout: TownLayout): void {
  const main = layout.streets[0]
  if (!main) {
    return
  }
  for (const x of [42, 87]) {
    let k = 0
    for (let z = main.z + 0.15; z < main.z + main.d - 0.2; z += 0.46) {
      const shade = [0x9a_7a_58, 0x8a_6c_4c, 0xa8_86_60][k++ % 3] ?? 0x9a_7a_58
      bs.wood.box(x, 0.02, z + 0.22, 2 - (k % 2) * 0.12, 0.04, 0.43, shade, { skip: ['bottom'] })
    }
  }
}

function addPlatform(bs: Builders, b: Building, front: Side): void {
  const r = sideStrip(b, front, PLATFORM_DEPTH)
  bs.wood.box(r.x + r.w / 2, PORCH_DECK / 2, r.z + r.d / 2, r.w, PORCH_DECK, r.d, WOOD, {
    skip: ['bottom'],
  })
  const along = front === 'n' || front === 's'
  const [edge] = faceQuad(b, front, sideLength(b, front) / 2, 0, 0, 1, PLATFORM_DEPTH - 0.1)
  if (edge) {
    bs.wood.box(
      edge.x,
      PORCH_DECK + 0.04,
      edge.z,
      along ? r.w : 0.2,
      0.08,
      along ? 0.2 : r.d,
      0xd8_c0_40,
    )
  }
}

/**
 * Life on the street that never blocks: a lantern under the porch roof by every front door, and
 * laundry strung high across the back alleys (above any rider's head).
 */
function addDecor(bs: Builders, layout: TownLayout, lanterns: Matrix4[]): void {
  for (const b of layout.buildings) {
    if (!PORCHED.has(b.kind)) {
      continue
    }
    const front = frontOf(b, layout)
    for (const d of b.doors.filter((dd) => dd.side === front)) {
      const [q] = faceQuad(b, front, d.at + d.width + 0.6, 0, 0, 1, 0.5)
      if (q) {
        // hung from the porch roof's underside on a short chain
        bs.wood.box(q.x, PORCH_ROOF - 0.06 - 0.15, q.z, 0.02, 0.3, 0.02, 0x2a_2a_2a)
        lanterns.push(placeMatrix(q.x, PORCH_ROOF - 0.06 - 0.3 - 0.4, q.z, 0, 1))
      }
      // handbills pasted up beside the door, at eye level
      const bill = BILLS[Math.floor(b.x * 7 + b.z * 3) % BILLS.length] ?? 'WANTED'
      bs.signs.push({
        text: bill,
        bg: '#e4d6b4',
        fg: '#3a2414',
        quad: faceQuad(b, front, d.at - 0.85, d.at - 0.3, 1.45, 2.15, 0.012),
      })
      // a shingle sign hung from the porch beam, edge-on to the street, readable walking past
      const paint = PAINT[b.kind]
      const [s0] = faceQuad(b, front, d.at - 0.9, 0, 0, 1, PORCH_DEPTH - 0.45)
      if (paint?.sign && s0) {
        const along = front === 'n' || front === 's'
        const half = 0.55
        const y0 = 2.35
        const y1 = 2.8
        const fg = paint.signBg.startsWith('#e') ? '#2a1a10' : '#f0e2c0'
        for (const k of [1, -1]) {
          const ax = along ? 0 : k * half
          const az = along ? k * half : 0
          const nx = along ? k * 0.012 : 0
          const nz = along ? 0 : k * 0.012
          bs.signs.push({
            text: paint.sign,
            bg: paint.signBg,
            fg,
            quad: [
              new Vector3(s0.x - ax + nx, y0, s0.z - az + nz),
              new Vector3(s0.x + ax + nx, y0, s0.z + az + nz),
              new Vector3(s0.x + ax + nx, y1, s0.z + az + nz),
              new Vector3(s0.x - ax + nx, y1, s0.z - az + nz),
            ],
          })
        }
        bs.wood.box(
          s0.x,
          (y1 + PORCH_ROOF - 0.06) / 2,
          s0.z,
          0.02,
          PORCH_ROOF - 0.06 - y1,
          0.02,
          0x2a_2a_2a,
        )
      }
    }
  }
  // laundry lines across the alleys between neighbours (east wall of one, west wall of the next)
  const lines: [string, string, number][] = [
    ['livery', 'saloon', 46],
    ['hotel', 'assay', 50],
    ['bank', 'undertaker', 82],
    ['general_store', 'bank', 86],
  ]
  const shirt = [0xc8_c0_b0, 0x8a_9a_b8, 0xb8_5a_4a, 0xe0_d8_c0, 0x6a_7a_5a]
  for (const [wId, eId, z] of lines) {
    const w = layout.buildings.find((x) => x.id === wId)
    const e = layout.buildings.find((x) => x.id === eId)
    if (!(w && e)) {
      continue
    }
    const x0 = w.x + w.w
    const x1 = e.x
    const y = 3.2
    bs.wood.box((x0 + x1) / 2, y, z, x1 - x0, 0.02, 0.02, 0x3a_34_2a)
    let k = 0
    for (let x = x0 + 0.35; x < x1 - 0.5; x += 0.85) {
      const wdt = 0.45 + ((k * 7) % 3) * 0.1
      const h = 0.5 + ((k * 5) % 3) * 0.12
      const V = (xx: number, yy: number) => new Vector3(xx, yy, z)
      bs.cloth.quad(
        V(x, y - h),
        V(x + wdt, y - h),
        V(x + wdt, y),
        V(x, y),
        shirt[k % shirt.length] ?? 0xc8_c0_b0,
      )
      k++
    }
  }
}

function signMesh(signs: Builders['signs'], mat: MeshStandardMaterial): Mesh | null {
  if (signs.length === 0) {
    return null
  }
  const unique = [...new Map(signs.map((s) => [s.text, s])).values()]
  const { tex, rows } = signAtlas(unique.map((s) => ({ text: s.text, bg: s.bg, fg: s.fg })))
  mat.map = tex
  const pos: number[] = []
  const uv: number[] = []
  const nor: number[] = []
  for (const s of signs) {
    const row = unique.findIndex((u) => u.text === s.text)
    const v0 = 1 - (row + 1) / rows
    const v1 = 1 - row / rows
    const [a, b, c, d] = s.quad
    if (!(a && b && c && d)) {
      continue
    }
    const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(d, a)).normalize()
    for (const [p, u, v] of [
      [a, 0, v0],
      [b, 1, v0],
      [c, 1, v1],
      [a, 0, v0],
      [c, 1, v1],
      [d, 0, v1],
    ] as const) {
      pos.push(p.x, p.y, p.z)
      uv.push(u, v)
      nor.push(n.x, n.y, n.z)
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new Float32BufferAttribute(nor, 3))
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  geo.computeBoundingSphere()
  const mesh = new Mesh(geo, mat)
  mesh.name = 'signs'
  // signs hang on the facades: they must take the porch and building shadows like the walls
  mesh.receiveShadow = true
  return mesh
}

function newBuilders(room: (id: string) => Builders, lean: boolean): Builders {
  return {
    wall: new GeoBuilder(2.4),
    stone: new GeoBuilder(2),
    wood: new GeoBuilder(2),
    cloth: new GeoBuilder(1.5),
    windows: new GeoBuilder(1),
    roofs: [],
    signs: [],
    extra: [],
    kit: [],
    room,
    lean,
  }
}

/** Detail tiles, metres. */
const TILE = 36
/** How close the camera must come to a detail tile, or to a building, to draw its detail. */
const NEAR_DETAIL = { lean: 27, full: 46 }
const NEAR_ROOM = { lean: 10, full: 18 }

const tileKey = (x: number, z: number): string => `${Math.floor(x / TILE)},${Math.floor(z / TILE)}`

interface Placement {
  def: PropDef
  at: Matrix4
}

/** Tiles the far batch can fold away: x and z tile indices −2..5 (the town and its outskirts). */
const FAR_SPAN = 8
const farIndex = (ix: number, iz: number): number =>
  Math.min(FAR_SPAN - 1, Math.max(0, ix + 2)) +
  Math.min(FAR_SPAN - 1, Math.max(0, iz + 2)) * FAR_SPAN
/** 1 where a tile's full detail shows (its stand-ins fold away), shared by every far material. */
const FAR_HIDE = { value: new Array<number>(FAR_SPAN * FAR_SPAN).fill(0) }

function tagTile(g: BufferGeometry, id: number): BufferGeometry {
  const n = g.getAttribute('position').count
  g.setAttribute('tile', new BufferAttribute(new Float32Array(n).fill(id), 1))
  return g
}

/** Keep only the named attributes (and fill a missing colour with white), so batches merge. */
const stripTo =
  (names: readonly string[]) =>
  (g: BufferGeometry): BufferGeometry => {
    const src = g.index ? g.toNonIndexed() : g
    const out = new BufferGeometry()
    const n = src.getAttribute('position').count
    for (const name of names) {
      const a = src.getAttribute(name)
      if (a) {
        out.setAttribute(name, a)
      } else if (name === 'color') {
        out.setAttribute('color', new BufferAttribute(new Float32Array(n * 3).fill(1), 3))
      } else if (name === 'uv') {
        out.setAttribute('uv', new BufferAttribute(new Float32Array(n * 2), 2))
      } else if (name === 'normal') {
        src.computeVertexNormals()
        out.setAttribute('normal', src.getAttribute('normal'))
      }
    }
    return out
  }

const farMats = new Map<Material, Material>()

/** A material's far twin: the same look, with tiles showing full detail folded out of view. */
function farMaterial(base: Material): Material {
  const hit = farMats.get(base)
  if (hit) {
    return hit
  }
  const m = base.clone()
  const prev = base.onBeforeCompile
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer)
    shader.uniforms.farHide = FAR_HIDE
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float tile;
uniform float farHide[${FAR_SPAN * FAR_SPAN}];`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
if (farHide[int(tile + 0.5)] > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);`,
      )
  }
  const key = base.customProgramCacheKey()
  m.customProgramCacheKey = () => `${key}-far`
  farMats.set(base, m)
  return m
}

/** One detail tile: full kit up close; clustered and flat stand-ins from further off. */
interface Tile {
  near: Placement[]
  far: Placement[]
  /** Flat window stand-ins (the windows material). */
  flat: GeoBuilder
}

/**
 * Far stand-ins by kit piece: a vertex-cluster cell as a fraction of the piece's size, or a flat
 * painted window. Anything not here has no far version: small props have their always-drawn
 * inset stand-ins (dressing.ts), and door frames, lanterns and wagon loads aren't missed at 40 m.
 */
const FAR: Record<string, number | 'flat'> = {
  rock: 0.3,
  fence: 0.1,
  k_door_plank: 0.12,
  k_window_thin: 'flat',
  k_window_wide: 'flat',
}

/**
 * Drop the CPU copy of every town-owned vertex and index array once it is on the GPU (iOS
 * WebViews are killed under memory pressure). Bounding spheres are computed first, which is all
 * culling needs. Instanced meshes (shared prop geometry, used elsewhere too) are left alone, as
 * is everything when the dev audits, which read vertices, are watching.
 */
function freeAfterUpload(root: Object3D): void {
  const free = function (this: { array: unknown }) {
    this.array = null
  }
  root.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh || (m as InstancedMesh).isInstancedMesh) {
      return
    }
    const g = m.geometry
    g.computeBoundingSphere()
    g.computeBoundingBox()
    for (const a of Object.values(g.attributes)) {
      ;(a as BufferAttribute).onUpload(free)
    }
    g.index?.onUpload(free)
  })
}

const FRAME = 0x5a_3e_28
const GLASS = 0x1a_22_2a
const box3 = new Box3()

/**
 * A window as two quads on the wall face (frame, then glass inset), sized from the kit window's
 * own bounds under its placement: 4 triangles for 112–160, at a distance nobody counts muntins.
 */
function flatWindow(g: GeoBuilder, def: PropDef, at: Matrix4): void {
  box3.makeEmpty()
  for (const p of def.parts) {
    if (!p.geometry.boundingBox) {
      p.geometry.computeBoundingBox()
    }
    const b = p.geometry.boundingBox
    if (b) {
      box3.union(b.clone().applyMatrix4(at))
    }
  }
  if (box3.isEmpty()) {
    return
  }
  // the window's outward axis is its placement's +z
  const e = at.elements
  const nx = e[8] ?? 0
  const nz = e[10] ?? 0
  const alongX = Math.abs(nz) >= Math.abs(nx)
  const sgn = alongX ? Math.sign(nz) || 1 : Math.sign(nx) || 1
  // just inside the front of the bounds (the kit sash stands proud of the wall; its back sinks in)
  const face = alongX
    ? (sgn > 0 ? box3.max.z : box3.min.z) - sgn * 0.03
    : (sgn > 0 ? box3.max.x : box3.min.x) - sgn * 0.03
  const a0 = alongX ? box3.min.x : box3.min.z
  const a1 = alongX ? box3.max.x : box3.max.z
  const y0 = box3.min.y + 0.12
  const y1 = box3.max.y
  const quad = (u0: number, u1: number, v0: number, v1: number, off: number, color: number) => {
    const P = (u: number, v: number) =>
      alongX ? new Vector3(u, v, face + sgn * off) : new Vector3(face + sgn * off, v, u)
    // wound to face outward
    if (sgn > 0 === alongX) {
      g.quad(P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1), color)
    } else {
      g.quad(P(u1, v0), P(u0, v0), P(u0, v1), P(u1, v1), color)
    }
  }
  const iu = (a1 - a0) * 0.14
  const iv = (y1 - y0) * 0.1
  quad(a0, a1, y0, y1, 0, FRAME)
  quad(a0 + iu, a1 - iu, y0 + iv, y1 - iv, 0.01, GLASS)
}

/** Which side of town a point past the edge is on (the outskirts' four batches). */
function sectorOf(layout: TownLayout, x: number, z: number): string {
  const a = Math.atan2(z - layout.size / 2, x - layout.size / 2)
  return ['w', 'n', 'e', 's'][Math.floor(((a + Math.PI + Math.PI / 4) / (Math.PI / 2)) % 4)] ?? 'n'
}

/** Split a geometry's triangles into buckets by where their centroid falls. */
function splitTriangles(
  geo: BufferGeometry,
  keyOf: (x: number, z: number) => string,
): Map<string, BufferGeometry> {
  const g = geo.index ? geo.toNonIndexed() : geo
  const pos = g.getAttribute('position')
  const names = Object.keys(g.attributes)
  const buckets = new Map<string, number[]>()
  for (let t = 0; t < pos.count / 3; t++) {
    const x = (pos.getX(t * 3) + pos.getX(t * 3 + 1) + pos.getX(t * 3 + 2)) / 3
    const z = (pos.getZ(t * 3) + pos.getZ(t * 3 + 1) + pos.getZ(t * 3 + 2)) / 3
    const k = keyOf(x, z)
    const list = buckets.get(k) ?? []
    list.push(t)
    buckets.set(k, list)
  }
  const out = new Map<string, BufferGeometry>()
  for (const [k, tris] of buckets) {
    const part = new BufferGeometry()
    for (const name of names) {
      const src = g.getAttribute(name)
      const size = src.itemSize
      const arr = new Float32Array(tris.length * 3 * size)
      let o = 0
      for (const t of tris) {
        for (let v = 0; v < 3; v++) {
          for (let c = 0; c < size; c++) {
            arr[o++] = src.getComponent(t * 3 + v, c)
          }
        }
      }
      part.setAttribute(name, new BufferAttribute(arr, size))
    }
    part.computeBoundingSphere()
    out.set(k, part)
  }
  return out
}

/** Distance on the ground from (x, z) to a rect (0 inside). */
const toRect = (r: Rect, x: number, z: number): number =>
  Math.hypot(Math.max(r.x - x, 0, x - r.x - r.w), Math.max(r.z - z, 0, z - r.z - r.d))

export function buildTown(
  layout: TownLayout,
  assets: Assets,
  sun: Vector3,
  tier: Quality = 'high',
): Town {
  const root = new Group()
  root.name = 'town'
  const mats = makeMaterials(assets)
  const lean = tier === 'floor' || tier === 'legacy'
  const rooms = new Map<string, Builders>()
  const room = (id: string): Builders => {
    let r = rooms.get(id)
    if (!r) {
      r = newBuilders(room, lean)
      rooms.set(id, r)
    }
    return r
  }
  const bs = newBuilders(room, lean)
  const roofs: Building[] = []
  for (const b of layout.buildings) {
    addBuilding(bs, b, layout, roofs.length)
    roofs.push(b)
  }
  addRoofWalks(bs)
  addBank(bs, layout)
  addCreek(bs, layout)
  addWallAds(bs, layout)
  addCrossings(bs, layout)
  const lanterns: Matrix4[] = []
  addDecor(bs, layout, lanterns)
  const tiles = new Map<string, Tile>()
  /** A kit piece into its tile: full detail up close, its far stand-in (if any) beyond. */
  const toTile = (def: PropDef, at: Matrix4) => {
    const k = tileKey(at.elements[12] ?? 0, at.elements[14] ?? 0)
    let t = tiles.get(k)
    if (!t) {
      t = { near: [], far: [], flat: new GeoBuilder(1) }
      tiles.set(k, t)
    }
    t.near.push({ def, at })
    const rule = FAR[def.name]
    if (rule === 'flat') {
      flatWindow(t.flat, def, at)
    } else if (rule !== undefined) {
      t.far.push({ def: farDef(def, rule * Math.max(def.size.x, def.size.y, def.size.z)), at })
    }
  }
  const lantern = propDef(assets.props, 'lantern', 0.4, 'y')
  for (const at of lantern ? lanterns : []) {
    toTile(lantern as PropDef, at)
  }
  const deckRects = decks(layout)
  for (const [i, r] of deckRects.slice(0, SHADE_RECTS).entries()) {
    SHADE.rects.value[i]?.set(r.x, r.z, r.w, r.d)
  }
  dressCover({
    layout,
    props: assets.props,
    structure: bs,
    interior: room,
    floorAt: (x, z) => floorHeight(layout, deckRects, x, z),
    porchRoof: PORCH_ROOF - 0.06,
    kit: (layer, def, at) => {
      if (layer === 'structure') {
        bs.kit.push({ def, at })
      } else if (layer === 'near') {
        toTile(def, at)
      } else {
        room(layer.slice(3)).kit.push({ def, at })
      }
    },
    outskirts: toTile,
  })
  // the facades' kit (windows, frames, doors) and the cover's (fences, wagon loads) go by tile
  // too: full kit near the camera, clustered or flat stand-ins beyond
  for (const { def, at } of bs.kit.splice(0)) {
    toTile(def, at)
  }
  const mask = bakeGroundMask(layout, sun)
  const ground = groundMesh(layout, { map: assets.tex.ground, normal: assets.tex.groundN }, mask)
  root.add(ground)
  // the land past the playable edge (cut bank, bench, hills, mesas, scrub), one batch per side of
  // town so the side behind the camera isn't drawn
  const landGeo = outskirtsGeometry(layout, OUTSKIRTS_SEED, sun)
  for (const [k, part] of splitTriangles(landGeo, (x, z) => sectorOf(layout, x, z))) {
    const land = new Mesh(part, ground.material)
    land.name = 'outskirts'
    land.userData.sector = k
    land.receiveShadow = true
    root.add(land)
  }
  landGeo.dispose()
  const swap = new Map([
    ['Kit', mats.kit],
    ['KitGlass', mats.windows],
  ])
  /** Every batch of one builder set, under `parent`. */
  const emit = (set: Builders, parent: Group) => {
    const add = (geo: BufferGeometry | null, mat: MeshStandardMaterial, name: string) => {
      if (!geo || geo.getAttribute('position').count === 0) {
        return
      }
      const m = new Mesh(geo, mat)
      m.name = name
      m.receiveShadow = true
      m.matrixAutoUpdate = false
      parent.add(m)
    }
    add(set.wall.empty ? null : set.wall.build(), mats.wall, 'walls')
    add(set.stone.empty ? null : set.stone.build(), mats.stone, 'stone')
    if (!set.wood.empty || set.extra.length > 0) {
      const wood = set.wood.build()
      add(set.extra.length > 0 ? mergeGeometries([wood, ...set.extra]) : wood, mats.wood, 'wood')
    }
    add(set.windows.empty ? null : set.windows.build(), mats.windows, 'windows')
    add(set.cloth.empty ? null : set.cloth.build(), mats.cloth, 'canvas')
    if (set.kit.length > 0) {
      for (const m of mergePlaced(set.kit, parent, swap, false)) {
        m.name = 'kit'
      }
    }
  }
  emit(bs, root)
  for (const r of bs.roofs) {
    if (!r.getAttribute('rk')) {
      // the clock tower's roofs: plain boards
      const n = r.getAttribute('position').count
      r.setAttribute('rk', new BufferAttribute(new Float32Array(n).fill(RK_PLAIN), 1))
    }
  }
  if (bs.roofs.length > 0) {
    const m = new Mesh(mergeGeometries(bs.roofs), mats.roof)
    m.name = 'roofs'
    m.receiveShadow = true
    root.add(m)
  }
  const signs = signMesh(bs.signs, mats.signs)
  if (signs) {
    signs.matrixAutoUpdate = false
    root.add(signs)
  }
  root.add(waterMesh(layout))
  // the culled layers: detail tiles (near and far versions), and rooms
  const culled: { group: Group; rect: Rect; within: number }[] = []
  const farGeos = new Map<Material, BufferGeometry[]>()
  const farRects: { rect: Rect; id: number }[] = []
  const farMeshes: Mesh[] = []
  const nearM = lean ? NEAR_DETAIL.lean : NEAR_DETAIL.full
  for (const [k, t] of tiles) {
    const [ix = 0, iz = 0] = k.split(',').map(Number)
    const rect = { x: ix * TILE, z: iz * TILE, w: TILE, d: TILE }
    const near = new Group()
    near.name = `detail ${k}`
    for (const m of mergePlaced(t.near, near, swap, false)) {
      m.name = 'kit'
    }
    root.add(near)
    culled.push({ group: near, rect, within: nearM })
    // far stand-ins all go into one batch per material (tagged with their tile), drawn always;
    // the vertex shader folds away the tiles whose full detail is showing
    const id = farIndex(ix, iz)
    for (const { def, at } of t.far) {
      for (const p of def.parts) {
        const mat = swap.get(p.material.name) ?? p.material
        const list = farGeos.get(mat) ?? []
        list.push(tagTile(p.geometry.clone().applyMatrix4(at), id))
        farGeos.set(mat, list)
      }
    }
    if (!t.flat.empty) {
      const list = farGeos.get(mats.windows) ?? []
      list.push(tagTile(t.flat.build(), id))
      farGeos.set(mats.windows, list)
    }
    farRects.push({ rect, id })
  }
  for (const [mat, geos] of farGeos) {
    const geo = mergeGeometries(geos.map(stripTo(['position', 'normal', 'uv', 'color', 'tile'])))
    if (geo) {
      const m = new Mesh(geo, farMaterial(mat))
      farMeshes.push(m)
      m.name = 'far'
      m.receiveShadow = true
      root.add(m)
    }
  }
  const roomM = lean ? NEAR_ROOM.lean : NEAR_ROOM.full
  for (const [id, set] of rooms) {
    const b = layout.buildings.find((o) => o.id === id)
    if (!b) {
      continue
    }
    const g = new Group()
    g.name = `room ${id}`
    emit(set, g)
    root.add(g)
    culled.push({ group: g, rect: b, within: roomM })
  }
  root.updateMatrixWorld(true)
  // Static: never recompose these matrices again.
  root.traverse((o) => {
    o.matrixAutoUpdate = false
    o.matrixWorldAutoUpdate = false
  })
  const audit0 = Reflect.has(globalThis, 'owAuditScenes')
  if (!audit0) {
    freeAfterUpload(root)
  }
  // the culler and the disposer are built outside this scope: a closure made here would keep
  // every builder's vertex arrays alive with it
  const update = culler({ culled, farRects, farMeshes, nearM })
  ground.onBeforeRender = onCamera(update)
  return { root, roofs, sun, update, dispose: disposer(root, Object.values(mats), mask) }
}

interface CullState {
  culled: { group: Group; rect: Rect; within: number }[]
  farRects: { rect: Rect; id: number }[]
  farMeshes: Mesh[]
  nearM: number
}

/**
 * Per-frame detail selection for `camera`: detail tiles and rooms by distance, and the far
 * batch's fold mask. A few dozen rect distances, no allocation.
 */
function culler(s: CullState): (camera: Camera) => void {
  return (camera) => {
    const cam = camera.position
    // the dev audits (float, collider) need every piece in the scene they capture
    const audit = Reflect.has(globalThis, 'owAuditScenes')
    for (const c of s.culled) {
      c.group.visible = audit || toRect(c.rect, cam.x, cam.z) <= c.within
    }
    for (const m of s.farMeshes) {
      m.visible = !audit
    }
    for (const { rect, id } of s.farRects) {
      // the audits see the full kit only
      FAR_HIDE.value[id] = audit || toRect(rect, cam.x, cam.z) <= s.nearM ? 1 : 0
    }
  }
}

/** The ground's onBeforeRender: the main (perspective) camera drives the culler, not the sun's. */
function onCamera(update: (camera: Camera) => void): Mesh['onBeforeRender'] {
  return (_r, _s, camera) => {
    if ((camera as PerspectiveCamera).isPerspectiveCamera) {
      update(camera)
    }
  }
}

function disposer(root: Group, mats: { dispose: () => void }[], mask: Texture): () => void {
  return () => {
    root.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose()
      }
    })
    for (const m of mats) {
      m.dispose()
    }
    mask.dispose()
  }
}

function waterMesh(layout: TownLayout): Mesh {
  const c = layout.creek
  const g = new GeoBuilder(4)
  const V = (x: number, z: number) => new Vector3(x, 0.04, z)
  // A dry creek: a thin trickle wandering down the bed, narrowing to nothing in places, so it
  // reads as water over sand from above (not a painted stripe).
  const mid = c.z + c.d / 2 + 0.6
  const step = 1.5
  for (let x = c.x - 30; x < c.x + c.w + 30; x += step) {
    const at = (t: number) => mid + Math.sin(t * 0.21) * 0.9 + Math.sin(t * 0.057) * 1.4
    const half = (t: number) =>
      Math.max(0, 0.05 + 0.2 * Math.sin(t * 0.13) * Math.sin(t * 0.31 + 1))
    const [z0, z1, h0, h1] = [at(x), at(x + step), half(x), half(x + step)]
    if (h0 + h1 > 0.02) {
      g.quad(V(x, z0 + h0), V(x + step, z1 + h1), V(x + step, z1 - h1), V(x, z0 - h0), 0x4a_44_3a)
    }
  }
  const mat = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.12,
    metalness: 0.05,
    envMapIntensity: 1.2,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  })
  const m = new Mesh(g.build(), mat)
  m.name = 'creek'
  m.receiveShadow = true
  return m
}
