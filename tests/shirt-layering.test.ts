import { expect, it } from 'bun:test'
import { file } from 'bun'
import { type SkinnedMesh, Vector3 } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { BodyKey } from '../src/experiments/out-west/data/outlaws.ts'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import { Actor, type Clip } from '../src/experiments/out-west/scene/actor.ts'
import type { Cuff } from '../src/experiments/out-west/scene/garment-mesh.ts'
import { propObject } from '../src/experiments/out-west/scene/props.ts'
import { revolverDef } from '../src/experiments/out-west/scene/revolver.ts'

function sleeveFaces(mesh: SkinnedMesh): number {
  const index = mesh.geometry.getIndex()
  const ranges = mesh.geometry.userData.sleeveRanges as { start: number; count: number }[]
  if (!index) {
    throw new Error('Missing body triangles')
  }
  let faces = 0
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    let sleeve = true
    for (let corner = 0; corner < 3; corner++) {
      const vertex = index.getX(triangle + corner)
      if (!ranges.some((range) => vertex >= range.start && vertex < range.start + range.count)) {
        sleeve = false
      }
    }
    if (sleeve) {
      faces++
    }
  }
  return faces
}

it.each(['casual', 'worker', 'suit', 'rugged', 'punk', 'king', 'woman'] as BodyKey[])(
  'keeps the real %s shirt sleeves visible beneath a waistcoat',
  async (base) => {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
    const source = await loader.parseAsync(
      await file(
        new URL(`../public/experiments/out-west/3d/models/${base}.glb`, import.meta.url),
      ).arrayBuffer(),
      '',
    )
    const player = await loader.parseAsync(
      await file(
        new URL('../public/experiments/out-west/3d/models/player.glb', import.meta.url),
      ).arrayBuffer(),
      '',
    )
    markCharacterSlots(source)
    const plain = new Actor(source, {
      base,
      clips: player.animations,
      gun: propObject(revolverDef(0.32)),
    })
    const vest = new Actor(source, { base, clips: player.animations, vest: 0x3a_2a_1e })
    const a = plain.meshes[0]
    const b = vest.meshes[0]
    if (!(a && b)) {
      throw new Error('Missing dressed body')
    }
    const full = sleeveFaces(a)
    const dressed = sleeveFaces(b)
    expect(full).toBeGreaterThan(100)
    expect(dressed / full).toBeGreaterThan(0.95)
    const cuffs = a.geometry.userData.cuffs as Cuff[]
    expect(cuffs).toHaveLength(2)
    for (const [clip, time] of [
      ['Idle', 0],
      ['Idle', 0.7],
      ['Walk', 0.3],
      ['Run', 0.2],
      ['Idle_Gun_Pointing', 0.3],
    ] as [Clip, number][]) {
      plain.play(clip, 0)
      plain.update(time)
      plain.root.updateMatrixWorld(true)
      for (const cuff of cuffs) {
        const wrist = cuff.side === 'L' ? plain.handL : plain.handR
        const center = new Vector3()
        for (const vertex of cuff.vertices) {
          center.add(a.getVertexPosition(vertex, new Vector3()).applyMatrix4(a.matrixWorld))
        }
        center.divideScalar(cuff.vertices.length)
        expect(wrist && center.distanceTo(wrist.getWorldPosition(new Vector3()))).toBeLessThan(0.03)
      }
    }
    plain.dispose()
    vest.dispose()
  },
)
