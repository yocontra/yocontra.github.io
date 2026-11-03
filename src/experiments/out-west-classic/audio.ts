import { SONGS, SOUNDS, type SongName, type SoundName } from './constants.ts'

/**
 * Sound effects go through Web Audio so they can fire outside of a user
 * gesture on iOS (the gunshot happens on a timer). If decoding is not done
 * yet, or Web Audio is missing, fall back to a throwaway <audio> element like
 * the original did.
 */
export class GameAudio {
  private ctx: AudioContext | null = null
  private readonly buffers = new Map<SoundName, AudioBuffer>()
  private readonly music: HTMLAudioElement

  constructor() {
    this.music = document.createElement('audio')
    this.music.loop = true
    this.music.volume = 0.9
    this.music.preload = 'auto'
  }

  /** Must be called from inside a user gesture. */
  unlock(): void {
    if (this.ctx || typeof AudioContext === 'undefined') {
      return
    }
    this.ctx = new AudioContext()
    void this.ctx.resume()
    for (const name of Object.keys(SOUNDS) as SoundName[]) {
      void this.load(this.ctx, name)
    }
  }

  private async load(ctx: AudioContext, name: SoundName): Promise<void> {
    try {
      const res = await fetch(SOUNDS[name])
      const data = await res.arrayBuffer()
      this.buffers.set(name, await ctx.decodeAudioData(data))
    } catch {
      // Leave it to the <audio> fallback.
    }
  }

  play(name: SoundName): void {
    const buffer = this.buffers.get(name)
    if (this.ctx && buffer) {
      const src = this.ctx.createBufferSource()
      src.buffer = buffer
      src.connect(this.ctx.destination)
      src.start()
      return
    }
    const el = document.createElement('audio')
    el.src = SOUNDS[name]
    el.play().catch(() => undefined)
  }

  playSong(name: SongName): void {
    this.music.src = SONGS[name]
    this.music.play().catch(() => undefined)
  }
}
