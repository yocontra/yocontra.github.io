import { afterEach, expect, test as it, jest } from 'bun:test'
import type { VoiceClientControl } from '../../src/experiments/out-west/contract/voice.ts'
import { RiderBlocks } from '../../src/experiments/out-west/ffa/client/rider-blocks.ts'
import type { VoiceTransport } from '../../src/experiments/out-west/voice/transport.ts'
import { VoiceChat } from '../../src/experiments/out-west/voice/voice-chat.ts'

const originalStream = Reflect.get(globalThis, 'MediaStream')
const originalDocument = Reflect.get(globalThis, 'document')
afterEach(() => {
  Reflect.set(globalThis, 'MediaStream', originalStream)
  Reflect.set(globalThis, 'document', originalDocument)
})
function remoteTrack() {
  return Object.assign(new EventTarget(), {
    kind: 'audio',
    readyState: 'live',
  }) as MediaStreamTrack
}
class FixtureMediaStream {
  readonly tracks: MediaStreamTrack[]
  constructor(tracks: MediaStreamTrack[]) {
    this.tracks = tracks
  }
}
function audioElement() {
  return Object.assign(new EventTarget(), {
    muted: false,
    defaultMuted: false,
    volume: 1,
    srcObject: null as MediaProvider | null,
    pause: () => undefined,
    play: () => Promise.resolve(),
    remove: () => undefined,
  })
}
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

it('reconciles confirmed rider blocks through live voice before SDK unsubscribe completes', async () => {
  Reflect.set(globalThis, 'MediaStream', FixtureMediaStream)
  const elements: ReturnType<typeof audioElement>[] = []
  Reflect.set(
    globalThis,
    'document',
    Object.assign(new EventTarget(), {
      hidden: false,
      createElement: () => {
        const element = audioElement()
        elements.push(element)
        return element
      },
    }),
  )
  const initial = Promise.withResolvers<ReadonlySet<string>>()
  const unsubscribed = Promise.withResolvers<void>()
  const peers = [{ id: 1, name: 'Fellow Rider', x: 2, y: 0, z: 0 }]
  const sent: VoiceClientControl[] = []
  const gains: number[] = []
  const blocks = new RiderBlocks(initial.promise, () => voice.update(peers, { x: 0, z: 0 }))
  const voice = new VoiceChat({
    audio: {
      attachVoiceChat: () => ({
        setGain: (gain) => gains.push(gain),
        setPose: () => undefined,
        dispose: () => undefined,
      }),
    },
    microphone: () => null,
    activity: () => null,
    audioRunning: () => true,
    listening: () => true,
    settings: () => ({ voiceChat: true, voicePushToTalk: true }),
    muted: (id) => blocks.has(peers.find((peer) => peer.id === id)?.name),
    send: (control) => sent.push(control),
  })
  const transport = Reflect.get(voice, 'transport') as VoiceTransport
  Object.assign(Reflect.get(voice, 'live'), { enabled: true, connected: true, requested: true })
  const audio = remoteTrack()
  let deliverAudio: ((event: { audioTrack: MediaStreamTrack }) => void) | undefined
  const participant = {
    id: 'sdk-peer',
    customParticipantId: '1',
    audioTrack: audio,
    on: (_name: string, callback: typeof deliverAudio) => {
      deliverAudio = callback
    },
    off: () => {
      deliverAudio = undefined
    },
  }
  const subscribed = new Map([[participant.id, participant]])
  const unsubscribe = jest.fn(() =>
    unsubscribed.promise.then(() => {
      subscribed.delete(participant.id)
    }),
  )
  const meeting = {
    self: { cleanUpTracks: () => undefined },
    leave: () => Promise.resolve(),
    participants: {
      audioSubscribed: subscribed,
      subscribe: () => {
        subscribed.set(participant.id, participant)
        return Promise.resolve()
      },
      unsubscribe,
    },
  }
  try {
    voice.update(peers, { x: 0, z: 0 })
    Reflect.set(transport, 'meeting', meeting)
    Reflect.apply(Reflect.get(transport, 'addParticipant'), transport, [participant])
    voice.receive({ type: 'voice_status', listeners: 1, speakers: [1] })
    await flush()
    expect(gains.at(-1)).toBe(1)
    expect(elements[0]?.srcObject).not.toBeNull()

    blocks.apply('FELLOW RIDER', true)
    expect(sent.at(-1)).toEqual({ type: 'voice_on', listening: true, muted: [1] })
    expect(gains.at(-1)).toBe(0)
    deliverAudio?.({ audioTrack: remoteTrack() })
    expect(elements).toHaveLength(1)
    expect(elements[0]?.srcObject).toBeNull()

    voice.receive({ type: 'voice_status', listeners: 0, speakers: [1] })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(subscribed.has(participant.id)).toBe(true)
    initial.resolve(new Set(['another rider']))
    await flush()
    expect(blocks.has('Fellow Rider')).toBe(true)
    expect(blocks.has('Another Rider')).toBe(true)
    expect(sent.at(-1)).toEqual({ type: 'voice_on', listening: true, muted: [1] })

    blocks.apply('fellow rider', false)
    expect(sent.at(-1)).toEqual({ type: 'voice_on', listening: true, muted: [] })
    voice.receive({ type: 'voice_status', listeners: 1, speakers: [1] })
    unsubscribed.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    expect(elements).toHaveLength(2)
    expect(gains.at(-1)).toBe(1)
  } finally {
    initial.resolve(new Set())
    unsubscribed.resolve()
    await voice.dispose()
  }
})

it('keeps a confirmed unblock through an older block-list load', async () => {
  const initial = Promise.withResolvers<ReadonlySet<string>>()
  const blocks = new RiderBlocks(initial.promise, () => undefined)
  blocks.apply('Fellow Rider', false)
  initial.resolve(new Set(['fellow rider']))
  await initial.promise
  expect(blocks.has('Fellow Rider')).toBe(false)
})
