import { DurableSeats } from '../../../packages/durable-game-runtime/src/seats.ts'
import type { NativeJoinProfile } from './room.ts'

export interface NativeSeat {
  lobbyId: string
  profile: NativeJoinProfile
  protocol: number
}

export class NativeSeats extends DurableSeats<NativeSeat> {
  constructor(storage: DurableObjectStorage) {
    super(storage, { name: 'frontier', processId: 'native', clients: 0, maxClients: 32 })
  }
}
