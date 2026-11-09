/** Preferences and short speaking leases use the existing authenticated game control channel. */
export type VoiceClientControl =
  | { type: 'voice_on'; listening?: boolean; muted?: number[] }
  | { type: 'voice_talk'; talking: boolean }
  | { type: 'voice_off' }

export type VoiceServerControl =
  | { type: 'voice_status'; listeners: number; speakers: number[] }
  | { type: 'voice_ready'; generation: number; meetingId: string; token: string }
  | { type: 'voice_standby' }
  | { type: 'voice_error'; message: string }

export const VOICE_INTENT_TTL_MS = 2500
export const VOICE_HEARTBEAT_MS = 750
export const VOICE_IDLE_MS = 1000
