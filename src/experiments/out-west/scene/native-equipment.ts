import { type ContainerResource, type Entity, StandardMaterial } from 'playcanvas'
import type { GameApplication } from '../client/application.ts'
import { EQUIPMENT } from '../content/equipment.ts'
import { DEFAULT_LOADOUT, type ItemId, type Loadout, normalizeLoadout } from '../data/catalog.ts'
import { type Dyes, dyeHex } from '../data/dye.ts'
import { DuelActor } from '../duel/native-actor.ts'

/** Standard native material instances keep one rider's dyes out of shared asset resources. */
function applyDye(model: Entity, dye: number | null): void {
  if (dye === null) {
    return
  }
  const materials = new Map<StandardMaterial, StandardMaterial>()
  for (const component of model.findComponents('render')) {
    for (const instance of component.meshInstances) {
      const original = instance.material
      if (!(original instanceof StandardMaterial) || original.name !== 'Dyeable') {
        continue
      }
      let material = materials.get(original)
      if (!material) {
        material = original.clone()
        material.diffuse.set(((dye >> 16) & 255) / 255, ((dye >> 8) & 255) / 255, (dye & 255) / 255)
        material.update()
        materials.set(original, material)
      }
      instance.material = material
    }
  }
  model.once('destroy', () => {
    for (const material of materials.values()) {
      material.destroy()
    }
  })
}

function bindSkin(model: Entity, actor: DuelActor, id: string): void {
  for (const component of model.findComponents('render')) {
    for (const instance of component.meshInstances) {
      if (!instance.skinInstance) {
        continue
      }
      for (const bone of instance.skinInstance.skin.boneNames) {
        if (!actor.model.findByName(bone)) {
          throw new Error(`Equipment ${id} references missing bone ${bone}`)
        }
      }
      instance.skinInstance.resolve(actor.model, actor.model)
    }
  }
}
function mountRigid(model: Entity, actor: DuelActor): void {
  const mounts = model.find(
    (node) =>
      node.name.startsWith('mount.') ||
      node.name === 'Head' ||
      node.name === 'FootL' ||
      node.name === 'FootR',
  )
  for (const mount of mounts) {
    const parts = mount.name.split('.')
    const name = mount.name.startsWith('mount.') ? parts[1] : mount.name
    const bone = name ? actor.model.findByName(name) : null
    if (!bone) {
      throw new Error(`Missing equipment mount: ${name}`)
    }
    mount.reparent(bone)
    if (mount.name.startsWith('mount.')) {
      actor.weaponMounts.push({ node: mount, drawn: parts[2] === 'drawn' })
    }
  }
}

/** Outfit rigs and accessories are authored once; equipment never constructs a mesh at runtime. */
export async function equippedActor(
  game: GameApplication,
  raw: Loadout,
  dyes: Dyes = {},
): Promise<DuelActor> {
  const loadout = normalizeLoadout(raw)
  const outfit =
    EQUIPMENT[loadout.outfit as keyof typeof EQUIPMENT] ??
    EQUIPMENT[DEFAULT_LOADOUT.outfit as keyof typeof EQUIPMENT]
  const actor = await DuelActor.create(game, outfit.url, 'gunslinger')
  try {
    applyDye(actor.model, dyeHex(dyes[loadout.outfit]))
    const ids = [loadout.hat, loadout.gun, loadout.spurs, loadout.holster, loadout.extra].filter(
      (id): id is ItemId => Boolean(id),
    )
    actor.root.enabled = false
    const loads = await Promise.allSettled(
      ids.map(async (id) => {
        const source = EQUIPMENT[id as keyof typeof EQUIPMENT]
        if (!source) {
          throw new Error(`Missing equipped asset: ${id}`)
        }
        const asset = await game.loadContainer(source.url)
        const resource = asset.resource as ContainerResource
        const model = resource.instantiateRenderEntity({ castShadows: true, receiveShadows: true })
        applyDye(model, dyeHex(dyes[id]))
        actor.root.addChild(model)
        if (id.startsWith('holster.') || id.startsWith('extra.')) {
          bindSkin(model, actor, id)
        } else {
          mountRigid(model, actor)
        }
      }),
    )
    const rejected = loads.find((load) => load.status === 'rejected')
    if (rejected?.status === 'rejected') {
      throw rejected.reason
    }
    actor.root.enabled = true
    actor.play('Idle')
    return actor
  } catch (error) {
    actor.destroy()
    throw error
  }
}
