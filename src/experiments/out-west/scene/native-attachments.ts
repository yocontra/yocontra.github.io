/** Native mounted props retain their authored pose and asset ownership across a presentation drop. */
import { type Entity, Mat4, Quat } from 'playcanvas'

export interface DetachedAttachment {
  readonly entity: Entity
  restore: () => void
  destroy: () => void
}

export function detachAttachment(entity: Entity, stage: Entity): DetachedAttachment {
  const parent = entity.parent
  if (!parent) {
    throw new Error('Cannot detach an unmounted prop')
  }
  const originalEnabled = entity.enabled
  const position = entity.getLocalPosition().clone()
  const rotation = entity.getLocalRotation().clone()
  const scale = entity.getLocalScale().clone()
  const world = entity.getWorldTransform().clone()
  const renderers = entity.findComponents('render').map((component) => ({
    component,
    group: component.batchGroupId,
  }))
  const animations = entity.findComponents('anim').map((component) => ({
    component,
    enabled: component.enabled,
  }))
  for (const { component } of renderers) {
    component.batchGroupId = -1
  }
  for (const { component } of animations) {
    component.enabled = false
  }
  entity.reparent(stage)
  const local = new Mat4().mul2(stage.getWorldTransform().clone().invert(), world)
  entity.setLocalPosition(local.getTranslation())
  entity.setLocalRotation(new Quat().setFromMat4(local))
  entity.setLocalScale(local.getScale())
  let retired = false
  return {
    entity,
    restore() {
      if (retired) {
        return
      }
      retired = true
      entity.reparent(parent)
      entity.enabled = originalEnabled
      entity.setLocalPosition(position)
      entity.setLocalRotation(rotation)
      entity.setLocalScale(scale)
      for (const { component, enabled } of animations) {
        component.enabled = enabled
      }
      for (const { component, group } of renderers) {
        component.batchGroupId = group
      }
    },
    destroy() {
      if (retired) {
        return
      }
      retired = true
      entity.destroy()
    },
  }
}
