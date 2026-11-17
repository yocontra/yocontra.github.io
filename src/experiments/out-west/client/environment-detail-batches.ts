/** Native static batch groups bound LOD rebuilds to the authored root's 32 metre world cell. */
import {
  type BatchGroup,
  type BatchManager,
  type Entity,
  type RenderComponent,
  SEMANTIC_POSITION,
  TYPE_FLOAT32,
} from 'playcanvas'

import { propOwner } from '../content/environment-props.ts'

function canBatch(component: RenderComponent, detailed: boolean): boolean {
  if (detailed && !component.enabled) {
    return false
  }
  return component.meshInstances.every(
    (instance) =>
      !(instance.skinInstance || instance.morphInstance) &&
      instance.mesh?.vertexBuffer.format.elements.find(
        (element) => element.name === SEMANTIC_POSITION,
      )?.dataType === TYPE_FLOAT32,
  )
}

export function assignEnvironmentBatch(
  component: RenderComponent,
  {
    ordinary,
    owner,
    regions,
    batcher,
  }: {
    ordinary: BatchGroup | undefined
    owner: Entity | undefined
    regions: Map<string, BatchGroup>
    batcher: BatchManager | undefined
  },
): void {
  if (propOwner(component.entity) || !(batcher && canBatch(component, owner !== undefined))) {
    return
  }
  let target = ordinary
  if (owner) {
    const position = owner.getPosition()
    const key = [position.x, position.z].map((value) => Math.floor(value / 32)).join(':')
    target = regions.get(key)
    if (!target) {
      target = batcher.addGroup(`environment-detail:${key}`, false, 32)
      regions.set(key, target)
    }
  }
  if (target) {
    component.batchGroupId = target.id
  }
}
