/**
 * Per-mode shot presentation: duels keep their cinematic look, Frontier reads at mobile range.
 * Tracer widths are metres per metre of camera distance, so a streak keeps a few pixels at range.
 */
export interface ShotStyle {
  width: number
  minWidth: number
  maxWidth: number
  length: number
  lead: number
  opacity: number
  flashSeconds: number
  dust: number
  dustSeconds: number
  dustGrowth: number
  dustColor: readonly [number, number, number]
  puffOpacity: number
  blood: number
  spark: number
  /** Frontier impacts use authored puff/spark sprites; duels keep the ambient dust. */
  sprites: boolean
  standoff: number
}
export const DUEL_STYLE: ShotStyle = {
  width: 0,
  minWidth: 0.0045,
  maxWidth: 0.0045,
  length: 0.45,
  lead: 0.12,
  opacity: 0.7,
  flashSeconds: 0.035,
  dust: 0.12,
  dustSeconds: 0.16,
  dustGrowth: 1,
  dustColor: [0.62, 0.54, 0.42],
  puffOpacity: 0.8,
  blood: 0.09,
  spark: 0,
  sprites: false,
  standoff: 0,
}
export const FRONTIER_STYLE: ShotStyle = {
  width: 0.0045,
  minWidth: 0.012,
  maxWidth: 0.06,
  length: 2.4,
  lead: 1.5,
  opacity: 0.95,
  flashSeconds: 0.05,
  dust: 0.8,
  dustSeconds: 0.42,
  dustGrowth: 1.2,
  dustColor: [0.8, 0.74, 0.64],
  puffOpacity: 0.95,
  blood: 0.3,
  spark: 0.8,
  sprites: true,
  standoff: 0.12,
}
