/** Browser-only recording, reusable through addInitScript or the simulator's Web Inspector. */
export function installFrameRecorder(): void {
  if (Reflect.has(globalThis, '__owFrameRecorder')) {
    return
  }
  performance.setResourceTimingBufferSize(10_000)
  const contexts: (WebGLRenderingContext | WebGL2RenderingContext)[] = []
  const audio: AudioContext[] = []
  const allocations: Record<string, { created: number; deleted: number }> = {}
  const seen = new WeakSet<object>()
  const originalContext = HTMLCanvasElement.prototype.getContext
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value(this: HTMLCanvasElement, ...args: unknown[]) {
      const context = Reflect.apply(originalContext, this, args)
      if (
        (context instanceof WebGLRenderingContext || context instanceof WebGL2RenderingContext) &&
        !seen.has(context)
      ) {
        seen.add(context)
        contexts.push(context)
        for (const kind of [
          'Buffer',
          'Texture',
          'Program',
          'Shader',
          'Framebuffer',
          'Renderbuffer',
        ]) {
          allocations[kind] ??= { created: 0, deleted: 0 }
          const balance = allocations[kind]
          const live = new WeakSet<object>()
          for (const operation of ['create', 'delete'] as const) {
            const key = `${operation}${kind}`
            const method = Reflect.get(context, key)
            if (typeof method !== 'function') {
              continue
            }
            Reflect.set(
              context,
              key,
              new Proxy(method, {
                apply(target, receiver, parameters) {
                  const result = Reflect.apply(target, receiver, parameters)
                  if (operation === 'create' && result) {
                    live.add(result)
                    balance.created++
                  } else if (operation === 'delete' && parameters[0] && live.has(parameters[0])) {
                    live.delete(parameters[0])
                    balance.deleted++
                  }
                  return result
                },
              }),
            )
          }
        }
      }
      return context
    },
  })
  const OriginalAudio = globalThis.AudioContext
  if (OriginalAudio) {
    globalThis.AudioContext = new Proxy(OriginalAudio, {
      construct(target, args, newTarget) {
        const context = Reflect.construct(target, args, newTarget) as AudioContext
        audio.push(context)
        return context
      },
    })
  }
  const inputs: { at: number; type: string; key?: string; x?: number; y?: number }[] = []
  const allowed = new Set(
    'KeyW KeyA KeyS KeyD KeyR KeyC Space ShiftLeft ArrowUp ArrowDown ArrowLeft ArrowRight'.split(
      ' ',
    ),
  )
  let running = false
  let start = 0
  let duration = 0
  let lastSample = -1000
  let timestamps: number[] = []
  let samples: unknown[] = []
  let result: unknown = null
  const snapshot = () => ({
    at: performance.now(),
    wall: Date.now(),
    visible: document.visibilityState,
    focused: document.hasFocus(),
    dpr: devicePixelRatio,
    game: Reflect.get(globalThis, '__owPerformanceSnapshot')?.(),
    audio: audio.map((context) => ({
      state: context.state,
      sampleRate: context.sampleRate,
      baseLatency: context.baseLatency,
    })),
    contexts: contexts.map((gl) => {
      const canvas = gl.canvas
      const rect = canvas instanceof HTMLCanvasElement ? canvas.getBoundingClientRect() : null
      const extension = gl.getExtension('WEBGL_debug_renderer_info')
      return {
        lost: gl.isContextLost(),
        css: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        buffer: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
        antialias: gl.getContextAttributes()?.antialias,
        samples: gl.getParameter(gl.SAMPLES),
        renderer: gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
        version: gl.getParameter(gl.VERSION),
      }
    }),
    // Explicit creates/deletes only: browser GC can also retire resources.
    allocations: Object.fromEntries(
      Object.entries(allocations).map(([kind, value]) => [kind, { ...value }]),
    ),
  })
  const recordInput = (event: Event) => {
    if (!(running && event.isTrusted) || inputs.length >= 20_000) {
      return
    }
    if (event instanceof KeyboardEvent && allowed.has(event.code)) {
      inputs.push({ at: performance.now(), type: event.type, key: event.code })
    } else if (event instanceof PointerEvent) {
      inputs.push({ at: performance.now(), type: event.type, x: event.clientX, y: event.clientY })
    }
  }
  for (const name of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'pointermove']) {
    document.addEventListener(name, recordInput, true)
  }
  const resources = () =>
    performance.getEntriesByType('resource').map((resource) => {
      const url = new URL(resource.name)
      return {
        path: url.pathname,
        version: url.searchParams.get('v'),
        start: resource.startTime,
        duration: resource.duration,
      }
    })
  const tick = (now: number) => {
    if (!running) {
      return
    }
    if (timestamps.length === 0) {
      start = now
    }
    timestamps.push(now)
    if (now - lastSample >= 1000) {
      samples.push(snapshot())
      lastSample = now
    }
    if (now - start >= duration) {
      samples.push(snapshot())
      running = false
      result = { timestamps, samples, inputs: [...inputs], resources: resources(), completed: true }
    } else {
      requestAnimationFrame(tick)
    }
  }
  Reflect.set(globalThis, '__owFrameRecorder', {
    start(seconds = 60) {
      if (running || !Number.isFinite(seconds) || seconds <= 0) {
        throw new Error('Invalid recording start')
      }
      duration = seconds * 1000
      timestamps = []
      samples = []
      inputs.length = 0
      lastSample = -1000
      result = null
      running = true
      requestAnimationFrame(tick)
    },
    status: () => ({
      running,
      frames: timestamps.length,
      seconds: timestamps.length > 0 ? ((timestamps.at(-1) ?? start) - start) / 1000 : 0,
    }),
    result: () => result,
    inspect: snapshot,
    partial: () => ({
      timestamps: [...timestamps],
      samples: [...samples],
      inputs: [...inputs],
      resources: resources(),
      completed: false,
    }),
  })
}
