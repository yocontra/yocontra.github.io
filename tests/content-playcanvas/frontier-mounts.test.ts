import { expect, test as it } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { Vec3 } from 'playcanvas'
import published from '../../src/experiments/out-west/content/collision.json' with { type: 'json' }
import { buildingSideRect } from '../../src/experiments/out-west/ffa/sim/building-rules.ts'
import { TOWN } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { frontOf } from '../../src/experiments/out-west/ffa/sim/porches.ts'
import { type Point, rayHit } from '../../tools/content/freight-crates-contract.ts'
import { porchFasciaSignMount, porchSignMount } from '../../tools/content/frontier-architecture.ts'
import { compileFrontierCollision } from '../../tools/content/frontier-collision.ts'
import { hangingLampSites } from '../../tools/content/frontier-hanging-lamps.ts'
import {
  type FrontierMount,
  frontierMounts,
  groupFrontierMounts,
  lampBracket,
} from '../../tools/content/frontier-mounts.ts'
import { appendFrontierMounts, readMountGlb } from '../../tools/content/frontier-mounts-install.ts'
import { FRONTIER_IRON } from '../../tools/content/frontier-surfaces.ts'
import { appendFixture, ironStreams } from './frontier-mounts-fixture.ts'

const members = frontierMounts(TOWN)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read('tools/art/environments/frontier.glb')
const propPrefix = 'Perdition dressed interiors and purposeful cover:'
function faces(member: Pick<FrontierMount, 'positions' | 'indices'>): Point[][] {
  return Array.from({ length: member.indices.length / 3 }, (_, face) =>
    [0, 1, 2].map((corner) => {
      const index = member.indices[face * 3 + corner] ?? 0
      return member.positions.slice(index * 3, index * 3 + 3) as Point
    }),
  )
}
function sceneFaces(name: string, source = doc): Point[][] {
  const result: Point[][] = []
  for (const node of source
    .getRoot()
    .listNodes()
    .filter((n) => n.getName() === name)) {
    const matrix = node.getWorldMatrix()
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const positions = primitive.getAttribute('POSITION')
      const indices = primitive.getIndices()
      if (!(positions && indices)) {
        continue
      }
      const world = Array.from({ length: positions.getCount() }, (_, i): Point => {
        const [x = 0, y = 0, z = 0] = positions.getElement(i, [] as number[])
        return [
          matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
          matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
          matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
        ]
      })
      for (let i = 0; i < indices.getCount(); i += 3) {
        result.push([0, 1, 2].map((k) => world[indices.getScalar(i + k)] as Point))
      }
    }
  }
  return result
}
function contactOverlap(a: Point[][], b: Point[][], point: Point, direction: Point): number | null {
  // Only A is a verified single closed member. Never envelope hits on a merged scene mesh.
  const projection = (p: Point) =>
    p.reduce((sum, value, axis) => sum + value * (direction[axis] ?? 0), 0)
  const start = Math.min(Math.min(...a.flat().map(projection)) - projection(point) - 0.01, -0.07)
  const origin = point.map((value, axis) => value + (direction[axis] ?? 0) * start) as Point
  const crossings = (triangles: Point[][]) =>
    triangles
      .flatMap((triangle) => {
        const hit = rayHit([triangle], origin, direction)
        return hit === null ? [] : [hit]
      })
      .sort((left, right) => left - right)
      .filter((hit, i, all) => i === 0 || hit - (all[i - 1] ?? 0) > 1e-7)
  // From outside the closed member, paired crossings are its occupied intervals, including holes.
  const hits = crossings(a)
  if (hits.length % 2 !== 0) {
    return null
  }
  const surfaces = crossings(b).filter((hit) => Math.abs(hit + start) <= 0.06)
  if (!(hits.length > 0 && surfaces.length > 0)) {
    return null
  }
  let overlap = Number.NEGATIVE_INFINITY
  for (let i = 0; i < hits.length; i += 2) {
    const lo = hits[i]
    const hi = hits[i + 1]
    if (lo === undefined || hi === undefined) {
      throw new Error('Unpaired member crossing')
    }
    for (const hit of surfaces) {
      overlap = Math.max(overlap, Math.min(hit - lo, hi - hit))
    }
  }
  return overlap
}
function contacts(a: Point[][], b: Point[][], origin: Point, direction: Point): boolean {
  const overlap = contactOverlap(a, b, origin, direction)
  return overlap !== null && overlap >= -0.001
}
function patchContacts(a: Point[][], b: Point[][], point: Point, direction: Point): boolean {
  const first = direction[0] === 0 ? 0 : 1
  return [-0.002, 0, 0.002].every((u) =>
    [-0.002, 0, 0.002].every((v) => {
      const sample = point.map((value, axis) => {
        if (direction[axis]) {
          return value
        }
        return value + (axis === first ? u : v)
      }) as Point
      return contacts(a, b, sample, direction)
    }),
  )
}
const part = (id: string) => {
  const member = members.find((m) => m.id === id)
  if (!member) {
    throw new Error(`Missing mount ${id}`)
  }
  return faces(member)
}
const wood = sceneFaces(`${propPrefix}wood-mesh`)
const iron = sceneFaces(`${propPrefix}iron-mesh`)
const floor = sceneFaces(`${propPrefix}floor-mesh`)

