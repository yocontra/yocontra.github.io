/** Consolidate compatible rigid PBR styles without resampling their authored color or normal maps. */
import type { Document, Material, Mesh, Primitive } from '@gltf-transform/core'
import sharp from 'sharp'
import { compressedCharacterTexture } from './character-textures.ts'

interface Surface {
  albedo: string
  normal?: string
  arm?: string
  armUv?: number
  dyes?: Record<string, string>
}
type PaletteEncoder = (bytes: Uint8Array, color: boolean) => Promise<string>

const FACTORS = new Set(['name', 'metallicFactor', 'roughnessFactor'])
const BLOCK = 8
function surface(material: Material): Surface | undefined {
  return material.getExtras().nativePbr as Surface | undefined
}
function eligible(primitive: Primitive): boolean {
  const material = primitive.getMaterial()
  return Boolean(
    material &&
      surface(material)?.albedo &&
      !surface(material)?.arm &&
      !material.getMetallicRoughnessTexture() &&
      !material.getOcclusionTexture() &&
      material.getAlphaMode() === 'OPAQUE' &&
      primitive.getMode() === 4 &&
      primitive.getIndices() &&
      primitive.getAttribute('POSITION') &&
      !primitive.getAttribute('JOINTS_0') &&
      !primitive.getAttribute('TEXCOORD_1') &&
      primitive.listTargets().length === 0 &&
      primitive.listExtensions().length === 0,
  )
}
function role(material: Material): string {
  return material.getName().startsWith('Gun ') ? 'Gun' : material.getName()
}
function compatible(first: Primitive, next: Primitive): boolean {
  const a = first.getMaterial(),
    b = next.getMaterial()
  if (!(a && b && role(a) === role(b) && a.equals(b, FACTORS))) {
    return false
  }
  // Keep source vertex indices and pieceRanges intact. The style baker shares these accessors.
  const semantics = first.listSemantics()
  return (
    JSON.stringify(first.getExtras()) === JSON.stringify(next.getExtras()) &&
    semantics.length === next.listSemantics().length &&
    semantics.every((semantic) => first.getAttribute(semantic) === next.getAttribute(semantic))
  )
}
function groups(mesh: Mesh): Primitive[][] {
  const result: Primitive[][] = []
  for (const primitive of mesh.listPrimitives().filter(eligible)) {
    const group = result.find((candidate) => candidate[0] && compatible(candidate[0], primitive))
    if (group) {
      group.push(primitive)
    } else {
      result.push([primitive])
    }
  }
  return result.filter((group) => group.length > 1)
}

function coordinates(
  primitives: Primitive[],
  width: number,
): Float32Array<ArrayBuffer> | undefined {
  const count = primitives[0]?.getAttribute('POSITION')?.getCount() ?? 0
  const owners = new Int32Array(count).fill(-1)
  const uv = new Float32Array(count * 2)
  for (const [style, primitive] of primitives.entries()) {
    const indices = primitive.getIndices()
    if (!indices) {
      return undefined
    }
    for (let i = 0; i < indices.getCount(); i++) {
      const vertex = indices.getScalar(i)
      // A shared corner with incompatible material factors needs authoring-level vertex splitting.
      if (owners[vertex] !== -1 && owners[vertex] !== style) {
        return undefined
      }
      owners[vertex] = style
      uv[vertex * 2] = (style * BLOCK + BLOCK / 2) / width
      uv[vertex * 2 + 1] = 0.5
    }
  }
  return uv
}
async function palette(
  primitives: Primitive[],
  width: number,
  encode: PaletteEncoder,
): Promise<string> {
  const pixels = new Uint8Array(width * BLOCK * 4)
  for (let x = 0; x < width; x++) {
    const material =
      primitives[Math.min(primitives.length - 1, Math.floor(x / BLOCK))]?.getMaterial()
    if (!material) {
      throw new Error('Rigid palette lost its source material')
    }
    for (let y = 0; y < BLOCK; y++) {
      pixels.set(
        [
          255,
          Math.round(material.getRoughnessFactor() * 255),
          Math.round(material.getMetallicFactor() * 255),
          255,
        ],
        (y * width + x) * 4,
      )
    }
  }
  const image = await sharp(pixels, { raw: { width, height: BLOCK, channels: 4 } })
    .png()
    .toBuffer()
  return encode(image, false)
}
async function consolidate({
  doc,
  mesh,
  primitives,
  encode,
}: {
  doc: Document
  mesh: Mesh
  primitives: Primitive[]
  encode: PaletteEncoder
}): Promise<void> {
  const first = primitives[0],
    original = first?.getMaterial()
  if (!(first && original)) {
    return
  }
  const width = 2 ** Math.ceil(Math.log2(primitives.length * BLOCK))
  const uv = coordinates(primitives, width)
  if (!uv) {
    return
  }
  const arm = await palette(primitives, width, encode)
  const material = original
    .clone()
    .setName(role(original))
    .setMetallicFactor(1)
    .setRoughnessFactor(1)
  material.setExtras({
    ...original.getExtras(),
    nativePbr: { ...surface(original), arm, armUv: 1 },
  })
  const indices = primitives.flatMap((primitive) =>
    Array.from(primitive.getIndices()?.getArray() ?? []),
  )
  const buffer = first.getAttribute('POSITION')?.getBuffer() ?? doc.createBuffer()
  const combined = first
    .clone()
    .setMaterial(material)
    .setAttribute('TEXCOORD_1', doc.createAccessor().setType('VEC2').setArray(uv).setBuffer(buffer))
    .setIndices(
      doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(indices)).setBuffer(buffer),
    )
  for (const primitive of primitives) {
    mesh.removePrimitive(primitive)
    primitive.dispose()
  }
  mesh.addPrimitive(combined)
}

/** Call after the style bake and before weld/quantize: mount nodes and source vertex order survive. */
export async function consolidateRigidMaterials(
  doc: Document,
  encode: PaletteEncoder = compressedCharacterTexture,
): Promise<void> {
  const skinned = new Set(
    doc
      .getRoot()
      .listNodes()
      .filter((node) => node.getSkin())
      .map((node) => node.getMesh()),
  )
  // Each emitted palette is shared by its content hash. Serial encoding bounds the offline worker pool.
  for (const mesh of doc
    .getRoot()
    .listMeshes()
    .filter((candidate) => !skinned.has(candidate))) {
    for (const group of groups(mesh)) {
      await consolidate({ doc, mesh, primitives: group, encode })
    }
  }
}
