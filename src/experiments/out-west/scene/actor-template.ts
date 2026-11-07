/** Immutable dressed graph and fitted landmarks; forks own their animation and shader state. */
import {
  type AnimationClip,
  AnimationMixer,
  type Bone,
  Group,
  type Material,
  Mesh,
  type Object3D,
  type SkinnedMesh,
  type Vector3,
} from 'three'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { Actor } from './actor.ts'
import type { ActorOpts } from './actor-options.ts'
import type { Body } from './fit.ts'
import type { HatFit } from './hats.ts'
import type { GunAnatomy } from './holster.ts'
import { characterMaterial, type Glow } from './shade.ts'
import type { Floor } from './style.ts'

export interface ActorTemplate {
  readonly prepared: true
  readonly root: Group
  readonly model: Object3D
  readonly bones: ReadonlyMap<string, Bone>
  readonly meshes: readonly SkinnedMesh[]
  readonly props: Readonly<
    Record<
      'hat' | 'gun' | 'offGun' | 'holster' | 'handSlot' | 'offSlot' | 'offHolster',
      Object3D | null
    >
  >
  readonly clips: readonly AnimationClip[]
  readonly label: string
  readonly height: number
  readonly realBeard: boolean
  readonly neutralFrames: NonNullable<Body['neutralFrames']>
  readonly pocket: Vector3 | null
  readonly anatomy: GunAnatomy | null
  readonly hatFit: HatFit | null
  readonly stance: ActorOpts['stance']
  readonly paceLength: number
  readonly heelStrikes: readonly number[]
  readonly walkDuration: number
}

/** Three preserves traversal order when cloning the hierarchy, including unweighted bones. */
export function cloneActorGraph(root: Group) {
  const copy = cloneSkinned(root) as Group
  const originals: Object3D[] = []
  const copies: Object3D[] = []
  root.traverse((node) => originals.push(node))
  copy.traverse((node) => copies.push(node))
  const map = new Map(originals.map((node, index) => [node, copies[index] as Object3D]))
  return { root: copy, node: <T extends Object3D>(node: T): T => map.get(node) as T }
}

export function snapshotActor(
  actor: Actor,
  fitted: Pick<ActorTemplate, 'clips' | 'realBeard' | 'neutralFrames' | 'pocket' | 'stance'>,
  bones: ReadonlyMap<string, Bone>,
): ActorTemplate {
  const graph = cloneActorGraph(actor.root)
  const prop = (node: Object3D | null) => (node ? graph.node(node) : null)
  return {
    ...fitted,
    prepared: true,
    root: graph.root,
    model: graph.node(actor.model),
    bones: new Map([...bones].map(([name, bone]) => [name, graph.node(bone)])),
    meshes: actor.meshes.map((mesh) => graph.node(mesh)),
    props: {
      hat: prop(actor.hat),
      gun: prop(actor.gun),
      offGun: prop(actor.offGun),
      holster: prop(actor.holster),
      handSlot: prop(actor.handSlot),
      offSlot: prop(actor.offSlot),
      offHolster: prop(actor.offHolster),
    },
    label: actor.label,
    height: actor.height,
    anatomy: actor.anatomy,
    hatFit: actor.hatFit ? { ...actor.hatFit } : null,
    pocket: fitted.pocket?.clone() ?? null,
    stance: fitted.stance ? { ...fitted.stance } : undefined,
    paceLength: actor.paceLength,
    heelStrikes: [...actor.heelStrikes],
    walkDuration: actor.walkDuration,
  }
}

