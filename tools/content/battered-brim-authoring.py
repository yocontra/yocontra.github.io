"""Build the starter hat with a pinched crown, stitched edge and separate leather band."""

import math
import sys
from pathlib import Path

import bpy

out = Path(sys.argv[sys.argv.index("--") + 1])
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
segments = 64


def material(name, color, roughness, metal=0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metal
    return mat


felt = material("Brim felt", (0.61, 0.52, 0.43), 0.85)
edge = material("Brim binding", (0.29, 0.20, 0.135), 0.87)
leather = material("Band leather", (0.125, 0.063, 0.034), 0.69)
thread = material("Band thread", (0.33, 0.255, 0.17), 0.83)
buckle = material("Band buckle", (0.42, 0.30, 0.15), 0.46, 0.68)


def surface(name, rings, steps, mat, invert=False, seal=False):
    verts = [ring(i * math.tau / steps) for ring in rings for i in range(steps)]
    faces = []
    for j in range(len(rings) - 1):
        for i in range(steps):
            a = j * steps + i
            b = j * steps + (i + 1) % steps
            face = (a, b, b + steps, a + steps)
            faces.append(face[::-1] if invert else face)
    if seal:
        faces.append(tuple(range(len(verts) - steps, len(verts))))
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    data.materials.append(mat)
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    uv = data.uv_layers.new(name="Felt")
    for face in data.polygons:
        face.use_smooth = len(face.vertices) == 4
        base = min(data.loops[i].vertex_index % steps for i in face.loop_indices)
        for j in face.loop_indices:
            index = data.loops[j].vertex_index
            t = index % steps
            if (
                base == 0
                and t == 0
                and any(
                    data.loops[i].vertex_index % steps == steps - 1
                    for i in face.loop_indices
                )
            ):
                t = steps
            uv.data[j].uv = (t / steps, (index // steps) / (len(rings) - 1))
    return obj


def brim(t, radius, offset=0):
    x, y = math.cos(t), math.sin(t)
    rx = 0.084 + radius * 0.092
    ry = 0.097 + radius * 0.090
    side = 0.038 * (abs(x) ** 4)
    slope = 0.012 * y
    kink = 0.015 * math.exp(-(((t - 0.45) / 0.31) ** 2))
    z = 0.010 + radius**2 * (side + slope + kink) + 0.002 * radius * math.sin(3 * t)
    return rx * x, ry * y, z + offset


# The top and underside have separate thickness. The bound edge follows the irregular felt.
surface(
    "Brim upper felt",
    [lambda t, r=r: brim(t, r) for r in (1, 0.96, 0.79, 0.45, 0.15, 0)],
    segments,
    felt,
)
surface(
    "Brim lower felt",
    [lambda t, r=r: brim(t, r, -0.0045) for r in (0, 0.3, 0.69, 0.95, 1)],
    segments,
    felt,
)
surface(
    "Brim bound edge",
    [
        lambda t: brim(t, 0.991, -0.0043),
        lambda t: brim(t, 1.001, -0.0036),
        lambda t: brim(t, 1.008, -0.0017),
        lambda t: brim(t, 1.001, 0.0007),
        lambda t: brim(t, 0.986, 0.0012),
    ],
    segments,
    edge,
)


def crown(t, radius, z, dent):
    x, y = math.cos(t), math.sin(t)
    front = max(0, -y)
    pinch = 1 - min(1, z / 0.11) * 0.25 * front**2
    return (
        0.084 * radius * x * pinch,
        0.097 * radius * y,
        z - dent * abs(y) ** 3 + 0.0025 * z * x / 0.11,
    )


# High shoulders, pinched front and a low channel through the crown.
surface(
    "Pinched crown",
    [
        lambda t, r=r, z=z, d=d: crown(t, r, z, d)
        for r, z, d in (
            (1, 0.008, 0),
            (1, 0.022, 0),
            (0.99, 0.047, 0.003),
            (0.94, 0.076, 0.006),
            (0.91, 0.103, 0.010),
            (0.83, 0.122, 0.018),
            (0.65, 0.128, 0.024),
            (0.39, 0.121, 0.029),
            (0.13, 0.111, 0.008),
            (0.006, 0.104, 0.0),
        )
    ],
    segments,
    felt,
    seal=True,
)
surface(
    "Worn leather hatband",
    [
        lambda t, r=r, z=z: crown(t, r, z, 0)
        for r, z in ((1.001, 0.015), (1.034, 0.017), (1.033, 0.034), (1.011, 0.036))
    ],
    segments,
    leather,
)
for z in (0.0185, 0.033):
    surface(
        "Band stitch line",
        [
            lambda t, z=z - 0.0006: crown(t, 1.036, z, 0),
            lambda t, z=z + 0.0006: crown(t, 1.039, z, 0),
        ],
        segments,
        thread,
    )


def buckle_bar(name, center, dimensions):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    obj = bpy.context.object
    obj.name = name
    obj.scale = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(buckle)
    mod = obj.modifiers.new("Rounded buckle edges", "BEVEL")
    mod.width = 0.0006
    mod.segments = 2
    bpy.ops.object.modifier_apply(modifier=mod.name)


for offset in (-0.0105, 0.0105):
    buckle_bar("Buckle upright", (-0.087, offset, 0.025), (0.0024, 0.0020, 0.017))
for height in (0.018, 0.032):
    buckle_bar("Buckle crossbar", (-0.087, 0, height), (0.0024, 0.021, 0.0020))
buckle_bar("Buckle bar", (-0.088, 0, 0.024), (0.002, 0.019, 0.0016))

out.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=str(out.resolve()), export_format="GLB", export_yup=True
)
