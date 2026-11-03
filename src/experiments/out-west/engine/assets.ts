import type { Texture } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { BodyKey } from '../data/outlaws'
import { loadTex } from '../scene/textures'

const ROOT = '/experiments/out-west/3d'

export interface Assets {
  player: GLTF
  bodies: Record<BodyKey, GLTF>
  props: GLTF
  tex: {
    ground: Texture
    groundN: Texture
    planks: Texture
    planksN: Texture
    vplanks: Texture
    vplanksN: Texture
  }
}

export async function loadAssets(
  anisotropy: number,
  onProgress: (fraction: number) => void,
): Promise<Assets> {
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  let done = 0
  const total = 12
  const tick = <T>(p: Promise<T>): Promise<T> =>
    p.then((v) => {
      done++
      onProgress(done / total)
      return v
    })
  const glb = (name: string) => tick(loader.loadAsync(`${ROOT}/models/${name}.glb`))
  const tex = (name: string, srgb: boolean) =>
    tick(loadTex(`${ROOT}/tex/${name}.webp`, srgb, anisotropy))

  const [
    player,
    suit,
    rugged,
    woman,
    casual,
    props,
    ground,
    groundN,
    planks,
    planksN,
    vplanks,
    vplanksN,
  ] = await Promise.all([
    glb('player'),
    glb('suit'),
    glb('rugged'),
    glb('woman'),
    glb('casual'),
    glb('props'),
    tex('ground_diff', true),
    tex('ground_nor', false),
    tex('planks_diff', true),
    tex('planks_nor', false),
    tex('vplanks_diff', true),
    tex('vplanks_nor', false),
  ])
  return {
    player,
    bodies: { suit, rugged, woman, casual },
    props,
    tex: { ground, groundN, planks, planksN, vplanks, vplanksN },
  }
}
