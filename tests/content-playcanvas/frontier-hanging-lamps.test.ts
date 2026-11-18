import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const assets = [
  {
    path: 'tools/art/environments/frontier.glb',
    // biome-ignore lint/security/noSecrets: SHA-256 of the public source coffin atlas.
    atlas: '468a60ee8105316da0dd9744411e32f49b7101dab31b350b0c76b79b3ea7216c',
  },
  {
    path: 'public/experiments/out-west/3d/native-v2/baked/frontier.glb',
    // biome-ignore lint/security/noSecrets: SHA-256 of the public native coffin atlas.
    atlas: '466d67a9fc0a354efe35e42398028bb1d80700c7e4ac121b753f32953b289197',
  },
]
for (const { path, atlas } of assets) {
  it(`retains every coffin and gives all eleven fixtures independent PBR glass: ${path}`, async () => {
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
    const coffinAtlas = root
      .listMaterials()
      .find((material) => material.getName() === 'HalloweenBits')
    const coffinBytes = coffinAtlas?.getBaseColorTexture()?.getImage()
    if (!coffinBytes) {
      throw new Error('Missing coffin atlas')
    }
    expect(createHash('sha256').update(coffinBytes).digest('hex')).toBe(atlas)
    expect(
      nodes.filter((node) =>
        node
          .getMesh()
          ?.listPrimitives()
          .some((primitive) => primitive.getMaterial() === coffinAtlas),
      ),
    ).toHaveLength(12)
  })
}
