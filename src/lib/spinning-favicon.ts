/**
 * Spins the face favicon around its Y axis on every page. Firefox animates the SVG favicon
 * natively; everywhere else, one full turn is rendered once (in a worker) into cached frames, and the
 * page just cycles the <link> through them. Steady-state cost is one attribute swap per frame, with
 * no canvas encoding on the main thread, so it is safe on game pages.
 *
 * Skipped when it can't be seen or isn't wanted: reduced motion, inside the native app's WebView,
 * and on pages that set `data-static-favicon` on <html> (benchmarks).
 */
import { isNativeShell } from '~/experiments/out-west/platform/bridge.ts'

const FRAMES = 24
const PERIOD_MS = 2400

export function spinFavicon(src = '/face.png'): void {
  const skip =
    navigator.userAgent.includes('Firefox') ||
    matchMedia('(prefers-reduced-motion: reduce)').matches ||
    isNativeShell() ||
    document.documentElement.hasAttribute('data-static-favicon') ||
    typeof OffscreenCanvas === 'undefined'
  if (skip) {
    return
  }
  // biome-ignore lint/security/noSecrets: a CSS selector, not a credential
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    return
  }

  const worker = new Worker(new URL('./favicon.worker.ts', import.meta.url), { type: 'module' })
  worker.addEventListener('message', (event: MessageEvent<{ blobs: Blob[] }>) => {
    worker.terminate()
    const urls = event.data.blobs.map((blob) => URL.createObjectURL(blob))
    if (urls.length === 0) {
      return
    }
    link.type = 'image/png'
    let frame = 0
    let timer: ReturnType<typeof setInterval> | undefined
    const tick = () => {
      frame = (frame + 1) % urls.length
      link.href = urls[frame] ?? link.href
    }
    const start = () => {
      timer ??= globalThis.setInterval(tick, PERIOD_MS / urls.length)
    }
    const stop = () => {
      globalThis.clearInterval(timer)
      timer = undefined
    }
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()))
    if (!document.hidden) {
      start()
    }
  })
  worker.postMessage({ src: new URL(src, location.href).href, frames: FRAMES })
}
