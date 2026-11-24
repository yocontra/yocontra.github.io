import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Accessor, Document } from '@gltf-transform/core'
import { ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import { duelOpponentUrl } from '../../src/experiments/out-west/duel/native-actor.ts'
import { validateAuthoringInputs } from '../../tools/content/authoring-inputs.ts'
import { resampleNative } from '../../tools/content/native-resample.ts'
import { completeCharacterClips } from '../../tools/content/normalize-character-clips.ts'
import { uprightPosture } from '../../tools/content/upright-posture.ts'
import { clipHash, io, isLegacyClip, root } from './paired-grip-test-helpers.ts'

function stream(a: Accessor | null) {
  if (!a) {
    return null
  }
  const values = a.getArray()
  if (!values) {
    throw new Error('Missing native buffer')
  }
  return [
    a.getType(),
    a.getComponentType(),
    a.getNormalized(),
    createHash('sha256')
      .update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength))
      .digest('hex'),
  ]
}
function clips(doc: Document) {
  return new Map(
    doc
      .getRoot()
      .listAnimations()
      .map((c) => [
        c.getName(),
        {
          extras: c.getExtras(),
          channels: c
            .listChannels()
            .map((ch) => {
              const s = ch.getSampler()
              if (!s) {
                throw new Error('Missing native sampler')
              }
              return [
                ch.getTargetNode()?.getName(),
                ch.getTargetPath(),
                s.getInterpolation(),
                stream(s.getInput()),
                stream(s.getOutput()),
              ]
            })
            .sort((a, b) => `${a[0]}.${a[1]}`.localeCompare(`${b[0]}.${b[1]}`)),
        },
      ]),
  )
}
function mesh(doc: Document) {
  return doc
    .getRoot()
    .listMeshes()
    .map((m) =>
      m.listPrimitives().map((p) => ({
        material: p.getMaterial()?.getName(),
        mode: p.getMode(),
        indices: stream(p.getIndices()),
        attributes: p
          .listSemantics()
          .sort((left, right) => left.localeCompare(right))
          .map((s) => [s, stream(p.getAttribute(s))]),
      })),
    )
}
for (const id of ['gun.hardins-pair', 'outlaw-5', 'outlaw-16']) {
  it(`${id} paired variant preserves native geometry, PBR, rig and non-weapon clips`, async () => {
    const base = `public/experiments/out-west/3d/native-v2/${id.startsWith('gun.') ? 'equipment' : 'baked'}/${id}`
    const a = await io.read(base + '.glb'),
      b = await io.read(base + '.pair.glb')
    await validateAuthoringInputs(b)
    expect(b.getRoot().getExtras().pairedGripSeats).toBe(true)
    expect(mesh(b)).toEqual(mesh(a))
    const skins = (d: Document) =>
      d
        .getRoot()
        .listSkins()
        .map((s) => ({
          joints: s.listJoints().map((j) => j.getName()),
          ibm: stream(s.getInverseBindMatrices()),
        }))
    expect(skins(b)).toEqual(skins(a))
    const material = async (path: string) => {
      const bytes = await readFile(path)
      return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString()).materials
    }
    expect(await material(base + '.pair.glb')).toEqual(await material(base + '.glb'))
    const old = clips(a),
      next = clips(b)
    expect([...next.keys()].sort((left, right) => left.localeCompare(right))).toEqual(
      [...old.keys()].sort((left, right) => left.localeCompare(right)),
    )
    for (const [name, data] of [...old].filter(([clipName]) => !clipName.startsWith('Weapon_'))) {
      expect(next.get(name)).toEqual(data)
    }
  })
}
it('published paired body curves match their authored seats and native reduction', async () => {
  const body = await io.read(`${root}/paired-grips/body.glb`)
  completeCharacterClips(body)
  uprightPosture(body)
  await body.transform(resampleNative())
  const expected = clips(body),
    actual = clips(await io.read('public/experiments/out-west/3d/native-v2/baked/moves.glb'))
  for (const [name, data] of expected) {
    expect(actual.get(name)).toEqual(data)
  }
})
it('only paired duel opponents select the paired body variant', () => {
  for (let i = 0; i < 17; i++) {
    const asset = ASSETS[`outlaw-${i}` as keyof typeof ASSETS]
    const url = duelOpponentUrl(i)
    const paired = i === 5 || i === 16
    const expected = paired && 'pair' in asset ? asset.pair : asset
    expect(url).toBe(expected.url)
    expect(url.split('?')[0]).toBe(
      `/experiments/out-west/3d/native-v2/${i === 0 ? 'fitted/baked' : 'baked'}/outlaw-${i}${paired ? '.pair' : ''}.glb`,
    )
  }
})

it('all single-hand, gait, stance and gesture samples retain the released baseline', async () => {
  const baseline = JSON.parse(await readFile('tests/fixtures/paired-legacy-clips.json', 'utf8'))
  const doc = await io.read('public/experiments/out-west/3d/native-v2/baked/moves.glb')
  const current = Object.fromEntries(
    doc
      .getRoot()
      .listAnimations()
      .filter(isLegacyClip)
      .map((c) => [c.getName(), clipHash(c)]),
  )
  expect(current).toEqual(baseline.clips)
  expect(doc.getRoot().getExtras().gaitSpeeds).toEqual(baseline.gaitSpeeds)
})
