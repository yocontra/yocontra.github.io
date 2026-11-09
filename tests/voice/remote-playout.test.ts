import { afterEach, describe, expect, test as it } from 'bun:test'
import {
  RemotePlayout,
  type RemotePlayoutState,
} from '../../src/experiments/out-west/voice/remote-playout.ts'
import { VoiceTransport } from '../../src/experiments/out-west/voice/transport.ts'

function remoteTrack(): MediaStreamTrack {
  return Object.assign(new EventTarget(), {
    kind: 'audio',
    id: 'owned-remote',
    label: 'Synthetic remote',
    muted: false,
    contentHint: '',
    enabled: true,
    readyState: 'live' as MediaStreamTrackState,
    onended: null,
    onmute: null,
    onunmute: null,
    clone: remoteTrack,
    stop() {
      this.readyState = 'ended'
    },
    applyConstraints: () => Promise.resolve(),
    getCapabilities: () => ({}),
    getConstraints: () => ({}),
    getSettings: () => ({}),
  })
}

class Element extends EventTarget {
  private readonly settings: {
    muted: boolean
    defaultMuted: boolean
    level: number
    ignoreVolume: boolean
  } = { muted: false, defaultMuted: false, level: 1, ignoreVolume: false }
  get muted(): boolean {
    return this.settings.muted
  }
  set muted(value: boolean) {
    this.settings.muted = value
  }
  get defaultMuted(): boolean {
    return this.settings.defaultMuted
  }
  set defaultMuted(value: boolean) {
    this.settings.defaultMuted = value
  }
  get ignoreVolume(): boolean {
    return this.settings.ignoreVolume
  }
  set ignoreVolume(value: boolean) {
    this.settings.ignoreVolume = value
  }
  stream: MediaProvider | null = null
  silenceBeforeSource = false
  calls = 0
  readonly silentPlays: boolean[] = []
  pauses = 0
  removed = false
  playback: (() => Promise<void>) | undefined
  get volume(): number {
    return this.settings.ignoreVolume ? 1 : this.settings.level
  }
  set volume(value: number) {
    this.settings.level = value
  }
  get srcObject(): MediaProvider | null {
    return this.stream
  }
  set srcObject(value: MediaProvider | null) {
    if (value) {
      this.silenceBeforeSource = this.muted && this.defaultMuted
    }
    this.stream = value
  }
  play(): Promise<void> {
    this.silentPlays.push(this.muted && this.defaultMuted)
    this.calls++
    return this.playback?.() ?? Promise.resolve()
  }
  pause(): void {
    this.pauses++
  }
  remove(): void {
    this.removed = true
  }
}

const originalStream = Reflect.get(globalThis, 'MediaStream')
const originalDocument = Reflect.get(globalThis, 'document')
const active: RemotePlayout[] = []
const transports: VoiceTransport[] = []
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.stop()))
  for (const playout of active.splice(0)) {
    playout.dispose()
  }
  Reflect.set(globalThis, 'MediaStream', originalStream)
  Reflect.set(globalThis, 'document', originalDocument)
})
function installStream() {
  Reflect.set(
    globalThis,
    'MediaStream',
    function stream(this: { tracks: MediaStreamTrack[] }, tracks: MediaStreamTrack[]) {
      this.tracks = tracks
    },
  )
}
function fixture(element = new Element()) {
  installStream()
  const track = remoteTrack()
  const states: RemotePlayoutState[] = []
  const playout = new RemotePlayout(track, (state) => states.push(state), element)
  active.push(playout)
  return { track, element, states, playout }
}
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

