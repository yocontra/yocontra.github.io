// biome-ignore-all lint/security/noSecrets: voice setting keys and key names are not credentials
/**
 * The pause menu's settings: view (over the shoulder, first person, top-down), field of view for
 * the current view, look sensitivity (mouse on desktop, thumbs on touch), invert-Y, hold or toggle
 * aim, the shoulder, and on touch the CoD Mobile block: layout side, button and stick size, auto
 * sprint, auto fire, auto reload and the ADS look speed.
 * Every change applies at once and is saved per device.
 */
import { getSettings, setSetting } from '../../settings.ts'
import {
  ADS_SENS_RANGE,
  CONTROL_RANGE,
  FOV_RANGE,
  type FrontierSettings,
  JOY_RANGE,
  SENS_RANGE,
  type ViewMode,
} from './settings.ts'

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
  private readonly adsToggle: HTMLInputElement
  private readonly shoulderRow: HTMLElement
  private readonly shoulderBtn: HTMLButtonElement
  private readonly lookRows: HTMLElement[] = []
  private adsModeBtn: HTMLButtonElement | null = null
  private autoSprint: HTMLInputElement | null = null
  private autoFire: HTMLInputElement | null = null
  private autoReload: HTMLInputElement | null = null
  private leftHanded: HTMLInputElement | null = null
  private ctl: HTMLInputElement | null = null
  private ctlOut: HTMLOutputElement | null = null
  private joy: HTMLInputElement | null = null
  private joyOut: HTMLOutputElement | null = null
  private adsSens: HTMLInputElement | null = null
  private adsSensOut: HTMLOutputElement | null = null
  private voiceChat: HTMLInputElement | null = null
  private voicePtt: HTMLInputElement | null = null
  private voiceVol: HTMLInputElement | null = null
  private voiceVolOut: HTMLOutputElement | null = null

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
    const ads = document.createElement('label')
    ads.className = 'fr-set-row fr-set-check fr-hit'
    this.adsToggle = document.createElement('input')
    this.adsToggle.type = 'checkbox'
    this.adsToggle.addEventListener('change', () => {
      this.change((s) => {
        s.adsToggle = this.adsToggle.checked
      })
    })
    const adsText = document.createElement('span')
    adsText.textContent = 'Right click toggles the sights'
    ads.append(this.adsToggle, adsText)
    if (!touch) {
      // touch AIM is always a toggle
      this.el.append(ads)
      this.lookRows.push(ads)
    }
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
    if (touch) {
      this.addTouchControls()
    }
    this.addVoiceControls()
    this.sync()
  }

  /** The touch-only block: layout, sizes and the CoD Mobile play aids. */
  private addTouchControls(): void {
    const head = document.createElement('div')
    head.className = 'fr-set-head'
    head.textContent = 'Touch controls'
    this.el.append(head)

    const adsRow = document.createElement('div')
    adsRow.className = 'fr-set-row'
    const adsLabel = document.createElement('span')
    adsLabel.className = 'fr-set-label'
    adsLabel.textContent = 'AIM button'
    const adsBtn = document.createElement('button')
    adsBtn.type = 'button'
    adsBtn.className = 'fr-seg-btn fr-hit fr-set-toggle'
    adsBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.change((s) => {
        s.adsMode = s.adsMode === 'hold' ? 'toggle' : 'hold'
      })
    })
    adsRow.append(adsLabel, adsBtn)
    this.el.append(adsRow)
    this.adsModeBtn = adsBtn

    this.autoSprint = this.check('Auto sprint (push the stick)', (v) => {
      this.change((s) => {
        s.autoSprint = v
      })
    })
    this.autoFire = this.check('Auto fire (crosshair on a rider)', (v) => {
      this.change((s) => {
        s.autoFire = v
      })
    })
    this.autoReload = this.check('Auto reload an empty gun', (v) => {
      this.change((s) => {
        s.autoReload = v
      })
    })
    this.leftHanded = this.check('Left-handed layout', (v) => {
      this.change((s) => {
        s.leftHanded = v
      })
    })

    const [, ctl, ctlOut] = this.slider('Button size', CONTROL_RANGE, 0.05, (n) => {
      this.change((s) => {
        s.controlScale = n
      })
    })
    this.ctl = ctl
    this.ctlOut = ctlOut
    const [, joy, joyOut] = this.slider('Stick size', JOY_RANGE, 0.05, (n) => {
      this.change((s) => {
        s.joyScale = n
      })
    })
    this.joy = joy
    this.joyOut = joyOut
    const [, adsSens, adsSensOut] = this.slider('Aim look speed', ADS_SENS_RANGE, 0.05, (n) => {
      this.change((s) => {
        s.touchAdsSens = n
      })
    })
    this.adsSens = adsSens
    this.adsSensOut = adsSensOut
  }

  /** The shared proximity-voice switches (the same values the hub's Settings sheet edits). */
  private addVoiceControls(): void {
    const head = document.createElement('div')
    head.className = 'fr-set-head'
    head.textContent = 'Voice chat'
    this.el.append(head)
    this.voiceChat = this.check('Proximity voice (off by default)', (v) => {
      setSetting('voiceChat', v)
    })
    this.voicePtt = this.check(this.touch ? 'Hold TALK to speak' : 'Push to talk (hold T)', (v) => {
      setSetting('voicePushToTalk', v)
    })
    const [, vol, out] = this.slider('Voice chat volume', { min: 0, max: 1 }, 0.05, (n) => {
      setSetting('voiceChatVolume', n)
    })
    this.voiceVol = vol
    this.voiceVolOut = out
  }

  /** A labelled checkbox row. */
  private check(labelText: string, set: (v: boolean) => void): HTMLInputElement {
    const row = document.createElement('label')
    row.className = 'fr-set-row fr-set-check fr-hit'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.addEventListener('change', () => set(input.checked))
    const text = document.createElement('span')
    text.textContent = labelText
    row.append(input, text)
    this.el.append(row)
    return input
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
    this.adsToggle.checked = s.adsToggle
    this.shoulderBtn.textContent = s.shoulder === 1 ? 'Right' : 'Left'
    if (this.adsModeBtn) {
      this.adsModeBtn.textContent = s.adsMode === 'hold' ? 'Hold' : 'Toggle'
    }
    if (this.autoSprint) {
      this.autoSprint.checked = s.autoSprint
    }
    if (this.autoFire) {
      this.autoFire.checked = s.autoFire
    }
    if (this.autoReload) {
      this.autoReload.checked = s.autoReload
    }
    if (this.leftHanded) {
      this.leftHanded.checked = s.leftHanded
    }
    if (this.ctl && this.ctlOut) {
      this.ctl.value = String(s.controlScale)
      this.ctlOut.textContent = `${Math.round(s.controlScale * 100)}%`
    }
    if (this.joy && this.joyOut) {
      this.joy.value = String(s.joyScale)
      this.joyOut.textContent = `${Math.round(s.joyScale * 100)}%`
    }
    if (this.adsSens && this.adsSensOut) {
      this.adsSens.value = String(s.touchAdsSens)
      this.adsSensOut.textContent = `${Math.round(s.touchAdsSens * 100)}%`
    }
    const voice = getSettings()
    if (this.voiceChat) {
      this.voiceChat.checked = voice.voiceChat
    }
    if (this.voicePtt) {
      this.voicePtt.checked = voice.voicePushToTalk
    }
    if (this.voiceVol && this.voiceVolOut) {
      this.voiceVol.value = String(voice.voiceChatVolume)
      this.voiceVolOut.textContent = `${Math.round(voice.voiceChatVolume * 100)}%`
    }
  }
}
