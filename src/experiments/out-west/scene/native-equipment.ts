import {
  type ContainerResource,
  Entity,
  type GraphNode,
  type RenderComponent,
  StandardMaterial,
} from 'playcanvas'
import type { GameApplication } from '../client/application.ts'
import { EQUIPMENT } from '../content/equipment.ts'
import { DEFAULT_LOADOUT, type ItemId, type Loadout, normalizeLoadout } from '../data/catalog.ts'
import type { DyeId, Dyes } from '../data/dye.ts'
import { DuelActor } from '../duel/native-actor.ts'
import {
  destroyDyedMaterial,
  dyedNativeMaterial,
  prepareNativeMaterials,
} from './native-materials.ts'
import { authoredMounts, type WeaponMount } from './native-mounts.ts'
import { animateRevolvers, animateWeaponMount } from './native-weapon-animation.ts'

interface EquipmentSource {
  url: string
  pair?: { url: string }
}
const batchGroups = new WeakMap<GameApplication, number>()
function rigidBatch(game: GameApplication, components: RenderComponent[]): void {
  const batcher = game.app.batcher
  if (!batcher) {
    return
  }
  let id = batchGroups.get(game)
  if (id === undefined) {
    const group = batcher.addGroup('Rider equipment', true, 24)
    id = group.id
    batchGroups.set(game, id)
    game.stage.once('destroy', () => {
      batcher.removeGroup(group.id)
      batchGroups.delete(game)
    })
  }
  for (const component of components) {
    component.batchGroupId = id
  }
}

/** Dye materials are immutable clones; disposal is installed before any asynchronous image work. */
async function applyDye(
  game: GameApplication,
  model: Entity,
  dye: DyeId | undefined,
): Promise<void> {
  if (!dye || dye === 'natural') {
    return
  }
  const materials = new Map<StandardMaterial, StandardMaterial>()
  let closed = false
  model.once('destroy', () => {
    closed = true
    for (const material of materials.values()) {
      destroyDyedMaterial(material)
    }
    materials.clear()
  })
  for (const component of model.findComponents('render')) {
    for (const instance of component.meshInstances) {
      const original = instance.material
      if (!(original instanceof StandardMaterial) || original.name !== 'Dyeable') {
        continue
      }
      let material = materials.get(original)
      if (!material) {
        const dyed = await dyedNativeMaterial(game, original, dye)
        if (closed) {
          if (dyed) {
            destroyDyedMaterial(dyed)
          }
          throw new DOMException('Equipment was removed', 'AbortError')
        }
        if (!dyed) {
          continue
        }
        material = dyed
        materials.set(original, material)
      }
      instance.material = material
    }
  }
}

function jointRoot(bone: GraphNode, joints: ReadonlySet<GraphNode>): GraphNode {
  let top = bone
  while (top.parent && joints.has(top.parent)) {
    top = top.parent
  }
  return top
}
function bindSkin(model: Entity, actor: DuelActor, id: string): void {
  const components = model.findComponents('render')
  const renderNodes = new Set<GraphNode>(components.map((component) => component.entity))
  const skins = new Set(
    components.flatMap((component) =>
      component.meshInstances.flatMap((instance) =>
        instance.skinInstance ? [instance.skinInstance] : [],
      ),
    ),
  )
  const oldRoots = new Set<GraphNode>()
  // Shared skins reference one original joint graph. Collect it before components rebind.
  for (const skin of skins) {
    for (const name of skin.skin.boneNames) {
      if (!actor.model.findByName(name)) {
        throw new Error(`Equipment ${id} references missing bone ${name}`)
      }
    }
    const joints = new Set(skin.bones)
    for (const bone of skin.bones) {
      oldRoots.add(jointRoot(bone, joints))
    }
  }
  // The native component setter balances the old cache lease before rebinding to the rider.
  for (const component of components) {
    if (component.meshInstances.some((instance) => instance.skinInstance)) {
      component.rootBone = actor.model
    }
  }
  for (const root of oldRoots) {
    if (root.find((node) => renderNodes.has(node)).length > 0) {
      throw new Error(`Equipment ${id} nests rendered geometry inside its retired skeleton`)
    }
    if (root instanceof Entity) {
      root.destroy()
    } else {
      root.parent?.removeChild(root)
    }
  }
}

function mountRigid(model: Entity, actor: DuelActor, weapon?: 'rifle' | 'shotgun'): WeaponMount[] {
  const mounts = authoredMounts(model)
  if (mounts.length === 0) {
    throw new Error(`Missing authored equipment mounts on${model.name}`)
  }
  const weapons: WeaponMount[] = []
  for (const { node, point } of mounts) {
    const bone = actor.model.findByName(point.bone)
    if (!bone) {
      throw new Error(`Missing authored bone${point.bone}`)
    }
    node.reparent(bone)
    if (point.mode !== 'accessory') {
      const mount: WeaponMount = { node, drawn: point.mode === 'drawn', hand: point.hand, weapon }
      actor.weaponMounts.push(mount)
      weapons.push(mount)
    }
  }
  if (model.findComponents('render').some((component) => component.meshInstances.length)) {
    throw new Error(`Unattached rigid geometry on${model.name}`)
  }
  for (const child of [...model.children]) {
    if (child instanceof Entity) {
      child.destroy()
    } else {
      model.removeChild(child)
    }
  }
  return weapons
}

