import { expect, it } from 'bun:test'
import { file, hash } from 'bun'
import { type Bone, Raycaster, SkinnedMesh, Vector3 } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import { Actor, type Clip } from '../src/experiments/out-west/scene/actor.ts'
import { boneKey } from '../src/experiments/out-west/scene/fit.ts'
import { propObject } from '../src/experiments/out-west/scene/props.ts'
import { revolverDef } from '../src/experiments/out-west/scene/revolver.ts'
import { FABRIC, SKIN_FLAG } from '../src/experiments/out-west/scene/style.ts'

const FOOT = /^(?:Foot|Toe)[LR]$/u
const bases = ['casual', 'worker', 'rugged', 'suit', 'king', 'punk', 'woman'] as const
const load = async (base: string) =>
  new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .parseAsync(await file(`public/experiments/out-west/3d/models/${base}.glb`).arrayBuffer(), '')
function sourcePositions(mesh: SkinnedMesh) {
  return ['position', 'skinIndex', 'skinWeight']
    .map((name) => {
      const a = mesh.geometry.getAttribute(name).array
      return String(hash(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)))
    })
    .join(':')
}
it.each(bases)(
  'finishes real %s faces and boots without mutating source geometry or changing the ground contract',
  async (base) => {
    const [model, player] = await Promise.all([load(base), load('player')])
    markCharacterSlots(model)
    const originals = new Map<SkinnedMesh, ReturnType<typeof sourcePositions>>()
    model.scene.traverse((node) => {
      if (node instanceof SkinnedMesh) {
        originals.set(node, sourcePositions(node))
      }
    })
    for (const skin of ['pale', 'brown'] as const) {
      const actor = new Actor(model, {
        base,
        clips: player.animations,
        skin,
        gloves: 0x35_29_1f,
      })
      actor.update(0)
      actor.root.updateMatrixWorld(true)
      const mesh = actor.meshes[0]
      if (!mesh) {
        throw new Error('Missing actual face mesh')
      }
      mesh.skeleton.update()
      let neck: Bone | undefined
      actor.root.traverse((node) => {
        if ((node as Partial<Bone>).isBone && boneKey(node.name) === 'Neck') {
          neck = node as Bone
        }
      })
      if (!neck) {
        throw new Error('Missing original neck bone')
      }
      const neckAt = neck.getWorldPosition(new Vector3())
      const throat = new Raycaster(
        new Vector3(neckAt.x, neckAt.y + 0.012, 1),
        new Vector3(0, 0, -1),
      ).intersectObject(mesh)[0]
      if (!throat?.face) {
        throw new Error('Open throat through the current collar')
      }
      const skinAtThroat = [throat.face.a, throat.face.b, throat.face.c].every(
        (vertex) => mesh.geometry.getAttribute('styMat').getY(vertex) >= SKIN_FLAG,
      )
      expect(skinAtThroat).toBe(true)
      const { neckVertices, neckRadius, surface, sole, finiteSurface } = closeupMetrics(
        mesh,
        neckAt,
      )
      expect(finiteSurface).toBe(true)
      expect(neckVertices).toBeGreaterThan(5)
      expect(neckRadius).toBeLessThan(1.005)
      expect(surface.size).toBeGreaterThan(8)
      expect(sole).toBeGreaterThan(-0.025)
      expect(sole).toBeLessThan(0.025)
      expect(mesh.geometry.getAttribute('roughnessAt')).toBeUndefined()
      actor.dispose()
    }
    for (const [mesh, checksum] of originals) {
      expect(sourcePositions(mesh)).toBe(checksum)
    }
  },
)

it.each(bases)(
  'fits the %s belt outside the actual shirt and its placket through poses',
  async (base) => {
    const [model, player] = await Promise.all([load(base), load('player')])
    markCharacterSlots(model)
    const actor = new Actor(model, {
      base,
      clips: player.animations,
      gun: propObject(revolverDef(0.32)),
    })
    actor.draw()
    actor.update(0)
    actor.root.updateMatrixWorld(true)
    const mesh = actor.meshes[0]
    const bone = (name: string) =>
      mesh?.skeleton.bones.find((candidate) => boneKey(candidate.name) === name)
    const hips = bone('Hips')
    const left = bone('UpperLegL')?.getWorldPosition(new Vector3())
    const right = bone('UpperLegR')?.getWorldPosition(new Vector3())
    const kneeLeft = bone('LowerLegL')?.getWorldPosition(new Vector3())
    const kneeRight = bone('LowerLegR')?.getWorldPosition(new Vector3())
    if (!(mesh && hips && left && right && kneeLeft && kneeRight)) {
      throw new Error('Missing actual dressed waist')
    }
    const thigh = (left.distanceTo(kneeLeft) + right.distanceTo(kneeRight)) / 2
    const y = (left.y + right.y) / 2 + thigh * 0.08
    const faces = waistFaces(mesh, y, hips.getWorldPosition(new Vector3()).z)
    const underShirt = waistVertices(mesh, y)
    const beltLocalY = hips.worldToLocal(new Vector3(0, y, 0)).y
    expect(faces.length).toBeGreaterThan(4)
    expect(underShirt.length).toBeGreaterThan(10)
    for (const [clip, time] of [
      ['Idle', 0],
      ['Walk', 0.3],
      ['Walk', 0.65],
      ['Run', 0.15],
      ['Idle_Gun_Pointing', 0.2],
    ] as [Clip, number][]) {
      actor.play(clip, 0)
      actor.update(time)
      actor.root.updateMatrixWorld(true)
      mesh.skeleton.update()
      for (const face of faces) {
        const [a, b, c] = face.map((vertex) =>
          mesh.getVertexPosition(vertex, new Vector3()).applyMatrix4(mesh.matrixWorld),
        )
        if (!(a && b && c)) {
          throw new Error('Missing actual belt face')
        }
        const center = a.clone().add(b).add(c).divideScalar(3)
        const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize()
        const from = center.clone().addScaledVector(normal, 0.3)
        const hit = new Raycaster(from, normal.negate(), 0.25, 0.35)
          .intersectObject(mesh)
          .find(
            (candidate) =>
              candidate.face &&
              trunkFace(mesh, [candidate.face.a, candidate.face.b, candidate.face.c]),
          )
        if (!hit?.face) {
          throw new Error('Open waist below the actual shirt')
        }
        const material = mesh.geometry.getAttribute('styMat')
        const rims = [hit.face.a, hit.face.b, hit.face.c].map((vertex) => material.getY(vertex))
        expect(rims.every((rim) => Math.abs(rim - FABRIC.leather.rim) < 1e-6)).toBe(true)
      }
      const pelvis = hips.getWorldPosition(new Vector3())
      let exposedWaist = 0
      for (const vertex of underShirt) {
        const target = mesh.getVertexPosition(vertex, new Vector3()).applyMatrix4(mesh.matrixWorld)
        if (hips.worldToLocal(target.clone()).y < beltLocalY + 0.025) {
          continue
        }
        const outward = target.clone().sub(pelvis).setY(0).normalize()
        const from = target.clone().addScaledVector(outward, 0.3)
        const hit = new Raycaster(from, outward.negate()).intersectObject(mesh)[0]
        const rim = hit?.face ? mesh.geometry.getAttribute('styMat').getY(hit.face.a) : null
        exposedWaist += rim !== null && Math.abs(rim - FABRIC.denim.rim) < 1e-6 ? 1 : 0
      }
      expect(exposedWaist).toBe(0)
    }
    actor.dispose()
  },
)