export function forkTemplate(template: ActorTemplate, floor: Floor, glow: Glow) {
  const graph = cloneActorGraph(template.root)
  forkMaterials(template, graph, floor, glow)
  const bones = new Map([...template.bones].map(([name, bone]) => [name, graph.node(bone)]))
  const find = (key: string) => bones.get(key) ?? null
  const prop = (key: keyof ActorTemplate['props']) => {
    const source = template.props[key]
    return source ? (graph.node(source) as Group) : null
  }
  return {
    root: graph.root,
    model: graph.node(template.model),
    bones,
    meshes: template.meshes.map((mesh) => graph.node(mesh)),
    head: find('Head'),
    handR: find('WristR') ?? find('FistR'),
    handL: find('WristL') ?? find('FistL'),
    hips: find('Hips'),
    spine: find('Torso') ?? find('Abdomen'),
    armR: find('UpperArmR'),
    forearmR: find('LowerArmR'),
    hat: prop('hat'),
    gun: prop('gun'),
    offGun: prop('offGun'),
    holster: prop('holster'),
    handSlot: prop('handSlot'),
    offSlot: prop('offSlot'),
    offHolster: prop('offHolster'),
    pocket: template.pocket?.clone() ?? null,
    anatomy: template.anatomy,
    hatFit: template.hatFit ? { ...template.hatFit } : null,
  }
}

const materialSources = new WeakMap<Material, Material>()
/** Batches use a stable immutable finish, while individual actor materials remain mutable. */
export const actorMaterialSource = (material: Material): Material =>
  materialSources.get(material) ?? material

function rigidMaterial(material: Material): Material {
  const own = material.clone()
  own.onBeforeCompile = material.onBeforeCompile
  own.customProgramCacheKey = material.customProgramCacheKey
  materialSources.set(own, actorMaterialSource(material))
  return own
}

/** Late-added map weapons need the same private fade state as the template's fitted props. */
export function ownPropMaterials(root: Object3D): void {
  const materials = new Map<Material, Material>()
  const swap = (source: Material): Material => {
    let own = materials.get(source)
    if (!own) {
      own = rigidMaterial(source)
      materials.set(source, own)
    }
    return own
  }
  root.traverse((node) => {
    if (node instanceof Mesh) {
      node.material = Array.isArray(node.material) ? node.material.map(swap) : swap(node.material)
      node.userData.actorMaterial = true
    }
  })
}

export function forkMaterials(
  template: ActorTemplate,
  graph: ReturnType<typeof cloneActorGraph>,
  floor: Floor,
  glow: Glow,
): void {
  const materials = new Map<Material, Material>()
  const hats = new Set<Object3D>()
  template.props.hat?.traverse((node) => hats.add(node))
  template.root.traverse((source) => {
    if (!(source instanceof Mesh)) {
      return
    }
    const mesh = graph.node(source)
    const character = template.meshes.includes(source as SkinnedMesh) || hats.has(source)
    const swap = (material: Material): Material => {
      const have = materials.get(material)
      if (have) {
        return have
      }
      const own = character
        ? characterMaterial(floor, material.name, glow).copy(material)
        : rigidMaterial(material)
      materialSources.set(own, actorMaterialSource(material))
      materials.set(material, own)
      return own
    }
    mesh.material = Array.isArray(source.material)
      ? source.material.map(swap)
      : swap(source.material)
    mesh.userData.actorMaterial = true
    // The source hat is actor-owned; a living fork must survive its template's departure.
    if (hats.has(source)) {
      mesh.geometry = source.geometry.clone()
    }
  })
}

export function forkPlayback(template: ActorTemplate, model: Object3D) {
  const mixer = new AnimationMixer(model)
  const actions = new Map(
    template.clips.map((clip) => [clip.name.split('|').pop() ?? clip.name, mixer.clipAction(clip)]),
  )
  return {
    mixer,
    actions,
    walkAction: actions.get('Walk') ?? null,
    idleAction: actions.get('Idle') ?? null,
  }
}

/** A knocked-off prop belongs to the FX lifetime; respawn receives a fresh owned hat. */
export function restoreTemplateHat(actor: Actor, template: ActorTemplate): void {
  const source = template.props.hat
  if (actor.hat || !(source instanceof Group && source.parent && actor.head)) {
    return
  }
  const graph = cloneActorGraph(source)
  forkMaterials({ ...template, root: source, meshes: [] }, graph, actor.floor, actor.glow)
  const slot = new Group().copy(source.parent, false)
  slot.add(graph.root)
  actor.head.add(slot)
  actor.hat = graph.root
}
