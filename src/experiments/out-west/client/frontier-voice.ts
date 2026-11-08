import type { AudioEngine } from '../audio/audio.ts'
import { blockedNames } from '../net/social.ts'
import { getSettings, onSettings } from '../settings.ts'
import { VoiceChat, type VoiceCredentials } from '../voice/voice-chat.ts'
import { VoiceControls } from '../voice/voice-ui.ts'
import type { FrontierSession } from './frontier-session.ts'

/** The existing proximity service follows the native session's authoritative positions. */
export class FrontierVoice {
  private readonly session: FrontierSession
  private readonly chat: VoiceChat
  private readonly controls: VoiceControls
  private readonly unsubscribe: () => void
  private readonly unsubscribeSettings: () => void
  private pending:
    | { finish: (value: VoiceCredentials | null) => void; timeout: ReturnType<typeof setTimeout> }
    | undefined
  private blocked = new Set<string>()
  constructor(root: HTMLElement, session: FrontierSession, audio: AudioEngine | null) {
    this.session = session
    this.controls = new VoiceControls({
      settings: getSettings,
      talk: (on) => this.chat.setTalking(on),
      mute: (on) => this.chat.setMicMuted(on),
    })
    root.append(this.controls.root)
    this.chat = new VoiceChat({
      audio,
      settings: getSettings,
      sendOff: () => session.control(JSON.stringify({ type: 'voice_off' })),
      requestToken: () =>
        new Promise((finish) => {
          this.finish(null)
          this.pending = { finish, timeout: setTimeout(() => this.finish(null), 10_000) }
          session.control(JSON.stringify({ type: 'voice_on' }))
        }),
      muted: (id) => this.blocked.has(session.world.players[id]?.name.toLowerCase() ?? ''),
      onState: (state, message) => this.controls.setState(state, message),
    })
    this.unsubscribe = session.subscribeControl((message) => {
      if (message.type === 'voice_ready') {
        this.finish(message)
      }
      if (message.type === 'voice_error') {
        this.finish(null)
      }
    })
    this.unsubscribeSettings = onSettings(() => this.configure())
    this.configure()
  }
  private finish(value: VoiceCredentials | null): void {
    if (this.pending) {
      clearTimeout(this.pending.timeout)
      this.pending.finish(value)
      this.pending = undefined
    }
  }
  private configure(): void {
    if (getSettings().voiceChat && !this.session.practice) {
      void blockedNames().then((names) => {
        this.blocked = names
      })
    }
    this.chat.setEnabled(getSettings().voiceChat && !this.session.practice)
    this.controls.refresh()
  }
  update(): void {
    const { world, selfSlot } = this.session
    const self = world.players[selfSlot]
    const silenced = Boolean(self && self.showdown >= 0)
    this.chat.setSilenced(silenced)
    this.controls.setSilenced(silenced)
    this.chat.update(
      world.players.flatMap((player) =>
        player && player.id !== selfSlot && player.alive ? [player] : [],
      ),
      self ?? undefined,
    )
  }
  destroy(): void {
    this.finish(null)
    this.unsubscribe()
    this.unsubscribeSettings()
    this.controls.dispose()
    void this.chat.dispose()
  }
}
