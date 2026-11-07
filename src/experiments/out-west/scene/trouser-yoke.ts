/** The trouser yoke belongs to the pelvis; only the thigh below the crease follows the femur. */
import { Vector3 } from 'three'
import type { Piece } from './bake.ts'
import { type Body, boneKey } from './fit.ts'

export function bindTrouserYoke(piece: Piece, body: Body): void {
  const skin = piece.skin
  if (!skin) {
    return
  }
  const bone = (key: string) => body.bones.findIndex((candidate) => boneKey(candidate.name) === key)
  const hips = bone('Hips')
  if (hips < 0) {
    return
  }
  const center = body.bones[hips]?.getWorldPosition(new Vector3())
  if (!center) {
    return
  }
  const frames = (['L', 'R'] as const).flatMap((side) => {
    const hip = body.bones[bone(`UpperLeg${side}`)]?.getWorldPosition(new Vector3())
    const knee = body.bones[bone(`LowerLeg${side}`)]?.getWorldPosition(new Vector3())
    return hip && knee
      ? [{ sign: Math.sign(hip.x - center.x), y: hip.y, length: hip.distanceTo(knee) * 0.6 }]
      : []
  })
  const position = piece.geo.getAttribute('position')
  for (let vertex = 0; vertex < position.count; vertex++) {
    const frame = frames.find(
      (candidate) => (position.getX(vertex) - center.x) * candidate.sign >= 0,
    )
    if (!frame) {
      continue
    }
    const t = Math.max(
      0,
      Math.min(1, (position.getY(vertex) - frame.y + frame.length) / (frame.length + 0.015)),
    )
    if (t === 0) {
      continue
    }
    const amount = t * t * (3 - 2 * t)
    const combined = new Map<number, number>()
    for (let slot = 0; slot < 4; slot++) {
      const index = skin.index[vertex * 4 + slot] ?? 0
      const weight = (skin.weight[vertex * 4 + slot] ?? 0) * (1 - amount)
      combined.set(index, (combined.get(index) ?? 0) + weight)
    }
    combined.set(hips, (combined.get(hips) ?? 0) + amount)
    const weights = [...combined].sort((a, b) => b[1] - a[1]).slice(0, 4)
    const sum = weights.reduce((total, [, weight]) => total + weight, 0) || 1
    for (let slot = 0; slot < 4; slot++) {
      skin.index[vertex * 4 + slot] = weights[slot]?.[0] ?? 0
      skin.weight[vertex * 4 + slot] = (weights[slot]?.[1] ?? 0) / sum
    }
  }
}
