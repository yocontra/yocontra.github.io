import type { AudioEngine } from '../audio/audio.ts'
import { blockedNames } from '../net/social.ts'
import { getSettings, onSettings } from '../settings.ts'
import { NativeVoiceAudio } from '../voice/native-audio.ts'
import { VoiceChat } from '../voice/voice-chat.ts'
import { VoiceControls } from '../voice/voice-ui.ts'
import type { FrontierSession } from './frontier-session.ts'

/** The existing proximity service follows the native session's authoritative positions. */
export class FrontierVoice {
  private readonly session: FrontierSession
  private readonly chat: VoiceChat
  private readonly controls: VoiceControls
  private readonly unsubscribe: () => void
  private readonly unsubscribeSettings: () => void
  private readonly nativeAudio: NativeVoiceAudio
  private blocked = new Set<string>()
  constructor(
    root: HTMLElement,
    session: FrontierSession,
    audio: AudioEngine | null,
    context: () => AudioContext | null,
  ) {
    this.session = session
    this.nativeAudio = new NativeVoiceAudio(context, () => getSettings().voiceChatVolume)
    this.controls = new VoiceControls({
      connect: () => this.chat.retry(),
      settings: getSettings,
      talk: (on) => this.chat.setTalking(on),
      mute: (on) => this.chat.setMicMuted(on),
    })
    root.append(this.controls.root)
    this.chat = new VoiceChat({
      audio: audio ?? this.nativeAudio,
      activity: (track, interrupted) => this.nativeAudio.analyse(track, interrupted),
      audioRunning: () => this.nativeAudio.running,
      settings: getSettings,
      listening: () => getSettings().voiceChatVolume > 0,
      send: (control) => session.control(JSON.stringify(control)),
      muted: (id) => this.blocked.has(session.world.players[id]?.name.toLowerCase() ?? ''),
      onState: (state, message) => this.controls.setState(state, message),
    })
    this.unsubscribe = session.subscribeControl((message) => {
      if (
        message.type === 'voice_ready' ||
        message.type === 'voice_error' ||
        message.type === 'voice_standby' ||
        message.type === 'voice_status'
      ) {
        this.chat.receive(message)
      }
    })
    this.unsubscribeSettings = onSettings(() => this.configure())
    this.configure()
  }
  setLinked(on: boolean): void {
    this.chat.setLinked(on)
  }
  private configure(): void {
    const enabled = getSettings().voiceChat && !this.session.practice
    if (enabled) {
      void blockedNames().then((names) => {
        this.blocked = names
      })
    }
    this.chat.setEnabled(enabled)
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
    this.unsubscribe()
    this.unsubscribeSettings()
    this.controls.dispose()
    void this.chat.dispose()
    this.nativeAudio.dispose()
  }
}
