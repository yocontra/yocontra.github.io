import type { Texture } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { BodyKey, Look } from '../data/outlaws.ts'
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
  const total = 8 + firstKeys.length
  const tick = <T>(p: Promise<T>): Promise<T> =>
    p.then((v) => {
      done++
      onProgress(done / total)
      return v
    })
  const glb = (name: string) => loader.loadAsync(`${ROOT}/models/${name}.glb`)
  const tex = (name: string, srgb: boolean) =>
    tick(loadTex(`${ROOT}/tex/${name}.webp`, srgb, anisotropy))

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
  const [player, props, ground, groundN, planks, planksN, vplanks, vplanksN] = await Promise.all([
    tick(glb('player')),
    tick(glb('props')),
    tex('ground_diff', true),
    tex('ground_nor', false),
    tex('planks_diff', true),
    tex('planks_nor', false),
    tex('vplanks_diff', true),
    tex('vplanks_nor', false),
  ])
  await first
  return {
    player,
    props,
    tex: { ground, groundN, planks, planksN, vplanks, vplanksN },
    body,
    bodyNow: (k) => loaded.get(k) ?? null,
    lookReady: async (look) => {
      await Promise.all(lookKeys(look).map(body))
    },
    lookLoaded: (look) => lookKeys(look).every((k) => loaded.has(k)),
  }
}
