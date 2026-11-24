"""Blender source for the small trades visible from Perdition's street and yards. Metres, Z up."""

import math
import random
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

OUTPUT = (
    Path(sys.argv[sys.argv.index("--") + 1])
    if "--" in sys.argv
    else Path("tools/art/environments/frontier-street-trades.glb")
)
bpy.ops.wm.read_factory_settings(use_empty=True)
rng = random.Random(4189)
TAU = math.tau
IRON = (0.115, 0.116, 0.10)
BRASS = (0.50, 0.32, 0.120)
RUST = (0.255, 0.155, 0.09)
OAK = (0.38, 0.215, 0.105)
LEATHER = (0.205, 0.078, 0.038)
LIP = (0.34, 0.148, 0.058)
LINEN = (0.55, 0.43, 0.275)
PAPER = (0.66, 0.49, 0.285)
TWINE = (0.46, 0.32, 0.17)


def surface(name, rough, metallic):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Roughness"].default_value = rough
    shader.inputs["Metallic"].default_value = metallic
    return mat


def image_map(mat, name, rgb, normal=False):
    size = rgb.shape[0]
    image = bpy.data.images.new(
        name, width=size, height=size, alpha=False, is_data=normal
    )
    pixels = np.ones((size, size, 4), dtype=np.float32)
    pixels[:, :, :3] = rgb
    image.pixels.foreach_set(pixels.ravel())
    image.pack()
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    links = mat.node_tree.links
    shader = mat.node_tree.nodes.get("Principled BSDF")
    if normal:
        relief = mat.node_tree.nodes.new("ShaderNodeNormalMap")
        relief.inputs["Strength"].default_value = 0.38
        links.new(tex.outputs["Color"], relief.inputs["Color"])
        links.new(relief.outputs["Normal"], shader.inputs["Normal"])
    else:
        links.new(tex.outputs["Color"], shader.inputs["Base Color"])


def texture_finish(mat, name, light, height):
    image_map(mat, name + " grain", np.clip(light[:, :, None], 0, 1))
    dx = (np.roll(height, 1, 1) - np.roll(height, -1, 1)) * 0.45
    dy = (np.roll(height, 1, 0) - np.roll(height, -1, 0)) * 0.45
    norm = np.sqrt(1 + dx * dx + dy * dy)
    image_map(
        mat,
        name + " relief",
        0.5 + 0.5 * np.stack([dx / norm, dy / norm, 1 / norm], axis=2),
        True,
    )


dry = surface("Perdition weathered trade timber", 0.72, 0)
leather = surface("Perdition oiled bridle leather", 0.53, 0)
cloth = surface("Perdition canvas and wrapping", 0.92, 0)
metal = surface("Perdition rubbed hardware", 0.54, 0.66)
v, u = np.mgrid[:128, :128] * (TAU / 128)
noise = np.random.default_rng(41).normal(0, 0.032, (128, 128))
warp = np.sin(17 * u + 0.35 * np.sin(v))
weft = np.sin(16 * v) * (0.55 + 0.45 * np.cos(17 * u))
texture_finish(
    cloth,
    "Trade plain weave",
    0.91 + 0.039 * warp + 0.036 * weft + noise * 0.2,
    0.34 * warp + 0.36 * weft,
)
grain = 17 * v + 1.6 * np.sin(u) + 0.65 * np.cos(v + 2 * u)
vein = np.maximum(0, np.sin(grain)) ** 5
pore = np.maximum(0, np.sin(44 * v + 1.6 * np.cos(3 * u) + 0.32 * np.sin(u))) ** 8
texture_finish(
    dry,
    "Trade oiled wood",
    0.94 - 0.085 * vein - 0.098 * pore + noise * 0.25,
    0.39 * vein + 0.41 * pore,
)
pebble = (
    np.maximum(
        0,
        np.sin(24 * u + 2.2 * np.sin(3 * v) + np.cos(6 * v))
        * np.cos(27 * v + np.sin(2 * u)),
    )
    ** 2
)
texture_finish(
    leather,
    "Trade worn hide",
    0.94 - 0.13 * pebble + noise * 0.38,
    0.56 * pebble + noise,
)
parts = []


