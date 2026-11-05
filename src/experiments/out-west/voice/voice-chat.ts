// biome-ignore-all lint/suspicious/noUnnecessaryConditions: live voice state changes between async callbacks and frames
/**
 * Proximity voice, client side. Cloudflare RealtimeKit owns the session, microphone, TURN/SFU,
 * reconnects and participant/track plumbing; this module only decides which nearby players to
 * subscribe to and routes their tracks through the game's positional audio.
 *
 * RealtimeKit is imported only when voice is turned on, so the normal game bundle and boot path
 * are unchanged.
 */
import type Client from '@cloudflare/realtimekit'
import type { RTKParticipant } from '@cloudflare/realtimekit'
import type { AudioEngine, VoiceChatNode } from '../audio/audio.ts'
import { rankVoicePeers, type VoicePeer } from './rank.ts'

export type VoiceState = 'off' | 'connecting' | 'live' | 'error'

export interface VoiceCredentials {
  meetingId: string
  token: string
}

export interface VoiceSettings {
  voiceChat: boolean
  voicePushToTalk: boolean
}

export interface VoiceChatOptions {
  audio: AudioEngine | null
  /** Ask the game server for a RealtimeKit participant token. */
  requestToken: () => Promise<VoiceCredentials | null>
  /** Tell the game server the participant is gone (its token is deleted). */
  sendOff: () => void
  settings: () => VoiceSettings
  /** Players whose voice is locally muted. */
  muted?: (id: number) => boolean
  onState?: (state: VoiceState, message?: string) => void
  /** Frontier uses four; a duel passes one. */
  maxPeers?: number
  /** Audible radius and the slightly wider drop radius (hysteresis). */
  inRange?: number
  outRange?: number
  keepMs?: number
}

const GAME_ID = /^\d+$/u
const TOKEN_TIMEOUT_MS = 10_000
const RECONCILE_MS = 500
const DEFAULT_KEEP_MS = 2000

export class VoiceChat {
  private readonly o: VoiceChatOptions
  private state: VoiceState = 'off'
  private enabled = false
  private meeting: Client | null = null
  private mic: MediaStreamTrack | null = null
  private starting = false
  private startSeq = 0
  private tokenRequested = false
  private talking = false
  private silenced = false
  private micMuted = false
  private lastReconcile = 0
  private reconciling = false
  private readonly peers = new Map<number, VoicePeer>()
  private own = { x: 0, z: 0 }
  private readonly participants = new Map<number, RTKParticipant>()
  private readonly audioListeners = new Map<number, (p: { audioTrack: MediaStreamTrack }) => void>()
  private readonly nodes = new Map<number, VoiceChatNode>()
  private readonly wanted = new Set<number>()
  private readonly keepUntil = new Map<number, number>()
  private readonly localMuted = new Set<number>()

  constructor(o: VoiceChatOptions) {
    this.o = o
  }

  get current(): VoiceState {
    return this.state
  }

  get isLive(): boolean {
    return this.state === 'live'
  }

  /** Follow the Settings toggle. */
  setEnabled(on: boolean): void {
    if (this.enabled === on) {
      this.applyMic()
      return
    }
    this.enabled = on
    if (on) {
      void this.start()
    } else {
      void this.stop()
    }
  }

  /** Hold/put down the talk control. No-op in open-mic mode. */
  setTalking(on: boolean): void {
    this.talking = on
    this.applyMic()
  }

  /** Open-mic mode's local mute. */
  setMicMuted(on: boolean): void {
    this.micMuted = on
    this.applyMic()
  }

  get micMutedState(): boolean {
    return this.micMuted
  }

  /** Duel's standoff: neither side can send or hear until the result. */
  setSilenced(on: boolean): void {
    this.silenced = on
    this.applyMic()
    this.applyGains()
  }

  setMuted(id: number, on: boolean): void {
    if (on) {
      this.localMuted.add(id)
    } else {
      this.localMuted.delete(id)
    }
    this.applyGains()
  }

  /** Call once per frame with the game's current positions and the listener's ground position. */
  update(peers: readonly VoicePeer[], own?: { x: number; z: number }): void {
    if (own) {
      this.own = own
    }
    this.peers.clear()
    for (const p of peers) {
      this.peers.set(p.id, p)
    }
    for (const [id, peer] of this.peers) {
      this.nodes.get(id)?.setPose(peer.x, peer.y + 1.25, peer.z)
    }
    this.applyGains()
    if (this.meeting) {
      this.reconcile(false)
    }
    this.applyMic()
  }

  async dispose(): Promise<void> {
    this.enabled = false
    await this.stop()
  }

  private async start(): Promise<void> {
    if (this.starting || this.meeting) {
      return
    }
    this.starting = true
    const seq = ++this.startSeq
    this.setState('connecting')
    try {
      const credentials = await this.withTimeout(this.o.requestToken())
      if (!this.enabled || seq !== this.startSeq) {
        return
      }
      if (!credentials) {
        this.setState('error', 'Voice is unavailable.')
        this.o.sendOff()
        return
      }
      this.tokenRequested = true
      const sdk = await import('@cloudflare/realtimekit')
      const meeting = await sdk.default.init({
        authToken: credentials.token,
        defaults: {
          audio: true,
          video: false,
          mediaConfiguration: {
            audio: {
              echoCancellation: true,
              noiseSupression: true,
              autoGainControl: true,
              enableStereo: false,
            },
          },
        },
        // RealtimeKit's SFU already hides peer addresses; force TURN when a direct path is not
        // available rather than leaking a host candidate.
        overrides: { forceRelay: true },
        // Core SDK is headless: do not let it play remote tracks behind our panners.
        modules: { experimentalAudioPlayback: false },
      })
      await meeting.join()
      // Only nearby players should be subscribed: RealtimeKit's manual mode is the switch that
      // makes subscribe/unsubscribe authoritative.
      await meeting.participants.setViewMode('MANUAL')
      if (!this.enabled || seq !== this.startSeq) {
        await meeting.leave().catch(() => undefined)
        return
      }
      this.meeting = meeting
      this.bindMeeting(meeting)
      this.mic = meeting.self.audioTrack ?? null
      this.setState('live')
      this.applyMic()
      this.reconcile(true)
    } catch (err) {
      console.error('proximity voice failed', err)
      this.setState('error', err instanceof Error ? err.message : 'Voice is unavailable.')
      this.o.sendOff()
      this.tokenRequested = false
    } finally {
      this.starting = false
    }
  }

