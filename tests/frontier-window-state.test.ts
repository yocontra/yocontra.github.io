import { describe, expect, it } from 'bun:test'
import { Matrix4, MeshStandardMaterial } from 'three'
import { buildWindowGlass } from '../src/experiments/out-west/ffa/scene/town.ts'
import { townWindows } from '../src/experiments/out-west/ffa/sim/building-rules.ts'
import { TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'

describe('persistent window visibility', () => {
  it('reconciles all296 panes beyond the event cap and restores intact matrices on replacement', () => {
    const material = new MeshStandardMaterial()
    const glass = buildWindowGlass(TOWN, material)
    if (!glass) {
      throw new Error('Missing window fixture')
    }
    try {
      const count = townWindows(TOWN).length
      expect(count).toBe(296)
      const intact = Array.from(glass.mesh.instanceMatrix.array)
      glass.setBrokenWindows(Array.from({ length: count }, (_, i) => i))
      const last = new Matrix4()
      glass.mesh.getMatrixAt(count - 1, last)
      expect(last.determinant()).toBe(0)
      glass.setBrokenWindows([])
      expect(Array.from(glass.mesh.instanceMatrix.array)).toEqual(intact)
      glass.breakWindow(0)
      const version = glass.mesh.instanceMatrix.version
      glass.breakWindow(0)
      glass.setBrokenWindows([0])
      expect(glass.mesh.instanceMatrix.version).toBe(version)
      glass.setBrokenWindows([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, count])
      expect(Array.from(glass.mesh.instanceMatrix.array)).toEqual(intact)
    } finally {
      glass.mesh.dispose()
      glass.mesh.geometry.dispose()
      material.dispose()
    }
  })
})
