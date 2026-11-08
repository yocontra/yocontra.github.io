/** Exercise the production remote rider masks and pose selection on actual native actors. */
import { Vec3 } from 'playcanvas'
import { animateRider } from '../../src/experiments/out-west/client/actor-animation.ts'
import {
  createRiderPose,
  type RiderPose,
} from '../../src/experiments/out-west/client/actor-pose.ts'
import { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { DYNAMIC_ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import { DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'
import type { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import type { Player } from '../../src/experiments/out-west/ffa/sim/types.ts'
import {
  attachHeldWeapon,
  equippedActor,
} from '../../src/experiments/out-west/scene/native-equipment.ts'

let game: GameApplication | undefined
let current:
  | {
      actor: DuelActor
      pose: RiderPose
      clip: string
      firingUntil: number
      aim: RiderPose['aim']
      weaponLayer: RiderPose['weapon']
    }
  | undefined
let category = ''
const WEAPONS = new Map([
  ['revolver', 0],
  ['shotgun', 1],
  ['rifle', 2],
])
export async function remoteCharacterPose(
  weapon: 'revolver' | 'rifle' | 'shotgun',
  crouched: boolean,
  pitch: number,
): Promise<unknown> {
  if (!game) {
    document.body.replaceChildren()
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh'
    const canvas = document.createElement('canvas')
    document.body.append(canvas)
    game = await GameApplication.create({ canvas, viewport: document.body, pixelRatio: 1 })
    game.camera.setPosition(2, 1.25, 3.5)
    game.camera.lookAt(0, 0.95, 0)
    if (game.camera.camera) {
      game.camera.camera.fov = 35
    }
  }
  if (!current || category !== weapon) {
    current?.actor.destroy()
    const actor = await equippedActor(game, DEFAULT_LOADOUT)
    if (weapon !== 'revolver') {
      await attachHeldWeapon(game, actor, weapon, DYNAMIC_ASSETS[`held-${weapon}`].url)
    }
    actor.hold(weapon, true)
    actor.face(-55)
    const pose = createRiderPose(game, actor)
    current = { actor, pose, clip: '', firingUntil: 0, aim: pose.aim, weaponLayer: pose.weapon }
    category = weapon
    if (actor.model.anim) {
      actor.model.anim.playing = false
    }
    if (pose.root.anim) {
      pose.root.anim.playing = false
    }
  }
  const domain = {
    weapon: WEAPONS.get(weapon) ?? 0,
    crouched,
  } as Player
  animateRider(
    current,
    {
      id: 'remote-fixture',
      x: 0,
      y: 0.9,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      pitch,
      grounded: true,
      crouched,
      hp: 100,
      ammo: 6,
      seq: 1,
    },
    { first: false, domain },
  )
  current.actor.model.anim?.update(0.4)
  current.pose.root.anim?.update(0.4)
  const muzzle = current.actor.muzzle()
  if (!muzzle) {
    throw new Error('Missing remote held socket')
  }
  const direction = current.actor.root
    .getWorldTransform()
    .clone()
    .invert()
    .transformVector(muzzle.direction, new Vec3())
    .normalize()
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  return {
    weapon,
    crouched,
    pitch,
    direction,
    upper: current.weaponLayer.activeState,
    aim: current.aim.activeState,
    lower: current.actor.model.anim?.baseLayer?.activeState,
  }
}
