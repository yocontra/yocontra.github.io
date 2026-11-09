/** Authoritative interest selection; no provider, socket, timer, or game-world allocation. */
export interface VoicePeer {
  id: number
  name: string
  x: number
  z: number
  human: boolean
  connected: boolean
  available: boolean
}
export interface VoiceInterest {
  listening: boolean
  muted: ReadonlySet<number>
}
export interface VoiceSelection {
  members: Set<number>
  listeners: Map<number, number>
}

export function selectVoiceMembers(
  peers: readonly VoicePeer[],
  interests: ReadonlyMap<number, VoiceInterest>,
  talking: ReadonlySet<number>,
  previous: ReadonlySet<number> = new Set(),
): VoiceSelection {
  const eligible = peers.filter(
    (peer) => peer.human && peer.connected && peer.available && interests.has(peer.id),
  )
  const members = new Set<number>()
  const listeners = new Map<number, number>()
  for (const speaker of eligible) {
    const own = interests.get(speaker.id)
    const audience = eligible
      .filter((peer) => {
        const preference = interests.get(peer.id)
        const radius = previous.has(peer.id) ? 28 : 24
        return (
          peer.id !== speaker.id &&
          preference?.listening &&
          !preference.muted.has(speaker.id) &&
          !own?.muted.has(peer.id) &&
          Math.hypot(peer.x - speaker.x, peer.z - speaker.z) <= radius
        )
      })
      .sort(
        (a, b) =>
          Math.hypot(a.x - speaker.x, a.z - speaker.z) -
            Math.hypot(b.x - speaker.x, b.z - speaker.z) || a.id - b.id,
      )
      .slice(0, 4)
    listeners.set(speaker.id, audience.length)
    if (talking.has(speaker.id) && audience.length > 0) {
      members.add(speaker.id)
      for (const peer of audience) {
        members.add(peer.id)
      }
    }
  }
  return { members, listeners }
}
