import { expect, test as it } from 'bun:test'
import type { VoiceMicrophone } from '../../src/experiments/out-west/voice/native-audio.ts'
import { VoiceTransport } from '../../src/experiments/out-west/voice/transport.ts'
import { VoiceChat } from '../../src/experiments/out-west/voice/voice-chat.ts'

function track(): MediaStreamTrack {
  return Object.assign(new EventTarget(), {
    readyState: 'live' as MediaStreamTrackState,
    enabled: true,
    stop() {
      this.readyState = 'ended'
    },
  }) as MediaStreamTrack
}

function fakeMeeting() {
  const published: MediaStreamTrack[] = []
  const self = {
    audioTrack: null as MediaStreamTrack | null,
    disableAudio: () => Promise.resolve(),
    enableAudio: (output: MediaStreamTrack) => {
      self.audioTrack = output
      published.push(output)
      return Promise.resolve()
    },
    cleanUpTracks: () => undefined,
  }
  return { self, leave: () => Promise.resolve(), published }
}

function fixture() {
  const channels: { channel: VoiceMicrophone; releases: number }[] = []
  const transport = new VoiceTransport({
    audio: null,
    microphone: () => {
      const output = track()
      const item = {
        channel: {
          track: output,
          setSending: () => undefined,
          dispose: () => {
            item.releases++
            Reflect.set(output, 'readyState', 'ended')
          },
        },
        releases: 0,
      }
      channels.push(item)
      return item.channel
    },
    muted: () => false,
    onState: () => undefined,
  })
  return {
    channels,
    transport,
    attach(meeting: ReturnType<typeof fakeMeeting>) {
      Reflect.set(transport, 'meeting', meeting)
    },
  }
}

it('allows a replacement meeting to publish while the retired producer is pending', async () => {
  const f = fixture()
  const retired = fakeMeeting()
  const current = fakeMeeting()
  const publishStarted = Promise.withResolvers<true>()
  const held = Promise.withResolvers<void>()
  retired.self.enableAudio = () => {
    publishStarted.resolve(true)
    return held.promise
  }
  f.attach(retired)
  const old = f.transport.replaceMicrophone(track(), () => true).catch((error: unknown) => error)
  let replacement: Promise<boolean> | undefined
  try {
    await publishStarted.promise
    await f.transport.stop()
    f.attach(current)
    replacement = f.transport.replaceMicrophone(track(), () => true)
    await new Promise((resolve) => setImmediate(resolve))
    expect(current.published).toHaveLength(1)
    expect(await replacement).toBe(true)
    expect(f.channels.map((item) => item.releases)).toEqual([1, 0])
  } finally {
    held.reject(new Error('Retired producer failed after leaving'))
    await Promise.all([old, replacement])
    await f.transport.stop()
  }
  expect(await old).toBe(false)
  expect(f.channels.map((item) => item.releases)).toEqual([1, 1])
})

it('ignores a provider rejection after stop but propagates failure from the active meeting', async () => {
  const f = fixture()
  const retired = fakeMeeting()
  const disableStarted = Promise.withResolvers<true>()
  const held = Promise.withResolvers<void>()
  retired.self.disableAudio = () => {
    disableStarted.resolve(true)
    return held.promise
  }
  f.attach(retired)
  const old = f.transport.replaceMicrophone(track(), () => true).catch((error: unknown) => error)
  await disableStarted.promise
  await f.transport.stop()
  held.reject(new Error('Retired provider failed to disable audio'))
  expect(await old).toBe(false)
  const current = fakeMeeting()
  const failure = new Error('Active provider failed to publish audio')
  current.self.enableAudio = () => Promise.reject(failure)
  f.attach(current)
  try {
    await expect(f.transport.replaceMicrophone(track(), () => true)).rejects.toBe(failure)
    expect(f.channels.map((item) => item.releases)).toEqual([1])
    expect(await f.transport.replaceMicrophone(null, () => true)).toBe(true)
  } finally {
    await f.transport.stop()
  }
})

it('does not show an older meeting playback message after a replacement is live', async () => {
  const previousDocument = Reflect.get(globalThis, 'document')
  Reflect.set(globalThis, 'document', Object.assign(new EventTarget(), { hidden: false }))
  const states: (string | undefined)[] = []
  const voice = new VoiceChat({
    audio: null,
    microphone: () => null,
    activity: () => null,
    audioRunning: () => true,
    listening: () => true,
    settings: () => ({ voiceChat: true, voicePushToTalk: true }),
    send: () => undefined,
    onState: (_state, message) => states.push(message),
  })
  const transport = Reflect.get(voice, 'transport') as VoiceTransport
  const notify = Reflect.get(Reflect.get(transport, 'o'), 'onState') as (
    state: 'live',
    message: string,
  ) => void
  const held = Promise.withResolvers<boolean>()
  const capture = track()
  Object.assign(Reflect.get(voice, 'live'), { enabled: true, requested: true })
  Reflect.set(voice, 'microphone', capture)
  transport.connect = () => Promise.resolve()
  transport.replaceMicrophone = () => held.promise
  try {
    voice.receive({ type: 'voice_ready', generation: 1, meetingId: 'old', token: 'Test only' })
    notify('live', 'Old meeting playback message')
    voice.receive({ type: 'voice_ready', generation: 2, meetingId: 'new', token: 'Test only' })
    transport.replaceMicrophone = () => Promise.resolve(true)
    notify('live', 'Replacement playback message')
    await new Promise((resolve) => setImmediate(resolve))
    expect(states.at(-1)).toBe('Replacement playback message')
    held.resolve(false)
    await new Promise((resolve) => setImmediate(resolve))
    expect(states.at(-1)).toBe('Replacement playback message')
    expect(voice.current).toBe('live')
    expect(capture.readyState).toBe('live')
  } finally {
    held.resolve(false)
    await voice.dispose()
    Reflect.set(globalThis, 'document', previousDocument)
  }
})
