/** Runtime-native rig, texture and socket contracts used by rendered asset regressions. */
import type { MeshInstance, StandardMaterial } from 'playcanvas'
import type { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'

const DRAWN_POSE = /Pointing|Shoot|Draw|Spin|Flinch|Hold_/u
export function assertNativeCharacter(actor: DuelActor): void {
  const state = actor.model.anim?.baseLayer?.activeState ?? ''
  if (DRAWN_POSE.test(state) && !actor.muzzle()) {
    throw new Error(`Missing live authored muzzle during${state}`)
  }
  assertBoneTargets(actor)
  for (const render of actor.root.findComponents('render')) {
    for (const instance of render.meshInstances) {
      assertSkinBinding(instance, actor)
    }
  }
}
function assertBoneTargets(actor: DuelActor): void {
  for (const name of ['Head', 'Abdomen', 'WristL', 'WristR', 'FootL', 'FootR']) {
    const matches = actor.root.find((node) => node.name === name)
    if (matches.length !== 1) {
      throw new Error(`Native binder has${matches.length} matches for${name}`)
    }
    const scale = matches[0]?.getLocalScale()
    if (!scale || Math.min(scale.x, scale.y, scale.z) < 0.01) {
      throw new Error(`Collapsed native bone${name}`)
    }
  }
}
function assertSkinBinding(instance: MeshInstance, actor: DuelActor): void {
  const skin = instance.skinInstance
  if (!skin?.skin) {
    return
  }
  const material = instance.material as StandardMaterial
  if (!material.diffuseMap) {
    throw new Error('Native body is missing its authored PBR albedo')
  }
  for (const [index, name] of skin.skin.boneNames.entries()) {
    if (skin.bones[index] !== actor.model.findByName(name)) {
      throw new Error(`Unbound live equipment joint${name}`)
    }
  }
}
