/** Apply Blender's vertex edits to the canonical starter meshes before native fitting. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { Document } from '@gltf-transform/core'

const ART = 'tools/art/characters'
const STARTER = new Set(['player', 'outfit.trail-duds', 'outfit.trail-duds.pair', 'gun.rusty-six'])
interface StarterSurface {
  source: string
  edits: {
    mesh: number
    primitive: number
    shape: [index: number, position: number[], normal: number[]][]
    paint: [index: number, color: number[], pbr: number[]][]
  }[]
}

export async function fitStarterSurfaces(document: Document, id: string): Promise<string | null> {
  if (!STARTER.has(id)) {
    return null
  }
  const path = join(ART, 'starter-surfaces', `${id}.json.gz`)
  const [source, buffer, authored] = await Promise.all([
    readFile(join(ART, `${id}.gltf`)),
    readFile(join(ART, `${id}.bin`)),
    readFile(path),
  ])
  const { source: expected, edits } = JSON.parse(gunzipSync(authored).toString()) as StarterSurface
  if (createHash('sha256').update(source).update(buffer).digest('hex') !== expected) {
    throw new Error(`Regenerate Blender starter surfaces for ${id}`)
  }

  for (const edit of edits) {
    const primitive = document.getRoot().listMeshes()[edit.mesh]?.listPrimitives()[edit.primitive]
    const position = primitive?.getAttribute('POSITION')
    const normal = primitive?.getAttribute('NORMAL')
    const color = primitive?.getAttribute('COLOR_0')
    const pbr = primitive?.getAttribute('_PBR')
    if (!(position && normal && color && (pbr || edit.paint.length === 0))) {
      throw new Error(`Missing starter vertex attributes for ${id}`)
    }
    for (const [index, point, direction] of edit.shape) {
      position.setElement(index, point)
      normal.setElement(index, direction)
    }
    for (const [index, tint, finish] of edit.paint) {
      color.setElement(index, tint)
      pbr?.setElement(index, finish)
    }
  }
  return path
}
