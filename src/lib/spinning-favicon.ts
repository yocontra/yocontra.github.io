/**
 * Spins the face favicon around its Y axis. Firefox animates the SVG favicon natively;
 * every other browser gets frames drawn to a canvas and swapped into the <link>.
 */
const SIZE = 64
const FPS = 20
const PERIOD_MS = 2400

export function spinFavicon(src = '/face.png'): void {
  if (navigator.userAgent.includes('Firefox')) {
    return
  }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return
  }

  // biome-ignore lint/security/noSecrets: a CSS selector, not a credential
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!(link && ctx)) {
    return
  }

  const img = new Image()
  img.src = src
  img.addEventListener('load', () => {
    link.type = 'image/png'
    let timer: ReturnType<typeof setInterval> | undefined

    const frame = () => {
      const angle = ((performance.now() % PERIOD_MS) / PERIOD_MS) * Math.PI * 2
      const sx = Math.cos(angle)
      ctx.clearRect(0, 0, SIZE, SIZE)
      ctx.save()
      ctx.translate(SIZE / 2, 0)
      // Keep a sliver visible edge-on so it never fully disappears.
      ctx.scale(Math.sign(sx || 1) * Math.max(Math.abs(sx), 0.06), 1)
      ctx.drawImage(img, -SIZE / 2, 0, SIZE, SIZE)
      ctx.restore()
      link.href = canvas.toDataURL('image/png')
    }

    const start = () => {
      if (timer === undefined) {
        timer = globalThis.setInterval(frame, 1000 / FPS)
      }
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
}
