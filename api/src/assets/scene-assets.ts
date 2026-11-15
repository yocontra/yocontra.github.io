import { ASSETS } from '../../../src/experiments/out-west/content/manifest.ts'

/** These five current scenes keep their public URLs; historical containers stay on Pages. */
export const SCENE_BUCKET = 'contra-out-west-scenes'
export const SCENE_ASSETS = [
  ASSETS.frontier,
  ASSETS.duel,
  ASSETS.mission,
  ASSETS.depot,
  ASSETS.bank,
].map((asset) => ({ ...asset, path: asset.url.split('?')[0] ?? '' }))

export function sceneKey(path: string, version: string): string {
  const basename = path.slice(path.lastIndexOf('/') + 1)
  return `${basename}/${version}`
}