async function gearModel(
  game: GameApplication,
  url: string,
  name: string,
): Promise<{ model: Entity; resource: ContainerResource }> {
  const asset = await game.loadContainer(url)
  const resource = asset.resource as ContainerResource
  const release = await prepareNativeMaterials(game, resource)
  try {
    if (!game.stage.parent) {
      throw new DOMException('Game was closed', 'AbortError')
    }
    const model = resource.instantiateRenderEntity({ castShadows: true, receiveShadows: true })
    model.name = `equipment:${name}`
    model.once('destroy', release)
    return { model, resource }
  } catch (error) {
    release()
    throw error
  }
}
function fittedUrl(source: EquipmentSource, paired: boolean): string {
  if (!paired) {
    return source.url
  }
  if (!source.pair) {
    throw new Error(`Missing authored paired fit for ${source.url}`)
  }
  return source.pair.url
}

/** All fitting is authored offline; runtime uses native skins, explicit mounts and batching. */
export async function equippedActor(
  game: GameApplication,
  raw: Loadout,
  dyes: Dyes = {},
): Promise<DuelActor> {
  const loadout = normalizeLoadout(raw)
  const paired = loadout.gun === 'gun.hardins-pair'
  const outfit: EquipmentSource =
    EQUIPMENT[loadout.outfit as keyof typeof EQUIPMENT] ??
    EQUIPMENT[DEFAULT_LOADOUT.outfit as keyof typeof EQUIPMENT]
  const actor = await DuelActor.create(game, fittedUrl(outfit, paired), 'gunslinger')
  actor.paired = paired
  actor.root.enabled = false
  try {
    await applyDye(game, actor.model, dyes[loadout.outfit])
    if (loadout.extra?.includes('bandana')) {
      for (const render of actor.model.findComponents('render')) {
        for (const instance of render.meshInstances) {
          if (instance.material?.name === 'Neckerchief') {
            instance.visible = false
          }
        }
      }
    }
    const ids = [loadout.hat, loadout.gun, loadout.spurs, loadout.holster, loadout.extra].filter(
      (id): id is ItemId => Boolean(id),
    )
    const loads = await Promise.allSettled(
      ids.map(async (id) => {
        const source: EquipmentSource | undefined = EQUIPMENT[id as keyof typeof EQUIPMENT]
        if (!source) {
          throw new Error(`Missing equipped asset: ${id}`)
        }
        const { model, resource } = await gearModel(
          game,
          fittedUrl(source, paired && id.startsWith('holster.')),
          id,
        )
        if (!actor.root.parent) {
          model.destroy()
          throw new DOMException('Rider was removed', 'AbortError')
        }
        actor.root.addChild(model)
        await applyDye(game, model, dyes[id])
        if (id.startsWith('holster.') || id.startsWith('extra.')) {
          bindSkin(model, actor, id)
        } else {
          const renders = model.findComponents('render')
          const mounts = mountRigid(model, actor)
          if (id.startsWith('gun.')) {
            animateRevolvers(mounts, resource)
          }
          rigidBatch(game, renders)
        }
      }),
    )
    const rejected = loads.find((load) => load.status === 'rejected')
    if (rejected?.status === 'rejected') {
      throw rejected.reason
    }
    if (!actor.root.parent) {
      throw new DOMException('Rider was removed', 'AbortError')
    }
    actor.model.anim?.rebind()
    actor.play('Idle')
    actor.root.enabled = true
    return actor
  } catch (error) {
    actor.destroy()
    throw error
  }
}

export async function attachHeldWeapon(
  game: GameApplication,
  actor: DuelActor,
  weapon: 'rifle' | 'shotgun',
  url: string,
): Promise<Entity> {
  const { model, resource } = await gearModel(game, url, `held-${weapon}`)
  try {
    if (!actor.root.parent) {
      throw new DOMException('Rider was removed', 'AbortError')
    }
    actor.root.addChild(model)
    const renders = model.findComponents('render')
    mountRigid(model, actor, weapon)
    if (!actor.root.parent) {
      throw new DOMException('Rider was removed', 'AbortError')
    }
    for (const mount of actor.weaponMounts) {
      if (mount.weapon === weapon && mount.node instanceof Entity) {
        animateWeaponMount(mount.node, resource, weapon)
      }
    }
    rigidBatch(game, renders)
    actor.model.anim?.rebind()
    return model
  } catch (error) {
    model.destroy()
    throw error
  }
}
