/** RealtimeKit owns WebRTC; this adapter owns only native game track routing/subscriptions. */
import type Client from '@cloudflare/realtimekit'
import type { RTKParticipant } from '@cloudflare/realtimekit'
import type { VoiceChatNode } from '../audio/audio.ts'
import {
  gameId,
  microphoneFailure,
  prepareVoiceMeeting,
  publishVoiceMicrophone,
  releaseVoiceMeeting,
  safeTrack,
  type VoiceCredentials,
} from './meeting.ts'
import type { VoiceAudio, VoiceMicrophone } from './native-audio.ts'
import { rankVoicePeers, type VoicePeer } from './rank.ts'
import { RemotePlayout } from './remote-playout.ts'

interface Options {
  audio: VoiceAudio | null
  microphone: (track: MediaStreamTrack) => VoiceMicrophone | null
  muted: (id: number) => boolean
  onState: (state: 'live' | 'error', message?: string) => void
}
const RECONCILE_MS = 500
const DEFAULT_KEEP_MS = 2000
export class VoiceTransport {
  private readonly live: {
    sequence: number
    sending: boolean
    silenced: boolean
    lastReconcile: number
    reconciling: boolean
    reconcileAgain: boolean
  } = {
    sequence: 0,
    sending: false,
    silenced: false,
    lastReconcile: 0,
    reconciling: false,
    reconcileAgain: false,
  }
  private readonly o: Options
  private meeting: Client | null = null
  private joining: Client | null = null
  private unbindMeeting: (() => void) | undefined
  private mic: VoiceMicrophone | null = null
  private pendingMicrophone: VoiceMicrophone | null = null
  private microphoneSwitch: Promise<unknown> = Promise.resolve()
  private connection: Promise<void> = Promise.resolve()
  private sourceMicrophone: MediaStreamTrack | null = null
  private readonly peers = new Map<number, VoicePeer>()
  private own = { x: 0, z: 0 }
  private readonly participants = new Map<number, RTKParticipant>()
  private readonly audioListeners = new Map<number, (p: { audioTrack: MediaStreamTrack }) => void>()
  private readonly tracks = new Map<number, MediaStreamTrack>()
  private speakers = new Set<number>()
  private readonly nodes = new Map<number, VoiceChatNode>()
  private readonly playouts = new Map<number, RemotePlayout>()
  private readonly wanted = new Set<number>()
  private readonly keepUntil = new Map<number, number>()
  constructor(options: Options) {
    this.o = options
  }

