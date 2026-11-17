/** Plan bounded native fills of the original male chin and anterior-throat fans. */
import type { Document, Primitive } from '@gltf-transform/core'
import { Mat4, Vec3 } from 'playcanvas'
import family from './head-throat-family.json' with { type: 'json' }
import constrained from './head-throat-recipes.json' with { type: 'json' }

export const THROAT_CONSTRAINED_RECIPES = constrained.recipes
export function constrainedThroatRecipe(id: string) {
  return THROAT_CONSTRAINED_RECIPES.find((recipe) => recipe.id === id)
}

export const THROAT_PROOF_IDS = family.acceptedProofIDs
export const THROAT_BODY_IDS = family.bodyIDs
export const THROAT_CONTROL_IDS = family.geometryControls
export const THROAT_GEOMETRY_IDS = THROAT_BODY_IDS.filter((id) => !THROAT_CONTROL_IDS.includes(id))
export const THROAT_NORMAL_IDS = THROAT_BODY_IDS.filter((id) => !family.normalControls.includes(id))
export function throatRecipe(id: string): 'merged' | 'split' {
  if (!THROAT_GEOMETRY_IDS.includes(id)) {
    throw new Error('Anterior jaw geometry excludes healthy controls and unknown sources')
  }
  return family.splitFanIDs.includes(id) ? 'split' : 'merged'
}
export interface ThroatFan {
  interior: number[]
  removeTriangles: number[]
  boundary: number[]
  constrainedDiagonals?: number[][]
  triangles?: number[][]
}
const CHIN = { interior: [495, 503, 504, 506], triangles: 17, boundary: 11 }
const FANS = [
  CHIN,
  { interior: [19, 21, 23, 25], triangles: 18, boundary: 12 },
  { interior: [30, 32, 34, 36], triangles: 18, boundary: 12 },
]

