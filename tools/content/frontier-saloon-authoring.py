"""Build the Perdition saloon bar and fixtures in Blender, in town coordinates."""

import math
import sys
from pathlib import Path

import bpy
import numpy as np

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

brass = material("Saloon aged brass", (0.47, 0.275, 0.095), 0.33, 0.82)


def walnut_surface():
    # Long open pores follow the growth rings. Periodic distortion keeps board ends tileable.
    size = 512
    v, u = np.mgrid[:size, :size] * (math.tau / size)
    arc = 2.1 * np.sin(u) + 0.72 * np.sin(2 * u - v) + 0.22 * np.cos(3 * u + 2 * v)
    phase = 16 * v + arc + 2.4 * np.sin(v + 0.42 * np.cos(u))
    latewood = np.maximum(0, np.cos(phase)) ** 7
    pores = np.maximum(0, np.sin(79 * v + 3 * arc + np.cos(9 * u))) ** 10
    pores *= np.maximum(0, np.cos(11 * u - 5 * v)) ** 2
    grain = 0.94 - 0.16 * latewood - 0.12 * pores + 0.07 * np.cos(phase / 2 + arc / 2)
    # Last low-frequency variation also repeats exactly at the tile boundary.
    height = 0.55 * latewood + pores
    du = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * 0.08
    dv = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * 0.16
    norm = np.sqrt(1 + du * du + dv * dv)

    def image(name, rgb, data):
        result = bpy.data.images.new(
            name, width=size, height=size, alpha=False, is_data=data
        )
        pixels = np.ones((size, size, 4), dtype=np.float32)
        pixels[:, :, :3] = rgb
        result.pixels.foreach_set(pixels.ravel())
        result.pack()
        return result

    color = image(
        "Oiled walnut grain", grain[:, :, None] * np.array([0.66, 0.46, 0.31]), False
    )
    relief = image(
        "Oiled walnut pores",
        np.stack((du / norm, dv / norm, 1 / norm), axis=-1) * 0.5 + 0.5,
        True,
    )
    for surface in (walnut, endgrain):
        nodes = surface.node_tree.nodes
        links = surface.node_tree.links
        shader = nodes.get("Principled BSDF")
        paint = nodes.new("ShaderNodeTexImage")
        paint.image = color
        links.new(paint.outputs["Color"], shader.inputs["Base Color"])
        detail = nodes.new("ShaderNodeTexImage")
        detail.image = relief
        normal = nodes.new("ShaderNodeNormalMap")
        normal.inputs["Strength"].default_value = 0.45
        links.new(detail.outputs["Color"], normal.inputs["Color"])
        links.new(normal.outputs["Normal"], shader.inputs["Normal"])


walnut_surface()
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
        dimensions = (width, depth, height)
        grain = obj.data.uv_layers.active.data
        for face in obj.data.polygons:
            normal_axis = max(range(3), key=lambda axis: abs(face.normal[axis]))
            plane = [axis for axis in range(3) if axis != normal_axis]
            along, across = sorted(
                plane, key=lambda axis: dimensions[axis], reverse=True
            )
            for li in face.loop_indices:
                co = obj.data.vertices[obj.data.loops[li].vertex_index].co
                grain[li].uv = (co[along] / 1.5 + z / 3.1, co[across] / 0.8 + x / 2.7)


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
    # Green quart bottles have broad shoulders and a shorter neck.
    if surface == green:
        profile[2:5] = [(0.160, 0.041), (0.173, 0.039), (0.208, 0.017)]
    turned(x, z, base, [(y * scale, r * scale) for y, r in profile], surface, 20)
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
            [
                (0, (0.0385 if surface == green else 0.0366) * scale),
                (0.065 * scale, (0.0408 if surface == green else 0.0366) * scale),
            ],
            paper,
            20,
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

# Raised panels have a recessed field, a molded lip and a top/bottom rail.
for bay in range(7):
    z = 34.61 + bay * 0.86
    for y in (0.238, 0.842):
        block(26.68, y, z, 0.040, 0.055, 0.74, endgrain, 0.011)
    for side in (-0.35, 0.35):
        block(26.68, 0.54, z + side, 0.039, 0.55, 0.045, endgrain, 0.009)
    block(26.688, 0.53, z, 0.015, 0.43, 0.50, walnut, 0.007)

# Rolled brass protects the drink ledge. Leave the original cover bounds intact.
block(26.681, 1.021, 37.25, 0.036, 0.028, 6.46, brass, 0.012)

# A pressed serving tray and a footed stoneware jug occupy the middle of the bar.
turned(
    26.43,
    37.28,
    1.10,
    [(0, 0.125), (0.007, 0.147), (0.018, 0.151), (0.020, 0.146), (0.007, 0.125)],
    brass,
    40,
)
turned(
    26.43,
    37.28,
    1.107,
    [
        (0, 0.045),
        (0.015, 0.053),
        (0.045, 0.060),
        (0.105, 0.075),
        (0.16, 0.069),
        (0.19, 0.046),
        (0.207, 0.039),
        (0.215, 0.047),
        (0.225, 0.046),
        (0.225, 0.040),
        (0.194, 0.035),
    ],
    ceramic,
    32,
)
bpy.ops.mesh.primitive_torus_add(
    location=town(26.43, 1.245, 37.354),
    rotation=(0, math.pi / 2, 0),
    major_segments=28,
    minor_segments=8,
    major_radius=0.046,
    minor_radius=0.008,
)
handle = bpy.context.object
handle.scale.y = 0.80
handle.scale.x = 1.20
for face in handle.data.polygons:
    face.use_smooth = True
finish(handle, ceramic)

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

# Plinths and inset panels stand outside the four-metre saloon passage.
for x in (29.78, 34.22):
    block(x, 0.26, 44.045, 0.35, 0.52, 0.105, walnut, 0.014)
    block(x, 0.53, 44.052, 0.38, 0.06, 0.12, endgrain, 0.012)
    block(x, 1.44, 44.039, 0.24, 1.82, 0.09, walnut)
    block(x, 1.44, 44.091, 0.16, 1.55, 0.025, endgrain, 0.012)
    block(x, 2.38, 44.053, 0.36, 0.11, 0.12, endgrain, 0.012)

# The smith has strapped the opposite gateposts with iron and rounded rivet heads.
for x in (22.88, 31.12):
    for y in (0.26, 0.75, 1.92):
        block(x, y, 59.928, 0.21, 0.12, 0.033, iron, 0.007)
        for dx in (-0.069, 0.069):
            bpy.ops.mesh.primitive_uv_sphere_add(
                segments=12, ring_count=6, radius=1, location=town(x + dx, y, 59.911)
            )
            rivet = bpy.context.object
            rivet.scale = (0.018, 0.009, 0.018)
            finish(rivet, iron)

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
