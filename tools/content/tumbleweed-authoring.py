"""Build two dry, open tumbleweeds with curved stems and forked twig silhouettes."""

import math
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def points_along(start, end, bend, sections):
    return [start.lerp(end, i / sections) + bend * math.sin(math.pi * i / sections) for i in range(sections + 1)]


def branch(vertices, faces, colors, path, thickness, color):
    start = len(vertices)
    sides = 5
    for i, point in enumerate(path):
        t = i / (len(path) - 1)
        axis = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        reference = Vector((0, 0, 1)) if abs(axis.z) < 0.89 else Vector((0, 1, 0))
        u = axis.cross(reference).normalized()
        v = axis.cross(u).normalized()
        radius = thickness * (1 - t * 0.86)
        gain = 0.81 + 0.24 * t
        for k in range(sides):
            angle = k * math.tau / sides
            vertices.append(point + (u * math.cos(angle) + v * math.sin(angle)) * radius)
            colors.append(tuple(channel * gain for channel in color) + (1,))
    faces.append(tuple(reversed(range(start, start + sides))))
    for i in range(len(path) - 1):
        r = start + i * sides
        for k in range(sides):
            j = (k + 1) % sides
            faces.append((r + k, r + j, r + j + sides, r + k + sides))
    end = start + (len(path) - 1) * sides
    faces.append(tuple(range(end, end + sides)))


def tumbleweed(name, seed):
    rng = random.Random(seed)
    vertices, faces, colors = [], [], []
    golden = math.pi * (3 - math.sqrt(5))
    stem_count = 20
    tips = []
    for index in range(stem_count):
        z = 2 * ((index + 0.5) / stem_count) - 1
        angle = (index + rng.uniform(-0.17, 0.17)) * golden
        radial = math.sqrt(1 - z * z)
        end = Vector((radial * math.cos(angle), radial * math.sin(angle), z)).normalized()
        tangent = end.cross(Vector((0, 0, 1))).normalized()
        bend = (tangent + end.cross(tangent) * rng.uniform(-0.42, 0.66)) * rng.uniform(0.03, 0.072)
        # The dried crown has a low root knot and a loose, irregular shell.
        base = end * rng.uniform(0.024, 0.065) + Vector((0.01, 0, -0.053))
        tip = end * rng.uniform(0.309, 0.371)
        roots = points_along(base, tip, bend, 6)
        tips.append(roots[5])
        shade = rng.uniform(0.70, 0.92)
        branch(vertices, faces, colors, roots, rng.uniform(0.0046, 0.0063), (shade, shade * 0.86, shade * 0.67))
        for j in range(2, 6):
            sign = -1 if (j + index) % 2 else 1
            outward = (end * 0.45 + tangent * sign + end.cross(tangent) * rng.uniform(-0.80, 0.80)).normalized()
            end_point = roots[j] + outward * rng.uniform(0.067, 0.127)
            if end_point.length > 0.366:
                end_point.length = 0.366
            twig = points_along(roots[j], end_point, -bend * 0.30, 3)
            branch(vertices, faces, colors, twig, rng.uniform(0.0022, 0.0033), (0.72, 0.63, 0.48))
            tip_out = (outward * 0.60 + end * 0.40 + end.cross(tangent) * -sign * 0.42).normalized()
            fork_tip = twig[1] + tip_out * rng.uniform(0.047, 0.080)
            if fork_tip.length > 0.366:
                fork_tip.length = 0.366
            fork = points_along(twig[1], fork_tip, -tangent * sign * 0.012, 3)
            branch(vertices, faces, colors, fork, 0.00195, (0.82, 0.74, 0.58))
    # Side shoots bow around the outside instead of all pointing away from the root.
    for index, a in enumerate(tips):
        b = min((point for point in tips if point is not a), key=lambda point: (point - a).length_squared)
        if index % 4 == 0:
            continue
        end = a.lerp(b, rng.uniform(0.62, 0.97))
        outward = ((a + b) * 0.5).normalized()
        link = points_along(a, end, outward * rng.uniform(0.025, 0.047), 5)
        for point in link:
            if point.length > 0.369:
                point.length = 0.369
        branch(vertices, faces, colors, link, 0.0023, (0.62, 0.48, 0.33))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    mesh.shade_smooth()
    tint = mesh.color_attributes.new(name="Sun-dried straw", type="FLOAT_COLOR", domain="POINT")
    for i, color in enumerate(colors):
        tint.data[i].color = color
    uv = mesh.uv_layers.new(name="Bark along the stem")
    for face in mesh.polygons:
        for i in face.loop_indices:
            x, y, z = mesh.vertices[mesh.loops[i].vertex_index].co
            uv.data[i].uv = ((x + y) * 6.2, z * 7.4)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)


def main():
    output = Path(sys.argv[sys.argv.index("--") + 1])
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    tumbleweed("Perdition dry tumbleweed", 117)
    tumbleweed("Duel dry tumbleweed", 519)
    bpy.ops.export_scene.gltf(
        filepath=str(output), export_format="GLB", export_yup=True,
        export_vertex_color="ACTIVE", export_vertex_color_name="Sun-dried straw",
    )


if __name__ == "__main__":
    main()
