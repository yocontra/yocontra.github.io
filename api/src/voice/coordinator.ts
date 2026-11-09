import {
  VOICE_IDLE_MS,
  VOICE_INTENT_TTL_MS,
  type VoiceClientControl,
  type VoiceServerControl,
} from '../../../src/experiments/out-west/contract/voice.ts'
import type { Env } from '../env.ts'
import { reserveVoiceBudget, VOICE_LEASE_MS, VOICE_RENEW_MS, VoiceBudgetError } from './budget.ts'
import {
  cleanVoiceEntry,
  type VoiceGeneration as Generation,
  type VoiceCleanup,
  type VoiceStorage,
} from './cleanup.ts'

import { selectVoiceMembers, type VoiceInterest, type VoicePeer } from './proximity.ts'
import {
  addVoiceParticipant,
  createVoiceMeeting,
  voiceConfigured,
  voiceUnavailableMessage,
} from './realtime.ts'

export type { VoiceStorage } from './cleanup.ts'

interface Options {
  env: Env
  title: () => string
  peers: () => readonly VoicePeer[]
  send: (id: number, control: VoiceServerControl) => void
  save: (state: VoiceStorage) => Promise<void>
  reschedule: () => Promise<void>
  waitUntil: (work: Promise<unknown>) => void
  now?: () => number
  reserve?: (participants: number) => Promise<boolean>
}

