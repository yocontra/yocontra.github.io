/** Types shared by the room flow and its host. */
import type {
  DuelResult,
  MatchOutcome,
  RoomServerMessage,
  Settlement,
} from '../../../src/experiments/out-west/contract/duel.ts'
import type { Pair, PvpLink, Seat } from './judge-pvp.ts'
import type { AiOpponent, Rng } from './opponents.ts'
import type { Clock, WaitStats } from './standoff.ts'

/** What the room asks of its host. */
export interface RoomIo {
  send: (seat: Seat, message: RoomServerMessage) => void
  /** RTT stats for a human seat. */
  link: (seat: Seat) => PvpLink
  /** Commit the result. Resolves with each seat's settlement (null for an AI seat or a failure). */
  settle: (result: FinishedDuel) => Promise<Pair<Settlement | null>>
  /** The room has nothing timed until `deadline` (the rematch window): the host may hibernate. */
  idle: (deadline: number) => void
  /** The room is finished. */
  close: (reason: 'done' | 'opponent-left' | 'timeout') => void
  /** The dodged seat should go to the front of the queue. */
  requeue?: (seat: Seat) => void
  /** A duel (re)starts: the host sends `hello`. */
  started?: (rematch: number) => void
}

export interface FinishedDuel {
  rematch: number
  outcome: MatchOutcome
  winner: Seat | null
  culprit: Seat | null
  reactions: Pair<number | null>
  deadHeats: number
  wait: WaitStats | null
  startedAt: number
  endedAt: number
}

export interface RoomFlowOptions {
  /** The room id, echoed in results. */
  matchId?: string
  /** A factory for the AI seat's brain (seat 1 in a ghost duel), or null for two humans. */
  ai: (() => AiOpponent) | null
  io: RoomIo
  clock: Clock
  rng?: Rng
}

/** The bit of state that survives hibernation during the rematch window. */
export interface RestState {
  rematch: number
  votes: [boolean, boolean]
  deadline: number
  last: DuelResult | null
}
