import { afterAll, beforeAll, expect, it, spyOn } from 'bun:test'
import { file } from 'bun'
import { Body, type ContactEquation, Plane, Sphere, Vec3 } from 'cannon-es'
import { type BufferGeometry, Group, SkinnedMesh, Vector3 } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { BodyKey } from '../src/experiments/out-west/data/outlaws.ts'
import type { Assets } from '../src/experiments/out-west/engine/assets.ts'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import { dressedRider } from '../src/experiments/out-west/ffa/scene/crowd/actor.ts'
import {
  cloneCorpse,
  prepareCorpseFit,
} from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import {
  ownGeometry,
  releaseGeometry,
} from '../src/experiments/out-west/ffa/scene/crowd/geometry-lease.ts'
import { lookFor } from '../src/experiments/out-west/ffa/scene/looks.ts'
import { CorpsePhysics } from '../src/experiments/out-west/ffa/scene/ragdoll-body.ts'
import { bootFitStats } from '../src/experiments/out-west/ffa/scene/ragdoll-boot.ts'
import { corpseGround } from '../src/experiments/out-west/ffa/scene/ragdoll-cloth-contact.ts'
import { Ragdolls } from '../src/experiments/out-west/ffa/scene/ragdolls.ts'
import { buildGrid } from '../src/experiments/out-west/ffa/sim/layout.ts'
import { surfaceTop } from '../src/experiments/out-west/ffa/sim/surfaces.ts'
import { boneKey } from '../src/experiments/out-west/scene/fit.ts'

const bases = ['casual', 'worker', 'rugged', 'suit', 'king', 'punk', 'woman'] as const
const models = new Map<BodyKey, GLTF>()
let assets: Assets
const grid = buildGrid()
let pool: Ragdolls
beforeAll(async () => {
  const load = async (name: string) => {
    const gltf = await new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(
        await file(
          new URL(`../public/experiments/out-west/3d/models/${name}.glb`, import.meta.url),
        ).arrayBuffer(),
        '',
      )
    markCharacterSlots(gltf)
    return gltf
  }
  const player = await load('player')
  await Promise.all(bases.map(async (base) => models.set(base, await load(base))))
  assets = { player, bodyNow: (key: BodyKey) => models.get(key) } as Assets
  const props = await new GLTFLoader().parseAsync(
    JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }),
    '',
  )
  pool = new Ragdolls({
    root: new Group(),
    grid,
    props,
    source: {
      captureCorpse: () => Promise.resolve(null),
      suppressCorpse: () => false,
      releaseCorpse: () => undefined,
    },
  })
})
afterAll(() => pool.dispose())

function bootVertices(root: Group) {
  const entries: {
    mesh: SkinnedMesh
    side: 'FootL' | 'FootR'
    vertices: number[]
  }[] = []
  root.traverse((mesh) => {
    if (!(mesh instanceof SkinnedMesh)) {
      return
    }
    const skin = mesh.geometry.getAttribute('skinIndex')
    const weights = mesh.geometry.getAttribute('skinWeight')
    for (const side of ['FootL', 'FootR'] as const) {
      const vertices: number[] = []
      const suffix = side.slice(-1)
      for (const vertex of new Set<number>(mesh.geometry.index?.array ?? [])) {
        let shoe = 0
        for (let slot = 0; slot < 4; slot++) {
          const key = boneKey(mesh.skeleton.bones[skin.getComponent(vertex, slot)]?.name ?? '')
          if (key === `Foot${suffix}` || key === `Toe${suffix}`) {
            shoe += weights.getComponent(vertex, slot)
          }
        }
        if (shoe >= 1 - 1e-6) {
          vertices.push(vertex)
        }
      }
      entries.push({ mesh, side, vertices })
    }
  })
  return entries
}
function supportPlane(contact: ContactEquation, body: import('cannon-es').Body) {
  const first = contact.bi === body
  const other = first ? contact.bj : contact.bi
  const point = other.position.vadd(first ? contact.rj : contact.ri)
  const normal = first ? contact.ni.negate(new Vec3()) : contact.ni
  return {
    point: new Vector3(point.x, point.y, point.z),
    normal: new Vector3(normal.x, normal.y, normal.z),
  }
}

