import { Vec3 } from 'playcanvas'
import { shotVisuals } from '../client/shot-visuals.ts'
import type { EnemyShot } from './judge.ts'
import type { DuelActor } from './native-actor.ts'
import type { NativeDirector } from './native-director.ts'

/** Cosmetic only: the existing clock/domain continues to judge every shot. */
export function duelShot(
  director: NativeDirector,
  actor: DuelActor | null | undefined,
  target?: DuelActor | null,
): void {
  if (!actor) {
    return
  }
  actor.shoot()
  const muzzle = actor.muzzle()
  if (!muzzle) {
    return
  }
  const end = target
    ? target.root
        .getPosition()
        .clone()
        .add(new Vec3(0, 1.25, 0))
    : muzzle.position.clone().add(muzzle.direction.clone().mulScalar(30))
  const visuals = shotVisuals(director.game, true)
  visuals.muzzle(muzzle.position, 0.11, muzzle.direction)
  visuals.trace(muzzle.position, end)
}

export function plannedShot(director: NativeDirector, shot: Pick<EnemyShot, 'who' | 'hit'>): void {
  duelShot(
    director,
    shot.who === 1 ? director.rifleman : director.enemy,
    shot.hit ? director.player : null,
  )
  director.c.audio.play('fire', { gain: 0.7 })
}

/** Warm the native unlit, particle and point-lit PBR variants behind the title. */
export async function prepareDuelShotVisuals(director: NativeDirector): Promise<void> {
  const point = director.player?.root.getPosition().clone() ?? new Vec3()
  point.y += 1.3
  await shotVisuals(director.game, true).warm(point)
}

/** The judged fall releases cosmetic props; Bullet owns their flight and contact. */
export function dropEnemyProps(director: NativeDirector, actor: DuelActor | null): void {
  if (!actor) {
    return
  }
  const away = actor.root
    .getPosition()
    .clone()
    .sub(director.player?.root.getPosition() ?? Vec3.ZERO)
  away.y = 0
  if (away.lengthSq() > 0) {
    away.normalize()
  }
  director.debris.drop(actor, 'hat', away, director.hatShot)
  if (director.handShot) {
    director.debris.drop(actor, 'gun', away)
  }
}
