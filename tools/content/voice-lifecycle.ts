import { loadSettings } from '../../src/experiments/out-west/ffa/client/settings.ts'
import { SettingsPanel } from '../../src/experiments/out-west/ffa/client/settings-panel.ts'
import { openSettings } from '../../src/experiments/out-west/ui/settings-sheet.ts'
import {
  getMicrophoneInput,
  setMicrophoneInput,
} from '../../src/experiments/out-west/voice/input-device.ts'
import { NativeVoiceAudio } from '../../src/experiments/out-west/voice/native-audio.ts'
import { VoiceChat } from '../../src/experiments/out-west/voice/voice-chat.ts'
import { VoiceControls } from '../../src/experiments/out-west/voice/voice-ui.ts'
import {
  disconnectVoice,
  finishJoin,
  finishLeave,
  finishMicrophone,
  fixtureState,
  holdJoin,
  holdLeave,
  holdMicrophone,
} from './voice-meeting-fixture.ts'
export const transport = { disconnectVoice, finishJoin, holdJoin, holdMicrophone, finishMicrophone }

let chat: VoiceChat | undefined
let controls: VoiceControls | undefined
let context: AudioContext | undefined
let requests = 0
let offs = 0
let ptt = true
let enabled = true
let fail = false
let audience = 0
let generation = 0
let speech = false
let preserveMeeting = false
let original: MediaStreamTrack | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let frame: number | undefined
let pickerLifetime: AbortController | undefined
let pickerPanel: HTMLElement | undefined
const commands: { type: string; talking?: boolean }[] = []
export function beginVoice() {
  context = new AudioContext()
  const audio = new NativeVoiceAudio(
    () => context ?? null,
    () => 0.5,
  )
  chat = new VoiceChat({
    audio,
    activity: (track, interrupted) => {
      original = track
      return audio.analyse(track, interrupted)
    },
    audioRunning: () => audio.running,
    listening: () => true,
    settings: () => ({ voiceChat: enabled, voicePushToTalk: ptt }),
    send: (control) => {
      commands.push(control)
      if (control.type === 'voice_off') {
        offs++
      }
      if (control.type === 'voice_on') {
        if (fail) {
          queueMicrotask(() =>
            chat?.receive({
              type: 'voice_error',
              message: 'Voice chat is disabled on this server.',
            }),
          )
        } else {
          queueMicrotask(() =>
            chat?.receive({ type: 'voice_status', listeners: audience, speakers: [] }),
          )
        }
      }
      if (control.type === 'voice_talk') {
        speech = control.talking
        clearTimeout(timer)
        if (speech && audience > 0 && chat?.current === 'standby') {
          invite()
        }
        if (!(speech || preserveMeeting)) {
          timer = setTimeout(() => chat?.receive({ type: 'voice_standby' }), 1000)
        }
      }
    },
    onState: (state, message) => controls?.setState(state, message),
  })
  controls = new VoiceControls({
    settings: () => ({ voiceChat: enabled, voicePushToTalk: ptt }),
    connect: () => chat?.retry(),
    talk: (on) => chat?.setTalking(on),
    mute: (on) => chat?.setMicMuted(on),
  })
  const update = () => {
    chat?.update([])
    frame = requestAnimationFrame(update)
  }
  update()
  chat.setEnabled(true)
  return voiceSnapshot()
}
function invite() {
  requests++
  chat?.receive({
    type: 'voice_ready',
    generation: ++generation,
    meetingId: 'fixture',
    token: 'nonbillable-test-only',
  })
}
export function keepFixtureMeeting(on: boolean): void {
  preserveMeeting = on
  if (on) {
    clearTimeout(timer)
  }
}
export function setAudience(count: number): void {
  audience = count
  chat?.receive({ type: 'voice_status', listeners: count, speakers: speech ? [0] : [] })
  if (speech && count > 0 && chat?.current === 'standby') {
    invite()
  }
  if (count === 0) {
    chat?.receive({ type: 'voice_standby' })
  }
}
export function voiceSnapshot() {
  return {
    state: chat?.current,
    requests,
    offs,
    control: controls?.root.textContent,
    original: original?.readyState,
    originalEnabled: original?.enabled,
    input: getMicrophoneInput(),
    inputDevice: original?.getSettings().deviceId,
    inputLabel: original?.label,
    commands,
    ...fixtureState(),
  }
}
export function selectMicrophone(id: string): void {
  setMicrophoneInput(id)
}
export function showInputSettings(frontier: boolean): void {
  for (const button of Array.from(
    document.querySelectorAll<HTMLButtonElement>('.ow-sheet-close'),
  )) {
    button.click()
  }
  pickerLifetime?.abort()
  pickerPanel?.remove()
  pickerLifetime = new AbortController()
  if (frontier) {
    const settings = loadSettings()
    const panel = new SettingsPanel(
      { settings: () => settings, onChange: () => undefined },
      matchMedia('(pointer: coarse)').matches,
      pickerLifetime.signal,
    )
    pickerPanel = panel.el
    document.body.append(panel.el)
  } else {
    openSettings(document.body)
  }
}
export function disableService(value: boolean): void {
  fail = value
}
export function setOpenMic(value = true): void {
  ptt = !value
  controls?.refresh()
  chat?.setTalking(false)
}
export function setVoiceEnabled(value: boolean): void {
  enabled = value
  chat?.setEnabled(value)
  controls?.refresh()
}
export function interrupt(): Promise<void> | undefined {
  return context?.suspend()
}
export function resume(): Promise<void> | undefined {
  return context?.resume()
}
export function link(on: boolean): void {
  chat?.setLinked(on)
}
export async function disposeVoice() {
  pickerLifetime?.abort()
  pickerPanel?.remove()
  for (const button of Array.from(
    document.querySelectorAll<HTMLButtonElement>('.ow-sheet-close'),
  )) {
    button.click()
  }
  if (frame !== undefined) {
    cancelAnimationFrame(frame)
  }
  clearTimeout(timer)
  controls?.dispose()
  await chat?.dispose()
  await context?.close()
  return {
    ...voiceSnapshot(),
    context: context?.state,
    controls: document.querySelectorAll('.ow-voice').length,
  }
}

