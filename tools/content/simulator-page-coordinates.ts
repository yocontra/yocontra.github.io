/** Serialized local QA publisher. Event-driven before Start; stopped and drained before the clock. */
import type { CoordinateInput, CoordinatePage } from './simulator-document.ts'
export function createSimulatorCoordinates(
  id: string,
  expectedURL: string,
  startText: string,
  publish: (page: CoordinatePage) => Promise<unknown>,
) {
  const documentTitle = `Out West recording [run:${id}]`
  const canvasLabel = `Out West game [run:${id}]`
  const startLabel = `${startText} [run:${id}]`
  let sequence = 0
  let inputSequence = 0
  let settledAfter = 0
  let active = false
  let writes = Promise.resolve()
  const inputs: CoordinateInput[] = []
  const abort = new AbortController()
  const frames = new Set<number>()
  const rect = (value: DOMRect) => ({
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  })
  const page = (): CoordinatePage => {
    const canvas = document.querySelector('canvas')?.getBoundingClientRect()
    return {
      url: location.href,
      visible: document.visibilityState,
      focused: document.hasFocus(),
      width: innerWidth,
      height: innerHeight,
      canvas: canvas ? rect(canvas) : null,
      qa: {
        id,
        documentTitle: document.title,
        canvasLabel,
        startLabel,
        sequence,
        settledAfter,
        at: performance.now(),
        wall: Date.now(),
        inputs: [...inputs],
        controls: Object.fromEntries(
          ['FIRE', 'AIM', 'RELOAD'].flatMap((label) => {
            const element = document.querySelector(`[aria-label="${label}"]`)
            return element ? [[label, rect(element.getBoundingClientRect())]] : []
          }),
        ),
      },
    }
  }
  const emit = () => {
    if (!active) {
      return Promise.resolve()
    }
    sequence++
    const snapshot = page()
    const next = writes.then(async () => {
      await publish(snapshot)
    })
    writes = next
    void next.catch(() => undefined) // The same rejection remains in writes and is awaited before Start.
    return next
  }
  const pointer = (event: Event) => {
    if (!(event instanceof PointerEvent && active)) {
      return
    }
    const target = event.target instanceof Element ? event.target : null
    const label =
      target?.closest('button')?.getAttribute('aria-label') ??
      (target instanceof HTMLCanvasElement ? target.getAttribute('aria-label') : '') ??
      ''
    inputs.push({
      sequence: ++inputSequence,
      type: event.type,
      isTrusted: event.isTrusted,
      pointerType: event.pointerType,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      label,
      at: performance.now(),
      wall: Date.now(),
    })
    void emit()
    if (event.type === 'pointerup') {
      const input = inputSequence
      const frame = requestAnimationFrame(() => {
        frames.delete(frame)
        settledAfter = input
        void emit()
      })
      frames.add(frame)
    }
  }
  return {
    page,
    async start(button: HTMLElement) {
      if (location.href !== expectedURL || new URL(expectedURL).searchParams.get('qaRun') !== id) {
        throw new Error('QA run URL mismatch')
      }
      const canvas = document.querySelector('canvas')
      if (!canvas) {
        throw new Error('QA canvas missing')
      }
      canvas.setAttribute('aria-label', canvasLabel)
      button.setAttribute('aria-label', startLabel)
      document.title = documentTitle
      active = true
      for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
        document.addEventListener(type, pointer, { capture: true, signal: abort.signal })
      }
      for (const type of ['resize', 'orientationchange']) {
        globalThis.addEventListener(
          type,
          () => {
            void emit()
          },
          { signal: abort.signal },
        )
      }
      globalThis.visualViewport?.addEventListener(
        'resize',
        () => {
          void emit()
        },
        { signal: abort.signal },
      )
      globalThis.visualViewport?.addEventListener(
        'scroll',
        () => {
          void emit()
        },
        { signal: abort.signal },
      )
      await emit()
    },
    async stop() {
      active = false
      abort.abort()
      for (const frame of frames) {
        cancelAnimationFrame(frame)
      }
      frames.clear()
      await writes
    },
  }
}
