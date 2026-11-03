import { defaultParams, type HeroHandle, type HeroParams, mountHero, paramRanges } from '~/lib/hero'
import type { BackendKind } from '~/lib/hero/backends'

type ParamKey = keyof HeroParams

const PARAM_KEYS = Object.keys(paramRanges) as ParamKey[]
const BACKENDS: readonly BackendKind[] = ['webgpu', 'webgl2']

function isBackend(value: string | null): value is BackendKind {
  return value === 'webgpu' || value === 'webgl2'
}

function must<T extends Element>(
  root: ParentNode,
  selector: string,
  ctor: abstract new () => T,
): T {
  const node = root.querySelector(selector)
  if (!(node instanceof ctor)) throw new Error(`[flow] missing ${selector}`)
  return node
}

function decimals(step: number): number {
  const text = String(step)
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : text.length - dot - 1
}

function quantize(key: ParamKey, value: number): number {
  const { min, max, step } = paramRanges[key]
  const clamped = Math.min(max, Math.max(min, value))
  const snapped = min + Math.round((clamped - min) / step) * step
  return Number(snapped.toFixed(decimals(step)))
}

function format(key: ParamKey, value: number): string {
  if (key === 'vcr') return value > 0.5 ? 'on' : 'off'
  return value.toFixed(decimals(paramRanges[key].step))
}

interface HashState {
  params: Partial<HeroParams>
  backend?: BackendKind
}

/** `#speed=0.32&scale=1.6&…&backend=webgl2` */
function readHash(): HashState {
  const search = new URLSearchParams(location.hash.slice(1))
  const params: Partial<HeroParams> = {}
  for (const key of PARAM_KEYS) {
    const raw = search.get(key)
    if (raw === null || raw.trim() === '') continue
    const value = Number(raw)
    if (Number.isFinite(value)) params[key] = quantize(key, value)
  }
  const backend = search.get('backend')
  return isBackend(backend) ? { params, backend } : { params }
}

function writeHash(params: HeroParams, backend: BackendKind | undefined) {
  const search = new URLSearchParams()
  for (const key of PARAM_KEYS) {
    search.set(key, key === 'vcr' ? String(params.vcr) : format(key, params[key]))
  }
  if (backend) search.set('backend', backend)
  history.replaceState(null, '', `#${search.toString()}`)
}

function randomParams(current: HeroParams): HeroParams {
  const next: HeroParams = { ...current }
  for (const key of PARAM_KEYS) {
    if (key === 'vcr') continue
    const { min, max } = paramRanges[key]
    // Keep it moving: never randomize into a dead stop.
    const lo = key === 'speed' ? Math.max(min, 0.05) : min
    next[key] = quantize(key, lo + Math.random() * (max - lo))
  }
  next.vcr = Math.random() < 0.2 ? 1 : 0
  return next
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.closest('input, textarea, select, button, summary') !== null
}

