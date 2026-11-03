import { fragmentSource, vertexSource } from './shader'

const FALLBACK_BG = 'url("/experiments/hax/bg.gif")'
const MAX_DPR = 1.5
/** Drawing-buffer pixel budget; larger screens render at reduced resolution and upscale. */
const MAX_PIXELS = 1920 * 1200
/** Fixed time for the reduced-motion still frame (chosen because it looks good). */
const STILL_TIME = 14.2

type UniformName = 'uResolution' | 'uScale' | 'uTime' | 'uGlitch' | 'uSeed' | 'uBeat' | 'uPointer'
const UNIFORMS: readonly UniformName[] = [
  'uResolution',
  'uScale',
  'uTime',
  'uGlitch',
  'uSeed',
  'uBeat',
  'uPointer',
]

interface GlState {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  uniforms: Record<UniformName, WebGLUniformLocation | null>
}

interface Glitch {
  intensity: number
  seed: number
  beat: number
}

/** Deterministic 0..1 hash, so glitch timing is stable per beat. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/**
 * Glitch schedule, keyed to the box's 1s blink (on for the first half of each second).
 * Some beats burst as the box pops on, some as it vanishes, plus rare off-beat twitches.
 */
function glitchAt(blinkSeconds: number): Glitch {
  const beat = Math.floor(blinkSeconds)
  const phase = blinkSeconds - beat
  const step = Math.floor(blinkSeconds * 15)
  const seed = hash(step) * 1000
  const beatFlash = Math.max(0, 1 - phase / 0.2)

  let intensity = 0
  if (hash(beat) < 0.3 && phase < 0.22) intensity = 1 - phase / 0.22
  else if (hash(beat + 0.5) < 0.2 && phase >= 0.5 && phase < 0.62) intensity = 0.8
  else if (hash(step + 0.37) < 0.025) intensity = 0.35
  return { intensity, seed, beat: beatFlash }
}

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('hax: createShader failed')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`hax: shader compile failed\n${log ?? ''}`)
  }
  return shader
}

function setup(gl: WebGL2RenderingContext): GlState {
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  const program = gl.createProgram()
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`hax: program link failed\n${log ?? ''}`)
  }
  const vao = gl.createVertexArray()
  const uniforms = Object.fromEntries(
    UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]),
  ) as Record<UniformName, WebGLUniformLocation | null>
  return { program, vao, uniforms }
}

/** Seconds into the box's blink cycle, read from its CSS animation so bursts land on the blink. */
function blinkClock(box: Element | null): () => number {
  const anim = box
    ?.getAnimations()
    .find((a) => a instanceof CSSAnimation && a.animationName === 'blink')
  return () => {
    const ct = anim?.currentTime
    return (typeof ct === 'number' ? ct : performance.now()) / 1000
  }
}

/**
 * Mounts the shader background into `canvas`. Falls back to the original tiled gif when
 * WebGL2 is unavailable. Returns a disposer that stops rendering and frees GPU resources.
 */
export function mountBackground(canvas: HTMLCanvasElement, box: Element | null): () => void {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
    preserveDrawingBuffer: false,
  })

  const fallback = (): void => {
    canvas.hidden = true
    document.body.style.background = FALLBACK_BG
  }

  if (!gl) {
    fallback()
    return () => {}
  }

  let state: GlState
  try {
    state = setup(gl)
  } catch (err) {
    console.warn(err)
    fallback()
    return () => {}
  }

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  const clock = blinkClock(box)
  const start = performance.now()
  let raf = 0
  let scale = 1
  let lost = false
  let disposed = false
  const pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, presence: 0, target: 0 }
  let lastFrame = start
  let glitching = false

  const resize = (): void => {
    const rect = canvas.getBoundingClientRect()
    const w = Math.max(1, rect.width)
    const h = Math.max(1, rect.height)
    scale = Math.min(window.devicePixelRatio || 1, MAX_DPR)
    const budget = Math.sqrt(MAX_PIXELS / (w * h * scale * scale))
    if (budget < 1) scale *= budget
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
  }

  const draw = (time: number, glitch: Glitch): void => {
    if (lost) return
    const { program, vao, uniforms: u } = state
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.useProgram(program)
    gl.bindVertexArray(vao)
    gl.uniform2f(u.uResolution, canvas.width, canvas.height)
    gl.uniform1f(u.uScale, scale)
    gl.uniform1f(u.uTime, time)
    gl.uniform1f(u.uGlitch, glitch.intensity)
    gl.uniform1f(u.uSeed, glitch.seed)
    gl.uniform1f(u.uBeat, glitch.beat)
    gl.uniform3f(u.uPointer, pointer.x, pointer.y, pointer.presence)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  const drawStill = (): void => draw(STILL_TIME, { intensity: 0, seed: 0, beat: 0 })

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(0.1, (now - lastFrame) / 1000)
    lastFrame = now
    const ease = 1 - Math.exp(-dt * 4)
    pointer.x += (pointer.tx - pointer.x) * ease
    pointer.y += (pointer.ty - pointer.y) * ease
    pointer.presence += (pointer.target - pointer.presence) * ease
    const glitch = glitchAt(clock())
    const nowGlitching = glitch.intensity > 0.5
    if (nowGlitching !== glitching) {
      glitching = nowGlitching
      canvas.setAttribute('data-glitch', glitching ? '1' : '0')
    }
    draw((now - start) / 1000, glitch)
  }

  const animated = (): boolean => !motionQuery.matches && !document.hidden && !lost && !disposed

  const sync = (): void => {
    cancelAnimationFrame(raf)
    raf = 0
    if (disposed || lost) return
    if (animated()) {
      lastFrame = performance.now()
      raf = requestAnimationFrame(frame)
    } else if (motionQuery.matches) {
      drawStill()
    }
  }

  const observer = new ResizeObserver(() => {
    resize()
    // Resizing clears the buffer; repaint immediately so there is no flash.
    if (motionQuery.matches) drawStill()
  })
  observer.observe(canvas)

  const onPointerMove = (e: PointerEvent): void => {
    pointer.tx = e.clientX / window.innerWidth
    pointer.ty = 1 - e.clientY / window.innerHeight
    pointer.target = 1
  }
  const onPointerLeave = (): void => {
    pointer.target = 0
  }
  const onContextLost = (e: Event): void => {
    e.preventDefault()
    lost = true
    sync()
  }
  const onContextRestored = (): void => {
    try {
      state = setup(gl)
      lost = false
      sync()
    } catch (err) {
      console.warn(err)
      fallback()
    }
  }

  window.addEventListener('pointermove', onPointerMove, { passive: true })
  document.documentElement.addEventListener('pointerleave', onPointerLeave)
  document.addEventListener('visibilitychange', sync)
  motionQuery.addEventListener('change', sync)
  canvas.addEventListener('webglcontextlost', onContextLost)
  canvas.addEventListener('webglcontextrestored', onContextRestored)

  resize()
  sync()

  return () => {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(raf)
    observer.disconnect()
    window.removeEventListener('pointermove', onPointerMove)
    document.documentElement.removeEventListener('pointerleave', onPointerLeave)
    document.removeEventListener('visibilitychange', sync)
    motionQuery.removeEventListener('change', sync)
    canvas.removeEventListener('webglcontextlost', onContextLost)
    canvas.removeEventListener('webglcontextrestored', onContextRestored)
    if (!lost) {
      gl.deleteVertexArray(state.vao)
      gl.deleteProgram(state.program)
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
