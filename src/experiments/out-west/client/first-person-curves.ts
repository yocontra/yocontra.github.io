import { AnimCurve, AnimEvents, AnimTrack, type ContainerResource } from 'playcanvas'
import { DYNAMIC_ASSETS } from '../content/manifest.ts'
import type { GameApplication } from './application.ts'

const composed = new WeakMap<AnimTrack, { arms: AnimTrack; track: AnimTrack }>()
const target = (path: AnimCurve['paths'][number]): string =>
  JSON.stringify([path.entityPath, path.component, path.propertyPath])

/** Replace only the authored arm targets. The world actor keeps its original tracks. */
function withArms(base: AnimTrack, arms: AnimTrack): AnimTrack {
  const cached = composed.get(base)
  if (cached?.arms === arms) {
    return cached.track
  }
  if (base.duration !== arms.duration) {
    throw new Error(`First-person arm curves do not match the duration of ${base.name}`)
  }
  const replaced = new Set(arms.curves.flatMap((curve) => curve.paths.map(target)))
  const curves: AnimCurve[] = []
  for (const curve of base.curves) {
    const paths = curve.paths.filter((path) => !replaced.delete(target(path)))
    if (paths.length === curve.paths.length) {
      curves.push(curve)
    } else if (paths.length > 0) {
      curves.push(new AnimCurve(paths, curve.input, curve.output, curve.interpolation))
    }
  }
  if (replaced.size > 0) {
    throw new Error(`First-person arm curves do not match targets in ${base.name}`)
  }
  for (const curve of arms.curves) {
    curves.push(
      new AnimCurve(
        curve.paths,
        base.inputs.length + curve.input,
        base.outputs.length + curve.output,
        curve.interpolation,
      ),
    )
  }
  const track = new AnimTrack(
    base.name,
    base.duration,
    [...base.inputs, ...arms.inputs],
    [...base.outputs, ...arms.outputs],
    curves,
    new AnimEvents(Array.isArray(base.events) ? base.events : base.events.events),
  )
  composed.set(base, { arms, track })
  return track
}

export async function loadViewmodelTracks(
  game: GameApplication,
  world: readonly AnimTrack[],
): Promise<AnimTrack[]> {
  const asset = await game.loadContainer(DYNAMIC_ASSETS['viewmodel-arm-curves'].url)
  const arms = new Map<string, AnimTrack>()
  for (const animation of (asset.resource as ContainerResource).animations) {
    const track = animation.resource as AnimTrack
    arms.set(track.name, track)
  }
  return world.map((base) => {
    const authored = arms.get(base.name)
    return authored ? withArms(base, authored) : base
  })
}
