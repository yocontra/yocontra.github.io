import { NativeVoiceAudio } from '../../src/experiments/out-west/voice/native-audio.ts'
import { VoiceChat } from '../../src/experiments/out-west/voice/voice-chat.ts'
import { VoiceControls } from '../../src/experiments/out-west/voice/voice-ui.ts'
import { disconnectVoice, finishJoin, fixtureState, holdJoin } from './voice-meeting-fixture.ts'
export const transport = { disconnectVoice, finishJoin, holdJoin }

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
let original: MediaStreamTrack | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let frame: number | undefined
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
        if (!speech) {
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
    commands,
    ...fixtureState(),
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
