/** Disjoint native controllers give gait rate and upper-body action timing separate clocks. */
import { type AnimComponentLayer, Entity } from 'playcanvas'
import type { DuelActor } from '../duel/native-actor.ts'
import type { GameApplication } from './application.ts'

const WEAPON =
  /^(?:Crouch_(?:Idle_Gun_Pointing|Gun_Shoot|Shoot_|Reload|Hold_)|Idle_Gun_Pointing|Gun_Shoot|Shoot_|Reload|Hold_)/u
const AIM = /^(?:Crouch_)?Aim_/u
const ACTION = /Shoot|Reload/u
export interface RiderPose {
  readonly root: Entity
  readonly weapon: AnimComponentLayer
  readonly aim: AnimComponentLayer
  enabled: (value: boolean) => void
}
export function createRiderPose(game: GameApplication, actor: DuelActor): RiderPose {
  const root = new Entity('upper-body-pose', game.app)
  actor.root.addChild(root)
  root.addComponent('anim', { activate: false, rootBone: actor.model })
  const anim = root.anim
  if (!anim) {
    throw new Error('Native upper-body controller unavailable')
  }
  const tracks = actor.tracks.filter((track) => WEAPON.test(track.name))
  const initial = actor.animation('Idle_Gun_Pointing')
  anim.loadStateGraph({
    layers: [
      {
        name: 'Held weapon',
        states: [
          { name: 'START' },
          ...tracks.map((track) => ({
            name: track.name,
            speed: 1,
            loop: !ACTION.test(track.name),
          })),
        ],
        transitions: [{ from: 'START', to: initial }],
      },
    ],
    parameters: {},
  })
  const weapon = anim.baseLayer
  if (!weapon) {
    throw new Error('Native upper-body layer unavailable')
  }
  weapon.mask = actor.upperBodyMask()
  for (const track of tracks) {
    weapon.assignAnimation(track.name, track)
  }
  weapon.play(initial)
  const aim = anim.addLayer('Aim pitch', 0)
  aim.mask = {
    ...actor.upperBodyMask(false),
    ...actor.upperBodyMask(false, 'Torso'),
    ...actor.upperBodyMask(false, 'Chest'),
  }
  for (const track of actor.tracks.filter((clip) => AIM.test(clip.name))) {
    aim.assignAnimation(track.name, track, 1, true)
  }
  anim.normalizeWeights = false
  anim.activate = true
  anim.playing = true
  const lower = {
    ...actor.upperBodyMask(false, 'Root'),
    ...actor.upperBodyMask(false, 'Hips'),
    ...actor.upperBodyMask(true, 'UpperLegL'),
    ...actor.upperBodyMask(true, 'UpperLegR'),
  }
  const full = actor.upperBodyMask(true, 'Root')
  if (actor.model.anim?.baseLayer) {
    actor.model.anim.baseLayer.mask = lower
  }
  let enabled = true
  return {
    root,
    weapon,
    aim,
    enabled(value) {
      if (enabled === value) {
        return
      }
      enabled = value
      root.enabled = value
      if (actor.model.anim?.baseLayer) {
        actor.model.anim.baseLayer.mask = value ? lower : full
      }
    },
  }
}
