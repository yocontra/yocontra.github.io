"""Author three period furniture silhouettes. Exports use metres and a floor origin."""

import math
import sys
from pathlib import Path

import bpy

output = Path(sys.argv[sys.argv.index("--") + 1])
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)


def finish(name, rgb, roughness, metal=0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = (*rgb, 1)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metal
    return mat


walnut = finish("Frontier furniture walnut", (0.34, 0.175, 0.085), 0.72)
lip = finish("Frontier furniture polished walnut", (0.48, 0.265, 0.12), 0.49)
oak = finish("Frontier furniture scrubbed oak", (0.59, 0.40, 0.22), 0.75)
cloth = finish("Frontier furniture baize", (0.075, 0.18, 0.108), 0.91)
brass = finish("Frontier furniture brass", (0.46, 0.30, 0.128), 0.44, 0.7)
iron = finish("Frontier furniture cast iron", (0.23, 0.21, 0.185), 0.64, 0.35)
black = finish("Frontier furniture blackened iron", (0.095, 0.091, 0.086), 0.58, 0.4)
cards = finish("Frontier furniture playing cards", (0.75, 0.69, 0.55), 0.86)
cards_back = finish("Frontier furniture card backs", (0.33, 0.06, 0.045), 0.81)

active = None


def mesh(name, coords, faces, mat, *, smooth=False, bevel=0, grain_axis=0):
    data = bpy.data.meshes.new(name)
    data.from_pydata(coords, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.parent = active
    data.materials.append(mat)
    for face in data.polygons:
        face.use_smooth = smooth and len(face.vertices) == 4
    if bevel:
        mod = obj.modifiers.new("Worn edges", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        norm = obj.modifiers.new("Weighted normals", "WEIGHTED_NORMAL")
        norm.keep_sharp = True
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.ops.object.modifier_apply(modifier=norm.name)
    uv = obj.data.uv_layers.new(name="Grain")
    for face in obj.data.polygons:
        normal = [abs(c) for c in face.normal]
        across = max(range(3), key=lambda k: normal[k])
        axes = [k for k in range(3) if k != across]
        if grain_axis in axes:
            axes.remove(grain_axis)
            axes.insert(0, grain_axis)
        for i in face.loop_indices:
            vertex = obj.data.vertices[obj.data.loops[i].vertex_index].co
            uv.data[i].uv = (vertex[axes[0]] / 0.94, vertex[axes[1]] / 0.56)
    return obj


def prism(name, points, bottom, top, mat, bevel=0, grain_axis=0):
    n = len(points)
    verts = [(x, y, z) for z in (bottom, top) for x, y in points]
    faces = [tuple(reversed(range(n))), tuple(range(n, n * 2))]
    faces.extend((i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n))
    return mesh(name, verts, faces, mat, bevel=bevel, grain_axis=grain_axis)


def box(name, x, y, bottom, size, mat, bevel=0.003, *, spin=0, grain_axis=0):
    w, d, h = size
    local = [(-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)]
    c, s = math.cos(spin), math.sin(spin)
    points = [(x + c * px - s * py, y + s * px + c * py) for px, py in local]
    return prism(name, points, bottom, bottom + h, mat, bevel, grain_axis)


def lathe(name, x, y, rings, mat, sides=16):
    vertices = [
        (
            x + r * math.cos(i * math.tau / sides),
            y + r * math.sin(i * math.tau / sides),
            z,
        )
        for z, r in rings
        for i in range(sides)
    ]
    faces = [tuple(reversed(range(sides)))]
    for ring in range(len(rings) - 1):
        for i in range(sides):
            a = ring * sides + i
            b = ring * sides + (i + 1) % sides
            faces.append((a, b, b + sides, a + sides))
    faces.append(tuple(range(len(vertices) - sides, len(vertices))))
    return mesh(name, vertices, faces, mat, smooth=True, grain_axis=2)


def ring(name, outer, inner, bottom, top, mat):
    n = len(outer)
    vertices = [(*p, z) for z in (bottom, top) for loop in (outer, inner) for p in loop]
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.extend(
            [
                (i, j, j + n * 2, i + n * 2),
                (i + n, j + n, j, i),
                (i + n * 2, j + n * 2, j + n * 3, i + n * 3),
                (i + n, i + n * 3, j + n * 3, j + n),
            ]
        )
    return mesh(name, vertices, faces, mat, bevel=0.005)


def octagon(radius, clip):
    r = radius
    c = r - clip
    return [(-c, -r), (c, -r), (r, -c), (r, c), (c, r), (-c, r), (-r, c), (-r, -c)]


def begin(name):
    global active
    active = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(active)


def pack():
    # One mesh per material, shared across all placements.
    groups = {}
    for child in active.children:
        groups.setdefault(child.data.materials[0].name, []).append(child)
    for name, objects in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if len(objects) > 1:
            bpy.ops.object.join()
        objects[0].name = name


begin("saloon-card-table")
outer = octagon(0.75, 0.125)
inner = octagon(0.612, 0.104)
prism("Solid walnut top", outer, 0.735, 0.776, walnut, 0.010)
ring("Hand polished rail", outer, inner, 0.772, 0.80, lip)
prism("Inset wool baize", inner, 0.765, 0.787, cloth, 0.004)
ring(
    "Apron with chased lower edge",
    octagon(0.62, 0.12),
    octagon(0.57, 0.107),
    0.642,
    0.738,
    walnut,
)
for x in (-0.49, 0.49):
    for y in (-0.49, 0.49):
        lathe(
            "Turned walnut leg",
            x,
            y,
            [
                (0, 0.046),
                (0.024, 0.055),
                (0.074, 0.049),
                (0.129, 0.035),
                (0.34, 0.044),
                (0.44, 0.082),
                (0.49, 0.063),
                (0.54, 0.052),
                (0.555, 0.077),
                (0.603, 0.065),
                (0.684, 0.064),
                (0.74, 0.061),
            ],
            walnut,
        )
        lathe("Recessed brass pin", x, y, [(0.79, 0.015), (0.80, 0.015)], brass, 10)
for i, (x, y, spin) in enumerate(
    (
        (-0.26, 0.23, 0.4),
        (-0.15, 0.24, 0.29),
        (0.09, -0.36, -0.35),
        (0.15, -0.34, -0.19),
    )
):
    box(
        "Dog eared card",
        x,
        y,
        0.787 + (i % 2) * 0.0015,
        (0.065, 0.09, 0.0017),
        cards,
        0,
        spin=spin,
    )
    box(
        "Inset card back",
        x,
        y,
        0.789 + (i % 2) * 0.0015,
        (0.052, 0.077, 0.0008),
        cards_back,
        0,
        spin=spin,
    )
pack()

begin("scrubbed-work-table")
for i, y in enumerate((-0.375, -0.125, 0.125, 0.375)):
    box(
        "Jointed oak plank",
        0,
        y,
        0.737,
        (2, 0.249, 0.063),
        oak if i % 2 == 0 else lip,
        0.008,
    )
for x in (-0.91, 0.91):
    for y in (-0.41, 0.41):
        box(
            "Bevelled oak leg",
            x,
            y,
            0,
            (0.115, 0.112, 0.755),
            walnut,
            0.013,
            grain_axis=2,
        )
        box("Tenon pin", x, y, 0.681, (0.028, 0.117, 0.029), lip, 0.002)
for y in (-0.41, 0.41):
    box("Long mortised apron", 0, y, 0.587, (1.79, 0.056, 0.15), walnut, 0.012)
for x in (-0.91, 0.91):
    box("Short apron", x, 0, 0.587, (0.053, 0.80, 0.15), walnut, 0.009, grain_axis=1)
    box(
        "Trestle end stretcher",
        x,
        0,
        0.215,
        (0.061, 0.81, 0.073),
        lip,
        0.011,
        grain_axis=1,
    )
box("Through stretcher", 0, 0, 0.233, (1.90, 0.085, 0.077), walnut, 0.012)
pack()

begin("potbelly-stove")
for x in (-0.25, 0.25):
    for y in (-0.25, 0.25):
        lathe(
            "Cast splayed foot",
            x,
            y,
            [(0, 0.071), (0.025, 0.079), (0.059, 0.052), (0.153, 0.04), (0.20, 0.061)],
            iron,
        )
lathe(
    "Cast fire body",
    0,
    0,
    [
        (0.13, 0.318),
        (0.168, 0.37),
        (0.205, 0.362),
        (0.249, 0.297),
        (0.332, 0.33),
        (0.42, 0.38),
        (0.503, 0.40),
        (0.578, 0.37),
        (0.658, 0.29),
        (0.71, 0.269),
        (0.743, 0.344),
        (0.774, 0.369),
        (0.80, 0.355),
    ],
    black,
    28,
)
for z, r in ((0.185, 0.366), (0.317, 0.329), (0.57, 0.381), (0.732, 0.331)):
    lathe(
        "Raised cast seam",
        0,
        0,
        [(z, r - 0.012), (z + 0.012, r + 0.012), (z + 0.024, r - 0.012)],
        iron,
        24,
    )
lathe(
    "Detachable cooking lid",
    -0.088,
    -0.024,
    [(0.798, 0.149), (0.812, 0.154), (0.821, 0.138)],
    iron,
    24,
)
lathe("Lid lifter socket", -0.088, -0.024, [(0.82, 0.025), (0.826, 0.029)], black, 12)
lathe(
    "Stovepipe collar",
    0.112,
    0.082,
    [(0.795, 0.102), (0.827, 0.106), (0.869, 0.080)],
    iron,
    20,
)
lathe(
    "Black iron stovepipe",
    0.112,
    0.082,
    [(0.85, 0.068), (1.075, 0.068), (1.09, 0.074), (1.10, 0.074)],
    black,
    20,
)
box("Cast door frame", 0, -0.348, 0.379, (0.385, 0.086, 0.257), iron, 0.027)
box("Inset raised fire door", 0, -0.394, 0.399, (0.303, 0.044, 0.213), black, 0.023)
for x in (-0.151, 0.152):
    for z in (0.424, 0.549):
        lathe("Door rivet", x, -0.423, [(z, 0.012), (z + 0.029, 0.012)], brass, 8)
box("Vent register", -0.024, -0.424, 0.413, (0.152, 0.028, 0.051), iron, 0.009)
for x in (-0.074, -0.051, -0.028, -0.005, 0.018):
    box("Vent opening", x, -0.441, 0.425, (0.011, 0.005, 0.026), black, 0.001)
box("Door latch", 0.105, -0.442, 0.504, (0.115, 0.039, 0.024), iron, 0.009, spin=0.13)
lathe("Latch finial", 0.153, -0.452, [(0.49, 0.017), (0.521, 0.018)], brass, 12)
pack()

output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=str(output.resolve()),
    export_format="GLB",
    export_yup=True,
    export_cameras=False,
    export_lights=False,
)
