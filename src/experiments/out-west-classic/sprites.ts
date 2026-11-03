import { SPRITES, type SpriteName } from './constants.ts'

export type Sprites = Record<SpriteName, HTMLImageElement>

export const loadSprites = (): Sprites => {
  const make = (src: string): HTMLImageElement => {
    const img = new Image()
    img.decoding = 'async'
    img.src = src
    return img
  }
  return {
    playerFire: make(SPRITES.playerFire),
    playerWalk: make(SPRITES.playerWalk),
    enemyFire: make(SPRITES.enemyFire),
    enemyWalk: make(SPRITES.enemyWalk),
  }
}

/** drawImage throws on a broken image, so skip anything not ready yet. */
export const isReady = (img: HTMLImageElement): boolean => img.complete && img.naturalWidth > 0