export function nativeReceiveProof() {
  if (!context) {
    throw new Error('Missing native context')
  }
  const existing = context
  const createPanner = existing.createPanner.bind(existing)
  const createGain = existing.createGain.bind(existing)
  let panner: PannerNode | undefined
  let gain: GainNode | undefined
  existing.createPanner = () => {
    panner = createPanner()
    return panner
  }
  existing.createGain = () => {
    gain = createGain()
    return gain
  }
  const stream = existing.createMediaStreamDestination()
  const track = stream.stream.getAudioTracks()[0]
  if (!track) {
    throw new Error('No native stream track')
  }
  const audio = new NativeVoiceAudio(
    () => existing,
    () => 0.5,
  )
  const node = audio.attachVoiceChat(7, track)
  existing.createPanner = createPanner
  existing.createGain = createGain
  node?.setPose(10, 2, 3)
  node?.setGain(0.5)
  const result = {
    borrowedContext: context === existing,
    gain: gain?.gain.value,
    position: [panner?.positionX.value, panner?.positionY.value, panner?.positionZ.value],
  }
  audio.dispose()
  const after = { context: existing.state, track: track.readyState }
  track.stop()
  stream.disconnect()
  return { ...result, after }
}

export async function nativeVadProof() {
  if (!context) {
    throw new Error('Missing native context')
  }
  const audio = new NativeVoiceAudio(
    () => context ?? null,
    () => 1,
  )
  const stream = context.createMediaStreamDestination()
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  gain.gain.value = 0
  oscillator.connect(gain).connect(stream)
  oscillator.start()
  const track = stream.stream.getAudioTracks()[0]
  if (!track) {
    throw new Error('Missing generated microphone track')
  }
  let cleared = false
  const detector = audio.analyse(track, () => {
    cleared = true
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const silent = detector?.speaking()
  gain.gain.value = 0.25
  await new Promise((resolve) => setTimeout(resolve, 100))
  const detected = detector?.speaking()
  await context.suspend()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const interrupted = detector?.speaking()
  detector?.dispose()
  track.stop()
  oscillator.stop()
  oscillator.disconnect()
  gain.disconnect()
  stream.disconnect()
  await context.resume()
  return {
    silent,
    speech: detected,
    interrupted,
    disposed: cleared && track.readyState === 'ended',
  }
}

/** Actual VoiceChat callbacks when a native meeting's leave settles after a newer lifecycle. */
export async function deferredLeaveProof() {
  const results: {
    mode: string
    state: string
    lateStates: string[]
    track: ReturnType<typeof fixtureState>['track']
  }[] = []
  for (const mode of ['dispose', 'replace', 'current'] as const) {
    const states: string[] = []
    let ready = false
    const voice = new VoiceChat({
      audio: null,
      activity: () => null,
      audioRunning: () => true,
      listening: () => true,
      settings: () => ({ voiceChat: true, voicePushToTalk: true }),
      send: (control) => {
        if (control.type === 'voice_on') {
          queueMicrotask(() => voice.receive({ type: 'voice_status', listeners: 1, speakers: [] }))
        }
        if (control.type === 'voice_talk' && control.talking && !ready) {
          ready = true
          queueMicrotask(() =>
            voice.receive({
              type: 'voice_ready',
              generation: 1,
              meetingId: 'fixture',
              token: 'nonbillable-test-only',
            }),
          )
        }
      },
      onState: (state) => states.push(state),
    })
    const until = async (state: string) => {
      const deadline = performance.now() + 2000
      while (voice.current !== state) {
        if (performance.now() > deadline) {
          throw new Error(`Deferred leave setup: expected ${state}, got ${voice.current}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
    try {
      voice.setEnabled(true)
      await until('standby')
      voice.setTalking(true)
      await until('live')
      voice.setTalking(false)
      holdLeave(true)
      disconnectVoice()
      if (fixtureState().leaving !== 1) {
        throw new Error('Old meeting leave was not deferred')
      }
      if (mode === 'dispose') {
        await voice.dispose()
      } else if (mode === 'replace') {
        voice.receive({
          type: 'voice_ready',
          generation: 2,
          meetingId: 'replacement',
          token: 'nonbillable-test-only',
        })
        await until('live')
      }
      const baseline = states.length
      finishLeave()
      await new Promise((resolve) => setTimeout(resolve, 0))
      results.push({
        mode,
        state: voice.current,
        lateStates: states.slice(baseline),
        track: fixtureState().track,
      })
    } finally {
      finishLeave()
      await voice.dispose()
    }
  }
  return results
}
