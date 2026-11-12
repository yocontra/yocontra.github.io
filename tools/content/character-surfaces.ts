/** Material boundaries and native PBR channel conversion for authored character surfaces. */
import { resolve } from 'node:path'
import type { Document, Mesh, Primitive } from '@gltf-transform/core'
import sharp from 'sharp'
import { DYES } from '../../src/experiments/out-west/data/dye.ts'
import {
  appendPrimitive,
  element,
  imageFile,
  originalFile,
  type Patch,
  type Pixels,
  patches,
  pixels,
  type Range,
  rangeIndices,
  renderPatch,
} from './character-atlas.ts'
import { gunSurfaceDetail } from './character-metal.ts'

async function addGun(doc: Document, mesh: Mesh, primitive: Primitive): Promise<boolean> {
  const original = primitive.getMaterial()
  const gunPbr = primitive.getAttribute('_PBR')
  if (original && gunPbr) {
    const groups = new Map<string, { indices: number[]; metal: number; rough: number }>()
    const input = primitive.getIndices()
    if (!input) {
      throw new Error('Authored gun requires indices')
    }
    for (let i = 0; i < input.getCount(); i += 3) {
      const indices = [input.getScalar(i), input.getScalar(i + 1), input.getScalar(i + 2)]
      const [metal = 0, rough = 0.5] = gunPbr.getElement(indices[0] ?? 0, [])
      const key = `${metal.toFixed(4)}/${rough.toFixed(4)}`
      const group = groups.get(key) ?? { indices: [], metal, rough }
      group.indices.push(...indices)
      groups.set(key, group)
    }
    for (const [key, group] of groups) {
      const material = original
        .clone()
        .setName(`Gun ${key}`)
        .setMetallicFactor(group.metal)
        .setRoughnessFactor(group.rough)
      const map = original.getBaseColorTexture()
      if (map) {
        material.setExtras({
          nativePbr: {
            albedo: await originalFile(map, true),
            normal: (await gunSurfaceDetail()).normal,
          },
        })
        material.setBaseColorTexture(null)
      }
      mesh.addPrimitive(appendPrimitive(doc, primitive, group.indices, material))
    }
    mesh.removePrimitive(primitive)
    primitive.dispose()
    return true
  }
  return false
}
function addPlain(
  doc: Document,
  mesh: Mesh,
  primitive: Primitive,
  {
    plain,
    baseUrl,
    normalUrl,
    armUrl,
  }: { plain: Range[]; baseUrl: string; normalUrl: string; armUrl: string },
): void {
  const original = primitive.getMaterial()
  if (!original) {
    throw new Error('Missing authored material')
  }
  if (plain.length > 0) {
    const inputColor = primitive.getAttribute('COLOR_0')
    const style = primitive.getAttribute('_STYLE_MATERIAL')
    if (!inputColor) {
      throw new Error('Missing authored character colors')
    }
    const values = new Float32Array(inputColor.getCount() * 4)
    for (let index = 0; index < inputColor.getCount(); index++) {
      const rgb = inputColor.getElement(index, [])
      const rough = element(style, index, 2, 1)[0] ?? 1
      values.set([rgb[0] ?? 1, rgb[1] ?? 1, rgb[2] ?? 1, rough / 2], index * 4)
    }
    const color = doc
      .createAccessor()
      .setType('VEC4')
      .setArray(values)
      .setBuffer(doc.getRoot().listBuffers()[0] ?? doc.createBuffer())
    const material = original
      .clone()
      .setName('Character')
      .setBaseColorFactor([1, 1, 1, 1])
      .setRoughnessFactor(1)
      .setMetallicFactor(1)
      .setExtras({
        nativePbr: { albedo: baseUrl, normal: normalUrl, arm: armUrl, roughnessVertexScale: 2 },
      })
    material.setBaseColorTexture(null).setNormalTexture(null).setMetallicRoughnessTexture(null)
    const indices = plain.flatMap((range) => rangeIndices(primitive, range))
    if (indices.length > 0) {
      mesh.addPrimitive(
        appendPrimitive(doc, primitive, indices, material).setAttribute('COLOR_0', color),
      )
    }
  }
}
async function addColored(
  doc: Document,
  mesh: Mesh,
  primitive: Primitive,
  {
    colored,
    images,
    dyeable,
  }: {
    colored: Range[]
    images: { albedo: Pixels; normal: Pixels; arm: Pixels }
    dyeable: boolean
  },
): Promise<void> {
  const original = primitive.getMaterial()
  if (!original) {
    throw new Error('Missing authored material')
  }
  if (colored.length > 0) {
    const packed = patches(primitive, colored, images.albedo)
    const count = packed.width * packed.height * 4
    const atlases = {
      albedo: new Uint8Array(count),
      normal: new Uint8Array(count),
      arm: new Uint8Array(count),
    }
    const uv = primitive.getAttribute('TEXCOORD_0')?.clone()
    const color = primitive.getAttribute('COLOR_0')?.clone()
    if (!(uv && color)) {
      throw new Error('Missing canonical surface attributes')
    }
    const indices: number[] = []
    const neckerchief: number[] = []
    for (const patch of packed.patches) {
      renderPatch(patch, primitive, { images, atlases, width: packed.width, dye: null })
      mapPatchUV(primitive, patch, {
        uv,
        color,
        width: packed.width,
        height: packed.height,
        albedo: images.albedo,
      })
      const target =
        dyeable && patch.range.swatch === 'linen' && !patch.range.slot && !patch.range.name
          ? neckerchief
          : indices
      target.push(...patch.indices)
    }
    const dyes: Record<string, string> = {}
    const nativePbr = {
      albedo: await imageFile(atlases.albedo, packed.width, packed.height, true),
      normal: await imageFile(atlases.normal, packed.width, packed.height, false),
      arm: await imageFile(atlases.arm, packed.width, packed.height, false),
      dyes,
      width: packed.width,
      height: packed.height,
    }
    await renderDyes(dyeable, packed, primitive, { images, atlases, dyes })
    const material = original
      .clone()
      .setName(dyeable ? 'Dyeable' : 'Fabric')
      .setBaseColorFactor([1, 1, 1, 1])
      .setRoughnessFactor(1)
      .setMetallicFactor(1)
      .setExtras({ nativePbr })
    material.setBaseColorTexture(null).setNormalTexture(null).setMetallicRoughnessTexture(null)
    for (const [subset, surface] of [
      [indices, material],
      [
        neckerchief,
        material
          .clone()
          .setName('Neckerchief')
          .setExtras({ ...material.getExtras(), equipmentPart: 'neckerchief' }),
      ],
    ] as const) {
      if (subset.length > 0) {
        mesh.addPrimitive(
          appendPrimitive(doc, primitive, subset, surface)
            .setAttribute('TEXCOORD_0', uv)
            .setAttribute('COLOR_0', color),
        )
      }
    }
  }
}
export async function convertCharacterSurface(
  doc: Document,
  mesh: Mesh,
  primitive: Primitive,
  { ranges, dyeable }: { ranges: Range[]; dyeable: boolean },
): Promise<void> {
  if (await addGun(doc, mesh, primitive)) {
    return
  }
  const original = primitive.getMaterial()
  const albedo = original?.getBaseColorTexture()
  const normal = original?.getNormalTexture()
  const arm = original?.getMetallicRoughnessTexture()
  const lum = primitive.getAttribute('_STYLE_LUMINANCE')
  if (!(original && albedo && normal && arm && lum)) {
    return
  }
  const images = {
    albedo: await pixels(albedo),
    normal: await pixels(normal),
    arm: await pixels(arm),
  }
  const all = ranges.length > 0 ? ranges : [{ start: 0, count: lum.getCount() }]
  const actual = all.filter((range) => !range.surface)
  const colored = actual.filter((range) => lum.getScalar(range.start) > 0)
  const plain = actual.filter((range) => !(lum.getScalar(range.start) > 0))
  await addSurfaced(
    doc,
    mesh,
    primitive,
    all.filter((range) => range.surface),
  )
  const [normalUrl, armUrl, baseUrl] = await Promise.all([
    originalFile(normal, false),
    originalFile(arm, false),
    originalFile(albedo, true),
  ])
  addPlain(doc, mesh, primitive, { plain, baseUrl, normalUrl, armUrl })
  await addColored(doc, mesh, primitive, { colored, images, dyeable })
  mesh.removePrimitive(primitive)
  primitive.dispose()
}

