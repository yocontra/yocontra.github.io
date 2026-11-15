import { AnimCurve, AnimEvents, AnimTrack } from 'playcanvas'

type BoneMask = Readonly<Record<string, { children: boolean }>>
const tracks = new WeakMap<AnimTrack, Map<string, AnimTrack>>()

/** Keep authored data intact while omitting channels this native layer always masks out. */
export function maskedTrack(track: AnimTrack, mask: BoneMask): AnimTrack {
  const entries = Object.entries(mask).sort(([left], [right]) => left.localeCompare(right))
  const key = JSON.stringify(entries)
  const cached = tracks.get(track)?.get(key)
  if (cached) {
    return cached
  }
  const curves: AnimCurve[] = []
  for (const curve of track.curves) {
    const paths = curve.paths.filter((path) => {
      if (path.component !== 'graph') {
        return true
      }
      const bone = path.entityPath.join('/')
      return entries.some(
        ([root, value]) => bone === root || (value.children && bone.startsWith(`${root}/`)),
      )
    })
    if (paths.length === curve.paths.length) {
      curves.push(curve)
    } else if (paths.length > 0) {
      curves.push(new AnimCurve(paths, curve.input, curve.output, curve.interpolation))
    }
  }
  const result = new AnimTrack(
    track.name,
    track.duration,
    track.inputs,
    track.outputs,
    curves,
    // The engine getter returns the event array although its declaration says AnimEvents.
    new AnimEvents(Array.isArray(track.events) ? track.events : track.events.events),
  )
  const variants = tracks.get(track) ?? new Map<string, AnimTrack>()
  variants.set(key, result)
  tracks.set(track, variants)
  return result
}
