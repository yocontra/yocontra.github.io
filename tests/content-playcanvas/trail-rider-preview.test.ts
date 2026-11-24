import { expect, test as it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'
import { type Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import sharp from 'sharp'

const body = new Set(['field-hands'])
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)

function outfitParts(doc: Document) {
  const parts = doc
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
  return parts
    .filter((part) => body.has(part.getMaterial()?.getName() ?? ''))
    .map((part) => {
      const hash = createHash('sha256')
      for (const semantic of part.listSemantics().sort((a, b) => a.localeCompare(b))) {
        hash.update(semantic)
        hash.update(part.getAttribute(semantic)?.getArray() ?? new Uint8Array())
      }
      hash.update(part.getIndices()?.getArray() ?? new Uint8Array())
      return { material: part.getMaterial()?.getExtras(), geometry: hash.digest('hex') }
    })
}

it('fits the sculpted garments, accessories and both faces to the native game rigs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trail-duds-test-'))
  const output = join(root, 'equipment')
  try {
    execFileSync(process.execPath, ['tools/content/trail-rider-preview.ts', output])
    await Promise.all(
      ['outfit.trail-duds.glb', 'outfit.trail-duds.pair.glb'].map(async (file) => {
        const [original, fitted] = await Promise.all([
          io.read(join('public/experiments/out-west/3d/native-v2/equipment', file)),
          io.read(join(output, file)),
        ])
        const originalParts = outfitParts(original)
        expect(originalParts).toHaveLength(body.size)
        expect(outfitParts(fitted)).toEqual(originalParts)
        expect(fitted.getRoot().listSkins()[0]?.getInverseBindMatrices()?.getArray()).toEqual(
          original.getRoot().listSkins()[0]?.getInverseBindMatrices()?.getArray(),
        )
        const materials = fitted
          .getRoot()
          .listMaterials()
          .map((material) => material.getName())
        const fabric = fitted
          .getRoot()
          .listMaterials()
          .filter((m) => m.getName() === 'Dyeable')
        expect(fabric).toHaveLength(4)
        const sizes = await Promise.all(
          fabric.map(async (cloth) => {
            const surface = cloth.getExtras().nativePbr as {
              normal: string
              arm: string
              albedo: string
              dyes: { sage: string; [id: string]: string }
            }
            expect(Object.keys(surface.dyes).sort((a, b) => a.localeCompare(b))).toEqual([
              'bone',
              'coal',
              'indigo',
              'oxblood',
              'rust',
              'sage',
              'sand',
            ])
            const pathFor = (url: string) => join(root, 'characters', basename(url))
            await Promise.all(Object.values(surface.dyes).map((url) => access(pathFor(url))))
            const maps = await Promise.all(
              [surface.albedo, surface.normal, surface.arm, surface.dyes.sage].map((url) =>
                sharp(pathFor(url)).metadata(),
              ),
            )
            const dimensions = maps.map(({ width, height }) => `${width}x${height}`)
            expect(new Set(dimensions).size).toBe(1)
            return dimensions[0]
          }),
        )
        expect(sizes.sort()).toEqual(['1536x1536', '1536x1536', '2048x2048', '2048x2048'])
        expect(materials).toContain('Neckerchief')
        expect(materials).toContain('Rider beard and skin')
        expect(materials).toContain('Scanned nape and hairline')
        expect(materials).toContain('Scanned boot leather')
        expect(materials).toContain('Oxidized copper hardware')
        const arms = (await io.read(join(root, 'viewmodels', file))).getRoot()
        expect(
          arms
            .listMaterials()
            .map((m) => m.getName())
            .sort((a, b) => a.localeCompare(b)),
        ).toEqual(['Dyeable', 'field-hands'])
        const sleeve = arms.listMaterials().find((material) => material.getName() === 'Dyeable')
        expect(fabric.map((cloth) => cloth.getExtras().nativePbr)).toContainEqual(
          sleeve?.getExtras().nativePbr,
        )
        expect(
          arms
            .listSkins()[0]
            ?.listJoints()
            .some((j) => j.getName() === 'WristR'),
        ).toBe(true)
        expect(materials).not.toContain('Field-worn skin')
      }),
    )
    const bret = (await io.read(join(root, 'baked', 'outlaw-0.glb'))).getRoot()
    const source = (
      await io.read('public/experiments/out-west/3d/native-v2/baked/outlaw-0.glb')
    ).getRoot()
    expect(bret.listAnimations().map((a) => a.getName())).toEqual(
      source.listAnimations().map((a) => a.getName()),
    )
    const surfaces = bret.listMaterials().map((m) => m.getName())
    for (const name of [
      'Greenhorn fair skin',
      'oatmeal cotton',
      'blue serge',
      'sand felt',
      'Worn saddle brass',
      'Flaxen brow fibers',
    ]) {
      expect(surfaces).toContain(name)
    }
    for (const belt of ['holster.plain-leather', 'holster.plain-leather.pair']) {
      const gear = (await io.read(join(output, `${belt}.glb`))).getRoot()
      expect(gear.listMaterials().map((m) => m.getName())).toContain('Worn saddle brass')
    }
    const hat = (await io.read(join(output, 'hat.battered-brim.glb'))).getRoot()
    expect(
      hat
        .listNodes()
        .find((n) => n.getName() === 'mount.Head.accessory')
        ?.listChildren().length,
    ).toBeGreaterThan(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)
