"""Bake shared small worn-metal maps using Blender's native procedural texture."""

from pathlib import Path

import bpy
from mathutils import Vector

output = Path(__file__).resolve().parents[1] / "art/characters/textures"
output.mkdir(parents=True, exist_ok=True)
texture = bpy.data.textures.new("Fine metal wear", type="CLOUDS")
texture.noise_scale = 0.14
texture.noise_depth = 2
size = 128


def height(x, y):
    # Native procedural noise supplies fine grain; stretched coordinates suggest brushed steel.
    return texture.evaluate(Vector((x / size * 6, y / size * 0.6, 0.37)))[3]


maps = {"color": [], "normal": [], "wear": []}
for y in range(size):
    for x in range(size):
        value = height(x, y)
        dx = (height(x + 1, y) - height(x - 1, y)) * 0.17
        dy = (height(x, y + 1) - height(x, y - 1)) * 0.17
        normal = Vector((-dx, -dy, 1)).normalized()
        color = 0.89 + value * 0.1
        maps["color"].extend((color, color, color, 1))
        maps["normal"].extend(
            ((normal.x + 1) / 2, (normal.y + 1) / 2, (normal.z + 1) / 2, 1)
        )
        maps["wear"].extend((1, 0.37 + value * 0.16, 0.94 + value * 0.06, 1))
for role, values in maps.items():
    image = bpy.data.images.new(f"Worn metal {role}", width=size, height=size)
    image.colorspace_settings.name = "Non-Color"
    image.pixels = values
    image.filepath_raw = str(output / f"worn-metal-{role}.png")
    image.file_format = "PNG"
    image.save()
    print(image.filepath_raw)
