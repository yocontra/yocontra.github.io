/** CPU-only actual dressed rigs: repeat the same32-rig pose workload before and after optimization. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { file } from 'bun'
import { Group, Quaternion, SkinnedMesh, Vector3 } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { BodyKey } from '../../src/experiments/out-west/data/outlaws.ts'
import { markCharacterSlots } from '../../src/experiments/out-west/engine/assets.ts'
import { clothPoints } from '../../src/experiments/out-west/ffa/scene/crowd/corpse-cloth-points.ts'
import {
  type CorpseRig,
  cloneCorpse,
} from '../../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import {
  ownGeometry,
  releaseGeometry,
} from '../../src/experiments/out-west/ffa/scene/crowd/geometry-lease.ts'
import { corpseGround } from '../../src/experiments/out-west/ffa/scene/ragdoll-cloth-contact.ts'
import { buildGrid } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { dressedActor } from '../../src/experiments/out-west/scene/loadout.ts'
import { revolverDef } from '../../src/experiments/out-west/scene/revolver.ts'

const bases = ['casual', 'worker', 'rugged', 'suit', 'king', 'punk', 'woman'] as const
const outfits = [
  'outfit.trail-duds',
  'outfit.shirt-vest',
  'outfit.wool-duster',
  'outfit.striped-poncho',
  'outfit.gamblers-frock',
  'outfit.bandolier-rig',
  'outfit.undertakers-black',
  'outfit.midnight-coat',
] as const
const load = async (name: string): Promise<GLTF> =>
  new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .parseAsync(await file(`public/experiments/out-west/3d/models/${name}.glb`).arrayBuffer(), '')
const models = new Map<BodyKey, GLTF>()
const [player, moves] = await Promise.all([load('player'), load('moves')])
for (const base of bases) {
  const model = await load(base)
  markCharacterSlots(model)
  models.set(base, model)
}
const rigs: CorpseRig[] = []
for (let i = 0; i < 32; i++) {
  const base = bases[i % bases.length] ?? 'casual'
  const model = models.get(base)
  if (!model) {
    throw new Error('Missing model')
  }
  const actor = dressedActor(model, revolverDef(0.32), {
    base,
    clips: [...player.animations, ...moves.animations],
    outfit: outfits[i % outfits.length],
    gun: 'gun.hardins-pair',
    hat: 'hat.bronze-band',
    spurs: 'spurs.silver-jinglebobs',
    seed: `pose-bench-${i}`,
  })
  new Group().add(actor.root)
  actor.root.position.set(72 + (i % 8) * 0.05, 0.25, 69 + Math.floor(i / 8) * 0.05)
  actor.root.scale.setScalar(1.25)
  actor.play('Idle_Gun_Pointing', 0)
  actor.update(0.37)
  const geometry = actor.meshes[0]?.geometry
  if (!geometry) {
    throw new Error('Missing dressed skin')
  }
  ownGeometry(geometry)
  rigs.push(cloneCorpse(actor, geometry, `bench-${i}`))
  releaseGeometry(geometry)
  actor.dispose()
}
const targets = rigs.map((rig) =>
  rig.links.map((link) => ({ position: link.position.clone(), rotation: link.rotation.clone() })),
)
const rotation = new Quaternion()
const axis = new Vector3(0, 0, 1)
const town = corpseGround(buildGrid())
const counts = rigs
  .map((rig) => {
    const total = { points: 0, vertices: 0, influences: 0 }
    rig.root.traverse((node) => {
      if (node instanceof SkinnedMesh && rig.sourceGeometry) {
        const found = clothPoints(node, rig.sourceGeometry)
        total.points += found.count
        total.vertices += found.vertices.length
        total.influences += found.bones.length
      }
    })
    return total
  })
  .reduce(
    (total, next) => ({
      points: total.points + next.points,
      vertices: total.vertices + next.vertices,
      influences: total.influences + next.influences,
    }),
    { points: 0, vertices: 0, influences: 0 },
  )
const sourceHash = createHash('sha256')
for (const moduleName of ['corpse-rig', 'corpse-pose', 'corpse-cloth', 'corpse-cloth-points']) {
  sourceHash.update(readFileSync(`src/experiments/out-west/ffa/scene/crowd/${moduleName}.ts`))
}
const result: Record<string, unknown> = {
  sourceHash: sourceHash.digest('hex'),
  capturedAt: new Date().toISOString(),
  runtime: `Bun ${Bun.version}`,
  cloth: counts,
  rigs: 32,
  frames: 120,
  models: bases,
  outfits,
}
for (const [label, ground] of [
  ['poseOnly', undefined],
  ['poseAndCloth', town],
] as const) {
  const samples: number[] = []
  for (let frame = 0; frame < 150; frame++) {
    rotation.setFromAxisAngle(axis, Math.sin(frame * 0.04) * 0.45)
    for (const [index, rig] of rigs.entries()) {
      for (const [bone, link] of rig.links.entries()) {
        targets[index]?.[bone]?.rotation.copy(link.rotation).premultiply(rotation)
      }
    }
    const before = performance.now()
    for (const [index, rig] of rigs.entries()) {
      rig.pose(targets[index] ?? [], ground)
    }
    if (frame >= 30) {
      samples.push(performance.now() - before)
    }
  }
  samples.sort((a, b) => a - b)
  result[label] = {
    p50: samples[60],
    p95: samples[114],
    mean: samples.reduce((sum, n) => sum + n, 0) / samples.length,
    max: samples.at(-1),
  }
}
for (const rig of rigs) {
  rig.dispose()
}
const label = process.argv.find((arg) => arg.startsWith('--label='))?.slice(8) ?? 'current'
writeFileSync(`.playwright-mcp/quality/pose-${label}.json`, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
