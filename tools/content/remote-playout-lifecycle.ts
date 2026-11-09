/** Cost-free native WebRTC regression. Run in an isolated browser with physical output muted. */
import { NativeVoiceAudio } from '../../src/experiments/out-west/voice/native-audio.ts'
import {
  RemotePlayout,
  type RemotePlayoutState,
} from '../../src/experiments/out-west/voice/remote-playout.ts'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function analyse(context: AudioContext, track: MediaStreamTrack) {
  const source = context.createMediaStreamSource(new MediaStream([track]))
  const analyser = context.createAnalyser()
  source.connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  return {
    rms: () => {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) {
        sum += sample * sample
      }
      return Math.sqrt(sum / samples.length)
    },
    dispose: () => {
      source.disconnect()
      analyser.disconnect()
    },
  }
}

/** Real browser codecs, ICE and positional graph; no provider calls. SDK production is separate. */
export async function remotePlayoutProof() {
  const context = new AudioContext()
  await context.resume()
  const oscillator = context.createOscillator()
  oscillator.frequency.value = 523.25
  const amplitude = context.createGain()
  amplitude.gain.value = 0.12
  const destination = context.createMediaStreamDestination()
  oscillator.connect(amplitude).connect(destination)
  oscillator.start()
  const original = destination.stream.getAudioTracks()[0]
  if (!original) {
    throw new Error('Missing synthetic track')
  }
  const clone = original.clone()
  clone.enabled = false
  const sourceMeter = analyse(context, original)
  const cloneMeter = analyse(context, clone)
  const sender = new RTCPeerConnection()
  const receiver = new RTCPeerConnection()
  const errors: string[] = []
  sender.onicecandidate = ({ candidate }) => {
    if (candidate) {
      void receiver.addIceCandidate(candidate).catch(() => errors.push('Receiver ICE failed'))
    }
  }
  receiver.onicecandidate = ({ candidate }) => {
    if (candidate) {
      void sender.addIceCandidate(candidate).catch(() => errors.push('Sender ICE failed'))
    }
  }
  const audio = new NativeVoiceAudio(
    () => context,
    () => 0.3,
  )
  let remote: MediaStreamTrack | undefined
  let receiveMeter: ReturnType<typeof analyse> | undefined
  let playout: RemotePlayout | undefined
  const states: RemotePlayoutState[] = []
  const cleanup = { original: '', clone: '', context: '', sender: '', receiver: '' }
  const element = document.createElement('audio')
  const received = new Promise<void>((resolve) => {
    receiver.ontrack = ({ track }) => {
      remote = track
      receiveMeter = analyse(context, track)
      audio.attachVoiceChat(1, track)
      resolve()
    }
  })
  const snapshot = async () => {
    const outbound: { energy: number; duration: number }[] = []
    const inbound: { bytes: number; energy: number; duration: number }[] = []
    for (const stat of (await sender.getStats()).values()) {
      if (stat.type === 'media-source') {
        outbound.push({ energy: stat.totalAudioEnergy, duration: stat.totalSamplesDuration })
      }
    }
    for (const stat of (await receiver.getStats()).values()) {
      if (stat.type === 'inbound-rtp') {
        inbound.push({
          bytes: stat.bytesReceived,
          energy: stat.totalAudioEnergy,
          duration: stat.totalSamplesDuration,
        })
      }
    }
    return {
      sourceRms: sourceMeter.rms(),
      cloneRms: cloneMeter.rms(),
      receiveRms: receiveMeter?.rms() ?? 0,
      outbound,
      inbound,
    }
  }
  try {
    sender.addTrack(clone, new MediaStream([clone]))
    await sender.setLocalDescription(await sender.createOffer())
    if (!sender.localDescription) {
      throw new Error('Missing offer')
    }
    await receiver.setRemoteDescription(sender.localDescription)
    await receiver.setLocalDescription(await receiver.createAnswer())
    if (!receiver.localDescription) {
      throw new Error('Missing answer')
    }
    await sender.setRemoteDescription(receiver.localDescription)
    await received
    clone.enabled = true
    await delay(1200)
    const before = await snapshot()
    if (!remote) {
      throw new Error('Missing remote track')
    }
    playout = new RemotePlayout(remote, (state) => states.push(state), element)
    playout.resume()
    let after = await snapshot()
    const deadline = performance.now() + 2500
    while (
      (playout.state !== 'playing' || after.receiveRms < 0.01) &&
      performance.now() < deadline
    ) {
      await delay(50)
      after = await snapshot()
    }
    if (after.sourceRms < 0.01 || after.cloneRms < 0.01 || after.receiveRms < 0.01) {
      throw new Error('Native remote signal failed')
    }
    if (
      !(element.muted && element.defaultMuted && after.inbound.some((stat) => stat.duration > 0))
    ) {
      throw new Error('Silent activation or actual decoding failed')
    }
    playout.dispose()
    const detached = {
      paused: element.paused,
      sourceCleared: element.srcObject === null,
      remoteStillLive: remote.readyState === 'live',
    }
    if (!(detached.paused && detached.sourceCleared && detached.remoteStillLive)) {
      throw new Error('Receive detach ownership failed')
    }
    return {
      before,
      after,
      states,
      detached,
      permanentlyMuted: element.muted && element.defaultMuted,
      errors,
      cleanup,
      physicalMicrophone: false,
      providerRequests: 0,
    }
  } finally {
    playout?.dispose()
    sender.close()
    receiver.close()
    original.stop()
    clone.stop()
    oscillator.stop()
    sourceMeter.dispose()
    cloneMeter.dispose()
    receiveMeter?.dispose()
    audio.dispose()
    await context.close()
    Object.assign(cleanup, {
      original: original.readyState,
      clone: clone.readyState,
      context: context.state,
      sender: sender.connectionState,
      receiver: receiver.connectionState,
    })
  }
}
