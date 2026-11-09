// biome-ignore-all lint/suspicious/noUnnecessaryConditions: live voice state changes between async callbacks and frames
// biome-ignore-all lint/security/noSecrets: voice setting keys and key names are not credentials
/**
 * The one voice control shared by Frontier and Bounty Hunt: a TALK / MIC button at the bottom of
 * the screen, plus a small state line. It sits outside the game HUD so it cannot collide with the
 * touch clusters, and it only appears after the player turns proximity voice on.
 */
import './voice.css'

export interface VoiceUiOpts {
  /** Connect, or retry after a permission or service failure. */
  connect: () => void
  /** Push-to-talk down/up, or open-mic mute toggle. */
  talk: (down: boolean) => void
  /** Open mic: the button toggles local mute. */
  mute: (muted: boolean) => void
  settings: () => { voiceChat: boolean; voicePushToTalk: boolean }
}

export type VoiceUiState = 'off' | 'connecting' | 'standby' | 'live' | 'error'

export class VoiceControls {
  readonly root: HTMLElement
  private readonly button: HTMLButtonElement
  private readonly status: HTMLElement
  private readonly o: VoiceUiOpts
  private state: VoiceUiState = 'off'
  private message = ''
  private silenced = false
  private muted = false
  private talking = false
  private blocked = false
  private activePointer = -1
  private readonly offKey: () => void

  constructor(o: VoiceUiOpts) {
    this.o = o
    this.root = document.createElement('div')
    this.root.className = 'ow-voice'
    this.button = document.createElement('button')
    this.button.type = 'button'
    this.button.className = 'ow-voice-btn'
    this.button.setAttribute('aria-label', 'Talk')
    this.status = document.createElement('span')
    this.status.className = 'ow-voice-status'
    this.status.setAttribute('role', 'status')
    this.status.setAttribute('aria-live', 'polite')
    this.root.append(this.button, this.status)
    document.body.append(this.root)

    this.button.addEventListener('pointerdown', (e) => {
      if (this.silenced || this.blocked) {
        return
      }
      e.stopPropagation()
      if (this.state === 'off' || this.state === 'error') {
        return
      }
      e.preventDefault()
      if (this.o.settings().voicePushToTalk) {
        this.activePointer = e.pointerId
        this.talking = true
        this.o.talk(true)
        this.render()
      } else {
        this.muted = !this.muted
        this.o.mute(this.muted)
        this.render()
      }
    })
    this.button.addEventListener('click', (event) => {
      event.stopPropagation()
      if (this.blocked || this.silenced) {
        return
      }
      if (this.state === 'off' || this.state === 'error') {
        this.o.connect()
      } else if (!this.o.settings().voicePushToTalk && event.detail === 0) {
        this.muted = !this.muted
        this.o.mute(this.muted)
        this.render()
      }
    })
    const release = (e: PointerEvent) => {
      if (this.activePointer !== e.pointerId) {
        return
      }
      this.activePointer = -1
      this.talking = false
      this.o.talk(false)
      this.render()
    }
    this.button.addEventListener('pointerup', release)
    this.button.addEventListener('pointercancel', release)
    this.button.addEventListener('pointerleave', release)

    const key = (e: KeyboardEvent): void => {
      if (
        e.code !== 'KeyT' ||
        e.repeat ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        this.blocked ||
        this.silenced
      ) {
        return
      }
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
        return
      }
      if (this.state === 'off' || this.state === 'error') {
        e.preventDefault()
        this.o.connect()
        return
      }
      if (this.o.settings().voicePushToTalk) {
        e.preventDefault()
        this.talking = true
        this.o.talk(true)
        this.render()
      }
    }
    const keyUp = (e: KeyboardEvent): void => {
      if (e.code === 'KeyT' && this.talking) {
        this.talking = false
        this.o.talk(false)
        this.render()
      }
    }
    globalThis.addEventListener('keydown', key)
    globalThis.addEventListener('keyup', keyUp)
    const blur = () => this.quiet()
    const visibility = () => {
      if (document.hidden) {
        this.quiet()
      }
    }
    globalThis.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', visibility)
    this.offKey = () => {
      globalThis.removeEventListener('keydown', key)
      globalThis.removeEventListener('keyup', keyUp)
      globalThis.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', visibility)
    }
    this.refresh()
  }

  refresh(): void {
    const s = this.o.settings()
    this.root.classList.toggle('on', s.voiceChat)
    this.root.classList.toggle('open', !s.voicePushToTalk)
    if (!s.voiceChat) {
      this.quiet()
    }
    this.render()
  }

  setState(state: VoiceUiState, message?: string): void {
    this.state = state
    if (state === 'off' || state === 'error') {
      this.quiet()
    }
    this.message = message ?? ''
    this.render()
  }

  /** The pause menu, the coach card or a summary is up: stay out of its way. */
  setBlocked(on: boolean): void {
    if (this.blocked === on) {
      return
    }
    this.blocked = on
    this.root.classList.toggle('blocked', on)
    if (on) {
      this.activePointer = -1
      this.quiet()
    }
    this.render()
  }

  setSilenced(on: boolean): void {
    this.silenced = on
    if (on) {
      this.quiet()
    }
    this.render()
  }

  /** Stop transmitting (a setting change, a modal, or the match ending). */
  private quiet(): void {
    this.activePointer = -1
    if (!this.talking) {
      return
    }
    this.talking = false
    this.o.talk(false)
  }

  get isMuted(): boolean {
    return this.muted
  }

  dispose(): void {
    this.quiet()
    this.offKey()
    this.root.remove()
  }

  private renderUnavailable(): void {
    this.button.textContent = this.state === 'error' ? 'RETRY VOICE' : 'CONNECT VOICE'
    this.button.setAttribute(
      'aria-label',
      this.state === 'error' ? 'Retry voice chat' : 'Connect voice chat',
    )
    this.button.disabled = this.blocked || this.silenced
    this.status.textContent = this.message || 'Connect your microphone to nearby players.'
    this.status.className = 'ow-voice-status bad'
  }

  private render(): void {
    const s = this.o.settings()
    const ptt = s.voicePushToTalk
    this.button.classList.toggle('talking', this.talking && !this.silenced)
    this.button.setAttribute(
      'aria-pressed',
      String(
        (this.state === 'live' || this.state === 'standby' || this.state === 'connecting') &&
          (ptt ? this.talking : !this.muted),
      ),
    )
    if (this.state === 'error' || this.state === 'off') {
      this.renderUnavailable()
      return
    }
    this.button.disabled = this.blocked || this.silenced
    let label = this.silenced || this.muted ? 'MUTED' : 'MIC ON'
    if (!this.silenced && ptt) {
      label = this.talking ? 'TALKING' : 'TALK'
    }
    this.button.textContent = label
    const micLabel = this.muted ? 'Unmute microphone' : 'Mute microphone'
    this.button.setAttribute('aria-label', ptt ? 'Hold to talk' : micLabel)
    if (this.silenced) {
      this.status.textContent = 'muted for the draw'
    } else if (this.state === 'connecting') {
      this.status.textContent = this.message || 'connecting…'
    } else if (this.state === 'standby') {
      this.status.textContent = this.message || 'Ready · hold T to talk'
    } else if (ptt) {
      this.status.textContent = 'hold T'
    } else {
      this.status.textContent = 'open mic'
    }
    this.status.className = 'ow-voice-status'
  }
}
