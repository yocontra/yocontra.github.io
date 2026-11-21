import type { Node } from '@gltf-transform/core'
import type { Building, BuildingKind, Side } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { PORCH_DEPTH, PORCHED, sideStrip } from '../../src/experiments/out-west/ffa/sim/porches.ts'
import { type FrontierGeometry, frontierIO, type Rgb } from './frontier-geometry.ts'

const styles = ['saloon-porch-post', 'shop-porch-post', 'service-porch-post'] as const
const styleFor: Partial<Record<BuildingKind, (typeof styles)[number]>> = {
  saloon: 'saloon-porch-post',
  hotel: 'saloon-porch-post',
  general_store: 'shop-porch-post',
  undertaker: 'shop-porch-post',
}
const tones: Readonly<Record<string, number>> = {
  'Foot block': 0.86,
  'Cornice seat': 1.12,
  'Knee braces': 1.12,
}

interface Timber {
  positions: number[]
  crossPositions: number[]
  indices: number[]
  tone: number
}

export async function readPorchPosts(path: string): Promise<Map<string, Timber[]>> {
  const doc = await frontierIO.read(path)
  const posts = new Map<string, Timber[]>()
  for (const name of styles) {
    const root = doc
      .getRoot()
      .getDefaultScene()
      ?.listChildren()
      .find((node) => node.getName() === name)
    if (root?.listChildren().length !== 4) {
      throw new Error(`Missing modeled porch joinery ${name}`)
    }
    posts.set(
      name,
      root.listChildren().map((part) => {
        const mesh = part.getMesh()?.listPrimitives()[0]
        const positions = mesh?.getAttribute('POSITION')?.getArray()
        const indices = mesh?.getIndices()?.getArray()
        if (!(positions && indices)) {
          throw new Error(`Incomplete porch post geometry ${part.getName()}`)
        }
        const brace = part.getName().startsWith('Knee braces')
        const maxWidth = brace ? 0.411 : 0.0801
        const minHeight = brace ? 2.55 : 0
        const crossPositions: number[] = []
        for (let i = 0; i < positions.length; i += 3) {
          const x = positions[i] ?? Number.NaN
          const y = positions[i + 1] ?? Number.NaN
          const z = positions[i + 2] ?? Number.NaN
          if (
            !(Math.abs(x) <= maxWidth && Math.abs(z) <= 0.0801 && y >= minHeight && y <= 3.0401)
          ) {
            throw new Error(`Porch post extends outside its original envelope ${name}`)
          }
          crossPositions.push(z, y, -x)
        }
        return {
          positions: Array.from(positions),
          crossPositions,
          indices: Array.from(indices),
          tone: tones[part.getName().split('.')[0] ?? ''] ?? 0.99,
        }
      }),
    )
  }
  return posts
}

export function porchPosts(
  g: FrontierGeometry,
  root: Node,
  building: Building,
  options: { front: Side; paint: Rgb; posts: ReadonlyMap<string, Timber[]> },
): void {
  if (!PORCHED.has(building.kind)) {
    return
  }
  const { front, paint, posts } = options
  const style = styleFor[building.kind] ?? 'service-porch-post'
  const timber = posts.get(style)
  if (!timber) {
    throw new Error(`Missing porch posts for ${building.id}`)
  }
  const { x, z, w, d } = building
  const strip = sideStrip(building, front, PORCH_DEPTH)
  const horizontal = front === 'n' || front === 's'
  const length = horizontal ? w : d
  for (let along = 0.25; along < length; along += 4.5) {
    const px = horizontal ? x + along : strip.x + (front === 'e' ? 1.7 : 0.3)
    const pz = horizontal ? strip.z + (front === 's' ? 1.7 : 0.3) : z + along
    const origin = [px, 0.06, pz]
    for (const part of timber) {
      const local = horizontal ? part.positions : part.crossPositions
      const positions = local.map((value, i) => value + (origin[i % 3] ?? 0))
      const { tone } = part
      const tint: Rgb = [paint[0] * tone, paint[1] * tone, paint[2] * tone]
      g.surface(
        root,
        'wood',
        { id: `porch-post:${building.id}:${along}`, positions, indices: part.indices },
        tint,
      )
    }
  }
}
