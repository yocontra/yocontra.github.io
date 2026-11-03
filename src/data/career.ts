export interface Role {
  company: string
  href?: string
  title: string
  /** Display years, e.g. "2021 — 2024". Omitted when unknown. */
  years?: string
  location?: string
  blurb?: string
}

export const career: readonly Role[] = [
  {
    company: 'Veil Labs',
    href: 'https://appari.sh',
    title: 'Co-founder',
    years: '2026 — now',
    location: 'Phoenix',
    blurb:
      'A game studio building AI-native game experiences. Our first game is Apparish, a location-based ghost hunting game for iOS and Android.',
  },
  {
    company: 'Plaza',
    href: 'https://plaza.fyi',
    title: 'Co-founder',
    years: '2026 — now',
    location: 'Phoenix',
    blurb:
      'A way for AI agents to work with the physical world: geocoding, routing, search and more across the entire OpenStreetMap planet, as an API and MCP server.',
  },
  {
    company: 'Trigram',
    href: 'https://trigram.co',
    title: 'Consultant',
    years: '2026 — now',
    location: 'Phoenix',
    blurb:
      'A small collective of senior engineers. I help companies with architecture, infrastructure, and getting products from zero to one.',
  },
  {
    company: 'Apple',
    title: 'Senior Staff Engineer · SEAR',
    years: '2024 — 2026',
    location: 'Cupertino / SF',
    blurb:
      'Worked on macOS and iOS security in SEAR: anti-malware, the next generation of sandboxing, and a platform for running AI agents at scale.',
  },
  {
    company: 'CreateSafe',
    href: 'https://createsafe.io',
    title: 'Head of Engineering',
    years: '2021 — 2024',
    location: 'Los Angeles',
    blurb:
      'Led engineering and research for a platform helping independent musicians with distribution, royalties and fan engagement, plus some early generative audio work.',
  },
  {
    company: 'Stae',
    href: 'https://stae.co/',
    title: 'Co-founder / CTO',
    years: '2016 — 2021',
    location: 'New York',
    blurb:
      'Co-founded a civic data company and built its data, analytics and GIS platform, used by city and county governments in North America.',
  },
  {
    company: 'Charmed',
    href: 'https://becharmed.co/',
    title: 'Co-founder / CTO',
    years: '2015 — 2016',
    location: 'San Francisco',
    blurb: 'A video speed dating app for iOS and desktop.',
  },
  {
    company: 'Factory X',
    href: 'http://fact0ryx.com/',
    title: 'Engineering Lead',
    years: '2014 — 2016',
    location: 'San Francisco',
    blurb: 'Built prototypes and products alongside large companies as part of a venture studio.',
  },
  {
    company: 'Fractal',
    href: 'http://wearefractal.com',
    title: 'Co-founder / CTO',
    years: '2010 — 2014',
    location: 'Phoenix',
    blurb: 'Co-founded a small consultancy building products for companies and startups.',
  },
  {
    company: 'Bechtel',
    href: 'https://www.bechtel.com',
    title: 'API Infrastructure Engineer',
    years: '2012 — 2013',
    location: 'Phoenix',
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
