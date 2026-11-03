export interface Role {
  company: string
  href?: string
  title: string
  /** Display years, e.g. "2021 — 2024". Omitted when unknown. */
  years?: string
  blurb?: string
}

export const career: readonly Role[] = [
  {
    company: 'Apple',
    title: 'Software Engineer · SEAR',
    years: '2024 — 2026',
    blurb:
      'Worked on macOS and iOS security in SEAR, building tools and infrastructure. Not much more I can say about it.',
  },
  {
    company: 'CreateSafe',
    href: 'https://createsafe.io',
    title: 'Head of Engineering',
    years: '2021 — 2024',
    blurb:
      'Led engineering and research for a platform helping independent musicians with distribution, royalties and fan engagement, plus some early generative audio work.',
  },
  {
    company: 'Stae',
    href: 'https://stae.co/',
    title: 'Co-founder / CTO',
    years: '2016 — 2021',
    blurb:
      'Co-founded a civic data company and built its data, analytics and GIS platform, used by city and county governments in North America.',
  },
  {
    company: 'Charmed',
    href: 'https://becharmed.co/',
    title: 'TODO: role',
  },
  {
    company: 'Factory X',
    href: 'http://fact0ryx.com/',
    title: 'Engineering Lead',
    years: '2014 — 2016',
    blurb: 'Built prototypes and products alongside large companies as part of a venture studio.',
  },
  {
    company: 'Fractal',
    href: 'http://wearefractal.com',
    title: 'Co-founder / CTO',
    years: '2010 — 2014',
    blurb: 'Co-founded a small consultancy building products for companies and startups.',
  },
  {
    company: 'Bechtel',
    title: 'API Infrastructure Engineer',
    years: '2012 — 2013',
    blurb:
      'Worked on API gateways, internal API standards, and a portal for exploring internal data.',
  },
]

export const stack: readonly string[] = [
  'TypeScript',
  'Node.js',
  'Bun',
  'React',
  'React Native',
  'Python',
  'Postgres',
  'PostGIS',
  'WebGPU',
  'C / C++',
  'Swift',
  'Kubernetes',
  'Pulumi',
  'CoreML',
  'WebRTC',
  'GIS',
]

export const socials = [
  { label: 'Email', href: 'mailto:yo@contra.io' },
  { label: 'GitHub', href: 'https://github.com/yocontra' },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/in/ericschoffstall' },
  { label: 'Twitter', href: 'https://twitter.com/contrahacks' },
  { label: 'Instagram', href: 'https://instagram.com/yungcontra' },
] as const
