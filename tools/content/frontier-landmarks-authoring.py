"""Original southwestern sandstone buttes for the space beyond Perdition's fence."""

import math
import sys
from pathlib import Path

import bpy

target = Path(sys.argv[sys.argv.index("--") + 1])
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

beds = [
    (0.00, 1.00, (0.53, 0.36, 0.22)),
    (0.13, 0.91, (0.62, 0.43, 0.29)),
    (0.27, 0.73, (0.69, 0.44, 0.28)),
    (0.35, 0.62, (0.78, 0.48, 0.30)),
    (0.42, 0.58, (0.61, 0.34, 0.23)),
    (0.44, 0.61, (0.52, 0.27, 0.19)),
    (0.53, 0.57, (0.60, 0.36, 0.24)),
    (0.61, 0.53, (0.71, 0.41, 0.25)),
    (0.68, 0.49, (0.77, 0.49, 0.31)),
    (0.70, 0.52, (0.67, 0.43, 0.27)),
    (0.80, 0.46, (0.79, 0.50, 0.31)),
    (0.88, 0.43, (0.71, 0.48, 0.33)),
    (0.92, 0.49, (0.81, 0.57, 0.39)),
    (0.97, 0.45, (0.76, 0.50, 0.34)),
    (1.00, 0.29, (0.76, 0.51, 0.34)),
]


def cliff(name, rx, ry, height, phase, lean):
    sides = 47
    vertices, faces, color = [], [], []
    for row, (level, radius, tint) in enumerate(beds):
        for i in range(sides):
            t = math.tau * i / sides
            pillars = 0.12 * math.sin(t * 5 + phase) + 0.045 * math.cos(t * 11 + phase)
            cracks = 0.027 * math.cos(t * 23 + 0.57 * row)
            rounding = (1.0 + pillars + cracks) * radius
            direction = math.sin(t) * math.cos(t * 0.5 + phase)
            x = rx * (rounding * math.cos(t) + lean * level)
            y = ry * (rounding * math.sin(t) + 0.12 * level)
            z = height * (level + (0.032 * direction + 0.012 * math.cos(t * 3)) * level)
            grain = 0.13 * math.sin(t * 24 + row) + 0.045 * math.cos(t * 10 + row * 4)
            shade = 0.98 + grain - 0.08 * max(0, -math.sin(t * 11 + phase))
            vertices.append((x, y, z))
            color.append((*[max(0.0, min(1.0, c * shade)) for c in tint], 1))
    for lower_row in range(len(beds) - 1):
        lower = lower_row * sides
        upper = lower + sides
        for i in range(sides):
            next_i = (i + 1) % sides
            faces.extend(((lower + i, lower + next_i, upper + next_i), (lower + i, upper + next_i, upper + i)))
    faces.append(tuple((len(beds) - 1) * sides + i for i in range(sides)))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    colors = mesh.color_attributes.new(name="Stratified sandstone", type="FLOAT_COLOR", domain="POINT")
    for i, rgba in enumerate(color):
        colors.data[i].color = rgba
    uv = mesh.uv_layers.new(name="Stone strata projection")
    perimeter = math.tau * math.sqrt((rx * rx + ry * ry) / 2)
    for face in mesh.polygons:
        angles = [(mesh.loops[index].vertex_index % sides) / sides for index in face.loop_indices]
        repeats_at_seam = len(angles) < sides and max(angles) - min(angles) > 0.5
        for loop_index, angle in zip(face.loop_indices, angles):
            index = mesh.loops[loop_index].vertex_index
            vx, vy, vz = vertices[index]
            if len(angles) == sides:
                coords = (vx / 2.6, vy / 2.6)
            else:
                if repeats_at_seam and angle < 0.5:
                    angle += 1
                coords = (angle * perimeter / 3.2, vz / 3.2)
            uv.data[loop_index].uv = coords
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)


cliff("Layered butte", 19, 12.7, 22.2, 1.7, -0.13)
cliff("Broken sandstone tower", 8.2, 8.4, 16.0, -0.8, 0.19)
cliff("Bedded bench", 14.4, 11.1, 9.4, -1.2, 0.02)
bpy.ops.export_scene.gltf(filepath=str(target), export_format="GLB", export_yup=True, export_vertex_color="ACTIVE", export_vertex_color_name="Stratified sandstone")
