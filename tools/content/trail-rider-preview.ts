/** Assemble the two edited Blender characters on their native gameplay skeletons. */
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  type Accessor,
  type Document,
  type Material,
  type mat4,
  type Node,
  NodeIO,
  type Primitive,
  type Skin,
} from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import {
  copyToDocument,
  joinPrimitives,
  prune,
  transformPrimitive,
  unpartition,
} from '@gltf-transform/functions'
import { Mat4 } from 'playcanvas'
import sharp from 'sharp'
import { cameraSleeves } from './blender-rider-sleeves.ts'
import { fabricDyes, isRiderCloth } from './studio-fabric.ts'

const equipment = resolve(process.argv[2] ?? '/tmp/out-west-trail-rider/equipment')
const riderOnly = process.argv.includes('--rider-only')
const base = resolve('public/experiments/out-west/3d/native-v2')
if (equipment === join(base, 'equipment')) {
  throw new Error('Use a separate review directory.')
}
const output = dirname(equipment)
const textures =
  output === join(base, 'fitted') ? join(base, 'characters') : join(output, 'characters')
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const art = 'tools/art/characters'
const face =
  /^(?:Drover head and neck|Fitted hazel eye |Orbital margin|Swept hair at temples and nape|Combed eyebrow hair)/u
const shirt = /^(?:Sewn shirt buttons|Rolled shirt cuff )/u
const belt = new Set(['Forged buckle and tongue', 'Rolled leather belt keepers'])
const oldFace = new Set([
  'Character',
  'Field-worn skin',
  'Tobacco brown hair',
  'Tobacco brown eyebrows',
])
type Kind = 'rider' | 'bret' | 'belt' | 'hat' | 'arms'

function selected(name: string, kind: Kind) {
  if (kind === 'arms') {
    return name === 'Rider ranch jacket'
  }
  if (kind === 'belt') {
    return belt.has(name) || name === 'holster.plain-leather Dyeable'
  }
  if (kind === 'hat') {
    return name === 'Rider crushed felt hat'
  }
  if (face.test(name) || shirt.test(name) || name === 'Trouser pocket and seam welts') {
    return true
  }
  return kind === 'rider'
    ? name.startsWith('Rider riding boot ') ||
        name.startsWith('Rider tailoring ') ||
        [
          'Rider striped workshirt',
          'Rider work trousers',
          'Tied silk kerchief',
          'Rider wool waistcoat',
          'Rider ranch jacket',
          'Rider scanned face',
          'Rider fitted nape',
        ].includes(name)
    : belt.has(name) || ['Bret workwear', 'outlaw-0 Character'].includes(name)
}

function replacing(part: Primitive, kind: Kind) {
  const name = part.getMaterial()?.getName() ?? ''
  if (kind === 'arms') {
    return name === 'Dyeable'
  }
  if (kind === 'belt') {
    return part.getAttribute('POSITION')?.getCount() === 224
  }
  if (kind === 'hat') {
    return ['Dyeable', 'Band leather', 'Band buckle', 'Band thread', 'Brim binding'].includes(name)
  }
  if (kind === 'rider') {
    return oldFace.has(name) || ['Dyeable', 'Neckerchief', 'Boots'].includes(name)
  }
  return ['Field-worn skin', 'Character', 'Fabric'].includes(name)
}

function jointBind(skin: Skin, joint: string): Mat4 {
  const index = skin.listJoints().findIndex((node) => node.getName() === joint)
  const matrices = skin.getInverseBindMatrices()
  if (!matrices || index < 0) {
    throw new Error(`Missing ${joint} bind`)
  }
  const result = new Mat4()
  result.data.set(matrices.getElement(index, []))
  return result
}

function remap(indices: Accessor, source: Skin, target: Skin) {
  const names = target.listJoints().map((joint) => joint.getName())
  const order = source.listJoints().map((joint) => names.indexOf(joint.getName()))
  if (order.includes(-1)) {
    throw new Error('Incompatible Blender skeleton')
  }
  const result = indices.clone()
  for (let i = 0; i < indices.getCount(); i++) {
    result.setElement(
      i,
      indices.getElement(i, []).map((index) => order[index] ?? 0),
    )
  }
  return result
}

