"""Author forged rowels, necks and bands in the fitted boot accessory space."""

import math
import sys
from pathlib import Path

import bpy

destination = Path(sys.argv[sys.argv.index("--") + 1]).resolve()


def material(name, rgb, roughness, metal):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metal
    return m


def face_mesh(name, points, faces, mat):
    # glTF x/z define the rowel's plane. Blender's Y/Z differ at export.
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(x, -z, y) for x, y, z in points], [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    mesh.materials.append(mat)
    uv = mesh.uv_layers.new(name="Forging direction")
    for p in mesh.polygons:
        p.use_smooth = len(p.vertices) == 4
        for j in p.loop_indices:
            x, _, z = points[mesh.loops[j].vertex_index]
            uv.data[j].uv = (0.5 + x * 16, 0.36 + z * 11)
    return obj


def disk(name, radial, z, height, bevel, mat):
    n = len(radial)
    points = []
    for y, inset in [
        (-height, bevel),
        (-height + bevel, 0),
        (height - bevel, 0),
        (height, bevel),
    ]:
        for j, r in enumerate(radial):
            t = j * math.tau / n
            points.append(((r - inset) * math.cos(t), y, z + (r - inset) * math.sin(t)))
    faces = [tuple(range(n))]
    for row in range(3):
        for j in range(n):
            a = row * n + j
            b = row * n + (j + 1) % n
            faces.append((a, a + n, b + n, b))
    faces.append(tuple(reversed(range(len(points) - n, len(points)))))
    return face_mesh(name, points, faces, mat)


def band(name, radial, spread, height, mat):
    n = 28
    points = []
    for inner in (False, True):
        for top in (False, True):
            for j in range(n):
                t = -0.96 + j / (n - 1) * 1.92
                r = radial - (spread if inner else 0)
                points.append(
                    (
                        r * math.sin(t),
                        height if top else -height,
                        0.022 + r * math.cos(t),
                    )
                )
    faces = [(0, n, n * 3, n * 2), (n - 1, n * 3 - 1, n * 4 - 1, n * 2 - 1)]
    for j in range(n - 1):
        faces.extend(
            [
                (j, j + 1, j + 1 + n, j + n),
                (j + 2 * n, j + 3 * n, j + 1 + 3 * n, j + 1 + 2 * n),
                (j + n, j + 1 + n, j + 1 + 3 * n, j + 3 * n),
                (j, j + 2 * n, j + 1 + 2 * n, j + 1),
            ]
        )
    return face_mesh(name, points, faces, mat)


def neck(mat):
    return face_mesh(
        "Curved fork neck",
        [
            (-0.007, -0.004, 0.006),
            (0.007, -0.004, 0.006),
            (0.012, -0.004, 0.029),
            (0.012, -0.004, 0.041),
            (-0.012, -0.004, 0.041),
            (-0.012, -0.004, 0.029),
            (-0.007, 0.004, 0.006),
            (0.007, 0.004, 0.006),
            (0.012, 0.004, 0.029),
            (0.012, 0.004, 0.041),
            (-0.012, 0.004, 0.041),
            (-0.012, 0.004, 0.029),
        ],
        [(5, 4, 3, 2, 1, 0), (6, 7, 8, 9, 10, 11)]
        + [(i, (i + 1) % 6, (i + 1) % 6 + 6, i + 6) for i in range(6)],
        mat,
    )


styles = {
    "plain-rowels": (8, 0.030, 0.021, (0.18, 0.17, 0.15), 0.53),
    "silver-jinglebobs": (10, 0.030, 0.0215, (0.50, 0.49, 0.44), 0.34),
    "star-rowels": (5, 0.030, 0.0145, (0.25, 0.22, 0.17), 0.40),
    "legend-rowels": (12, 0.029, 0.024, (0.42, 0.29, 0.125), 0.39),
}
destination.mkdir(parents=True, exist_ok=True)
for name, (teeth, tip, valley, color, roughness) in styles.items():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for mesh in list(bpy.data.meshes):
        if not mesh.users:
            bpy.data.meshes.remove(mesh)
    for old in list(bpy.data.materials):
        if not old.users:
            bpy.data.materials.remove(old)
    iron = material(
        "Blackened spur steel", tuple(c * 0.53 for c in color), roughness + 0.07, 0.74
    )
    wheel = material("Forged rowel", color, roughness, 0.84)
    worn = material(
        "Burnished spindle and strap pins", tuple(c * 1.09 for c in color), 0.40, 0.82
    )
    outline = []
    for _ in range(teeth):
        outline.extend([valley, tip - 0.0028, tip, tip - 0.0028, valley])
    disk("Beveled rowel wheel", outline, 0, 0.0034, 0.001, wheel)
    disk("Raised rowel hub", [0.0104] * 20, 0, 0.0046, 0.0014, iron)
    disk("Turned axle pin", [0.0049] * 16, 0, 0.006, 0.0007, worn)
    neck(iron)
    band("Rolled yoke", 0.030, 0.005, 0.0048, wheel)
    band("Forged yoke rib", 0.031, 0.0016, 0.0023, worn)
    if name == "silver-jinglebobs":
        for z in (0.010, 0.022):
            disk("Loose silver jingle disc", [0.0066] * 16, z, 0.009, 0.0008, worn)
    bpy.ops.export_scene.gltf(
        filepath=str(destination / f"{name}.glb"), export_format="GLB", export_yup=True
    )
