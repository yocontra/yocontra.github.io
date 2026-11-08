/** Convert legacy atlas selectors into ordinary native PBR materials and repeating UVs. */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dequantize, prune } from '@gltf-transform/functions'
import sharp from 'sharp'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
for (const path of process.argv.slice(2)) {
  const doc = await io.read(path)
  await doc.transform(dequantize())
  const cache = new Map<string, ReturnType<typeof doc.createTexture>>()
  async function tile(texture: ReturnType<typeof doc.createTexture> | null, cell: number) {
    if (!texture) {
      return null
    }
    const key = `${doc.getRoot().listTextures().indexOf(texture)}:${cell}`
    const existing = cache.get(key)
    if (existing) {
      return existing
    }
    const image = texture.getImage()
    if (!image) {
      return null
    }
    const metadata = await sharp(image).metadata()
    const half = Math.floor((metadata.width ?? 0) / 2)
    const gutter = half / 32
    const data = await sharp(image)
      .extract({
        left: (cell % 2) * half + gutter,
        top: (1 - Math.floor(cell / 2)) * half + gutter,
        width: half - 2 * gutter,
        height: half - 2 * gutter,
      })
      .webp({ quality: 85 })
      .toBuffer()
    const result = doc
      .createTexture(`${texture.getName()}-${cell}`)
      .setImage(data)
      .setMimeType('image/webp')
    cache.set(key, result)
    return result
  }
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial()
      if (material?.getName() !== 'Civic') {
        continue
      }
      const uv = primitive.getAttribute('TEXCOORD_0')
      const indices = primitive.getIndices()
      if (!uv) {
        continue
      }
      const groups = new Map<number, number[]>()
      const array = uv.getArray()
      if (!array) {
        continue
      }
      const count = indices?.getCount() ?? uv.getCount()
      for (let i = 0; i < count; i += 3) {
        const a = indices?.getScalar(i) ?? i
        const cell = Math.floor((uv.getElement(a, [0, 0])[0] ?? 0) / 1000)
        const list = groups.get(cell) ?? []
        list.push(a, indices?.getScalar(i + 1) ?? i + 1, indices?.getScalar(i + 2) ?? i + 2)
        groups.set(cell, list)
      }
      const values = Float32Array.from(array)
      for (let i = 0; i < values.length; i += 2) {
        values[i] = (values[i] ?? 0) - Math.floor((values[i] ?? 0) / 1000) * 1000 - 500
      }
      const remap = uv.clone().setArray(values)
      for (const [cell, group] of groups) {
        const next = material.clone().setName(`Masonry-${cell}`)
        next.setBaseColorTexture(await tile(material.getBaseColorTexture(), cell))
        next.setNormalTexture(await tile(material.getNormalTexture(), cell))
        next.setMetallicRoughnessTexture(await tile(material.getMetallicRoughnessTexture(), cell))
        // The original Civic shader read ARM.r itself; make that AO channel explicit in glTF.
        next.setOcclusionTexture(
          await tile(
            material.getOcclusionTexture() ?? material.getMetallicRoughnessTexture(),
            cell,
          ),
        )
        const part = primitive
          .clone()
          .setAttribute('TEXCOORD_0', remap)
          .setIndices(
            doc
              .createAccessor()
              .setType('SCALAR')
              .setArray(Uint32Array.from(group))
              .setBuffer(uv.getBuffer()),
          )
          .setMaterial(next)
        mesh.addPrimitive(part)
      }
      mesh.removePrimitive(primitive)
      primitive.dispose()
    }
  }
  await doc.transform(prune())
  await io.write(path, doc)
}