async function surfaceFile(name: string, color: boolean): Promise<string> {
  const image = await sharp(resolve('tools/art/characters/textures', name))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return imageFile(image.data, image.info.width, image.info.height, color)
}
/** Authored surfaces share one material and texture set per variant across every actor. */
async function addSurfaced(
  doc: Document,
  mesh: Mesh,
  primitive: Primitive,
  surfaced: Range[],
): Promise<void> {
  const original = primitive.getMaterial()
  const inputColor = primitive.getAttribute('COLOR_0')
  if (surfaced.length === 0 || !(original && inputColor)) {
    return
  }
  const groups = new Map<string, Range[]>()
  for (const range of surfaced) {
    const key = `${range.surface}.${range.variant ?? 'default'}`
    groups.set(key, [...(groups.get(key) ?? []), range])
  }
  for (const [key, group] of groups) {
    const [surface] = key.split('.')
    const color = inputColor.clone()
    for (const range of group) {
      for (let index = range.start; index < range.start + range.count; index++) {
        color.setElement(index, [1, 1, 1, 1].slice(0, color.getElementSize()))
      }
    }
    const material = original
      .clone()
      .setName(surface === 'cowboy-boot' ? 'Boots' : (surface ?? 'Surface'))
      .setBaseColorFactor([1, 1, 1, 1])
      .setRoughnessFactor(1)
      .setMetallicFactor(1)
      .setExtras({
        nativePbr: {
          albedo: await surfaceFile(`${key}.albedo.png`, true),
          normal: await surfaceFile(`${surface}.normal.png`, false),
          arm: await surfaceFile(`${surface}.arm.png`, false),
          ao: true,
        },
      })
    material.setBaseColorTexture(null).setNormalTexture(null).setMetallicRoughnessTexture(null)
    const indices = group.flatMap((range) => rangeIndices(primitive, range))
    if (indices.length > 0) {
      mesh.addPrimitive(
        appendPrimitive(doc, primitive, indices, material).setAttribute('COLOR_0', color),
      )
    }
  }
}

