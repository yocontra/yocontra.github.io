/**
 * The Daily Outlaw on the street (meta-game stream): one server-judged duel against the day's
 * outlaw, with its modifiers (fog, two fake-outs, no bell), then back to the saloon.
 *
 * It rides the ranked machinery: the DailySession speaks the ranked protocol, so the duel runs on
 * a `RankedDuelClock` and the director plays it like any ranked standoff. Through
 * `Director.hooks` it stops the gauntlet from moving on: no next outlaw, no retry (a retry is a
 * new ticket). Your gauntlet save is set aside for the duel and put back after, untouched.
 */
import { assertNever } from '../contract/assertNever.ts'
import type { DailySpec } from '../data/daily.ts'
import { FEEL } from '../data/feel.ts'
import type { Press } from '../engine/input.ts'
import { reportDuel } from '../meta/events.ts'
import type { RankedSession } from '../net/ranked.ts'
import { emptyRun, save as persist, type SaveData } from '../save.ts'
import { confirmSheet } from '../ui/sheet.ts'
import { LocalDuelClock, type Verdict } from './clock.ts'
import type { Director, DirectorHooks } from './director.ts'
import { emptyStreet } from './mode.ts'
import { startAmbience } from './present.ts'
import { RankedDuelClock } from './ranked-clock.ts'
import type { Phase } from './state.ts'

export interface DailyOpts {
  spec: DailySpec
  session: RankedSession
  /**
   * Back at the saloon: the server's verdict, or null if the duel never finished. `drewMs` is
   * your press as this device timed it, when the server's verdict came before your shot reached it
   * (a late press: the sheet says "too slow", not "you didn't draw").
   */
  onExit: (v: Verdict | null, drewMs: number | null) => void
}

/** Fog thickening on a fog day (0..1, `World.windyFog`). */
const FOG = 0.85
/** Presses this soon after a result is shown are the draw's follow-through, not "leave". */
const PRESS_GRACE_S = 0.8
/** The server's verdict can trail the client's own card (a back-shot is judged at its call). */
const VERDICT_WAIT_S = 8

export class DailyDuel implements DirectorHooks {
  private readonly d: Director
  private readonly o: DailyOpts
  private readonly realSave: SaveData
  private verdict = null as Verdict | null
  private over = false as boolean
  private asking = false as boolean

  constructor(d: Director, o: DailyOpts) {
    this.d = d
    this.o = o
    this.realSave = d.c.save
    const scratch = structuredClone(d.c.save)
    scratch.settings = d.c.save.settings
    scratch.legend = false
    scratch.run = emptyRun()
    scratch.attempts = {}
    scratch.best = {}
    d.c.save = scratch
    d.clock.dispose()
    d.clock = new RankedDuelClock(o.session, {
      ...d.events,
      verdict: (v) => this.onVerdict(v),
      dropped: (reason) => this.onDropped(reason),
    })
    d.hooks = this
    d.duelId = -1
    d.standoffSent = false
    d.c.hud.show(true)
    d.c.hud.setMode('DAILY OUTLAW')
    d.c.hud.setPurse(0, false)
    startAmbience(d)
    d.startLevel(o.spec.outlaw, false)
    d.c.hud.setDaily(true)
    this.dress()
  }

  private get spec(): DailySpec {
    return this.o.spec
  }

  /** The day's modifiers, set after `startLevel` (it resets them) and before the standoff. */
  private dress(): void {
    const d = this.d
    d.daily = true
    const noBell = this.spec.modifiers.includes('no-bell')
    d.callPresentation = { bell: !noBell, text: !noBell }
  }

  private onVerdict(v: Verdict): void {
    const d = this.d
    if (!this.verdict) {
      this.verdict = v
      // the duel report skips hooked duels, so the daily reports its own
      reportDuel({
        level: d.level,
        legend: false,
        ranked: true,
        outcome: v.outcome,
        reactionMs: v.outcome === 'coward' ? null : v.reactionMs,
        touch: d.c.input.touch,
        secondChance: d.secondChance,
        hatShot: d.hatShot,
        fakesSeen: d.fakesSeen,
        firstTry: true,
        daily: true,
      })
    }
    d.events.verdict(v)
  }