it('frees old receive slots before delayed SDK unsubscribe and new audio events', async () => {
  installStream()
  const elements: Element[] = []
  Reflect.set(globalThis, 'document', {
    createElement: () => {
      const element = new Element()
      elements.push(element)
      return element
    },
  })
  const nodes = new Set<number>()
  const operations: string[] = []
  const peers = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    name: 'Synthetic peer',
    x: i < 4 ? i : 100 + i,
    y: 0,
    z: 0,
  }))
  const listeners = new Map<number, (event: { audioTrack: MediaStreamTrack }) => void>()
  const participants = new Map(
    peers.map((peer) => [
      String(peer.id),
      {
        id: String(peer.id),
        customParticipantId: String(peer.id),
        audioTrack: remoteTrack(),
        on: (_name: string, listener: (event: { audioTrack: MediaStreamTrack }) => void) =>
          listeners.set(peer.id, listener),
        off: () => listeners.delete(peer.id),
      },
    ]),
  )
  const subscribed = new Map([...participants].filter(([id]) => Number(id) <= 4))
  let release: (() => void) | undefined
  let held = false
  const meeting = {
    self: { cleanUpTracks: () => undefined },
    leave: () => Promise.resolve(),
    participants: {
      joined: participants,
      audioSubscribed: subscribed,
      unsubscribe: (ids: string[]) => {
        operations.push(`unsubscribe:${ids[0]}`)
        const wait = held
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              release = resolve
            })
        held = true
        return wait.then(() => {
          for (const id of ids) {
            subscribed.delete(id)
          }
        })
      },
      subscribe: (ids: string[]) => {
        operations.push(`subscribe:${ids[0]}`)
        for (const id of ids) {
          const participant = participants.get(id)
          if (participant) {
            subscribed.set(id, participant)
          }
        }
        return Promise.resolve()
      },
    },
  }
  const transport = new VoiceTransport({
    audio: {
      attachVoiceChat: (id) => {
        nodes.add(id)
        return {
          setGain: () => undefined,
          setPose: () => undefined,
          dispose: () => {
            nodes.delete(id)
          },
        }
      },
    },
    muted: () => false,
    onState: () => undefined,
  })
  transports.push(transport)
  transport.update(peers, { x: 0, z: 0 }, false)
  Reflect.set(transport, 'meeting', meeting)
  for (const participant of participants.values()) {
    Reflect.apply(Reflect.get(transport, 'addParticipant'), transport, [participant])
  }
  transport.setSpeakers(peers.map((peer) => peer.id))
  expect([...nodes]).toEqual([1, 2, 3, 4])
  for (const peer of peers) {
    peer.x = peer.id <= 4 ? 100 + peer.id : peer.id - 5
  }
  transport.update(peers, { x: 0, z: 0 }, false)
  transport.setSpeakers(peers.map((peer) => peer.id))
  expect(operations).toEqual(['unsubscribe:1'])
  expect(nodes.size).toBe(0)
  expect(elements.filter((element) => element.srcObject !== null)).toHaveLength(0)
  for (const id of [5, 6, 7, 8]) {
    const participant = participants.get(String(id))
    if (!participant) {
      throw new Error('Missing fixture participant')
    }
    listeners.get(id)?.({ audioTrack: participant.audioTrack })
    expect(nodes.size).toBeLessThanOrEqual(4)
    expect(elements.filter((element) => element.srcObject !== null).length).toBeLessThanOrEqual(4)
  }
  release?.()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(operations).toEqual([
    'unsubscribe:1',
    'unsubscribe:2',
    'unsubscribe:3',
    'unsubscribe:4',
    'subscribe:5',
    'subscribe:6',
    'subscribe:7',
    'subscribe:8',
  ])
  expect([...nodes]).toEqual([5, 6, 7, 8])
  await transport.stop()
  expect(nodes.size).toBe(0)
  expect(elements.every((element) => element.srcObject === null && element.removed)).toBe(true)
  expect(
    [...participants.values()].every((participant) => participant.audioTrack.readyState === 'live'),
  ).toBe(true)
})

