/** Portable authored geometry stays in the original native skin/material/atlas batch. */
import { ComponentTypeToTypedArray, type Primitive } from '@gltf-transform/core'
import type { Range } from './character-atlas.ts'

interface Piece extends Range {
  sourceStyleIndex?: number
  tint?: number[]
  roughness?: number
}
export function bindAuthoredSurface(
  garment: Primitive,
  original: Primitive,
  fallback: number,
): void {
  garment.setMaterial(original.getMaterial())
  garment.setAttribute('JOINTS_0', garment.getAttribute('_AUTHOR_JOINTS'))
  garment.setAttribute('WEIGHTS_0', garment.getAttribute('_AUTHOR_WEIGHTS'))
  garment.setAttribute('_AUTHOR_JOINTS', null).setAttribute('_AUTHOR_WEIGHTS', null)
  const count = garment.getAttribute('POSITION')?.getCount() ?? 0
  const pieces = (garment.getExtras().pieceRanges ?? []) as Piece[]
  for (const semantic of ['COLOR_0', '_STYLE_LUMINANCE', '_STYLE_MATERIAL', '_DYE']) {
    const attribute = original.getAttribute(semantic)
    if (!attribute && semantic === '_DYE') {
      continue
    }
    if (!attribute) {
      throw new Error(`Missing canonical garment attribute ${semantic}`)
    }
    const width = attribute.getElementSize()
    const values = new Float32Array(count * width)
    for (const piece of pieces) {
      const style = attribute.getElement(piece.sourceStyleIndex ?? fallback, [])
      for (let vertex = piece.start; vertex < piece.start + piece.count; vertex++) {
        for (let c = 0; c < width; c++) {
          values[vertex * width + c] = styleValue(semantic, c, style[c] ?? 0, piece)
        }
      }
    }
    garment.setAttribute(semantic, attribute.clone().setArray(values))
  }
}
function styleValue(semantic: string, channel: number, value: number, piece: Piece): number {
  if (semantic === 'COLOR_0') {
    return value * (piece.tint?.[channel] ?? 1)
  }
  if (semantic === '_STYLE_MATERIAL' && channel === 0) {
    return value * (piece.roughness ?? 1)
  }
  return value
}
export function appendAuthoredSurface(
  original: Primitive,
  garment: Primitive,
  ranges: Range[],
): void {
  const offset = original.getAttribute('POSITION')?.getCount() ?? 0
  for (const semantic of original.listSemantics()) {
    const base = original.getAttribute(semantic)
    const extra = garment.getAttribute(semantic)?.getArray()
    const values = base?.getArray()
    if (!(base && values && extra)) {
      throw new Error(`Incompatible cloth attribute ${semantic}`)
    }
    const ArrayType = ComponentTypeToTypedArray[base.getComponentType()]
    if (!ArrayType) {
      throw new Error(`Unsupported cloth type ${base.getComponentType()}`)
    }
    const joined = new ArrayType(values.length + extra.length)
    joined.set(values)
    joined.set(extra, values.length)
    original.setAttribute(semantic, base.clone().setArray(joined))
  }
  const indices = original.getIndices()
  const extra = garment.getIndices()?.getArray()
  if (!(indices && extra)) {
    throw new Error('Authored cloth requires native indices')
  }
  original.setIndices(
    indices
      .clone()
      .setArray(
        Uint32Array.from([
          ...Array.from(indices.getArray() ?? []),
          ...Array.from(extra, (i) => i + offset),
        ]),
      ),
  )
  const pieces = (garment.getExtras().pieceRanges ?? []) as Range[]
  original.setExtras({
    ...original.getExtras(),
    pieceRanges: [...ranges, ...pieces.map((piece) => ({ ...piece, start: offset + piece.start }))],
  })
}
