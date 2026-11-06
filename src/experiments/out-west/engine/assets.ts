import {
  ClampToEdgeWrapping,
  type Material,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  type Texture,
} from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { BodyKey, Look } from '../data/outlaws.ts'
import { hairDonor } from '../scene/person.ts'
import { setPropsLibrary } from '../scene/props.ts'

import { markSlot, SLOT, type Slot, slotOf } from '../scene/roles.ts'
import { NORMAL_GUARD_GLSL, setCharacterMaps } from '../scene/shade.ts'
import { glassLook, surfaceProps } from '../scene/surface.ts'
import { loadTex } from '../scene/textures.ts'

const CHARACTER_SLOTS: Readonly<Record<string, Slot>> = {
  Skin: SLOT.Skin,
  Hair: SLOT.Hair,
  Brows: SLOT.Brows,
  Beard: SLOT.Beard,
  Eye: SLOT.Eye,
  Shirt: SLOT.Shirt,
  Sleeves: SLOT.Sleeves,
  Bracer: SLOT.Bracer,
  Pauldron: SLOT.Pauldron,
  Belt: SLOT.Belt,
}

/** Map the character GLB's baked material names to slots once, at load. */
function markCharacterSlots(gltf: GLTF): void {
  for (const scene of gltf.scenes) {
    scene.traverse((o) => {
      if (!(o instanceof Mesh)) {
        return
      }
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        const slot = CHARACTER_SLOTS[m.name]
        if (slot !== undefined && slotOf(m) === undefined) {
          markSlot(m, slot)
        }
      }
    })
  }
}

const ROOT = '/experiments/out-west/3d'

export interface Assets {
  player: GLTF
  props: GLTF
  tex: {
    ground: Texture
    groundN: Texture
    planks: Texture
    planksN: Texture
    vplanks: Texture
    vplanksN: Texture
    /** The shared character atlas (scene/atlas.ts): albedo, normal, ARM. */
    char: { map: Texture; normal: Texture; arm: Texture }
  }
  /** Character part files, lazily loaded and cached. */
  body: (key: BodyKey) => Promise<GLTF>
  /** Already-loaded part (or null). */
  bodyNow: (key: BodyKey) => GLTF | null
  /** Load every file a look needs. */
  lookReady: (look: Look) => Promise<void>
  lookLoaded: (look: Look) => boolean
}

/** A pre-base look literal (game.ts's never-taken fallback); loads the casual base. */
interface LegacyLook {
  readonly head: string
  readonly body: string
  readonly legs: string
  readonly feet: string
  readonly tint: Readonly<Record<string, number>>
  readonly build: readonly number[]
}

/**
 * Bind the props' shared "Kit" material (tools/build-props.ts) to the trim atlas: repeating
 * along U like the source trim sheets, clamped along V between the stacked sheets.
 */
async function kitMaterial(
  props: GLTF,
  tex: (name: string, srgb: boolean) => Promise<Texture>,
): Promise<void> {
  const [map, normal, arm] = await Promise.all([
    tex('kit_diff', true),
    tex('kit_nor', false),
    tex('kit_arm', false),
  ])
  for (const t of [map, normal, arm]) {
    t.flipY = false
    t.wrapS = RepeatWrapping
    t.wrapT = ClampToEdgeWrapping
    t.needsUpdate = true
  }
  const kit = new MeshStandardMaterial({
    name: 'Kit',
    // the kits' paint, weathered toward the street's sun-bleached boards
    color: 0xc8_bc_ae,
    map,
    normalMap: normal,
    roughnessMap: arm,
    metalnessMap: arm,
    roughness: 1,
    metalness: 1,
    vertexColors: true,
  })
  kit.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      NORMAL_GUARD_GLSL,
    )
  }
  kit.customProgramCacheKey = () => 'ow-kit'
  markSlot(kit, SLOT.Kit)
  const glass = new MeshStandardMaterial({
    name: 'KitGlass',
    color: 0x1a_1c_1e,
    roughness: 0.12,
    metalness: 0.4,
  })
  glassLook(glass)
  markSlot(glass, SLOT.Glass)
  for (const s of props.scenes) {
    s.traverse((o) => {
      if (!(o instanceof Mesh)) {
        return
      }
      const m = o
      const name = (m.material as Material).name
      if (name === 'Kit') {
        m.material = kit
      } else if (name === 'KitGlass') {
        m.material = glass
      } else {
        dielectric(m.material as MeshStandardMaterial)
      }
    })
  }
}