export function initFlow(root: HTMLElement = document.body): void {
  const stage = must(root, '[data-flow-stage]', HTMLElement)
  const fallback = must(root, '[data-flow-fallback]', HTMLElement)
  const panel = must(root, '[data-flow-panel]', HTMLDetailsElement)
  const form = must(root, '[data-flow-form]', HTMLFormElement)
  const hudBox = must(root, '[data-flow-hud]', HTMLElement)
  const hudBackend = must(root, '[data-hud="backend"]', HTMLElement)
  const hudFps = must(root, '[data-hud="fps"]', HTMLElement)
  const hudRes = must(root, '[data-hud="res"]', HTMLElement)
  const hudState = must(root, '[data-hud="state"]', HTMLElement)
  const status = must(root, '[data-flow-status]', HTMLElement)

  const inputs = new Map<ParamKey, HTMLInputElement>()
  const outputs = new Map<ParamKey, HTMLOutputElement>()
  for (const key of PARAM_KEYS) {
    inputs.set(key, must(form, `[name="${key}"]`, HTMLInputElement))
    const out = form.querySelector(`output[for="p-${key}"]`)
    if (out instanceof HTMLOutputElement) outputs.set(key, out)
  }
  const backendRadios = BACKENDS.map((kind) =>
    must(form, `input[name="backend"][value="${kind}"]`, HTMLInputElement),
  )

  const hasWebGPU = 'gpu' in navigator
  for (const radio of backendRadios) {
    if (radio.value === 'webgpu' && !hasWebGPU) {
      radio.disabled = true
      radio.closest('label')?.setAttribute('title', 'WebGPU is not available in this browser')
    }
  }

  const fromHash = readHash()
  /** Source of truth; the renderer's params mirror this (except speed while paused). */
  let model: HeroParams = { ...defaultParams, ...fromHash.params }
  let preferred: BackendKind | undefined = fromHash.backend
  let paused = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let handle: HeroHandle | null = null
  let mountToken = 0
  let hashTimer = 0
  let statusTimer = 0

  const flash = (message: string) => {
    status.textContent = message
    window.clearTimeout(statusTimer)
    statusTimer = window.setTimeout(() => {
      status.textContent = ''
    }, 1800)
  }

  const scheduleHash = () => {
    window.clearTimeout(hashTimer)
    hashTimer = window.setTimeout(() => writeHash(model, preferred), 150)
  }

  const apply = () => {
    if (handle) {
      Object.assign(handle.params, model)
      handle.params.speed = paused ? 0 : model.speed
    }
    const docEl = document.documentElement
    docEl.style.setProperty('--accent-h', String(model.hue))
    docEl.toggleAttribute('data-vcr', model.vcr > 0.5)
    hudState.textContent = paused ? 'paused' : 'live'
    hudState.toggleAttribute('data-paused', paused)
  }

  const syncInputs = () => {
    for (const key of PARAM_KEYS) {
      const input = inputs.get(key)
      if (!input) continue
      if (input.type === 'checkbox') input.checked = model[key] > 0.5
      else input.value = String(model[key])
      const out = outputs.get(key)
      if (out) out.value = format(key, model[key])
    }
  }

  const setModel = (next: HeroParams) => {
    model = next
    syncInputs()
    apply()
    scheduleHash()
  }

  const freshCanvas = (): HTMLCanvasElement => {
    // A canvas is locked to its first context type, so every (re)mount gets a new one.
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-label', 'Domain-warped noise flow field')
    stage.querySelector('canvas')?.remove()
    stage.append(canvas)
    return canvas
  }

  const mount = async (prefer: BackendKind | undefined) => {
    const token = ++mountToken
    handle?.destroy()
    handle = null
    hudBackend.textContent = '…'

    const order: (BackendKind | undefined)[] = prefer
      ? [prefer, ...BACKENDS.filter((kind) => kind !== prefer)]
      : [undefined, 'webgl2']
    for (const kind of order) {
      if (kind === 'webgpu' && !hasWebGPU) continue
      const opts = kind
        ? { params: model, scrollTarget: stage, prefer: kind }
        : { params: model, scrollTarget: stage }
      const next = await mountHero(freshCanvas(), opts)
      if (token !== mountToken) {
        next?.destroy()
        return
      }
      if (next) {
        handle = next
        break
      }
    }

    if (!handle) {
      stage.querySelector('canvas')?.remove()
      fallback.hidden = false
      panel.hidden = true
      hudBox.hidden = true
      return
    }
    fallback.hidden = true
    panel.hidden = false
    hudBox.hidden = false
    if (prefer && handle.backend !== prefer) flash(`${prefer} unavailable, using ${handle.backend}`)
    for (const radio of backendRadios) radio.checked = radio.value === handle.backend
    hudBackend.textContent = handle.backend
    apply()
  }

  // --- inputs -------------------------------------------------------------

  form.addEventListener('submit', (event) => event.preventDefault())

  form.addEventListener('input', (event) => {
    const target = event.target
    if (!(target instanceof HTMLInputElement)) return
    if (target.name === 'backend') return
    const key = PARAM_KEYS.find((k) => k === target.name)
    if (!key) return
    const value = target.type === 'checkbox' ? (target.checked ? 1 : 0) : Number(target.value)
    model = { ...model, [key]: quantize(key, value) }
    const out = outputs.get(key)
    if (out) out.value = format(key, model[key])
    apply()
    scheduleHash()
  })

  form.addEventListener('change', (event) => {
    const target = event.target
    if (!(target instanceof HTMLInputElement) || target.name !== 'backend') return
    if (!isBackend(target.value)) return
    preferred = target.value
    scheduleHash()
    void mount(preferred)
  })

  const randomize = () => {
    setModel(randomParams(model))
    flash('randomized')
  }
  const reset = () => {
    setModel({ ...defaultParams })
    flash('reset to defaults')
  }
  const togglePause = () => {
    paused = !paused
    apply()
    flash(paused ? 'paused' : 'resumed')
  }
  const copy = async () => {
    const json = JSON.stringify(model, null, 2)
    try {
      await navigator.clipboard.writeText(json)
      flash('params copied')
    } catch {
      flash('clipboard blocked')
    }
  }

  const actions: Record<string, () => void> = {
    randomize,
    reset,
    pause: togglePause,
    copy: () => void copy(),
  }
  form.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest('button[data-action]')
    if (!(button instanceof HTMLButtonElement)) return
    actions[button.getAttribute('data-action') ?? '']?.()
  })

  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    if (isTyping(event.target)) return
    if (event.key === 'h' || event.key === 'H') {
      panel.open = !panel.open
    } else if (event.key === 'r' || event.key === 'R') {
      randomize()
    } else if (event.key === ' ' || event.code === 'Space') {
      event.preventDefault()
      togglePause()
    }
  })

  window.addEventListener('hashchange', () => {
    const next = readHash()
    setModel({ ...defaultParams, ...next.params })
    if (next.backend && next.backend !== handle?.backend) {
      preferred = next.backend
      void mount(preferred)
    }
  })

  // --- HUD ----------------------------------------------------------------

  let fps = 60
  let lastHud = 0
  const hud = (now: number) => {
    if (handle) {
      fps += (1000 / Math.max(1, handle.frameMs) - fps) * 0.1
      if (now - lastHud > 250) {
        lastHud = now
        hudFps.textContent = fps.toFixed(0).padStart(3, ' ')
        hudRes.textContent = `${Math.round(handle.resolution * 100)}%`
      }
    }
    requestAnimationFrame(hud)
  }
  requestAnimationFrame(hud)

  // Phones: start with the art, not the panel (`h` / tap the summary to open).
  if (window.matchMedia('(max-width: 40rem)').matches) panel.open = false

  syncInputs()
  apply()
  void mount(preferred)
}
