/**
 * The Settings sheet, from the saloon and the pause menu: music and effects volume, vibration,
 * reduced motion and graphics quality. Everything saves as you change it (`settings.ts`).
 */
import { hapticsSupported } from '../platform/haptics.ts'
import {
  type Graphics,
  getSettings,
  reducedMotion,
  type Settings,
  setReducedMotion,
  setSetting,
} from '../settings.ts'
import { button, el, panelSheet } from './sheet.ts'

let uid = 0

function slider(parent: HTMLElement, label: string, key: 'music' | 'sfx' | 'voice'): void {
  const id = `ow-set-${++uid}`
  const row = el('div', 'ow-set-row', parent)
  const l = el('label', 'ow-set-label', row, label)
  l.htmlFor = id
  const input = el('input', 'ow-set-range', row)
  input.type = 'range'
  input.id = id
  input.min = '0'
  input.max = '100'
  input.step = '5'
  input.value = String(Math.round(getSettings()[key] * 100))
  const out = el('output', 'ow-set-value', row)
  out.htmlFor.add(id)
  const show = (): void => {
    out.textContent = `${input.value}%`
    input.style.setProperty('--ow-fill', `${input.value}%`)
  }
  show()
  input.addEventListener('input', () => {
    show()
    setSetting(key, Number(input.value) / 100)
  })
}

interface ToggleOpts {
  label: string
  hint: string
  value: boolean
  change: (on: boolean) => void
}

function toggle(parent: HTMLElement, o: ToggleOpts): HTMLInputElement {
  const row = el('label', 'ow-toggle', parent)
  const input = el('input', '', row)
  input.type = 'checkbox'
  input.checked = o.value
  el('span', 'ow-toggle-label', row, o.label)
  el('span', 'ow-toggle-hint', row, o.hint)
  input.addEventListener('change', () => o.change(input.checked))
  return input
}

const GRAPHICS: readonly { id: Graphics; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'low', label: 'Low' },
  { id: 'high', label: 'High' },
]

function graphics(parent: HTMLElement): void {
  const loaded: Settings['graphics'] = getSettings().graphics
  const box = el('div', 'ow-set-graphics', parent)
  el('b', 'ow-set-label', box, 'Graphics')
  const seg = el('div', 'ow-set-seg', box)
  seg.setAttribute('role', 'radiogroup')
  seg.setAttribute('aria-label', 'Graphics quality')
  const note = el('p', 'ow-hub-note', box)
  const reload = button(box, 'Reload now', () => location.reload())
  const sync = (): void => {
    const g = getSettings().graphics
    for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) {
      const on = b.dataset.g === g
      b.classList.toggle('on', on)
      b.setAttribute('aria-checked', String(on))
    }
    const changed = g !== loaded
    note.textContent = changed
      ? 'Takes effect the next time the game loads.'
      : 'Auto picks for this device. Low is smoother on older phones; High adds shadows and detail.'
    reload.hidden = !changed
  }
  for (const g of GRAPHICS) {
    const b = el('button', 'ow-set-seg-btn', seg, g.label)
    b.type = 'button'
    b.dataset.g = g.id
    b.setAttribute('role', 'radio')
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      setSetting('graphics', g.id)
      sync()
    })
  }
  sync()
}

/** Open the Settings sheet over `root`. */
export function openSettings(root: HTMLElement, onClose?: () => void): void {
  const s = panelSheet(root, { title: 'Settings', cls: 'ow-set', ...(onClose ? { onClose } : {}) })
  const sound = el('section', 'ow-set-group', s.body)
  el('h3', 'ow-set-h', sound, 'Sound')
  slider(sound, 'Music', 'music')
  slider(sound, 'Effects', 'sfx')
  slider(sound, 'Voices', 'voice')
  const feel = el('section', 'ow-set-group', s.body)
  el('h3', 'ow-set-h', feel, 'Feel')
  const buzz = toggle(feel, {
    label: 'Vibration',
    hint: hapticsSupported()
      ? 'A buzz on your own shot and on a hit. Never on the call.'
      : 'This device can’t vibrate.',
    value: getSettings().vibration,
    change: (on) => setSetting('vibration', on),
  })
  buzz.disabled = !hapticsSupported()
  toggle(feel, {
    label: 'Reduced motion',
    hint: 'No shake, zoom or flash. Shorter kill cam.',
    value: reducedMotion(),
    change: setReducedMotion,
  })
  const look = el('section', 'ow-set-group', s.body)
  el('h3', 'ow-set-h', look, 'Look')
  graphics(look)
}