export function planHeadThroat(doc: Document, id: string) {
  const recipe = throatRecipe(id)
  const node = doc
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === 'Character' && n.getSkin())
  const surface = node?.getMesh()?.listPrimitives()[0]
  const head = (
    node?.getExtras().pieceRanges as { start: number; count: number }[] | undefined
  )?.[0]
  if (!(surface && head?.start === 0 && head.count === 1555)) {
    throw new Error('Unsupported canonical anterior jaw topology')
  }
  const chin = family.chinFanOverrides[id as keyof typeof family.chinFanOverrides] ?? CHIN
  const throat =
    recipe === 'merged'
      ? [{ interior: [19, 21, 23, 25, 27, 30, 32, 34, 36], triangles: 38, boundary: 22 }]
      : FANS.slice(1)
  const constrainedRecipe = constrainedThroatRecipe(id)
  const fans = constrainedRecipe
    ? constrainedRecipe.fans.map((fan) => ({
        interior: fan.interior,
        triangles: fan.removeOriginalPrimitiveTriangles.length,
        boundary: fan.boundary.length,
      }))
    : [chin, ...throat]
  const skin = node?.getSkin()
  const headJoint = skin?.listJoints().findIndex((joint) => joint.getName() === 'Head')
  const inverseBind = skin?.getInverseBindMatrices()
  const position = surface.getAttribute('POSITION')
  if (!(inverseBind && position && headJoint !== undefined && headJoint >= 0)) {
    throw new Error('Missing canonical Head coordinate system')
  }
  const bind = new Mat4().set(inverseBind.getElement(headJoint, []))
  const points = Array.from({ length: head.count }, (_, i) =>
    bind.transformPoint(new Vec3(...position.getElement(i, []))),
  )
  const scale = Math.max(...points.map((p) => p.y)) / 0.199_726_505_927_274_6
  for (const point of points) {
    point.divScalar(scale)
  }
  const frontVertices = points.flatMap((p, i) =>
    Math.abs(p.x) < 0.055 && p.y < 0.005 && p.y > -0.07 && p.z > 0.015 ? [i] : [],
  )
  const plannedFans = fans.map((fan, index) => {
    const planned = planFan(surface, head.count, fan)
    const fixed = constrainedRecipe?.fans[index]
    if (fixed) {
      if (
        JSON.stringify(planned.boundary) !== JSON.stringify(fixed.boundary) ||
        JSON.stringify(planned.removeTriangles) !==
          JSON.stringify([...fixed.removeOriginalPrimitiveTriangles].sort((a, b) => a - b))
      ) {
        throw new Error(`Constrained anterior fan no longer matches canonical topology: ${id}`)
      }
      const candidate = {
        ...planned,
        constrainedDiagonals: fixed.constrainedDiagonals,
        triangles: fixed.triangles,
      }
      validateConstrainedThroatFan(surface, candidate)
      return candidate
    }
    return planned
  })
  const shape = anteriorMetrics(
    surface,
    points,
    new Set(frontVertices),
    new Set(plannedFans.flatMap((fan) => fan.removeTriangles)),
  )
  if (
    shape.unownedFolds > 0 ||
    shape.maxDihedral <= 120 ||
    shape.vertex27MaxDihedral > 120 !== (recipe === 'merged')
  ) {
    throw new Error(`Anterior jaw recipe no longer matches this source's measured folds: ${id}`)
  }
  const edits = (family.positionHeadYEdits as Record<string, Record<string, number>>)[id] ?? {}
  const toSource = bind.clone().invert()
  const positionEdits = Object.entries(edits).map(([index, deltaY]) => {
    const sourceVertex = Number(index)
    const before = points[sourceVertex]
    if (id !== 'outlaw-15' || ![83, 84].includes(sourceVertex) || !before) {
      throw new Error('Unknown anterior position edit')
    }
    const target = before.clone()
    target.y += deltaY
    return {
      sourceVertex,
      normalizedHeadDelta: [0, deltaY, 0],
      sourcePosition: position.getElement(sourceVertex, []),
      sourceTarget: new Vec3(...position.getElement(sourceVertex, []))
        .add(toSource.transformVector(new Vec3(0, deltaY * scale, 0)))
        .toArray(),
      normalizedHeadBefore: before.toArray(),
      normalizedHeadTarget: target.toArray(),
    }
  })
  return {
    recipe,
    positionEdits,
    headScale: scale,
    headInverseBind: Array.from(bind.data),
    fans: plannedFans,
    frontVertices,
    shape,
  }
}

function anteriorMetrics(
  surface: Primitive,
  points: Vec3[],
  front: Set<number>,
  removed: Set<number>,
) {
  const indices = surface.getIndices()
  if (!indices) {
    throw new Error('Missing anterior jaw source indices')
  }
  const edges = new Map<string, { ids: number[]; normal: Vec3; triangle: number }[]>()
  const key = (i: number) => {
    const point = points[i]
    if (!point) {
      throw new Error('Anterior jaw edge has an invalid source vertex')
    }
    return point
      .toArray()
      .map((v) => v.toFixed(7))
      .join(',')
  }
  for (let t = 0; t < indices.getCount(); t += 3) {
    const ids = [0, 1, 2].map((corner) => indices.getScalar(t + corner))
    if (!ids.every((i) => i < points.length)) {
      continue
    }
    const [a, b, c] = ids.map((i) => points[i])
    if (!(a && b && c)) {
      throw new Error('Missing anterior jaw source point')
    }
    const normal = new Vec3().cross(b.clone().sub(a), c.clone().sub(a)).normalize()
    for (let k = 0; k < 3; k++) {
      const edge = [key(ids[k] ?? -1), key(ids[(k + 1) % 3] ?? -1)]
        .sort((left, right) => left.localeCompare(right))
        .join('|')
      edges.set(edge, [...(edges.get(edge) ?? []), { ids, normal, triangle: t / 3 }])
    }
  }
  let maxDihedral = 0
  let vertex27MaxDihedral = 0
  let unownedFolds = 0
  for (const pair of edges.values()) {
    if (pair.length !== 2 || !pair.every((f) => f.ids.every((i) => front.has(i)))) {
      continue
    }
    const a = pair[0]
    const b = pair[1]
    if (!(a && b)) {
      continue
    }
    const angle = (Math.acos(Math.max(-1, Math.min(1, a.normal.dot(b.normal)))) * 180) / Math.PI
    maxDihedral = Math.max(maxDihedral, angle)
    if (angle > 120 && pair.every((face) => !removed.has(face.triangle))) {
      unownedFolds++
    }
    if (pair.some((f) => f.ids.includes(27))) {
      vertex27MaxDihedral = Math.max(vertex27MaxDihedral, angle)
    }
  }
  return { maxDihedral, vertex27MaxDihedral, unownedFolds }
}

