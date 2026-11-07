import { expect, it } from 'bun:test'
import { bindOwnedAudio } from '../src/experiments/out-west/ffa/client/owned-audio.ts'
import { getSettings, setSetting } from '../src/experiments/out-west/settings.ts'

it('applies saved standalone volumes before playback, follows live changes and releases its subscription', () => {
  const previous = { ...getSettings() }
  const volume = { music: 1, sfx: 1, voice: 1 }
  const audio = {
    setMusicVolume: (value: number) => {
      volume.music = value
    },
    setSfxVolume: (value: number) => {
      volume.sfx = value
    },
    setVoiceVolume: (value: number) => {
      volume.voice = value
    },
  }
  let release: (() => void) | null = null
  try {
    setSetting('music', 0)
    setSetting('sfx', 0)
    setSetting('voice', 0)
    release = bindOwnedAudio(audio, true)
    expect(volume).toEqual({ music: 0, sfx: 0, voice: 0 })
    setSetting('music', 0.2)
    setSetting('sfx', 0.3)
    setSetting('voice', 0.4)
    expect(volume).toEqual({ music: 0.2, sfx: 0.3, voice: 0.4 })
    release?.()
    release = null
    setSetting('music', 0.9)
    setSetting('sfx', 0.8)
    setSetting('voice', 0.7)
    expect(volume).toEqual({ music: 0.2, sfx: 0.3, voice: 0.4 })
  } finally {
    release?.()
    setSetting('music', previous.music)
    setSetting('sfx', previous.sfx)
    setSetting('voice', previous.voice)
  }
})

it('leaves the shared main-owned audio engine and disabled audio untouched', () => {
  let calls = 0
  const audio = {
    setMusicVolume: () => {
      calls++
    },
    setSfxVolume: () => {
      calls++
    },
    setVoiceVolume: () => {
      calls++
    },
  }
  const previous = getSettings().music
  expect(bindOwnedAudio(audio, false)).toBeNull()
  expect(bindOwnedAudio(null, true)).toBeNull()
  try {
    setSetting('music', 1 - previous)
    expect(calls).toBe(0)
  } finally {
    setSetting('music', previous)
  }
})
