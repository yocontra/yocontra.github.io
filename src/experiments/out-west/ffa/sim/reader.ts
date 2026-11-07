/** Little-endian byte reader over a DataView (shared by both ends of the codec). */

export class Reader {
  private readonly view: DataView
  offset = 0

  constructor(data: ArrayBuffer | Uint8Array) {
    // Views from any realm (workerd hands sockets' binary frames over as foreign buffers).
    const bytes = ArrayBuffer.isView(data) ? data : new Uint8Array(data)
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
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

  i16(): number {
    const v = this.view.getInt16(this.offset, true)
    this.offset += 2
    return v
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true)
    this.offset += 4
    return v
  }
}
