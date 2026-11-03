import type { BackendKind } from '~/lib/hero/backends.ts'
import { type HeroHandle, mountHero } from '~/lib/hero/index.ts'
import { defaultParams, type HeroParams, paramRanges } from '~/lib/hero/params.ts'

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
  if (!(node instanceof ctor)) {
    throw new Error(`[flow] missing ${selector}`)
  }
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
  if (key === 'vcr') {
    return value > 0.5 ? 'on' : 'off'
  }
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
    if (raw === null || raw.trim() === '') {
      continue
    }
    const value = Number(raw)
    if (Number.isFinite(value)) {
      params[key] = quantize(key, value)
    }
  }
  const backend = search.get('backend')
  return isBackend(backend) ? { params, backend } : { params }
}

function writeHash(params: HeroParams, backend: BackendKind | undefined) {
  const search = new URLSearchParams()
  for (const key of PARAM_KEYS) {
    search.set(key, key === 'vcr' ? String(params.vcr) : format(key, params[key]))
  }
  if (backend) {
    search.set('backend', backend)
  }
  history.replaceState(null, '', `#${search.toString()}`)
}

function randomParams(current: HeroParams): HeroParams {
  const next: HeroParams = { ...current }
  for (const key of PARAM_KEYS) {
    if (key === 'vcr') {
      continue
    }
    const { min, max } = paramRanges[key]
    // Keep it moving: never randomize into a dead stop.
    const lo = key === 'speed' ? Math.max(min, 0.05) : min
    next[key] = quantize(key, lo + Math.random() * (max - lo))
  }
  next.vcr = Math.random() < 0.2 ? 1 : 0
  return next
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  if (target.isContentEditable) {
    return true
  }
  return target.closest('input, textarea, select, button, summary') !== null
}

interface FlowElements {
  stage: HTMLElement
  fallback: HTMLElement
  panel: HTMLDetailsElement
  form: HTMLFormElement
  hudBox: HTMLElement
  hudBackend: HTMLElement
  hudFps: HTMLElement
  hudRes: HTMLElement
  hudState: HTMLElement
  status: HTMLElement
  inputs: Map<ParamKey, HTMLInputElement>
  outputs: Map<ParamKey, HTMLOutputElement>
  backendRadios: HTMLInputElement[]
}

function queryElements(root: HTMLElement): FlowElements {
  const form = must(root, '[data-flow-form]', HTMLFormElement)
  const inputs = new Map<ParamKey, HTMLInputElement>()
  const outputs = new Map<ParamKey, HTMLOutputElement>()
  for (const key of PARAM_KEYS) {
    inputs.set(key, must(form, `[name="${key}"]`, HTMLInputElement))
    const out = form.querySelector(`output[for="p-${key}"]`)
    if (out instanceof HTMLOutputElement) {
      outputs.set(key, out)
    }
  }
  return {
    stage: must(root, '[data-flow-stage]', HTMLElement),
    fallback: must(root, '[data-flow-fallback]', HTMLElement),
    panel: must(root, '[data-flow-panel]', HTMLDetailsElement),
    form,
    hudBox: must(root, '[data-flow-hud]', HTMLElement),
    // biome-ignore lint/security/noSecrets: a CSS selector, not a credential
    hudBackend: must(root, '[data-hud="backend"]', HTMLElement),
    hudFps: must(root, '[data-hud="fps"]', HTMLElement),
    hudRes: must(root, '[data-hud="res"]', HTMLElement),
    hudState: must(root, '[data-hud="state"]', HTMLElement),
    status: must(root, '[data-flow-status]', HTMLElement),
    inputs,
    outputs,
    backendRadios: BACKENDS.map((kind) =>
      must(form, `input[name="backend"][value="${kind}"]`, HTMLInputElement),
    ),
  }
}

