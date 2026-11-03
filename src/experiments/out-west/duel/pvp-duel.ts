/**
 * Bounty Hunt: a duel against another gunslinger (or a labelled ghost), driven entirely by the
 * DuelRoom. The room owns every beat: the walk only advances while both men hold, the server sends
 * the fake-out cues and the call, and judges both shots. This module turns room messages into the
 * director's existing moments (walk, standoff, call, kill cam, death, back-shot) through one seam,
 * `Director.hooks`, and puts the match intro and results screens around them.
 *
 * The gauntlet's save is never touched: the duel runs on a scratch copy, restored on the way out.
 */
import type { Beat, DuelResult, Poster, RoomServerMessage, Seat } from '../contract/duel.ts'
import { FEEL } from '../data/feel.ts'
import type { Press } from '../engine/input.ts'
import { fetchDuelStats } from '../net/api.ts'
import { DuelRoomLink } from '../net/pvp.ts'
import { haptic } from '../platform/haptics.ts'
import type { SaveData } from '../save.ts'
import { DRAW_SOUNDS } from '../scene/loadout.ts'
import { MatchIntro } from '../ui/match-intro.ts'
import { type OpponentRef, ResultsPanel, RoomNews } from '../ui/results.ts'
import { recordLine } from '../ui/standing.ts'
import { tickCoward } from './defeat.ts'
import type { Director, DirectorHooks } from './director.ts'
import { tickWin } from './outcome.ts'
import { startAmbience } from './present.ts'
import { watchAway } from './pvp-away.ts'
import { clearStreet, confirmFlee, endView, lostResult, quietEndFx } from './pvp-end.ts'
import { RemoteDuelClock } from './remote.ts'
import {
  asOutlaw,
  deadHeatFx,
  enterRemoteTurn,
  HECKLES,
  type HoldState,
  honestWin,
  opponentActor,
  remotePace,
  reviveForSuddenDeath,
  TAUNT_TEXT,
  tickRemoteWalk,
} from './remote-beats.ts'
import type { Phase } from './state.ts'
import { enterWalk } from './walk.ts'

export type PvpExit = 'saloon' | 'next'

/** From a win over a ghost to its vanishing, ms. */
const GHOST_VANISH_MS = 900

export interface PvpOpts {
  wsUrl: string
  opponent: Poster
  /** Your XP before the match (the results bar), when signed-in data is at hand. */
  xpBefore: number | null
  /** Your purse going in (the HUD), when known. */
  purse: number | null
  /** Refetch your profile after settlement (for the XP bar and level-ups). */
  refreshXp: () => Promise<number | null>
  onExit: (how: PvpExit) => void
}

/** One Bounty Hunt match: hello → duel(s) → results → rematch or leave. */
export class PvpDuel implements DirectorHooks {
  private readonly d: Director
  private readonly o: PvpOpts
  private readonly link: DuelRoomLink
  private readonly clock: RemoteDuelClock
  private readonly realSave: SaveData
  private seat: Seat = 0
  private posters: readonly [Poster, Poster] | null = null
  private serverOffset = 0
  private intro: MatchIntro | null = null
  private results: ResultsPanel | null = null
  private result: DuelResult | null = null
  /** perf time when the results sheet may open (after the kill cam or the fall). */
  private resultsAt = 0
  private deadHeat = false as boolean
  private readonly hold: HoldState = { mine: false, theirs: false, sent: false, autoUntil: 0 }
  private over = false as boolean
  private fleeing = false as boolean
  private xpAfter = null as number | null
  /** XP going into the current duel: the match's start, then each rematch's (not summed). */
  private xpBefore = null as number | null
  /** Why the room went away before it sent a result (we can't know the outcome). */
  private lostLine = null as string | null
  /** The next wait's draw number is already known (from `suddenDeath` or `sync`). */
  private drawKnown = false as boolean
  private readonly news = new RoomNews()
  /** The rematch number of the last hello: a rejoin repeats it, a rematch moves it on. */
  private rematchN = -1
  /** The verdict arrived in a rejoin's sync (no money lines for us in it). */
  private synced = false as boolean
  /** His line dropped and he hasn't come back yet. */
  private oppDropped = false as boolean
  private readonly unwatch: () => void

