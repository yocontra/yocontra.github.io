"""Build the Perdition saloon bar and fixtures in Blender, in town coordinates."""

import math
import sys
from pathlib import Path

import bpy

OUTPUT = Path("tools/art/environments/frontier-saloon.glb")
if "--" in sys.argv:
    OUTPUT = Path(sys.argv[sys.argv.index("--") + 1])

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)


def material(name, color, roughness, metallic=0):
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    result.diffuse_color = (*color, 1)
    shader = result.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    return result


walnut = material("Saloon walnut", (0.38, 0.19, 0.09), 0.74)
endgrain = material("Saloon worn walnut", (0.58, 0.33, 0.15), 0.56)
iron = material("Saloon iron", (0.12, 0.086, 0.055), 0.49, 0.55)
amber = material("Saloon amber bottles", (0.29, 0.095, 0.025), 0.28)
green = material("Saloon green bottles", (0.065, 0.16, 0.108), 0.27)
paper = material("Saloon paper and cork", (0.67, 0.52, 0.31), 0.72)
ceramic = material("Saloon stoneware", (0.60, 0.49, 0.32), 0.34)
glass = material("LampGlass", (0.84, 0.57, 0.26), 0.27)

groups = {}


def town(x, y, z):
    return x, -z, y


def finish(obj, surface, edge=0, group=None):
    obj.data.materials.append(surface)
    if edge:
        bevel = obj.modifiers.new("Worn edges", "BEVEL")
        bevel.width = edge
        bevel.segments = 2
        normals = obj.modifiers.new("Weighted normals", "WEIGHTED_NORMAL")
        normals.keep_sharp = True
        for modifier in (bevel, normals):
            bpy.ops.object.modifier_apply(modifier=modifier.name)
    groups.setdefault(group or surface.name, []).append(obj)
    return obj


def block(x, y, z, width, height, depth, surface, edge=0.008):
    bpy.ops.mesh.primitive_cube_add(size=1, location=town(x, y, z))
    obj = bpy.context.object
    obj.scale = width, depth, height
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    finish(obj, surface, edge)
    if surface in (walnut, endgrain):
        # Keep the grain on the long axis and use the same scale on adjoining pieces.
        long_z = depth > width
        grain = obj.data.uv_layers.active.data
        for face in obj.data.polygons:
            for li in face.loop_indices:
                vx, vy, vz = obj.data.vertices[obj.data.loops[li].vertex_index].co
                along, across = (vy, vx) if long_z else (vx, vy)
                grain[li].uv = (
                    (along if abs(face.normal.z) > 0.7 else vz) / 1.5,
                    (across if abs(face.normal.z) > 0.7 else along + across) / 0.8,
                )