def finish(obj, color, mat=dry, bevel=0):
    if mat == dry and color in (LEATHER, LIP):
        mat = leather
    obj.data.materials.append(mat)
    bpy.context.view_layer.objects.active = obj
    if bevel:
        mod = obj.modifiers.new("Handled corners", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        bpy.ops.object.modifier_apply(modifier=mod.name)
        norm = obj.modifiers.new("Weighted planar normals", "WEIGHTED_NORMAL")
        bpy.ops.object.modifier_apply(modifier=norm.name)
    mesh = obj.data
    shade = mesh.color_attributes.new(
        name="Surface", type="BYTE_COLOR", domain="CORNER"
    )
    mesh.color_attributes.active_color = shade
    uv = mesh.uv_layers.active or mesh.uv_layers.new(name="Surface coordinates")
    uv.name = "Surface coordinates"
    # Face tone gives separate planks and curved leather panels subtle changes in finish.
    for face in mesh.polygons:
        bright = rng.uniform(0.94, 1.04)
        axes = sorted(range(3), key=lambda k: abs(face.normal[k]))[:2]
        if mat == dry:
            axes.sort(key=lambda k: obj.dimensions[k], reverse=True)
        for li in face.loop_indices:
            co = mesh.vertices[mesh.loops[li].vertex_index].co
            shade.data[li].color = (*(c * bright for c in color), 1)
            uv.data[li].uv = (co[axes[0]] * 4.8, co[axes[1]] * 4.8)
    parts.append(obj)
    return obj


def box(center, dims, color, mat=dry, bevel=0.006, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    obj = bpy.context.object
    obj.scale = dims
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.rotation_euler = rot
    return finish(obj, color, mat, bevel)


def mesh_object(verts, faces, color, mat=dry, smooth=False):
    mesh = bpy.data.meshes.new("Form")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Form", mesh)
    bpy.context.collection.objects.link(obj)
    for face in mesh.polygons:
        face.use_smooth = smooth
    return finish(obj, color, mat)


def tube(points, radius, color, mat=metal, sides=8, closed=False):
    """Sweep a round section along a bent handle, seam or cast pipe."""
    points = [Vector(p) for p in points]
    verts = []
    count = len(points)
    for n, point in enumerate(points):
        prev = points[(n - 1) % count] if closed else points[max(0, n - 1)]
        nxt = points[(n + 1) % count] if closed else points[min(count - 1, n + 1)]
        tangent = (nxt - prev).normalized()
        ref = Vector((0, 1, 0)) if abs(tangent.y) < 0.9 else Vector((0, 0, 1))
        a = tangent.cross(ref).normalized()
        b = tangent.cross(a).normalized()
        for i in range(sides):
            angle = TAU * i / sides
            verts.append(point + radius * (a * math.cos(angle) + b * math.sin(angle)))
    faces = []
    for n in range(count if closed else count - 1):
        for i in range(sides):
            j = (i + 1) % sides
            k = ((n + 1) % count) * sides
            faces.append((n * sides + i, n * sides + j, k + j, k + i))
    if not closed:
        faces.extend(
            [
                tuple(reversed(range(sides))),
                tuple(range((count - 1) * sides, count * sides)),
            ]
        )
    return mesh_object(verts, faces, color, mat, True)


def hoop(x, y, z, rx, rz, width, color=IRON, mat=metal, start=0, end=TAU):
    full = end - start >= TAU - 0.00001
    count = max(12, math.ceil((end - start) * 4.3))
    return tube(
        [
            (
                x + rx * math.cos(start + (end - start) * i / count),
                y,
                z + rz * math.sin(start + (end - start) * i / count),
            )
            for i in range(count if full else count + 1)
        ],
        width,
        color,
        mat,
        closed=full,
    )


def lathe(x, y, profile, color, mat=metal, n=24):
    verts = [
        (x + r * math.cos(TAU * i / n), y + r * math.sin(TAU * i / n), z)
        for r, z in profile
        for i in range(n)
    ]
    faces = [
        (j * n + i, j * n + (i + 1) % n, (j + 1) * n + (i + 1) % n, (j + 1) * n + i)
        for j in range(len(profile) - 1)
        for i in range(n)
    ]
    faces.extend([tuple(reversed(range(n))), tuple(range(len(verts) - n, len(verts)))])
    return mesh_object(verts, faces, color, mat, True)


def close_model(name):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in parts:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    obj = bpy.context.object
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.name = obj.data.name = name
    parts.clear()


def backing(width, z):
    box((0, -0.026, z), (width, 0.055, 0.105), OAK, bevel=0.009)
    for x in (-width * 0.44, width * 0.44):
        box((x, -0.056, z), (0.022, 0.012, 0.022), RUST, metal, 0.004)


# Three iron shoes, each hung from its heel, and two fitted farrier tools.
backing(1.13, 0.68)
for i, x in enumerate((-0.39, -0.13, 0.15)):
    for offset in (-0.047, 0.047):
        tube([(x + offset, -0.05, 0.64), (x + offset, -0.109, 0.67)], 0.012, IRON)
    hoop(
        x,
        -0.086,
        0.56,
        0.075 + i * 0.005,
        0.105,
        0.018,
        RUST if i == 1 else IRON,
        start=2.28,
        end=7.12,
    )
for x in (0.35, 0.44):
    tube([(x, -0.080, 0.68), (x + 0.015, -0.080, 0.28)], 0.012, IRON)
    box((x + 0.013, -0.077, 0.31), (0.046, 0.029, 0.13), LIP, bevel=0.012)
close_model("farrier-shoe-rack")

# Bridle on a pair of pegs. Flat straps follow an open cheek ring and the low loop of the reins.
backing(1.08, 0.96)
for x, scale in ((-0.27, 1), (0.24, 0.86)):
    tube([(x, -0.035, 0.98), (x, -0.135, 0.98)], 0.027, OAK, dry)
    for off in (-0.09, 0.09):
        tube(
            [
                (x, -0.125, 1.01),
                (x + off, -0.15, 0.90),
                (x + off * 0.85, -0.15, 0.48 * scale),
            ],
            0.015,
            LEATHER,
            dry,
        )
        hoop(x + off * 0.85, -0.15, 0.48 * scale, 0.03, 0.032, 0.007, BRASS)
    hoop(x, -0.139, 0.58, 0.137, 0.37 * scale, 0.012, LIP, dry)
    tube(
        [(x - 0.082, -0.155, 0.64), (x, -0.197, 0.60), (x + 0.082, -0.155, 0.64)],
        0.02,
        LEATHER,
        dry,
    )
close_model("stable-bridles")

# Iron tire, three wooden felloes' worth of rim and twelve spokes around the iron-bound nave.
r = 0.465
cy = -0.086
hoop(0, cy, r, r, r, 0.024, IRON)
hoop(0, cy, r, r - 0.038, r - 0.038, 0.031, OAK, dry)
for i in range(12):
    a = TAU * i / 12 + 0.05
    tube(
        [
            (0.061 * math.cos(a), cy - 0.018, r + 0.061 * math.sin(a)),
            (0.412 * math.cos(a), cy, r + 0.412 * math.sin(a)),
        ],
        0.018,
        OAK,
        dry,
    )
tube([(0, 0.008, r), (0, -0.19, r)], 0.080, OAK, dry, sides=16)
tube([(0, -0.16, r), (0, -0.20, r)], 0.067, IRON, sides=16)
close_model("wheelwright-spare")


def parcel(x, y, bottom, dx, dy, dz, color):
    box((x, y, bottom + dz / 2), (dx, dy, dz), color, cloth, 0.022)
    for offset in (-dx * 0.24, dx * 0.24):
        a = x + offset
        tube(
            [
                (a, y - dy / 2, bottom + 0.006),
                (a, y - dy / 2 - 0.002, bottom + dz - 0.012),
                (a, y - dy / 2 + 0.015, bottom + dz + 0.002),
                (a, y + dy / 2 - 0.015, bottom + dz + 0.002),
                (a, y + dy / 2, bottom + dz - 0.01),
                (a, y + dy / 2, bottom + 0.01),
            ],
            0.004,
            TWINE,
            dry,
            sides=6,
        )
    tube(
        [
            (x - dx / 2, y, bottom + dz - 0.01),
            (x - dx / 2 + 0.015, y, bottom + dz + 0.003),
            (x + dx / 2 - 0.015, y, bottom + dz + 0.003),
            (x + dx / 2, y, bottom + dz - 0.01),
        ],
        0.004,
        TWINE,
        dry,
        sides=6,
    )
    box(
        (x + dx * 0.12, y - 0.045, bottom + dz + 0.003),
        (0.072, 0.054, 0.002),
        (0.78, 0.70, 0.51),
        cloth,
        0,
    )


parcel(-0.14, 0, 0, 0.37, 0.27, 0.15, PAPER)
parcel(0.21, 0.026, 0, 0.26, 0.21, 0.175, (0.41, 0.27, 0.15))
parcel(-0.135, 0.008, 0.154, 0.26, 0.20, 0.09, LINEN)
close_model("cord-bound-parcels")

# Curved doctor-style valise with edge piping, case straps and a raised rolled grip.
box((0, 0, 0.14), (0.53, 0.245, 0.28), LEATHER, bevel=0.042)
box((0, 0, 0.275), (0.404, 0.213, 0.050), LEATHER, bevel=0.022)
for y in (-0.124, 0.124):
    tube(
        [
            (-0.224, y, 0.256),
            (-0.18, y, 0.30),
            (0, y, 0.31),
            (0.18, y, 0.30),
            (0.224, y, 0.256),
        ],
        0.018,
        LIP,
        dry,
    )
for x in (-0.158, 0.158):
    for y in (-0.124, 0.124):
        box((x, y, 0.155), (0.032, 0.012, 0.248), LIP, bevel=0.006)
    box((x, 0, 0.28), (0.034, 0.218, 0.015), LIP, bevel=0.003)
    box((x, -0.133, 0.186), (0.041, 0.007, 0.026), BRASS, metal, 0.004)
tube(
    [
        (-0.077, 0, 0.283),
        (-0.067, 0, 0.34),
        (-0.036, 0, 0.357),
        (0.046, 0, 0.357),
        (0.071, 0, 0.341),
        (0.079, 0, 0.283),
    ],
    0.015,
    LEATHER,
    dry,
)
close_model("travellers-valise")

# Shallow flared ore pan with a rolled rim, sample fragments and a marked split sample sack.
lathe(
    -0.091,
    0,
    [
        (0.128, 0.003),
        (0.18, 0.035),
        (0.194, 0.065),
        (0.195, 0.072),
        (0.187, 0.073),
        (0.161, 0.038),
        (0.119, 0.016),
    ],
    (0.205, 0.195, 0.16),
)
for i in range(11):
    a = i * 2.4
    distance = 0.028 * math.sqrt(i)
    x, y = -0.091 + distance * math.sin(a), distance * math.cos(a)
    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=1, radius=1, location=(x, y, 0.037)
    )
    ob = bpy.context.object
    ob.scale = (0.031, 0.024, 0.029)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    finish(ob, (0.38, 0.29, 0.19) if i % 3 else (0.52, 0.45, 0.31), dry)
parcel(0.235, 0, 0, 0.174, 0.14, 0.085, LINEN)
close_model("assayers-pan")


# Gather cloth at the neck, model the side seam, and tighten twine above the bulging shoulder.
def sack(x, y, height, color, sweep):
    levels = [
        (0, 0.78),
        (0.06, 0.94),
        (0.23, 1),
        (0.55, 0.94),
        (0.72, 0.82),
        (0.84, 0.46),
        (0.89, 0.20),
        (0.98, 0.29),
        (1, 0.24),
    ]
    verts = []
    n = 22
    for z, radius in levels:
        for i in range(n):
            a = i * TAU / n
            fold = (
                1
                + (0.025 + 0.10 * z**2) * math.cos(7 * a + 2 * z)
                + 0.032 * math.cos(3 * a - z)
            )
            verts.append(
                (
                    x + sweep * z * z + 0.218 * radius * fold * math.cos(a),
                    y + 0.165 * radius * fold * math.sin(a),
                    z * height,
                )
            )
    faces = [
        (j * n + i, j * n + (i + 1) % n, (j + 1) * n + (i + 1) % n, (j + 1) * n + i)
        for j in range(len(levels) - 1)
        for i in range(n)
    ]
    faces.extend([tuple(reversed(range(n))), tuple(range(len(verts) - n, len(verts)))])
    mesh_object(verts, faces, color, cloth, True)
    tube([verts[j * n + 16] for j in range(len(levels))], 0.005, LINEN, dry, sides=5)
    z = 0.89 * height
    tube(
        [
            (
                x + 0.89**2 * sweep + 0.050 * math.cos(i * TAU / 14),
                y + 0.039 * math.sin(i * TAU / 14),
                z,
            )
            for i in range(14)
        ],
        0.006,
        TWINE,
        dry,
        closed=True,
    )


sack(-0.10, 0, 0.52, LINEN, 0.042)
sack(0.249, 0.005, 0.39, (0.45, 0.315, 0.186), -0.032)
close_model("gathered-mail-sacks")

# A cast pitcher pump stands on a cross-plank over one end of the stock trough.
box((0, 0, 0.022), (0.31, 0.98, 0.044), OAK, bevel=0.009)
lathe(
    0,
    0,
    [
        (0.115, 0.044),
        (0.115, 0.065),
        (0.090, 0.081),
        (0.067, 0.18),
        (0.064, 0.36),
        (0.072, 0.40),
        (0.083, 0.42),
        (0.085, 0.60),
        (0.092, 0.62),
        (0.077, 0.65),
        (0.050, 0.65),
    ],
    (0.095, 0.178, 0.11),
)
tube(
    [(0, 0, 0.51), (0.09, 0, 0.51), (0.145, 0, 0.52), (0.21, 0, 0.49), (0.25, 0, 0.45)],
    0.032,
    (0.11, 0.18, 0.12),
)
tube(
    [
        (0, 0, 0.64),
        (-0.035, 0, 0.72),
        (-0.105, 0, 0.73),
        (-0.18, 0, 0.65),
        (-0.22, 0, 0.49),
        (-0.295, 0, 0.37),
    ],
    0.018,
    IRON,
)
tube([(-0.215, 0, 0.49), (-0.30, 0, 0.356)], 0.023, LIP, dry)
tube([(0, -0.068, 0.646), (0, 0.068, 0.646)], 0.025, BRASS)
for x in (-0.10, 0.10):
    for y in (-0.415, 0.415):
        lathe(x, y, [(0.011, 0.043), (0.013, 0.045), (0.010, 0.05)], IRON, n=8)
tip = Vector((0.25, 0, 0.45))
axis = Vector((0.04, 0, -0.04)).normalized()
ring_y = Vector((0, 1, 0))
ring_z = axis.cross(ring_y)
tube(
    [
        tip
        + 0.033 * (ring_y * math.cos(TAU * i / 16) + ring_z * math.sin(TAU * i / 16))
        for i in range(16)
    ],
    0.004,
    IRON,
    closed=True,
)
tube(
    [tip + axis * 0.0008, tip + axis * 0.0018],
    0.026,
    (0.023, 0.028, 0.019),
    metal,
    sides=16,
)
close_model("stock-trough-pump")

# Carpenter's handled fore-plane, shallow shaving and wooden folding rule.
box((-0.10, 0, 0.049), (0.285, 0.077, 0.098), OAK, bevel=0.016)
box((-0.082, 0, 0.118), (0.052, 0.053, 0.069), IRON, metal, 0.004, (0, -0.50, 0))
hoop(-0.177, 0, 0.120, 0.040, 0.052, 0.012, LEATHER, dry)
for i in range(3):
    box(
        (0.151, -0.037 + i * 0.029, 0.009 + i * 0.003),
        (0.197, 0.022, 0.012),
        (0.55, 0.39, 0.18),
        dry,
        0.002,
        (0, 0, 0.19 - i * 0.13),
    )
for i in range(2):
    tube(
        [(0.056 + i * 0.18, -0.012, 0.01), (0.056 + i * 0.18, -0.012, 0.029)],
        0.007,
        BRASS,
    )
for i in range(3):
    tube(
        [
            (
                0.04 + 0.017 * t,
                0.081 + 0.015 * i + 0.01 * math.sin(t),
                0.018 + 0.013 * math.cos(t),
            )
            for t in np.linspace(0, 6, 16)
        ],
        0.003,
        OAK,
        dry,
        sides=5,
    )
close_model("joiners-bench-tools")

# Grocer's split-oak basket. Fruit rests inside the sloped staves and the open hoop handle.
for i in range(18):
    a = TAU * i / 18

    def stake(angle, r, z):
        return (r * math.cos(angle), r * math.sin(angle), z)

    half = 0.15
    verts = [
        stake(a - half, 0.128, 0),
        stake(a + half, 0.128, 0),
        stake(a + half, 0.172, 0.210),
        stake(a - half, 0.172, 0.210),
        stake(a - half, 0.119, 0.005),
        stake(a + half, 0.119, 0.005),
        stake(a + half, 0.164, 0.205),
        stake(a - half, 0.164, 0.205),
    ]
    faces = [
        (0, 1, 2, 3),
        (4, 7, 6, 5),
        (0, 4, 5, 1),
        (3, 2, 6, 7),
        (0, 3, 7, 4),
        (1, 5, 6, 2),
    ]
    mesh_object(verts, faces, OAK if i % 3 else LIP)
for radius, z in ((0.135, 0.04), (0.169, 0.188), (0.173, 0.213)):
    tube(
        [
            (radius * math.cos(i * TAU / 30), radius * math.sin(i * TAU / 30), z)
            for i in range(30)
        ],
        0.006,
        TWINE,
        dry,
        closed=True,
    )
hoop(0, 0, 0.211, 0.169, 0.167, 0.009, OAK, dry, start=0, end=math.pi)
for i in range(12):
    a = TAU * i / 9 if i < 9 else TAU * (i - 9) / 3 + 0.28
    r = 0.123 if i < 9 else 0.046
    x, y = r * math.sin(a), r * math.cos(a)
    z = 0.207 if i < 9 else 0.236
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=10, ring_count=6, radius=1, location=(x, y, z)
    )
    obj = bpy.context.object
    obj.scale = (0.041, 0.042, 0.039)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for f in obj.data.polygons:
        f.use_smooth = True
    finish(
        obj, [(0.37, 0.081, 0.041), (0.43, 0.128, 0.042), (0.44, 0.31, 0.085)][i % 3]
    )
    tube([(x, y, z + 0.032), (x + 0.004, y, z + 0.046)], 0.002, TWINE, dry, sides=5)
