import { describe, expect, test as it } from 'bun:test'
import { nameKey, validateName } from './names.ts'

describe('validateName', () => {
  it('accepts and tidies ordinary names', () => {
    expect(validateName('  Wild   Bill ')).toEqual({ ok: true, name: 'Wild Bill', key: 'wildbill' })
    expect(validateName("D'Artagnan_99")).toMatchObject({ ok: true })
    expect(validateName('Zoë')).toMatchObject({ ok: true, key: 'zoe' })
  })

  it('rejects empty, long, and odd input', () => {
    expect(validateName('')).toMatchObject({ ok: false })
    expect(validateName('   ')).toMatchObject({ ok: false })
    expect(validateName(42)).toMatchObject({ ok: false })
    expect(validateName('a'.repeat(17))).toMatchObject({ ok: false })
    expect(validateName('<script>')).toMatchObject({ ok: false })
    expect(validateName('---')).toMatchObject({ ok: false })
  })

  it('blocks obvious slurs and profanity, including leetspeak', () => {
    expect(validateName('fuckface')).toMatchObject({ ok: false })
    expect(validateName('sh1t head')).toMatchObject({ ok: false })
    expect(validateName('N4ZI')).toMatchObject({ ok: false })
  })
})

describe('nameKey', () => {
  it('groups names regardless of case, accents and spacing', () => {
    expect(nameKey('Wild Bill')).toBe(nameKey('wildbill'))
    expect(nameKey('ZOË')).toBe('zoe')
  })
})
