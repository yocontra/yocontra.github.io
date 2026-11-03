/** Little-endian byte writer and reader over a DataView (shared by both ends of the codec). */

export class Writer {
  private buf: ArrayBuffer
  private view: DataView
  offset = 0

  constructor(capacity = 2048) {
    this.buf = new ArrayBuffer(capacity)
    this.view = new DataView(this.buf)
  }

  reset(): this {
    this.offset = 0
    return this
  }

  private ensure(n: number): void {
    if (this.offset + n <= this.buf.byteLength) {
      return
    }
    const next = new ArrayBuffer(Math.max(this.buf.byteLength * 2, this.offset + n))
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.offset))
    this.buf = next
    this.view = new DataView(next)
  }

  u8(v: number): this {
    this.ensure(1)
    this.view.setUint8(this.offset, v)
    this.offset += 1
    return this
  }

  i8(v: number): this {
    this.ensure(1)
    this.view.setInt8(this.offset, v)
    this.offset += 1
    return this
  }

  u16(v: number): this {
    this.ensure(2)
    this.view.setUint16(this.offset, v & 0xff_ff, true)
    this.offset += 2
    return this
  }

  u32(v: number): this {
    this.ensure(4)
    this.view.setUint32(this.offset, v >>> 0, true)
    this.offset += 4
    return this
  }

  /** Overwrite a u8 written earlier (for counts known only at the end). */
  patchU8(at: number, v: number): void {
    this.view.setUint8(at, v)
  }

  /** A copy of the written bytes (safe to hand to a socket and reuse this writer). */
  bytes(): Uint8Array {
    return new Uint8Array(this.buf.slice(0, this.offset))
  }
}

export class Reader {
  private readonly view: DataView
  offset = 0

  constructor(data: ArrayBuffer | Uint8Array) {
    this.view =
      data instanceof Uint8Array
        ? new DataView(data.buffer, data.byteOffset, data.byteLength)
        : new DataView(data)
  }

  get remaining(): number {
    return this.view.byteLength - this.offset
  }

  u8(): number {
    const v = this.view.getUint8(this.offset)
    this.offset += 1
    return v
  }

  i8(): number {
    const v = this.view.getInt8(this.offset)
    this.offset += 1
    return v
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true)
    this.offset += 2
    return v
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true)
    this.offset += 4
    return v
  }
}

export const clampI8 = (v: number): number => Math.max(-127, Math.min(127, Math.round(v)))
export const clampU8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))
