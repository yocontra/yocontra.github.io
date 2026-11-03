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
  /** Span two columns. */
  wide?: boolean
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
    name: 'react-responsive',
    href: 'https://github.com/yocontra/react-responsive',
    blurb: 'Media queries for React, as components or hooks.',
    source: 'yocontra/react-responsive',
    stars: 7182,
    npm: 'react-responsive',
    wide: true,
  },
  {
    name: 'genome.js',
    href: 'http://genomejs.com/',
    blurb: 'Tools for exploring your own DNA data with JavaScript.',
    source: 'org:genomejs',
    stars: 600,
  },
  {
    name: 'gulp-concat',
    href: 'https://github.com/gulp-community/gulp-concat',
    blurb: 'Concatenates files. Small, boring, and very widely used.',
    source: 'gulp-community/gulp-concat',
    stars: 775,
    npm: 'gulp-concat',
  },
  {
    name: 'windows_98.css',
    href: 'https://github.com/yocontra/windows_98.css',
    blurb: 'Some sick styles for your guestbook.',
    source: 'yocontra/windows_98.css',
    stars: 789,
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
