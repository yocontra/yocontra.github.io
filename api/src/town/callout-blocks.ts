import type { LobbyCore } from './core.ts'

export interface JoinBlocks {
  accounts: readonly string[]
  current: () => boolean
}

interface CalloutBlockReads {
  core: () => LobbyCore | null
  readAccount: (accountId: string) => Promise<readonly string[]>
  readPair: (accountA: string, accountB: string) => Promise<boolean>
}

export class CalloutBlocks {
  private readonly reads: CalloutBlockReads
  private revision = 0
  private updates = Promise.resolve()

  constructor(reads: CalloutBlockReads) {
    this.reads = reads
  }

  async readJoin(accountId: string): Promise<JoinBlocks> {
    const revision = this.revision
    const accounts = await this.reads.readAccount(accountId)
    return { accounts, current: () => revision === this.revision }
  }

  refresh(accountA: string, accountB: string): Promise<void> {
    // Read inside the queue so delayed notifications cannot apply an older write over a newer one.
    const update = this.updates.then(async () => {
      const core = this.reads.core()
      if (core) {
        const blocked = await this.reads.readPair(accountA, accountB)
        if (this.reads.core() === core) {
          core.setCalloutBlocked(accountA, accountB, blocked)
          this.revision++
        }
      }
    })
    this.updates = update.catch(() => undefined)
    return update
  }
}
