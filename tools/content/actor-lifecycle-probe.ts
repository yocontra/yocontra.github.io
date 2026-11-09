/** Native engine identity observations for the actual game-page lifecycle regression. */
import { AppBase, Entity, Vec3 } from 'playcanvas'

const identities = new Map<string, string>()
export function rememberRider(id: string): string {
  const actor = AppBase.getApplication()?.root.findByTag(`rider:${id}`)[0]
  if (!(actor instanceof Entity)) {
    throw new Error(`Missing native rider${id}`)
  }
  const identity = actor.getGuid()
  identities.set(id, identity)
  return identity
}
export function sameRider(id: string): boolean {
  const actor = AppBase.getApplication()?.root.findByTag(`rider:${id}`)[0]
  return Boolean(actor instanceof Entity && actor.getGuid() === identities.get(id))
}

export function riderView(id: string): unknown {
  const app = AppBase.getApplication()
  const actor = app?.root.findByTag(`rider:${id}`)[0]
  const camera = app?.root.findByName('camera')
  const head = actor?.findByName('Head')
  if (!(actor instanceof Entity && camera && head)) {
    throw new Error('Missing native FP pose')
  }
  const point = head.getPosition().clone()
  const up = actor.getWorldTransform().transformVector(new Vec3(0, 0.1, 0), new Vec3())
  point.add(up)
  const muzzle = actor.find((node) => node.name === 'socket.muzzle' && node.enabled)[0]
  return {
    eye: camera.getPosition().clone(),
    rigEye: point,
    headScale: head.getLocalScale().clone(),
    muzzle: muzzle?.getPosition().clone(),
    muzzleForward: muzzle?.getWorldTransform().transformVector(Vec3.RIGHT, new Vec3()).normalize(),
    forward: camera.forward.clone(),
    root: actor.getPosition().clone(),
    controllers: actor
      .findComponents('anim')
      .filter((component) => component.enabled && component.entity.enabled)
      .map((component) => ({
        node: component.entity.name,
        state: component.baseLayer?.activeState,
        time: component.baseLayer?.activeStateCurrentTime,
      })),
  }
}