it('shares all new collision triangles and retains every original collider unchanged', () => {
  const collision = compileFrontierCollision(TOWN)
  expect(JSON.stringify(collision.boxes)).toBe(JSON.stringify(published.boxes))
  // Mesh.setPositions stores Float32 positions before Ammo reads them. Compare those exact
  // native values: platform libm implementations can differ in the last double-precision bit.
  const originalMeshes = (meshes: typeof collision.meshes) =>
    meshes
      .filter((m) => !m.id.startsWith('mount:'))
      .map((m) => ({ ...m, positions: new Float32Array(m.positions) }))
  expect(originalMeshes(collision.meshes)).toEqual(originalMeshes(published.meshes))
  expect(collision.meshes.filter((m) => m.id.startsWith('mount:'))).toEqual(
    groupFrontierMounts(members).map(({ id, positions, indices }) => ({ id, positions, indices })),
  )
  expect(members.filter((m) => m.id.endsWith(':eye')).length).toBe(24)
  expect(members.filter((m) => m.family === 'bank').length).toBe(8)
})

function solidEdges(member: Pick<FrontierMount, 'positions' | 'indices'>) {
  const edges = new Map<string, { forward: number; backward: number }>()
  const neighbours = new Map<string, Set<string>>()
  let minimumArea = Number.POSITIVE_INFINITY
  let volume = 0
  for (const triangle of faces(member)) {
    const [a, b, c] = triangle.map((p) => new Vec3().fromArray(p))
    if (!(a && b && c)) {
      throw new Error('Missing solid triangle')
    }
    minimumArea = Math.min(
      minimumArea,
      new Vec3().cross(b.clone().sub(a), c.clone().sub(a)).length(),
    )
    volume += a.dot(new Vec3().cross(b, c)) / 6
    for (const [u, v] of [
      [triangle[0], triangle[1]],
      [triangle[1], triangle[2]],
      [triangle[2], triangle[0]],
    ]) {
      if (!(u && v)) {
        throw new Error('Missing solid edge')
      }
      const from = u.join(',')
      const to = v.join(',')
      const sorted = [from, to].sort((left, right) => left.localeCompare(right))
      const key = sorted.join('|')
      const count = edges.get(key) ?? { forward: 0, backward: 0 }
      if (from === sorted[0]) {
        count.forward++
      } else {
        count.backward++
      }
      edges.set(key, count)
      const connected = neighbours.get(from) ?? new Set<string>()
      connected.add(to)
      neighbours.set(from, connected)
    }
  }
  const stack = [neighbours.keys().next().value as string]
  const visited = new Set<string>()
  while (stack.length > 0) {
    const vertex = stack.pop()
    if (vertex && !visited.has(vertex)) {
      visited.add(vertex)
      stack.push(...(neighbours.get(vertex) ?? []))
    }
  }
  return {
    minimumArea,
    volume,
    connected: visited.size === neighbours.size,
    directed: [...edges.values()].every((e) => e.forward === 1 && e.backward === 1),
  }
}