  connect(credentials: VoiceCredentials, microphone: MediaStreamTrack | null): Promise<void> {
    this.connection = this.join(credentials, microphone)
    return this.connection
  }
  private async join(
    credentials: VoiceCredentials,
    microphone: MediaStreamTrack | null,
  ): Promise<void> {
    const previous = this.stop()
    const sequence = this.live.sequence
    await previous
    if (sequence !== this.live.sequence) {
      return
    }
    let candidate: Client | null = null
    let channel: VoiceMicrophone | null = null
    try {
      candidate = await prepareVoiceMeeting(credentials, () => this.live.sequence === sequence)
      if (!candidate) {
        return
      }
      this.joining = candidate
      await candidate.join()
      if (sequence !== this.live.sequence) {
        return
      }
      await candidate.participants.setViewMode('MANUAL')
      if (sequence !== this.live.sequence) {
        return
      }
      if (microphone?.readyState === 'live') {
        channel = await this.publish(candidate, microphone, () => this.live.sequence === sequence)
      }
      if (sequence !== this.live.sequence) {
        return
      }
      this.meeting = candidate
      this.joining = null
      this.mic = channel
      this.sourceMicrophone = channel ? microphone : null
      channel = null
      this.bindMeeting(candidate)
      this.setSending(this.live.sending)
      this.reconcile(true)
      candidate = null
      this.o.onState('live')
    } catch (error) {
      if (sequence === this.live.sequence) {
        this.o.onState(
          'error',
          error instanceof Error ? error.message : 'Voice connection failed. Retry voice.',
        )
      }
    } finally {
      channel?.dispose()
      if (candidate) {
        if (this.joining === candidate) {
          this.joining = null
        }
        await releaseVoiceMeeting(candidate)
      }
    }
  }
  setSending(on: boolean): void {
    this.live.sending = on
    this.mic?.setSending(on)
  }
  private async publish(
    meeting: Client,
    microphone: MediaStreamTrack,
    active: () => boolean,
  ): Promise<VoiceMicrophone | null> {
    const channel = this.o.microphone(microphone)
    if (!channel) {
      throw new Error(microphoneFailure(undefined))
    }
    this.pendingMicrophone = channel
    let adopted = false
    try {
      adopted = await publishVoiceMicrophone(meeting, channel.track, active)
      return adopted ? channel : null
    } finally {
      if (this.pendingMicrophone === channel) {
        this.pendingMicrophone = null
      }
      if (!adopted) {
        channel.dispose()
      }
    }
  }
  /** Serialize native producer changes on the current meeting; never touch a replacement meeting. */
  async replaceMicrophone(
    microphone: MediaStreamTrack | null,
    active: () => boolean,
  ): Promise<boolean> {
    await this.connection
    if (!active()) {
      return false
    }
    const meeting = this.meeting
    if (!meeting) {
      return false
    }
    const sequence = this.live.sequence
    const current = () => active() && this.meeting === meeting && this.live.sequence === sequence
    const change = this.microphoneSwitch.then(async () => {
      if (!current()) {
        return false
      }
      if (
        microphone === this.sourceMicrophone &&
        (!microphone || this.mic?.track.readyState === 'live')
      ) {
        return true
      }
      const previous = this.mic
      this.mic = null
      this.sourceMicrophone = null
      previous?.setSending(false)
      try {
        await meeting.self.disableAudio()
      } finally {
        previous?.dispose()
      }
      if (!current()) {
        return false
      }
      if (microphone?.readyState !== 'live') {
        return true
      }
      const channel = await this.publish(meeting, microphone, current)
      if (!(channel && current())) {
        channel?.dispose()
        return false
      }
      this.mic = channel
      this.sourceMicrophone = microphone
      this.setSending(this.live.sending)
      return true
    })
    this.microphoneSwitch = change.catch(() => undefined)
    return change
  }
  resumeReceive(): void {
    for (const playout of this.playouts.values()) {
      playout.resume()
    }
  }
  setSpeakers(ids: readonly number[]): void {
    this.speakers = new Set(ids)
    this.applyGains()
    this.reconcile(true)
  }
  update(
    peers: readonly VoicePeer[],
    own: { x: number; z: number } | undefined,
    silenced: boolean,
  ): void {
    this.live.silenced = silenced
    if (own) {
      this.own = own
    }
    this.peers.clear()
    for (const peer of peers) {
      this.peers.set(peer.id, peer)
      this.nodes.get(peer.id)?.setPose(peer.x, peer.y + 1.25, peer.z)
    }
    this.applyGains()
    this.reconcile(false)
  }
  private bindMeeting(meeting: Client): void {
    const joined = meeting.participants.joined
    const add = (p: RTKParticipant) => {
      this.addParticipant(p)
      this.reconcile(true)
    }
    const drop = (p: RTKParticipant) => {
      this.dropParticipant(p)
      this.reconcile(true)
    }
    const reconcile = () => this.reconcile(true)
    joined.on('participantJoined', add)
    joined.on('participantLeft', drop)
    joined.on('participantsUpdate', reconcile)
    for (const p of joined.values()) {
      this.addParticipant(p)
    }
    const left = () => {
      if (this.meeting === meeting) {
        const stopped = this.stop()
        const sequence = this.live.sequence
        void stopped.then(() => {
          if (sequence === this.live.sequence) {
            this.o.onState('error', 'Voice connection lost. Retry voice.')
          }
        })
      }
    }
    meeting.self.on('roomLeft', left)
    this.unbindMeeting = () => {
      joined.off('participantJoined', add)
      joined.off('participantLeft', drop)
      joined.off('participantsUpdate', reconcile)
      meeting.self.off('roomLeft', left)
    }
  }

  private addParticipant(p: RTKParticipant): void {
    const id = gameId(p.customParticipantId)
    if (id === null) {
      return
    }
    const previous = this.participants.get(id)
    if (previous === p) {
      return
    }
    if (previous) {
      this.removeParticipant(id, previous)
    }
    this.participants.set(id, p)
    const onAudio = ({ audioTrack }: { audioTrack: MediaStreamTrack }) => {
      if (this.participants.get(id) === p) {
        this.attach(id, audioTrack)
      }
    }
    this.audioListeners.set(id, onAudio)
    p.on('audioUpdate', onAudio)
    this.attach(id, safeTrack(p))
  }

  private dropParticipant(p: RTKParticipant): void {
    const id = gameId(p.customParticipantId)
    if (id === null || this.participants.get(id) !== p) {
      return
    }
    this.removeParticipant(id, p)
  }

  private removeParticipant(id: number, p: RTKParticipant): void {
    const listener = this.audioListeners.get(id)
    if (listener) {
      p.off('audioUpdate', listener)
      this.audioListeners.delete(id)
    }
    this.participants.delete(id)
    this.detach(id)
    this.wanted.delete(id)
    this.keepUntil.delete(id)
  }

