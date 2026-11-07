import { expect, it } from 'bun:test'
import { LobbyCore, type Peer } from '../api/src/town/core.ts'
import type { ServerControl } from '../src/experiments/out-west/contract/town.ts'
import { DEFAULT_LOADOUT } from '../src/experiments/out-west/data/catalog.ts'
import { lookFor } from '../src/experiments/out-west/ffa/scene/looks.ts'
import { loadoutOpts } from '../src/experiments/out-west/scene/loadout.ts'

class AppearancePeer implements Peer {
  closed = false
  readonly messages: ServerControl[] = []
  send(data: Uint8Array | string): void {
    if (typeof data === 'string') {
      this.messages.push(JSON.parse(data) as ServerControl)
    }
  }
  close(): void {
    this.closed = true
  }
}

it('carries every equipped item through real welcome and roster-add JSON into the shared appearance resolver', () => {
  const core = new LobbyCore('appearance-test', 7)
  const observer = new AppearancePeer()
  core.join(
    {
      accountId: 'observer',
      name: 'Observer',
      level: 50,
      prestige: 0,
      loadout: [],
      banked: 0,
      tcpRtt: null,
    },
    observer,
    0,
  )
  for (const extra of ['extra.red-bandana', 'extra.tin-star', 'extra.handlebar'] as const) {
    const slots = {
      ...DEFAULT_LOADOUT,
      hat: 'hat.bronze-band',
      gun: 'gun.hardins-pair',
      outfit: 'outfit.undertakers-black',
      spurs: 'spurs.star-rowels',
      holster: 'holster.silver-conchos',
      extra,
    } as const
    const equipped = Object.values(slots)
    const peer = new AppearancePeer()
    const session = core.join(
      {
        accountId: extra,
        name: extra,
        level: 50,
        prestige: 0,
        loadout: equipped,
        banked: 0,
        tcpRtt: null,
      },
      peer,
      0,
    )
    const welcome = peer.messages.find((message) => message.type === 'welcome')
    if (welcome?.type !== 'welcome') {
      throw new Error('No welcome')
    }
    const entry = welcome.roster.find((rider) => rider.id === session?.playerId)
    if (!entry) {
      throw new Error('No own appearance')
    }
    const added = observer.messages.find(
      (message) => message.type === 'roster_add' && message.entry.id === entry.id,
    )
    expect(added).toMatchObject({ type: 'roster_add', entry: { loadout: equipped } })
    expect(entry.loadout).toEqual(equipped)
    const look = lookFor(entry.loadout, entry.id)
    const catalog = loadoutOpts(slots)
    if (catalog.hatColor === undefined) {
      throw new Error('Catalog hat has no colour')
    }
    expect(look.hatColor).toBe(catalog.hatColor)
    expect(look.hatDetail).toBe('bronze')
    expect(look.look.coat).toBe(catalog.coat)
    expect(look.look.bandana).toBe(catalog.bandana)
    expect(look.look.star).toBe(catalog.star)
    expect(look.look.catalogMoustache).toBe(catalog.moustache)
    expect(look.look.holster).toEqual(catalog.holster)
    expect(look.spurs).toBe(slots.spurs)
    expect(look.gun).toBe(slots.gun)
    expect(look.look.offGun).toBe(true)
  }
})
