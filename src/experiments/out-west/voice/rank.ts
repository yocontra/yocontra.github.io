/** Pure proximity selection for voice subscriptions; no DOM, no SDK. */
export interface VoicePeer {
  /** Game player id, also the RealtimeKit custom participant id. */
  id: number
  name: string
  x: number
  y: number
  z: number
}

/** Pure proximity ranking: nearest `max`, with a short keep-alive past the inner radius. */
export function rankVoicePeers(
  peers: ReadonlyMap<number, VoicePeer>,
  own: { x: number; z: number },
  o: {
    max: number
    inRange: number
    outRange: number
    keepMs: number
    now: number
    muted: ReadonlySet<number>
    keepUntil: Map<number, number>
  },
): number[] {
  const candidates: { id: number; d: number }[] = []
  for (const [id, peer] of peers) {
    if (o.muted.has(id)) {
      o.keepUntil.delete(id)
      continue
    }
    const d = Math.hypot(peer.x - own.x, peer.z - own.z)
    if (d <= o.inRange) {
      o.keepUntil.set(id, o.now + o.keepMs)
    }
    if (d <= o.outRange && (d <= o.inRange || (o.keepUntil.get(id) ?? 0) > o.now)) {
      candidates.push({ id, d })
    } else {
      o.keepUntil.delete(id)
    }
  }
  candidates.sort((a, b) => a.d - b.d || a.id - b.id)
  return candidates.slice(0, Math.max(1, o.max)).map((c) => c.id)
}
