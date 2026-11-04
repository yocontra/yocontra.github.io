/**
 * Camera views of Perdition for `tools/frontier-shots.ts` (dev screenshots only; the game never
 * imports this): eye-level walks down every street and alley, and overviews. Layout metres, y up.
 */
export interface TownView {
  name: string
  from: [number, number, number]
  to: [number, number, number]
  fov?: number
}

/** A third-person camera's height over the ground (a rider's eyes are ~1.6 m). */
const EYE = 1.7

// biome-ignore lint/complexity/useMaxParams: a view is two ground points, positional like the layout
const eye = (name: string, x0: number, z0: number, x1: number, z1: number): TownView => ({
  name,
  from: [x0, EYE, z0],
  to: [x1, EYE * 0.85, z1],
})

export const FRONTIER_VIEWS: TownView[] = [
  { name: 'over-top', from: [72, 150, 73], to: [72, 0, 72], fov: 55 },
  { name: 'over-nw', from: [-20, 70, -10], to: [72, 0, 72], fov: 55 },
  { name: 'over-se', from: [164, 70, 160], to: [72, 0, 72], fov: 55 },
  { name: 'over-bank', from: [72, 30, 40], to: [72, 0, 84], fov: 55 },
  // main street, both ways and down each boardwalk
  eye('main-west-east', 5, 64, 60, 64),
  eye('main-east-west', 139, 64, 80, 64),
  eye('main-north-boardwalk', 20, 55, 70, 55),
  eye('main-south-boardwalk', 120, 73, 70, 73),
  eye('main-crossroads', 72, 66, 72, 80),
  // north road and the creek
  eye('north-road-south', 72, 14, 72, 56),
  eye('north-road-north', 72, 54, 72, 10),
  eye('bridge', 72, 18, 72, 2),
  eye('creek-west', 66, 8, 20, 8),
  eye('creek-east', 78, 8, 130, 8),
  // cross street and the railroad
  eye('cross-south', 72, 94, 72, 139),
  eye('cross-north', 72, 139, 72, 92),
  eye('depot-platform', 15, 121, 42, 121),
  eye('track-east', 60, 128, 136, 125),
  eye('stock-pens', 80, 128, 108, 138),
  // the bank from every side
  eye('bank-north', 72, 64, 72, 76),
  eye('bank-lobby', 72, 76, 72, 83),
  eye('bank-west-alley', 60, 96, 60, 72),
  eye('bank-east-alley', 83.5, 94, 83.5, 72),
  eye('bank-south', 72, 104, 72, 91),
  // back lots and alleys
  eye('corral', 23, 50, 12, 24),
  eye('livery-saloon-alley', 43.5, 30, 43.5, 58),
  eye('saloon-back', 48, 24, 66, 30),
  eye('hotel-back', 76, 30, 108, 28),
  eye('cemetery', 112, 26, 132, 16),
  eye('south-back-west', 4, 94, 56, 96),
  eye('south-back-east', 80, 98, 136, 98),
  eye('jail-yard', 108, 92, 122, 104),
  eye('water-tower', 104, 112, 120, 115),
  eye('east-lot', 140, 74, 124, 90),
  // facades and close-ups
  eye('facade-saloon', 50, 63, 58, 52),
  eye('facade-store', 52, 69, 48, 76),
  eye('trough-corral', 15, 47, 12.5, 44.5),
  { name: 'bank-deposits', from: [72, 1.7, 76], to: [72, 2.2, 83] },
  eye('coach-close', 27, 58.5, 33, 61),
  eye('wreck-close', 124, 60, 131, 64),
  eye('telegraph', 50, 132, 96, 126),
  eye('ads-alley', 43.5, 64, 43.5, 40),
  { name: 'ad-livery', from: [45, 2.5, 48], to: [40, 3.4, 44] },
  { name: 'ad-store', from: [37.5, 2.5, 80], to: [40, 3.3, 82] },
  // interiors
  eye('saloon-bar', 64, 52, 50, 40),
  eye('store-inside', 56, 76, 42, 86),
  eye('smithy-inside', 34, 75, 25, 84),
  eye('saloon-room', 61, 52, 49, 44),
  eye('hotel-lobby', 86, 53, 82, 44),
  eye('church-nave', 117, 51, 117, 31),
  eye('jail-inside', 111, 76, 106, 86),
  eye('bank-vault', 72, 84, 64, 90),
  eye('depot-inside', 28, 118, 18, 111),
  eye('livery-stalls', 30, 52, 38, 38),
]
