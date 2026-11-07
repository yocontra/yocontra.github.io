/** The catalog badge remains the same actual skinned metal in living and captured corpse views. */
import { type PerspectiveCamera, type Scene, Vector3 } from 'three'
import { DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'
import type { Assets } from '../../src/experiments/out-west/engine/assets.ts'
import { badgeBounds } from '../../src/experiments/out-west/scene/item-feature.ts'
import { dressedActor } from '../../src/experiments/out-west/scene/loadout.ts'
import { revolverDef } from '../../src/experiments/out-west/scene/revolver.ts'

export function captureBadge(
  assets: Assets,
  scene: Scene,
  camera: PerspectiveCamera,
  take: (group: string, name: string) => void,
): void {
  const position = camera.position.clone()
  const rotation = camera.quaternion.clone()
  const actor = dressedActor(assets.player, revolverDef(0.32), {
    ...DEFAULT_LOADOUT,
    extra: 'extra.tin-star',
  })
  actor.holsterGun()
  actor.update(0.4)
  actor.root.rotation.y = 0.3
  scene.add(actor.root)
  const center = badgeBounds(actor).getCenter(new Vector3())
  camera.position.copy(center).add(new Vector3(0, 0.01, 0.5))
  camera.lookAt(center)
  take('badge', 'living-actual-metal')
  actor.root.removeFromParent()
  actor.dispose()
  camera.position.copy(position)
  camera.quaternion.copy(rotation)
  camera.updateMatrixWorld(true)
}
