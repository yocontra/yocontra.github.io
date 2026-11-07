/** Optional exact GS accelerator. Each world owns its instance and scratch memory. */
export const GS_ROW_WIDTH = 24
const ABI = 1
const PAGE = 65_536
const MAX_ADDRESS = 0x7f_ff_ff_ff

export interface GsInput {
  count: number
  iterations: number
  tolerance: number
  rows: Float64Array
  indices: Int32Array
  velocities: Float64Array
  masses: Float64Array
  finite: Uint8Array
}
interface Native extends WebAssembly.Exports {
  memory: WebAssembly.Memory
  gs_base: () => number
  gs_abi: () => number
  gs_width: () => number
  gs: (...args: number[]) => number
}
interface Layout {
  rows: number
  indices: number
  velocities: number
  masses: number
  finite: number
  stats: number
  bytes: number
}

function validInput(input: GsInput): boolean {
  const { count, iterations, tolerance, rows, indices, finite, velocities, masses } = input
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Number.isInteger(iterations) ||
    iterations < 0 ||
    iterations > MAX_ADDRESS ||
    count * iterations > MAX_ADDRESS ||
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    count * GS_ROW_WIDTH > rows.length ||
    count * 2 > indices.length ||
    count > finite.length ||
    velocities.length % 6 !== 0
  ) {
    return false
  }
  for (let i = 0; i < count * 2; i++) {
    const body = indices[i]
    if (
      body === undefined ||
      body < 0 ||
      body >= masses.length ||
      body * 6 + 5 >= velocities.length
    ) {
      return false
    }
  }
  return true
}

function layout(base: number, input: GsInput): Layout {
  let offset = base
  const take = (bytes: number): number => {
    const pointer = offset
    offset = Math.ceil((offset + bytes) / 8) * 8
    return pointer
  }
  const rows = take(input.count * GS_ROW_WIDTH * 8)
  const indices = take(input.count * 2 * 4)
  const velocities = take(input.velocities.byteLength)
  const masses = take(input.masses.byteLength)
  const finite = take(input.count)
  const stats = take(4)
  return { rows, indices, velocities, masses, finite, stats, bytes: offset }
}

export class GsKernel {
  private native: Native | null
  private readonly base: number

  private constructor(native: Native) {
    this.native = native
    this.base = native.gs_base()
  }

  static create(module: WebAssembly.Module): GsKernel | null {
    try {
      const native = new WebAssembly.Instance(module).exports
      if (
        !(native.memory instanceof WebAssembly.Memory) ||
        typeof native.gs !== 'function' ||
        typeof native.gs_base !== 'function' ||
        typeof native.gs_abi !== 'function' ||
        typeof native.gs_width !== 'function' ||
        native.gs_abi() !== ABI ||
        native.gs_width() !== GS_ROW_WIDTH ||
        !Number.isInteger(native.gs_base()) ||
        native.gs_base() < 0 ||
        native.gs_base() > native.memory.buffer.byteLength
      ) {
        return null
      }
      const kernel = new GsKernel(native as Native)
      // Instantiate and enter the compiled function behind loading, before any death frame.
      const warmed = kernel.run({
        count: 0,
        iterations: 1,
        tolerance: 0,
        rows: new Float64Array(),
        indices: new Int32Array(),
        velocities: new Float64Array(),
        masses: new Float64Array(),
        finite: new Uint8Array(),
      })
      return warmed ? kernel : null
    } catch {
      return null
    }
  }

  get bytes(): number {
    return this.native?.memory.buffer.byteLength ?? 0
  }

  run(input: GsInput): { iterations: number; zeros: number } | null {
    const native = this.native
    if (!(native && validInput(input))) {
      return null
    }
    const at = layout(this.base, input)
    if (!Number.isSafeInteger(at.bytes) || at.bytes > MAX_ADDRESS) {
      return null
    }
    try {
      if (at.bytes > native.memory.buffer.byteLength) {
        native.memory.grow(Math.ceil((at.bytes - native.memory.buffer.byteLength) / PAGE))
      }
      const memory = native.memory.buffer
      const rows = new Float64Array(memory, at.rows, input.count * GS_ROW_WIDTH)
      const velocities = new Float64Array(memory, at.velocities, input.velocities.length)
      const stats = new Int32Array(memory, at.stats, 1)
      rows.set(input.rows.subarray(0, rows.length))
      new Int32Array(memory, at.indices, input.count * 2).set(
        input.indices.subarray(0, input.count * 2),
      )
      velocities.set(input.velocities)
      new Float64Array(memory, at.masses, input.masses.length).set(input.masses)
      new Uint8Array(memory, at.finite, input.count).set(input.finite.subarray(0, input.count))
      const iterations = native.gs(
        input.count,
        input.iterations,
        input.tolerance,
        at.rows,
        at.indices,
        at.velocities,
        at.masses,
        at.finite,
        at.stats,
      )
      if (!Number.isInteger(iterations) || iterations < 0 || iterations > input.iterations) {
        this.dispose()
        return null
      }
      input.rows.set(rows)
      input.velocities.set(velocities)
      return { iterations, zeros: stats[0] ?? 0 }
    } catch {
      // JS buffers are untouched until successful completion, so the caller can retry in JS.
      this.dispose()
      return null
    }
  }

  dispose(): void {
    this.native = null
  }
}
