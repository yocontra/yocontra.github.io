import type { VoiceChatNode } from '../audio/audio.ts'

export interface MicrophoneActivity {
  speaking: () => boolean
  dispose: () => void
}

export interface VoiceMicrophone {
  track: MediaStreamTrack
  setSending: (on: boolean) => void
  dispose: () => void
}

export interface VoiceAudio {
  attachVoiceChat: (id: number, track: MediaStreamTrack) => VoiceChatNode | null
  resume?: () => void
}

/** Borrow the game's native audio context and listener; the SFU retains track ownership. */
export class NativeVoiceAudio implements VoiceAudio {
  private readonly nodes = new Map<number, VoiceChatNode>()
  private readonly context: () => AudioContext | null
  private readonly volume: () => number
  constructor(context: () => AudioContext | null, volume: () => number) {
    this.context = context
    this.volume = volume
  }

  resume(): void {
    const context = this.context()
    if (context && context.state !== 'running' && context.state !== 'closed') {
      void context.resume().catch(() => undefined)
    }
  }

  get running(): boolean {
    return this.context()?.state === 'running'
  }

  createMicrophone(track: MediaStreamTrack): VoiceMicrophone | null {
    const context = this.context()
    if (!context || context.state === 'closed') {
      return null
    }

    // RealtimeKit signals the producer as paused if its track starts disabled.
    // Keep the outbound track enabled and gate the microphone signal before it reaches WebRTC.
    const destination = context.createMediaStreamDestination()
    const [output] = destination.stream.getAudioTracks()
    if (!output) {
      return null
    }
    destination.channelCount = 1
    const source = context.createMediaStreamSource(new MediaStream([track]))
    const gain = context.createGain()
    gain.gain.value = 0
    source.connect(gain).connect(destination)
    return {
      track: output,
      setSending: (on) => {
        gain.gain.value = Number(on)
      },
      dispose: () => {
        gain.gain.value = 0
        source.disconnect()
        gain.disconnect()
        output.stop()
      },
    }
  }

  analyse(track: MediaStreamTrack, interrupted?: () => void): MicrophoneActivity | null {
    const context = this.context()
    if (!context || context.state === 'closed') {
      return null
    }
    const source = context.createMediaStreamSource(new MediaStream([track]))
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    let until = 0
    const state = () => {
      if (context.state !== 'running') {
        until = 0
        interrupted?.()
      }
    }
    context.addEventListener('statechange', state)
    return {
      speaking: () => {
        if (context.state !== 'running' || track.readyState !== 'live' || !track.enabled) {
          until = 0
          return false
        }
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (const value of samples) {
          sum += value * value
        }
        if (Math.sqrt(sum / samples.length) > 0.018) {
          until = performance.now() + 200
        }
        return performance.now() < until
      },
      dispose: () => {
        context.removeEventListener('statechange', state)
        source.disconnect()
        analyser.disconnect()
      },
    }
  }

  attachVoiceChat(id: number, track: MediaStreamTrack): VoiceChatNode | null {
    const context = this.context()
    if (!context || context.state === 'closed') {
      return null
    }
    this.nodes.get(id)?.dispose()
    const source = context.createMediaStreamSource(new MediaStream([track]))
    const panner = context.createPanner()
    panner.panningModel = 'equalpower'
    panner.distanceModel = 'inverse'
    panner.refDistance = 5
    panner.maxDistance = 28
    panner.rolloffFactor = 0.8
    const gain = context.createGain()
    source.connect(panner).connect(gain).connect(context.destination)
    let previousGain = -1
    const node: VoiceChatNode = {
      setPose: (x, y, z) => {
        panner.positionX.value = x
        panner.positionY.value = y
        panner.positionZ.value = z
      },
      setGain: (value) => {
        const level = Math.max(0, Math.min(1, value * this.volume()))
        if (level !== previousGain) {
          gain.gain.value = level
          previousGain = level
        }
      },
      dispose: () => {
        source.disconnect()
        panner.disconnect()
        gain.disconnect()
        this.nodes.delete(id)
      },
    }
    this.nodes.set(id, node)
    node.setGain(1)
    return node
  }

  dispose(): void {
    for (const node of this.nodes.values()) {
      node.dispose()
    }
  }
}
