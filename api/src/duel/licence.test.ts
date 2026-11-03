import { describe, expect, it } from 'bun:test'
import {
  LICENCE_MASK,
  licenceCopy,
  licenceStatus,
} from '../../../src/experiments/out-west/data/licence.ts'

describe('Bounty Hunt licence', () => {
  it('needs the first three outlaws, and only those', () => {
    expect(LICENCE_MASK).toBe(0b111)
    expect(licenceStatus(0)).toEqual({ licensed: false, cleared: 0, remaining: 3 })
    expect(licenceStatus(0b1)).toEqual({ licensed: false, cleared: 1, remaining: 2 })
    expect(licenceStatus(0b011)).toEqual({ licensed: false, cleared: 2, remaining: 1 })
    expect(licenceStatus(0b111).licensed).toBe(true)
    // later outlaws don't stand in for the first three
    expect(licenceStatus(0b1_1111_1000)).toEqual({ licensed: false, cleared: 0, remaining: 3 })
    expect(licenceStatus((1 << 17) - 1)).toEqual({ licensed: true, cleared: 3, remaining: 0 })
  })

  it('the account plate says what is true, and what is left', () => {
    expect(licenceCopy(licenceStatus(0b111))).toEqual({
      kicker: 'Licensed gunslinger',
      progress: null,
    })
    expect(licenceCopy(licenceStatus(0b1))).toEqual({
      kicker: 'Unlicensed gunslinger',
      progress: 'Clear 2 more outlaws to earn your Bounty Hunt licence',
    })
    expect(licenceCopy(licenceStatus(0b11)).progress).toBe(
      'Clear 1 more outlaw to earn your Bounty Hunt licence',
    )
    expect(licenceCopy(licenceStatus(0)).progress).toBe(
      'Clear 3 more outlaws to earn your Bounty Hunt licence',
    )
  })
})