function checkContacts(physics: CorpsePhysics, vertices: ReturnType<typeof bootVertices>) {
  const samples: {
    error: number
    gap: number
    ground: boolean
    travel: number
    drift: number
    side: string
    normal: number[]
    collider: number
  }[] = []
  const point = new Vector3()
  for (const entry of vertices) {
    const part = physics.parts.find((candidate) => candidate.link.key === entry.side)
    if (!part) {
      throw new Error('Missing actual foot')
    }
    const anatomy = part.body.shapes.slice(0, part.link.anatomySpheres?.length ?? 0)
    const contacts = pool.world.contacts.filter((contact) => {
      if (contact.bi === part.body) {
        return contact.bj.mass === 0 && anatomy.includes(contact.si) && contact.multiplier > 0.01
      }
      return (
        contact.bj === part.body &&
        contact.bi.mass === 0 &&
        anatomy.includes(contact.sj) &&
        contact.multiplier > 0.01
      )
    })
    for (const contact of contacts) {
      const plane = supportPlane(contact, part.body)
      let gap = Number.POSITIVE_INFINITY
      for (const vertex of entry.vertices) {
        entry.mesh.getVertexPosition(vertex, point).applyMatrix4(entry.mesh.matrixWorld)
        gap = Math.min(gap, point.sub(plane.point).dot(plane.normal))
      }
      let collider = Number.POSITIVE_INFINITY
      for (const [index, shape] of anatomy.entries()) {
        const offset = part.body.shapeOffsets[index]
        if (!(shape instanceof Sphere && offset)) {
          throw new Error('Boot support must remain a measured sphere')
        }
        const center = part.body.pointToWorldFrame(offset)
        const height = new Vector3(center.x, center.y, center.z).sub(plane.point).dot(plane.normal)
        collider = Math.min(collider, height - shape.radius)
      }
      const other = contact.bi === part.body ? contact.bj : contact.bi
      const bone = entry.mesh.skeleton.bones.find((value) => boneKey(value.name) === entry.side)
      if (!bone) {
        throw new Error('Missing actual boot bone')
      }
      // Child translations preserve authored bone lengths. Separate their existing joint
      // anchor drift from the new sphere envelope's geometric support error.
      const drift = new Vector3().setFromMatrixPosition(bone.matrixWorld).sub(part.pose.position)
      samples.push({
        error: gap - collider - drift.dot(plane.normal),
        side: entry.side,
        normal: plane.normal.toArray(),
        collider,
        drift: drift.dot(plane.normal),
        gap,
        ground: other.shapes.some((shape) => shape instanceof Plane),
        travel:
          (part.body.velocity.length() +
            part.body.angularVelocity.length() * part.body.boundingRadius) /
          120,
      })
    }
  }
  return samples
}

