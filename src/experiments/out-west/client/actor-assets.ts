/** Common actor assets share one native material lease for each rider collection. */
import type { ContainerResource } from 'playcanvas'
import { ASSETS, DYNAMIC_ASSETS } from '../content/manifest.ts'
import { prepareNativeMaterials } from '../scene/native-materials.ts'
import type { GameApplication } from './application.ts'

export async function commonCharacters(game: GameApplication): Promise<() => void> {
  const [, fallback] = await Promise.all([
    game.loadContainer(ASSETS.moves.url),
    game.loadContainer(ASSETS['outlaw-0'].url),
    game.loadContainer(DYNAMIC_ASSETS['held-rifle'].url),
    game.loadContainer(DYNAMIC_ASSETS['held-shotgun'].url),
  ])
  return prepareNativeMaterials(game, fallback.resource as ContainerResource)
}
