import { describe, expect, it } from 'bun:test'
import { RANKED_RESUME_WINDOW_MS } from '../../../src/experiments/out-west/contract/ranked.ts'
import type { Env } from '../env.ts'
import { creditJobFor } from './credit.ts'
import { resumeToken, verifyResumeToken } from './resume-token.ts'
import { newRun, resumedInfo, resumeVerdict } from './run-state.ts'

const run = () =>
  newRun({ sessionId: 's1', clientHash: 'h', accountId: 'a1', accountName: 'Ann', now: 1000 })

const stats = { fakesSeen: 0, coward: null, waitedMs: 2000 }

describe('ranked resume window', () => {
  it('a connected run can always be taken over; a dropped one only within 30 s', () => {
    const r = run()
    expect(resumeVerdict(r, 10_000_000, true)).toBe('ok')
    r.droppedAt = 5000
    expect(resumeVerdict(r, 5000 + RANKED_RESUME_WINDOW_MS, false)).toBe('ok')
    expect(resumeVerdict(r, 5001 + RANKED_RESUME_WINDOW_MS, false)).toBe('expired')
  })

  it('after a restart (no recorded drop) the last save stands in for it', () => {
    const r = run()
    r.savedAt = 2000
    expect(resumeVerdict(r, 2000 + RANKED_RESUME_WINDOW_MS - 1, false)).toBe('ok')
    expect(resumeVerdict(r, 2001 + RANKED_RESUME_WINDOW_MS, false)).toBe('expired')
  })

  it('a finished run never resumes', () => {
    const r = run()
    r.finished = true
    expect(resumeVerdict(r, 1000, true)).toBe('finished')
  })

  it('the resume info carries the server-owned progress and the voided duel', () => {
    const r = run()
    r.level = 4
    r.records = [
      { level: 0, outcome: 'win', reactionMs: 200 },
      { level: 1, outcome: 'win', reactionMs: 210 },
    ]
    r.nextDuel = 7
    const info = resumedInfo(r, 6)
    expect(info).toMatchObject({ level: 4, phase: 1, nextDuel: 7, voided: 6, duels: 2 })
    expect(info.purse).toBeGreaterThan(0)
  })
})

describe('ranked rewards', () => {
  it('the Midnight frame needs the final win of a run with no cowardice', () => {
    const r = run()
    r.complete = true
    const win = { level: 16, outcome: 'win' as const, reactionMs: 200, stats, bossPhaseOne: false }
    expect(creditJobFor(r, win).grants).toEqual(['frame.midnight'])
    expect(creditJobFor({ ...r, coward: true }, win).grants).toBeUndefined()
    expect(creditJobFor({ ...r, complete: false }, win).grants).toBeUndefined()
    expect(creditJobFor(r, { ...win, bossPhaseOne: true }).grants).toBeUndefined()
  })
})

describe('resume token', () => {
  const env = { AUTH_SECRET: 'resume-token-test-secret' } as unknown as Env
  it('verifies only for its own session, and not when tampered with', async () => {
    const token = await resumeToken(env, 'abc')
    expect(await verifyResumeToken(env, 'abc', token)).toBe(true)
    expect(await verifyResumeToken(env, 'abd', token)).toBe(false)
    const flipped = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`
    expect(await verifyResumeToken(env, 'abc', flipped)).toBe(false)
    expect(await verifyResumeToken(env, 'abc', '')).toBe(false)
  })
})
