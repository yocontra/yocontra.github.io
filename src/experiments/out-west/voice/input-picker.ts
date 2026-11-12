import {
  availableMicrophones,
  getMicrophoneInput,
  onMicrophoneAccess,
  onMicrophoneInput,
  setMicrophoneInput,
} from './input-device.ts'
import { captureMicrophone } from './meeting.ts'
import './voice.css'

let uid = 0

/** Shared by both settings surfaces; only the explicit button can request microphone access. */
export function microphonePicker(parent: HTMLElement, signal: AbortSignal): void {
  if (signal.aborted) {
    return
  }
  const root = document.createElement('div')
  root.className = 'ow-voice-input fr-hit'
  const label = document.createElement('label')
  label.textContent = 'Microphone'
  const select = document.createElement('select')
  select.id = `ow-microphone-${++uid}`
  label.htmlFor = select.id
  const choose = document.createElement('button')
  choose.type = 'button'
  choose.className = 'ow-btn'
  choose.textContent = 'Choose microphone'
  const status = document.createElement('span')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  root.append(label, select, choose, status)
  parent.append(root)
  let revision = 0
  const refresh = async (): Promise<void> => {
    const version = ++revision
    const devices = await availableMicrophones().catch(() => null)
    if (signal.aborted || version !== revision) {
      return
    }
    select.replaceChildren(new Option('System default', ''))
    for (const [index, device] of (devices ?? []).entries()) {
      select.add(new Option(device.label || `Microphone ${index + 1}`, device.deviceId))
    }
    select.value = getMicrophoneInput()
    select.disabled = devices === null
    choose.hidden = devices !== null
    choose.disabled = !navigator.mediaDevices?.getUserMedia
    status.textContent =
      devices === null
        ? 'Allow microphone access to choose an input.'
        : 'Used for proximity voice on this device.'
  }
  select.addEventListener('change', () => setMicrophoneInput(select.value), { signal })
  select.addEventListener(
    'focus',
    () => {
      void refresh()
    },
    { signal },
  )
  choose.addEventListener(
    'click',
    async () => {
      choose.disabled = true
      let track: MediaStreamTrack | undefined
      try {
        track = await captureMicrophone('')
        await refresh()
      } catch (error) {
        if (!signal.aborted) {
          status.textContent =
            error instanceof Error ? error.message : 'Microphone could not start.'
        }
      } finally {
        track?.stop()
        if (!signal.aborted) {
          choose.disabled = false
        }
      }
    },
    { signal },
  )
  for (const event of ['pointerdown', 'click']) {
    root.addEventListener(event, (e) => e.stopPropagation(), { signal })
  }
  const changed = () => {
    void refresh()
  }
  const offInput = onMicrophoneInput(changed)
  const offAccess = onMicrophoneAccess(changed)
  navigator.mediaDevices?.addEventListener('devicechange', changed, { signal })
  signal.addEventListener(
    'abort',
    () => {
      revision++
      offInput()
      offAccess()
    },
    { once: true },
  )
  void refresh()
}
