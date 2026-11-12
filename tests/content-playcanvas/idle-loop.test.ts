import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { type Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const idle = new Set(['Idle_Character', 'Idle_Drunk', 'Idle_Shaky'])
// These upper-body channels alone contained the unrelated pointing pose at t=0.
const repaired =
  /^(?:Torso|Chest|Neck|Head|(?:Shoulder|UpperArm|LowerArm|Wrist|(?:Index|Middle|Pinky|Ring|Thumb)[123])[LR])$/u
const hash = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex')
const fingerprint = (value: unknown): string => hash(JSON.stringify(value))
const affected = (clip: string, bone: string, path: string): boolean =>
  idle.has(clip) && path === 'rotation' && repaired.test(bone)

function retained(document: Document) {
  return fingerprint(
    document
      .getRoot()
      .listAnimations()
      .flatMap((clip) =>
        clip.listChannels().flatMap((channel) => {
          const bone = channel.getTargetNode()?.getName() ?? ''
          const path = channel.getTargetPath() ?? ''
          if (affected(clip.getName(), bone, path)) {
            return []
          }
          const sampler = channel.getSampler()
          return [
            [
              clip.getName(),
              bone,
              path,
              sampler?.getInterpolation(),
              Array.from(sampler?.getInput()?.getArray() ?? []),
              Array.from(sampler?.getOutput()?.getArray() ?? []),
            ],
          ]
        }),
      ),
  )
}

function geometry(document: Document) {
  const root = document.getRoot()
  return fingerprint({
    nodes: root
      .listNodes()
      .map((node) => [
        node.getName(),
        node.getTranslation(),
        node.getRotation(),
        node.getScale(),
        node.listChildren().map((child) => child.getName()),
      ]),
    skins: root
      .listSkins()
      .map((skin) => [
        skin.listJoints().map((joint) => joint.getName()),
        Array.from(skin.getInverseBindMatrices()?.getArray() ?? []),
      ]),
    meshes: root
      .listMeshes()
      .map((mesh) =>
        mesh
          .listPrimitives()
          .map((primitive) => [
            primitive.getMode(),
            Array.from(primitive.getIndices()?.getArray() ?? []),
            primitive
              .listSemantics()
              .map((name) => [
                name,
                primitive.getAttribute(name)?.getComponentType(),
                primitive.getAttribute(name)?.getNormalized(),
                Array.from(primitive.getAttribute(name)?.getArray() ?? []),
              ]),
          ]),
      ),
  })
}

function seams(document: Document) {
  return Object.fromEntries(
    document
      .getRoot()
      .listAnimations()
      .filter((clip) => idle.has(clip.getName()))
      .map((clip) => {
        const channels = clip
          .listChannels()
          .filter((channel) =>
            affected(
              clip.getName(),
              channel.getTargetNode()?.getName() ?? '',
              channel.getTargetPath() ?? '',
            ),
          )
        return [
          clip.getName(),
          {
            channels: channels.length,
            closed: channels.every((channel) => {
              const sampler = channel.getSampler()
              const times = sampler?.getInput()
              const values = sampler?.getOutput()
              if (!(times && values)) {
                throw new Error('Incomplete idle channel')
              }
              return (
                times.getScalar(0) === 0 &&
                times.getScalar(times.getCount() - 1) === 8 &&
                JSON.stringify(values.getElement(0, [])) ===
                  JSON.stringify(values.getElement(values.getCount() - 1, []))
              )
            }),
          },
        ]
      }),
  )
}
const closedLoops = Object.fromEntries(
  [...idle].map((name) => [name, { channels: 42, closed: true }]),
)

it('canonical idle repair changes only the 126 corrupt first rotations', async () => {
  const json = await readFile('tools/art/characters/character-actions.gltf')
  const binary = await readFile('tools/art/characters/character-actions.bin')
  const gltf = JSON.parse(json.toString()) as import('@gltf-transform/core').GLTF.IGLTF
  for (const clip of gltf.animations ?? []) {
    for (const channel of clip.channels) {
      const node = gltf.nodes?.[channel.target.node ?? -1]
      if (!affected(clip.name ?? '', node?.name ?? '', channel.target.path)) {
        continue
      }
      const accessor = gltf.accessors?.[clip.samplers[channel.sampler]?.output ?? -1]
      const view = gltf.bufferViews?.[accessor?.bufferView ?? -1]
      if (!(accessor && view)) {
        throw new Error('Missing canonical rotation storage')
      }
      binary.fill(
        0,
        (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0),
        (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + 16,
      )
    }
  }
  expect(hash(json)).toBe('6d1e3b4f9ec8aab9af9569b2ae8895bac6f168c76dd949e90effb7d518114c3e')
  expect(hash(binary)).toBe('cb6e6f70e9dc21df7be7839f003279c12bce615a91de7e46320f14dfb15bfefe')
  expect(seams(await io.read('tools/art/characters/character-actions.gltf'))).toEqual(closedLoops)
})

it('native idle loops close while other clips, times and geometry remain authored', async () => {
  const document = await io.read(
    process.env.OW_IDLE_MOVES ?? 'public/experiments/out-west/3d/native-v2/baked/moves.glb',
  )
  expect(document.getRoot().listAnimations()).toHaveLength(72)
  expect(retained(document)).toBe(
    '9765ecced33d60e39e174c7bd50a31cd280d4b2670acab383e79760182e82f57',
  )
  expect(geometry(document)).toBe(
    '7c5107d243019cf1378ad72cd244a9bbe3917322a576cdb8555ae78ae257f498',
  )
  expect(seams(document)).toEqual(closedLoops)
})
