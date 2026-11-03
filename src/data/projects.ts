export interface Project {
  name: string
  href: string
  blurb: string
  /** GitHub `owner/repo` for live stars, or `org:<name>` to sum an org. */
  source?: string
  /** Fallback star count when the API is unavailable at build time. */
  stars?: number
  npm?: string
  tag?: string
  featured?: boolean
}

export const projects: readonly Project[] = [
  {
    name: 'gulp.js',
    href: 'https://gulpjs.com/',
    blurb:
      'The streaming build system. Over a million installs a week, used by thousands of companies to build and ship their code.',
    source: 'gulpjs/gulp',
    stars: 32916,
    npm: 'gulp',
    featured: true,
  },
  {
    name: 'genome.js',
    href: 'http://genomejs.com/',
    blurb: 'Open-source toolkit for exploring your own DNA with JavaScript.',
    source: 'org:genomejs',
    stars: 600,
  },
  {
    name: 'rtc-everywhere',
    href: 'http://rtc.works/',
    blurb: 'Cross-everything WebRTC mega-project.',
    source: 'yocontra/rtc-everywhere',
    stars: 653,
  },
  {
    name: 'shasta',
    href: 'http://shasta.tools/',
    blurb: 'Dead simple, opinionated toolkit for building Redux + React applications.',
    source: 'shastajs/shasta',
    stars: 506,
  },
  {
    name: 'pg_accel',
    href: 'https://github.com/yocontra/pg_accel',
    blurb: 'Experiment: Postgres, on the GPU.',
    source: 'yocontra/pg_accel',
    tag: 'new',
  },
]

export const moreProjectsHref = 'https://github.com/wearefractal'
