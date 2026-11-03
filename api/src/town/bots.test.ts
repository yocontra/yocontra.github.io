import { describe, expect, it } from 'bun:test'
import { botName, freshBotName } from './bots.ts'

const DIGIT = /\d/u

describe('bot names', () => {
  it('64 distinct names with no numeric suffixes', () => {
    const names = Array.from({ length: 64 }, (_, n) => botName(n))
    expect(new Set(names).size).toBe(64)
    expect(names.filter((n) => DIGIT.test(n))).toEqual([])
  })

  it('a full town of 32 bots never repeats a name, whatever the seeds', () => {
    const inUse = new Set<string>()
    for (let i = 0; i < 32; i++) {
      inUse.add(freshBotName(7 * i, inUse))
    }
    expect(inUse.size).toBe(32)
  })
})
