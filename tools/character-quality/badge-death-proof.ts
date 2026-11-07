/** Pixel evidence from the production kill's current physical skin, not a separately posed clone. */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  SkinnedMesh,
  SRGBColorSpace,
  Vector3,
  WebGLRenderTarget,
} from 'three'
import type { FrontierGame } from '../../src/experiments/out-west/ffa/client/game.ts'
import type { Ragdolls } from '../../src/experiments/out-west/ffa/scene/ragdolls.ts'
import { deathFrame } from './death.ts'

export function actualBadgeProof() {
  const game = Reflect.get(globalThis, '__qualityDeathGame') as FrontierGame
  const source = Reflect.get(game, 'scene') as Scene
  const renderer = Reflect.get(game, 'renderer') as { gl: import('three').WebGLRenderer }
  const pool = Reflect.get(game, 'ragdolls') as Ragdolls
  const corpse = source.children.find((node) => node.name === 'dressed-corpse')
  if (!corpse) {
    throw new Error('Production kill did not create a dressed corpse')
  }
  const camera = new PerspectiveCamera(38, 1, 0.01, 1000)
  pool.present(camera, false)
  let skin: SkinnedMesh | undefined
  corpse.traverse((node) => {
    if (node instanceof SkinnedMesh && node.geometry.userData.badgeRanges?.length) {
      skin = node
    }
  })
  if (!skin) {
    throw new Error('Production corpse has no actual equipped badge')
  }
  const mesh = skin
  const geometry = mesh.geometry
  const badge = badgeTriangles(mesh)
  const scene = new Scene()
  scene.background = new Color(0x4d_46_3c)
  scene.environment = source.environment
  scene.environmentIntensity = 0.7
  const light = new DirectionalLight(0xff_ee_d5, 3.2)
  scene.add(light, new AmbientLight(0xff_ff_ff, 0.8))
  const state = deathFrame()
  const parent = corpse.parent
  scene.add(corpse)
  const box = new Box3()
  const points = new Map<number, Vector3>()
  for (const vertex of badge.vertices) {
    const point = mesh.getVertexPosition(vertex, new Vector3()).applyMatrix4(mesh.matrixWorld)
    box.expandByPoint(point)
    points.set(vertex, point)
  }
  const [a, b, c] = badge.front.map((vertex) => points.get(vertex))
  if (!(a && b && c)) {
    throw new Error('Missing actual metal front face')
  }
  const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize()
  const center = box.getCenter(new Vector3())
  camera.position
    .copy(center)
    .addScaledVector(normal, 0.32)
    .add(new Vector3(0, 0.025, 0))
  camera.lookAt(center)
  light.position
    .copy(center)
    .addScaledVector(normal, 3)
    .add(new Vector3(-1, 3, 0))
  const target = new WebGLRenderTarget(512, 512, { samples: 4 })
  target.texture.colorSpace = SRGBColorSpace
  const gl = renderer.gl
  const previous = gl.getRenderTarget()
  const tone = gl.toneMapping
  const exposure = gl.toneMappingExposure
  const masked = geometry.clone()
  masked.setIndex(badge.without)
  const render = () => {
    gl.setRenderTarget(target)
    gl.clear()
    gl.render(scene, camera)
    const pixels = new Uint8Array(512 * 512 * 4)
    gl.readRenderTargetPixels(target, 0, 0, 512, 512, pixels)
    return pixels
  }
  try {
    gl.toneMapping = ACESFilmicToneMapping
    gl.toneMappingExposure = 1
    const withBadge = render()
    mesh.geometry = masked
    const withoutBadge = render()
    let changedPixels = 0
    for (let i = 0; i < withBadge.length; i += 4) {
      const delta =
        Math.abs((withBadge[i] ?? 0) - (withoutBadge[i] ?? 0)) +
        Math.abs((withBadge[i + 1] ?? 0) - (withoutBadge[i + 1] ?? 0)) +
        Math.abs((withBadge[i + 2] ?? 0) - (withoutBadge[i + 2] ?? 0))
      changedPixels += delta > 20 ? 1 : 0
    }
    if (changedPixels < 500) {
      throw new Error(`Actual corpse badge has only${changedPixels} visible pixels`)
    }
    return {
      changedPixels,
      triangles: badge.triangles,
      state,
      withBadge: png(withBadge),
      withoutBadge: png(withoutBadge),
    }
  } finally {
    mesh.geometry = geometry
    masked.dispose()
    target.dispose()
    if (parent) {
      parent.add(corpse)
    }
    gl.setRenderTarget(previous)
    gl.toneMapping = tone
    gl.toneMappingExposure = exposure
    const actualCamera = (Reflect.get(game, 'cam') as { camera: PerspectiveCamera }).camera
    pool.present(actualCamera, !gl.shadowMap.enabled)
  }
}

function badgeTriangles(mesh: SkinnedMesh) {
  const geometry = mesh.geometry
  const ranges = geometry.userData.badgeRanges as { start: number; count: number }[]
  const contains = (vertex: number) =>
    ranges.some((range) => vertex >= range.start && vertex < range.start + range.count)
  const index = geometry.index
  if (!index) {
    throw new Error('Actual body has no drawn triangles')
  }
  const vertices = new Set<number>()
  const without: number[] = []
  let front: number[] = []
  let triangles = 0
  for (let i = 0; i < index.count; i += 3) {
    const face = [index.getX(i), index.getX(i + 1), index.getX(i + 2)]
    if (face.every(contains)) {
      triangles++
      for (const vertex of face) {
        vertices.add(vertex)
      }
      if (
        front.length === 0 &&
        face.every((vertex) => geometry.getAttribute('normal').getZ(vertex) > 0.9)
      ) {
        front = face
      }
    } else {
      without.push(...face)
    }
  }
  return { vertices, without, front, triangles }
}

function png(pixels: Uint8Array): string {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Missing proof canvas')
  }
  const image = context.createImageData(512, 512)
  for (let y = 0; y < 512; y++) {
    image.data.set(pixels.subarray((511 - y) * 2048, (512 - y) * 2048), y * 2048)
  }
  context.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}
