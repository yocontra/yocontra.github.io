/** Exercise the production lobby settlement methods against the integration fixture's real D1. */
import { createProfileStatements } from '../src/economy/profile.ts'
import { type Departure, LobbyCore, type Session } from '../src/town/core.ts'
import { Lobby } from '../src/town/lobby.ts'
import { sessionStartStatement } from '../src/town/settle.ts'

export class SettlementProbe extends Lobby {
  override async fetch(request: Request) {
    if (new URL(request.url).pathname === '/__test/restart-settlement') {
      this.ctx.abort('Expected settlement recovery probe restart')
    }
    if (new URL(request.url).pathname === '/__test/orphan-socket') {
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    const accountId = crypto.randomUUID()
    await this.env.DB.prepare('INSERT INTO accounts(id,name,name_key,created_at) VALUES(?,?,?,?)')
      .bind(accountId, 'Settlement probe', accountId, Date.now())
      .run()
    await this.env.DB.batch(createProfileStatements(this.env, accountId))
    const core = new LobbyCore('lobby:999', 7)
    const session = core.join(
      {
        accountId,
        name: 'Settlement probe',
        level: 1,
        prestige: 0,
        loadout: [],
        banked: 0,
        tcpRtt: null,
      },
      { send: () => undefined, close: () => undefined },
      Date.now(),
    )
    const player = session && core.world.players[session.playerId]
    if (!(session && player)) {
      throw new Error('Missing probe player')
    }
    Reflect.set(this, 'core', core)
    Reflect.set(this, 'lobbyId', core.lobbyId)
    await sessionStartStatement(this.env, core.lobbyId, session).run()
    const flush: (dep: Departure, at: number | null) => Promise<void> = Reflect.get(
      this,
      'flushXp',
    ).bind(this)
    const reopen: (core: LobbyCore, session: Session) => Promise<void> = Reflect.get(
      this,
      'onNativeJoin',
    ).bind(this)
    const departure = { session, player }
    player.stats.xp = 30
    await Promise.all([flush(departure, null), flush(departure, null)])
    const concurrentFlushed = session.xpFlushed
    player.stats.xp = 45
    await flush(departure, null)
    const earned = await this.env.DB.prepare('SELECT xp FROM profiles WHERE account_id=?')
      .bind(accountId)
      .first<number>('xp')
    const actualEnv = this.env
    let loseAcknowledgement = true
    const faultDb = new Proxy(actualEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements)
            if (loseAcknowledgement) {
              loseAcknowledgement = false
              throw new Error('Expected lost acknowledgement after real D1 commit')
            }
            return result
          }
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    Reflect.set(this, 'env', { ...actualEnv, DB: faultDb })
    player.stats.xp = 50
    await flush(departure, null)
    player.stats.xp = 55
    await flush(departure, null)
    Reflect.set(this, 'env', actualEnv)
    const ambiguousEarned = await actualEnv.DB.prepare('SELECT xp FROM profiles WHERE account_id=?')
      .bind(accountId)
      .first<number>('xp')
    player.stats.xp = 60
    await this.env.DB.prepare(
      `CREATE TRIGGER reject_probe_xp BEFORE INSERT ON ledger WHEN NEW.kind='ffa_kill_mint'
       BEGIN SELECT RAISE(ABORT,'expected probe failure'); END`,
    ).run()
    await flush(departure, null)
    const failedFlushed = session.xpFlushed
    await this.env.DB.prepare('DROP TRIGGER reject_probe_xp').run()
    await flush(departure, null)
    player.stats.xp = 75
    await Promise.all([flush(departure, Date.now()), reopen(core, session)])
    const visit = await this.env.DB.prepare('SELECT left_at FROM ffa_sessions WHERE id=?')
      .bind(session.sessionId)
      .first<{ left_at: number | null }>()
    const recovered = await this.env.DB.prepare('SELECT xp FROM profiles WHERE account_id=?')
      .bind(accountId)
      .first<number>('xp')
    const pendingDeposit = {
      sessionId: session.sessionId,
      playerId: session.playerId,
      accountId,
      seq: 2,
      amount: 7,
      commission: 0,
      xp: 1,
      bot: false,
    }
    const handle: (output: {
      deposits: (typeof pendingDeposit)[]
      departures: Departure[]
    }) => void = Reflect.get(this, 'handle').bind(this)
    handle({ deposits: [pendingDeposit], departures: [] })
    const immediateAlarm = await this.ctx.storage.getAlarm()
    if (immediateAlarm === null) {
      throw new Error('Recorded deposit has no autonomous recovery alarm')
    }
    handle({ deposits: [{ ...pendingDeposit, amount: 999 }], departures: [] })
    const pendingSql = [
      ...this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM pending_deposits'),
    ]
    if (pendingSql.length !== 1 || JSON.parse(pendingSql[0]?.data ?? '{}').amount !== 7) {
      throw new Error('Pending economic intent was not synchronously immutable')
    }
    await this.ctx.storage.put(`dep:recovery:${session.sessionId}`, {
      sessionId: session.sessionId,
      lobbyId: core.lobbyId,
      playerId: session.playerId,
      accountId,
      seq: 1,
      amount: 10,
      commission: 2,
      xp: 3,
      bot: false,
    })
    await this.env.DB.prepare(
      `CREATE TRIGGER reject_pending_deposit BEFORE INSERT ON ledger WHEN NEW.kind='ffa_deposit'
       BEGIN SELECT RAISE(ABORT,'expected pending settlement failure'); END`,
    ).run()
    return Response.json({
      concurrentFlushed,
      earned,
      ambiguousEarned,
      failedFlushed,
      recovered,
      leftAt: visit?.left_at,
      accountId,
      visitId: session.sessionId,
      pendingSql: pendingSql.length,
      immediateAlarm: immediateAlarm !== null,
    })
  }
}
