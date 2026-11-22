/** Add missing timber under the recessed passenger gable and against the Express roof plate. */
import { resolve } from 'node:path'
import {
  type Document,
  type Node,
  NodeIO,
  type Primitive,
  type vec3,
  type vec4,
} from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { Mat4, Vec3 } from 'playcanvas'

export const DEPOT_ROOF_TIMBER = [
  'Depot roof passenger gable lining',
  'Depot roof Express frieze',
] as const

interface Sample {
  position: vec3
  uv: [number, number]
  color: vec4
}

function surface(document: Document, name: string): [Node, Primitive] {
  const node = document
    .getRoot()
    .listNodes()
    .find((entry) => entry.getName() === name)
  const parts = node?.getMesh()?.listPrimitives()
  const part = parts?.[0]
  if (!(node && part) || parts.length !== 1 || !part.getMaterial()) {
    throw new Error(`Missing Depot wood material on ${name}`)
  }
  return [node, part]
}

function sample([node, part]: [Node, Primitive], anchor: vec3, normal: Vec3): Sample {
  const position = part.getAttribute('POSITION')
  const uv = part.getAttribute('TEXCOORD_0')
  const colors = part.getAttribute('COLOR_0')
  const normalStream = part.getAttribute('NORMAL')
  if (!(position && uv && colors && normalStream)) {
    throw new Error('Depot timber donors need authored positions, UVs, colors and normals')
  }
  const toWorld = new Mat4().set(node.getWorldMatrix())
  const target = new Vec3().fromArray(anchor)
  const point = new Vec3()
  const direction = new Vec3()
  for (let i = 0; i < position.getCount(); i++) {
    toWorld.transformPoint(point.fromArray(position.getElement(i, [])), point)
    if (point.distance(target) > 0.018) {
      continue
    }
    toWorld.transformVector(direction.fromArray(normalStream.getElement(i, [])), direction)
    if (direction.normalize().dot(normal) < 0.97) {
      continue
    }
    const color = colors.getElement(i, [1, 1, 1, 1]) as vec4
    return {
      position: [point.x, point.y, point.z],
      uv: uv.getElement(i, [0, 0]) as [number, number],
      color,
    }
  }
  throw new Error(`Missing Depot wood sample near ${anchor.join(', ')}`)
}

function board(
  document: Document,
  name: string,
  donor: Primitive,
  corners: readonly Sample[],
): void {
  const [a, b, c] = corners
  const material = donor.getMaterial()
  const buffer = donor.getAttribute('POSITION')?.getBuffer()
  const scene = document.getRoot().listScenes()[0]
  if (!(a && b && c) || corners.length !== 4 || !(material && buffer && scene)) {
    throw new Error(`Incomplete Depot timber board ${name}`)
  }
  const origin = new Vec3().fromArray(a.position)
  const ab = new Vec3().fromArray(b.position).sub(origin)
  const ac = new Vec3().fromArray(c.position).sub(origin)
  const { x, y, z } = new Vec3().cross(ab, ac).normalize()
  const accessor = (type: 'VEC2' | 'VEC3' | 'VEC4', values: number[]) =>
    document.createAccessor().setType(type).setArray(Float32Array.from(values)).setBuffer(buffer)
  const primitive = document
    .createPrimitive()
    .setMaterial(material)
    .setIndices(
      document
        .createAccessor()
        .setType('SCALAR')
        .setArray(new Uint16Array([0, 1, 2, 0, 2, 3]))
        .setBuffer(buffer),
    )
    .setAttribute(
      'POSITION',
      accessor(
        'VEC3',
        corners.flatMap((corner) => corner.position),
      ),
    )
    .setAttribute(
      'NORMAL',
      accessor(
        'VEC3',
        corners.flatMap(() => [x, y, z]),
      ),
    )
    .setAttribute(
      'TEXCOORD_0',
      accessor(
        'VEC2',
        corners.flatMap((corner) => corner.uv),
      ),
    )
    .setAttribute(
      'COLOR_0',
      accessor(
        'VEC4',
        corners.flatMap((corner) => corner.color),
      ),
    )
    .setAttribute(
      'TEXCOORD_1',
      accessor(
        'VEC2',
        corners.flatMap(({ position: [wx, , wz] }) => [wx / 1024, wz / 1024]),
      ),
    )
  scene.addChild(
    document.createNode(name).setMesh(document.createMesh(name).addPrimitive(primitive)),
  )
}

export function installDepotRoofTimber(document: Document): void {
  if (
    document
      .getRoot()
      .listNodes()
      .some((node) => DEPOT_ROOF_TIMBER.some((name) => name === node.getName()))
  ) {
    throw new Error('Depot roof timber is already installed')
  }
  const trim = surface(document, 'trim-1')
  const soffit = sample(trim, [9.3, 3.43, -2.6], new Vec3(0.173, -0.985, 0))
  // The gable wall is recessed by 0.6 m. Carry the exposed far roof lining back to that wall.
  const lining: vec3[] = [
    [16.5, 6.975, -2.6],
    [20.6, 3.695, -2.6],
    [20.6, 3.695, -1.979],
    [16.5, 6.975, -1.979],
  ]
  board(
    document,
    DEPOT_ROOF_TIMBER[0],
    trim[1],
    lining.map((position) => ({
      position,
      uv: [position[2] / 1.6, position[0] / 1.6],
      color: soffit.color,
    })),
  )

  const walls = surface(document, 'walls-0')
  const south = sample(walls, [-16, 4.8, -14], Vec3.RIGHT)
  const north = sample(walls, [-16, 4.8, 4], Vec3.RIGHT)
  // Continue the wall's courses up to the roof plate while keeping the loading canopy below open.
  const corner = ({ position: [, base, end], uv, color }: Sample, height: number): Sample => ({
    position: [-15.996, height, end],
    uv: [uv[0], uv[1] + (height - base) / 1.9],
    color,
  })
  board(document, DEPOT_ROOF_TIMBER[1], walls[1], [
    corner(south, 4.793),
    corner(south, 5.007),
    corner(north, 5.007),
    corner(north, 4.793),
  ])
}

if (import.meta.main) {
  const [input, output] = process.argv.slice(2)
  if (!(input && output) || resolve(input) === resolve(output)) {
    throw new Error('Supply a native Depot input GLB and a separate staged output GLB')
  }
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const document = await io.read(input)
  installDepotRoofTimber(document)
  await io.write(output, document)
}
