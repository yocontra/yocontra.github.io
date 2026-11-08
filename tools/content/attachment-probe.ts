/** Actual native mount transforms, batch restoration and detached resource lifetime. */
import { Entity, type GraphNode } from 'playcanvas'
import type { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'

function groups(node: Entity): number[] {
  return node.findComponents('render').map((render) => render.batchGroupId)
}
function difference(actual: ArrayLike<number>, expected: ArrayLike<number>): number {
  return Math.max(
    ...Array.from(actual).map((value, index) => Math.abs(value - (expected[index] ?? 0))),
  )
}
interface Mounted {
  node: Entity
  parent: GraphNode | null
  local: number[]
  groups: number[]
}
function assertRestored(before: Mounted): void {
  if (
    before.node.parent !== before.parent ||
    difference(before.node.getLocalTransform().data, before.local) > 1e-5 ||
    JSON.stringify(groups(before.node)) !== JSON.stringify(before.groups)
  ) {
    throw new Error('Native authored mount did not restore')
  }
}
export function assertAttachmentLifecycle(actor: DuelActor): unknown {
  actor.place(2, 0.3, -1)
  const hat = actor.root.findByName('mount.Head.accessory')
  const gun = actor.weaponMounts.find((mount) => mount.drawn && mount.hand === 'R')?.node
  if (!(hat instanceof Entity && gun instanceof Entity)) {
    throw new Error('Missing authored native hat/gun')
  }
  const originals: Mounted[] = [hat, gun].map((node) => ({
    node,
    parent: node.parent,
    local: Array.from(node.getLocalTransform().data),
    groups: groups(node),
  }))
  for (let cycle = 0; cycle < 3; cycle++) {
    const world = originals.map(({ node }) => Array.from(node.getWorldTransform().data))
    const pieces = [actor.detach('hat'), actor.detach('gun')]
    for (const [index, piece] of pieces.entries()) {
      if (
        !piece ||
        difference(piece.getWorldTransform().data, world[index] ?? []) > 1e-5 ||
        groups(piece).some((group) => group !== -1)
      ) {
        throw new Error('Detach changed authored world frame or batch membership')
      }
    }
    actor.play('Idle', 0)
    actor.fireWeapon()
    if (actor.muzzle() || actor.detach('gun') || actor.detach('hat')) {
      throw new Error('Detached prop was re-enabled or detached twice')
    }
    actor.restoreAttachments()
    actor.restoreAttachments()
    originals.forEach(assertRestored)
    actor.play('Gun_Shoot', 0)
  }
  let destroyed = 0
  const count = () => destroyed++
  for (const piece of [actor.detach('hat'), actor.detach('gun')]) {
    piece?.once('destroy', count)
  }
  actor.destroy()
  if (destroyed !== 2) {
    throw new Error(`Actor did not retire detached props:${destroyed}`)
  }
  return { cycles: 3, destroyed }
}