class FlowPlayground {
  private readonly el: FlowElements
  private readonly hasWebGPU = 'gpu' in navigator
  /** Source of truth; the renderer's params mirror this (except speed while paused). */
  private model: HeroParams
  private preferred: BackendKind | undefined
  private paused = globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
  private handle: HeroHandle | null = null
  private mountToken = 0
  private hashTimer: ReturnType<typeof setTimeout> | undefined
  private statusTimer: ReturnType<typeof setTimeout> | undefined

  constructor(root: HTMLElement) {
    this.el = queryElements(root)
    const fromHash = readHash()
    this.model = { ...defaultParams, ...fromHash.params }
    this.preferred = fromHash.backend

    for (const radio of this.el.backendRadios) {
      if (radio.value === 'webgpu' && !this.hasWebGPU) {
        radio.disabled = true
        radio.closest('label')?.setAttribute('title', 'WebGPU is not available in this browser')
      }
    }
  }

  start(): void {
    this.bindForm()
    this.bindKeys()
    this.startHud()
    // Phones: start with the art, not the panel (`h` / tap the summary to open).
    if (globalThis.matchMedia('(max-width: 40rem)').matches) {
      this.el.panel.open = false
    }
    this.syncInputs()
    this.apply()
    void this.mount(this.preferred)
  }

  private flash(message: string): void {
    this.el.status.textContent = message
    globalThis.clearTimeout(this.statusTimer)
    this.statusTimer = globalThis.setTimeout(() => {
      this.el.status.textContent = ''
    }, 1800)
  }

  private scheduleHash(): void {
    globalThis.clearTimeout(this.hashTimer)
    this.hashTimer = globalThis.setTimeout(() => writeHash(this.model, this.preferred), 150)
  }

  private apply(): void {
    if (this.handle) {
      Object.assign(this.handle.params, this.model)
      this.handle.params.speed = this.paused ? 0 : this.model.speed
    }
    const docEl = document.documentElement
    docEl.style.setProperty('--accent-h', String(this.model.hue))
    docEl.toggleAttribute('data-vcr', this.model.vcr > 0.5)
    this.el.hudState.textContent = this.paused ? 'paused' : 'live'
    this.el.hudState.toggleAttribute('data-paused', this.paused)
  }

  private syncInputs(): void {
    for (const key of PARAM_KEYS) {
      const input = this.el.inputs.get(key)
      if (!input) {
        continue
      }
      if (input.type === 'checkbox') {
        input.checked = this.model[key] > 0.5
      } else {
        input.value = String(this.model[key])
      }
      const out = this.el.outputs.get(key)
      if (out) {
        out.value = format(key, this.model[key])
      }
    }
  }

  private setModel(next: HeroParams): void {
    this.model = next
    this.syncInputs()
    this.apply()
    this.scheduleHash()
  }

  private freshCanvas(): HTMLCanvasElement {
    // A canvas is locked to its first context type, so every (re)mount gets a new one.
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-label', 'Domain-warped noise flow field')
    this.el.stage.querySelector('canvas')?.remove()
    this.el.stage.append(canvas)
    return canvas
  }

  private async mount(prefer: BackendKind | undefined): Promise<void> {
    const token = ++this.mountToken
    this.handle?.destroy()
    this.handle = null
    this.el.hudBackend.textContent = '…'

    const order: (BackendKind | undefined)[] = prefer
      ? [prefer, ...BACKENDS.filter((kind) => kind !== prefer)]
      : [undefined, 'webgl2']
    for (const kind of order) {
      if (kind === 'webgpu' && !this.hasWebGPU) {
        continue
      }
      const opts = kind
        ? { params: this.model, scrollTarget: this.el.stage, prefer: kind }
        : { params: this.model, scrollTarget: this.el.stage }
      // Backends are tried one after another on purpose: each attempt needs a fresh canvas.
      // biome-ignore lint/performance/noAwaitInLoops: sequential fallback, not parallelisable work
      const next = await mountHero(this.freshCanvas(), opts)
      if (token !== this.mountToken) {
        next?.destroy()
        return
      }
      if (next) {
        this.handle = next
        break
      }
    }
    this.showMounted(prefer)
  }