  private bindMeeting(meeting: Client): void {
    const joined = meeting.participants.joined
    joined.on('participantJoined', (p) => this.addParticipant(p))
    joined.on('participantLeft', (p) => this.dropParticipant(p))
    joined.on('participantsUpdate', () => this.reconcile(true))
    for (const p of joined.values()) {
      this.addParticipant(p)
    }
    meeting.self.on('audioUpdate', ({ audioTrack }) => {
      this.mic = audioTrack ?? null
      this.applyMic()
    })
    meeting.self.on('roomLeft', () => {
      if (this.enabled) {
        this.setState('error', 'Voice connection lost.')
      }
    })
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
    if (!track || track.readyState === 'ended') {
      this.detach(id)
      return
    }
    const existing = this.nodes.get(id)
    if (existing) {
      return
    }
    const node = this.o.audio?.attachVoiceChat(id, track)
    if (!node) {
      return
    }
    this.nodes.set(id, node)
    this.applyGains()
  }

  private detach(id: number): void {
    const node = this.nodes.get(id)
    if (node) {
      node.dispose()
      this.nodes.delete(id)
    }
  }

  private async stop(): Promise<void> {
    const meeting = this.meeting
    this.meeting = null
    this.startSeq++
    this.mic = null
    for (const id of [...this.nodes.keys()]) {
      this.detach(id)
    }
    this.participants.clear()
    this.audioListeners.clear()
    this.wanted.clear()
    this.keepUntil.clear()
    this.setState('off')
    if (meeting) {
      await meeting.leave().catch(() => undefined)
    }
    if (this.tokenRequested) {
      this.tokenRequested = false
      this.o.sendOff()
    }
  }

  private reconcile(force: boolean): void {
    const meeting = this.meeting
    if (!meeting) {
      return
    }
    const now = performance.now()
    if (!force && (this.reconciling || now - this.lastReconcile < RECONCILE_MS)) {
      return
    }
    this.lastReconcile = now
    const inRange = this.o.inRange ?? 24
    const outRange = this.o.outRange ?? 28
    const keepMs = this.o.keepMs ?? DEFAULT_KEEP_MS
    const max = Math.max(1, this.o.maxPeers ?? 4)

    const muted = new Set<number>()
    for (const id of this.participants.keys()) {
      if (this.o.muted?.(id) || this.localMuted.has(id)) {
        muted.add(id)
      }
    }
    this.wanted.clear()
    for (const id of rankVoicePeers(this.peers, this.own, {
      max,
      inRange,
      outRange,
      keepMs,
      now,
      muted,
      keepUntil: this.keepUntil,
    })) {
      this.wanted.add(id)
    }

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
    this.reconciling = true
    void (async () => {
      try {
        for (const id of subscribed) {
          const peerId = peerIds.get(id)
          if (!this.wanted.has(id) && peerId) {
            // biome-ignore lint/performance/noAwaitInLoops: RealtimeKit serializes subscription changes
            await meeting.participants.unsubscribe([peerId], ['audio']).catch(() => undefined)
            this.detach(id)
          }
        }
        for (const id of this.wanted) {
          const peerId = peerIds.get(id)
          if (peerId && !subscribed.has(id)) {
            // biome-ignore lint/performance/noAwaitInLoops: one subscription request per nearby peer
            await meeting.participants.subscribe([peerId], ['audio']).catch(() => undefined)
          }
          const p = this.participants.get(id)
          this.attach(id, p ? safeTrack(p) : null)
        }
      } finally {
        this.reconciling = false
      }
    })()
  }

  private applyMic(): void {
    if (!this.mic) {
      return
    }
    const s = this.o.settings()
    const open = !s.voicePushToTalk
    const send =
      this.enabled && this.isLive && !this.silenced && !this.micMuted && (open || this.talking)
    if (this.mic.enabled !== send) {
      this.mic.enabled = send
    }
  }

  private applyGains(): void {
    for (const [id, node] of this.nodes) {
      const quiet = this.silenced || this.localMuted.has(id) || this.o.muted?.(id) === true
      node.setGain(quiet ? 0 : 1)
    }
  }

  private setState(state: VoiceState, message?: string): void {
    if (this.state === state && !message) {
      return
    }
    this.state = state
    this.o.onState?.(state, message)
  }

  // biome-ignore lint/style/useThisInClassMethods: a free helper keeps the async race readable
  private async withTimeout<T>(p: Promise<T>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        p,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), TOKEN_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }
}

/** The game id carried in `customParticipantId`; 0 is a real Frontier player and Duel seat. */
function gameId(custom: string | undefined): number | null {
  if (typeof custom !== 'string' || !GAME_ID.test(custom)) {
    return null
  }
  const id = Number(custom)
  return Number.isSafeInteger(id) ? id : null
}

function safeTrack(p: RTKParticipant): MediaStreamTrack | null {
  try {
    return p.audioTrack ?? null
  } catch {
    return null
  }
}
