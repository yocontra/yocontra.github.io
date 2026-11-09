/** Native trigger overlaps detect the actual capsule touching an authored glass pane. */
import { Entity, Vec3 } from 'playcanvas'
import type { World } from '../ffa/sim/state.ts'
import { breakGlass } from '../ffa/sim/windows.ts'
import type { Simulation } from './world.ts'

export function bindWindowContacts(options: {
  world: World
  physics: Simulation
  eligible: ReadonlySet<string>
}): () => void {
  const { world, physics, eligible } = options
  const panes = world.grid.glass.map((pane) => {
    const along = (pane.a0 + pane.a1) / 2
    const entity = new Entity(`glass-contact:${pane.index}`, physics.app)
    entity.setPosition(
      pane.axis === 0 ? pane.at : along,
      (pane.y0 + pane.y1) / 2,
      pane.axis === 0 ? along : pane.at,
    )
    const width = (pane.a1 - pane.a0) / 2
    entity.addComponent('collision', {
      type: 'box',
      halfExtents: new Vec3(
        pane.axis === 0 ? 0.01 : width,
        (pane.y1 - pane.y0) / 2,
        pane.axis === 0 ? width : 0.01,
      ),
    })
    entity.collision?.on('triggerenter', (other: Entity) => {
      if (eligible.has(other.name)) {
        breakGlass(world, pane.index)
      }
    })
    physics.app.root.addChild(entity)
    return entity
  })
  return () => {
    for (const pane of panes) {
      pane.destroy()
    }
  }
}
