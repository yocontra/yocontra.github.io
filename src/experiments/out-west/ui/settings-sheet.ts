/**
 * The Settings sheet, from the saloon and the pause menu: volumes and mono audio, captions and
 * toggle walk, vibration, reduced motion and graphics quality. Everything saves as you change it
 * (`settings.ts`).
 */
import { hapticsSupported } from '../platform/haptics.ts'
import {
  type Graphics,
  getSettings,
  type RunFlag,
  runFlag,
  type Settings,
  setRunFlag,
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

/** A switch kept in the run's save (reduced motion, captions, mono, toggle walk). */
function flag(parent: HTMLElement, key: RunFlag, copy: { label: string; hint: string }): void {
  toggle(parent, { ...copy, value: runFlag(key), change: (on) => setRunFlag(key, on) })
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
      ? 'Reload to apply.'
      : 'Low runs smoother on older phones. High adds shadows.'
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
  flag(sound, 'mono', { label: 'Mono audio', hint: 'All sound in both ears.' })
  const feel = el('section', 'ow-set-group', s.body)
  el('h3', 'ow-set-h', feel, 'Controls')
  flag(feel, 'captions', { label: 'Captions', hint: 'Show sounds and speech as text.' })
  flag(feel, 'toggleWalk', { label: 'Toggle walk', hint: 'Press once to walk, again to stop.' })
  const buzz = toggle(feel, {
    label: 'Vibration',
    hint: hapticsSupported()
      ? 'When you shoot or get hit. Never on the bell.'
      : 'Not available on this device.',
    value: getSettings().vibration,
    change: (on) => setSetting('vibration', on),
  })
  buzz.disabled = !hapticsSupported()
  flag(feel, 'reducedMotion', {
    label: 'Reduced motion',
    hint: 'No shake, zoom or flash. Shorter kill cam.',
  })
  const look = el('section', 'ow-set-group', s.body)
  el('h3', 'ow-set-h', look, 'Display')
  graphics(look)
}