/**
 * The palette props (wood, hay, pumpkins, cactus) were exported with metallic 0.4, which takes
 * 40 % off their diffuse and paints them with a grey mirror of the sky: set each to a plain
 * dielectric with a roughness for what it is.
 */
const PROP_ROUGHNESS: Record<string, number> = {
  Atlas: 0.85,
  'Atlas.016': 0.85,
  HalloweenBits: 0.8,
  Hay: 0.92,
  Green: 0.62,
}

function dielectric(mat: MeshStandardMaterial): void {
  const r = PROP_ROUGHNESS[mat.name]
  if (r === undefined || mat.metalnessMap) {
    return
  }
  mat.metalness = 0
  mat.roughness = r
}

/** The files a look needs: its base, and the base its hair cut is borrowed from. */
export function lookKeys(look: Look | LegacyLook): BodyKey[] {
  if (!('base' in look)) {
    return ['casual']
  }
  const donor = hairDonor(look.base, look.hair)
  return donor ? [look.base, donor] : [look.base]
}

export async function loadAssets(
  anisotropy: number,
  firstLook: Look | LegacyLook,
  onProgress: (fraction: number) => void,
): Promise<Assets> {
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  let done = 0
  const firstKeys = lookKeys(firstLook)
  const total = 14 + firstKeys.length
  const tick = <T>(p: Promise<T>): Promise<T> =>
    p.then((v) => {
      done++
      onProgress(done / total)
      return v
    })
  const glb = (name: string) => loader.loadAsync(`${ROOT}/models/${name}.glb`)
  const tex = (name: string, srgb: boolean) =>
    tick(loadTex(`${ROOT}/tex/${name}.webp`, srgb, anisotropy))
  // glTF UV space (origin top left), clamped: the atlas is never tiled
  const atlas = (name: string, srgb: boolean) =>
    tex(name, srgb).then((t) => {
      t.flipY = false
      t.wrapS = ClampToEdgeWrapping
      t.wrapT = ClampToEdgeWrapping
      t.anisotropy = Math.min(4, anisotropy)
      t.needsUpdate = true
      return t
    })

  const cache = new Map<BodyKey, Promise<GLTF>>()
  const loaded = new Map<BodyKey, GLTF>()
  const body = (key: BodyKey): Promise<GLTF> => {
    const have = cache.get(key)
    if (have) {
      return have
    }
    const p = glb(key).then((g) => {
      markCharacterSlots(g)
      loaded.set(key, g)
      return g
    })
    cache.set(key, p)
    return p
  }

  const first = Promise.all(firstKeys.map((k) => tick(body(k))))
  const [player, props, ground, groundN, planks, planksN, vplanks, vplanksN, cMap, cNor, cArm] =
    await Promise.all([
      tick(glb('player')),
      tick(glb('props')),
      tex('ground_diff', true),
      tex('ground_nor', false),
      tex('planks_diff', true),
      tex('planks_nor', false),
      tex('vplanks_diff', true),
      tex('vplanks_nor', false),
      atlas('char_diff', true),
      atlas('char_nor', false),
      atlas('char_arm', false),
    ])
  markCharacterSlots(player)
  const char = { map: cMap, normal: cNor, arm: cArm }
  setCharacterMaps(char)
  await kitMaterial(props, tex)
  // the flat-coloured rocks, hay and cactus take real surface detail
  surfaceProps(props.scenes, ground)
  setPropsLibrary(props)
  await first
  return {
    player,
    props,
    tex: { ground, groundN, planks, planksN, vplanks, vplanksN, char },
    body,
    bodyNow: (k) => loaded.get(k) ?? null,
    lookReady: async (look) => {
      await Promise.all(lookKeys(look).map(body))
    },
    lookLoaded: (look) => lookKeys(look).every((k) => loaded.has(k)),
  }
}
