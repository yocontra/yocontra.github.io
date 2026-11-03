import { type Backend, type BackendKind, createWebGL2, createWebGPU } from './backends'
import {
  defaultParams,
  type FrameState,
  type HeroParams,
  packUniforms,
  UNIFORM_FLOATS,
} from './params'

export { defaultParams, type HeroParams, paramRanges } from './params'

export interface HeroOptions {
  params?: Partial<HeroParams>
  /** Render a single frame and stop (reduced motion). */
  still?: boolean
  /** Element whose scroll-out drives the `scroll` uniform. Defaults to the canvas. */
  scrollTarget?: Element
  /** Force a backend (playground). */
  prefer?: BackendKind
  /** Max device pixel ratio before the adaptive scale kicks in. */
  maxDpr?: number
}

export interface HeroHandle {
  readonly backend: BackendKind
  /** Live, mutable params — changes apply next frame. */
  readonly params: HeroParams
  /** Current fraction of native resolution being rendered (adaptive). */
  readonly resolution: number
  /** Smoothed frame time in ms. */
  readonly frameMs: number
  /** Re-render once (useful when paused / still). */
  redraw(): void
  destroy(): void
}

async function createBackend(
  canvas: HTMLCanvasElement,
  prefer?: BackendKind,
): Promise<Backend | null> {
  if (prefer !== 'webgl2') {
    try {
      const gpu = await createWebGPU(canvas)
      if (gpu) return gpu
    } catch (error) {
      console.warn('[hero] WebGPU unavailable, falling back to WebGL2', error)
    }
    if (prefer === 'webgpu') return null
  }
  try {
    return createWebGL2(canvas)
  } catch (error) {
    console.warn('[hero] WebGL2 unavailable', error)
    return null
  }
}

export async function mountHero(
  canvas: HTMLCanvasElement,
  options: HeroOptions = {},
): Promise<HeroHandle | null> {
  const backend = await createBackend(canvas, options.prefer)
  if (!backend) return null

  const params: HeroParams = { ...defaultParams, ...options.params }
  const uniforms = new Float32Array(UNIFORM_FLOATS)
  const maxDpr = options.maxDpr ?? 1.5
  const scrollTarget = options.scrollTarget ?? canvas

  const state: FrameState = {
    width: 1,
    height: 1,
    mouseX: 0.25,
    mouseY: 0.1,
    velX: 0,
    velY: 0,
    time: 18,
    phase: 18 * params.speed,
    scroll: 0,
  }

  // Pointer, smoothed toward target.
  let targetX = state.mouseX
  let targetY = state.mouseY
  let resolution = 0.75
  let frameMs = 16.7
  let slowFrames = 0
  let fastFrames = 0
  let visible = true
  let raf = 0
  let last = performance.now()
  let destroyed = false

  const resize = () => {
    const rect = canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr) * resolution
    const w = Math.max(1, Math.round(rect.width * dpr))
    const h = Math.max(1, Math.round(rect.height * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    state.width = w
    state.height = h
  }

  const onPointer = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect()
    targetX = (event.clientX - rect.left - rect.width / 2) / rect.height
    targetY = (rect.height / 2 - (event.clientY - rect.top)) / rect.height
  }

  const onOrientation = (event: DeviceOrientationEvent) => {
    if (event.gamma === null || event.beta === null) return
    targetX = Math.max(-0.8, Math.min(0.8, event.gamma / 45))
    targetY = Math.max(-0.5, Math.min(0.5, (45 - event.beta) / 60))
  }

  const updateScroll = () => {
    const rect = scrollTarget.getBoundingClientRect()
    state.scroll = Math.max(0, Math.min(1, -rect.top / Math.max(1, rect.height)))
  }

  let settled = false
  const render = (force = false) => {
    resize()
    updateScroll()
    // Once the field has fully faded out behind the page, stop spending GPU time on it.
    const faded = state.scroll >= 1
    if (faded && settled && !force) return
    settled = faded
    backend.draw(packUniforms(uniforms, state, params))
  }

  const adapt = (dt: number) => {
    frameMs += (dt - frameMs) * 0.05
    if (frameMs > 24) slowFrames++
    else slowFrames = 0
    if (frameMs < 17.5) fastFrames++
    else fastFrames = 0
    if (slowFrames > 30 && resolution > 0.35) {
      resolution = Math.max(0.35, resolution * 0.85)
      slowFrames = 0
    } else if (fastFrames > 180 && resolution < 1) {
      resolution = Math.min(1, resolution * 1.1)
      fastFrames = 0
    }
  }

  const tick = (now: number) => {
    raf = 0
    if (destroyed) return
    const dt = Math.min(100, now - last)
    last = now
    adapt(dt)

    const k = 1 - Math.exp(-dt / 90)
    const nx = state.mouseX + (targetX - state.mouseX) * k
    const ny = state.mouseY + (targetY - state.mouseY) * k
    const inst = 1000 / Math.max(dt, 1)
    state.velX += ((nx - state.mouseX) * inst - state.velX) * 0.15
    state.velY += ((ny - state.mouseY) * inst - state.velY) * 0.15
    state.mouseX = nx
    state.mouseY = ny
    state.time += dt / 1000
    state.phase += (dt / 1000) * params.speed

    render()
    if (visible && !document.hidden) raf = requestAnimationFrame(tick)
  }

  const start = () => {
    if (options.still || raf || destroyed) return
    last = performance.now()
    raf = requestAnimationFrame(tick)
  }

  const stop = () => {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  const io = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true
    if (visible) start()
    else stop()
  })
  io.observe(canvas)

  const onVisibility = () => (document.hidden ? stop() : start())
  const ro = new ResizeObserver(() => {
    if (!raf) render(true)
  })
  ro.observe(canvas)

  window.addEventListener('pointermove', onPointer, { passive: true })
  window.addEventListener('deviceorientation', onOrientation, { passive: true })
  document.addEventListener('visibilitychange', onVisibility)

  render(true)
  start()

  return {
    backend: backend.kind,
    params,
    get resolution() {
      return resolution
    },
    get frameMs() {
      return frameMs
    },
    redraw: () => render(true),
    destroy() {
      destroyed = true
      stop()
      io.disconnect()
      ro.disconnect()
      window.removeEventListener('pointermove', onPointer)
      window.removeEventListener('deviceorientation', onOrientation)
      document.removeEventListener('visibilitychange', onVisibility)
      backend.destroy()
    },
  }
}
