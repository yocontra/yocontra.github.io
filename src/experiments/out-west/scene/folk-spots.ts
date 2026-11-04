/**
 * Where the townsfolk stand on the main street: each one's porch, balcony or doorway, his habit
 * there and the door he runs for. Other arenas move the same people (`FolkPlace`, scene/arenas).
 */
import type { BodyKey } from '../data/outlaws.ts'
import { DECK, STREET } from './street.ts'

export type Habit = 'whittle' | 'sit' | 'lean' | 'rail' | 'door' | 'stand'

export interface Spot {
  name: string
  base: BodyKey
  /** Where he stands or sits (feet, or the bench seat under him), and the way he faces. */
  x: number
  y: number
  z: number
  yaw: number
  habit: Habit
  /** Where he goes indoors (a door on his porch), or null: he stays and ducks. */
  door: readonly [number, number] | null
  /** The floor he runs indoors on (default the boardwalk's deck). */
  floor?: number
  /** The x of the lane he runs along to his door (default just inside the porch posts). */
  lane?: number
}

/** Where one of the townsfolk stands in another arena (scene/arenas): his spot, minus his name. */
export type FolkPlace = Omit<Spot, 'name' | 'base'>

/** Faces the street from the right (+x) or left (-x) boardwalk. */
const FACE_R = -Math.PI / 2
const FACE_L = Math.PI / 2
/** A bench seat's height above the deck (the kit bench). */
const SEAT = 0.42
/** The porch roof's top, where the balcony folk stand. */
const ROOF = 3.16
const H = STREET.half

/**
 * In tier order (the floor tier takes the first four, medium seven, high all nine): those in the
 * standoff's frame first, up the street beyond the outlaw.
 */
export const SPOTS: readonly Spot[] = [
  {
    name: 'Clara Bell',
    base: 'woman',
    x: 9.75,
    y: ROOF,
    z: 14,
    yaw: FACE_R,
    habit: 'rail',
    door: null,
  },
  {
    name: 'Walt Greer',
    base: 'worker',
    x: 9.43,
    y: DECK,
    z: 19.85,
    yaw: FACE_R - 0.35,
    habit: 'lean',
    door: [H + 2.05, 15],
  },
  {
    name: 'Ned Calloway',
    base: 'rugged',
    x: -10.4,
    y: DECK,
    z: 27.5,
    yaw: FACE_L - 0.3,
    habit: 'stand',
    door: [-(H + 2.05), 30],
  },
  {
    name: 'Ezra Dunn',
    base: 'rugged',
    x: -9.75,
    y: ROOF,
    z: 19.6,
    yaw: FACE_L,
    habit: 'rail',
    door: null,
  },
  {
    name: 'Amos Whitlock',
    base: 'worker',
    x: 10.72,
    y: DECK + SEAT,
    z: 11.3,
    yaw: FACE_R,
    habit: 'whittle',
    door: [H + 2.05, 15],
  },
  {
    name: 'Silas Moon',
    base: 'suit',
    x: 10.85,
    y: DECK,
    z: 3.05,
    yaw: FACE_R - 0.4,
    habit: 'door',
    door: [H + 2.1, 2],
  },
  {
    name: 'Hattie Crane',
    base: 'woman',
    x: -10.72,
    y: DECK + SEAT,
    z: 14.3,
    yaw: FACE_L,
    habit: 'sit',
    door: [-(H + 2.05), 18],
  },
  {
    name: 'Jed Pruitt',
    base: 'casual',
    x: -9.43,
    y: DECK,
    z: 7.55,
    yaw: FACE_L + 0.35,
    habit: 'lean',
    door: [-(H + 2.05), 5.5],
  },
  {
    name: 'Old Tom Bixby',
    base: 'casual',
    x: -10.72,
    y: DECK + SEAT,
    z: -2.8,
    yaw: FACE_L,
    habit: 'sit',
    door: null,
  },
]
