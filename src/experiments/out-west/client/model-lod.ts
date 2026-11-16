/** Authored static detail variants share one container; native render components own visibility. */
import { Entity, type RenderComponent, type Vec3 } from 'playcanvas'
import { MODEL_LOD_PREFIX, type StaticModelLod } from '../content/types.ts'

interface Group {
  root: Entity
  spec: StaticModelLod
  near: RenderComponent[]
  far: RenderComponent[]
  distant: boolean | undefined
}

export class NativeModelLods {
  private readonly groups: Group[] = []
  private readonly components = new Map<RenderComponent, { enabled: boolean; owner: Entity }>()
  constructor(root: Entity) {
    for (const node of root.find((candidate) => candidate.name.startsWith(MODEL_LOD_PREFIX))) {
      if (!(node instanceof Entity)) {
        continue
      }
      const [distance, hysteresis] = node.name.slice(MODEL_LOD_PREFIX.length).split(':').map(Number)
      if (
        !(
          distance &&
          hysteresis &&
          Number.isFinite(distance) &&
          Number.isFinite(hysteresis) &&
          distance > hysteresis &&
          hysteresis > 0
        )
      ) {
        throw new Error(`Invalid authored detail group ${node.name}`)
      }
      const near = node.children.find((child) => child.name.startsWith('lod-near:'))
      const far = node.children.find((child) => child.name.startsWith('lod-far:'))
      if (!(near instanceof Entity && far instanceof Entity)) {
        throw new Error(`Incomplete authored detail group ${node.name}`)
      }
      const group: Group = {
        root: node,
        spec: { distance, hysteresis },
        near: near.findComponents('render'),
        far: far.findComponents('render'),
        distant: undefined,
      }
      if (!(group.near.length > 0 && group.far.length > 0)) {
        throw new Error(`Empty authored detail group ${node.name}`)
      }
      for (const component of [...group.near, ...group.far]) {
        this.components.set(component, { enabled: component.enabled, owner: node })
      }
      this.groups.push(group)
    }
  }
  /** Use a separate native batch group: detail changes should not rebuild buildings or panes. */
  owns(component: RenderComponent): boolean {
    return this.components.has(component)
  }
  /** Near/far components share their authored root, including its world-space location. */
  owner(component: RenderComponent): Entity | undefined {
    return this.components.get(component)?.owner
  }
  update(camera: Vec3): void {
    for (const group of this.groups) {
      if (!group.root.enabled) {
        continue
      }
      const position = group.root.getPosition()
      const dx = camera.x - position.x
      const dy = camera.y - position.y
      const dz = camera.z - position.z
      const { distance, hysteresis } = group.spec
      let threshold = distance
      if (group.distant !== undefined) {
        threshold += group.distant ? -hysteresis : hysteresis
      }
      const distant = dx * dx + dy * dy + dz * dz >= threshold * threshold
      if (distant === group.distant) {
        continue
      }
      group.distant = distant
      for (const component of group.near) {
        component.enabled = !distant && this.components.get(component)?.enabled === true
      }
      for (const component of group.far) {
        component.enabled = distant && this.components.get(component)?.enabled === true
      }
    }
  }
  /** Containers/material leases remain owned by the environment; no resources are allocated here. */
  destroy(): void {
    this.groups.length = 0
    this.components.clear()
  }
}
