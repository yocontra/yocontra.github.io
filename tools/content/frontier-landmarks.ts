/** Sandstone shapes beyond the walkable town envelope use the existing masonry scans. */
import { type FrontierGeometry, frontierIO } from './frontier-geometry.ts'

const sites = [
  ['Layered butte', 137, 0.5, 62, -0.47, 0.9],
  ['Broken sandstone tower', 134, 1.4, 79, 0.46, 0.81],
  ['Bedded bench', 128, 0.9, 40, 1.53, 0.98],
  ['Layered butte', 34, 3.6, -31, 0.21, 0.84],
  ['Broken sandstone tower', 51, 3.6, -30, 0.18, 0.82],
  ['Bedded bench', 16, 4.1, -36, -0.2, 0.95],
] as const

export async function installFrontierLandmarks(
  g: FrontierGeometry,
  size: number,
  path: string,
): Promise<void> {
  const art = await frontierIO.read(path)
  const parts = art.getRoot().getDefaultScene()?.listChildren() ?? []
  const stone = g.materials.get('masonry')
  if (!stone) {
    throw new Error('Missing the shared sandstone material')
  }
  g.materials.set(
    'landmarks',
    stone
      .clone()
      .setName('Perdition weathered sandstone')
      .setBaseColorFactor([0.93, 0.73, 0.52, 1]),
  )
  const group = g.group('Sandstone formations beyond Perdition')
  for (const [name, x, y, z, angle, scale] of sites) {
    const source = parts
      .find((node) => node.getName() === name)
      ?.getMesh()
      ?.listPrimitives()[0]
    const points = source?.getAttribute('POSITION')
    const paints = source?.getAttribute('COLOR_0')
    const uvs = source?.getAttribute('TEXCOORD_0')?.getArray()
    const faces = source?.getIndices()?.getArray()
    if (!(points && paints && uvs && faces)) {
      throw new Error(`Missing authored sandstone formation ${name}`)
    }
    const sin = Math.sin(angle) * scale
    const cos = Math.cos(angle) * scale
    const positions: number[] = []
    const colors: number[] = []
    for (let i = 0; i < points.getCount(); i++) {
      const [px = 0, py = 0, pz = 0] = points.getElement(i, [])
      const wx = x + px * cos + pz * sin
      const wz = z - px * sin + pz * cos
      if (wx <= size + 5 && wz >= -5) {
        throw new Error(`Sandstone formation extends into the walkable town ${name}`)
      }
      positions.push(wx, y + py * scale, wz)
      colors.push(...paints.getElement(i, []))
    }
    g.surface(group, 'landmarks', {
      id: `sandstone:${name}:${x}:${z}`,
      positions,
      indices: Array.from(faces),
      colors,
      uvs: Array.from(uvs),
    })
  }
}
