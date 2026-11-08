import { expect, test as it } from 'bun:test'
import { judgePvp } from '../../api/src/duel/judge-pvp.ts'
import { GameLinkSampler } from '../../api/src/game/rtt.ts'
import { rttStats } from '../../api/src/judge.ts'
import { RTT_SAMPLES } from '../../api/src/net/constants.ts'

it('only server-bound nonce round trips affect the bounded game judging samples', () => {
  const samples: number[] = []
  let nonce = ''
  const sampler = new GameLinkSampler(samples, (value) => {
    nonce = value
  })
  sampler.activity(1000)
  sampler.pong({ nonce: 'forged', rtt: 0 }, 1100)
  expect(samples).toEqual([])
  sampler.pong({ nonce, rtt: 0 }, 1200)
  sampler.pong({ nonce }, 1300)
  expect(samples).toEqual([200])
  for (let i = 1; i <= RTT_SAMPLES + 2; i++) {
    sampler.activity(1000 + i * 5000)
    sampler.pong({ nonce }, 1200 + i * 5000)
  }
  expect(samples.length).toBe(RTT_SAMPLES)
  const link = { ...rttStats(samples), tcp: 160 }
  expect(
    judgePvp({
      callSentAt: [1000, 1000],
      shotSeenAt: [1400, 1300],
      localMs: [200, 300],
      rtt: [link, { median: 0, jitter: 0, tcp: null }],
      now: 1500,
    }),
  ).toMatchObject({ kind: 'win', winner: 0 })
})

it('replaces lost probes and ignores impossible or expired round trips', () => {
  const samples: number[] = []
  let nonce = ''
  const sampler = new GameLinkSampler(samples, (value) => {
    nonce = value
  })
  sampler.activity(1000)
  const old = nonce
  sampler.activity(6000)
  sampler.pong({ nonce: old }, 6100)
  expect(samples).toEqual([])
  sampler.pong({ nonce }, 8500)
  expect(samples).toEqual([])
  sampler.activity(11_000)
  sampler.pong({ nonce }, 10_999)
  expect(samples).toEqual([])
})