function planFan(
  surface: Primitive,
  count: number,
  expected: { interior: number[]; triangles: number; boundary: number },
): ThroatFan {
  const position = surface.getAttribute('POSITION')
  const indices = surface.getIndices()
  if (!(position && indices)) {
    throw new Error('Missing canonical anterior jaw mesh')
  }
  const removeTriangles: number[] = []
  const edges = new Map<string, { count: number; directed: [number, number] }>()
  for (let triangle = 0; triangle < indices.getCount() / 3; triangle++) {
    const face = [0, 1, 2].map((c) => indices.getScalar(triangle * 3 + c))
    if (!face.some((i) => expected.interior.includes(i))) {
      continue
    }
    if (face.some((i) => i >= count)) {
      throw new Error('Anterior jaw ownership crossed the head boundary')
    }
    removeTriangles.push(triangle)
    for (let c = 0; c < 3; c++) {
      const a = face[c]
      const b = face[(c + 1) % 3]
      if (a === undefined || b === undefined) {
        throw new Error('Missing anterior jaw edge')
      }
      const key = [a, b].sort((left, right) => left - right).join(',')
      const edge = edges.get(key)
      edges.set(key, { count: (edge?.count ?? 0) + 1, directed: [a, b] })
    }
  }
  const boundaryEdges = [...edges.values()].filter((edge) => edge.count === 1)
  if (removeTriangles.length !== expected.triangles || boundaryEdges.length !== expected.boundary) {
    throw new Error('Canonical anterior jaw fan inventory changed')
  }
  const boundary = orderedBoundary(
    boundaryEdges.map((edge) => edge.directed),
    expected.boundary,
  )
  for (const index of expected.interior) {
    const point = position.getElement(index, [])
    for (let other = 0; other < count; other++) {
      if (other !== index && position.getElement(other, []).every((v, k) => v === point[k])) {
        throw new Error('Anterior jaw interior unexpectedly reaches a UV seam')
      }
    }
  }
  return { interior: [...expected.interior], removeTriangles, boundary }
}

function orderedBoundary(edges: [number, number][], count: number): number[] {
  const next = new Map(edges)
  const first = Math.min(...next.keys())
  const boundary = [first]
  let current = next.get(first)
  while (current !== first && current !== undefined && boundary.length <= next.size) {
    boundary.push(current)
    current = next.get(current)
  }
  if (current !== first || boundary.length !== count || new Set(boundary).size !== count) {
    throw new Error('Anterior jaw requires one fixed boundary loop per fan')
  }
  return boundary
}