  constructor(d: Director, o: PvpOpts) {
    this.d = d
    this.o = o
    this.realSave = d.c.save
    this.xpBefore = o.xpBefore
    const scratch = structuredClone(d.c.save)
    scratch.settings = d.c.save.settings
    scratch.legend = false
    d.c.save = scratch
    this.link = new DuelRoomLink(o.wsUrl, {
      message: (m) => this.onMessage(m),
      dropped: () => d.c.hud.fake('[connection dropped · reconnecting]', 3000),
      rejoined: () => {
        // the room forgot our hold when the line dropped: say it again on the next frame
        this.hold.sent = false
        d.c.hud.fake('[reconnected]', 1500)
      },
      gone: (reason) => this.onGone(reason),
    })
    this.clock = new RemoteDuelClock(this.link)
    d.clock.dispose()
    d.clock = this.clock
    d.hooks = this
    d.outlaw = asOutlaw(o.opponent)
    // the hair cuts an opponent's face may borrow, fetched while the match is found
    for (const donor of ['worker', 'king'] as const) {
      d.c.assets.body(donor).catch(() => undefined)
    }
    d.level = 0
    d.c.hud.root.classList.add('ow-pvp')
    d.c.hud.show(true)
    d.c.hud.setMode(o.opponent.kind === 'human' ? 'BOUNTY HUNT' : 'GHOST DUEL')
    d.c.hud.setPurse(o.purse ?? 0, false)
    startAmbience(d)
    this.unwatch = watchAway(d, this.link, () => !this.over && this.result === null)
  }

  private get opp(): Seat {
    return this.seat === 0 ? 1 : 0
  }

  // ------------------------------------------------------------------ hooks

  tick(phase: Phase, _now: number, dt: number): boolean {
    const d = this.d
    switch (phase) {
      case 'cock':
        return true
      case 'walk':
        tickRemoteWalk(d, dt, this.hold, (down) => this.link.send({ type: 'hold', down }))
        return true
      case 'turn':
        if (d.phaseT >= FEEL.turnDuration && d.phaseT - dt < FEEL.turnDuration) {
          d.player.play('Idle', 0.25)
          d.enemy?.play('Idle', 0.25)
        }
        return true
      case 'win':
        // the kill cam, without the gauntlet's card or its move to the next outlaw
        d.resultShown = true
        if (d.phaseT < FEEL.resultAt + FEEL.resultFor - 0.1) {
          tickWin(d, dt)
        }
        this.maybeResults()
        return true
      case 'coward':
        // the slow-mo and the gasp, without the gauntlet's card (the results sheet says it)
        d.cowardCard = true
        if (d.phaseT < FEEL.cowardAutoRetry - 0.1) {
          tickCoward(d)
        }
        this.maybeResults()
        return true
      case 'lose':
        // the fall, without the gauntlet's "press to try again" card
        d.c.hud.hideCard()
        this.maybeResults()
        return true
      case 'bossWound':
      case 'end':
      case 'poster':
      case 'intro':
        this.maybeResults()
        return true
      default:
        return false
    }
  }

  press(p: Press): boolean {
    const d = this.d
    if (p.action === 'pause') {
      this.flee().catch(() => undefined)
      return true
    }
    if (
      d.phase === 'call' &&
      d.shotsSent === 0 &&
      (p.action === 'fire' || p.source === 'pointer')
    ) {
      haptic('shot')
      this.drawSound()
    }
    // walking, a back-shot and the draw behave as ever; everything else waits on the room
    return !['walk', 'turn', 'wait', 'call'].includes(d.phase)
  }

  /** Your draw sound, layered on the report (on the shot, never before). */
  private drawSound(): void {
    const mine = this.posters?.[this.seat]
    const s = mine ? DRAW_SOUNDS[String(mine.loadout.drawSound) as keyof typeof DRAW_SOUNDS] : null
    if (!s) {
      return
    }
    const a = this.d.c.audio
    a.play('fireBig', { gain: s.gain, rate: s.rate, reverb: 0.8 })
    if (s.hawk) {
      a.play('hawk', { gain: 0.5, when: a.now + 0.35 })
    }
  }

  // --------------------------------------------------------------- messages

  private onMessage(m: RoomServerMessage): void {
    if (this.over) {
      return
    }
    if ('serverTime' in m) {
      this.serverOffset = m.serverTime - Date.now()
    }
    switch (m.type) {
      case 'hello':
        this.onHello(m.you, m.posters, m.rematch)
        break
      case 'sync':
        this.onSync(m)
        break
      case 'beat':
        this.onBeat(m.beat, m.deadline)
        break
      case 'ready':
        if (m.seat === this.opp) {
          this.intro?.say('He’s cocked and waiting.')
        }
        break
      case 'holding':
        this.hold.theirs = m.holding[this.opp]
        break
      case 'pace':
        remotePace(this.d, m.n, m.auto, this.hold)
        break
      case 'heckle':
        this.d.c.hud.line(
          this.d.outlaw.name,
          HECKLES[Math.floor(Math.random() * HECKLES.length)] ?? '',
        )
        break
      case 'cue':
        this.adoptDraw(m.draw)
        this.d.events.cue(m.draw, m.cue)
        break
      case 'call':
        this.adoptDraw(m.draw)
        this.clock.call(m.draw, m.inMs, (draw) => this.d.events.call(draw))
        break
      default:
        this.onOther(m)
        break
    }
  }