  private onDropped(reason: string): void {
    if (this.verdict || this.over) {
      // the server closes the line once the duel is recorded
      return
    }
    this.d.c.hud.fake(`[${reason} That try didn’t count.]`, 3000)
    this.leave()
  }

  tick(phase: Phase, _now: number, _dt: number): boolean {
    const d = this.d
    if (this.over) {
      return false
    }
    if (this.spec.modifiers.includes('fog') && phase !== 'poster' && phase !== 'intro') {
      d.c.world.windyFog(FOG)
    }
    if (phase === 'cock' && d.phaseT < 0.05) {
      // a retry path would reset these: keep the day's modifiers on
      this.dress()
    }
    const t = d.phaseT
    // leaving closes the socket, and a socket closed before the verdict voids the try
    if (!this.verdict && t < VERDICT_WAIT_S) {
      return phase === 'win' || phase === 'lose' || phase === 'coward'
        ? this.holdForVerdict(phase)
        : false
    }
    switch (phase) {
      case 'win':
        if (t >= FEEL.resultAt + FEEL.resultFor - 0.05) {
          this.leave()
          return true
        }
        return false
      case 'lose':
        if (t >= FEEL.loseAutoRetry - 0.05) {
          this.leave()
          return true
        }
        return false
      case 'coward':
        if (t >= FEEL.cowardAutoRetry - 0.05) {
          this.leave()
          return true
        }
        return false
      case 'title':
      case 'intro':
      case 'poster':
      case 'cock':
      case 'walk':
      case 'turn':
      case 'wait':
      case 'call':
      case 'bossClock':
      case 'bossWound':
      case 'end':
        return false
      default:
        assertNever(phase)
    }
  }

  /**
   * The client has shown its result but the server hasn't ruled: let the phase play out (its own
   * tick runs) except for the gauntlet's auto-retry and next outlaw, which the daily never takes.
   */
  private holdForVerdict(phase: Phase): boolean {
    const t = this.d.phaseT
    if (phase === 'win') {
      return t >= FEEL.resultAt + FEEL.resultFor - 0.05
    }
    return t >= (phase === 'lose' ? FEEL.loseAutoRetry : FEEL.cowardAutoRetry) - 0.05
  }

  press(p: Press): boolean {
    const d = this.d
    if (this.over) {
      return false
    }
    if (p.action === 'pause') {
      this.quit()
      return true
    }
    const after = d.phase === 'win' ? d.resultShown : d.phase === 'lose' || d.phase === 'coward'
    if (after && d.phaseT > PRESS_GRACE_S) {
      // not before the server's verdict (leaving would void the try); swallowed meanwhile
      if (this.verdict || d.phaseT >= VERDICT_WAIT_S) {
        this.leave()
      }
      return true
    }
    return false
  }

  /**
   * Pause in the daily: its clock is the server's, so pausing is leaving. Before the verdict that
   * spends the try, so ask first (a stray Escape shouldn't cost one of three).
   */
  private quit(): void {
    if (this.verdict || this.asking) {
      if (this.verdict) {
        this.leave()
      }
      return
    }
    this.asking = true
    confirmSheet(this.d.c.hud.root, {
      title: 'Leave this duel?',
      body: 'Leaving now uses up this try.',
      yes: 'Leave',
      no: 'Keep going',
      danger: true,
      focusNo: true,
    })
      .then((yes) => {
        this.asking = false
        if (yes) {
          this.leave()
        }
      })
      .catch(() => undefined)
  }

  /** Back to the saloon: the ranked clock closed, the gauntlet save restored. */
  leave(): void {
    if (this.over) {
      return
    }
    this.over = true
    const d = this.d
    const drewMs = d.lastReaction ?? d.lateMs
    d.hooks = null
    d.daily = false
    d.callPresentation = { bell: true, text: true }
    d.clock.dispose()
    d.clock = new LocalDuelClock(d.events)
    this.o.session.close()
    d.c.save = this.realSave
    persist(this.realSave)
    d.c.hud.setDaily(false)
    d.c.hud.setPurse(this.realSave.run.total, false)
    d.c.hud.setMode('PRACTICE · not ranked')
    d.duelId = -1
    d.standoffSent = false
    emptyStreet(d)
    this.o.onExit(this.verdict, drewMs)
  }
}
