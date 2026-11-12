/** Merge baked authoring poses into the native shared Anim container. No runtime posing code. */
import { copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type Animation, type Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, mergeDocuments, prune, resample, unpartition } from '@gltf-transform/functions'
import { validateAuthoringInputs } from './authoring-inputs.ts'
import { appendCrouchClips } from './crouch-character-clips.ts'
import { closeIdleSeams } from './idle-seams.ts'
import { completeCharacterClips } from './normalize-character-clips.ts'
import { normalizeSkinnedAsset } from './normalize-skinned-nodes.ts'
import { uprightPosture } from './upright-posture.ts'

const root = resolve('tools/art/characters')
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
export function appendClips(target: Document, source: Document, names?: ReadonlySet<string>): void {
  if (names) {
    selectClips(source, names)
  }
  replaceNamedClips(target, source)
  const nodes = target.getRoot().listNodes()
  const scenes = target.getRoot().listScenes()
  for (const node of source.getRoot().listNodes()) {
    if (node.getExtras().gaitSpeeds) {
      target
        .getRoot()
        .setExtras({ ...target.getRoot().getExtras(), gaitSpeeds: node.getExtras().gaitSpeeds })
    }
  }
  const map = mergeDocuments(target, source)
  for (const original of source.getRoot().listAnimations()) {
    const animation = map.get(original) as Animation | undefined
    if (!animation) {
      throw new Error('Animation copy failed')
    }
    for (const channel of animation.listChannels()) {
      const name = channel.getTargetNode()?.getName()
      const node = nodes.find((candidate) => candidate.getName() === name)
      if (node) {
        channel.setTargetNode(node)
      } else {
        channel.dispose()
      }
    }
  }
  for (const animation of target.getRoot().listAnimations()) {
    if (animation.listChannels().length === 0) {
      animation.dispose()
    }
  }
  for (const scene of target.getRoot().listScenes()) {
    if (!scenes.includes(scene)) {
      scene.dispose()
    }
  }
  for (const node of target.getRoot().listNodes()) {
    if (!nodes.includes(node)) {
      node.dispose()
    }
  }
}
export async function bakeCharacterClips(): Promise<void> {
  const path = resolve('public/experiments/out-west/3d/native-v2/baked/moves.glb')
  // Keep the original authored move clips as canonical input on the first conversion.
  const preserved = resolve(root, 'moves.gltf')
  const original = (await Bun.file(preserved).exists()) ? preserved : resolve(root, 'moves.glb')
  if (!(await Bun.file(original).exists())) {
    await copyFile(path, original)
  }
  const target = await io.read(original)
  for (const name of ['character-actions', 'character-strides', 'held-rifle', 'held-shotgun']) {
    appendClips(target, await io.read(resolve(root, `${name}.gltf`)))
  }
  appendClips(target, await io.read(resolve(root, 'character-pair-actions.glb')))
  const paired = await io.read(resolve(root, 'paired-poses/left-arm.glb'))
  await validateAuthoringInputs(paired)
  appendClips(target, paired)
  appendClips(
    target,
    await io.read(resolve(root, 'character-draw-actions.glb')),
    new Set(['Draw', 'Flinch', 'Spin']),
  )
  for (const kind of ['rifle', 'shotgun']) {
    appendClips(
      target,
      await io.read(resolve(root, `held-actions-${kind}.glb`)),
      new Set([`Hold_${kind}`, `Shoot_${kind}`]),
    )
    const grip = resolve(root, `longgun-grips/${kind}.glb`)
    if (await Bun.file(grip).exists()) {
      const grips = await io.read(grip)
      await validateAuthoringInputs(grips)
      appendClips(target, grips)
    }
  }
  appendClips(
    target,
    await io.read(resolve(root, 'player.gltf')),
    new Set(['Idle_Gun_Pointing', 'Gun_Shoot']),
  )
  completeCharacterClips(target)
  closeIdleSeams(target)
  uprightPosture(target)
  appendCrouchClips(target)
  await target.transform(resample(), dedup(), prune({ keepLeaves: true }), unpartition())
  await io.write(path, target)
  await normalizeSkinnedAsset(path)
  console.log(
    target
      .getRoot()
      .listAnimations()
      .map((clip) => clip.getName())
      .join(', '),
  )
}
if (import.meta.main) {
  await bakeCharacterClips()
}

function selectClips(doc: Document, names: ReadonlySet<string>): void {
  for (const clip of doc.getRoot().listAnimations()) {
    if (!names.has(clip.getName())) {
      clip.dispose()
    }
  }
}

function replaceNamedClips(target: Document, source: Document): void {
  const names = new Set(
    source
      .getRoot()
      .listAnimations()
      .map((clip) => clip.getName()),
  )
  for (const clip of target.getRoot().listAnimations()) {
    if (names.has(clip.getName())) {
      clip.dispose()
    }
  }
}
