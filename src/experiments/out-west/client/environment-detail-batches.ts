/** Native static batch groups keep LOD and window changes local to a world cell. */
import {
  type BatchGroup,
  type BatchManager,
  type Entity,
  type RenderComponent,
  SEMANTIC_POSITION,
  TYPE_FLOAT32,
  type Vec3,
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

const REGION_SIZE = 32

function environmentBatchRegion(
  batcher: BatchManager,
  regions: Map<string, BatchGroup>,
  name: string,
  position: Vec3,
): BatchGroup {
  const key = [Math.floor(position.x / REGION_SIZE), Math.floor(position.z / REGION_SIZE)].join(':')
  let group = regions.get(key)
  if (!group) {
    group = batcher.addGroup(`${name}:${key}`, false, REGION_SIZE)
    regions.set(key, group)
  }
  return group
}

export function assignEnvironmentBatch(
  component: RenderComponent,
  {
    ordinary,
    owner,
    panes,
    regions,
    batcher,
  }: {
    ordinary: BatchGroup | undefined
    owner: Entity | undefined
    panes: Map<string, BatchGroup>
    regions: Map<string, BatchGroup>
    batcher: BatchManager | undefined
  },
): void {
  const pane = component.entity.name.startsWith('glass-')
  if (pane) {
    component.castShadows = false
  }
  if (propOwner(component.entity) || !(batcher && canBatch(component, owner !== undefined))) {
    return
  }
  let target = ordinary
  if (pane) {
    const center = component.meshInstances[0]?.aabb.center
    if (center) {
      target = environmentBatchRegion(batcher, panes, 'environment-panes', center)
    }
  } else if (owner) {
    target = environmentBatchRegion(batcher, regions, 'environment-detail', owner.getPosition())
  }
  if (target) {
    component.batchGroupId = target.id
  }
}
