/** RealtimeKit owns WebRTC; this adapter owns only native game track routing/subscriptions. */
import type Client from '@cloudflare/realtimekit'
import type { RTKParticipant } from '@cloudflare/realtimekit'
import type { VoiceChatNode } from '../audio/audio.ts'
import {
  gameId,
  prepareVoiceMeeting,
  publishVoiceMicrophone,
  releaseVoiceMeeting,
  safeTrack,
  type VoiceCredentials,
} from './meeting.ts'
import type { VoiceAudio } from './native-audio.ts'
import { rankVoicePeers, type VoicePeer } from './rank.ts'
import { RemotePlayout } from './remote-playout.ts'

interface Options {
  audio: VoiceAudio | null
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
  private mic: MediaStreamTrack | null = null
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

  async connect(credentials: VoiceCredentials, microphone: MediaStreamTrack): Promise<void> {
    const previous = this.stop()
    const sequence = this.live.sequence
    await previous
    if (sequence !== this.live.sequence) {
      return
    }
    let candidate: Client | null = null
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
      const track = await publishVoiceMicrophone(
        candidate,
        microphone,
        () => this.live.sequence === sequence,
      )
      if (!track || sequence !== this.live.sequence) {
        return
      }
      this.meeting = candidate
      this.joining = null
      this.mic = candidate.self.audioTrack ?? null
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
    if (this.mic) {
      this.mic.enabled = on
    }
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
    const add = (p: RTKParticipant) => this.addParticipant(p)
    const drop = (p: RTKParticipant) => this.dropParticipant(p)
    const reconcile = () => this.reconcile(true)
    joined.on('participantJoined', add)
    joined.on('participantLeft', drop)
    joined.on('participantsUpdate', reconcile)
    for (const p of joined.values()) {
      this.addParticipant(p)
    }
    const audio = ({ audioTrack }: { audioTrack: MediaStreamTrack }) => {
      this.mic = audioTrack ?? null
      this.setSending(this.live.sending)
    }
    const left = () => {
      if (this.meeting === meeting) {
        void this.stop().then(() => this.o.onState('error', 'Voice connection lost. Retry voice.'))
      }
    }
    meeting.self.on('audioUpdate', audio)
    meeting.self.on('roomLeft', left)
    this.unbindMeeting = () => {
      joined.off('participantJoined', add)
      joined.off('participantLeft', drop)
      joined.off('participantsUpdate', reconcile)
      meeting.self.off('audioUpdate', audio)
      meeting.self.off('roomLeft', left)
    }
  }

  private addParticipant(p: RTKParticipant): void {
    const id = gameId(p.customParticipantId)
    if (id === null) {
      return
    }
    this.participants.set(id, p)
    const onAudio = ({ audioTrack }: { audioTrack: MediaStreamTrack }) => {
      this.attach(id, audioTrack)
    }
    this.audioListeners.set(id, onAudio)
    p.on('audioUpdate', onAudio)
    this.attach(id, safeTrack(p))
  }

  private dropParticipant(p: RTKParticipant): void {
    const id = gameId(p.customParticipantId)
    if (id === null) {
      return
    }
    const listener = this.audioListeners.get(id)
    if (listener) {
      p.off('audioUpdate', listener)
      this.audioListeners.delete(id)
    }
    this.participants.delete(id)
    this.detach(id)
    this.wanted.delete(id)
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
    this.mic?.stop()
    this.mic = null
    this.unbindMeeting?.()
    this.unbindMeeting = undefined
    for (const id of [...this.nodes.keys()]) {
      this.detach(id)
    }
    for (const [id, participant] of this.participants) {
      const listener = this.audioListeners.get(id)
      if (listener) {
        participant.off('audioUpdate', listener)
      }
    }
    this.participants.clear()
    this.audioListeners.clear()
    this.wanted.clear()
    this.keepUntil.clear()
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
    const subscribed = new Set<number>()
    for (const peerId of meeting.participants.audioSubscribed.keys()) {
      const p = meeting.participants.joined.get(peerId)
      const id = p ? gameId(p.customParticipantId) : null
      if (id !== null) {
        subscribed.add(id)
      }
    }
    const peerIds = new Map<number, string>()
    for (const [id, p] of this.participants) {
      peerIds.set(id, p.id)
    }
    this.live.reconciling = true
    const sequence = this.live.sequence
    const wanted = new Set(this.wanted)
    const current = () => this.meeting === meeting && sequence === this.live.sequence
    void (async () => {
      try {
        for (const id of subscribed) {
          const peerId = peerIds.get(id)
          if (!wanted.has(id) && peerId) {
            // RealtimeKit serializes subscription changes
            await meeting.participants.unsubscribe([peerId], ['audio']).catch(() => undefined)
            if (!current()) {
              return
            }
            this.detach(id)
          }
        }
        for (const id of wanted) {
          const peerId = peerIds.get(id)
          if (peerId && !subscribed.has(id)) {
            // one subscription request per nearby peer
            await meeting.participants.subscribe([peerId], ['audio']).catch(() => undefined)
          }
          if (!current()) {
            return
          }
          const p = this.participants.get(id)
          this.attach(id, p ? safeTrack(p) : null)
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
