"""Sculpt open leather pockets over the current fitted holster seats."""

import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

destination = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
destination.mkdir(parents=True, exist_ok=True)


def material(name, value, roughness, metal=0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (value, value, value, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metal
    m.use_backface_culling = False
    return m


def shell(name, points, faces, coords, mat):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(x, -z, y) for x, y, z in points], [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    mesh.materials.append(mat)
    uv = mesh.uv_layers.new(name="Finished leather")
    for face in mesh.polygons:
        face.use_smooth = len(face.vertices) == 4
        for loop in face.loop_indices:
            uv.data[loop].uv = coords[mesh.loops[loop].vertex_index]
    return obj


def pocket(side, profile):
    mouth, heel = {
        "Right": ((-0.21910, 0.80530, -0.10804), (-0.25390, 0.61540, -0.10600)),
        "Left": ((0.20757, 0.85020, -0.08566), (0.20338, 0.68365, 0.02192)),
    }[side]
    top, bottom = Vector(mouth), Vector(heel)
    axis = (bottom - top).normalized()
    x = Vector((1, 0, 0))
    across = (x - axis * x.dot(axis)).normalized()
    depth = across.cross(axis).normalized()
    outer = material("Rolled leather", 0.94, 0.7)
    rim = material("Dark bound rim", 0.54, 0.75)
    thread = material(
        "Waxed thread", 0.68 if profile == "plain-leather" else 0.58, 0.86
    )
    n = 40

    def surface(t, f, padding=0):
        center = top.lerp(bottom, f)
        rx = (0.0355 * (1 - f) + 0.0208 * f) + 0.0015 * math.sin(f * math.pi)
        rz = (0.0362 * (1 - f) + 0.0242 * f) + 0.0012 * math.sin(f * math.pi * 3)
        saddle = 0.0033 * math.sin(t * 2 + 0.12) * (1 - f) ** 7
        if profile == "buscadero":
            rz += 0.0038 * math.sin(math.pi * f)
        if profile == "tooled-floral":
            rx -= 0.0017 * math.sin(math.pi * f)
        radius = 1 + 0.018 * math.sin(t * 4 + f * 5)
        p = (
            center
            + (rx + padding) * math.cos(t) * across * radius
            + (rz + padding) * math.sin(t) * depth * radius
        )
        return p + saddle * axis

    def rings(name, steps, mat, seal=False):
        points = [
            surface(i * math.tau / n, f, padding)
            for f, padding in steps
            for i in range(n)
        ]
        coords = [(i / n, f) for f, _ in steps for i in range(n)]
        faces = []
        for j in range(len(steps) - 1):
            for i in range(n):
                a = j * n + i
                b = j * n + (i + 1) % n
                faces.append((a, a + n, b + n, b))
        if seal:
            faces.append(tuple(reversed(range(len(points) - n, len(points)))))
        shell(side + " " + name, points, faces, coords, mat)

    rings(
        "formed leather pocket",
        [
            (0, 0.0005),
            (0.045, 0.0018),
            (0.13, 0.0014),
            (0.32, 0),
            (0.56, 0),
            (0.78, -0.0003),
            (0.92, -0.0009),
            (1, -0.002),
        ],
        outer,
        True,
    )
    rings(
        "turned mouth binding",
        [
            (0, 0.0014),
            (-0.009, 0.0015),
            (-0.017, 0.0003),
            (-0.010, -0.0017),
            (0.013, -0.0024),
            (0.084, -0.0028),
        ],
        rim,
    )
    rings("sewn welt", [(0.034, 0.0022), (0.048, 0.0027), (0.065, 0.0020)], outer)

    outside = math.pi if side == "Right" else 0
    silver = material("Cast silver conchos", 0.58, 0.43, 0.77)
    tooling = material("Burnished floral embossing", 0.51, 0.66)
    if profile == "silver-conchos":
        for f in (0.27, 0.43, 0.59, 0.75):
            origin = surface(outside, f, 0.0033)
            facing = across * (-1 if side == "Right" else 1)
            points = [origin]
            for i in range(20):
                t = i * math.tau / 20
                r = 0.0049 + 0.0014 * math.cos(5 * t)
                points.append(
                    origin
                    + r * (math.cos(t) * axis + math.sin(t) * depth)
                    - 0.0011 * facing
                )
            faces = [(0, 1 + (i + 1) % 20, 1 + i) for i in range(20)]
            if side == "Left":
                faces = [tuple(reversed(face)) for face in faces]
            shell(
                side + " scalloped silver concho",
                points,
                faces,
                [(0.5, 0.5)] * len(points),
                silver,
            )
    if profile == "tooled-floral":
        for f in (0.25, 0.42, 0.59, 0.76):
            for flower in (0, 0.3):
                points = []
                coord = []
                for band in (0, 0.0017):
                    for i in range(24):
                        t = i * math.tau / 24
                        r = 0.1 + 0.034 * math.cos(t * 5) + band * 42
                        angle = outside + flower + r * math.cos(t)
                        progress = f + r * 0.41 * math.sin(t)
                        points.append(surface(angle, progress, 0.0016))
                        coord.append((0.5, progress))
                faces = [
                    (i, (i + 1) % 24, (i + 1) % 24 + 24, i + 24) for i in range(24)
                ]
                shell(side + " tooled rosette", points, faces, coord, tooling)
    if profile == "buscadero":
        rings(
            "Rolled leather keeper",
            [(0.13, 0.0009), (0.136, 0.0028), (0.184, 0.0027), (0.19, 0.0009)],
            rim,
        )
        rings(
            "Rawhide toe binding",
            [(0.82, 0.0011), (0.83, 0.0023), (0.893, 0.0022), (0.904, 0.0008)],
            rim,
        )

    anchor = Vector(
        (-0.165, 0.912, -0.107) if side == "Right" else (0.178, 0.912, -0.082)
    )
    attachment = surface(outside + math.pi, 0.096, -0.001)
    points = []
    coords = []
    faces = []
    for i in range(9):
        f = i / 8
        p = anchor.lerp(attachment, f)
        width = 0.022 * (1 - 0.11 * f)
        side_sign = -1 if side == "Right" else 1
        p.x += side_sign * 0.008 * math.sin(f * math.pi)
        for x, z in (
            (-0.002, -width),
            (0.002, -width),
            (0.002, width),
            (-0.002, width),
        ):
            points.append(p + Vector((x, 0, z)))
            coords.append((0.5 + z * 18, f))
        if i:
            j = i * 4
            for segment in range(4):
                a = j + segment
                b = j + (segment + 1) % 4
                faces.append((a - 4, b - 4, b, a))
    faces.extend([(3, 2, 1, 0), (32, 33, 34, 35)])
    shell(side + " stitched belt hanger", points, faces, coords, outer)

    # The saddle stitch follows the actual formed front, including the flexed toe.
    point_rows, faces, coords = [], [], []
    for theta in (0.30, 2.85) if profile == "buscadero" else (0.32,):
        for i in range(24):
            f = 0.063 + i * 0.038
            b = len(point_rows)
            for wiggle, progress in (
                (-0.014, f),
                (0.014, f + 0.003),
                (0.014, f + 0.018),
                (-0.014, f + 0.015),
            ):
                point_rows.append(surface(theta + wiggle + 0.09 * f, progress, 0.0012))
                coords.append((theta / math.tau, progress))
            faces.append((b, b + 3, b + 2, b + 1))
    shell(side + " saddle stitch", point_rows, faces, coords, thread)


for profile in ("plain-leather", "silver-conchos", "tooled-floral", "buscadero"):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for data in list(bpy.data.meshes):
        if not data.users:
            bpy.data.meshes.remove(data)
    for old in list(bpy.data.materials):
        if not old.users:
            bpy.data.materials.remove(old)
    pocket("Right", profile)
    pocket("Left", profile)
    bpy.ops.export_scene.gltf(
        filepath=str(destination / f"{profile}.glb"),
        export_format="GLB",
        export_yup=True,
    )
