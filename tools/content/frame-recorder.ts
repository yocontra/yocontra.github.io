/** Browser-only recording, reusable through addInitScript or the simulator's Web Inspector. */
export interface QARecorderPrivacySample {
  captureCalls: number
  captureBlocked: boolean
  voiceChatForcedOff: boolean
  graphics: {
    original: unknown
    originalSettingsState: 'absent' | 'malformed' | 'object' | 'non-object'
    applied: 'auto'
    tierOverride: 'low' | 'high' | null
    tierOverrideRaw: string | null
  }
}

export function installQARecorderPrivacy(): void {
  if (Reflect.has(globalThis, '__owQaPrivacy')) {
    return
  }
  let captureCalls = 0
  const media = navigator.mediaDevices
  if (typeof media?.getUserMedia === 'function') {
    Object.defineProperty(media, 'getUserMedia', {
      configurable: true,
      value: () => {
        captureCalls++
        return Promise.reject(
          new DOMException(
            'Microphone capture disabled in the local performance fixture',
            'NotAllowedError',
          ),
        )
      },
    })
  }
  const key = 'ow.settings.v1'
  // biome-ignore lint/security/noSecrets: fixed localStorage key, not a credential
  const backupKey = '__owQaSettingsBackup'
  const existing = localStorage.getItem(backupKey)
  if (!existing) {
    localStorage.setItem(backupKey, JSON.stringify({ value: localStorage.getItem(key) }))
  }
  const original = (
    JSON.parse(localStorage.getItem(backupKey) ?? '{}') as {
      value: string | null
    }
  ).value
  let originalGraphics: unknown = null
  let originalSettingsState: QARecorderPrivacySample['graphics']['originalSettingsState'] =
    original === null ? 'absent' : 'malformed'
  if (original !== null) {
    try {
      const parsed: unknown = JSON.parse(original)
      originalSettingsState = parsed && typeof parsed === 'object' ? 'object' : 'non-object'
      if (parsed && typeof parsed === 'object' && 'graphics' in parsed) {
        originalGraphics = parsed.graphics
      }
    } catch {
      /* The exact malformed value remains in the restore backup. */
    }
  }
  const override = new URLSearchParams(globalThis.location?.hash.slice(1) ?? '').get('tier')
  let settings: Record<string, unknown> = {}
  try {
    settings = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}
  } catch {
    /* Preserve malformed originals too. */
  }
  localStorage.setItem(key, JSON.stringify({ ...settings, voiceChat: false, graphics: 'auto' }))
  const restoreSettings = () => {
    const saved = localStorage.getItem(backupKey)
    if (!saved) {
      return
    }
    const { value } = JSON.parse(saved) as { value: string | null }
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
    localStorage.removeItem(backupKey)
  }
  globalThis.addEventListener('pagehide', restoreSettings, { once: true })
  Reflect.set(globalThis, '__owQaPrivacy', {
    inspect: () => ({
      captureCalls,
      captureBlocked: true,
      voiceChatForcedOff: true,
      graphics: {
        original: originalGraphics,
        originalSettingsState,
        applied: 'auto',
        tierOverride: override === 'low' || override === 'high' ? override : null,
        tierOverrideRaw: override,
      },
    }),
    restoreSettings,
  })
}
type WebGLContext = WebGLRenderingContext | WebGL2RenderingContext

// GPU queries can block on queued draws. Keep them outside the measured frame interval.
const readWebGL = (contexts: readonly WebGLContext[]) => ({
  at: performance.now(),
  contexts: contexts.map((gl) => {
    if (gl.isContextLost()) {
      return null
    }
    const extension = gl.getExtension('WEBGL_debug_renderer_info')
    return {
      samples: gl.getParameter(gl.SAMPLES),
      renderer: gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
    }
  }),
})

export function frameRecorderSource(): string {
  return `(${installQARecorderPrivacy.toString()})();(${installFrameRecorder.toString()})(${readWebGL.toString()})`
}

function installFrameRecorder(captureWebGL: typeof readWebGL): void {
  if (Reflect.has(globalThis, '__owFrameRecorder')) {
    return
  }
  const privacy = Reflect.get(globalThis, '__owQaPrivacy')
  if (!privacy) {
    throw new Error('Local QA privacy guard must run before recorder/game initialization')
  }
  performance.setResourceTimingBufferSize(10_000)
  const contexts: WebGLContext[] = []
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
        for (const kind of 'Buffer Texture Program Shader Framebuffer Renderbuffer'.split(' ')) {
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
  let webglBefore: ReturnType<typeof readWebGL> | null = null
  const snapshot = () => ({
    at: performance.now(),
    wall: Date.now(),
    privacy: privacy.inspect(),
    url: location.href,
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
      return {
        lost: gl.isContextLost(),
        css: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        buffer: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
        antialias: gl.getContextAttributes()?.antialias,
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
  const receipt = (completed: boolean) => ({
    timestamps: [...timestamps],
    samples: [...samples],
    inputs: [...inputs],
    resources: resources(),
    webgl: { before: webglBefore, after: completed ? captureWebGL(contexts) : null },
    completed,
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
      result = receipt(true)
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
      webglBefore = captureWebGL(contexts)
      running = true
      requestAnimationFrame(tick)
    },
    status: () => ({
      running,
      frames: timestamps.length,
      seconds: ((timestamps.at(-1) ?? start) - start) / 1000,
    }),
    result: () => result,
    inspect: snapshot,
    partial: () => receipt(false),
  })
}
