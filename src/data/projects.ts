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
    blurb: 'A streaming build system for JavaScript. Still maintained by a great group of folks.',
    source: 'gulpjs/gulp',
    stars: 32916,
    npm: 'gulp',
    featured: true,
  },
  {
    name: 'genome.js',
    href: 'http://genomejs.com/',
    blurb: 'Tools for exploring your own DNA data with JavaScript.',
    source: 'org:genomejs',
    stars: 600,
  },
  {
    name: 'rtc-everywhere',
    href: 'http://rtc.works/',
    blurb: 'One WebRTC API that works across browsers, Node, and mobile.',
    source: 'yocontra/rtc-everywhere',
    stars: 653,
  },
  {
    name: 'shasta',
    href: 'http://shasta.tools/',
    blurb: 'An opinionated toolkit for building React + Redux apps.',
    source: 'shastajs/shasta',
    stars: 506,
  },
  {
    name: 'pg_accel',
    href: 'https://github.com/yocontra/pg_accel',
    blurb: 'An experiment: running parts of Postgres on the GPU.',
    source: 'yocontra/pg_accel',
    tag: 'new',
  },
]

export const moreProjectsHref = 'https://github.com/wearefractal'
