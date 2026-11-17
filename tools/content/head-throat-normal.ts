/** Offline, actor-scoped normal texels; the game renderer does not import this module. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type Document, NodeIO } from '@gltf-transform/core'
import sharp from 'sharp'
import { validateAuthoringInputs } from './authoring-inputs.ts'
import { THROAT_NORMAL_IDS } from './head-throat-plan.ts'

interface Image {
  data: Buffer
  width: number
  height: number
}
interface NormalPatch {
  sourceIds: string[]
  sourceSHA256: string
  image: string
  imageSHA256: string
  x: number
  y: number
  width: number
  height: number
}
const sources = new AsyncLocalStorage<string>()
const directory = resolve('tools/art/characters/head-throat-normal')
let atlas: Promise<Document | null> | undefined
let validated: Promise<void> | undefined

export function withHeadThroatNormalSource<T>(id: string, bake: () => Promise<T>): Promise<T> {
  return sources.run(id, bake)
}

export function assertOutwardNormalPixels(data: Uint8Array): number {
  let owned = 0
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]
    if (alpha === 0) {
      continue
    }
    const x = (data[i] ?? 0) / 127.5 - 1
    const y = (data[i + 1] ?? 0) / 127.5 - 1
    const z = (data[i + 2] ?? 0) / 127.5 - 1
    const length = Math.hypot(x, y, z)
    if (alpha !== 255 || z <= 0 || length < 0.98 || length > 1.02) {
      throw new Error('Anterior skin normal bake contains an inward, nonunit or partial-mask texel')
    }
    owned++
  }
  if (owned === 0) {
    throw new Error('Anterior skin normal mask is empty')
  }
  return owned
}

export function assertHeadThroatNormalSources(ids: readonly string[]): void {
  if (
    ids.length !== THROAT_NORMAL_IDS.length ||
    new Set(ids).size !== ids.length ||
    THROAT_NORMAL_IDS.some((id) => !ids.includes(id))
  ) {
    throw new Error('Anterior normal bake must name exactly the 32 male consumers')
  }
}

export async function patchHeadThroatNormalAtlas(bytes: Uint8Array, image: Image): Promise<void> {
  const id = sources.getStore()
  if (!(id && THROAT_NORMAL_IDS.includes(id))) {
    return
  }
  atlas ??= (async () => {
    const path = resolve(directory, 'atlas.gltf')
    return (await Bun.file(path).exists()) ? new NodeIO().read(path) : null
  })()
  const doc = await atlas
  if (!doc) {
    return
  }
  const patch = doc.getRoot().getExtras().normalPatch as unknown as NormalPatch
  assertHeadThroatNormalSources(patch.sourceIds)
  if (
    !patch.sourceIds.includes(id) ||
    createHash('sha256').update(bytes).digest('hex') !== patch.sourceSHA256
  ) {
    return
  }
  validated ??= validateAuthoringInputs(doc)
  await validated
  const png = await readFile(resolve(directory, patch.image))
  if (createHash('sha256').update(png).digest('hex') !== patch.imageSHA256) {
    throw new Error('Anterior normal image changed outside its native producer')
  }
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (
    info.width !== patch.width ||
    info.height !== patch.height ||
    patch.x < 0 ||
    patch.y < 0 ||
    patch.x + info.width > image.width ||
    patch.y + info.height > image.height
  ) {
    throw new Error('Anterior normal mask bounds do not match the source atlas')
  }
  assertOutwardNormalPixels(data)
  const composed = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .composite([
      {
        input: data,
        raw: { width: info.width, height: info.height, channels: 4 },
        left: patch.x,
        top: patch.y,
      },
    ])
    .raw()
    .toBuffer()
  image.data.set(composed)
}
