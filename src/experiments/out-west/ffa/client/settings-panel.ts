/**
 * The pause menu's settings: view (over the shoulder, first person, top-down), field of view for
 * the current view, look sensitivity (mouse on desktop, thumbs on touch), invert-Y and the shoulder.
 * Every change applies at once and is saved per device.
 */
import { FOV_RANGE, type FrontierSettings, SENS_RANGE, type ViewMode } from './settings.ts'

export interface PanelHooks {
  settings: () => FrontierSettings
  /** A setting changed (already written into the object): apply and save. */
  onChange: (s: FrontierSettings) => void
}

const VIEW_LABEL: Record<ViewMode, string> = {
  third: 'Shoulder',
  first: 'First person',
  top: 'Top-down',
}

let uid = 0

export class SettingsPanel {
  readonly el: HTMLElement
  private readonly hooks: PanelHooks
  private readonly touch: boolean
  private readonly viewBtns = new Map<ViewMode, HTMLButtonElement>()
  private readonly fov: HTMLInputElement
  private readonly fovOut: HTMLOutputElement
  private readonly fovRow: HTMLElement
  private readonly sens: HTMLInputElement
  private readonly sensOut: HTMLOutputElement
  private readonly invert: HTMLInputElement
  private readonly shoulderRow: HTMLElement
  private readonly shoulderBtn: HTMLButtonElement
  private readonly lookRows: HTMLElement[] = []

  constructor(hooks: PanelHooks, touch: boolean) {
    this.hooks = hooks
    this.touch = touch
    this.el = document.createElement('div')
    this.el.className = 'fr-settings'
    const views = document.createElement('div')
    views.className = 'fr-seg'
    views.setAttribute('role', 'radiogroup')
    views.setAttribute('aria-label', 'View')
    for (const v of ['third', 'first', 'top'] as const) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'fr-seg-btn fr-hit'
      b.textContent = VIEW_LABEL[v]
      b.setAttribute('role', 'radio')
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        this.change((s) => {
          s.view = v
        })
      })
      this.viewBtns.set(v, b)
      views.append(b)
    }
    this.el.append(views)
    ;[this.fovRow, this.fov, this.fovOut] = this.slider('Field of view', FOV_RANGE, 1, (n) => {
      this.change((s) => {
        if (s.view === 'first') {
          s.fovFirst = n
        } else {
          s.fovThird = n
        }
      })
    })
    const [sensRow, sens, sensOut] = this.slider(
      touch ? 'Look speed' : 'Mouse speed',
      SENS_RANGE,
      0.05,
      (n) => {
        this.change((s) => {
          if (touch) {
            s.touchSens = n
          } else {
            s.mouseSens = n
          }
        })
      },
    )
    this.sens = sens
    this.sensOut = sensOut
    this.lookRows.push(sensRow)
    const inv = document.createElement('label')
    inv.className = 'fr-set-row fr-set-check fr-hit'
    this.invert = document.createElement('input')
    this.invert.type = 'checkbox'
    this.invert.addEventListener('change', () => {
      this.change((s) => {
        s.invertY = this.invert.checked
      })
    })
    const invText = document.createElement('span')
    invText.textContent = 'Invert look up / down'
    inv.append(this.invert, invText)
    this.el.append(inv)
    this.lookRows.push(inv)
    this.shoulderRow = document.createElement('div')
    this.shoulderRow.className = 'fr-set-row'
    const sl = document.createElement('span')
    sl.className = 'fr-set-label'
    sl.textContent = 'Shoulder'
    this.shoulderBtn = document.createElement('button')
    this.shoulderBtn.type = 'button'
    this.shoulderBtn.className = 'fr-seg-btn fr-hit fr-set-toggle'
    this.shoulderBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.change((s) => {
        s.shoulder = s.shoulder === 1 ? -1 : 1
      })
    })
    this.shoulderRow.append(sl, this.shoulderBtn)
    this.el.append(this.shoulderRow)
    this.sync()
  }

  private slider(
    label: string,
    range: { min: number; max: number },
    step: number,
    on: (n: number) => void,
  ): [HTMLElement, HTMLInputElement, HTMLOutputElement] {
    const id = `fr-set-${++uid}`
    const row = document.createElement('div')
    row.className = 'fr-set-row fr-set-slider'
    const l = document.createElement('label')
    l.className = 'fr-set-label'
    l.htmlFor = id
    l.textContent = label
    const input = document.createElement('input')
    input.type = 'range'
    input.id = id
    input.className = 'fr-hit'
    input.min = String(range.min)
    input.max = String(range.max)
    input.step = String(step)
    const out = document.createElement('output')
    out.className = 'fr-set-value'
    out.htmlFor.add(id)
    input.addEventListener('input', () => on(Number(input.value)))
    row.append(l, input, out)
    this.el.append(row)
    return [row, input, out]
  }

  private change(fn: (s: FrontierSettings) => void): void {
    const s = this.hooks.settings()
    fn(s)
    this.hooks.onChange(s)
    this.sync()
  }

  /** Reflect the current settings (also after V or X changed them from the keyboard). */
  sync(): void {
    const s = this.hooks.settings()
    for (const [v, b] of this.viewBtns) {
      b.classList.toggle('on', v === s.view)
      b.setAttribute('aria-checked', String(v === s.view))
    }
    const shooter = s.view !== 'top'
    this.fovRow.hidden = !shooter
    for (const r of this.lookRows) {
      r.hidden = !shooter
    }
    this.shoulderRow.hidden = s.view !== 'third'
    const fov = s.view === 'first' ? s.fovFirst : s.fovThird
    this.fov.value = String(fov)
    this.fovOut.textContent = `${Math.round(fov)}°`
    const sens = this.touch ? s.touchSens : s.mouseSens
    this.sens.value = String(sens)
    this.sensOut.textContent = `${sens.toFixed(2)}×`
    this.invert.checked = s.invertY
    this.shoulderBtn.textContent = s.shoulder === 1 ? 'Right' : 'Left'
  }
}
