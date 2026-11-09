/** Durable remote teardown entries contain identifiers only, never participant tokens. */
import type { Env } from '../env.ts'
import { endVoiceSession, removeVoiceParticipant } from './realtime.ts'

export interface VoiceGeneration {
  id: number
  meetingId: string
  participants: Record<string, string>
  reserved?: number[]
  leaseUntil?: number
  renewAt?: number
}
export interface VoiceStorage {
  active?: VoiceGeneration
  cleanup?: VoiceCleanup[]
  next?: number
  /** Previous releases stored these fields directly. They are cleanup-only on restoration. */
  meetingId?: string
  participants?: Record<string, string>
}
export interface VoiceCleanup {
  generation: number
  meetingId: string
  participants: string[]
  end: boolean
  ended: boolean
  retryAt: number
  attempts: number
}
export async function cleanVoiceEntry(options: {
  env: Env
  entry: VoiceCleanup
  activeMeeting: () => string | undefined
  now: () => number
  persist: () => Promise<void>
}): Promise<boolean> {
  const { entry } = options
  try {
    if (entry.end && options.activeMeeting() === entry.meetingId) {
      throw new Error('Active generation owns this meeting')
    }
    if (entry.end && !entry.ended) {
      await endVoiceSession(options.env, entry.meetingId)
      entry.ended = true
      await options.persist()
    }
    const results = await Promise.allSettled(
      entry.participants.map((id) => removeVoiceParticipant(options.env, entry.meetingId, id)),
    )
    entry.participants = entry.participants.filter(
      (_id, index) => results[index]?.status !== 'fulfilled',
    )
    if (entry.participants.length > 0) {
      throw new Error('Participant revocation needs retry')
    }
    return true
  } catch {
    entry.attempts++
    entry.retryAt = options.now() + Math.min(60_000, 5000 * 2 ** Math.min(4, entry.attempts - 1))
    return false
  }
}
