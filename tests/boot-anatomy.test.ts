import { expect, it } from 'bun:test'
import { file } from 'bun'
import { Group, Vector3 } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import { boneKey, bounds, sampleBody } from '../src/experiments/out-west/scene/fit.ts'
import { SLOT } from '../src/experiments/out-west/scene/roles.ts'
import { westernKit } from '../src/experiments/out-west/scene/western-kit.ts'

const key = (x: number, y: number, z: number) => [x, y, z].map(Math.fround).join(',')

it.each(['casual', 'worker', 'suit', 'rugged', 'punk', 'king', 'woman'])(
  'keeps the accepted %s vamp/heel vertices and fits its shaft below the real knee',
  async (base) => {
    const model = await new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(await file(`public/experiments/out-west/3d/models/${base}.glb`).arrayBuffer(), '')
    markCharacterSlots(model)
    const root = new Group()
    root.add(model.scene)
    root.updateMatrixWorld(true)
    const body = sampleBody(model.scene, root)
    const boots = westernKit([], body, 'straight').filter((piece) => piece.slot === SLOT.Boots)
    expect(boots).toHaveLength(2)
    for (const [i, side] of [-1, 1].entries()) {
      const boot = boots[i]
      const sideName = side > 0 ? 'L' : 'R'
      const foot = body.bones.find((bone) => boneKey(bone.name) === `Foot${sideName}`)
      const shin = body.bones.find((bone) => boneKey(bone.name) === `LowerLeg${sideName}`)
      if (!(boot?.weights && foot && shin)) {
        throw new Error('Missing actual shoe or calf')
      }
      const ankle = foot.getWorldPosition(new Vector3())
      const knee = shin.getWorldPosition(new Vector3())
      const source = bounds(
        body.samples.filter((sample) => sample.slot === SLOT.Boots && sample.p.x * side > 0),
      )
      const positions = boot.geo.getAttribute('position')
      const normals = boot.geo.getAttribute('normal')
      const actual = new Set(
        Array.from({ length: positions.count }, (_, v) =>
          key(positions.getX(v), positions.getY(v), positions.getZ(v)),
        ),
      )
      expect(protectedFoot(source, ankle, knee).every((point) => actual.has(point))).toBe(true)
      let top = Number.NEGATIVE_INFINITY
      let invalid = 0
      let radial = 0
      let footPoints = 0
      let shinPoints = 0
      let wrongFoot = 0
      let wrongShin = 0
      for (let vertex = 0; vertex < positions.count; vertex++) {
        const point = new Vector3().fromBufferAttribute(positions, vertex)
        top = Math.max(top, point.y)
        const weights = boot.weights(point)
        invalid += validWeights(weights) ? 0 : 1
        if (point.y <= source.min.y + 0.13) {
          footPoints++
          wrongFoot += weights.find(([bone]) => bone === foot)?.[1] === 1 ? 0 : 1
        }
        if (point.y >= Math.max(ankle.y + 0.11, source.min.y + 0.21)) {
          shinPoints++
          wrongShin += weights.find(([bone]) => bone === shin)?.[1] === 1 ? 0 : 1
          const t = (point.y - ankle.y) / (knee.y - ankle.y)
          radial = Math.max(
            radial,
            Math.hypot(
              (point.x - (ankle.x + (knee.x - ankle.x) * t)) /
                ((source.max.x - source.min.x) * 0.375 + 0.012),
              (point.z - (ankle.z + (knee.z - ankle.z) * t)) /
                ((source.max.z - source.min.z) * 0.24 + 0.012),
            ),
          )
        }
      }
      expect(invalid).toBe(0)
      expect(footPoints).toBeGreaterThan(0)
      expect(shinPoints).toBeGreaterThan(0)
      expect(wrongFoot + wrongShin).toBe(0)
      expect(top).toBeLessThanOrEqual(knee.y - 0.02)
      expect(radial).toBeLessThan(1.2)
      expect(Array.from(normals.array).every(Number.isFinite)).toBe(true)
      boot.geo.dispose()
    }
  },
)

/** Golden coordinates of the previously accepted foot; shaft authoring must leave these exact. */
function protectedFoot(b: ReturnType<typeof bounds>, foot: Vector3, knee: Vector3): string[] {
  const width = b.max.x - b.min.x
  const length = b.max.z - b.min.z
  const bottom = b.min.y
  const points: string[] = []
  const rings = [
    [0.014, 0.45, 0.47, b.center.z],
    [0.033, 0.455, 0.47, b.center.z],
    [0.043, 0.46, 0.475, b.center.z],
    [0.061, 0.44, 0.46, b.center.z],
    [0.09, 0.42, 0.39, b.center.z - 0.006],
    [0.13, 0.35, 0.29, foot.z + 0.012],
  ] as const
  for (const [ring, [dy, rx, rz, z]] of rings.entries()) {
    const y = bottom + dy
    const axis = Math.max(0, Math.min(1, (y - foot.y) / Math.max(0.1, knee.y - foot.y)))
    for (let segment = 0; segment <= 20; segment++) {
      const a = (segment / 20) * Math.PI * 2
      const toe = 1 - 0.1 * Math.max(0, Math.cos(a))
      points.push(
        key(
          b.center.x + (knee.x - foot.x) * axis + Math.sin(a) * (width * rx) * toe,
          y + (ring < 2 ? 0.024 * Math.max(0, -Math.cos(a)) : 0),
          z + Math.cos(a) * (length * rz),
        ),
      )
    }
  }
  points.push(key(b.center.x, bottom + 0.025, b.center.z))
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      for (const z of [-1, 1]) {
        points.push(
          key(
            b.center.x + x * ((width * 0.7) / 2),
            bottom + 0.024 + y * (0.048 / 2),
            b.center.z - length * 0.32 + z * ((length * 0.27) / 2),
          ),
        )
      }
    }
  }
  return points
}

function validWeights(weights: readonly (readonly [unknown, number])[]): boolean {
  const sum = weights.reduce((total, [, weight]) => total + weight, 0)
  return (
    Math.abs(sum - 1) < 1e-7 &&
    weights.every(([, weight]) => Number.isFinite(weight) && weight >= 0 && weight <= 1)
  )
}