function outfitMount(doc: Document, kind: Kind, skin: Skin | undefined) {
  const root = doc.getRoot()
  const nodes = root.listNodes().filter((node) => {
    if (kind !== 'hat' && (!skin || node.getSkin() !== skin)) {
      return false
    }
    const primitives = node.getMesh()?.listPrimitives()
    return primitives?.length === 1 && primitives[0] && replacing(primitives[0], kind)
  })
  const parent =
    kind === 'hat'
      ? root.listNodes().find((node) => node.getName() === 'mount.Head.accessory')
      : nodes[0]?.getParentNode()
  const expected = { hat: 5, belt: 1, bret: 3, rider: 7, arms: 1 }
  if (!parent || nodes.length !== expected[kind]) {
    throw new Error(`Unexpected native ${kind} surfaces (${nodes.length})`)
  }
  for (const node of nodes) {
    node.setMesh(null).setSkin(null)
  }
  return parent
}

async function prep(doc: Document, kind: Kind, donor: Document, nodes: Node[]) {
  const primitiveList = nodes.flatMap((node) => node.getMesh()?.listPrimitives() ?? [])
  const copied = copyToDocument(doc, donor, primitiveList)
  const materials = new Set(primitiveList.map((p) => p.getMaterial()))
  for (const original of materials) {
    if (!original) {
      throw new Error('Missing Blender material')
    }
    const m = copied.get(original) as Material
    const name = original.getName()
    if (
      ((kind === 'rider' || kind === 'arms') && isRiderCloth(name)) ||
      (kind === 'hat' && name === 'Travel-worn felt') ||
      (kind === 'belt' && name === 'oiled hide')
    ) {
      await fabricDyes(m, textures)
    }
    if (name === 'Printed madder cotton') {
      m.setName('Neckerchief')
    }
    if (name === 'holster.plain-leather Dyeable' || name === 'outlaw-0 Character') {
      const native = doc
        .getRoot()
        .listMaterials()
        .find(
          (candidate) =>
            candidate !== copied.get(original) &&
            candidate.getName() === (kind === 'belt' ? 'Dyeable' : 'Character'),
        )
      if (!native) {
        throw new Error(`Missing original surface for ${name}`)
      }
      m.setExtras(native.getExtras()).setName(native.getName()).setBaseColorTexture(null)
    }
    if (!(m.getBaseColorTexture() || m.getExtras().nativePbr)) {
      const swatch = await sharp({
        create: { width: 4, height: 4, channels: 3, background: '#ffffff' },
      })
        .png()
        .toBuffer()
      m.setBaseColorTexture(doc.createTexture(name).setImage(swatch).setMimeType('image/png'))
    }
  }
  return copied
}

interface MountSpace {
  doc: Document
  target: Skin | undefined
  matrix: mat4
}

function fitSurface(part: Primitive, node: Node, { doc, target, matrix }: MountSpace) {
  const source = node.getSkin()
  if (!source) {
    throw new Error(`Missing Blender skin on ${node.getName()}`)
  }
  for (const semantic of ['POSITION', 'NORMAL', 'TANGENT']) {
    const attr = part.getAttribute(semantic)
    if (attr) {
      part.setAttribute(semantic, attr.clone())
    }
  }
  transformPrimitive(part, matrix)
  const indices = part.getAttribute('JOINTS_0')
  if (target && indices) {
    part.setAttribute('JOINTS_0', remap(indices, source, target))
  }
  if (!target) {
    part.setAttribute('JOINTS_0', null).setAttribute('WEIGHTS_0', null)
  }
  if (
    node.getName() !== 'holster.plain-leather Dyeable' &&
    node.getName() !== 'outlaw-0 Character'
  ) {
    part.setAttribute('COLOR_0', null)
  }
  const pos = part.getAttribute('POSITION')
  if (pos && !part.getAttribute('TEXCOORD_0')) {
    part.setAttribute(
      'TEXCOORD_0',
      doc
        .createAccessor('', doc.getRoot().listBuffers()[0])
        .setType('VEC2')
        .setArray(new Float32Array(pos.getCount() * 2)),
    )
  }
}

// The first opponent's hat can be detached during a duel. Keep its original rigid mount.
function fitGreenhornHat(doc: Document, donor: Document) {
  for (const [native, authored] of [
    ['Felt crown', 'outlaw-0 Fabric'],
    ['Fitted hatband', 'outlaw-0 Hatband'],
  ] as const) {
    const mount = doc
      .getRoot()
      .listNodes()
      .find((n) => n.getName() === native)
    const source = donor
      .getRoot()
      .listNodes()
      .find((n) => n.getName() === authored)
    const original = source?.getMesh()?.listPrimitives()[0]
    if (!(mount && source && original)) {
      throw new Error(`Missing Greenhorn hat part ${native}`)
    }
    const part = copyToDocument(doc, donor, [original]).get(original) as Primitive
    const local = new Mat4()
    local.data.set(mount.getWorldMatrix())
    fitSurface(part, source, {
      doc,
      target: undefined,
      matrix: Array.from(local.invert().data) as mat4,
    })
    mount.setMesh(doc.createMesh(native).addPrimitive(part))
  }
}

