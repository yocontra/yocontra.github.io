/** Reproduce fitted native character assets from preserved authoring sources. */
import { mkdir, readdir } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { type Document, NodeIO, type Primitive } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import {
  dedup,
  dequantizePrimitive,
  joinPrimitives,
  prune,
  quantize,
  unpartition,
  weld,
} from '@gltf-transform/functions'
import { cache, type Range } from './character-atlas.ts'
import { appendClips } from './character-clips.ts'
import { convertCharacterSurface } from './character-surfaces.ts'
import { completeCharacterClips } from './normalize-character-clips.ts'
import { consolidateRigidMaterials } from './rigid-materials.ts'
import { fitWaistcoats } from './waistcoat-fit.ts'
import { captureWeaponSockets, restoreWeaponSockets } from './weapon-sockets.ts'

const DYEABLE = /^(?:outfit|hat|holster|extra)\./u
const RIGID = /^(?:hat|spurs)\./u
const WEAPON_BEARER = /^(?:gun\.|outlaw-|held-|player$)/u
const source = resolve('tools/art/characters')
const output = resolve('public/experiments/out-west/3d/native-v2')
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
export async function bakeCharacter(path: string): Promise<void> {
  const doc = await io.read(path)
  const id = basename(path, '.gltf')
  fitWaistcoats(doc)
  const sockets = WEAPON_BEARER.test(id) ? captureWeaponSockets(doc) : []
  for (const node of [...doc.getRoot().listNodes()]) {
    if (node.getName() === 'socket.muzzle') {
      node.dispose()
    }
  }
  if (!id.startsWith('spurs.')) {
    for (const node of [...doc.getRoot().listNodes()]) {
      if (node.getExtras().corpseGear === 'spurs') {
        node.dispose()
      }
    }
  }
  if (
    !id.startsWith('outfit.') &&
    id !== 'player' &&
    !id.startsWith('outlaw-') &&
    !['dog', 'horse'].includes(id)
  ) {
    for (const animation of [...doc.getRoot().listAnimations()]) {
      animation.dispose()
    }
  }
  const dyeable = DYEABLE.test(id) && id !== 'extra.tin-star'
  for (const mesh of doc.getRoot().listMeshes()) {
    const node = doc
      .getRoot()
      .listNodes()
      .find((candidate) => candidate.getMesh() === mesh)
    const ranges = (node?.getExtras().pieceRanges ?? []) as Range[]
    for (const primitive of [...mesh.listPrimitives()]) {
      await convertCharacterSurface(doc, mesh, primitive, { ranges, dyeable })
    }
  }
  cleanAuthoring(doc, id)
  if (id.startsWith('held-')) {
    const kind = id.slice(5)
    appendClips(
      doc,
      await io.read(resolve(source, `held-actions-${kind}.glb`)),
      new Set([`Weapon_Shoot_${kind}`, `Weapon_Idle_${kind}`]),
    )
  }
  if (id.startsWith('outlaw-')) {
    appendClips(doc, await io.read(resolve(source, 'stances', `${id}.glb`)))
  }
  await consolidateRigidMaterials(doc)
  completeCharacterClips(doc)
  await appendGunMechanisms(doc, id)
  await doc.transform(dedup())
  joinMaterials(doc)
  await doc.transform(
    dedup(),
    weld(),
    quantize({ cleanup: false }),
    prune({ keepAttributes: true, keepLeaves: true }),
    unpartition(),
  )
  dequantizeRigidEquipment(doc)
  restoreWeaponSockets(doc, sockets, id)
  let category = 'equipment'
  if (['dog', 'horse'].includes(id) || id.startsWith('held-')) {
    category = 'dynamic'
  } else if (id === 'player' || id.startsWith('outlaw-')) {
    category = 'baked'
  }
  await io.write(resolve(output, category, `${id}.glb`), doc)
  cache.clear()
  console.log(`baked native PBR ${id}`)
}
export async function appendGunMechanisms(doc: Document, id: string): Promise<void> {
  if (!(id === 'player' || id.startsWith('gun.') || id.startsWith('outlaw-'))) {
    return
  }
  const paired = id === 'gun.hardins-pair' || ['outlaw-5', 'outlaw-16'].includes(id)
  appendClips(doc, await io.read(resolve(source, `gun-actions.${paired ? 'pair' : 'single'}.glb`)))
}
/** Native dynamic batching needs normalized geometry decoded into ordinary float streams. */
export function dequantizeRigidEquipment(doc: Document): boolean {
  let changed = false
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getAttribute('JOINTS_0')) {
        continue
      }
      if (primitive.listAttributes().some((attribute) => attribute.getComponentType() !== 5126)) {
        dequantizePrimitive(primitive)
        changed = true
      }
    }
  }
  return changed
}
function cleanAuthoring(doc: Document, id: string): void {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      for (const semantic of primitive.listSemantics()) {
        if (semantic.startsWith('_')) {
          primitive.setAttribute(semantic, null)
        }
      }
    }
  }
  // Static authoring wrappers must never collide with the native animation binder's bone names.
  if (RIGID.test(id)) {
    for (const node of doc.getRoot().listNodes()) {
      if (['Head', 'FootL', 'FootR'].includes(node.getName())) {
        node.setName(`mount.${node.getName()}.accessory`)
      }
    }
  }
  if (id.startsWith('held-')) {
    stripHeldRig(doc)
  }
}
function stripHeldRig(doc: Document): void {
  const keep = new Set(
    doc
      .getRoot()
      .listNodes()
      .filter((node) => node.getName().startsWith('mount.')),
  )
  for (const mount of [...keep]) {
    for (const node of mount.listChildren()) {
      node.traverse((child) => {
        keep.add(child)
      })
    }
    let parent = mount.getParentNode()
    while (parent) {
      keep.add(parent)
      parent = parent.getParentNode()
    }
  }
  for (const node of [...doc.getRoot().listNodes()]) {
    if (!keep.has(node)) {
      node.dispose()
    }
  }
}
function joinMaterials(doc: Document): void {
  for (const mesh of doc.getRoot().listMeshes()) {
    const groups = new Map<ReturnType<Primitive['getMaterial']>, Primitive[]>()
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial()
      const group = groups.get(material) ?? []
      group.push(primitive)
      groups.set(material, group)
    }
    for (const group of groups.values()) {
      if (group.length > 1) {
        const merged = joinPrimitives(group)
        for (const primitive of group) {
          mesh.removePrimitive(primitive)
          primitive.dispose()
        }
        mesh.addPrimitive(merged)
      }
    }
  }
}
if (import.meta.main) {
  await mkdir(resolve(output, 'characters'), { recursive: true })
  for (const file of (await readdir(source)).filter(
    (candidate) =>
      candidate.endsWith('.gltf') &&
      (!process.env.OUT_WEST_CHARACTERS ||
        process.env.OUT_WEST_CHARACTERS.split(',').includes(basename(candidate, '.gltf'))) &&
      !['character-actions.gltf', 'character-strides.gltf', 'moves.gltf'].includes(candidate),
  )) {
    await bakeCharacter(resolve(source, file))
  }
}
