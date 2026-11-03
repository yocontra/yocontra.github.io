const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

/** Animates numbers from 0 to their final value the first time they scroll into view. */
export function countUp(elements: NodeListOf<HTMLElement>): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        io.unobserve(entry.target)
        animate(entry.target as HTMLElement)
      }
    },
    { threshold: 0.6 },
  )
  for (const el of elements) io.observe(el)
}

function animate(el: HTMLElement): void {
  const target = Number(el.dataset.count)
  const display = el.dataset.display ?? String(target)
  if (!Number.isFinite(target)) return
  const suffix = display.endsWith('+') ? '+' : ''
  const useCompact = /[KMB]$/.test(display)
  const duration = 1400
  const start = performance.now()

  const frame = (now: number) => {
    const t = Math.min(1, (now - start) / duration)
    const eased = 1 - (1 - t) ** 4
    const value = target * eased
    el.textContent =
      t >= 1 ? display : `${useCompact ? compact.format(value) : Math.round(value)}${suffix}`
    if (t < 1) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}
