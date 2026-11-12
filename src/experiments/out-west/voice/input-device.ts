/** Browser microphone identifiers stay on this device, outside run saves and game controls. */
const KEY = 'ow.voice.input.v1'
let selected: string | undefined
let access = false
const inputs = new Set<() => void>()
const permissions = new Set<() => void>()

export function getMicrophoneInput(): string {
  if (selected === undefined) {
    try {
      selected = localStorage.getItem(KEY) ?? ''
    } catch {
      selected = ''
    }
  }
  return selected
}

export function setMicrophoneInput(id: string): void {
  if (id === getMicrophoneInput()) {
    return
  }
  selected = id
  try {
    if (id) {
      localStorage.setItem(KEY, id)
    } else {
      localStorage.removeItem(KEY)
    }
  } catch {
    // Private browsing can keep the choice for this visit only.
  }
  for (const notify of inputs) {
    notify()
  }
}

export function onMicrophoneInput(notify: () => void): () => void {
  inputs.add(notify)
  return () => inputs.delete(notify)
}

export function reportMicrophoneAccess(): void {
  access = true
  for (const notify of permissions) {
    notify()
  }
}

export function onMicrophoneAccess(notify: () => void): () => void {
  permissions.add(notify)
  return () => permissions.delete(notify)
}

/**
 * A "System default" capture stays on the device it opened. Chromium lists the current default as
 * `default` (sharing the physical device's group); Safari lists it first.
 */
export function systemDefaultMoved(
  capture: Pick<MediaTrackSettings, 'deviceId' | 'groupId'>,
  devices: readonly Pick<MediaDeviceInfo, 'deviceId' | 'groupId' | 'kind'>[],
): boolean {
  const listed = devices.filter((device) => device.kind === 'audioinput' && device.deviceId)
  const current = listed.find((device) => device.deviceId === 'default') ?? listed[0]
  if (!current) {
    return false
  }
  if (current.deviceId === 'default') {
    return Boolean(capture.groupId && current.groupId && capture.groupId !== current.groupId)
  }
  return Boolean(
    capture.deviceId && capture.deviceId !== 'default' && capture.deviceId !== current.deviceId,
  )
}

/** Enumeration never opens a permission prompt or starts capture. */
export async function availableMicrophones(): Promise<MediaDeviceInfo[] | null> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return null
  }
  let allowed = access
  try {
    const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    allowed = permission.state === 'granted'
  } catch {
    // Browsers without the microphone Permissions API can use a successful explicit capture.
  }
  if (!allowed) {
    return null
  }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    (device) => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default',
  )
  const id = getMicrophoneInput()
  if (id && !devices.some((device) => device.deviceId === id)) {
    setMicrophoneInput('')
  }
  return devices
}