function mapPatchUV(
  primitive: Primitive,
  patch: Patch,
  {
    uv,
    color,
    width,
    height,
    albedo,
  }: {
    uv: import('@gltf-transform/core').Accessor
    color: import('@gltf-transform/core').Accessor
    width: number
    height: number
    albedo: Pixels
  },
): void {
  for (const index of new Set(patch.indices)) {
    const sourceUv = primitive.getAttribute('TEXCOORD_0')?.getElement(index, []) ?? [0, 0]
    uv.setElement(index, [
      (patch.x + (sourceUv[0] ?? 0) * albedo.width - patch.left) / width,
      (patch.y + (sourceUv[1] ?? 0) * albedo.height - patch.top) / height,
    ])
    color.setElement(index, [1, 1, 1, 1].slice(0, color.getElementSize()))
  }
}

async function renderDyes(
  enabled: boolean,
  packed: ReturnType<typeof patches>,
  primitive: Primitive,
  {
    images,
    atlases,
    dyes,
  }: {
    images: { albedo: Pixels; normal: Pixels; arm: Pixels }
    atlases: { albedo: Uint8Array; normal: Uint8Array; arm: Uint8Array }
    dyes: Record<string, string>
  },
): Promise<void> {
  if (enabled) {
    for (const dye of DYES) {
      if (!dye.hex) {
        continue
      }
      for (const patch of packed.patches) {
        renderPatch(patch, primitive, { images, atlases, width: packed.width, dye: dye.hex })
      }
      dyes[dye.id] = await imageFile(atlases.albedo, packed.width, packed.height, true)
    }
  }
}
