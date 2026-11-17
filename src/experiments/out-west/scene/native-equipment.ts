import {
  type AnimTrack,
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
/** The local rider keeps per-instance pass masks; its arms load only the fit and drawn gun. */
export interface ActorPresentation {
  local?: boolean
  viewmodel?: { url: string; parent?: Entity; tracks: readonly AnimTrack[] }
  carryDrawn?: boolean
}
function rigidBatch(
  game: GameApplication,
  components: RenderComponent[],
  name: 'Rider equipment' | 'Rider weapons',
): void {
  const batcher = game.app.batcher
  if (!batcher) {
    return
  }
  let group = batcher.getGroupByName(name)
  if (!group) {
    const created = batcher.addGroup(name, true, 24)
    game.stage.once('destroy', () => batcher.removeGroup(created.id))
    group = created
  }
  for (const component of components) {
    component.batchGroupId = group.id
  }
}

type DyeScope = 'outfit' | 'attachment'
function supportsDye(material: unknown, scope: DyeScope): material is StandardMaterial {
  return (
    material instanceof StandardMaterial && (scope === 'attachment' || material.name === 'Dyeable')
  )
}

/** Dye materials are immutable clones; disposal is installed before any asynchronous image work. */
export async function applyDye(
  game: GameApplication,
  model: Entity,
  dye: DyeId | undefined,
  scope: DyeScope = 'outfit',
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
      if (!supportsDye(original, scope)) {
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

function mountRigid(
  model: Entity,
  actor: DuelActor,
  weapon?: 'rifle' | 'shotgun',
  drawnOnly = false,
): WeaponMount[] {
  const mounts = authoredMounts(model)
  if (mounts.length === 0) {
    throw new Error(`Missing authored equipment mounts on${model.name}`)
  }
  const weapons: WeaponMount[] = []
  for (const { node, point } of mounts) {
    if (drawnOnly && point.mode === 'holstered') {
      node.parent?.removeChild(node)
      if (node instanceof Entity) {
        node.destroy()
      }
      continue
    }
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
/** The selected outfit's own single or paired fit; first-person arms are derived per fit. */
export function fitId(raw: Loadout): string {
  const loadout = normalizeLoadout(raw)
  const outfit = loadout.outfit in EQUIPMENT ? loadout.outfit : DEFAULT_LOADOUT.outfit
  return `${outfit}${loadout.gun === 'gun.hardins-pair' ? '.pair' : ''}`
}

export async function equippedActor(
  game: GameApplication,
  raw: Loadout,
  dyes: Dyes = {},
  presentation: ActorPresentation = {},
): Promise<DuelActor> {
  const loadout = normalizeLoadout(raw)
  const paired = loadout.gun === 'gun.hardins-pair'
  const outfit: EquipmentSource =
    EQUIPMENT[loadout.outfit as keyof typeof EQUIPMENT] ??
    EQUIPMENT[DEFAULT_LOADOUT.outfit as keyof typeof EQUIPMENT]
  const viewmodel = presentation.viewmodel
  const actor = await DuelActor.create(
    game,
    viewmodel?.url ?? fittedUrl(outfit, paired),
    viewmodel ? 'viewmodel' : 'gunslinger',
    { enabled: false, ...(viewmodel ? { tracks: viewmodel.tracks, humanoid: true } : {}) },
  )
  actor.paired = paired
  actor.batchRigid = !(presentation.local || viewmodel)
  actor.pairedDrawn = Boolean(viewmodel)
  actor.hold('revolver', presentation.carryDrawn ?? false)
  actor.root.enabled = false
  try {
    if (viewmodel?.parent) {
      if (!viewmodel.parent.parent) {
        throw new DOMException('Viewmodel request was removed', 'AbortError')
      }
      actor.root.reparent(viewmodel.parent)
    }
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
    const ids = (
      viewmodel
        ? [loadout.gun]
        : [loadout.hat, loadout.gun, loadout.spurs, loadout.holster, loadout.extra]
    ).filter((id): id is ItemId => Boolean(id))
    const loads = await Promise.allSettled(
      ids.map(async (id) => {
        const source: EquipmentSource | undefined = EQUIPMENT[id as keyof typeof EQUIPMENT]
        if (!source) {
          throw new Error(`Missing equipped asset: ${id}`)
        }
        const { model, resource } = await gearModel(
          game,
          fittedUrl(
            source,
            paired &&
              (id.startsWith('holster.') || (id.startsWith('gun.') && !presentation.carryDrawn)),
          ),
          id,
        )
        if (!actor.root.parent) {
          model.destroy()
          throw new DOMException('Rider was removed', 'AbortError')
        }
        actor.root.addChild(model)
        await applyDye(game, model, dyes[id], 'attachment')
        if (id.startsWith('holster.') || id.startsWith('extra.')) {
          bindSkin(model, actor, id)
        } else {
          const renders = model.findComponents('render')
          const mounts = mountRigid(model, actor, undefined, Boolean(viewmodel))
          const gun = id.startsWith('gun.')
          if (gun) {
            animateRevolvers(mounts, resource)
          }
          if (actor.batchRigid) {
            // Swapping guns can rebuild their batch without re-uploading hats or spurs.
            rigidBatch(game, renders, gun ? 'Rider weapons' : 'Rider equipment')
          }
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
    actor.root.enabled = !viewmodel
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
    if (actor.batchRigid) {
      rigidBatch(game, renders, 'Rider weapons')
    }
    actor.model.anim?.rebind()
    return model
  } catch (error) {
    model.destroy()
    throw error
  }
}
