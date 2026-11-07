/** Controlled instance-palette changes must alter actual rendered far-body pixels. */
import type {
  InstancedBufferAttribute,
  InstancedMesh,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import type { Crowd } from '../../src/experiments/out-west/ffa/scene/crowd.ts'

interface Tinted {
  mesh: InstancedMesh
  topAttr: InstancedBufferAttribute
  sleevesAttr: InstancedBufferAttribute
}
export function recolorPixels(
  crowd: Crowd,
  gl: WebGLRenderer,
  stage: {
    scene: Scene
    camera: PerspectiveCamera
    target: WebGLRenderTarget
    take: (name: string) => void
  },
): number {
  const vats = [...(Reflect.get(crowd, 'vats') as Map<string, Tinted>).values()].filter(
    (vat) => vat.mesh.count > 0,
  )
  const attributes = vats.flatMap((vat) => [vat.topAttr, vat.sleevesAttr])
  const saved = attributes.map((attribute) => new Float32Array(attribute.array))
  const previous = gl.getRenderTarget()
  const green = new Uint8Array(360 * 480 * 4)
  const blue = new Uint8Array(green.length)
  const paint = (r: number, g: number, b: number, pixels: Uint8Array) => {
    for (const attribute of attributes) {
      for (let i = 0; i < attribute.count; i++) {
        attribute.setXYZ(i, r, g, b)
      }
      attribute.needsUpdate = true
    }
    gl.setRenderTarget(stage.target)
    gl.clear()
    gl.render(stage.scene, stage.camera)
    gl.readRenderTargetPixels(stage.target, 0, 0, 360, 480, pixels)
  }
  try {
    paint(0.03, 0.7, 0.03, green)
    stage.take('palette-green')
    paint(0.03, 0.03, 0.7, blue)
    stage.take('palette-blue')
    let changed = 0
    for (let i = 0; i < green.length; i += 4) {
      if (
        Math.abs((green[i + 1] ?? 0) - (blue[i + 1] ?? 0)) +
          Math.abs((green[i + 2] ?? 0) - (blue[i + 2] ?? 0)) >
        30
      ) {
        changed++
      }
    }
    return changed
  } finally {
    for (const [i, attribute] of attributes.entries()) {
      const original = saved[i]
      if (original) {
        attribute.array.set(original)
      }
      attribute.needsUpdate = true
    }
    gl.setRenderTarget(previous)
  }
}