describe('silent remote decoding activation', () => {
  it('mutes before source/play even when iOS ignores software volume', async () => {
    const element = new Element()
    element.ignoreVolume = true
    const f = fixture(element)
    f.playout.resume()
    await flush()
    expect(element.silenceBeforeSource).toBe(true)
    expect(element.silentPlays).toEqual([true])
    expect(element.volume).toBe(1)
    expect(f.states).toEqual(['playing'])
    expect(f.track.readyState).toBe('live')
  })

  it('refuses stream assignment if element muting cannot be enforced', () => {
    const element = new Element()
    Object.defineProperty(element, 'muted', { get: () => false, set: () => undefined })
    expect(() => fixture(element)).toThrow('Silent voice playback is unavailable')
    expect(element.srcObject).toBeNull()
    expect(element.calls).toBe(0)
  })

  it('deduplicates pending and already-playing retries', async () => {
    const f = fixture()
    f.playout.resume()
    f.playout.resume()
    await flush()
    f.playout.resume()
    expect(f.element.calls).toBe(1)
  })

  it('autoplay rejection waits for explicit retry without changing mute', async () => {
    const f = fixture()
    f.element.playback = () =>
      Promise.reject(new DOMException('Gesture required', 'NotAllowedError'))
    f.playout.resume()
    await flush()
    expect(f.states).toEqual(['blocked'])
    expect(f.element.calls).toBe(1)
    f.element.playback = () => Promise.resolve()
    f.playout.resume()
    await flush()
    expect(f.states).toEqual(['blocked', 'playing'])
    expect(f.element.muted && f.element.defaultMuted).toBe(true)
  })

  it('late resolution after disposal cannot revive playback or report state', async () => {
    const f = fixture()
    let finish: (() => void) | undefined
    f.element.playback = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    f.playout.resume()
    f.playout.dispose()
    finish?.()
    await flush()
    expect(f.states).toEqual([])
    expect(f.element.srcObject).toBeNull()
    expect(f.element.removed).toBe(true)
    expect(f.track.readyState).toBe('live')
  })

  it('late rejection after disposal is handled and ignored', async () => {
    const f = fixture()
    let fail: ((error: Error) => void) | undefined
    f.element.playback = () =>
      new Promise((_resolve, reject) => {
        fail = reject
      })
    f.playout.resume()
    f.playout.dispose()
    fail?.(new Error('Late failure'))
    await flush()
    expect(f.states).toEqual([])
  })

  it('replacement keeps the new receiver when the old play promise settles', async () => {
    const previous = fixture()
    let finish: (() => void) | undefined
    previous.element.playback = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    previous.playout.resume()
    previous.playout.dispose()
    const current = fixture()
    current.playout.resume()
    await flush()
    finish?.()
    await flush()
    expect(previous.states).toEqual([])
    expect(previous.element.srcObject).toBeNull()
    expect(current.states).toEqual(['playing'])
    expect(current.element.srcObject).not.toBeNull()
  })

  it('cancel before playback assigns no play work and leaves the SFU track alive', () => {
    const f = fixture()
    f.playout.dispose()
    f.playout.resume()
    expect(f.element.calls).toBe(0)
    expect(f.element.srcObject).toBeNull()
    expect(f.track.readyState).toBe('live')
  })

  it('track end disposes the activation and removes late media error listeners', async () => {
    const f = fixture()
    f.playout.resume()
    await flush()
    f.track.dispatchEvent(new Event('ended'))
    f.element.dispatchEvent(new Event('error'))
    expect(f.states).toEqual(['playing', 'ended'])
    expect(f.element.srcObject).toBeNull()
    expect(f.element.pauses).toBe(1)
  })

  it('permanent media error pauses and reports failure', async () => {
    const f = fixture()
    f.element.playback = () => Promise.reject(new DOMException('Unsupported', 'NotSupportedError'))
    f.playout.resume()
    await flush()
    expect(f.states).toEqual(['error'])
    expect(f.element.pauses).toBe(1)
  })

  it('mute invariant violation pauses rather than enabling an audible route', async () => {
    const f = fixture()
    f.playout.resume()
    await flush()
    f.element.muted = false
    f.element.dispatchEvent(new Event('volumechange'))
    expect(f.states).toEqual(['playing', 'error'])
    expect(f.element.pauses).toBeGreaterThan(0)
  })

  it('unsettled play is bounded and can be retried explicitly', async () => {
    const f = fixture()
    let failOld: ((error: Error) => void) | undefined
    f.element.playback = () =>
      new Promise((_resolve, reject) => {
        failOld = reject
      })
    f.playout.resume()
    await new Promise((resolve) => setTimeout(resolve, 4050))
    expect(f.states).toEqual(['blocked'])
    f.element.playback = () => Promise.resolve()
    f.playout.resume()
    await flush()
    failOld?.(new Error('Old timed out attempt'))
    await flush()
    expect(f.states).toEqual(['blocked', 'playing'])
  })
})
