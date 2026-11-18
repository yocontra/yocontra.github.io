import type { createSimulatorCoordinates } from './simulator-page-coordinates.ts'

interface SimulatorSetup {
  id: string
  stress: boolean
  preflight?: boolean
  expectedURL: string
}
/** Local QA page controls. The recorder and read-only native snapshot are installed before boot. */
export async function installSimulatorRecorder(
  createCoordinates: typeof createSimulatorCoordinates,
  hashScripts: typeof simulatorScriptHashes,
): Promise<void> {
  const saved = sessionStorage.getItem('__owQaRecording')
  if (!saved) {
    return
  }
  sessionStorage.removeItem('__owQaRecording')
  const { id, stress, preflight = false, expectedURL } = JSON.parse(saved) as SimulatorSetup
  const recorder = Reflect.get(globalThis, '__owFrameRecorder')
  const startText = preflight
    ? 'Start 2s headless preflight'
    : `Start 60s ${stress ? '32 rider' : '5 rider'} recording`
  let coordinates: ReturnType<typeof createSimulatorCoordinates> | undefined
  const pageState = () => ({
    ...(coordinates?.page() ?? {
      url: location.href,
      visible: document.visibilityState,
      focused: document.hasFocus(),
    }),
    recorder: recorder?.inspect(),
  })
  // Local QA alone supplies this dummy token, still verified by the Worker test secret.
  let tokenCallback: ((token: string) => void) | undefined
  const deliverTestToken = () => queueMicrotask(() => tokenCallback?.('XXXX.DUMMY.TOKEN.XXXX'))
  Reflect.set(globalThis, 'turnstile', {
    render(_element: HTMLElement, options: { callback: (token: string) => void }) {
      tokenCallback = options.callback
      deliverTestToken()
      return 'local-qa-provider'
    },
    reset: deliverTestToken,
  })
  if (document.readyState === 'loading') {
    await new Promise<void>((resolve) =>
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }),
    )
  }
  const button = document.createElement('button')
  button.textContent = 'Preparing QA recording…'
  button.disabled = true
  Object.assign(button.style, {
    position: 'fixed',
    top: '48px',
    right: '12px',
    zIndex: '10000',
    padding: '12px',
    background: '#fff',
    color: '#111',
  })
  document.body.append(button)
  const snapshot = (history = false) =>
    Reflect.get(globalThis, '__owPerformanceSnapshot')?.(history)
  const wait = async (ready: () => boolean) => {
    const start = Date.now()
    while (!ready()) {
      if (Date.now() - start > 120_000) {
        throw new Error('Native recording readiness timed out')
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  const fixture = async (
    action: string,
    error?: string,
    coordinatePage?: ReturnType<typeof pageState>,
  ) => {
    const response = await fetch(`/__qa/session/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action,
        lobbyId: snapshot()?.lobbyId ?? '',
        ...(error ? { error } : {}),
        ...(coordinatePage || ['ready', 'failed'].includes(action)
          ? { page: coordinatePage ?? pageState() }
          : {}),
        recording: error
          ? (recorder.result() ?? recorder.partial())
          : { ...recorder?.status(), at: performance.now(), wall: Date.now() },
        ...(error ? { failure: error, preflight, stress } : {}),
        players: stress ? 32 : 5,
      }),
    })
    const result = await response.json()
    if (!(response.ok && result.ok)) {
      throw new Error('Local Worker qualification fixture failed')
    }
    return result
  }
  const failure = async (error: unknown) => {
    button.textContent = error instanceof Error ? error.message : 'Recording failed'
    await fixture('failed', button.textContent).catch(() => undefined)
  }
  try {
    if (location.href !== expectedURL || new URL(expectedURL).searchParams.get('qaRun') !== id) {
      throw new Error('QA run URL mismatch')
    }
    await wait(() => Boolean(snapshot()?.scene.actors.loaded))
    const preparation = await fixture('pack')
    const count = stress ? 32 : 5
    await wait(() => {
      const scene = snapshot()?.scene
      return (
        scene?.players === count &&
        scene.actors.loaded === count &&
        !scene.actors.loading &&
        !scene.actors.fallbacks &&
        !scene.actors.failed &&
        !document.querySelector('.pc-loading')
      )
    })
    button.textContent = startText
    button.disabled = false
    coordinates = createCoordinates(id, expectedURL, startText, async (page) => {
      await fixture('coordinates', undefined, { ...page, recorder: recorder?.inspect() })
    })
    await coordinates.start(button)
    await fixture('ready')
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        await coordinates?.stop()
        if (
          !recorder
            .inspect()
            .audio.some((context: { state: string }) => context.state === 'running')
        ) {
          throw new Error('Tap the game first to enable audio')
        }
        await fixture('start')
        button.remove()
        recorder.start(preflight ? 2 : 60)
        await wait(() => recorder.status().frames > 0)
        await fixture('recording')
        await wait(() => !recorder.status().running)
        const authority = await fixture('finish')
        const data = recorder.result()
        const hashes = await hashScripts()
        const response = await fetch(`/__qa/receipt/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            surface: 'simulator-safari',
            turnstile: 'local-dummy-token-with-server-verification',
            userAgent: navigator.userAgent,
            stress,
            preflight,
            page: pageState(),
            scriptHashes: hashes,
            authority: authority.receipt,
            preparation,
            history: snapshot(true),
            recording: data,
          }),
        })
        if (!response.ok) {
          throw new Error('Could not save simulator receipt')
        }
        button.textContent = 'Recording saved on host'
      } catch (error) {
        await failure(error)
        button.disabled = false
      } finally {
        Reflect.get(globalThis, '__owQaPrivacy')?.restoreSettings()
      }
      document.body.append(button)
    })
  } catch (error) {
    await coordinates?.stop().catch(() => undefined)
    Reflect.get(globalThis, '__owQaPrivacy')?.restoreSettings()
    await failure(error)
  }
}

/** Real bytes fetched after recording; no hashing work runs in the measured interval. */
export async function simulatorScriptHashes() {
  const hashes: { path: string; local: boolean; sha256: string }[] = []
  const scripts = [
    ...new Set(performance.getEntriesByType('resource').map((resource) => resource.name)),
  ]
  for (const resource of scripts) {
    const url = new URL(resource)
    if (
      url.origin !== location.origin ||
      !url.pathname.endsWith('.js') ||
      url.pathname.startsWith('/__qa/')
    ) {
      continue
    }
    const bytes = await (await fetch(resource)).arrayBuffer()
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    hashes.push({
      path: url.pathname,
      local: true,
      sha256: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(
        '',
      ),
    })
  }
  return hashes
}
