import { expect, test as it } from 'bun:test'
import { type Accessor, Document } from '@gltf-transform/core'
import { bindAuthoredSurface } from '../../tools/content/garment-geometry.ts'

function surfaces(authored: boolean) {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const attribute = (width: 1 | 2 | 3 | 4, values: number[]) =>
    doc
      .createAccessor()
      .setType(({ 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' } as const)[width])
      .setArray(Float32Array.from(values))
      .setBuffer(buffer)
  const original = doc.createPrimitive().setMaterial(doc.createMaterial('Fabric'))
  const styles = Object.fromEntries<Accessor>([
    ['COLOR_0', attribute(3, [0.1, 0.08, 0.06, 0.3, 0.24, 0.18, 0.5, 0.4, 0.3])],
    ['_STYLE_LUMINANCE', attribute(1, [0.226, 0.226, 0.226])],
    ['_STYLE_MATERIAL', attribute(2, [0.8, 0, 0.85, 0, 0.9, 0])],
    ['_DYE', attribute(3, [0.55, 0.55, 0.55, 0.8, 0.8, 0.8, 1, 1, 1])],
  ])
  const garment = doc
    .createPrimitive()
    .setAttribute('POSITION', attribute(3, [0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setAttribute('_AUTHOR_JOINTS', attribute(4, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    .setAttribute('_AUTHOR_WEIGHTS', attribute(4, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]))
    .setExtras({ pieceRanges: [{ start: 0, count: 3, sourceStyleIndex: 0 }] })
  for (const [semantic, data] of Object.entries(styles)) {
    original.setAttribute(semantic, data)
    if (authored) {
      garment.setAttribute(
        `_AUTHOR${semantic.startsWith('_') ? semantic : `_${semantic}`}`,
        data.clone(),
      )
    }
  }
  return { garment, original, styles }
}

it('portable coat patches retain canonical per-corner shade and dye gradients at their boundary', () => {
  const { garment, original, styles } = surfaces(true)
  bindAuthoredSurface(garment, original, 0)
  for (const [semantic, data] of Object.entries(styles)) {
    expect(garment.getAttribute(semantic)?.getArray()).toEqual(data.getArray())
  }
  expect(garment.listSemantics().some((name) => name.startsWith('_AUTHOR'))).toBe(false)
  expect(garment.getMaterial()).toBe(original.getMaterial())
})

it('existing portable pieces retain their sourceStyleIndex fallback without authored styles', () => {
  const { garment, original, styles } = surfaces(false)
  bindAuthoredSurface(garment, original, 0)
  for (const [semantic, data] of Object.entries(styles)) {
    for (let i = 0; i < 3; i++) {
      expect(garment.getAttribute(semantic)?.getElement(i, [])).toEqual(data.getElement(0, []))
    }
  }
})
