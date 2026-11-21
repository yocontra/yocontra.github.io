"""Model the depot water tank within its shipped post and tank envelopes."""

import math
import sys
from pathlib import Path

from mathutils import Vector

root, output = map(Path, sys.argv[sys.argv.index("--") + 1:])
shared = root / "tools/content/frontier-furniture-authoring.py"
sys.argv = [str(shared), "--", str(output)]
lib = {"__name__": "frontier_furniture"}
exec(compile(shared.read_text().split('begin("saloon-card-table")')[0], str(shared), "exec"), lib)
bpy = lib["bpy"]
begin, pack, box, mesh, finish = (lib[name] for name in ("begin", "pack", "box", "mesh", "finish"))

post = finish("Tower squared timber", (0.78, 0.63, 0.46), 0.85)
planks = [
    finish("Tower dried cedar", (0.87, 0.68, 0.48), 0.79),
    finish("Tower dry heartwood", (0.68, 0.49, 0.34), 0.83),
    finish("Tower scrubbed rim", (0.73, 0.57, 0.43), 0.81),
]
iron = finish("Tower blackened iron", (0.34, 0.29, 0.21), 0.72, 0.58)
bolts = finish("Tower iron rivets", (0.41, 0.33, 0.24), 0.61, 0.7)


def beam(name, start, end, width, mat):
    axis = (end - start).normalized()
    across = axis.cross(Vector((0, 0, 1))).normalized() * width / 2
    deep = axis.cross(across).normalized() * width / 2
    edges = (-across - deep, across - deep, across + deep, -across + deep)
    vertices = [tuple(point + edge) for point in (start, end) for edge in edges]
    faces = [(3, 2, 1, 0), (4, 5, 6, 7)]
    faces.extend((i, (i+1) % 4, (i+1) % 4 + 4, i+4) for i in range(4))
    return mesh(name, vertices, faces, mat, bevel=0.013, grain_axis=2)


begin("Depot timber water tower")
for x in (-1.775, 1.775):
    for y in (-1.775, 1.775):
        box("Sill-stone foot", x, y, 0, (0.45, 0.45, 0.12), iron, 0.012)
        box("Squared stand timber", x, y, 0.12, (0.45, 0.45, 8.88), post, 0.018, grain_axis=2)
box("Sealed tank liner", 0, 0, 9.04, (3.82, 3.82, 2.91), planks[1], 0.012, grain_axis=2)

for side in range(4):
    angle = side * math.pi / 2
    c, s = math.cos(angle), math.sin(angle)
    def xyz(along, across, height):
        return Vector((c * along - s * across, s * along + c * across, height))

    for plank in range(19):
        along = -1.829 + (plank + 0.5) * 3.658 / 19
        x, y, _ = xyz(along, 1.916, 0)
        box("Separate cedar tank board", x, y, 9.02, (0.186, 0.149, 2.96),
            planks[(plank * 13 + side * 3) % len(planks)], 0.005, spin=angle, grain_axis=2)

    x, y, _ = xyz(0, 1.88, 0)
    for z in (8.83, 11.96):
        box("Heavy tank cap beam", x, y, z, (4, 0.24, 0.17), post, 0.014, spin=angle)
    x, y, _ = xyz(0, 1.985, 0)
    for z in (9.18, 10.11, 11.23):
        box("Square wrought-iron tank strap", x, y, z, (3.96, 0.028, 0.106), iron, 0.004, spin=angle)
        for along in (-1.82, -1.36, -0.90, -0.44, 0, 0.44, 0.90, 1.36, 1.82):
            x, y, _ = xyz(along, 1.993, 0)
            box("Domed strap rivet", x, y, z + 0.035, (0.041, 0.014, 0.034), bolts, 0.007, spin=angle)
        x, y, _ = xyz(0, 1.985, 0)
    beam("Mortised diagonal brace", xyz(-1.79, 1.79, 3.12), xyz(1.79, 1.79, 8.84), 0.17, post)
    beam("Opposite stand brace", xyz(1.79, 1.76, 3.12), xyz(-1.79, 1.76, 8.84), 0.17, post)

for x in (-1.865, 1.865):
    for y in (-1.865, 1.865):
        box("Tank corner timber", x, y, 9, (0.27, 0.27, 3), post, 0.017, grain_axis=2)

pack()
bpy.ops.export_scene.gltf(filepath=str(output), export_format="GLB", export_yup=True)
