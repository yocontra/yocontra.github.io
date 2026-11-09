import { expect, test as it } from 'bun:test'
import { Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { prune } from '@gltf-transform/functions'
import { CATALOG } from '../../src/experiments/out-west/data/catalog.ts'
import { completeCharacterClips } from '../../tools/content/normalize-character-clips.ts'
import { captureWeaponSockets } from '../../tools/content/weapon-sockets.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const MOUNT = /^mount\.[^.]+\.(?:accessory|drawn|holstered)$/u
const root = 'public/experiments/out-west/3d/native-v2'

it('a sparse draw blended from dense idle retains authored scale and translation', () => {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const wrist = doc.createNode('WristR').setTranslation([0.4, 1.2, 0]).setScale([1, 1, 1])
  const times = doc
    .createAccessor()
    .setType('SCALAR')
    .setArray(new Float32Array([0, 1]))
    .setBuffer(buffer)
  const rotation = doc
    .createAccessor()
    .setType('VEC4')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0.6, 0, 0.8]))
    .setBuffer(buffer)
  const clip = doc.createAnimation('Draw')
  const sampler = doc.createAnimationSampler().setInput(times).setOutput(rotation)
  clip
    .addSampler(sampler)
    .addChannel(
      doc
        .createAnimationChannel()
        .setTargetNode(wrist)
        .setTargetPath('rotation')
        .setSampler(sampler),
    )
  completeCharacterClips(doc)
  const scale = clip
    .listChannels()
    .find((channel) => channel.getTargetPath() === 'scale')
    ?.getSampler()
    ?.getOutput()
  const translation = clip
    .listChannels()
    .find((channel) => channel.getTargetPath() === 'translation')
    ?.getSampler()
    ?.getOutput()
  expect(scale?.getElement(0, [] as number[])).toEqual([1, 1, 1])
  expect(translation?.getElement(0, [])[1]).toBeCloseTo(1.2)
  expect(sampler.getOutput()).toBe(rotation)
  const count = clip.listChannels().length
  completeCharacterClips(doc)
  expect(clip.listChannels().length).toBe(count)
})

it('all rigid accessories use explicit authored mounts instead of duplicate animated bone names', async () => {
  const items = CATALOG.filter((item) => ['hat', 'gun', 'spurs'].includes(item.slot))
  for (const item of items) {
    const doc = await io.read(`${root}/equipment/${item.id}.glb`)
    expect(doc.getRoot().listSkins()).toHaveLength(0)
    const names = doc
      .getRoot()
      .listNodes()
      .map((node) => node.getName())
    expect(names.some((name) => MOUNT.test(name))).toBe(true)
    expect(
      names.some((name) => ['Head', 'FootL', 'FootR', 'WristL', 'WristR'].includes(name)),
    ).toBe(false)
  }
})

it('all twelve paired fits retain a standard rig and material detail', async () => {
  for (const item of CATALOG.filter((candidate) =>
    ['outfit', 'holster'].includes(candidate.slot),
  )) {
    const doc = await io.read(`${root}/equipment/${item.id}.pair.glb`)
    expect(doc.getRoot().listSkins()).toHaveLength(1)
    expect(
      doc
        .getRoot()
        .listMaterials()
        .some((material) => material.getName() === 'Dyeable'),
    ).toBe(true)
    const boneNames = doc
      .getRoot()
      .listSkins()[0]
      ?.listJoints()
      .map((node) => node.getName())
    expect(boneNames).toContain('WristR')
    expect(boneNames).toContain('FootL')
  }
})

it('all seventeen outlaws retain their individual native idle and telegraph-compatible TRS clips', async () => {
  for (let index = 0; index < 17; index++) {
    const doc = await io.read(`${root}/baked/outlaw-${index}.glb`)
    const idle = doc
      .getRoot()
      .listAnimations()
      .find((clip) => clip.getName() === 'Idle_Character')
    expect(idle).toBeDefined()
    expect(
      idle?.listSamplers().some((sampler) => (sampler.getInput()?.getMax([])[0] ?? 0) > 7.9),
    ).toBe(true)
    const nodes = new Set(idle?.listChannels().map((channel) => channel.getTargetNode()))
    for (const node of nodes) {
      expect(
        idle
          ?.listChannels()
          .filter((channel) => channel.getTargetNode() === node)
          .map((channel) => channel.getTargetPath())
          .sort(),
      ).toEqual(['rotation', 'scale', 'translation'])
    }
  }
})

