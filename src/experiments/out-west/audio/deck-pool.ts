/**
 * The media elements behind streamed audio (`stream.ts`), each wired once into the Web Audio graph
 * (a MediaElementAudioSourceNode can only ever be made once per element) and reused.
 *
 * iOS lets a media element start sound only after it has been played inside a user gesture, so
 * the pool is "blessed" (each element plays 50 ms of silence) during the unlock gesture, and again
 * on later gestures for any element made since.
 */

export interface Deck {
  el: HTMLAudioElement
  gain: GainNode
  free: boolean
}

let silentUrl: string | null = null

/** 50 ms of silence as a WAV data URI (for blessing elements on iOS). */
function silence(): string {
  if (silentUrl) {
    return silentUrl
  }
  const rate = 8000
  const n = 400
  const buf = new DataView(new ArrayBuffer(44 + n * 2))
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      buf.setUint8(o + i, s.charCodeAt(i))
    }
  }
  str(0, 'RIFF')
  buf.setUint32(4, 36 + n * 2, true)
  str(8, 'WAVEfmt ')
  buf.setUint32(16, 16, true)
  buf.setUint16(20, 1, true)
  buf.setUint16(22, 1, true)
  buf.setUint32(24, rate, true)
  buf.setUint32(28, rate * 2, true)
  buf.setUint16(32, 2, true)
  buf.setUint16(34, 16, true)
  str(36, 'data')
  buf.setUint32(40, n * 2, true)
  let bin = ''
  for (const b of new Uint8Array(buf.buffer)) {
    bin += String.fromCharCode(b)
  }
  silentUrl = `data:audio/wav;base64,${btoa(bin)}`
  return silentUrl
}

export class DeckPool {
  private readonly decks: Deck[] = []
  private readonly ctx: AudioContext

  constructor(ctx: AudioContext) {
    this.ctx = ctx
  }

  private make(): Deck {
    const el = new Audio()
    el.preload = 'auto'
    el.crossOrigin = 'anonymous'
    // iOS is happier with a media element that is in the document (a detached element can be
    // refused after its src changes), and it costs nothing: it never paints.
    el.setAttribute('playsinline', '')
    el.setAttribute('aria-hidden', 'true')
    el.style.display = 'none'
    document.body.append(el)
    // Rate nudges happen while silent; never pitch-correct them (cheaper, and no artefacts).
    el.preservesPitch = false
    const src = this.ctx.createMediaElementSource(el)
    const gain = this.ctx.createGain()
    gain.gain.value = 0
    src.connect(gain)
    const d: Deck = { el, gain, free: true }
    this.decks.push(d)
    return d
  }

  /** Inside a user gesture: create `n` decks and play each once so iOS lets them sound later. */
  bless(n: number): void {
    while (this.decks.length < n) {
      this.make()
    }
    for (const d of this.decks) {
      if (d.free && !d.el.src) {
        d.el.src = silence()
        d.el.play().then(
          () => d.el.pause(),
          () => undefined,
        )
      }
    }
  }

  take(): Deck {
    const d = this.decks.find((x) => x.free) ?? this.make()
    d.free = false
    return d
  }

  // biome-ignore lint/style/useThisInClassMethods: the pool's API; the deck carries its own state
  give(d: Deck): void {
    d.el.pause()
    d.el.playbackRate = 1
    d.gain.disconnect()
    d.gain.gain.cancelScheduledValues(0)
    d.gain.gain.value = 0
    d.free = true
  }

  get size(): number {
    return this.decks.length
  }

  get busy(): number {
    return this.decks.filter((d) => !d.free).length
  }
}