it('each Float32 member is one closed outward solid with opposite directed halfedges', () => {
  for (const member of members) {
    const solid = solidEdges(member)
    expect(solid.minimumArea, member.id).toBeGreaterThan(1e-14)
    expect(solid.directed, member.id).toBe(true)
    expect(solid.connected, member.id).toBe(true)
    expect(solid.volume, member.id).toBeGreaterThan(0)
  }
  const member = members[0]
  if (!member) {
    throw new Error('Missing closure control')
  }
  const indices = [...member.indices]
  indices.splice(0, 2, ...indices.slice(0, 2).reverse())
  expect(solidEdges({ ...member, indices }).directed).toBe(false)
})

it('hanger shoes touch actual board timber, porch soffits or connected wall brackets', () => {
  for (const building of TOWN.buildings) {
    const hangs = members.filter((m) => m.owner === building.id && m.id.endsWith(':board-shoe'))
    const porch = sceneFaces('ground-Perdition:floor-mesh')
    for (const shoe of hangs) {
      const x = building.x + 0.75
      const zs = shoe.positions.filter((_v, i) => i % 3 === 2)
      const z = (Math.min(...zs) + Math.max(...zs)) / 2
      expect(patchContacts(faces(shoe), wood, [x, 2.95, z], [0, 1, 0]), shoe.id).toBe(true)
      const stem = shoe.id.replace(':board-shoe', '')
      expect(patchContacts(faces(shoe), part(`${stem}:eye`), [x, 2.95, z], [0, 0, 1]), stem).toBe(
        true,
      )
      const upper = part(`${stem}:upper-shoe`)
      const support = members.some((m) => m.id === `mount:${building.id}:arm`)
        ? part(`mount:${building.id}:arm`)
        : porch
      expect(
        patchContacts(
          upper,
          support,
          [x, support === porch ? 3.04 : 3.09, z],
          support === porch ? [0, 1, 0] : [1, 0, 0],
        ),
        stem,
      ).toBe(true)
      const y = support === porch ? 3.04 : 3.09
      expect(patchContacts(upper, part(`${stem}:eye`), [x, y, z], [0, 0, 1])).toBe(true)
    }
  }
})

function facade(building: string) {
  return ['wood', 'stone', `siding:${building}`].flatMap((role) =>
    sceneFaces(`building-${building}:${role}-mesh`),
  )
}

it('three triangular brackets are anchored in actual solid facade timber/masonry', () => {
  for (const building of TOWN.buildings.filter((b) =>
    ['livery', 'church', 'depot'].includes(b.id),
  )) {
    const wall = building.z + building.d
    expect(
      patchContacts(
        part(`mount:${building.id}:wall-plate`),
        facade(building.id),
        [building.x + 0.75, 3.34, wall],
        [0, 0, 1],
      ),
      building.id,
    ).toBe(true)
  }
})