/** Validate source-authored diagonals; never search for a triangulation here. */
export function validateConstrainedThroatFan(surface: Primitive, fan: ThroatFan): void {
  throatRegionInteriors(surface, fan)
  const triangles = fan.triangles
  const diagonals = fan.constrainedDiagonals
  const uv = surface.getAttribute('TEXCOORD_0')
  const index = surface.getIndices()
  if (
    !(triangles && diagonals && uv && index) ||
    triangles.length !== fan.boundary.length - 2 ||
    diagonals.length !== fan.boundary.length - 3
  ) {
    throw new Error('Incomplete constrained anterior fan')
  }
  const key = (a: number, b: number) => [a, b].sort((left, right) => left - right).join(',')
  const edges = new Map<string, number[][]>()
  const unique = new Set<string>()
  const area = (face: number[]) => {
    const [a, b, c] = face.map((i) => uv.getElement(i, []))
    if (!(a && b && c)) {
      throw new Error('Missing constrained UV donor')
    }
    return (
      (((b[0] ?? 0) - (a[0] ?? 0)) * ((c[1] ?? 0) - (a[1] ?? 0)) -
        ((b[1] ?? 0) - (a[1] ?? 0)) * ((c[0] ?? 0) - (a[0] ?? 0))) /
      2
    )
  }
  for (const triangle of triangles) {
    const triangleKey = [...triangle].sort((a, b) => a - b).join(',')
    if (
      triangle.length !== 3 ||
      new Set(triangle).size !== 3 ||
      triangle.some((i) => !fan.boundary.includes(i)) ||
      unique.has(triangleKey) ||
      area(triangle) >= -1e-12
    ) {
      throw new Error('Invalid constrained anterior UV triangle')
    }
    unique.add(triangleKey)
    for (let k = 0; k < 3; k++) {
      const a = triangle[k] ?? -1
      const b = triangle[(k + 1) % 3] ?? -1
      const edge = key(a, b)
      edges.set(edge, [...(edges.get(edge) ?? []), [a, b]])
    }
  }
  validateConstrainedEdges(edges, fan.boundary, diagonals)
  const before = fan.removeTriangles.reduce(
    (sum, t) => sum + area([0, 1, 2].map((c) => index.getScalar(t * 3 + c))),
    0,
  )
  const after = triangles.reduce((sum, face) => sum + area(face), 0)
  if (Math.abs(before - after) > 1e-12) {
    throw new Error('Constrained fan changed source UV coverage')
  }
}

function validateConstrainedEdges(
  edges: Map<string, number[][]>,
  boundaryVertices: number[],
  diagonals: number[][],
): void {
  const key = (a: number, b: number) => [a, b].sort((left, right) => left - right).join(',')
  const expectedBoundary = new Map(
    boundaryVertices.map((a, k) => [
      key(a, boundaryVertices[(k + 1) % boundaryVertices.length] ?? -1),
      [a, boundaryVertices[(k + 1) % boundaryVertices.length]],
    ]),
  )
  const internal: string[] = []
  for (const [edge, pair] of edges) {
    const boundary = expectedBoundary.get(edge)
    if (boundary) {
      if (pair.length !== 1 || JSON.stringify(pair[0]) !== JSON.stringify(boundary)) {
        throw new Error('Constrained fan changed its directed UV boundary')
      }
      expectedBoundary.delete(edge)
    } else {
      if (pair.length !== 2 || pair[0]?.[0] !== pair[1]?.[1] || pair[0]?.[1] !== pair[1]?.[0]) {
        throw new Error('Constrained fan has an invalid internal edge')
      }
      internal.push(edge)
    }
  }
  if (
    expectedBoundary.size > 0 ||
    JSON.stringify(internal.sort((a, b) => a.localeCompare(b))) !==
      JSON.stringify(
        diagonals.map(([a, b]) => key(a ?? -1, b ?? -1)).sort((a, b) => a.localeCompare(b)),
      )
  ) {
    throw new Error('Constrained native diagonals do not match the triangle graph')
  }
}

/** The declared dissolve stencil can enclose another vertex without new ownership. */
export function throatRegionInteriors(surface: Primitive, fan: ThroatFan): number[] {
  const indices = surface.getIndices()
  if (!indices) {
    throw new Error('Missing constrained region indices')
  }
  const owned = new Set(fan.removeTriangles)
  const region = new Set<number>()
  for (const triangle of owned) {
    for (let corner = 0; corner < 3; corner++) {
      region.add(indices.getScalar(triangle * 3 + corner))
    }
  }
  const enclosed = [...region]
    .filter((vertex) => !fan.boundary.includes(vertex))
    .sort((a, b) => a - b)
  if (fan.interior.some((vertex) => !enclosed.includes(vertex))) {
    throw new Error('Declared stencil leaves its owned region')
  }
  for (let t = 0; t < indices.getCount(); t += 3) {
    if (!owned.has(t / 3) && [0, 1, 2].some((c) => enclosed.includes(indices.getScalar(t + c)))) {
      throw new Error('Constrained region interior has an unowned incident face')
    }
  }
  return enclosed
}