  private attach(id: number, track: MediaStreamTrack | null): void {
    if (!(this.wanted.has(id) && track) || track.readyState === 'ended') {
      this.detach(id)
      return
    }
    const existing = this.nodes.get(id)
    if (existing && this.tracks.get(id) === track) {
      return
    }
    this.detach(id)
    const node = this.o.audio?.attachVoiceChat(id, track)
    if (!node) {
      return
    }
    let playout: RemotePlayout
    try {
      playout = new RemotePlayout(track, (state) => {
        if (this.playouts.get(id) !== playout) {
          return
        }
        if (state === 'ended') {
          this.detach(id)
        } else if (state === 'error') {
          this.o.onState('error', 'Voice playback could not start. Retry voice.')
        } else {
          this.receiveState()
        }
      })
    } catch {
      node.dispose()
      this.o.onState('error', 'Silent voice playback is unavailable in this browser.')
      return
    }
    this.nodes.set(id, node)
    this.tracks.set(id, track)
    this.playouts.set(id, playout)
    this.applyGains()
    playout.resume()
  }

  private detach(id: number): void {
    this.playouts.get(id)?.dispose()
    this.playouts.delete(id)
    const node = this.nodes.get(id)
    if (node) {
      node.dispose()
      this.nodes.delete(id)
      this.tracks.delete(id)
    }
    this.receiveState()
  }

  private receiveState(): void {
    if (this.meeting) {
      this.o.onState(
        'live',
        [...this.playouts.values()].some((playout) => playout.state === 'blocked')
          ? 'Tap the voice button to hear nearby players.'
          : undefined,
      )
    }
  }

  async stop(): Promise<void> {
    const meeting = this.meeting ?? this.joining
    this.meeting = null
    this.joining = null
    this.live.sequence++
    this.mic?.dispose()
    this.mic = null
    this.pendingMicrophone?.dispose()
    this.pendingMicrophone = null
    this.sourceMicrophone = null
    this.unbindMeeting?.()
    this.unbindMeeting = undefined
    for (const [id, participant] of this.participants) {
      this.removeParticipant(id, participant)
    }
    this.live.reconciling = false
    this.live.reconcileAgain = false
    this.live.lastReconcile = 0
    if (meeting) {
      await releaseVoiceMeeting(meeting)
    }
  }

  private reconcile(force: boolean): void {
    const meeting = this.meeting
    if (!meeting) {
      return
    }
    const now = performance.now()
    if (this.live.reconciling) {
      this.live.reconcileAgain ||= force
      return
    }
    if (!force && now - this.live.lastReconcile < RECONCILE_MS) {
      return
    }
    this.live.lastReconcile = now
    const inRange = 24
    const outRange = 28
    const keepMs = DEFAULT_KEEP_MS
    const max = 4

    const muted = new Set<number>()
    for (const id of this.participants.keys()) {
      if (this.o.muted(id)) {
        muted.add(id)
      }
    }
    this.wanted.clear()
    for (const id of rankVoicePeers(
      new Map(
        [...this.peers].filter(
          ([peerId]) => this.participants.has(peerId) && this.speakers.has(peerId),
        ),
      ),
      this.own,
      {
        max,
        inRange,
        outRange,
        keepMs,
        now,
        muted,
        keepUntil: this.keepUntil,
      },
    )) {
      this.wanted.add(id)
    }

    // Free local receive slots before asynchronous SDK unsubscribe work. Late audio events for
    // newly wanted peers must never overlap the previous four decoding elements/nodes.
    for (const id of [...this.nodes.keys()]) {
      if (!this.wanted.has(id)) {
        this.detach(id)
      }
    }
    this.applyGains()
    // RealtimeKit keys its subscriptions by the SDK peer identity. A game slot can be reused.
    const subscribed = new Set(meeting.participants.audioSubscribed.keys())
    const wanted = new Map<string, { id: number; participant: RTKParticipant }>()
    for (const id of this.wanted) {
      const participant = this.participants.get(id)
      if (participant) {
        wanted.set(participant.id, { id, participant })
      }
    }
    this.live.reconciling = true
    const sequence = this.live.sequence
    const current = () => this.meeting === meeting && sequence === this.live.sequence
    void (async () => {
      try {
        // RealtimeKit serializes subscription changes.
        for (const peerId of [...subscribed].filter((id) => !wanted.has(id))) {
          await meeting.participants.unsubscribe([peerId], ['audio']).catch(() => undefined)
          if (!current()) {
            return
          }
        }
        for (const [peerId, { id, participant }] of wanted) {
          const stillWanted = () => this.participants.get(id) === participant && this.wanted.has(id)
          if (!stillWanted()) {
            continue
          }
          if (!subscribed.has(peerId)) {
            await meeting.participants.subscribe([peerId], ['audio']).catch(() => undefined)
            if (!current()) {
              return
            }
          }
          if (stillWanted()) {
            this.attach(id, safeTrack(participant))
          }
        }
      } finally {
        if (current()) {
          this.finishReconcile()
        }
      }
    })()
  }

  private finishReconcile(): void {
    this.live.reconciling = false
    if (this.live.reconcileAgain) {
      this.live.reconcileAgain = false
      this.reconcile(true)
    }
  }

  private applyGains(): void {
    for (const [id, node] of this.nodes) {
      node.setGain(
        !(this.wanted.has(id) && this.speakers.has(id)) || this.live.silenced || this.o.muted(id)
          ? 0
          : 1,
      )
    }
  }
}