it('all eleven iron brackets seat on the facade and their hooks hold the authored bails', async () => {
  const native = await io.read('public/experiments/out-west/3d/native-v2/baked/frontier.glb')
  const key = (triangle: Point[]) =>
    triangle
      .map((point) => point.join(','))
      .sort((left, right) => left.localeCompare(right))
      .join('|')
  const bails = sceneFaces('lamp-bail')
  const sites = hangingLampSites(TOWN)
  expect(sites).toHaveLength(11)
  for (const { x, face, direction, owner } of sites) {
    const z = face + direction * 0.225
    const support = lampBracket(owner, x, face, direction)
    const hook = support.find(({ id }) => id.endsWith(':lamp-hook'))
    const plate = support.find(({ id }) => id.endsWith(':lamp-wall-plate'))
    if (!(hook && plate)) {
      throw new Error(`Missing bracket member for ${owner}`)
    }
    const group = owner === 'livery' ? 'Perdition structural iron' : 'Frontier lantern bracket'
    for (const source of [doc, native]) {
      const actual = new Set(sceneFaces(`${group}:${owner}:iron-mesh`, source).map(key))
      expect(
        [...faces(plate), ...faces(hook)].every((triangle) => actual.has(key(triangle))),
        owner,
      ).toBe(true)
    }
    const bail = bails.filter((triangle) =>
      triangle.every(([px, , pz]) => Math.abs(px - x) < 0.03 && Math.abs(pz - z) < 0.007),
    )
    expect(bail, owner).toHaveLength(192)
    expect(
      patchContacts(faces(plate), facade(owner), [x, 3.16, face], [0, 0, direction]),
      owner,
    ).toBe(true)
    const contactsAtRest = [-0.002, 0, 0.002].flatMap((dx) =>
      [2.848, 2.849, 2.85, 2.851].map((y) =>
        contactOverlap(faces(hook), bail, [x + dx, y, z], [0, 0, direction]),
      ),
    )
    expect(
      contactsAtRest.some((overlap) => overlap !== null && overlap >= -0.001),
      owner,
    ).toBe(true)
    const displacedBail = displaced(bail, 0, 0.06)
    expect(contacts(faces(hook), displacedBail, [x, 2.849, z], [0, 0, direction]), owner).toBe(
      false,
    )
  }
})

it('bank end feet meet actual counter/grille triangles while preserving central service shots', () => {
  for (const member of members.filter((m) => m.family === 'bank')) {
    const xs = member.positions.filter((_v, i) => i % 3 === 0)
    const x = (Math.min(...xs) + Math.max(...xs)) / 2
    expect(patchContacts(faces(member), floor, [x, 1.1, 68.84], [0, 1, 0]), member.id).toBe(true)
    expect(patchContacts(faces(member), iron, [x, 1.305, 68.84], [0, 0, 1]), member.id).toBe(true)
  }
  const feet = members.filter((m) => m.family === 'bank').flatMap(faces)
  for (const x of [37.6, 41.6, 48.6, 52.6]) {
    for (const along of [0.091, 0.45, 0.9, 1.35, 1.709]) {
      for (const y of [1.101, 1.2, 1.299]) {
        expect(rayHit(feet, [x + along, y, 68.3], [0, 0, 1])).toBeNull()
      }
    }
  }
})

function displaced(triangles: Point[][], axis: number, distance: number): Point[][] {
  return triangles.map((t) =>
    t.map((p) => p.map((v, i) => v + (i === axis ? distance : 0)) as Point),
  )
}

it('20mm displaced shoe and foot controls expose a real local gap', () => {
  const shoe = part('mount:saloon:hanger:0:board-shoe')
  const foot = part('mount:bank:grille:237:foot:0')
  const shoePoint: Point = [23.75, 2.95, 44.47]
  const footPoint: Point = [37.645, 1.1, 68.84]
  expect(patchContacts(shoe, wood, shoePoint, [0, 1, 0])).toBe(true)
  expect(contactOverlap(displaced(shoe, 1, 0.02), wood, shoePoint, [0, 1, 0]) ?? 0).toBeLessThan(
    -0.015,
  )
  expect(patchContacts(foot, floor, footPoint, [0, 1, 0])).toBe(true)
  expect(contactOverlap(displaced(foot, 1, 0.02), floor, footPoint, [0, 1, 0]) ?? 0).toBeLessThan(
    -0.019,
  )
})

