import { type AppBase, Color, Entity, LIGHTFALLOFF_LINEAR } from 'playcanvas'
import { WALL_T } from '../ffa/sim/building-rules.ts'
import { type Building, TOWN } from '../ffa/sim/layout.ts'

/** Soft daylight in the roofed rooms, where the direct sun map is in shadow. */
export function roomLights(root: Entity, app: AppBase): Entity[] {
  return TOWN.buildings
    .filter((building) => building.hollow && building.windows?.length)
    .flatMap((building) => buildingLights(root, app, building))
}

function buildingLights(root: Entity, app: AppBase, b: Building): Entity[] {
  const upper = b.upperFloor?.[0]?.y
  const spans: readonly (readonly [number, number])[] =
    upper === undefined
      ? [[0, b.height]]
      : [
          [0, upper],
          [upper, b.height],
        ]
  const acrossX = b.w > b.d
  const length = Math.max(b.w, b.d)
  const width = Math.min(b.w, b.d)
  const offsets = length >= 16 ? [length / 3, (length * 2) / 3] : [length / 2]
  return spans.flatMap(([floor, ceiling]) =>
    offsets.map((along) => {
      const x = b.x + (acrossX ? along : width / 2)
      const z = b.z + (acrossX ? width / 2 : along)
      const y = Math.min(floor + 3.8, ceiling - 0.25)
      // End the falloff inside the building footprint.
      const range = Math.min(width / 2, along, length - along) - WALL_T / 2
      const light = new Entity(`frontier-room-bounce:${b.id}`, app)
      root.addChild(light)
      light.setPosition(x, y, z)
      light.addComponent('light', {
        type: 'spot',
        color: new Color(1, 0.88, 0.72),
        falloffMode: LIGHTFALLOFF_LINEAR,
        range,
        innerConeAngle: 52,
        // The downward cone stays off the ceiling and the storey above.
        outerConeAngle: 77,
        intensity: 0,
        castShadows: false,
        enabled: false,
      })
      return light
    }),
  )
}
