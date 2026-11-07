/** Standalone Frontier owns its volume subscription; the duel’s shared engine is managed by main. */
import type { AudioEngine } from '../../audio/audio.ts'
import { getSettings, onSettings } from '../../settings.ts'

type VolumeControl = Pick<AudioEngine, 'setMusicVolume' | 'setSfxVolume' | 'setVoiceVolume'>

export function bindOwnedAudio(audio: VolumeControl | null, owned: boolean): (() => void) | null {
  if (!(audio && owned)) {
    return null
  }
  const apply = (settings: ReturnType<typeof getSettings>): void => {
    audio.setMusicVolume(settings.music)
    audio.setSfxVolume(settings.sfx)
    audio.setVoiceVolume(settings.voice)
  }
  apply(getSettings())
  return onSettings(apply)
}
