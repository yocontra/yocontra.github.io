/** Browser-only cancellation fixture using the production native equipment/application path. */

import { Actors, type PreparedCharacters } from '../../src/experiments/out-west/client/actors.ts'
import { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'
import { equippedActor } from '../../src/experiments/out-west/scene/native-equipment.ts'

let game: GameApplication | undefined
let pending: Promise<{ cancelled: boolean; message: string }> | undefined
let prepared: PreparedCharacters | undefined
export async function beginInterruptedCharacter(usePrepare = false): Promise<void> {
  document.body.replaceChildren()
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  game = await GameApplication.create({ canvas, viewport: document.body, pixelRatio: 1 })
  const work = usePrepare
    ? Actors.prepare(game, {
        loadout: DEFAULT_LOADOUT,
        dyes: { 'outfit.trail-duds': 'sage' },
        key: 'cancelled',
      })
    : equippedActor(game, DEFAULT_LOADOUT, { 'outfit.trail-duds': 'sage' })
  pending = work.then(
    (result) => {
      if ('dispose' in result) {
        prepared = result
        result.dispose()
        result.dispose()
      } else {
        result.destroy()
      }
      return { cancelled: false, message: 'completed' }
    },
    (error: unknown) => ({
      cancelled: true,
      message: error instanceof Error ? error.message : String(error),
    }),
  )
}
export function interruptCharacter(): void {
  game?.destroy()
  prepared?.dispose()
}
export async function interruptedCharacterResult(): Promise<{
  cancelled: boolean
  message: string
}> {
  if (!pending) {
    throw new Error('No cancellation fixture is active')
  }
  const result = await pending
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  return result
}
