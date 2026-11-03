import type { Peer } from './core.ts'

/** A hibernatable WebSocket as a {@link Peer}: sends and closes never throw. */
export class SocketPeer implements Peer {
  private readonly ws: WebSocket
  constructor(ws: WebSocket) {
    this.ws = ws
  }
  send(data: Uint8Array | string): void {
    try {
      this.ws.send(data)
    } catch {
      // Closed under us; the close handler cleans up.
    }
  }
  close(code: number, reason: string): void {
    try {
      this.ws.close(code, reason)
    } catch {
      // Already closed.
    }
  }
}
