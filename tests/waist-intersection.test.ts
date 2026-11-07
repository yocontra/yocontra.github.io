import { beforeAll, expect, it } from 'bun:test'
import { file } from 'bun'
import { Box3, Group, Line3, Plane, Triangle, Vector3 } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { BodyKey } from '../src/experiments/out-west/data/outlaws.ts'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import { Actor, type Clip } from '../src/experiments/out-west/scene/actor.ts'
import { propObject } from '../src/experiments/out-west/scene/props.ts'
import { revolverDef } from '../src/experiments/out-west/scene/revolver.ts'
import { FABRIC } from '../src/experiments/out-west/scene/style.ts'

const bases = ['casual', 'worker', 'suit', 'rugged', 'punk', 'king', 'woman'] as const
const models = new Map<BodyKey, GLTF>()
let player: GLTF
beforeAll(async () => {
  const load = async (name: string) => {
    const model = await new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(await file(`public/experiments/out-west/3d/models/${name}.glb`).arrayBuffer(), '')
    markCharacterSlots(model)
    return model
  }
  player = await load('player')
  await Promise.all(bases.map(async (base) => models.set(base, await load(base))))
})

function crosses(a: Triangle, b: Triangle): boolean {
  const points: Vector3[] = []
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    for (const [p, q] of [
      [from.a, from.b],
      [from.b, from.c],
      [from.c, from.a],
    ]) {
      if (!(p && q)) {
        throw new Error('Incomplete actual triangle')
      }
      const hit = to.getPlane(new Plane()).intersectLine(new Line3(p, q), new Vector3())
      if (hit && to.containsPoint(hit)) {
        points.push(hit)
      }
    }
  }
  // A shared touching point is not a visible surface crossing.
  return points.some((p) => points.some((q) => p.distanceToSquared(q) > 1e-10))
}

it.each(bases)('keeps raised thighs from crossing the actual %s shirt above the belt', (base) => {
  const model = models.get(base)
  if (!model) {
    throw new Error(`Missing actual ${base}`)
  }
  const actor = new Actor(model, {
    base,
    clips: model.animations.length > 0 ? model.animations : player.animations,
    hat: 'cowboy',
    hatColor: 0x3a_2a_1a,
    gun: propObject(revolverDef(0.32)),
    scale: 1,
    seed: `${base}/cowboy/${0x3a_2a_1a}/`,
  })
  new Group().add(actor.root)
  actor.draw()
  actor.update(0)
  actor.root.updateMatrixWorld(true)
  const mesh = actor.meshes[0]
  const hip = actor.hips?.getWorldPosition(new Vector3())
  if (!(mesh && hip && mesh.geometry.index)) {
    throw new Error('Missing actual clothed waist')
  }
  const geometry = mesh.geometry
  const index = mesh.geometry.index
  const positions = geometry.getAttribute('position')
  const styles = geometry.getAttribute('styMat')
  const shirt: number[][] = []
  const pants: number[][] = []
  for (let i = 0; i < index.count; i += 3) {
    const vertices = [index.getX(i), index.getX(i + 1), index.getX(i + 2)]
    // The tailored cotton uses rim .8. Select the lower shirt above the tucked belt,
    // independently of its new binding or a guessed rigid world-space waist position.
    if (
      vertices.every((v) => Math.abs(styles.getY(v) - 0.8) < 1e-6) &&
      vertices.some((v) => positions.getY(v) > hip.y + 0.04 && positions.getY(v) < hip.y + 0.22) &&
      vertices.every((v) => positions.getY(v) < hip.y + 0.26)
    ) {
      shirt.push(vertices)
    }
    if (vertices.every((v) => Math.abs(styles.getY(v) - FABRIC.denim.rim) < 1e-6)) {
      pants.push(vertices)
    }
  }
  expect(shirt.length).toBeGreaterThan(20)
  expect(pants.length).toBeGreaterThan(100)
  try {
    for (const [clip, time] of [
      ['Idle', 0],
      ['Walk', 0.2],
      ['Walk', 0.65],
      ['Run', 0.15],
      ['Idle_Gun_Pointing', 0.2],
    ] as [Clip, number][]) {
      actor.play(clip, 0)
      actor.update(time)
      actor.root.updateMatrixWorld(true)
      const posed = (vertices: number[]) => {
        const points = vertices.map((v) =>
          mesh.getVertexPosition(v, new Vector3()).applyMatrix4(mesh.matrixWorld),
        )
        const [a, b, c] = points
        if (!(a && b && c)) {
          throw new Error('Incomplete actual triangle')
        }
        return { triangle: new Triangle(a, b, c), bounds: new Box3().setFromPoints(points) }
      }
      const cloth = shirt.map(posed)
      const denim = pants.map(posed)
      let crossings = 0
      for (const a of cloth) {
        for (const b of denim) {
          if (a.bounds.intersectsBox(b.bounds) && crosses(a.triangle, b.triangle)) {
            crossings++
          }
        }
      }
      expect(crossings, `${base}/${clip}/${time} actual cloth-denim crossings`).toBe(0)
    }
  } finally {
    actor.dispose()
  }
})
