/**
 * The app-shell service worker (`public/experiments/out-west/sw.js`). Production only: a worker
 * in development would cache Vite's module URLs and make hot reload lie. The scope is the game's
 * own path, so the rest of the site is untouched.
 */
export function registerServiceWorker(): void {
  if (!(import.meta.env.PROD && 'serviceWorker' in navigator)) {
    return
  }
  void (async () => {
    try {
      const reg = await navigator.serviceWorker.register('/experiments/out-west/sw.js', {
        scope: '/experiments/out-west/',
      })
      // A new deploy is picked up on the next launch; never reload under a player mid-duel.
      try {
        await reg.update()
      } catch {
        // offline, or the worker is already the newest
      }
    } catch {
      // no service worker (private mode, old browser): the game still works
    }
  })()
}