close_model("grocers-apple-basket")

# Porcelain-faced station clock, shallow enough to fit entirely against a solid wall bay.
tube([(0, -0.005, 0), (0, -0.055, 0)], 0.252, IRON, metal, sides=48)
tube([(0, -0.055, 0), (0, -0.064, 0)], 0.235, (0.72, 0.66, 0.49), dry, sides=48)
hoop(0, -0.066, 0, 0.241, 0.241, 0.011, BRASS)
for i in range(60):
    a = i * TAU / 60
    major = i % 5 == 0
    tip = 0.220
    foot = tip - (0.030 if major else 0.013)
    tube(
        [
            (foot * math.sin(a), -0.066, foot * math.cos(a)),
            (tip * math.sin(a), -0.066, tip * math.cos(a)),
        ],
        0.005 if major else 0.002,
        IRON,
        dry,
        sides=5,
    )
for a, length in ((1.7, 0.14), (-0.82, 0.184)):
    tube(
        [
            (0, -0.071, 0),
            (0.04 * math.sin(a), -0.071, 0.04 * math.cos(a)),
            (length * math.sin(a), -0.071, length * math.cos(a)),
        ],
        0.008,
        IRON,
    )
tube([(0, -0.066, 0), (0, -0.079, 0)], 0.016, BRASS)
close_model("depot-wall-clock")

