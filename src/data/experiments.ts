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

export const experiments: readonly Experiment[] = [
  {
    slug: 'flow',
    title: 'Flow',
    year: 2026,
    blurb:
      'A playground for the shader behind this site’s homepage. Tweak it, randomize it, share the URL.',
    tags: ['webgpu', 'webgl2', 'shader'],
    thumb: '/experiments/flow/thumb.webp',
    hue: 150,
  },
  {
    slug: 'out-west',
    title: 'out west',
    year: 2019,
    blurb:
      'Walk your paces, wait for the call, and outdraw seventeen outlaws before they outdraw you.',
    tags: ['game', 'canvas', 'audio'],
    thumb: '/experiments/out-west/thumb.webp',
    hue: 25,
  },
  {
    slug: 'hax',
    title: 'You Got Hacked',
    year: 2021,
    blurb: 'A prank page. Blinking red, looping audio, zero chill.',
    tags: ['prank', 'css', 'audio'],
    hue: 0,
    thumb: '/experiments/hax/thumb.webp',
    unlisted: true,
  },
]
