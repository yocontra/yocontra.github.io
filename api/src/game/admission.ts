import { AdmissionLeases as DurableRoomAdmission } from '../../../packages/durable-game-runtime/src/admission.ts'
import { CEILINGS } from '../budget.ts'

export class NativeBudgetRefusal extends Error {}

export class AdmissionLeases extends DurableRoomAdmission {
  constructor(storage: DurableObjectStorage) {
    super(storage, {
      dailyActiveSeconds: CEILINGS.lobby_seconds,
      dailyWebSocketMessages: CEILINGS.ws_messages,
      leaseSeconds: 60,
      maxMessagesPerSecond: 32 * 20,
      renewAfterTicks: 600,
    })
  }
}
