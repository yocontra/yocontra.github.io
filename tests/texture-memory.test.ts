import { describe, expect, it } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { textureMeterScript } from '../tools/character-quality/memory.ts'

function fixture() {
  const prototype: Record<string, (...args: unknown[]) => void> = {}
  for (const method of [
    'activeTexture',
    'bindTexture',
    'deleteTexture',
    'texImage2D',
    'texImage3D',
    'texStorage2D',
    'texStorage3D',
    'generateMipmap',
  ]) {
    prototype[method] = () => undefined
  }
  const context: Record<string, unknown> = { WebGL2RenderingContext: { prototype } }
  runInNewContext(textureMeterScript, context)
  const gl = Object.create(prototype)
  const canvas = new EventTarget()
  Reflect.set(gl, 'canvas', canvas)
  const call = (method: string, ...args: unknown[]) =>
    Reflect.apply(Reflect.get(gl, method), gl, args)
  const bytes = () => {
    const read = context.__owTextureBytes
    if (typeof read !== 'function') {
      throw new Error('Meter did not install')
    }
    return Number(read())
  }
  return { call, bytes, canvas }
}

describe('WebGL texture allocation accounting', () => {
  it('tracks base images, generated mip levels, active-unit binding, deletion and context loss', () => {
    const f = fixture()
    const a = {}
    const b = {}
    f.call('bindTexture', 0x0d_e1, a)
    f.call('texImage2D', 0x0d_e1, 0, 0x19_08, 4, 4, 0, 0x19_08, 0x14_01, null)
    expect(f.bytes()).toBe(64)
    f.call('generateMipmap', 0x0d_e1)
    expect(f.bytes()).toBe(84)
    f.call('activeTexture', 0x84_c1)
    f.call('bindTexture', 0x0d_e1, b)
    f.call('texImage2D', 0x0d_e1, 0, 0x19_08, 0x19_08, 0x14_01, { width: 2, height: 2 })
    expect(f.bytes()).toBe(100)
    f.call('deleteTexture', b)
    expect(f.bytes()).toBe(84)
    f.canvas.dispatchEvent(new Event('webglcontextlost'))
    expect(f.bytes()).toBe(0)
  })

  it('includes immutable cube faces and distinguishes3D depth from array layers in mip chains', () => {
    const f = fixture()
    f.call('bindTexture', 0x85_13, {})
    f.call('texStorage2D', 0x85_13, 2, 0x88_1a, 2, 2)
    expect(f.bytes()).toBe(240)
    f.call('generateMipmap', 0x85_13)
    expect(f.bytes()).toBe(240)
    f.call('bindTexture', 0x80_6f, {})
    f.call('texStorage3D', 0x80_6f, 2, 0x80_58, 2, 2, 2)
    expect(f.bytes()).toBe(276)
    f.call('bindTexture', 0x8c_1a, {})
    f.call('texStorage3D', 0x8c_1a, 2, 0x80_58, 2, 2, 3)
    expect(f.bytes()).toBe(336)
    f.call('bindTexture', 0x0d_e1, {})
    f.call('texStorage2D', 0x0d_e1, 3, 0x82_2d, 4, 4)
    expect(f.bytes()).toBe(378)
  })
})
