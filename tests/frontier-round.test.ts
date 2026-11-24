import { afterEach, expect, test as it, jest } from 'bun:test'
import { CHANNEL_LEAVE } from '../src/experiments/out-west/contract/town.ts'
import { loadRecord } from '../src/experiments/out-west/ffa/client/practice.ts'
import { ROUND_SECONDS, Rounds } from '../src/experiments/out-west/ffa/client/round.ts'

const original = ['document', 'localStorage', 'cancelAnimationFrame'].map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
)

function setup(practice: boolean) {
  jest.useFakeTimers()
  const elements: Array<EventTarget & { textContent: string }> = []
  const createElement = () => {
    const element = Object.assign(new EventTarget(), {
      textContent: '',
      classList: { toggle: jest.fn(), add: jest.fn(), remove: jest.fn() },
      append: jest.fn(),
      replaceChildren: jest.fn(),
      setAttribute: jest.fn(),
      focus: jest.fn(),
      querySelector: () => null,
      remove: jest.fn(),
    })
    elements.push(element)
    return element
  }
  const storage = new Map<string, string>()
  Reflect.set(globalThis, 'document', { createElement })
  Reflect.set(globalThis, 'cancelAnimationFrame', jest.fn())
  Reflect.set(globalThis, 'localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
  const can = { alive: true, carried: 0 }
  const send = jest.fn()
  const leave = jest.fn()
  const root = createElement() as unknown as HTMLElement
  const rounds = new Rounds(root, root, {
    practice,
    audio: null,
    you: () => 1,
    alive: () => can.alive,
    carried: () => can.carried,
    banked: () => 0,
    isBot: () => false,
    send,
    feed: jest.fn(),
    onOpen: jest.fn(),
    leave,
    canLeave: () => can.alive,
    blocked: () => false,
  })
  const click = (label: string) => {
    const button = elements.findLast((el) => el.textContent === label)
    if (!button) {
      throw new Error(`Missing button ${label}`)
    }
    button.dispatchEvent(new Event('click'))
  }
  return { rounds, send, leave, click, can }
}

afterEach(() => {
  jest.useRealTimers()
  for (const [key, descriptor] of original) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor)
    } else {
      Reflect.deleteProperty(globalThis, key)
    }
  }
})

it('a practice summary settles once and keeps the town running for the full leave channel', () => {
  const { rounds, send, leave, click } = setup(true)
  try {
    jest.advanceTimersByTime(ROUND_SECONDS * 1000 + 250)
    expect(rounds.summaryOpen).toBe(true)
    click('Leave town')
    click('Leave town')
    jest.advanceTimersByTime(6000)
    expect(rounds.state).toMatchObject({ round: 1, open: false })
    click('Ride again')
    expect(rounds.state.round).toBe(1)
    expect(loadRecord().rounds).toBe(1)
    expect(leave).toHaveBeenCalledTimes(1)
    expect(send.mock.calls.map(([text]) => JSON.parse(text))).toEqual([
      { type: 'practice_pause', on: true },
      { type: 'practice_pause', on: false },
    ])

    rounds.event({ type: 'channel_cancel', player: 2, kind: CHANNEL_LEAVE })
    expect(rounds.summaryOpen).toBe(false)
    rounds.event({ type: 'channel_cancel', player: 1, kind: CHANNEL_LEAVE })
    expect(rounds.summaryOpen).toBe(true)
    expect(loadRecord().rounds).toBe(1)
    click('Ride again')
    click('Ride again')
    expect(rounds.state).toMatchObject({ round: 2, open: false })
    expect(rounds.state.left).toBeGreaterThan(ROUND_SECONDS - 1)
    expect(send.mock.calls.map(([text]) => JSON.parse(text)).slice(2)).toEqual([
      { type: 'practice_pause', on: true },
      { type: 'practice_record', rounds: 1, kd: 1 },
      { type: 'practice_pause', on: false },
    ])
  } finally {
    rounds.dispose()
  }
})

it('a live overtime callback cannot end the next round or interrupt leaving', () => {
  const { rounds, send, leave, click, can } = setup(false)
  try {
    can.carried = 25
    jest.advanceTimersByTime(ROUND_SECONDS * 1000 + 250)
    expect(rounds.summaryOpen).toBe(false)
    rounds.event({ type: 'kill', victim: 1, killer: 2, flags: 0, bounty: 0 })
    can.alive = false
    jest.advanceTimersByTime(251)
    expect(rounds.summaryOpen).toBe(true)
    click('Ride again')
    jest.advanceTimersByTime(1300)
    expect(rounds.state).toMatchObject({ round: 2, open: false })
    rounds.devEnd()
    click('Leave town')
    expect(leave).not.toHaveBeenCalled()
    can.alive = true
    jest.advanceTimersByTime(6000)
    expect(rounds.summaryOpen).toBe(false)
    expect(leave).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
    expect(loadRecord().rounds).toBe(0)
  } finally {
    rounds.dispose()
  }
})
