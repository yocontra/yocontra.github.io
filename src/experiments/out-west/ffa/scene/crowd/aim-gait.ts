/** Far aiming keeps the authored leg cycle while the right arm holds the pistol on target. */
import { AnimationClip } from 'three'
import type { Clip } from '../../../scene/actor.ts'

export type FarClip = Clip | 'Walk_Aim' | 'Run_Aim'
const GUN_ARM = /^(?:Shoulder|UpperArm|LowerArm|Wrist|Index|Middle|Ring|Pinky|Thumb)\d?R$/u

export function aimedGaits(clips: AnimationClip[]): AnimationClip[] {
  const pointing = clips.find(
    (clip) => (clip.name.split('|').pop() ?? clip.name) === 'Idle_Gun_Pointing',
  )
  if (!pointing) {
    return []
  }
  const arm = pointing.tracks.filter((track) => GUN_ARM.test(track.name.split('.')[0] ?? ''))
  return clips
    .filter((clip) => ['Walk', 'Run'].includes(clip.name.split('|').pop() ?? clip.name))
    .map((gait) => {
      const tracks = gait.tracks.filter((track) => !GUN_ARM.test(track.name.split('.')[0] ?? ''))
      for (const source of arm) {
        const track = source.clone()
        const pose = source.values.slice(0, source.getValueSize())
        track.times = new Float32Array([0, gait.duration])
        track.values = new Float32Array([...pose, ...pose])
        tracks.push(track)
      }
      return new AnimationClip(
        `${gait.name.split('|').pop() ?? gait.name}_Aim`,
        gait.duration,
        tracks,
      )
    })
}
