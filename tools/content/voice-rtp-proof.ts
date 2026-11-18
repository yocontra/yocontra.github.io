import {
  NativeVoiceAudio,
  type VoiceMicrophone,
} from '../../src/experiments/out-west/voice/native-audio.ts'
import { RemotePlayout } from '../../src/experiments/out-west/voice/remote-playout.ts'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5000
  while (!(await condition())) {
    if (performance.now() >= deadline) {
      throw new Error('Local WebRTC audio did not become ready')
    }
    await delay(20)
  }
}

/** Measure decoded audio on a local-only peer with no external signaling or ICE servers. */
export async function outboundVoiceProof() {
  const context = new AudioContext()
  const sender = new RTCPeerConnection({ iceServers: [] })
  const receiver = new RTCPeerConnection({ iceServers: [] })
  const input = context.createMediaStreamDestination()
  const [original] = input.stream.getAudioTracks()
  const tone = context.createOscillator()
  const toneGain = context.createGain()
  toneGain.gain.value = 0.2
  tone.connect(toneGain).connect(input)
  const audio = new NativeVoiceAudio(
    () => context,
    () => 1,
  )
  let channel: VoiceMicrophone | null = null
  let playback: RemotePlayout | undefined
  tone.start()
  try {
    if (!original) {
      throw new Error('No generated microphone track')
    }
    channel = audio.createMicrophone(original)
    if (!channel) {
      throw new Error('No outbound voice track')
    }
    await context.resume()
    const initialEnabled = channel.track.enabled
    sender.addTrack(channel.track)
    await sender.setLocalDescription(await sender.createOffer())
    await waitFor(() => sender.iceGatheringState === 'complete')
    const offer = sender.localDescription
    if (!offer) {
      throw new Error('Local sender offer is missing')
    }
    await receiver.setRemoteDescription(offer)
    await receiver.setLocalDescription(await receiver.createAnswer())
    await waitFor(() => receiver.iceGatheringState === 'complete')
    const answer = receiver.localDescription
    if (!answer) {
      throw new Error('Local receiver answer is missing')
    }
    await sender.setRemoteDescription(answer)
    const inbound = receiver.getReceivers()[0]
    if (!inbound) {
      throw new Error('No inbound WebRTC audio receiver')
    }
    playback = new RemotePlayout(inbound.track, () => undefined)
    playback.resume()
    const source = context.createMediaStreamSource(new MediaStream([inbound.track]))
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const values = new Float32Array(analyser.fftSize)
    const rms = () => {
      analyser.getFloatTimeDomainData(values)
      const squares = values.reduce((sum, value) => sum + value * value, 0)
      return Math.sqrt(squares / values.length)
    }
    let received = 0
    await waitFor(async () => {
      for (const stat of (await inbound.getStats()).values()) {
        if (stat.type === 'inbound-rtp') {
          received = stat.packetsReceived
        }
      }
      return received > 10 && playback?.state === 'playing'
    })
    const peak = async () => {
      let largest = 0
      for (let sample = 0; sample < 8; sample++) {
        await delay(20)
        largest = Math.max(largest, rms())
      }
      return largest
    }
    const idle = await peak()
    channel.setSending(true)
    await waitFor(() => rms() > 0.04)
    const live = await peak()
    channel.setSending(false)
    await delay(250)
    const muted = await peak()
    const stillEnabled = channel.track.enabled
    channel.dispose()
    return {
      initialEnabled,
      stillEnabled,
      packetsBeforeOpening: received,
      idle,
      live,
      muted,
      closedTrack: channel.track.readyState,
      originalTrack: original.readyState,
    }
  } finally {
    if (channel?.track.readyState === 'live') {
      channel.dispose()
    }
    playback?.dispose()
    sender.close()
    receiver.close()
    original?.stop()
    tone.stop()
    await context.close()
  }
}