  private onOther(m: RoomServerMessage): void {
    const d = this.d
    switch (m.type) {
      case 'deadHeat':
        this.deadHeat = true
        deadHeatFx(d)
        break
      case 'suddenDeath':
        this.deadHeat = false
        this.drawKnown = true
        this.clock.draw = m.draw
        reviveForSuddenDeath(d, this.posters?.[this.opp])
        break
      case 'result':
        this.onResult(m)
        break
      case 'presence':
        // his first connect is a presence too: only a return after a drop is news
        if (m.seat === this.opp && (!m.connected || this.oppDropped)) {
          this.oppDropped = !m.connected
          d.c.hud.fake(m.connected ? '[he’s back]' : '[his line dropped · 5 s grace]', 3000)
        }
        break
      case 'taunt':
        if (m.seat === this.opp) {
          d.c.hud.line(d.outlaw.name, TAUNT_TEXT[m.taunt] ?? '', 1800)
        }
        break
      case 'rematch':
        this.news.vote(m, this.seat)
        break
      case 'error':
        if (m.fatal) {
          this.onGone(m.message)
        }
        break
      default:
        break
    }
  }

  private onHello(you: Seat, posters: readonly [Poster, Poster], rematch: number): void {
    const d = this.d
    this.seat = you
    const rejoin = this.posters !== null && rematch === this.rematchN
    this.posters = posters
    this.rematchN = rematch
    if (rejoin) {
      // back after a drop: the duel goes on where the room says (its sync follows)
      return
    }
    const them = posters[this.opp]
    d.outlaw = asOutlaw(them)
    if (rematch > 0 && this.xpAfter !== null) {
      // a rematch starts from the last settlement's XP, so its level-up isn't counted twice
      this.xpBefore = this.xpAfter
    }
    this.xpAfter = null
    this.result = null
    this.news.reset()
    this.synced = false
    this.results?.close()
    this.results = null
    this.stage(them)
    if (rematch === 0) {
      this.intro?.close()
      this.intro = new MatchIntro(d.c.hud.root, posters[you], them, {
        ready: () => this.link.send({ type: 'ready' }),
        flee: () => {
          this.flee().catch(() => undefined)
        },
      })
    } else {
      // a rematch: no intro, straight back to the street (ready on your behalf)
      this.link.send({ type: 'ready' })
    }
  }

  /** Both men on the street, dressed in their own kit. */
  private stage(them: Poster): void {
    const d = this.d
    const c = d.c
    d.enemy?.dispose()
    d.enemy = opponentActor(d, them)
    c.scene.add(d.enemy.root)
    d.enemyAlive = true
    d.dying = null
    d.fallers = []
    d.timeScale = 1
    c.physics.clear()
    c.hud.hideCard()
    c.hud.clearCaptions()
    c.hud.clearCall()
    c.hud.letterbox(false)
    c.world.setFires(false)
    c.world.apply(d.outlaw.day)
    c.world.setClock(17, 0)
    // the street's wanted-poster post carries the gauntlet's outlaw: not his, so it comes down
    c.world.poster.visible = false
    c.audio.playSong('intro')
    d.enterCock()
  }

  private onBeat(beat: Beat, deadline: number | null): void {
    const d = this.d
    switch (beat) {
      case 'cock':
        if (this.intro && !this.intro.readySent) {
          this.intro.cock(deadline, this.serverOffset)
        }
        break
      case 'walk':
        this.intro?.close()
        this.intro = null
        if (d.phase === 'cock') {
          this.hold.sent = false
          this.hold.mine = false
          d.c.hud.show(true)
          enterWalk(d)
        }
        break
      case 'turn':
        if (d.phase === 'walk') {
          enterRemoteTurn(d)
        }
        break
      case 'wait':
        // The room numbers every wait: +1 here, or the number `suddenDeath` just brought. The
        // standoff (and any early shot) must carry it, or the room ignores the shot as stale.
        if (!this.drawKnown) {
          this.clock.draw += 1
        }
        this.drawKnown = false
        if (d.phase === 'turn' || d.phase === 'walk') {
          d.player.play('Idle', 0.2)
          d.enemy?.play('Idle', 0.2)
          d.enterWait(false)
        }
        break
      default:
        break
    }
  }

  /** The room's draw number wins: a cue or the call for this wait must reach the standoff. */
  private adoptDraw(draw: number): void {
    this.clock.draw = draw
    if (this.d.phase === 'wait' && this.d.duelId !== draw) {
      this.d.duelId = draw
    }
  }