/** The game owns interest/leases; RealtimeKit owns all media. No provider work in standby. */
export class VoiceCoordinator {
  private readonly live: {
    next: number
    pumping: boolean
    dirty: boolean
    cleaning: boolean
    lastUpdate: number
    failureUntil: number
    quietAt: number
    timerAt: number
  } = {
    next: 0,
    pumping: false,
    dirty: false,
    cleaning: false,
    lastUpdate: 0,
    failureUntil: 0,
    quietAt: 0,
    timerAt: 0,
  }
  private readonly o: Options
  private readonly interests = new Map<number, VoiceInterest>()
  private readonly intents = new Map<number, number>()
  private readonly statuses = new Map<number, string>()
  private desired = new Set<number>()
  private active: Generation | undefined
  private cleanup: VoiceCleanup[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private saving = Promise.resolve()
  private budgetJob: Generation | undefined

  constructor(options: Options) {
    this.o = options
  }
  private now(): number {
    return this.o.now?.() ?? Date.now()
  }
  snapshot(): VoiceStorage {
    return structuredClone({
      ...(this.active ? { active: this.active } : {}),
      cleanup: this.cleanup,
      next: this.live.next,
    })
  }
  get nextRetry(): number | undefined {
    return this.cleanup.length > 0
      ? Math.min(...this.cleanup.map((entry) => entry.retryAt))
      : undefined
  }
  get resources() {
    return {
      interests: this.interests.size,
      intents: this.intents.size,
      members: Object.keys(this.active?.participants ?? {}).length,
      cleanup: this.cleanup.length,
      timers: Number(this.timer !== undefined),
    }
  }

  async restore(state: VoiceStorage | undefined): Promise<void> {
    if (!state) {
      return
    }
    this.live.next = state.next ?? 0
    this.cleanup = structuredClone(state.cleanup ?? [])
    const previous =
      state.active ??
      (state.meetingId
        ? {
            id: ++this.live.next,
            meetingId: state.meetingId,
            participants: state.participants ?? {},
          }
        : undefined)
    if (previous?.meetingId) {
      this.retire(previous, true)
    }
    await this.persist()
  }

  preference(id: number): Extract<VoiceClientControl, { type: 'voice_on' }> | undefined {
    const interest = this.interests.get(id)
    return interest
      ? { type: 'voice_on', listening: interest.listening, muted: [...interest.muted] }
      : undefined
  }

  handle(id: number, message: unknown): boolean {
    if (!message || typeof message !== 'object') {
      return false
    }
    const type = Reflect.get(message, 'type')
    if (type === 'voice_off') {
      this.drop(id)
      return true
    }
    if (type !== 'voice_on' && type !== 'voice_talk') {
      return false
    }
    const peer = this.o.peers().find((value) => value.id === id && value.human && value.connected)
    if (!peer) {
      return true
    }
    if (!voiceConfigured(this.o.env)) {
      this.o.send(id, { type: 'voice_error', message: voiceUnavailableMessage(this.o.env) })
      return true
    }
    if (type === 'voice_on') {
      const muted = Reflect.get(message, 'muted')
      this.interests.set(id, {
        listening: Reflect.get(message, 'listening') !== false,
        muted: new Set(
          Array.isArray(muted)
            ? muted
                .slice(0, 32)
                .filter(
                  (value): value is number =>
                    Number.isSafeInteger(value) && value >= 0 && value < 32,
                )
            : [],
        ),
      })
    } else if (this.interests.has(id)) {
      if (Reflect.get(message, 'talking') === true) {
        this.intents.set(id, this.now() + VOICE_INTENT_TTL_MS)
      } else {
        this.intents.delete(id)
      }
    }
    this.update(true)
    return true
  }

  drop(id: number): void {
    this.interests.delete(id)
    this.intents.delete(id)
    this.statuses.delete(id)
    this.update(true, true)
  }
  update(force = false, immediate = false): void {
    const now = this.now()
    if (!force && now - this.live.lastUpdate < 500) {
      return
    }
    if (this.interests.size === 0 && !this.active && this.intents.size === 0) {
      this.desired.clear()
      this.live.quietAt = 0
      this.arm()
      return
    }
    this.live.lastUpdate = now
    this.expireLease(now)
    for (const [id, until] of this.intents) {
      if (until <= now) {
        this.intents.delete(id)
      }
    }
    const selection = selectVoiceMembers(
      this.o.peers(),
      this.interests,
      new Set(this.intents.keys()),
      this.desired,
    )
    const speakers = [...this.intents.keys()]
      .filter((id) => selection.members.has(id))
      .sort((a, b) => a - b)
    for (const [id, count] of selection.listeners) {
      const status = `${count}:${speakers.join(',')}`
      if (this.statuses.get(id) !== status) {
        this.statuses.set(id, status)
        this.o.send(id, { type: 'voice_status', listeners: count, speakers })
      }
    }
    const quiet =
      selection.members.size === 0 && this.intents.size === 0 && this.active !== undefined
    if (quiet && !immediate) {
      this.live.quietAt ||= now + VOICE_IDLE_MS
      if (now < this.live.quietAt) {
        this.arm()
        return
      }
      this.live.quietAt = 0
    } else {
      this.live.quietAt = 0
    }
    this.desired = selection.members
    this.arm()
    this.live.dirty = true
    this.o.waitUntil(this.pump())
  }

  /** Cancel active-only timers synchronously; network cleanup is durable and independent. */
  async close(): Promise<void> {
    for (const id of this.interests.keys()) {
      this.o.send(id, { type: 'voice_standby' })
    }
    this.interests.clear()
    this.intents.clear()
    this.statuses.clear()
    this.desired.clear()
    this.live.quietAt = 0
    clearTimeout(this.timer)
    this.timer = undefined
    this.live.timerAt = 0
    if (this.active) {
      this.retire(this.active, true)
      this.active = undefined
      this.arm()
    }
    await this.persist()
    await this.retry()
  }
  private expireLease(now: number): void {
    const active = this.active
    if (active?.leaseUntil !== undefined && now >= active.leaseUntil) {
      for (const id of Object.keys(active.participants)) {
        this.o.send(Number(id), { type: 'voice_standby' })
      }
      this.retire(active, true)
      this.active = undefined
      this.arm()
      this.o.waitUntil(this.persist().then(() => this.retry()))
    }
  }

  private arm(): void {
    const lease = this.active?.leaseUntil ?? Number.POSITIVE_INFINITY
    const renewal =
      this.budgetJob === this.active
        ? Number.POSITIVE_INFINITY
        : (this.active?.renewAt ?? Number.POSITIVE_INFINITY)
    const next = Math.min(
      this.live.quietAt || Number.POSITIVE_INFINITY,
      lease,
      renewal,
      ...this.intents.values(),
    )
    if (next === this.live.timerAt) {
      return
    }
    clearTimeout(this.timer)
    this.timer = undefined
    this.live.timerAt = Number.isFinite(next) ? next : 0
    if (this.live.timerAt) {
      this.timer = setTimeout(
        () => {
          this.timer = undefined
          this.live.timerAt = 0
          this.update(true)
        },
        Math.max(1, next - this.now()),
      )
    }
  }
  private persist(): Promise<void> {
    const state = this.snapshot()
    this.saving = this.saving.catch(() => undefined).then(() => this.o.save(state))
    return this.saving.then(() => this.o.reschedule())
  }
  private retire(
    generation: Generation,
    end: boolean,
    participants = Object.values(generation.participants),
  ): void {
    if (!generation.meetingId) {
      return
    }
    this.cleanup.push({
      generation: generation.id,
      meetingId: generation.meetingId,
      participants,
      end,
      ended: false,
      retryAt: this.now(),
      attempts: 0,
    })
  }
  private async pump(): Promise<void> {
    if (this.live.pumping) {
      return
    }
    this.live.pumping = true
    try {
      while (this.live.dirty) {
        this.live.dirty = false
        // reconcile generations serially across concurrent game controls
        await this.reconcile()
      }
    } catch (error) {
      this.live.failureUntil = this.now() + 5000
      for (const id of this.desired) {
        this.interests.delete(id)
        this.intents.delete(id)
        this.statuses.delete(id)
        this.o.send(id, {
          type: 'voice_error',
          message:
            error instanceof VoiceBudgetError ? error.message : voiceUnavailableMessage(this.o.env),
        })
      }
      if (this.active) {
        this.retire(this.active, true)
        this.active = undefined
        this.arm()
      }
      this.desired.clear()
      this.arm()
      await this.persist()
    } finally {
      this.live.pumping = false
      this.o.waitUntil(this.retry())
    }
  }
  private async reconcile(): Promise<void> {
    const desired = this.desired
    if (desired.size < 2) {
      if (this.active) {
        for (const id of Object.keys(this.active.participants)) {
          this.o.send(Number(id), { type: 'voice_standby' })
        }
        this.retire(this.active, true)
        this.active = undefined
        this.arm()
        await this.persist()
      }
      return
    }
    if (this.now() < this.live.failureUntil) {
      return
    }
    if (this.cleanup.length > 0) {
      return
    }
    this.active ??= { id: ++this.live.next, meetingId: '', participants: {} }
    const generation = this.active
    if (!(await this.ensureBudget(generation))) {
      return
    }
    if (!generation.meetingId) {
      await this.persist()
      const meeting = await createVoiceMeeting(this.o.env, this.o.title())
      generation.meetingId = meeting
      if (this.active !== generation || this.desired.size < 2) {
        this.retire(generation, true)
        await this.persist()
        return
      }
      await this.persist()
    }
    await this.removeUnwanted(generation)
    if (this.cleanup.length > 0) {
      return
    }
    for (const id of [...this.desired]) {
      // allocation is serialized and generation-fenced per participant
      await this.add(generation, id)
    }
  }
  private async ensureBudget(generation: Generation): Promise<boolean> {
    const renewing = this.now() >= (generation.renewAt ?? 0)
    const reserved = new Set(renewing ? [] : (generation.reserved ?? []))
    const added = [...this.desired].filter((id) => !reserved.has(id))
    if (added.length === 0) {
      return true
    }
    this.budgetJob = generation
    this.arm()
    try {
      const granted = await (this.o.reserve?.(added.length) ??
        reserveVoiceBudget(this.o.env, added.length, this.now()))
      if (!granted) {
        throw new VoiceBudgetError(
          'Voice has reached the app’s free safety budget. It will reopen as older reservations expire.',
        )
      }
      if (this.active !== generation || this.desired.size < 2) {
        return false
      }
      generation.reserved = [...reserved, ...added]
      if (renewing) {
        generation.leaseUntil = this.now() + VOICE_LEASE_MS
        generation.renewAt = this.now() + VOICE_RENEW_MS
      }
      await this.persist()
      if ([...this.desired].some((id) => !generation.reserved?.includes(id))) {
        this.live.dirty = true
        return false
      }
      return this.active === generation
    } finally {
      if (this.budgetJob === generation) {
        this.budgetJob = undefined
      }
      this.arm()
    }
  }

  private async removeUnwanted(generation: Generation): Promise<void> {
    let changed = false
    for (const [id, participant] of Object.entries(generation.participants)) {
      if (!this.desired.has(Number(id))) {
        delete generation.participants[id]
        this.retire(generation, false, [participant])
        this.o.send(Number(id), { type: 'voice_standby' })
        changed = true
      }
    }
    if (changed) {
      await this.persist()
    }
  }
  private async add(generation: Generation, id: number): Promise<void> {
    if (this.active !== generation || !this.desired.has(id) || generation.participants[id]) {
      return
    }
    if (!generation.reserved?.includes(id)) {
      this.live.dirty = true
      return
    }
    const peer = this.o.peers().find((value) => value.id === id)
    if (!peer) {
      return
    }
    const participant = await addVoiceParticipant(
      this.o.env,
      generation.meetingId,
      peer.name,
      String(id),
    )
    if (this.active !== generation || !this.desired.has(id)) {
      this.retire(generation, this.active !== generation, [participant.id])
      await this.persist()
      return
    }
    generation.participants[id] = participant.id
    await this.persist()
    if (this.active === generation && this.desired.has(id)) {
      this.o.send(id, {
        type: 'voice_ready',
        generation: generation.id,
        meetingId: generation.meetingId,
        token: participant.token,
      })
    }
  }

  /** Called by a cold DO alarm too: requires only voice metadata, never a game world. */
  async retry(): Promise<void> {
    if (this.live.cleaning) {
      return
    }
    this.live.cleaning = true
    try {
      for (const entry of [...this.cleanup]) {
        if (entry.retryAt > this.now()) {
          continue
        }
        // persist each independent cleanup generation before continuing
        await this.clean(entry)
      }
    } finally {
      this.live.cleaning = false
    }
  }
  private async clean(entry: VoiceCleanup): Promise<void> {
    const complete = await cleanVoiceEntry({
      env: this.o.env,
      entry,
      activeMeeting: () => this.active?.meetingId,
      now: () => this.now(),
      persist: () => this.persist(),
    })
    if (complete) {
      this.cleanup = this.cleanup.filter((value) => value !== entry)
    }
    await this.persist()
  }
}
