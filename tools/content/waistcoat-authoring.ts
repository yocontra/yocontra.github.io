/** Blender authors cloth; this adapter preserves canonical skin IDs and the wool UV swatch. */
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { Document, NodeIO, type Primitive } from '@gltf-transform/core'
import type { Range } from './character-atlas.ts'

interface Garment {
  positions: number[][]
  normals: number[][]
  uvs: number[][]
  joints: number[][]
  weights: number[][]
  triangles: number[][]
  pieces: (Range & { tint: number[]; roughness: number })[]
}
const source = resolve('tools/art/characters')
const io = new NodeIO()
function swatch(primitive: Primitive, range: Range): { lo: number[]; hi: number[] } {
  const uv = primitive.getAttribute('TEXCOORD_0')
  if (!uv) {
    throw new Error('The original waistcoat requires its wool UV swatch')
  }
  const points = Array.from({ length: range.count }, (_, i) => uv.getElement(range.start + i, []))
  return {
    lo: [0, 1].map((c) => Math.min(...points.map((p) => p[c] ?? 0))),
    hi: [0, 1].map((c) => Math.max(...points.map((p) => p[c] ?? 0))),
  }
}
function surface(doc: Document, garment: Garment, original: Primitive, range: Range): Primitive {
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()
  const primitive = doc.createPrimitive()
  const { lo, hi } = swatch(original, range)
  const values: [string, number[][]][] = [
    ['POSITION', garment.positions],
    ['NORMAL', garment.normals],
    [
      'TEXCOORD_0',
      garment.uvs.map((uv) => uv.map((v, c) => (lo[c] ?? 0) + v * ((hi[c] ?? 1) - (lo[c] ?? 0)))),
    ],
    ['_AUTHOR_JOINTS', garment.joints],
    ['_AUTHOR_WEIGHTS', garment.weights],
  ]
  for (const [name, data] of values) {
    const type = ({ 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' } as const)[data[0]?.length ?? 0]
    if (!type) {
      throw new Error(`Invalid garment attribute ${name}`)
    }
    primitive.setAttribute(
      name,
      doc
        .createAccessor()
        .setBuffer(buffer)
        .setType(type)
        .setArray(
          name === '_AUTHOR_JOINTS'
            ? Uint16Array.from(data.flat())
            : Float32Array.from(data.flat()),
        ),
    )
  }
  primitive.setIndices(
    doc
      .createAccessor()
      .setBuffer(buffer)
      .setType('SCALAR')
      .setArray(Uint32Array.from(garment.triangles.flat())),
  )
  primitive.setExtras({
    pieceRanges: garment.pieces.map((piece) => ({ ...piece, swatch: range.swatch })),
  })
  return primitive
}
async function writeGarment(
  garment: Garment,
  original: Primitive,
  range: Range,
  { jointNames, id }: { jointNames: string[]; id: string },
): Promise<void> {
  const doc = new Document()
  const primitive = surface(doc, garment, original, range)
  const mesh = doc.createMesh().addPrimitive(primitive)
  doc.createScene().addChild(doc.createNode('Blender authored waistcoat').setMesh(mesh))
  doc.getRoot().setExtras({
    jointNames,
    authoring: 'Blender native UV pattern, Decimate, Solidify; no runtime cloth solver',
  })
  await mkdir(resolve(source, 'waistcoats'), { recursive: true })
  await io.write(resolve(source, 'waistcoats', `${id}.glb`), doc)
}
async function author(path: string): Promise<boolean> {
  const doc = await io.read(path)
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    const skin = node.getSkin()
    const ranges = node.getExtras().pieceRanges as Range[] | undefined
    if (!(mesh && skin && ranges)) {
      continue
    }
    const shirt = ranges.find((range) => range.name === 'WesternShirt')
    const original = mesh.listPrimitives().find((p) => p.getExtras().waistcoatFit)
    const wool = (original?.getExtras().waistcoatFit as { ranges: Range[] } | undefined)?.ranges[0]
    if (!(shirt && original && wool)) {
      continue
    }
    const temporary = await mkdtemp(join(tmpdir(), 'out-west-waistcoat-'))
    try {
      const input = join(temporary, 'shirt.json')
      const output = join(temporary, 'garment.json')
      const attrs = Object.fromEntries(
        original
          .listSemantics()
          .map((name) => [
            name,
            Array.from(
              { length: shirt.count },
              (_, i) => original.getAttribute(name)?.getElement(shirt.start + i, []) ?? [],
            ),
          ]),
      )
      await Bun.write(input, JSON.stringify({ attrs }))
      const child = Bun.spawn(
        [
          process.env.BLENDER ?? 'blender',
          '--background',
          '--factory-startup',
          '--python',
          resolve('tools/content/waistcoat-authoring.py'),
          '--',
          input,
          output,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0 || !(await Bun.file(output).exists())) {
        throw new Error(`Blender waistcoat failed: ${stdout}\n${stderr}`)
      }
      await writeGarment(
        (await Bun.file(output).json()) as Garment,
        original,
        { ...wool, swatch: 'wool' },
        {
          jointNames: skin.listJoints().map((j) => j.getName()),
          id: basename(path, '.gltf'),
        },
      )
      console.log(`Authored waistcoat ${basename(path)}: ${stdout.trim()}`)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
    return true
  }
  return false
}
if (import.meta.main) {
  for (const file of await readdir(source)) {
    if (
      file.endsWith('.gltf') &&
      (!process.env.OUT_WEST_CHARACTERS ||
        process.env.OUT_WEST_CHARACTERS.split(',').includes(basename(file, '.gltf')))
    ) {
      await author(resolve(source, file))
    }
  }
}
