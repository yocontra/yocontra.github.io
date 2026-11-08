#!/usr/bin/env bun
/**
 * Frontier's extra character clips (`baked/moves.glb`): sprint, crouch, the jump, the pistol
 * reload, aim up and down, from Quaternius's CC0 Universal Animation Library (Standard), retargeted
 * against the canonical player's skeleton: joints renamed to the game's rig
 * names, translation dropped except the hips (scaled to this skeleton's pelvis height), scale
 * dropped. The file holds the rig's joint hierarchy and the clips, no mesh; the Frontier client
 * loads it on top of `player.glb` (which the duel modes load alone), so only Frontier pays for it.
 *
 *   bun tools/build-moves.ts <UAL1_Standard.glb> [out=public/experiments/out-west/3d/baked/moves.glb]
 */
import { stat } from 'node:fs/promises'
import { Document, type Node as GNode, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { quantize, resample } from '@gltf-transform/functions'
import { MeshoptDecoder } from 'meshoptimizer'
import { rigName } from './build-characters-rig.ts'

const [SRC = '', OUT = 'public/experiments/out-west/3d/baked/moves.glb'] = process.argv.slice(2)
if (!SRC) {
  throw new Error('usage: bun tools/build-moves.ts <UAL1_Standard.glb> [out]')
}
const PLAYER = 'public/experiments/out-west/3d/baked/player.glb'

/** Game clip name ← Universal Animation Library clip. */
const CLIPS: Record<string, string> = {
  Sprint: 'Sprint_Loop',
  // biome-ignore lint/style/useNamingConvention: the game's clip names
  Crouch_Idle: 'Crouch_Idle_Loop',
  // biome-ignore lint/style/useNamingConvention: the game's clip names
  Crouch_Walk: 'Crouch_Fwd_Loop',
  // biome-ignore lint/style/useNamingConvention: the game's clip names
  Jump_Start: 'Jump_Start',
  // biome-ignore lint/style/useNamingConvention: the game's clip names
  Jump_Loop: 'Jump_Loop',
  // biome-ignore lint/style/useNamingConvention: the game's clip names
  Jump_Land: 'Jump_Land',
  Reload: 'Pistol_Reload',
  // biome-ignore lint/style/useNamingConvention: the game's clip names
  Aim_Up: 'Pistol_Aim_Up',
  // biome-ignore lint/style/useNamingConvention: the game's clip names
  Aim_Down: 'Pistol_Aim_Down',
}

await MeshoptDecoder.ready
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })

const ual = await io.read(SRC)
const player = await io.read(PLAYER)

// The player's joint hierarchy, copied node for node (names and rest transforms).
const out = new Document()
const buf = out.createBuffer()
const scene = out.createScene('Scene')
const byName = new Map<string, GNode>()
function copy(src: GNode, parent: GNode | null): void {
  const n = out
    .createNode(src.getName())
    .setTranslation(src.getTranslation())
    .setRotation(src.getRotation())
    .setScale(src.getScale())
  byName.set(src.getName(), n)
  if (parent) {
    parent.addChild(n)
  } else {
    scene.addChild(n)
  }
  for (const c of src.listChildren()) {
    if (!c.getMesh()) {
      copy(c, n)
    }
  }
}
for (const top of (
  player.getRoot().getDefaultScene() ?? player.getRoot().listScenes()[0]
)?.listChildren() ?? []) {
  if (!top.getMesh()) {
    copy(top, null)
  }
}

const pelvisY = (nodes: GNode[], name: string): number =>
  nodes.find((n) => n.getName() === name)?.getWorldTranslation()[1] ?? 0
const ualPelvis = pelvisY(ual.getRoot().listNodes(), 'pelvis')
const ourPelvis = pelvisY(player.getRoot().listNodes(), 'Hips')
const hipK = ualPelvis > 0 && ourPelvis > 0 ? ourPelvis / ualPelvis : 1
console.log(
  `hips ×${hipK.toFixed(3)}, ${byName.size} joints: ${[...byName.keys()].slice(0, 6).join(' ')} ← ${rigName('upperarm_r')} ${rigName('pelvis')}`,
)

for (const [ours, theirs] of Object.entries(CLIPS)) {
  const src = ual
    .getRoot()
    .listAnimations()
    .find((a) => a.getName() === theirs)
  if (!src) {
    console.warn(`  ! clip ${theirs} missing`)
    continue
  }
  const anim = out.createAnimation(ours)
  for (const ch of src.listChannels()) {
    const node = ch.getTargetNode()
    const path = ch.getTargetPath()
    const s = ch.getSampler()
    if (!(node && s && path)) {
      continue
    }
    const target = byName.get(rigName(node.getName()))
    const hips = node.getName() === 'pelvis'
    if (!target || path === 'scale' || (path === 'translation' && !hips)) {
      continue
    }
    const input = s.getInput()?.getArray()
    const output = s.getOutput()?.getArray()
    if (!(input && output)) {
      continue
    }
    const o = Float32Array.from(output)
    if (path === 'translation') {
      for (let i = 0; i < o.length; i++) {
        o[i] = (o[i] ?? 0) * hipK
      }
    }
    const sampler = out
      .createAnimationSampler()
      .setInput(
        out.createAccessor().setType('SCALAR').setArray(Float32Array.from(input)).setBuffer(buf),
      )
      .setOutput(
        out
          .createAccessor()
          .setType(path === 'rotation' ? 'VEC4' : 'VEC3')
          .setArray(o)
          .setBuffer(buf),
      )
      .setInterpolation(s.getInterpolation())
    anim.addSampler(sampler)
    anim.addChannel(
      out.createAnimationChannel().setTargetNode(target).setTargetPath(path).setSampler(sampler),
    )
  }
  console.log(`  ${ours} ← ${theirs} (${anim.listChannels().length} channels)`)
}

await out.transform(resample({ tolerance: 2e-4 }), quantize())
await io.write(OUT, out)
const { size } = await stat(OUT)
console.log(`wrote ${OUT} ${(size / 1024).toFixed(0)} KB`)