it.each(bases)(
  'prepares %s boot supports once and bounds sole fit on ground/roof/stair contacts',
  (base) => {
    const look = lookFor(['outfit.trail-duds', 'spurs.silver-jinglebobs'], 1)
    look.look.base = base
    const actor = dressedRider(assets, look)
    const full = actor.meshes[0]?.geometry
    if (!full) {
      throw new Error('Missing actual body')
    }
    ownGeometry(full)
    new Group().add(actor.root)
    actor.root.scale.setScalar(1.25)
    actor.play('Idle_Gun_Pointing', 0)
    actor.update(0.37)
    const roof = grid.roofs[0]
    const stair = grid.stairs[0]
    if (!(roof && stair)) {
      throw new Error('Missing actual elevated contacts')
    }
    const at = (surface: typeof roof) => {
      const x = surface.x + surface.w * 0.37
      const z = surface.z + surface.d * 0.41
      return { x, z, y: surfaceTop(surface, x, z) }
    }
    const fixtures = [{ x: 72, z: 69, y: 0 }, at(roof), at(stair), { x: 72, z: 69, y: 0.2 }]
    let supported = 0
    let rawGroundMin = 0
    let rawGroundMax = 0
    for (const position of fixtures) {
      actor.root.position.set(position.x, position.y, position.z)
      actor.root.updateMatrixWorld(true)
      const before = bootFitStats()
      const original = SkinnedMesh.prototype.getVertexPosition
      let scans = 0
      SkinnedMesh.prototype.getVertexPosition = function (vertex, target) {
        scans++
        return original.call(this, vertex, target)
      }
      const rig = cloneCorpse(actor, full, 'boot-contact')
      // Cloth retains this stable delegating getter; restoring a Bun mock here would invalidate it.
      SkinnedMesh.prototype.getVertexPosition = original
      expect(scans).toBe(0)
      expect(bootFitStats()).toEqual(before)
      const physics = new CorpsePhysics(
        pool.world,
        rig,
        { velocity: new Vector3(), impulse: new Vector3(3, 0.1, 0) },
        corpseGround(grid),
      )
      const vertices = bootVertices(rig.root)
      expect(physics.parts).toHaveLength(18)
      for (const part of physics.parts.filter((candidate) =>
        candidate.link.key.startsWith('Foot'),
      )) {
        const count = part.link.anatomySpheres?.length ?? 0
        expect(count).toBeGreaterThanOrEqual(12)
        expect(count).toBeLessThanOrEqual(14)
        expect(part.body.shapes).toHaveLength(count + (part.link.contacts?.length ?? 0))
        const massReference = originalMassBody(part.body, count)
        expect(part.body.mass).toBe(massReference.mass)
        expect(part.body.inertia.toArray()).toEqual(massReference.inertia.toArray())
        expect(part.body.invInertia.toArray()).toEqual(massReference.invInertia.toArray())
      }
      for (let tick = 0; tick < 240; tick++) {
        physics.limitSpeed()
        pool.world.step(1 / 120)
        physics.sync(false)
        if (tick < 60 || tick % 15 !== 0) {
          continue
        }
        const samples = checkContacts(physics, vertices)
        const grounded = samples.filter((sample) => sample.ground)
        const groundGaps = grounded.map((sample) => sample.gap)
        rawGroundMin = Math.min(rawGroundMin, ...groundGaps)
        rawGroundMax = Math.max(rawGroundMax, ...groundGaps)
        // Contact points precede integration; bound one120Hz linear and angular surface sweep.
        const lower = grounded.map(
          (sample) => sample.gap + sample.travel - Math.min(0, sample.drift),
        )
        expect(Math.min(0, ...lower)).toBeGreaterThan(-0.035)
        expect(Math.max(0, ...groundGaps)).toBeLessThan(0.025)
        for (const sample of samples) {
          // The measured2cm support approximation plus the source skin's15mm sole baseline.
          expect(sample.error, JSON.stringify({ base, position, tick, sample })).toBeLessThan(0.035)
          expect(sample.error).toBeGreaterThan(-0.035)
          supported++
        }
      }
      expect(Number.isFinite(physics.separation)).toBe(true)
      physics.dispose()
    }
    expect(
      supported,
      JSON.stringify({ base, rawGroundMin, rawGroundMax, bootFits: bootFitStats() }),
    ).toBeGreaterThan(0)
    releaseGeometry(full)
    actor.dispose()
  },
)

/** Compare the constructed body against the same old twelve supports and unchanged gear. */
function originalMassBody(body: Body, count: number): Body {
  const original = new Body({ mass: body.mass, position: body.position.clone() })
  const update = original.updateMassProperties
  original.updateMassProperties = () => undefined
  for (const [index, shape] of body.shapes.entries()) {
    if (index >= 12 && index < count) {
      continue
    }
    const offset = body.shapeOffsets[index]
    if (!(shape instanceof Sphere && offset)) {
      throw new Error('Unexpected boot contact shape')
    }
    original.addShape(new Sphere(shape.radius), offset.clone())
  }
  original.updateMassProperties = update
  original.updateMassProperties()
  return original
}

