/** Actual native component ownership: hiding civilian guns must stop only their controllers. */
import type { Component, Entity } from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'

export async function nativeCivilianWeapons(game: GameApplication) {
  const actor = await DuelActor.create(game, ASSETS['outlaw-2'].url, 'civilian-weapon-proof')
  try {
    const weapon: Component[] = [
      ...new Set(
        actor.weaponMounts.flatMap((mount) => {
          const node = mount.node as Entity
          return [...node.findComponents('render'), ...node.findComponents('anim')]
        }),
      ),
    ]
    const all: Component[] = [
      ...actor.root.findComponents('render'),
      ...actor.root.findComponents('anim'),
    ]
    const before = new Map(all.map((component) => [component, component.enabled]))
    const body = all.filter((component) => !weapon.includes(component))
    if (!(weapon.length > 0 && actor.model.anim && body.includes(actor.model.anim))) {
      throw new Error('Civilian fixture lacks separate native body and gun components')
    }
    actor.weaponsVisible(false)
    actor.weaponsVisible(false)
    for (const clip of ['Town_Sit', 'Run', 'Draw']) {
      actor.play(clip, 0)
      actor.fireWeapon()
      game.app.systems.fire('animationUpdate', 0.1)
      if (
        weapon.some((component) => component.enabled) ||
        body.some((component) => component.enabled !== before.get(component))
      ) {
        throw new Error(`Civilian ${clip} changed hidden gun or body/clothing ownership`)
      }
    }
    if ((actor.model.anim.baseLayer?.activeStateCurrentTime ?? 0) <= 0) {
      throw new Error('Hiding guns stopped the body animation')
    }
    actor.weaponsVisible(true)
    if (all.some((component) => component.enabled !== before.get(component))) {
      throw new Error('Showing weapons did not restore original component enabled states')
    }
    return {
      hiddenWeaponComponents: weapon.length,
      bodyComponentsPreserved: body.length,
      restored: true,
    }
  } finally {
    actor.destroy()
  }
}
