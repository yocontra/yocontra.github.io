/** Local microphone standby and short game-server speaking leases; RTK is strictly on demand. */
import {
  VOICE_HEARTBEAT_MS,
  type VoiceClientControl,
  type VoiceServerControl,
} from '../contract/voice.ts'
import { captureMicrophone } from './meeting.ts'
import type { MicrophoneActivity, VoiceAudio } from './native-audio.ts'
import type { VoicePeer } from './rank.ts'
import { VoiceTransport } from './transport.ts'

export type { VoiceCredentials } from './meeting.ts'
export type VoiceState = 'off' | 'connecting' | 'standby' | 'live' | 'error'
export interface VoiceSettings {
  voiceChat: boolean
  voicePushToTalk: boolean
}
export interface VoiceChatOptions {
  audio: VoiceAudio | null
  activity: (track: MediaStreamTrack, interrupted: () => void) => MicrophoneActivity | null
  audioRunning: () => boolean
  send: (control: VoiceClientControl) => void
  settings: () => VoiceSettings
  listening: () => boolean
  muted?: (id: number) => boolean
  onState?: (state: VoiceState, message?: string) => void
}
export class VoiceChat {
  private readonly live: {
    enabled: boolean
    linked: boolean
    foreground: boolean
    sequence: number
    capturing: boolean
    talking: boolean
    intent: boolean
    silenced: boolean
    micMuted: boolean
    requested: boolean
    listeners: number
    generation: number
    heartbeatAt: number
    sampleAt: number
  } = {
    enabled: false,
    linked: true,
    foreground: !document.hidden,
    sequence: 0,
    capturing: false,
    talking: false,
    intent: false,
    silenced: false,
    micMuted: false,
    requested: false,
    listeners: 0,
    generation: -1,
    heartbeatAt: 0,
    sampleAt: 0,
  }
  private readonly o: VoiceChatOptions
  private readonly transport: VoiceTransport
  private state: VoiceState = 'off'
  private playbackMessage: string | undefined
  private microphone: MediaStreamTrack | null = null
  private activity: MicrophoneActivity | null = null
  private readonly localMuted = new Set<number>()
  private peers: readonly VoicePeer[] = []
  private preference = ''
  private readonly unbind: () => void
  constructor(options: VoiceChatOptions) {
    this.o = options
    this.transport = new VoiceTransport({
      audio: options.audio,
      muted: (id) => this.localMuted.has(id) || options.muted?.(id) === true,
      onState: (state, message) => {
        if (state === 'error') {
          this.fail(message ?? 'Voice connection lost. Retry voice.')
        } else if (this.live.enabled && this.live.requested) {
          this.playbackMessage = message
          this.setState('live', message)
        }
      },
    })
    const blur = () => {
      this.live.foreground = false
      this.quiet()
    }
    const focus = () => {
      this.live.foreground = !document.hidden
    }
    const visibility = () => (document.hidden ? blur() : focus())
    globalThis.addEventListener('blur', blur)
    globalThis.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', visibility)
    this.unbind = () => {
      globalThis.removeEventListener('blur', blur)
      globalThis.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', visibility)
    }
  }
  get current(): VoiceState {
    return this.state
  }
  get isLive(): boolean {
    return this.state === 'live'
  }
  get micMutedState(): boolean {
    return this.live.micMuted
  }
  setEnabled(on: boolean): void {
    if (this.live.enabled === on) {
      this.refreshInterest()
      return
    }
    this.live.enabled = on
    if (on) {
      this.retry()
    } else {
      this.stopCapture()
      this.setState('off')
    }
  }
  retry(): void {
    if (!this.live.enabled || this.live.capturing) {
      return
    }
    this.o.audio?.resume?.()
    this.transport.resumeReceive()
    if (this.microphone?.readyState === 'live') {
      this.refreshInterest(true)
      this.setState('standby')
    } else {
      void this.capture()
    }
  }
  setLinked(on: boolean): void {
    if (on === this.live.linked) {
      return
    }
    this.live.linked = on
    this.quiet()
    this.live.requested = false
    this.preference = ''
    void this.transport.stop()
    if (this.live.enabled && this.microphone) {
      if (on) {
        this.refreshInterest(true)
        this.setState('standby')
      } else {
        this.setState('standby', 'Waiting for the game connection…')
      }
    }
  }
  setTalking(on: boolean): void {
    this.live.talking = on
    if (on) {
      this.o.audio?.resume?.()
      this.transport.resumeReceive()
    }
    this.sample(true)
  }
  setMicMuted(on: boolean): void {
    this.transport.resumeReceive()
    this.live.micMuted = on
    this.sample(true)
  }
  setSilenced(on: boolean): void {
    if (this.live.silenced === on) {
      return
    }
    this.live.silenced = on
    if (on) {
      this.quiet()
    }
    this.refreshInterest()
  }
  setMuted(id: number, on: boolean): void {
    if (on) {
      this.localMuted.add(id)
    } else {
      this.localMuted.delete(id)
    }
    this.refreshInterest()
  }
  receive(control: VoiceServerControl): void {
    if (!(this.live.enabled && this.live.requested)) {
      return
    }
    if (control.type === 'voice_error') {
      this.fail(control.message)
      return
    }
    if (control.type === 'voice_status') {
      this.live.listeners = control.listeners
      this.transport.setSpeakers(control.speakers)
      this.setState(this.state)
    } else if (control.type === 'voice_standby') {
      this.live.generation = -1
      void this.transport.stop()
      this.setState('standby')
    } else if (this.microphone && control.generation !== this.live.generation) {
      this.live.generation = control.generation
      this.setState('connecting', 'Connecting to nearby players…')
      void this.transport.connect(control, this.microphone)
    }
  }
  update(peers: readonly VoicePeer[], own?: { x: number; z: number }): void {
    if (!this.live.enabled) {
      return
    }
    this.peers = peers
    this.sample(false)
    this.refreshInterest()
    if (this.state === 'live') {
      this.transport.update(peers, own, this.live.silenced)
    }
  }
  async dispose(): Promise<void> {
    this.live.enabled = false
    this.stopCapture()
    this.unbind()
    await this.transport.stop()
    this.setState('off')
  }
  private async capture(): Promise<void> {
    this.live.capturing = true
    const sequence = ++this.live.sequence
    this.setState('connecting', 'Allow microphone access to enable voice.')
    try {
      const track = await captureMicrophone()
      if (!this.live.enabled || sequence !== this.live.sequence) {
        track.stop()
        return
      }
      this.microphone = track
      track.addEventListener('ended', this.microphoneEnded)
      this.activity = this.o.activity(track, () => this.quiet())
      this.refreshInterest(true)
      this.setState('standby')
      this.sample(true)
    } catch (error) {
      if (sequence === this.live.sequence && this.live.enabled) {
        this.fail(
          error instanceof Error ? error.message : 'Microphone could not start. Retry voice.',
        )
      }
    } finally {
      this.live.capturing = false
      if (this.live.enabled && sequence !== this.live.sequence && this.state !== 'error') {
        this.retry()
      }
    }
  }
  private readonly microphoneEnded = () => this.fail('Microphone disconnected. Retry voice.')
  private fail(message: string): void {
    this.stopCapture()
    this.setState('error', message)
  }
  private stopCapture(): void {
    this.live.sequence++
    this.quiet()
    if (this.live.requested && this.live.linked) {
      this.o.send({ type: 'voice_off' })
    }
    this.live.requested = false
    this.preference = ''
    this.live.generation = -1
    this.activity?.dispose()
    this.activity = null
    this.microphone?.removeEventListener('ended', this.microphoneEnded)
    this.microphone?.stop()
    this.microphone = null
    void this.transport.stop()
  }
  private quiet(): void {
    this.live.talking = false
    if (this.microphone) {
      this.microphone.enabled = false
    }
    this.sendIntent(false)
  }
  private sample(force: boolean): void {
    const now = performance.now()
    if (!force && now < this.live.sampleAt) {
      return
    }
    this.live.sampleAt = now + 100
    const permitted =
      this.live.enabled &&
      this.live.linked &&
      this.live.foreground &&
      !this.live.silenced &&
      !this.live.micMuted &&
      this.o.audioRunning()
    const ptt = this.o.settings().voicePushToTalk
    if (this.microphone) {
      this.microphone.enabled = permitted && (!ptt || this.live.talking)
    }
    const speaking = permitted && (ptt ? this.live.talking : this.activity?.speaking() === true)
    this.sendIntent(speaking && this.microphone?.readyState === 'live')
  }
  private sendIntent(on: boolean): void {
    const now = performance.now()
    this.transport.setSending(on)
    if (
      this.live.requested &&
      this.live.linked &&
      (on !== this.live.intent || (on && now >= this.live.heartbeatAt))
    ) {
      this.o.send({ type: 'voice_talk', talking: on })
      this.live.heartbeatAt = now + VOICE_HEARTBEAT_MS
    }
    this.live.intent = on
  }
  private refreshInterest(force = false): void {
    if (!(this.live.enabled && this.live.linked && this.microphone)) {
      return
    }
    const muted = this.peers
      .filter((peer) => this.localMuted.has(peer.id) || this.o.muted?.(peer.id))
      .map((peer) => peer.id)
    const control = {
      type: 'voice_on' as const,
      listening: !this.live.silenced && this.o.listening(),
      muted,
    }
    const preference = JSON.stringify(control)
    if (force || preference !== this.preference) {
      this.preference = preference
      this.live.requested = true
      this.o.send(control)
    }
  }
  private setState(state: VoiceState, message?: string): void {
    this.state = state
    if (state !== 'live') {
      this.playbackMessage = undefined
    }
    let status = message ?? (state === 'live' ? this.playbackMessage : undefined)
    if (!status && state === 'standby') {
      status = this.live.listeners > 0 ? 'Ready · nearby listeners' : 'Ready · no nearby listeners'
    }
    this.o.onState?.(state, status)
  }
}
