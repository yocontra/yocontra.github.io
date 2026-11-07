/** Verify shader linkage, attribute limits and real far-body pixels in the capture context. */
import type {
  InstancedMesh,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import type { Crowd } from '../../src/experiments/out-west/ffa/scene/crowd.ts'
import { recolorPixels } from './recolor.ts'

export interface GpuEvidence {
  maxVertexAttribs: number
  programs: { slots: number; linked: boolean; names: string[] }[]
  farBodyPixels: number
  magentaBodyPixels: number
  recoloredBodyPixels: number
  bodies: { count: number; attached: boolean; visible: boolean }[]
}
export function measureFar(
  crowd: Crowd,
  gl: WebGLRenderer,
  stage: {
    scene: Scene
    camera: PerspectiveCamera
    target: WebGLRenderTarget
    take: (name: string) => void
  },
): GpuEvidence {
  const { scene, camera, target } = stage
  stage.take('with-body')
  const previous = gl.getRenderTarget()
  const before = new Uint8Array(360 * 480 * 4)
  const after = new Uint8Array(before.length)
  gl.setRenderTarget(target)
  gl.clear()
  gl.render(scene, camera)
  gl.readRenderTargetPixels(target, 0, 0, 360, 480, before)
  const vats = [...(Reflect.get(crowd, 'vats') as Map<string, { mesh: InstancedMesh }>).values()]
  const bodies = vats.map((v) => ({
    count: v.mesh.count,
    attached: Boolean(v.mesh.parent),
    visible: v.mesh.visible,
  }))
  for (const vat of vats) {
    vat.mesh.visible = false
  }
  // readRenderTargetPixels binds the resolved framebuffer; restore the MSAA draw target.
  gl.setRenderTarget(target)
  gl.clear()
  gl.render(scene, camera)
  gl.readRenderTargetPixels(target, 0, 0, 360, 480, after)
  stage.take('without-body')
  for (const vat of vats) {
    vat.mesh.visible = true
  }
  gl.setRenderTarget(previous)
  let farBodyPixels = 0
  let magentaBodyPixels = 0
  for (let i = 0; i < before.length; i += 4) {
    if (
      Math.abs((before[i] ?? 0) - (after[i] ?? 0)) +
        Math.abs((before[i + 1] ?? 0) - (after[i + 1] ?? 0)) +
        Math.abs((before[i + 2] ?? 0) - (after[i + 2] ?? 0)) >
      20
    ) {
      farBodyPixels++
      const r = before[i] ?? 0
      const g = before[i + 1] ?? 0
      const b = before[i + 2] ?? 0
      if (r > 60 && b > 60 && r > g * 2.2 && b > g * 2.2) {
        magentaBodyPixels++
      }
    }
  }
  const recoloredBodyPixels = recolorPixels(crowd, gl, stage)
  if (magentaBodyPixels > 8 || recoloredBodyPixels < 100) {
    throw new Error(
      `Far semantic palette failed:${JSON.stringify({ magentaBodyPixels, recoloredBodyPixels })}`,
    )
  }
  const { programs, maxVertexAttribs } = gpuPrograms(gl)
  if (
    programs.length === 0 ||
    programs.some((program) => !program.linked || program.slots > maxVertexAttribs)
  ) {
    throw new Error(
      `Far body GPU check failed: ${JSON.stringify({ farBodyPixels, maxVertexAttribs, programs })}`,
    )
  }
  return {
    farBodyPixels,
    magentaBodyPixels,
    recoloredBodyPixels,
    maxVertexAttribs,
    programs,
    bodies,
  }
}

export function gpuPrograms(gl: WebGLRenderer): Pick<GpuEvidence, 'programs' | 'maxVertexAttribs'> {
  const ctx = gl.getContext()
  const programs: GpuEvidence['programs'] = []
  for (const program of gl.info.programs ?? []) {
    if (
      !(program.cacheKey.includes('ow-vat26-palette') || program.cacheKey.includes('corpse-cloth1'))
    ) {
      continue
    }
    const native = Reflect.get(program, 'program') as WebGLProgram
    const count = ctx.getProgramParameter(native, ctx.ACTIVE_ATTRIBUTES) as number
    let slots = 0
    const names: string[] = []
    for (let i = 0; i < count; i++) {
      const attr = ctx.getActiveAttrib(native, i)
      if (attr) {
        const matrixSlots: Record<number, number> = {
          [ctx.FLOAT_MAT4]: 4,
          [ctx.FLOAT_MAT3]: 3,
          [ctx.FLOAT_MAT2]: 2,
        }
        slots += attr.size * (matrixSlots[attr.type] ?? 1)
        names.push(attr.name)
      }
    }
    programs.push({
      slots,
      linked: Boolean(ctx.getProgramParameter(native, ctx.LINK_STATUS)),
      names,
    })
  }
  const maxVertexAttribs = ctx.getParameter(ctx.MAX_VERTEX_ATTRIBS) as number
  return { programs, maxVertexAttribs }
}