  private showMounted(prefer: BackendKind | undefined): void {
    const { handle, el } = this
    el.fallback.hidden = handle !== null
    el.panel.hidden = handle === null
    el.hudBox.hidden = handle === null
    if (!handle) {
      el.stage.querySelector('canvas')?.remove()
      return
    }
    if (prefer && handle.backend !== prefer) {
      this.flash(`${prefer} unavailable, using ${handle.backend}`)
    }
    for (const radio of el.backendRadios) {
      radio.checked = radio.value === handle.backend
    }
    el.hudBackend.textContent = handle.backend
    this.apply()
  }

  private onInput(target: HTMLInputElement): void {
    const key = PARAM_KEYS.find((k) => k === target.name)
    if (!key) {
      return
    }
    const value = target.type === 'checkbox' ? Number(target.checked) : Number(target.value)
    this.model = { ...this.model, [key]: quantize(key, value) }
    const out = this.el.outputs.get(key)
    if (out) {
      out.value = format(key, this.model[key])
    }
    this.apply()
    this.scheduleHash()
  }

  private randomize(): void {
    this.setModel(randomParams(this.model))
    this.flash('randomized')
  }

  private reset(): void {
    this.setModel({ ...defaultParams })
    this.flash('reset to defaults')
  }

  private togglePause(): void {
    this.paused = !this.paused
    this.apply()
    this.flash(this.paused ? 'paused' : 'resumed')
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(this.model, null, 2))
      this.flash('params copied')
    } catch {
      this.flash('clipboard blocked')
    }
  }

  private bindForm(): void {
    const { form } = this.el
    form.addEventListener('submit', (event) => event.preventDefault())

    form.addEventListener('input', (event) => {
      const { target } = event
      if (target instanceof HTMLInputElement && target.name !== 'backend') {
        this.onInput(target)
      }
    })

    form.addEventListener('change', (event) => {
      const { target } = event
      if (
        target instanceof HTMLInputElement &&
        target.name === 'backend' &&
        isBackend(target.value)
      ) {
        this.preferred = target.value
        this.scheduleHash()
        void this.mount(this.preferred)
      }
    })

    const actions: Record<string, () => void> = {
      randomize: () => this.randomize(),
      reset: () => this.reset(),
      pause: () => this.togglePause(),
      copy: () => void this.copy(),
    }
    form.addEventListener('click', (event) => {
      const button =
        event.target instanceof Element ? event.target.closest('button[data-action]') : null
      if (button instanceof HTMLButtonElement) {
        actions[button.getAttribute('data-action') ?? '']?.()
      }
    })
  }

  private bindKeys(): void {
    globalThis.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      if (isTyping(event.target)) {
        return
      }
      const key = event.key.toLowerCase()
      if (key === 'h') {
        this.el.panel.open = !this.el.panel.open
      } else if (key === 'r') {
        this.randomize()
      } else if (event.code === 'Space') {
        event.preventDefault()
        this.togglePause()
      }
    })

    globalThis.addEventListener('hashchange', () => {
      const next = readHash()
      this.setModel({ ...defaultParams, ...next.params })
      if (next.backend && next.backend !== this.handle?.backend) {
        this.preferred = next.backend
        void this.mount(this.preferred)
      }
    })
  }

  private startHud(): void {
    let fps = 60
    let lastHud = 0
    const hud = (now: number) => {
      const { handle } = this
      if (handle) {
        fps += (1000 / Math.max(1, handle.frameMs) - fps) * 0.1
        if (now - lastHud > 250) {
          lastHud = now
          this.el.hudFps.textContent = fps.toFixed(0).padStart(3, ' ')
          this.el.hudRes.textContent = `${Math.round(handle.resolution * 100)}%`
        }
      }
      requestAnimationFrame(hud)
    }
    requestAnimationFrame(hud)
  }
}

export function initFlow(root: HTMLElement = document.body): void {
  new FlowPlayground(root).start()
}
