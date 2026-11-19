import { type AppBase, AudioHandler } from 'playcanvas'

/** A late audio response must never reach a parser after its sound manager is destroyed. */
export class NativeAudioHandler extends AudioHandler {
  private closed = false as boolean

  constructor(app: AppBase) {
    super(app)
    app.once('destroy', () => {
      this.closed = true
    })
  }

  override load(...args: Parameters<AudioHandler['load']>): void {
    if (!this.closed) {
      super.load(...args)
    }
  }

  override fetch(...[url, responseType, callback, asset]: Parameters<AudioHandler['fetch']>): void {
    if (!this.closed) {
      super.fetch(
        url,
        responseType,
        (error, data) => {
          if (!this.closed) {
            callback(error, data)
          }
        },
        asset,
      )
    }
  }
}
