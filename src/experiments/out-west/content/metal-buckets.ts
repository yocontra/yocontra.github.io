/** Shared authored render names and authoritative collision IDs for Frontier's metal buckets. */
import type { TownLayout } from '../ffa/sim/layout.ts'
import type { StaticWorldHit } from '../runtime/protocol.ts'

export const BUCKET_NODE_PREFIX = 'frontier-bucket:'
const COVER_ID = /^cover:(?<index>\d+)$/u

export function bucketAtHit(layout: TownLayout, hit: StaticWorldHit): number | undefined {
  const id = hit.collider.id
  const cover = id ? COVER_ID.exec(id)?.groups?.index : undefined
  if (cover === undefined) {
    return
  }
  const index = Number(cover)
  return layout.cover[index]?.kind === 'bucket' ? index : undefined
}

export function bucketOwner(node: { name: string; parent?: { name: string } | null }): boolean {
  let current: typeof node | null | undefined = node
  while (current) {
    if (current.name.startsWith(BUCKET_NODE_PREFIX)) {
      return true
    }
    current = current.parent
  }
  return false
}
