"""Model porch posts within Perdition's existing 160 mm support envelopes."""

import math
import sys
from pathlib import Path

import bpy

output = Path(sys.argv[sys.argv.index("--") + 1])
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)


def profile(name, stations, corners):
    vertices = []
    for height, width, chamfer in stations:
        edge = width - chamfer
        if corners == 8:
            corners_xy = [
                (-edge, -width), (edge, -width), (width, -edge), (width, edge),
                (edge, width), (-edge, width), (-width, edge), (-width, -edge),
            ]
        else:
            corners_xy = [
                (width * math.cos(i * math.tau / corners), width * math.sin(i * math.tau / corners))
                for i in range(corners)
            ]
        vertices.extend((x, y, height) for x, y in corners_xy)
    faces = [tuple(reversed(range(corners)))]
    for row in range(len(stations) - 1):
        bottom = row * corners
        top = bottom + corners
        for i in range(corners):
            j = (i + 1) % corners
            faces.append((bottom + i, bottom + j, top + j, top + i))
    faces.append(tuple((len(stations) - 1) * corners + i for i in range(corners)))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    post = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(post)
    return post


def bracket(parent, turned):
    """Pair of knee braces above standing clearance, pegged into the capital."""
    arc = [
        (0.052, 2.56), (0.085, 2.57), (0.120, 2.69), (0.172, 2.77),
        (0.248, 2.85), (0.317, 2.89), (0.405, 2.91),
        (0.405, 3.039), (0.052, 3.039),
    ]
    bevel = 0.004
    if not turned:
        arc = [(0.052, 2.64), (0.371, 2.912), (0.371, 3.039), (0.052, 3.039)]
    vertices, faces = [], []
    for side in (-1, 1):
        offset = len(vertices)
        count = len(arc)
        contour = arc if side > 0 else list(reversed(arc))
        vertices.extend((side * x, y, h) for y in (-0.032, 0.032) for x, h in contour)
        faces.append(tuple(offset + i for i in range(count)))
        faces.append(tuple(offset + count + i for i in reversed(range(count))))
        for i in range(count):
            j = (i + 1) % count
            faces.append((offset + i, offset + i + count, offset + j + count, offset + j))
    mesh = bpy.data.meshes.new("Carved timber knee braces")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    brace = bpy.data.objects.new("Knee braces", mesh)
    bpy.context.collection.objects.link(brace)
    brace.parent = parent
    edge = brace.modifiers.new("Worn arris", "BEVEL")
    edge.width = bevel
    edge.segments = 2


def post(name, details, turned):
    root = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(root)
    cap = [
        (0, 0.075, 0.003), (0.018, 0.080, 0.004), (0.164, 0.080, 0.006),
        (0.178, 0.072, 0.007), (0.187, 0.068, 0.009),
    ]
    base = profile("Foot block", cap, 8)
    base.parent = root
    capital = profile("Cornice seat", [(3.04 - y, w, c) for y, w, c in reversed(cap)], 8)
    capital.parent = root
    stem = profile("Turned shaft" if turned else "Chamfered shaft", details, 16 if turned else 8)
    stem.parent = root
    bracket(root, turned)


post("shop-porch-post", [
    (0.165, 0.066, 0.008), (0.25, 0.071, 0.012), (0.51, 0.068, 0.012),
    (0.58, 0.066, 0.018), (2.52, 0.058, 0.018), (2.63, 0.068, 0.012),
    (2.875, 0.069, 0.010),
], False)

post("saloon-porch-post", [
    (0.164, 0.067, 0), (0.245, 0.072, 0), (0.275, 0.073, 0),
    (0.305, 0.060, 0), (0.36, 0.049, 0), (0.49, 0.058, 0),
    (0.53, 0.063, 0), (0.56, 0.057, 0), (0.605, 0.054, 0),
    (0.68, 0.056, 0), (2.18, 0.050, 0), (2.30, 0.057, 0),
    (2.34, 0.065, 0), (2.37, 0.067, 0), (2.40, 0.059, 0),
    (2.58, 0.052, 0), (2.65, 0.057, 0), (2.69, 0.072, 0),
    (2.73, 0.075, 0), (2.76, 0.062, 0), (2.89, 0.065, 0),
], True)

post("service-porch-post", [
    (0.17, 0.070, 0.004), (0.27, 0.074, 0.008), (0.42, 0.072, 0.008),
    (0.49, 0.069, 0.014), (2.61, 0.064, 0.014), (2.76, 0.071, 0.006),
    (2.885, 0.074, 0.004),
], False)

output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(output), export_format="GLB", export_yup=True)