# Wrought ice tongs and a timber carrying yoke on the shaded wall of the icehouse.
backing(1.14, 0.90)
box((-0.13, -0.076, 0.96), (0.80, 0.083, 0.069), OAK, bevel=0.022, rot=(0, -0.035, 0))
for x in (-0.29, 0.29):
    tube(
        [
            (x, -0.045, 0.896),
            (x, -0.080, 0.841),
            (x, -0.094, 0.793),
            (x, -0.117, 0.817),
        ],
        0.012,
        IRON,
    )
    hoop(x, -0.081, 0.72, 0.060, 0.087, 0.012, RUST)
    for side in (-1, 1):
        tube(
            [
                (x + 0.031 * side, -0.081, 0.645),
                (x + 0.078 * side, -0.092, 0.55),
                (x - 0.079 * side, -0.091, 0.39),
                (x - 0.109 * side, -0.089, 0.286),
                (x - 0.059 * side, -0.093, 0.237),
            ],
            0.013,
            IRON,
        )
    tube([(x, -0.065, 0.49), (x, -0.113, 0.49)], 0.016, BRASS)
close_model("icehouse-tongs")

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=str(OUTPUT),
    export_format="GLB",
    export_yup=True,
    export_vertex_color="ACTIVE",
    export_normals=True,
    export_animations=False,
)