def turned(x, z, base, rings, surface, sides=16, group=None):
    verts = []
    for y, radius in rings:
        verts.extend(
            (
                radius * math.cos(i * math.tau / sides),
                radius * math.sin(i * math.tau / sides),
                y,
            )
            for i in range(sides)
        )
    faces = [tuple(reversed(range(sides)))]
    for j in range(len(rings) - 1):
        for i in range(sides):
            a = j * sides + i
            b = j * sides + (i + 1) % sides
            faces.append((a, b, b + sides, a + sides))
    faces.append(tuple(range(len(verts) - sides, len(verts))))
    mesh = bpy.data.meshes.new(surface.name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    for face in list(mesh.polygons)[1:-1]:
        face.use_smooth = True
    obj = bpy.data.objects.new(surface.name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = town(x, base, z)
    return finish(obj, surface, group=group)


def bottle(x, z, base, scale, surface, ticket):
    profile = [
        (0, 0.027),
        (0.012, 0.036),
        (0.151, 0.036),
        (0.189, 0.027),
        (0.203, 0.015),
        (0.267, 0.015),
        (0.272, 0.020),
        (0.284, 0.020),
        (0.288, 0.016),
    ]
    turned(x, z, base, [(y * scale, r * scale) for y, r in profile], surface, 12)
    turned(
        x,
        z,
        base + 0.285 * scale,
        [(0, 0.014 * scale), (0.019 * scale, 0.016 * scale)],
        paper,
        10,
    )
    if ticket:
        turned(
            x,
            z,
            base + 0.056 * scale,
            [(0, 0.0366 * scale), (0.065 * scale, 0.0366 * scale)],
            paper,
            12,
        )


# Counter remains within its original 0.5 x 6.5 m cover footprint.
block(26.45, 0.53, 37.25, 0.43, 0.98, 6.46, walnut, 0.014)
block(26.45, 1.054, 37.25, 0.50, 0.092, 6.50, endgrain, 0.021)
block(26.674, 0.103, 37.25, 0.038, 0.145, 6.42, endgrain, 0.009)
block(26.674, 0.952, 37.25, 0.039, 0.096, 6.42, endgrain, 0.008)
for i in range(8):
    z = 34.18 + i * 0.86
    block(26.669, 0.53, z, 0.056, 0.82, 0.087, endgrain)
    if i < 7:
        block(26.673, 0.54, z + 0.43, 0.024, 0.54, 0.60, walnut, 0.014)

# Open-backed shelving retains the view through the original west windows.
for y in (0.18, 0.8, 1.38, 2.28):
    block(25, y, 37.5, 0.50, 0.064, 7, endgrain)
for z in (34.04, 35.76, 37.5, 39.24, 40.96):
    block(25, 1.14, z, 0.49, 2.28, 0.08, walnut)
for y, offsets in (
    (0.832, (34.3, 34.48, 34.73, 36.66, 36.83, 38.9, 39.71, 40.12)),
    (1.412, (34.5, 34.68, 35.4, 36.31, 36.48, 37.79, 37.97, 38.14, 39.7, 40.39)),
):
    for i, z in enumerate(offsets):
        bottle(
            25.10 if i % 3 else 24.93,
            z,
            y,
            0.85 + (i % 4) * 0.12,
            green if i % 3 == 0 else amber,
            i % 4 != 1,
        )
for z in (35.1, 37.8, 40.3):
    turned(
        24.98,
        z,
        0.212,
        [(0, 0.09), (0.025, 0.105), (0.235, 0.105), (0.29, 0.068), (0.33, 0.065)],
        ceramic,
    )
for z in (35.35, 39.70):
    bottle(26.4, z, 1.1, 0.94, amber, True)
    for dz in (0.14, 0.23):
        turned(
            26.48,
            z + dz,
            1.1,
            [
                (0, 0.036),
                (0.012, 0.041),
                (0.074, 0.045),
                (0.077, 0.042),
                (0.016, 0.034),
            ],
            ceramic,
            12,
        )

# Lamps hang from the ground-floor joists and stay clear of the doorway and stairs.
for index, (x, z) in enumerate(((27.18, 36.12), (30.45, 40.14))):
    turned(x, z, 2.48, [(0, 0.016), (0.79, 0.016)], iron, 10)
    turned(x, z, 2.4, [(0, 0.16), (0.051, 0.20), (0.09, 0.16), (0.118, 0.067)], iron)
    turned(
        x,
        z,
        2.29,
        [(0, 0.072), (0.027, 0.105), (0.096, 0.107), (0.128, 0.078)],
        glass,
        group=f"frontier-saloon-lamp-glass-{index + 1}",
    )
    turned(x, z, 2.24, [(0, 0.035), (0.025, 0.071), (0.054, 0.085)], iron)

# Pack by surface for static town rendering. Keep the two lamp origins as light sockets.
for name, objects in groups.items():
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    obj = bpy.context.object
    obj.name = name
    obj.data.name = name

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=str(OUTPUT.resolve()),
    export_format="GLB",
    export_yup=True,
    export_cameras=False,
    export_lights=False,
)