function soleHeight(vertices: ReturnType<typeof bootVertices>, point: Vector3): number {
  let minimum = Number.POSITIVE_INFINITY
  for (const entry of vertices) {
    for (const vertex of entry.vertices) {
      entry.mesh.getVertexPosition(vertex, point).applyMatrix4(entry.mesh.matrixWorld)
      minimum = Math.min(minimum, point.y)
    }
  }
  return minimum
}

function longestDip(depths: readonly number[]): number {
  let consecutive = 0
  let maximum = 0
  for (const depth of depths) {
    consecutive = depth < -0.03 ? consecutive + 1 : 0
    maximum = Math.max(maximum, consecutive)
  }
  return maximum
}

it('bounds the raw casual street left-boot impact depth and its brief recovery without drift subtraction', () => {
  const random = spyOn(Math, 'random').mockReturnValue(0.5)
  let actor: ReturnType<typeof dressedRider> | undefined
  let geometry: BufferGeometry | undefined
  let physics: CorpsePhysics | undefined
  try {
    const look = lookFor(['outfit.trail-duds'], 1)
    look.look.base = 'casual'
    actor = dressedRider(assets, look)
    new Group().add(actor.root)
    actor.root.scale.setScalar(1.25)
    actor.play('Idle_Gun_Pointing', 0)
    actor.update(0.37)
    actor.root.position.set(72, 0, 69)
    const full = actor.meshes[0]?.geometry
    if (!full) {
      throw new Error('Missing fixed-fixture body')
    }
    ownGeometry(full)
    geometry = full
    prepareCorpseFit(actor)
    const rig = cloneCorpse(actor, full, 'raw-street-impact')
    physics = new CorpsePhysics(
      pool.world,
      rig,
      { velocity: new Vector3(), impulse: new Vector3(3, 0.1, 0) },
      corpseGround(grid),
    )
    const vertices = bootVertices(rig.root).filter((entry) => entry.side === 'FootL')
    expect(vertices.some((entry) => entry.vertices.length > 0)).toBe(true)
    const depths: number[] = []
    const point = new Vector3()
    for (let tick = 0; tick < 360; tick++) {
      physics.limitSpeed()
      pool.world.step(1 / 120)
      physics.sync(false)
      depths.push(soleHeight(vertices, point))
    }
    const minimum = Math.min(...depths)
    const peakTick = depths.indexOf(minimum)
    const recoveredTick = depths.findIndex((depth, tick) => tick > peakTick && depth >= -0.03)
    const recoverySteps = minimum < -0.03 ? recoveredTick - peakTick : 0
    const consecutiveSteps = longestDip(depths)
    const lateMinimum = Math.min(...depths.slice(240))
    const diagnostic = JSON.stringify({
      case: 'casual/street/left-boot',
      minimum,
      peakTick,
      consecutiveSteps,
      recoverySteps,
      lateMinimum,
    })
    // The accepted fixture reached−49.27mm for11steps and recovered50ms after its peak.
    expect(Number.isFinite(minimum), diagnostic).toBe(true)
    expect(minimum, diagnostic).toBeGreaterThan(-0.055)
    expect(consecutiveSteps, diagnostic).toBeLessThanOrEqual(12)
    expect(recoverySteps, diagnostic).toBeGreaterThanOrEqual(0)
    expect(recoverySteps, diagnostic).toBeLessThanOrEqual(8)
    expect(lateMinimum, diagnostic).toBeGreaterThan(-0.005)
  } finally {
    physics?.dispose()
    if (geometry) {
      releaseGeometry(geometry)
    }
    actor?.dispose()
    random.mockRestore()
  }
})
