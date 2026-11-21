import { expect, test as it } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { getBounds } from '@gltf-transform/functions'
import town from '../../src/experiments/out-west/ffa/town.layout.json' with { type: 'json' }

const BLENDER_SUFFIX = /\.\d+$/u
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const assets = [
  'tools/art/environments/frontier.glb',
  'public/experiments/out-west/3d/native-v2/baked/frontier.glb',
]
for (const path of assets) {
  it(`retains all coffin placements and gives each hanging lamp independent PBR glass: ${path}`, async () => {
    const root = (await io.read(path)).getRoot()
    const nodes = root.listNodes()
    expect(nodes.filter((node) => node.getName() === 'lantern_hanging')).toHaveLength(0)
    const lamps = nodes.filter((node) => node.getName().startsWith('frontier-hanging-lamp:'))
    expect(lamps).toHaveLength(11)
    const sources = new Set()
    for (const lamp of lamps) {
      const parts = lamp.listChildren()
      expect(parts.map((part) => part.getName()).sort()).toEqual([
        'frontier-lantern-glass',
        'lamp-bail',
        'lamp-lantern',
      ])
      const lens = parts.find((part) => part.getName() === 'frontier-lantern-glass')
      const lensPositions = lens?.getMesh()?.listPrimitives()[0]?.getAttribute('POSITION')
      expect(lensPositions?.getMin([])[1]).toBeCloseTo(-0.13, 5)
      expect(lensPositions?.getMax([])[1]).toBeCloseTo(0.13, 5)
      expect(lens?.getWorldTranslation()[1]).toBeCloseTo(2.5135, 4)
      for (const part of parts) {
        const primitive = part.getMesh()?.listPrimitives()[0]
        const material = primitive?.getMaterial()
        if (!(material && primitive)) {
          throw new Error('Missing authored PBR fixture part')
        }
        const glass = part.getName() === 'frontier-lantern-glass'
        expect(material.getName()).toBe(glass ? 'LampGlass' : 'StreetLamp')
        expect(Boolean(material.getEmissiveTexture())).toBe(glass)
        expect(Boolean(material.getNormalTexture())).toBe(!glass)
        expect(Boolean(material.getBaseColorTexture())).toBe(!glass)
        sources.add(material)
      }
    }
    expect(sources.size).toBe(2)
    const coffinSites = town.cover.flatMap((site, index) =>
      site.kind === 'coffins' ? [{ site, index }] : [],
    )
    const coffins = nodes.filter((node) =>
      node.getName().startsWith('frontier-furniture:fitted-tapered-coffin:'),
    )
    expect(coffins).toHaveLength(6)
    expect(coffins.map((node) => Number(node.getName().split(':').at(-1)))).toEqual(
      coffinSites.map(({ index }) => index),
    )
    for (const { site, index } of coffinSites) {
      const coffin = coffins.find((node) => node.getName().endsWith(`:${index}`))
      if (!coffin) {
        throw new Error('Missing fitted undertaker coffin')
      }
      const { min, max } = getBounds(coffin)
      expect(min[0]).toBeGreaterThanOrEqual(site.x - 0.025)
      expect(min[2]).toBeGreaterThanOrEqual(site.z - 0.025)
      expect(max[0]).toBeLessThanOrEqual(site.x + site.w + 0.025)
      expect(max[2]).toBeLessThanOrEqual(site.z + site.d + 0.025)
      expect(max[1]).toBeCloseTo(site.top ?? 0.9, 4)
      const surfaces = coffin.listChildren().flatMap(
        (part) =>
          part
            .getMesh()
            ?.listPrimitives()
            .map((primitive) => primitive.getMaterial()) ?? [],
      )
      expect(
        surfaces.map((material) => material?.getName().replace(BLENDER_SUFFIX, '')).sort(),
      ).toEqual([
        'Blackened walnut lid',
        'Pegged white oak cut edge',
        'Silvery weathered iron hardware',
        'Smoked walnut cabinet',
      ])
      expect(surfaces.every((material) => material?.getNormalTexture())).toBe(true)
    }
  })
}
