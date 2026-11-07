/*
 * Out West app shell cache. The game is ~6 MB of models, textures and sound; on a phone that is
 * the slowest part of a cold load. The worker keeps everything under /experiments/out-west/ (and
 * the hashed /_astro/ bundles the page asks for) after the first visit, so launching from the
 * home screen is a cache read, and a repeat visit only revalidates the HTML.
 *
 * Bump VERSION when an unhashed file under public/experiments/out-west/ changes. The hashed
 * /_astro/ files carry their own names and never need a bump.
 */
const VERSION = 'ow-v2'
const CACHE = `out-west-${VERSION}`
const SHELL = [
  '/experiments/out-west/',
  '/experiments/out-west/manifest.webmanifest',
  '/experiments/out-west/icon-192.png',
  '/experiments/out-west/icon-512.png',
  '/experiments/out-west/icon-maskable-512.png',
  '/experiments/out-west/ui/paper.webp',
  '/experiments/out-west/ui/poster.webp',
  '/experiments/out-west/ui/wood.webp',
  '/experiments/out-west/ui/leather.webp',
  '/experiments/out-west/ui/seal.webp',
  '/experiments/out-west/ui/title-duel.svg',
  '/experiments/out-west/fonts/rye.woff2',
  '/experiments/out-west/fonts/ultra.woff2',
  '/experiments/out-west/fonts/eb-garamond.woff2',
  '/experiments/out-west/fonts/oswald-600.woff2',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // One missing file must not fail the whole install.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined))))
      // Do not skipWaiting: a new deploy takes over on the next launch, never mid-duel.
      .then(() => undefined),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('out-west-') && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

/** Assets that never change under their URL: the hashed bundles. */
const hashed = (path) => path.startsWith('/_astro/')

/** The static game files, the fonts and the UI art. */
const cacheable = (path) =>
  path.startsWith('/experiments/out-west/') ||
  path.startsWith('/_astro/') ||
  path.startsWith('/fonts/')

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') {
    return
  }
  // A media element's byte-range requests must go to the network (a partial response is not a
  // valid cache entry).
  if (req.headers.has('range')) {
    return
  }
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || !cacheable(url.pathname)) {
    return
  }

  // Navigations: network first, so a deploy is picked up; the cached shell is the offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            void caches.open(CACHE).then((cache) => cache.put(req, copy))
          }
          return res
        })
        .catch(async () => {
          const cache = await caches.open(CACHE)
          return (
            (await cache.match(req)) ||
            (await cache.match('/experiments/out-west/')) ||
            Response.error()
          )
        }),
    )
    return
  }

  // Hashed bundles: cache first forever. Unhashed game files: cache first, then refresh in the
  // background (stale-while-revalidate), so a long-lived install still picks up a new deploy.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const hit = await cache.match(req)
      if (hit) {
        if (!hashed(url.pathname)) {
          void fetch(req)
            .then((res) => {
              if (res.ok) {
                return cache.put(req, res)
              }
            })
            .catch(() => undefined)
        }
        return hit
      }
      try {
        const res = await fetch(req)
        if (res.ok) {
          void cache.put(req, res.clone())
        }
        return res
      } catch {
        return Response.error()
      }
    })(),
  )
})
