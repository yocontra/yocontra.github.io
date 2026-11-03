import {
  ClampToEdgeWrapping,
  type Material,
  type Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  type Texture,
} from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { BodyKey, Look } from '../data/outlaws.ts'
import { setPropsLibrary } from '../scene/props.ts'
import { NORMAL_GUARD_GLSL, setCharacterMaps } from '../scene/shade.ts'
import { loadTex } from '../scene/textures.ts'

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
  const glass = new MeshStandardMaterial({
    name: 'KitGlass',
    color: 0x1a_1c_1e,
    roughness: 0.12,
    metalness: 0.4,
  })
  for (const s of props.scenes) {
    s.traverse((o) => {
      const m = o as Mesh
      // biome-ignore lint/suspicious/noUnnecessaryConditions: three types isMesh as `true` on the cast; this is the runtime type check
      if (!m.isMesh) {
        return
      }
      const name = (m.material as Material).name
      if (name === 'Kit') {
        m.material = kit
      } else if (name === 'KitGlass') {
        m.material = glass
      }
    })
  }
}

export function lookKeys(look: Look | LegacyLook): BodyKey[] {
  return 'base' in look ? [look.base] : ['casual']
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
  const char = { map: cMap, normal: cNor, arm: cArm }
  setCharacterMaps(char)
  await kitMaterial(props, tex)
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
