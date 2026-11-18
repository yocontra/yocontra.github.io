/** Nonbillable transport fixture. Standby capture and native audio are the real browser APIs. */

import {
  gameId as nativeGameId,
  microphoneFailure as nativeMicrophoneFailure,
  publishVoiceMicrophone as nativePublishVoiceMicrophone,
  safeTrack as nativeSafeTrack,
} from '../../src/experiments/out-west/voice/meeting.ts'

export type { VoiceCredentials } from '../../src/experiments/out-west/voice/meeting.ts'
export const gameId = nativeGameId
export const microphoneFailure = nativeMicrophoneFailure
export const publishVoiceMicrophone = nativePublishVoiceMicrophone
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
let heldLeave = false
const pendingLeaves: (() => void)[] = []
let leaves = 0
let captures = 0
let disables = 0
let heldDisable = false
let heldEnable = false
let resolveDisable: (() => void) | undefined
let resolveEnable: (() => void) | undefined
const outputs: MediaStreamTrack[] = []
const initiallyEnabled: boolean[] = []

type Speaker = Events & { id: string; customParticipantId: string; audioTrack: MediaStreamTrack }
function createMeeting() {
  const joined = Object.assign(new Map<string, Speaker>(), new Events())
  // Map and the SDK event collection expose both interfaces.
  const events = new Events()
  const participants = {
    joined: Object.assign(joined, { on: events.on.bind(events), off: events.off.bind(events) }),
    audioSubscribed: new Map<string, Speaker>(),
    setViewMode: () => Promise.resolve(),
    subscribe: (ids: string[]) => {
      for (const id of ids) {
        const speaker = joined.get(id)
        if (speaker) {
          participants.audioSubscribed.set(id, speaker)
        }
      }
      return Promise.resolve()
    },
    unsubscribe: (ids: string[]) => {
      for (const id of ids) {
        participants.audioSubscribed.delete(id)
      }
      return Promise.resolve()
    },
  }
  const self = Object.assign(new Events(), {
    audioTrack: undefined as MediaStreamTrack | undefined,
    mediaPermissions: { audio: undefined },
    cleanUpTracks: () => self.audioTrack?.stop(),
    enableAudio: async (track: MediaStreamTrack) => {
      captures++
      initiallyEnabled.push(track.enabled)
      outputs.push(track)
      if (heldEnable) {
        await new Promise<void>((resolve) => {
          resolveEnable = resolve
        })
      }
      self.audioTrack = track
      self.emit('audioUpdate', { audioTrack: track })
    },
    disableAudio: async () => {
      disables++
      if (heldDisable) {
        await new Promise<void>((resolve) => {
          resolveDisable = resolve
        })
      }
      self.audioTrack?.stop()
      self.audioTrack = undefined
      self.emit('audioUpdate', { audioTrack: undefined })
    },
  })
  return {
    self,
    participants,
    events,
    join: () =>
      held
        ? new Promise<void>((resolve) => {
            resolveJoin = resolve
          })
        : Promise.resolve(),
    leave: () => {
      leaves++
      self.emit('roomLeft', {})
      return heldLeave
        ? new Promise<void>((resolve) => pendingLeaves.push(resolve))
        : Promise.resolve()
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
export async function releaseVoiceMeeting(
  meeting: ReturnType<typeof createMeeting>,
): Promise<void> {
  meeting.self.cleanUpTracks()
  await meeting.leave()
}

export function fixtureState() {
  return {
    captures,
    initiallyEnabled,
    leaves,
    leaving: pendingLeaves.length,
    joining: resolveJoin !== undefined,
    track: latest?.self.audioTrack?.readyState,
    enabled: latest?.self.audioTrack?.enabled,
    disables,
    disabling: resolveDisable !== undefined,
    enabling: resolveEnable !== undefined,
    outputs: outputs.map((track) => ({
      state: track.readyState,
      deviceId: track.getSettings().deviceId,
    })),
  }
}
export function holdMicrophone(disable: boolean, enable: boolean): void {
  heldDisable = disable
  heldEnable = enable
}
export function finishMicrophone(): void {
  heldDisable = false
  heldEnable = false
  resolveDisable?.()
  resolveEnable?.()
  resolveDisable = undefined
  resolveEnable = undefined
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

export function holdLeave(value: boolean): void {
  heldLeave = value
}
export function finishLeave(): void {
  heldLeave = false
  for (const resolve of pendingLeaves.splice(0)) {
    resolve()
  }
}

export function addSpeaker(track: MediaStreamTrack): void {
  if (!latest) {
    throw new Error('No receive meeting')
  }
  const participant = Object.assign(new Events(), {
    id: '7',
    customParticipantId: '7',
    audioTrack: track,
  })
  latest.participants.joined.set('7', participant)
  latest.events.emit('participantJoined', participant)
}
