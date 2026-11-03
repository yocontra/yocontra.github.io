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
    title: 'Staff Full Stack Engineer · SEAR',
    years: '2024 — 2026',
    blurb:
      'Technical lead in Security Engineering & Architecture, securing macOS and iOS against nation-state malware. Built customer-facing products and infrastructure serving billions of devices, often solo from zero. Can’t say more. The only KPI was the number of unhacked phones and laptops.',
  },
  {
    company: 'CreateSafe',
    href: 'https://createsafe.io',
    title: 'Head of Engineering',
    years: '2021 — 2024',
    blurb:
      'Led engineering and research while building tools to replace the functions of a record label: marketing, fan engagement, distribution, royalties and payments. Shipped generative music AI, audio analysis and voice cloning, training and hosting custom models at scale.',
  },
  {
    company: 'Stae',
    href: 'https://stae.co/',
    title: 'Co-founder / CTO',
    years: '2016 — 2021',
    blurb:
      'Raised ~$5M and, as founder and primary engineer, built a complete data warehousing, analytics, GIS, open data and city planning platform. Sold to and deployed in cities and counties across North America.',
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
    blurb:
      'Taught Fortune 500 companies rapid prototyping by doing it. Six full products in one year inside a venture studio.',
  },
  {
    company: 'Fractal',
    href: 'http://wearefractal.com',
    title: 'Co-founder / CTO',
    years: '2010 — 2014',
    blurb:
      'Co-founded and led engineering at a consultancy that shipped 30+ complete products for large companies and freshly funded startups.',
  },
  {
    company: 'Bechtel',
    title: 'API Infrastructure Engineer',
    years: '2012 — 2013',
    blurb:
      'High-performance API gateways across business units, internal API standards, and a portal for exploring the company’s data assets.',
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