function closeupMetrics(mesh: SkinnedMesh, neckAt: Vector3) {
  const styles = mesh.geometry.getAttribute('styMat')
  const weights = mesh.geometry.getAttribute('skinWeight')
  const bones = mesh.geometry.getAttribute('skinIndex')
  const point = new Vector3()
  const used = new Set(mesh.geometry.index?.array ?? [])
  let finiteSurface = true
  const surface = new Set<number>()
  let sole = Number.POSITIVE_INFINITY
  let neckRadius = 0
  let neckVertices = 0
  for (const vertex of used) {
    mesh.getVertexPosition(vertex, point)
    let foot = 0
    for (let slot = 0; slot < 4; slot++) {
      const name = mesh.skeleton.bones[bones.getComponent(vertex, slot)]?.name ?? ''
      if (FOOT.test(boneKey(name))) {
        foot += weights.getComponent(vertex, slot)
      }
    }
    if (foot > 0.5) {
      sole = Math.min(sole, point.y)
    }
    if (styles.getY(vertex) >= SKIN_FLAG) {
      finiteSurface &&= Number.isFinite(styles.getX(vertex))
      surface.add(Math.round(styles.getX(vertex) * 1000))
      if (point.y > neckAt.y - 0.06 && point.y < neckAt.y + 0.035) {
        neckRadius = Math.max(
          neckRadius,
          Math.hypot((point.x - neckAt.x) / 0.053, (point.z - neckAt.z) / 0.044),
        )
        neckVertices++
      }
    }
  }
  return { neckVertices, neckRadius, surface, sole, finiteSurface }
}

function waistFaces(mesh: SkinnedMesh, y: number, z: number): number[][] {
  const index = mesh.geometry.index
  if (!index) {
    throw new Error('Missing drawn belt triangles')
  }
  const material = mesh.geometry.getAttribute('styMat')
  const faces: number[][] = []
  for (let i = 0; i < index.count; i += 3) {
    const face = [index.getX(i), index.getX(i + 1), index.getX(i + 2)]
    if (!face.every((vertex) => Math.abs(material.getY(vertex) - FABRIC.leather.rim) < 1e-6)) {
      continue
    }
    const [a, b, c] = face.map((vertex) =>
      mesh.getVertexPosition(vertex, new Vector3()).applyMatrix4(mesh.matrixWorld),
    )
    if (!(a && b && c)) {
      continue
    }
    const center = a.clone().add(b).add(c).divideScalar(3)
    const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize()
    if (
      Math.abs(center.x) < 0.08 &&
      Math.abs(center.y - y) < 0.015 &&
      center.z > z + 0.02 &&
      normal.z > 0.6
    ) {
      faces.push(face)
    }
  }
  return faces
}

function waistVertices(mesh: SkinnedMesh, beltY: number): number[] {
  const material = mesh.geometry.getAttribute('styMat')
  return [...new Set(mesh.geometry.index?.array ?? [])].filter((vertex) => {
    const point = mesh.getVertexPosition(vertex, new Vector3()).applyMatrix4(mesh.matrixWorld)
    return (
      Math.abs(material.getY(vertex) - FABRIC.denim.rim) < 1e-6 &&
      point.y > beltY + 0.025 &&
      point.y < beltY + 0.17
    )
  })
}

function trunkFace(mesh: SkinnedMesh, vertices: number[]): boolean {
  const indices = mesh.geometry.getAttribute('skinIndex')
  const weights = mesh.geometry.getAttribute('skinWeight')
  return vertices.every((vertex) => {
    let trunk = 0
    for (let slot = 0; slot < 4; slot++) {
      const bone = boneKey(mesh.skeleton.bones[indices.getComponent(vertex, slot)]?.name ?? '')
      if (['Hips', 'Abdomen', 'Torso', 'Chest'].includes(bone)) {
        trunk += weights.getComponent(vertex, slot)
      }
    }
    return trunk > 0.5
  })
}