  private onSync(m: Extract<RoomServerMessage, { type: 'sync' }>): void {
    this.hold.theirs = m.holding[this.opp]
    this.clock.draw = m.draw
    if (m.last && !this.result && (m.beat === 'result' || m.beat === 'rematch')) {
      this.synced = true
      this.onResult(m.last)
      return
    }
    if (!this.result) {
      // catch up after a rejoin: the beat may have moved on while we were away
      this.drawKnown = true
      this.onBeat(m.beat, m.deadline)
      this.drawKnown = false
    }
  }

  // ---------------------------------------------------------------- results

  private onResult(r: DuelResult): void {
    const d = this.d
    this.result = r
    this.deadHeat = false
    const me = this.seat
    const paid = { payout: r.you?.delta ?? 0, purse: r.you?.purse ?? 0 }
    const verdict = {
      duel: r.draw,
      reactionMs: r.reactions[me],
      enemyMs: r.reactions[this.opp],
      payout: paid.payout,
      purse: paid.purse,
      targetsHit: 0,
    }
    this.resultsAt = performance.now() + 2200
    if (r.winner === me && this.posters?.[this.opp]?.kind === 'ghost') {
      // the ghost is beaten: it goes back to the dust as he falls (after the call's hush lifts)
      setTimeout(() => d.c.audio.ui('ghostVanish'), GHOST_VANISH_MS)
    }
    if (r.outcome === 'win' && r.winner === me) {
      d.events.verdict({ ...verdict, outcome: 'win', targetsHit: 1 })
    } else if (r.outcome === 'win') {
      haptic('hit')
      d.events.verdict({ ...verdict, outcome: 'loss' })
    } else if (r.outcome === 'coward' && r.culprit === me) {
      d.events.verdict({ ...verdict, outcome: 'coward' })
    } else if (r.outcome === 'coward') {
      honestWin(d, 'HE DREW EARLY. BOUNTY’S YOURS.')
    } else {
      this.quietEnd(r)
    }
    // after the verdict: the director's own purse display reads the scratch run
    if (r.you?.purse !== null && r.you?.purse !== undefined) {
      d.c.hud.setPurse(r.you.purse, true)
    }
    this.o
      .refreshXp()
      .then((xp) => {
        this.xpAfter = xp
        this.results?.setXp(this.xpBefore, xp)
      })
      .catch(() => undefined)
  }

  /** Forfeits, dodges, freezes and double dead heats: no kill cam, straight to the card. */
  private quietEnd(r: DuelResult): void {
    quietEndFx(this.d, r, this.seat, this.lostLine !== null)
    this.resultsAt = performance.now() + 1200
  }

  private maybeResults(): void {
    if (!this.result || this.results || performance.now() < this.resultsAt || this.deadHeat) {
      return
    }
    this.d.c.hud.hideCard()
    this.results = new ResultsPanel(
      this.d.c.hud.root,
      endView(this.result, this.seat, {
        name: this.d.outlaw.name,
        xp: { before: this.xpBefore, after: this.xpAfter },
        lost: this.lostLine,
        synced: this.synced,
      }),
      {
        rematch: () => this.link.send({ type: 'rematch' }),
        next: () => this.leave('next'),
        saloon: () => this.leave('saloon'),
      },
      this.opponentRef(),
    )
    this.news.attach(this.results, this.seat)
    fetchDuelStats()
      .then((s) => {
        if (s.ok) {
          this.results?.setRecord(`Record ${recordLine(s.value)}`)
        }
      })
      .catch(() => undefined)
  }

  /** Who to show a poster for, or report, from the results sheet (never a Town Outlaw). */
  private opponentRef(): OpponentRef | null {
    const them = this.posters?.[this.opp]
    if (!them || them.kind === 'outlaw') {
      return null
    }
    return { name: them.name, kind: them.kind, context: this.result?.matchId ?? '' }
  }

  // --------------------------------------------------------------- leaving

  private async flee(): Promise<void> {
    if (this.fleeing || this.over) {
      return
    }
    if (this.result) {
      this.leave('saloon')
      return
    }
    this.fleeing = true
    const yes = await confirmFlee(this.d)
    this.fleeing = false
    if (yes && !this.over) {
      this.link.send({ type: 'flee' })
    }
  }

  private onGone(reason: string): void {
    if (this.over) {
      return
    }
    if (this.result) {
      this.news.close(reason)
      return
    }
    this.d.c.hud.fake(`[${reason}]`, 3000)
    this.lostLine = reason
    this.result = lostResult(this.clock.draw)
    this.quietEnd(this.result)
  }

  /** Back to the saloon (or straight back into the queue). */
  leave(how: PvpExit): void {
    if (this.over) {
      return
    }
    this.over = true
    this.unwatch()
    const d = this.d
    this.link.send({ type: 'flee' })
    this.link.close()
    this.intro?.close()
    this.results?.close()
    clearStreet(d, this.realSave)
    this.o.onExit(how)
  }
}
