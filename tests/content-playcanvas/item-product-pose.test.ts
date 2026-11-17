import { expect, test as it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { Entity, Vec3 } from 'playcanvas'
import { CATALOG } from '../../src/experiments/out-west/data/catalog.ts'
import { orientGunProduct } from '../../tools/content/item-product-pose.ts'

interface Node {
  name?: string
  children?: number[]
  translation?: [number, number, number]
  rotation?: [number, number, number, number]
  scale?: [number, number, number]
  extras?: {
    gunAnatomy?: {
      muzzle: { x: number; y: number; z: number }
      grip: { x: number; y: number; z: number }
    }
  }
}
for (const item of CATALOG.filter((entry) => entry.slot === 'gun')) {
  it(`${item.id} product pose keeps real native gun decode while putting the grip below the barrel`, async () => {
    const bytes = await readFile(
      `public/experiments/out-west/3d/native-v2/equipment/${item.id}.glb`,
    )
    const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString()) as {
      nodes: Node[]
      scenes: { nodes: number[] }[]
      scene?: number
    }
    const nodes = json.nodes.map((node) => {
      const entity = new Entity(node.name)
      if (node.translation) {
        entity.setLocalPosition(...node.translation)
      }
      if (node.rotation) {
        entity.setLocalRotation(...node.rotation)
      }
      if (node.scale) {
        entity.setLocalScale(...node.scale)
      }
      return entity
    })
    const root = new Entity('product')
    try {
      for (const [index, node] of json.nodes.entries()) {
        for (const child of node.children ?? []) {
          const parent = nodes[index]
          const entity = nodes[child]
          if (!(parent && entity)) {
            throw new Error('Invalid native node reference')
          }
          parent.addChild(entity)
        }
      }
      for (const index of json.scenes[json.scene ?? 0]?.nodes ?? []) {
        const node = nodes[index]
        if (!node) {
          throw new Error('Missing native scene node')
        }
        root.addChild(node)
      }
      const seats = nodes.filter(
        (node) => node.name.startsWith('mount.Wrist') && node.name.endsWith('.drawn'),
      )
      const decoded = seats.map((seat) => {
        const gun = seat.findByName('revolver')
        if (!gun) {
          throw new Error('Missing gun')
        }
        return {
          gun,
          position: gun.getLocalPosition().clone(),
          rotation: gun.getLocalRotation().clone(),
          scale: gun.getLocalScale().clone(),
        }
      })
      orientGunProduct(root, item.id === 'gun.hardins-pair')
      expect(decoded).toHaveLength(item.id === 'gun.hardins-pair' ? 2 : 1)
      for (const { gun, position, rotation, scale } of decoded) {
        expect(gun.getLocalPosition().equals(position)).toBe(true)
        expect(gun.getLocalRotation().equals(rotation)).toBe(true)
        expect(gun.getLocalScale().equals(scale)).toBe(true)
        const world = gun.getWorldTransform()
        expect(world.transformVector(Vec3.UP).normalize().dot(Vec3.UP)).toBeGreaterThan(0.999)
        expect(world.transformVector(Vec3.RIGHT).normalize().dot(Vec3.RIGHT)).toBeGreaterThan(0.999)
        const index = nodes.indexOf(gun as Entity)
        const anatomy = json.nodes[index]?.extras?.gunAnatomy
        if (!anatomy) {
          throw new Error('Missing authored anatomy')
        }
        // Independent authored gun landmarks establish up/grip-down, rather than reproducing the quaternion inverse.
        expect(anatomy.muzzle.y).toBeGreaterThan(anatomy.grip.y)
      }
    } finally {
      root.destroy()
    }
  })
}
