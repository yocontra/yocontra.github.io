import { expect, it } from 'bun:test'
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Scene } from 'three'
import { warmSelfMaterials } from '../src/experiments/out-west/ffa/scene/crowd/self-warm.ts'

it.each([false, true])(
  'restores actual retained self material and graph state after warm failure=%s',
  (fail) => {
    const scene = new Scene()
    const root = new Group()
    root.visible = false
    scene.add(root)
    const before = new Group()
    const holder = new Group()
    const after = new Group()
    root.add(before, holder, after)
    const own = new MeshStandardMaterial({ opacity: 0.35, alphaHash: true })
    const source = new MeshStandardMaterial()
    const mesh = new Mesh(new BoxGeometry(), own)
    mesh.visible = false
    mesh.castShadow = false
    holder.add(mesh)
    holder.visible = false
    holder.position.set(3, 4, 5)
    holder.updateMatrixWorld(true)
    const original = holder.matrix.clone()
    const variants: boolean[] = []
    const warm = () => {
      expect(mesh.material).toBe(own)
      expect(mesh.visible && holder.visible && root.visible).toBe(true)
      expect(mesh.castShadow).toBe(true)
      expect(mesh.frustumCulled).toBe(false)
      expect(own.opacity).toBe(1)
      expect(source.alphaHash).toBe(false)
      variants.push(own.alphaHash)
      if (fail && variants.length === 2) {
        throw new Error('driver failure')
      }
    }
    let thrown: unknown
    try {
      warmSelfMaterials(holder, root, warm)
    } catch (error) {
      thrown = error
    }
    expect(thrown instanceof Error ? thrown.message : null).toBe(fail ? 'driver failure' : null)
    expect(variants).toEqual([false, true])
    expect(root.children).toEqual([before, holder, after])
    expect(root.visible || holder.visible || mesh.visible || mesh.castShadow).toBe(false)
    expect(mesh.frustumCulled).toBe(true)
    expect(own.opacity).toBe(0.35)
    expect(own.alphaHash).toBe(true)
    expect(holder.position.toArray()).toEqual([3, 4, 5])
    expect(holder.matrix.equals(original)).toBe(true)
    mesh.geometry.dispose()
    own.dispose()
    source.dispose()
  },
)

it('returns a parked body off the scene graph after both retained variants warm', () => {
  const root = new Group()
  const holder = new Group()
  const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial())
  holder.add(mesh)
  warmSelfMaterials(holder, root, () => expect(holder.parent).toBe(root))
  expect(holder.parent).toBeNull()
  expect(mesh.material.alphaHash).toBe(false)
  expect(mesh.material.opacity).toBe(1)
  mesh.geometry.dispose()
  mesh.material.dispose()
})
