"""Sculpt distinctive outlaw faces from the fitted CC0 anatomical head."""

import math
import sys
from pathlib import Path

import bpy

source, output, *args = sys.argv[sys.argv.index("--") + 1 :]
output = Path(output)
subject = args[0] if args else "greenhorn"
portraits = {
    "greenhorn": "Bret P. Barsh",
    "talker": "Prescott J. House",
    "burney": "Burney N. Coover",
}
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(source))

head = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH")
paint = head.data.color_attributes.new(name="Weathering", type="FLOAT_COLOR", domain="POINT")
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
    if subject == "talker":
        jowl = math.exp(-(((y - 1.501) / 0.035) ** 2))
        across += (x - temple) * (0.22 * jowl + 0.14 * collar)
        height -= jowl * 0.005 + lip * 0.003
        depth += 0.008 * nose + 0.005 * jowl + 0.008 * collar
        across -= 0.0032 * nose
    elif subject == "burney":
        cheek = math.exp(-(((y - 1.537) / 0.028) ** 2))
        across += (x - temple) * 0.16 * cheek
        depth += 0.01 * nose + 0.0038 * cheek
        across -= (x - temple) * 0.16 * collar
        delta = (x - temple) * 0.17 * lip
        height += delta - 0.005 * lip
    v.co = (across, -depth, height)
    if subject == "burney":
        cheek_y = max(0, 1 - abs(y - 1.545) / 0.030)
        scar_line = -0.072 - (1.574 - y) * 0.37
        scar = math.exp(-(((x - scar_line) / 0.0025) ** 2)) * cheek_y
        scar *= max(0, min(1, (z - 0.086) / 0.02))
        beard = math.exp(-(((y - 1.487) / 0.023) ** 2)) * max(0, min(1, (z - 0.073) / 0.037))
        paint.data[v.index].color = (1 - 0.17 * scar - 0.12 * beard, 1 - 0.42 * scar - 0.09 * beard, 1 - 0.39 * scar - 0.06 * beard, 1)
    else:
        paint.data[v.index].color = (1, 1, 1, 1)
head.data.update()
head.name = portraits[subject]
output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=str(output), export_format="GLB", export_yup=True,
    export_vertex_color="ACTIVE", export_vertex_color_name="Weathering",
)