it('native revolver containers retain authored prop draw and finger twirl channels', async () => {
  for (const item of CATALOG.filter((candidate) => candidate.slot === 'gun')) {
    const doc = await io.read(`${root}/equipment/${item.id}.glb`)
    const names = doc
      .getRoot()
      .listAnimations()
      .map((clip) => clip.getName())
    expect(names).toContain('Weapon_Draw_R')
    expect(names).toContain('Weapon_Spin_R')
    const spin = doc
      .getRoot()
      .listAnimations()
      .find((clip) => clip.getName() === 'Weapon_Spin_R')
    const values = spin
      ?.listChannels()
      .find((channel) => channel.getTargetPath() === 'rotation')
      ?.getSampler()
      ?.getOutput()
      ?.getArray()
    expect(new Set(values ? Array.from(values) : []).size).toBeGreaterThan(8)
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const primitive of mesh.listPrimitives()) {
        expect(primitive.getAttribute('POSITION')?.getComponentType()).toBe(5126)
        expect(primitive.getMaterial()?.getAlphaMode()).toBe('OPAQUE')
      }
    }
  }
})

it('all28 weapon-bearing final assets retain their authored barrel sockets through native pruning', async () => {
  const records = [
    ...CATALOG.filter((item) => item.slot === 'gun').map((item) => ({
      category: 'equipment',
      id: item.id,
    })),
    ...Array.from({ length: 17 }, (_, index) => ({ category: 'baked', id: `outlaw-${index}` })),
    { category: 'baked', id: 'player' },
    ...['rifle', 'shotgun'].map((kind) => ({ category: 'dynamic', id: `held-${kind}` })),
  ]
  for (const { category, id } of records) {
    const [source, doc] = await Promise.all([
      io.read(`tools/art/characters/${id}.gltf`),
      io.read(`${root}/${category}/${id}.glb`),
    ])
    const expected = captureWeaponSockets(source)
    await doc.transform(prune({ keepAttributes: true, keepLeaves: true }))
    const actual = captureWeaponSockets(doc)
    expect(actual).toHaveLength(expected.length)
    expect(actual.length).toBeGreaterThan(0)
    for (const socket of expected) {
      const found = actual.find((candidate) => candidate.mount === socket.mount)
      expect(found).toBeDefined()
      for (let axis = 0; axis < 3; axis++) {
        expect(found?.translation[axis]).toBeCloseTo(socket.translation[axis] as number, 5)
      }
    }
  }
})

it('finite crouch weapon clips preserve the authored upper world frame without mutating standing clips', async () => {
  const { Quat } = await import('playcanvas')
  const doc = await io.read(`${root}/baked/moves.glb`)
  const clips = new Map(
    doc
      .getRoot()
      .listAnimations()
      .map((clip) => [clip.getName(), clip]),
  )
  function q(name: string, bone: string): InstanceType<typeof Quat> {
    const values = clips
      .get(name)
      ?.listChannels()
      .find(
        (channel) =>
          channel.getTargetNode()?.getName() === bone && channel.getTargetPath() === 'rotation',
      )
      ?.getSampler()
      ?.getOutput()
      ?.getElement(0, [] as number[])
    expect(values).toHaveLength(4)
    return new Quat(values?.[0], values?.[1], values?.[2], values?.[3])
  }
  for (const name of [
    'Idle_Gun_Pointing',
    'Gun_Shoot',
    'Reload',
    'Hold_rifle',
    'Hold_shotgun',
    'Shoot_rifle',
    'Shoot_shotgun',
  ]) {
    const standing = new Quat().mul2(q(name, 'Hips'), q(name, 'Abdomen')).normalize()
    const crouched = new Quat()
      .mul2(q('Crouch_Idle', 'Hips'), q(`Crouch_${name}`, 'Abdomen'))
      .normalize()
    const dot = Math.abs(
      standing.x * crouched.x +
        standing.y * crouched.y +
        standing.z * crouched.z +
        standing.w * crouched.w,
    )
    expect(dot).toBeGreaterThan(0.999_99)
    const source = clips.get(name)
    const target = clips.get(`Crouch_${name}`)
    expect(target?.listChannels().length).toBe(source?.listChannels().length)
    const standingRotation = source
      ?.listChannels()
      .find(
        (channel) =>
          channel.getTargetNode()?.getName() === 'Abdomen' &&
          channel.getTargetPath() === 'rotation',
      )
      ?.getSampler()
      ?.getOutput()
    const crouchRotation = target
      ?.listChannels()
      .find(
        (channel) =>
          channel.getTargetNode()?.getName() === 'Abdomen' &&
          channel.getTargetPath() === 'rotation',
      )
      ?.getSampler()
      ?.getOutput()
    expect(crouchRotation).not.toBe(standingRotation)
  }
})

