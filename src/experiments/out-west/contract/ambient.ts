/** Authored town life data shared by the headless world and native scene. */
export interface Stand {
  x: number
  y: number
  z: number
  yaw: number
}
export interface ArenaLife {
  dog: Stand
  horses: readonly Stand[]
  crows: { x: number; y: number; z: number; face: number; along?: string }
  door: Stand
  folk: readonly (Stand & {
    habit?: string
    door?: readonly number[] | null
    base?: string
    seatY?: number
    floor?: number
  })[]
  hens?: { x: number; z: number } | null
  crowPerches?: readonly { x: number; y: number; z: number }[]
  allocation?: {
    folk: number
    horses: number
    crows: number
    hens: number
    dog: boolean
    fakeouts: boolean
  }
}
