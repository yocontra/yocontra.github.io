/** A muted media element starts WebRTC decoding; the game's positional graph owns audibility. */
export type RemotePlayoutState = 'pending' | 'playing' | 'blocked' | 'error' | 'ended'

const PLAY_TIMEOUT_MS = 4000

interface RemoteAudioElement extends EventTarget {
  muted: boolean
  defaultMuted: boolean
  volume: number
  srcObject: MediaProvider | null
  play: () => Promise<void>
  pause: () => void
  remove: () => void
}

export class RemotePlayout {
  private readonly element: RemoteAudioElement
  private readonly track: MediaStreamTrack
  private readonly changed: (state: RemotePlayoutState) => void
  private readonly live: {
    active: boolean
    attempt: number
    pending: boolean
    state: RemotePlayoutState
  } = { active: true, attempt: 0, pending: false, state: 'pending' }
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    track: MediaStreamTrack,
    changed: (state: RemotePlayoutState) => void,
    element: RemoteAudioElement = document.createElement('audio'),
  ) {
    this.element = element
    this.track = track
    this.changed = changed
    // iOS may ignore volume. Muting is mandatory before a stream or playback is assigned.
    element.muted = true
    element.defaultMuted = true
    try {
      element.volume = 0
    } catch {
      // Muted/defaultMuted are the silence invariant even without software volume control.
    }
    if (!(element.muted && element.defaultMuted)) {
      throw new Error('Silent voice playback is unavailable in this browser.')
    }
    element.srcObject = new MediaStream([track])
    element.addEventListener('error', this.failed)
    element.addEventListener('volumechange', this.checkMuted)
    track.addEventListener('ended', this.ended)
  }

  get state(): RemotePlayoutState {
    return this.live.state
  }

  /** Also called directly from an existing trusted voice gesture after autoplay rejection. */
  resume(): void {
    if (!this.live.active || this.live.pending || this.live.state === 'playing') {
      return
    }
    if (!(this.element.muted && this.element.defaultMuted)) {
      this.failed()
      return
    }
    this.live.pending = true
    const attempt = ++this.live.attempt
    const settle = (state: RemotePlayoutState) => {
      if (!(this.live.active && this.live.attempt === attempt)) {
        return
      }
      clearTimeout(this.timer)
      this.timer = undefined
      this.live.pending = false
      if (state === 'error') {
        this.failed()
      } else if (this.element.muted && this.element.defaultMuted) {
        this.report(state)
      } else {
        this.failed()
      }
    }
    this.timer = setTimeout(() => settle('blocked'), PLAY_TIMEOUT_MS)
    try {
      void this.element.play().then(
        () => settle('playing'),
        (error: unknown) => {
          settle(
            error instanceof DOMException &&
              (error.name === 'NotAllowedError' || error.name === 'AbortError')
              ? 'blocked'
              : 'error',
          )
        },
      )
    } catch {
      settle('error')
    }
  }

  dispose(): void {
    if (!this.live.active) {
      return
    }
    this.live.active = false
    this.live.attempt++
    clearTimeout(this.timer)
    this.timer = undefined
    this.element.removeEventListener('error', this.failed)
    this.element.removeEventListener('volumechange', this.checkMuted)
    this.track.removeEventListener('ended', this.ended)
    this.element.pause()
    this.element.srcObject = null
    this.element.remove()
    // RealtimeKit, not this adapter, owns and stops the remote track.
  }

  private report(state: RemotePlayoutState): void {
    if (state !== this.live.state) {
      this.live.state = state
      this.changed(state)
    }
  }

  private readonly failed = (): void => {
    if (this.live.active) {
      this.live.attempt++
      this.live.pending = false
      clearTimeout(this.timer)
      this.timer = undefined
      this.element.pause()
      this.report('error')
    }
  }

  private readonly checkMuted = (): void => {
    if (!(this.element.muted && this.element.defaultMuted)) {
      this.failed()
    }
  }

  private readonly ended = (): void => {
    this.dispose()
    this.report('ended')
  }
}