it('all new members remain outside actual door/window opening volumes', () => {
  for (const building of TOWN.buildings) {
    const openings = [
      ...building.doors.map((d) => ({ ...d, y0: d.y0 ?? 0, y1: d.y1 })),
      ...(building.windows ?? []).map((w) => ({ ...w, y0: w.sill, y1: w.top })),
    ]
    for (const opening of openings) {
      const rect = buildingSideRect(building, opening.side, opening.at, opening.width)
      for (const member of members) {
        const xyz = [0, 1, 2].map((axis) => member.positions.filter((_v, i) => i % 3 === axis))
        const lo = xyz.map((a) => Math.min(...a))
        const hi = xyz.map((a) => Math.max(...a))
        const intersects =
          (lo[0] ?? 0) < rect.x + rect.w &&
          (hi[0] ?? 0) > rect.x &&
          (lo[2] ?? 0) < rect.z + rect.d &&
          (hi[2] ?? 0) > rect.z &&
          (lo[1] ?? 0) < (opening.y1 ?? 2.45) &&
          (hi[1] ?? 0) > opening.y0
        expect(intersects, `${member.id} / ${building.id}:${opening.side}:${opening.at}`).toBe(
          false,
        )
      }
    }
  }
})

it('raw appending preserves old packed streams/indices/metadata and adds only local iron/cloud UVs', async () => {
  const source = await appendFixture()
  const before = readMountGlb(source)
  const output = appendFrontierMounts(source, members, 'b'.repeat(64))
  const after = readMountGlb(output)
  expect(after.bin.subarray(0, before.bin.length)).toEqual(before.bin)
  expect(after.json.extras).toEqual({ ...before.json.extras, frontierSourceHash: 'b'.repeat(64) })
  const written = await io.readBinary(output)
  const added = written
    .getRoot()
    .listNodes()
    .filter((n) => n.getName().startsWith('Perdition structural iron:'))
  expect(added.length).toBe(12)
  for (const addedNode of added) {
    const streams = ironStreams(addedNode)
    expect(streams.material).toBe('Perdition iron')
    expect(streams.finite).toBe(true)
    expect(streams.matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    expect(streams.minimumNormalDot).toBeGreaterThan(0)
    expect(streams.maximumSpan).toBeLessThan(32)
    expect(streams.cloudExact).toBe(true)
  }
  expect(() => appendFrontierMounts(output, members)).toThrow('already installed')
  const restored = structuredClone(after.json)
  restored.nodes = restored.nodes.slice(0, before.json.nodes.length)
  restored.meshes = restored.meshes.slice(0, before.json.meshes.length)
  restored.accessors = restored.accessors.slice(0, before.json.accessors.length)
  restored.bufferViews = restored.bufferViews.slice(0, before.json.bufferViews.length)
  restored.buffers[0].byteLength = before.json.buffers[0].byteLength
  const index = before.json.materials.findIndex((m) => m.name === 'Perdition iron')
  expect(after.json.materials[index]?.pbrMetallicRoughness?.baseColorFactor).toEqual(
    FRONTIER_IRON.baseColor,
  )
  expect(after.json.materials[index]?.pbrMetallicRoughness?.metallicFactor).toBe(
    FRONTIER_IRON.metallic,
  )
  const oldIron = before.json.materials[index]
  if (!oldIron) {
    throw new Error('Missing fixture iron')
  }
  const pbr = restored.materials[index]?.pbrMetallicRoughness
  const oldPbr = oldIron.pbrMetallicRoughness
  if (!(pbr && oldPbr)) {
    throw new Error('Missing fixture PBR')
  }
  Reflect.deleteProperty(pbr, 'baseColorFactor')
  Reflect.deleteProperty(pbr, 'metallicFactor')
  if (oldPbr.baseColorFactor) {
    pbr.baseColorFactor = oldPbr.baseColorFactor
  }
  if (oldPbr.metallicFactor !== undefined) {
    pbr.metallicFactor = oldPbr.metallicFactor
  }

  const scene = restored.scenes[0]
  if (!scene) {
    throw new Error('Missing fixture scene')
  }
  scene.nodes = scene.nodes?.slice(0, before.json.scenes[0]?.nodes?.length) ?? []
  if (!before.json.extras) {
    throw new Error('Missing fixture extras')
  }
  restored.extras = before.json.extras
  expect(restored).toEqual(before.json)
})

it('the new Mercantile and Sheriff boards touch both actual rail tiers', () => {
  for (const id of ['general_store', 'jail']) {
    const building = TOWN.buildings.find((entry) => entry.id === id)
    const mount = building && porchSignMount(TOWN, building)
    if (!mount) {
      throw new Error(`Missing porch sign mount for ${id}`)
    }
    const board = sceneFaces(`building-${id}:wood-mesh`)
    const signFace = sceneFaces(`building-${id}:sign-mesh`).filter((triangle) =>
      triangle.every(([, , z]) => Math.abs(z - (mount.z - 0.001)) < 0.000_02),
    )
    expect(signFace).toHaveLength(2)
    for (const y of mount.fixingRows) {
      const contact: Point = [mount.x + mount.w / 2, y, mount.z + mount.d]
      expect(patchContacts(board, wood, contact, [0, 0, 1]), id).toBe(true)
    }
  }
})

it('the four fascia boards clear their porch roofs from player eye height', () => {
  const roofs = sceneFaces('ground-Perdition:wood-mesh')
  for (const id of ['assay', 'smithy', 'stage_line', 'undertaker']) {
    const building = TOWN.buildings.find((entry) => entry.id === id)
    const mount = building && porchFasciaSignMount(building, frontOf(building, TOWN))
    if (!mount) {
      throw new Error(`Missing sign at the porch edge for ${id}`)
    }
    const { x, z, d, w, facing } = mount
    const center = x + w / 2
    const face = facing === -1 ? z - 0.001 : z + d + 0.001
    const signFaces = sceneFaces(`building-${id}:sign-mesh`).filter((triangle) =>
      triangle.every(([, , depth]) => Math.abs(depth - face) < 0.000_02),
    )
    expect(signFaces, id).toHaveLength(2)
    const opaque = [...roofs, ...sceneFaces(`building-${id}:wood-mesh`)]
    const distance = id === 'undertaker' ? 1.2 : 7
    for (const offset of [-0.3, 0, 0.3]) {
      for (const y of [3.22, 3.49, 3.72]) {
        const eye: Point = [center + offset * w, 1.72, face + facing * distance]
        const line: Point = [0, y - eye[1], face - eye[2]]
        const firstWood = rayHit(opaque, eye, line)
        expect(rayHit(signFaces, eye, line), id).toBeCloseTo(1, 4)
        expect(firstWood, id).toBeGreaterThan(1)
      }
    }
  }
})

it('the Undertaker blade exposes a painted face from each alley approach', () => {
  const sign = sceneFaces('building-undertaker:sign-mesh')
  const opaque = [
    ...sceneFaces('building-undertaker:wood-mesh'),
    ...sceneFaces('ground-Perdition:wood-mesh'),
  ]
  for (const [eyeX, face] of [
    [34.3, 47.259],
    [50.45, 47.341],
  ] as const) {
    const eye: Point = [eyeX, 1.72, 79]
    const line: Point = [face - eye[0], 3.51 - eye[1], 79.2 - eye[2]]
    const paint = sign.filter((triangle) => triangle.every(([x]) => Math.abs(x - face) < 0.000_02))
    expect(paint).toHaveLength(2)
    expect(rayHit(paint, eye, line)).toBeCloseTo(1, 4)
    expect(rayHit(opaque, eye, line)).toBeGreaterThan(1)
  }
})
