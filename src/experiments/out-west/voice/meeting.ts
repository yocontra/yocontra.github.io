import type Client from '@cloudflare/realtimekit'
import type { RTKParticipant } from '@cloudflare/realtimekit'
import { reportMicrophoneAccess } from './input-device.ts'

const GAME_ID = /^\d+$/u

export interface VoiceCredentials {
  generation: number
  meetingId: string
  token: string
}

/** Standby capture is local and needs no SDK import, meeting, token, or provider connection. */
export async function captureMicrophone(deviceId = ''): Promise<MediaStreamTrack> {
  if (!(globalThis.isSecureContext && navigator.mediaDevices?.getUserMedia)) {
    throw new Error('Microphone access requires HTTPS and a browser with voice support.')
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      video: false,
    })
    const track = stream.getAudioTracks()[0]
    for (const other of stream.getTracks()) {
      if (other !== track) {
        other.stop()
      }
    }
    if (!track) {
      throw new Error(microphoneFailure(undefined))
    }
    reportMicrophoneAccess()
    return track
  } catch (error) {
    if (error instanceof DOMException) {
      let permission = 'COULD_NOT_START'
      if (error.name === 'NotAllowedError') {
        permission = 'DENIED'
      } else if (error.name === 'NotFoundError') {
        permission = 'NO_DEVICES_AVAILABLE'
      }
      throw new Error(microphoneFailure(permission), { cause: error })
    }
    throw error
  }
}

/** Import and join only after authoritative speech plus a distinct eligible human audience. */
export async function prepareVoiceMeeting(
  credentials: VoiceCredentials,
  active: () => boolean,
): Promise<Client | null> {
  const sdk = await import('@cloudflare/realtimekit')
  if (!active()) {
    return null
  }
  const meeting = await sdk.default.init({
    authToken: credentials.token,
    defaults: {
      audio: false,
      video: false,
      mediaConfiguration: {
        audio: {
          echoCancellation: true,
          noiseSupression: true,
          autoGainControl: true,
          enableStereo: false,
        },
      },
    },
    overrides: { forceRelay: true },
    // Remote tracks are routed through the game's existing positional audio context.
    modules: { experimentalAudioPlayback: false },
  })
  if (!active()) {
    await releaseVoiceMeeting(meeting)
    return null
  }
  return meeting
}

/** Publish the caller's gated stream as a custom track after joining. */
export async function publishVoiceMicrophone(
  meeting: Client,
  track: MediaStreamTrack,
  active: () => boolean,
): Promise<boolean> {
  if (!active()) {
    return false
  }
  await meeting.self.enableAudio(track)
  if (!active()) {
    return false
  }
  if (meeting.self.audioTrack !== track || track.readyState === 'ended' || !track.enabled) {
    throw new Error(microphoneFailure(meeting.self.mediaPermissions.audio))
  }
  return true
}

export async function releaseVoiceMeeting(meeting: Client): Promise<void> {
  meeting.self.cleanUpTracks()
  await meeting.leave().catch(() => undefined)
}

export function microphoneFailure(permission: string | undefined): string {
  if (permission === 'DENIED' || permission === 'SYSTEM_DENIED') {
    return 'Microphone blocked. Allow microphone access in your browser settings, then retry.'
  }
  if (permission === 'NO_DEVICES_AVAILABLE') {
    return 'No microphone found. Connect a microphone, then retry.'
  }
  if (permission === 'COULD_NOT_START') {
    return 'Microphone could not start. Check other apps using it, then retry.'
  }
  return 'Microphone was not started. Retry voice and allow microphone access.'
}

/** The game id carried in `customParticipantId`; 0 is a real Frontier player and Duel seat. */
export function gameId(custom: string | undefined): number | null {
  if (typeof custom !== 'string' || !GAME_ID.test(custom)) {
    return null
  }
  const id = Number(custom)
  return Number.isSafeInteger(id) ? id : null
}

export function safeTrack(p: RTKParticipant): MediaStreamTrack | null {
  try {
    return p.audioTrack ?? null
  } catch {
    return null
  }
}
