"""Sculpt the Greenhorn from the CC0 anatomical head used for the starter rider."""

import math
import sys
from pathlib import Path

import bpy

source, output = [Path(path) for path in sys.argv[sys.argv.index("--") + 1 :]]
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(source))

head = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH")
for v in head.data.vertices:
    x, back, y = v.co
    z = -back
    cheek = max(0, 1 - abs(y - 1.527) / 0.065)
    lower = max(0, min(1, (1.521 - y) / 0.072))
    collar = lower**2 * (3 - 2 * lower)
    jaw = max(0, min(1, (z - 0.06) / 0.04))
    temple = -0.027
    across = temple + 0.012 * collar + (x - temple) * (1 - 0.13 * cheek - 0.20 * collar)
    height = y + 0.023 * jaw * collar - 0.012 * (1 - jaw) * collar
    depth = z * (1 - 0.16 * collar) - 0.010 * cheek - 0.018 * collar
    # Tight lower lip, a slightly uneven nose bridge and the Greenhorn's narrow cheeks.
    nose = math.exp(-(((y - 1.551) / 0.017) ** 2) - (((x - temple) / 0.024) ** 2))
    nose *= max(0, min(1, (z - 0.13) / 0.02))
    depth += 0.0031 * nose
    across += 0.0012 * nose
    lip = math.exp(-(((y - 1.514) / 0.009) ** 2) - (((x - temple) / 0.036) ** 2))
    height += (x - temple) * 0.077 * lip
    v.co = (across, -depth, height)
head.data.update()
head.name = "Bret P. Barsh"
output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(output), export_format="GLB", export_yup=True)