async function fitAsset(kind: Kind, id: string, donor: Document, canonical: Skin) {
  const category = {
    bret: 'baked',
    arms: 'viewmodels',
    hat: 'equipment',
    belt: 'equipment',
    rider: 'equipment',
  }[kind]
  const doc = await io.read(join(base, category, `${id}.glb`))
  const root = doc.getRoot()
  const target = root.listSkins()[0]
  const parent = outfitMount(doc, kind, target)
  const fromMeters = jointBind(canonical, 'Head')
  if (target) {
    fromMeters.mul2(jointBind(target, 'Head').invert(), jointBind(canonical, 'Head'))
  }
  const matrix = Array.from(fromMeters.data) as mat4
  const parts = donor
    .getRoot()
    .listNodes()
    .filter((node) => node.getMesh() && selected(node.getName(), kind))
  const copied = await prep(doc, kind, donor, parts)
  const batches = new Map<string, Primitive[]>()
  for (const node of parts) {
    for (const original of node.getMesh()?.listPrimitives() ?? []) {
      const part = copied.get(original) as Primitive
      const m = part.getMaterial()
      if (!m) {
        throw new Error('Missing fitted material')
      }
      fitSurface(part, node, { doc, target, matrix })
      const layout = part
        .listSemantics()
        .sort((a, b) => a.localeCompare(b))
        .map((semantic) => [semantic, part.getAttribute(semantic)?.getComponentType()])
      const key = JSON.stringify([
        root.listMaterials().indexOf(m),
        layout,
        part.getMode(),
        Boolean(part.getIndices()),
      ])
      const batch = batches.get(key) ?? []
      batch.push(part)
      batches.set(key, batch)
    }
  }
  for (const batch of batches.values()) {
    const mat = batch[0]?.getMaterial()
    if (!mat) {
      throw new Error('Missing Blender material')
    }
    const part = batch.length > 1 ? joinPrimitives(batch) : batch[0]
    if (!part) {
      throw new Error('Empty Blender surface')
    }
    const n = doc
      .createNode(`Studio ${mat.getName()}`)
      .setMesh(doc.createMesh(mat.getName()).addPrimitive(part))
    if (target) {
      n.setSkin(target)
    }
    parent.addChild(n)
  }
  if (kind === 'bret') {
    fitGreenhornHat(doc, donor)
  }
  root.getAsset().copyright = donor.getRoot().getAsset().copyright ?? ''
  await doc.transform(
    unpartition(),
    prune({ keepAttributes: true, keepLeaves: true, keepSolidTextures: true }),
  )
  const folder = category === 'equipment' ? equipment : join(output, category)
  await mkdir(folder, { recursive: true })
  await io.write(join(folder, `${id}.glb`), doc)
}

async function loadMaster(id: string, master: string) {
  const doc = await io.read(join(art, id, `${id}.glb`))
  const rest = (await io.read(join(art, `${master}.gltf`))).getRoot().listSkins()[0]
  if (!rest) {
    throw new Error(`Missing ${master} skeleton`)
  }
  const garmentMaps = new Set(
    doc
      .getRoot()
      .listMaterials()
      .filter((m) => isRiderCloth(m.getName()) || m.getName() === 'Printed madder cotton')
      .flatMap((m) => [
        m.getBaseColorTexture(),
        m.getNormalTexture(),
        m.getMetallicRoughnessTexture(),
      ]),
  )
  for (const t of doc.getRoot().listTextures()) {
    const image = t.getImage()
    if (garmentMaps.has(t) || !image || image.byteLength < 80_000) {
      continue
    }
    t.setImage(
      await sharp(image)
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
        .removeAlpha()
        .jpeg({ quality: 89, chromaSubsampling: '4:4:4' })
        .toBuffer(),
    ).setMimeType('image/jpeg')
  }
  return { doc, rest }
}
const rider = await loadMaster('trail-rider', 'player')
const sleeves = cameraSleeves(rider.doc)
for (const id of ['outfit.trail-duds', 'outfit.trail-duds.pair']) {
  await fitAsset('arms', id, sleeves, rider.rest)
  await fitAsset('rider', id, rider.doc, rider.rest)
}
for (const id of ['holster.plain-leather', 'holster.plain-leather.pair']) {
  await fitAsset('belt', id, rider.doc, rider.rest)
}
await fitAsset('hat', 'hat.battered-brim', rider.doc, rider.rest)
if (!riderOnly) {
  const bret = await loadMaster('greenhorn', 'outlaw-0')
  await fitAsset('bret', 'outlaw-0', bret.doc, bret.rest)
}
