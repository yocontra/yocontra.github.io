/** Keep the exact intact native box; only a real break introduces the remaining authored cells. */
import { type AppBase, Entity, Vec3 } from 'playcanvas'
import { ENVIRONMENT_PROPS } from '../content/environment-props.ts'
import type { CollisionData, StaticColliderSource } from './protocol.ts'

export function propColliders(
  app: AppBase,
  collision: CollisionData,
  sources: Map<Entity, StaticColliderSource>,
) {
  const groups = [...sources].flatMap(([entity, source]) => {
    const parts = ENVIRONMENT_PROPS.map((prop, index) => ({ prop, index })).filter(
      ({ prop }) => `cover:${prop.cover}` === source.id,
    )
    const box = source.kind === 'box' ? collision.boxes[source.index] : undefined
    const first = parts[0]?.prop
    if (
      !(box && first) ||
      box.rotation ||
      box.center[0] !== Math.floor(first.x) + 0.5 ||
      box.center[1] !== 0.475 ||
      box.center[2] !== Math.floor(first.z) + 0.5 ||
      box.halfExtents.some((v, i) => v !== [0.5, 0.475, 0.5][i])
    ) {
      return []
    }
    return [{ entity, source, parts, replaced: false, cells: new Map<number, Entity>() }]
  })
  const update = (health: Uint8Array) => {
    for (const group of groups) {
      if (!group.replaced && group.parts.every(({ index }) => health[index] !== 0)) {
        continue
      }
      if (!group.replaced) {
        group.replaced = true
        group.entity.enabled = false
        for (const { prop, index } of group.parts) {
          if (health[index] === 0) {
            continue
          }
          const entity = new Entity('collision', app)
          entity.setPosition(...(prop.center as [number, number, number]))
          entity.addComponent('collision', {
            type: 'box',
            halfExtents: new Vec3(...(prop.halfExtents as [number, number, number])),
          })
          entity.addComponent('rigidbody', { type: 'static', friction: 0.8 })
          app.root.addChild(entity)
          sources.set(entity, { ...group.source, id: prop.id })
          group.cells.set(index, entity)
        }
      }
      for (const [index, entity] of group.cells) {
        if (health[index] === 0) {
          sources.delete(entity)
          entity.destroy()
          group.cells.delete(index)
        }
      }
    }
  }
  const destroy = () => {
    for (const group of groups) {
      for (const entity of group.cells.values()) {
        sources.delete(entity)
        entity.destroy()
      }
      group.cells.clear()
    }
    groups.length = 0
  }
  const reset = (health: Uint8Array) => {
    for (const group of groups) {
      for (const entity of group.cells.values()) {
        sources.delete(entity)
        entity.destroy()
      }
      group.cells.clear()
      group.replaced = false
      group.entity.enabled = true
    }
    update(health)
  }
  return { update, reset, destroy }
}
