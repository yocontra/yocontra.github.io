export interface Experiment {
  slug: string
  title: string
  year: number
  blurb: string
  tags: readonly string[]
  /** Path under /public, or undefined to render a generated gradient card. */
  thumb?: string
  /** CSS hue (oklch) used to tint the card. */
  hue: number
  /** Hidden from the landing page teaser (still listed on /experiments). */
  unlisted?: boolean
}

export const experiments: readonly Experiment[] = []