it('authored waistcoats replace the apron with full shoulder coverage and retain the canonical body and skin', async () => {
  const { fitWaistcoats } = await import('../../tools/content/waistcoat-fit.ts')
  const doc = await io.read('tools/art/characters/outfit.trail-duds.gltf')
  const node = doc
    .getRoot()
    .listNodes()
    .find((entry) =>
      entry
        .getMesh()
        ?.listPrimitives()
        .some((surface) => Boolean(surface.getExtras().waistcoatFit)),
    )
  const mesh = node?.getMesh()
  const original = mesh?.listPrimitives().find((entry) => Boolean(entry.getExtras().waistcoatFit))
  const positions = original?.getAttribute('POSITION')
  const uv = original?.getAttribute('TEXCOORD_0')
  if (!(original && positions && uv && mesh)) {
    throw new Error('Missing preserved waistcoat source')
  }
  const fit = original.getExtras().waistcoatFit as { ranges: { start: number; count: number }[] }
  const obsolete = new Set(
    fit.ranges.flatMap((range) => Array.from({ length: range.count }, (_, i) => range.start + i)),
  )
  const before = Array.from(positions.getArray() ?? [])
  const originalUV = Array.from(uv.getArray() ?? [])
  await fitWaistcoats(doc, 'outfit.trail-duds')
  expect(Array.from(positions.getArray() ?? [])).toEqual(before)
  expect(Array.from(uv.getArray() ?? [])).toEqual(originalUV)
  const indices = original.getIndices()
  if (!indices) {
    throw new Error('Missing fitted body indices')
  }
  for (let i = 0; i < indices.getCount(); i += 3) {
    expect([0, 1, 2].every((corner) => obsolete.has(indices.getScalar(i + corner)))).toBe(false)
  }
  const garment = mesh.listPrimitives().find((entry) => Boolean(entry.getExtras().pieceRanges))
  const cloth = garment?.getAttribute('POSITION')
  const joints = garment?.getAttribute('JOINTS_0')
  const weights = garment?.getAttribute('WEIGHTS_0')
  if (!(garment && cloth && joints && weights)) {
    throw new Error('Missing authored native garment')
  }
  const clothRange = (
    garment.getExtras().pieceRanges as { start: number; count: number; name?: string }[]
  ).find((range) => range.name === 'Waistcoat')
  if (!clothRange) {
    throw new Error('Missing tailored cloth range')
  }
  const heights = Array.from(
    { length: clothRange.count },
    (_, i) => cloth.getElement(clothRange.start + i, [])[1] ?? 0,
  )
  expect(Math.max(...heights)).toBeGreaterThan(1.4)
  expect(Math.min(...heights)).toBeLessThan(1)
  const jointCount = node?.getSkin()?.listJoints().length ?? 0
  for (let i = 0; i < cloth.getCount(); i++) {
    expect(weights.getElement(i, []).reduce((sum, w) => sum + w, 0)).toBeCloseTo(1, 5)
    expect(joints.getElement(i, []).every((joint) => joint >= 0 && joint < jointCount)).toBe(true)
  }
  const count = mesh.listPrimitives().length
  await fitWaistcoats(doc, 'outfit.trail-duds')
  expect(mesh.listPrimitives()).toHaveLength(count)
})

it('all baked opponent hats retain one explicit Head-local native detachable mount', async () => {
  const { readFile } = await import('node:fs/promises')
  const { labelActorHatGlb } = await import('../../tools/content/label-actor-hats.ts')
  for (const id of ['player', ...Array.from({ length: 17 }, (_, index) => `outlaw-${index}`)]) {
    const path = `${root}/baked/${id}.glb`
    const bytes = await readFile(path)
    const labeled = labelActorHatGlb(bytes)
    const previousOffset = 20 + bytes.readUInt32LE(12)
    const nextOffset = 20 + labeled.bytes.readUInt32LE(12)
    expect(labeled.bytes.subarray(nextOffset)).toEqual(bytes.subarray(previousOffset))
    const doc = await io.read(path)
    const mounts = doc
      .getRoot()
      .listNodes()
      .filter((node) => node.getName() === 'mount.Head.accessory')
    expect(mounts).toHaveLength(1)
    expect(mounts[0]?.getParentNode()?.getName()).toBe('Head')
  }
})
