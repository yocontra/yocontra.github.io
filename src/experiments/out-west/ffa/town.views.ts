/**
 * Camera views of Perdition for visual QA captures (dev screenshots only; the game never imports
 * this): eye-level walks down every street and alley, interiors and overviews. Layout
 * metres from `town.layout.json`, y up; `tests/content-playcanvas/frontier-views.test.ts` keeps
 * every street eye out of the buildings and every interior eye inside its building.
 */
export interface TownView {
  name: string
  from: [number, number, number]
  to: [number, number, number]
  fov?: number
  /** The hollow building this view stands in; street views stand outside every building. */
  inside?: string
}

/** A third-person camera's height over the ground (a rider's eyes are ~1.6 m). */
const EYE = 1.7

// biome-ignore lint/complexity/useMaxParams: a view is two ground points, positional like the layout
const eye = (name: string, x0: number, z0: number, x1: number, z1: number): TownView => ({
  name,
  from: [x0, EYE, z0],
  to: [x1, EYE * 0.85, z1],
})
// biome-ignore lint/complexity/useMaxParams: as `eye`, plus the building it stands in
const room = (name: string, inside: string, x0: number, z0: number, x1: number, z1: number) => ({
  ...eye(name, x0, z0, x1, z1),
  inside,
})

export const FRONTIER_VIEWS: TownView[] = [
  { name: 'over-top', from: [52, 48, 53], to: [52, 0, 52], fov: 55 },
  { name: 'over-nw', from: [8, 30, 8], to: [52, 0, 52], fov: 55 },
  { name: 'over-se', from: [96, 30, 96], to: [52, 0, 52], fov: 55 },
  { name: 'over-bank', from: [46, 22, 36], to: [46, 0, 68], fov: 55 },
  // main street, both ways and down each boardwalk
  eye('main-west-east', 4, 52, 60, 52),
  eye('main-east-west', 100, 52, 44, 52),
  eye('main-north-boardwalk', 6, 45, 60, 45),
  eye('main-south-boardwalk', 98, 59, 50, 59),
  eye('main-arrival', 52, 52, 20, 47),
  // the backlot road, the church gap and the creek
  eye('backlot-west-east', 4, 21, 100, 21),
  eye('backlot-east-west', 100, 21, 4, 21),
  eye('church-gap-north', 63, 50, 63, 6),
  eye('church-gap-south', 63, 8, 63, 52),
  eye('bridge', 52, 10, 52, -6),
  eye('creek-west', 48, 4.5, 22, 3),
  eye('creek-east', 56, 4.5, 100, 3),
  // the rail service road and the yard
  eye('rail-west-east', 4, 80.5, 100, 80.5),
  eye('rail-east-west', 98, 79, 4, 80.5),
  eye('depot-platform', 13, 94.5, 34, 94.5),
  eye('track-east', 46, 96.5, 90, 99),
  eye('stock-shed', 88, 92, 95, 98),
  // the bank from every side
  eye('bank-north', 48, 52, 46, 62),
  room('bank-lobby', 'bank', 46, 61.5, 46, 75),
  eye('bank-west-alley', 34.5, 79, 34.5, 57),
  eye('bank-east-alley', 57.5, 79, 57.5, 57),
  eye('bank-south', 46, 80.5, 46, 74),
  // back lots and alleys
  eye('corral', 23, 11, 8, 12),
  eye('livery-saloon-alley', 21.5, 21, 21.5, 50),
  eye('saloon-back', 27, 20, 44, 21),
  eye('hotel-back', 43.5, 21, 64, 23),
  eye('cemetery', 80, 17, 68, 10),
  eye('jail-yard', 88, 79, 97, 75),
  eye('water-tower', 88, 80, 92, 88),
  eye('east-lot', 101, 44, 90, 30),
  // facades and close-ups
  eye('facade-saloon', 36, 52, 30, 44),
  eye('facade-store', 64, 52, 69, 60),
  eye('trough-corral', 11, 10, 7.5, 13.5),
  { name: 'bank-deposits', from: [46, 1.7, 64], to: [46, 2.2, 70], inside: 'bank' },
  eye('coach-close', 70, 88, 78, 87.5),
  eye('wagon-close', 17, 18, 9.5, 15),
  eye('ads-alley', 21.5, 50, 21.5, 26),
  { name: 'sign-saloon', from: [32, 2.5, 49], to: [32, 4.5, 44] },
  { name: 'sign-store', from: [68, 2.5, 55], to: [68, 4.2, 60] },
  // interiors
  room('saloon-bar', 'saloon', 30, 41, 38, 30),
  { name: 'saloon-room', from: [26, 5, 27], to: [36, 4.6, 36], inside: 'saloon' },
  room('store-inside', 'general_store', 62, 62, 74, 72),
  room('smithy-inside', 'smithy', 30, 62, 22, 70),
  room('hotel-lobby', 'hotel', 52, 42, 50, 30),
  room('church-nave', 'church', 72, 42, 72, 25),
  room('jail-inside', 'jail', 90, 62, 82, 71),
  room('bank-vault', 'bank', 46, 72, 53, 77),
  room('depot-inside', 'depot', 28, 85, 12, 91),
  room('livery-stalls', 'livery', 17, 42, 7, 27),
  room('undertaker-inside', 'undertaker', 48, 84, 38, 92),
  room('barn-inside', 'hay_barn', 56, 84, 66, 90),
]
