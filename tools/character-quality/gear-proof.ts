/** Render the actual settled corpse twice, changing only one fitted gear group's visibility. */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  type Object3D,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import type { FrontierGame } from '../../src/experiments/out-west/ffa/client/game.ts'

interface GearProof {
  item: string
  pixels: number
  draws: number
  url: string
}
function png(pixels: Uint8Array, size: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Missing image canvas')
  }
  const image = context.createImageData(size, size)
  for (let y = 0; y < size; y++) {
    image.data.set(pixels.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4)
  }
  context.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}
export function corpseGearProof(): GearProof[] {
  const game = Reflect.get(globalThis, '__qualityDeathGame') as FrontierGame
  const source = Reflect.get(game, 'scene') as Scene
  const gl = (Reflect.get(game, 'renderer') as { gl: WebGLRenderer }).gl
  const corpse = source.children.find((root) => root.name === 'dressed-corpse')
  if (!corpse) {
    throw new Error('Missing actual production corpse')
  }
  const parts = new Map<string, Object3D[]>()
  corpse.traverse((node) => {
    const kind = node.userData.corpseGear
    if (kind && effectiveVisible(node, corpse)) {
      const list = parts.get(String(kind)) ?? []
      list.push(node)
      parts.set(String(kind), list)
    }
  })
  const scene = new Scene()
  scene.background = new Color(0x4d_46_3c)
  scene.environment = source.environment
  scene.environmentIntensity = 0.7
  const key = new DirectionalLight(0xff_ee_d5, 3.2)
  scene.add(key, new AmbientLight(0xff_ff_ff, 0.8))
  const camera = new PerspectiveCamera(38, 1, 0.02, 100)
  const target = new WebGLRenderTarget(512, 512, { samples: 4 })
  target.texture.colorSpace = SRGBColorSpace
  const previous = gl.getRenderTarget()
  const tone = gl.toneMapping
  const exposure = gl.toneMappingExposure
  const parent = corpse.parent
  scene.add(corpse)
  const results: GearProof[] = []
  const render = () => {
    gl.setRenderTarget(target)
    gl.clear()
    gl.info.reset()
    gl.render(scene, camera)
    const pixels = new Uint8Array(512 * 512 * 4)
    gl.readRenderTargetPixels(target, 0, 0, 512, 512, pixels)
    return pixels
  }
  try {
    gl.toneMapping = ACESFilmicToneMapping
    gl.toneMappingExposure = 1
    for (const [item, nodes] of parts) {
      const box = new Box3()
      for (const node of nodes) {
        box.union(new Box3().setFromObject(node, true))
      }
      const center = box.getCenter(new Vector3())
      const extent = box.getSize(new Vector3()).length()
      let best: GearProof = { item, pixels: 0, draws: 0, url: '' }
      for (const direction of [
        new Vector3(1, 0.7, 1),
        new Vector3(-1, 0.7, -1),
        new Vector3(1, 0.2, -1),
      ]) {
        camera.position
          .copy(center)
          .addScaledVector(direction.normalize(), Math.max(0.5, extent * 2.3))
        camera.lookAt(center)
        key.position.copy(center).add(new Vector3(-2, 4, 3))
        const withGear = render()
        const draws = gl.info.render.calls
        for (const node of nodes) {
          node.visible = false
        }
        const without = render()
        for (const node of nodes) {
          node.visible = true
        }
        const changed = changedPixels(withGear, without)
        if (changed > best.pixels) {
          best = { item, pixels: changed, draws, url: png(withGear, 512) }
        }
      }
      results.push(best)
    }
  } finally {
    if (parent) {
      parent.add(corpse)
    }
    target.dispose()
    gl.setRenderTarget(previous)
    gl.toneMapping = tone
    gl.toneMappingExposure = exposure
  }
  if (results.some((result) => result.pixels < 2)) {
    throw new Error(
      `Corpse gear failed actual pixel test:${JSON.stringify(results.map(({ item, pixels }) => ({ item, pixels })))}`,
    )
  }
  return results
}

function changedPixels(a: Uint8Array, b: Uint8Array): number {
  let changed = 0
  for (let p = 0; p < a.length; p += 4) {
    const distance =
      Math.abs((a[p] ?? 0) - (b[p] ?? 0)) +
      Math.abs((a[p + 1] ?? 0) - (b[p + 1] ?? 0)) +
      Math.abs((a[p + 2] ?? 0) - (b[p + 2] ?? 0))
    if (distance > 20) {
      changed++
    }
  }
  return changed
}

function effectiveVisible(node: Object3D, root: Object3D): boolean {
  for (let current: Object3D | null = node; current && current !== root; current = current.parent) {
    if (!current.visible) {
      return false
    }
  }
  return true
}
