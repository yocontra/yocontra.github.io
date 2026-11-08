/** Inspect real baked opponents through the production actor/material and native attachment path. */
import { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import { assertAttachmentLifecycle } from './attachment-probe.ts'

let game: GameApplication | undefined
let actor: DuelActor | undefined
export async function previewOpponent(index: number, clip = 'Idle_Gun_Pointing'): Promise<unknown> {
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
  const entry = ASSETS[`outlaw-${index}` as keyof typeof ASSETS]
  if (!entry) {
    throw new Error('Unknown native opponent')
  }
  actor?.destroy()
  actor = await DuelActor.create(game, entry.url, `opponent-${index}`)
  actor.face(-55)
  actor.play(clip, 0)
  actor.model.anim?.update(0.2)
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  const materials = actor.root
    .findComponents('render')
    .flatMap((component) => component.meshInstances.map((instance) => instance.material))
  return {
    index,
    hat: Boolean(actor.root.findByName('mount.Head.accessory')),
    mapped: materials.filter((material) =>
      Boolean((material as import('playcanvas').StandardMaterial).diffuseMap),
    ).length,
  }
}
export function opponentAttachmentLifecycle(): unknown {
  if (!actor) {
    throw new Error('Missing native opponent')
  }
  const result = assertAttachmentLifecycle(actor)
  actor = undefined
  return result
}
export function closeOpponentProbe(): void {
  actor?.destroy()
  game?.destroy()
  actor = undefined
  game = undefined
}
