"""Sculpt nonfunctional held-game silhouettes in their existing visual bind space."""

import math
import sys
from pathlib import Path

import bpy

destination = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
destination.mkdir(parents=True, exist_ok=True)


def finish(name, rgb, roughness, metal=0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metal
    return mat


def loft(name, rings, mat, samples=24, contour=1.0):
    points = []
    for x, low, high, center, half_width in rings:
        for i in range(samples):
            t = i * math.tau / samples
            v = math.sin(t)
            w = math.cos(t)
            height = (high + low) * 0.5 + math.copysign(abs(v) ** contour, v) * (
                high - low
            ) * 0.5
            lateral = center + math.copysign(abs(w) ** contour, w) * half_width
            points.append((x, -lateral, height))
    faces = [tuple(range(samples))]
    for row in range(len(rings) - 1):
        for i in range(samples):
            a = row * samples + i
            b = row * samples + (i + 1) % samples
            faces.append((a, a + samples, b + samples, b))
    faces.append(tuple(reversed(range(len(points) - samples, len(points)))))
    data = bpy.data.meshes.new(name)
    data.from_pydata(points, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    data.materials.append(mat)
    uv = data.uv_layers.new(name="Surface grain")
    for poly in data.polygons:
        poly.use_smooth = len(poly.vertices) == 4
        for loop in poly.loop_indices:
            vertex = data.loops[loop].vertex_index
            x, _, height = points[vertex]
            uv.data[loop].uv = (
                (x + 1) * 0.5,
                0.5 + height * 2.07 + 0.018 * math.sin(vertex % samples),
            )
    return obj


def block(name, x, y, z, length, height, width, mat, bevel):
    return loft(
        name,
        [
            (
                x - length / 2,
                y - height / 2 + bevel,
                y + height / 2 - bevel,
                z,
                width / 2 - bevel,
            ),
            (x - length / 2 + bevel, y - height / 2, y + height / 2, z, width / 2),
            (x + length / 2 - bevel, y - height / 2, y + height / 2, z, width / 2),
            (
                x + length / 2,
                y - height / 2 + bevel,
                y + height / 2 - bevel,
                z,
                width / 2 - bevel,
            ),
        ],
        mat,
        12,
        0.25,
    )


def reset():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for data in list(bpy.data.meshes):
        if not data.users:
            bpy.data.meshes.remove(data)
    for mat in list(bpy.data.materials):
        if not mat.users:
            bpy.data.materials.remove(mat)


def rifle():
    stock = finish("Oiled walnut", (0.22, 0.105, 0.047), 0.55)
    metal = finish("Blued steel", (0.075, 0.092, 0.105), 0.49, 0.79)
    edge = finish("Polished edge metal", (0.17, 0.17, 0.15), 0.44, 0.82)
    loft(
        "Walnut fore-end",
        [
            (-0.153, 0.043, 0.125, 0, 0.029),
            (-0.121, 0.030, 0.126, 0, 0.033),
            (0.06, 0.044, 0.124, 0, 0.033),
            (0.29, 0.049, 0.126, 0, 0.0325),
            (0.416, 0.057, 0.13, 0, 0.031),
            (0.482, 0.064, 0.131, 0, 0.027),
        ],
        stock,
        24,
        0.60,
    )
    loft(
        "Long upper silhouette",
        [
            (-0.285, 0.111, 0.152, 0, 0.020),
            (-0.04, 0.105, 0.149, 0, 0.021),
            (0.27, 0.105, 0.146, 0, 0.021),
            (0.79, 0.106, 0.141, 0, 0.017),
            (1, 0.112, 0.139, 0, 0.014),
        ],
        metal,
        28,
        0.52,
    )
    block("Fore-end binding", 0.382, 0.111, 0, 0.042, 0.064, 0.065, edge, 0.005)


def shotgun():
    stock = finish("Rubbed dark walnut", (0.255, 0.122, 0.051), 0.52)
    metal = finish("Satin barrel steel", (0.111, 0.128, 0.138), 0.38, 0.83)
    for offset in (-0.022, 0.022):
        loft(
            "Side by side barrel silhouette",
            [
                (-0.19, 0.078, 0.144, offset, 0.029),
                (0.04, 0.088, 0.140, offset, 0.026),
                (0.28, 0.089, 0.141, offset, 0.025),
                (0.82, 0.094, 0.139, offset, 0.023),
                (1, 0.100, 0.137, offset, 0.019),
            ],
            metal,
            26,
            0.88,
        )
    loft(
        "Rounded supporting fore-end",
        [
            (-0.011, 0.047, 0.102, 0, 0.039),
            (0.044, 0.033, 0.107, 0, 0.045),
            (0.201, 0.036, 0.106, 0, 0.047),
            (0.308, 0.058, 0.109, 0, 0.040),
            (0.354, 0.071, 0.114, 0, 0.035),
        ],
        stock,
        26,
        0.56,
    )
    block("Top sight line", 0.449, 0.142, 0, 1.011, 0.015, 0.013, metal, 0.003)


for name, model in (("rifle", rifle), ("shotgun", shotgun)):
    reset()
    model()
    bpy.ops.export_scene.gltf(
        filepath=str(destination / f"{name}.glb"), export_format="GLB", export_yup=True
    )
