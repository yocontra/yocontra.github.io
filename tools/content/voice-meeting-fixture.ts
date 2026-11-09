/** Nonbillable transport fixture. Standby capture and native audio are the real browser APIs. */

import {
  gameId as nativeGameId,
  safeTrack as nativeSafeTrack,
} from '../../src/experiments/out-west/voice/meeting.ts'

export type { VoiceCredentials } from '../../src/experiments/out-west/voice/meeting.ts'
export const gameId = nativeGameId
export const safeTrack = nativeSafeTrack

class Events {
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>()
  on(name: string, listener: (value: unknown) => void): void {
    const listeners = this.listeners.get(name) ?? new Set()
    listeners.add(listener)
    this.listeners.set(name, listeners)
  }
  off(name: string, listener: (value: unknown) => void): void {
    this.listeners.get(name)?.delete(listener)
  }
  emit(name: string, value: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener(value)
    }
  }
}

let latest: ReturnType<typeof createMeeting> | undefined
let held = false
let resolveJoin: (() => void) | undefined
let leaves = 0
let captures = 0

function createMeeting() {
  const self = Object.assign(new Events(), {
    audioTrack: undefined as MediaStreamTrack | undefined,
    cleanUpTracks: () => self.audioTrack?.stop(),
  })
  return {
    self,
    participants: {
      joined: Object.assign(new Map<string, never>(), {
        on: () => undefined,
        off: () => undefined,
      }),
      audioSubscribed: new Map(),
      setViewMode: () => Promise.resolve(),
      subscribe: () => Promise.resolve(),
      unsubscribe: () => Promise.resolve(),
    },
    join: () =>
      held
        ? new Promise<void>((resolve) => {
            resolveJoin = resolve
          })
        : Promise.resolve(),
    leave: () => {
      leaves++
      self.emit('roomLeft', {})
      return Promise.resolve()
    },
  }
}

export function prepareVoiceMeeting(_credentials: unknown, active: () => boolean) {
  if (!active()) {
    return Promise.resolve(null)
  }
  latest = createMeeting()
  return Promise.resolve(latest)
}
export function publishVoiceMicrophone(
  meeting: ReturnType<typeof createMeeting>,
  original: MediaStreamTrack,
  active: () => boolean,
) {
  if (!active()) {
    return Promise.resolve(null)
  }
  captures++
  const clone = original.clone()
  clone.enabled = false
  meeting.self.audioTrack = clone
  return Promise.resolve(clone)
}

export async function releaseVoiceMeeting(
  meeting: ReturnType<typeof createMeeting>,
): Promise<void> {
  meeting.self.cleanUpTracks()
  await meeting.leave()
}

export function fixtureState() {
  return {
    captures,
    leaves,
    joining: resolveJoin !== undefined,
    track: latest?.self.audioTrack?.readyState,
    enabled: latest?.self.audioTrack?.enabled,
  }
}
export function holdJoin(value: boolean): void {
  held = value
}
export function finishJoin(): void {
  resolveJoin?.()
  resolveJoin = undefined
}
export function disconnectVoice(): void {
  latest?.self.emit('roomLeft', {})
}
