import type { AudioEngine } from '../audio/audio.ts'
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
  constructor(
    root: HTMLElement,
    session: FrontierSession,
    options: {
      audio: AudioEngine | null
      context: () => AudioContext | null
      blocksName: (name: string | undefined) => boolean
    },
  ) {
    this.session = session
    this.nativeAudio = new NativeVoiceAudio(options.context, () => getSettings().voiceChatVolume)
    this.controls = new VoiceControls({
      connect: () => this.chat.retry(),
      settings: getSettings,
      talk: (on) => this.chat.setTalking(on),
      mute: (on) => this.chat.setMicMuted(on),
    })
    root.append(this.controls.root)
    this.chat = new VoiceChat({
      audio: options.audio ?? this.nativeAudio,
      microphone: (track) => this.nativeAudio.createMicrophone(track),
      activity: (track, interrupted) => this.nativeAudio.analyse(track, interrupted),
      audioRunning: () => this.nativeAudio.running,
      settings: getSettings,
      listening: () => getSettings().voiceChatVolume > 0,
      send: (control) => session.control(JSON.stringify(control)),
      muted: (id) => options.blocksName(session.world.players[id]?.name),
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
    this.chat.setEnabled(enabled)
    this.controls.refresh()
  }
  update(): void {
    const { world, selfSlot } = this.session
    const self = world.players[selfSlot]
    const silenced = Boolean(self && self.showdown >= 0)
    this.chat.setSilenced(silenced)
    this.controls.setSilenced(silenced)
    if (!getSettings().voiceChat) {
      return
    }
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
