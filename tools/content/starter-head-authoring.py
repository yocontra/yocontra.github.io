"""Shape the starter head from CC0 anatomy and scanned skin maps."""

import math
import random
import struct
import sys
import zlib
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

root = Path(sys.argv[sys.argv.index("--") + 1])
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for data in list(bpy.data.meshes):
    if not data.users:
        bpy.data.meshes.remove(data)
for mat in list(bpy.data.materials):
    if not mat.users:
        bpy.data.materials.remove(mat)

vertices = []
uvs = []
faces = []
group = ""
for line in (root / "base.obj").read_text().splitlines():
    command, *value = line.split() or [""]
    if command == "v":
        vertices.append(tuple(map(float, value[:3])))
    elif command == "vt":
        uvs.append(tuple(map(float, value[:2])))
    elif command == "g":
        group = value[0]
    elif command == "f" and group == "body":
        faces.append([tuple(int(n) - 1 for n in part.split("/")[:2]) for part in value])

for line in (root / "male-young.target").read_text().splitlines():
    fields = line.split()
    if fields and fields[0].isdigit():
        index = int(fields[0])
        vertices[index] = tuple(
            component + float(delta)
            for component, delta in zip(vertices[index], fields[1:])
        )


def smooth(start, end, value):
    t = max(0, min(1, (value - start) / (end - start)))
    return t * t * (3 - 2 * t)


# Align the reconstructed head to the player's neutral pair of eye positions.
# All coordinates in the exported mesh are metres, in the player's bind pose.
def soften_limit(value, limit, influence):
    start = limit * 0.75
    span = limit - start
    if value <= start:
        return value
    rounded = start + span * math.tanh((value - start) / span)
    return value + (rounded - value) * influence


def position(src):
    x, y, z = src
    across = -0.027 + x * 0.103
    up = 1.584 + (y - 8.2164) * 0.113
    front = 0.107 + (z - 1.304) * 0.094

    # Keep the skull convex through the temples and occiput. Move the jaw
    # upward and inward while blending the throat into the existing shirt neck.
    rear = 1 - smooth(-0.045, 0.064, front)
    crown = smooth(1.552, 1.666, up)
    front += 0.004 * crown * rear
    lower_face = smooth(1.430, 1.480, up) * (1 - smooth(1.495, 1.554, up))
    chin = lower_face * smooth(0.057, 0.116, front)
    up += 0.012 * chin
    front -= 0.007 * chin

    base = 1 - smooth(1.442, 1.490, up)
    center = -0.027 + 0.006 * base
    # Roll the lower neck into the collar aperture instead of exposing the
    # broad shoulders of the donor at the base of the clipped head.
    width = 0.044 + 0.012 * smooth(1.434, 1.475, up)
    across = center + math.copysign(
        soften_limit(abs(across + 0.027), width, base), across + 0.027
    )
    fore_limit = 0.026 + 0.105 * smooth(1.438, 1.477, up)
    rear_limit = 0.036 + 0.010 * smooth(1.443, 1.478, up)
    front = math.copysign(soften_limit(abs(front), fore_limit if front > 0 else rear_limit, base), front)
    return across, -front, up


def clip_head(poly, height):
    out = []
    for i, a in enumerate(poly):
        b = poly[(i + 1) % len(poly)]
        ay, by = a[0][1], b[0][1]
        if ay >= height:
            out.append(a)
        if (ay >= height) == (by >= height):
            continue
        weight = (height - ay) / (by - ay)
        out.append(
            tuple(
                tuple(x + (y - x) * weight for x, y in zip(old, new))
                for old, new in zip(a, b)
            )
        )
    return out


points = []
index_by_point = {}
polys = []
uv_faces = []
for indices in faces:
    polygon = clip_head([(vertices[v], uvs[uv]) for v, uv in indices], 6.48)
    if len(polygon) < 3:
        continue
    face = []
    for origin, uv in polygon:
        p = tuple(round(x, 7) for x in position(origin))
        if p not in index_by_point:
            index_by_point[p] = len(points)
            points.append(p)
        face.append(index_by_point[p])
    if len(set(face)) == len(face):
        polys.append(face)
        uv_faces.append([uv for _, uv in polygon])

mesh = bpy.data.meshes.new("Neutral starter head, anatomical topology")
mesh.from_pydata(points, [], polys)
mesh.update()
uv_layer = mesh.uv_layers.new(name="Skin atlas")
for p in mesh.polygons:
    p.use_smooth = True
    for loop, value in zip(p.loop_indices, uv_faces[p.index]):
        uv_layer.data[loop].uv = value

head = bpy.data.objects.new("Starter head", mesh)
bpy.context.collection.objects.link(head)
material = bpy.data.materials.new("Field-worn skin")
material.use_nodes = True
nodes = material.node_tree.nodes
links = material.node_tree.links
skin = nodes["Principled BSDF"]
skin.inputs["Roughness"].default_value = 0.59
skin.inputs["Metallic"].default_value = 0
albedo = nodes.new("ShaderNodeTexImage")
albedo.image = bpy.data.images.load(str(root / "face-freckles.png"))
links.new(albedo.outputs["Color"], skin.inputs["Base Color"])
detail = nodes.new("ShaderNodeTexImage")
detail.image = bpy.data.images.load(str(root / "face-normal.png"))
detail.image.colorspace_settings.name = "Non-Color"
normal = nodes.new("ShaderNodeNormalMap")
normal.inputs["Strength"].default_value = 0.63
links.new(detail.outputs["Color"], normal.inputs["Color"])
links.new(normal.outputs["Normal"], skin.inputs["Normal"])
mesh.materials.append(material)

def brown_material(name, color):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    shader = material.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = 0.92
    return material


def surface_object(name, points, polygons, material):
    geometry = bpy.data.meshes.new(name)
    geometry.from_pydata(points, [], polygons)
    geometry.update()
    surface = bpy.data.objects.new(name, geometry)
    bpy.context.collection.objects.link(surface)
    uv = geometry.uv_layers.new(name="Groom UV")
    for poly in geometry.polygons:
        poly.use_smooth = True
        for corner in poly.loop_indices:
            x, depth, _height = geometry.vertices[geometry.loops[corner].vertex_index].co
            uv.data[corner].uv = (0.5 + x * 3, 0.52 - depth * 3)
    geometry.materials.append(material)
    return geometry


def hairline(point):
    x, depth, height = point
    angle = math.atan2(x + 0.027, -depth - 0.034)
    face = math.cos(angle)
    z = -depth
    # Lower the hair behind the ear and blend it up into the temples.
    base = 1.543 + 0.098 * smooth(-0.67, 0.96, face)
    side = smooth(0.061, 0.083, abs(x + 0.027))
    ear = smooth(-0.002, 0.027, z) * (1 - smooth(0.074, 0.103, z))
    base += 0.043 * side * ear
    return height - base + 0.003 * math.sin(angle * 5) + 0.0012 * math.sin(angle * 31)



def png_chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))


def hair_albedo(path):
    # Longitudinal strands, short split ends, and small color changes across
    # the scalp. The same plate wraps the rear seam without a discontinuity.
    period, height = 320, 176
    width = period + 96
    rng = random.Random(181)
    streaks = [rng.uniform(-14, 14) for _ in range(period)]
    tones = [rng.uniform(-5, 5) for _ in range(period)]
    texels = bytearray()
    for y in range(height):
        texels.append(0)
        shift = 4 * math.sin(y * 0.019) + 1.1 * math.sin(y * 0.047)
        for x in range(width):
            phase = x - 48 + shift + 2 * math.sin((x - 48) * math.tau / period) * math.sin(y * 0.017)
            base = math.floor(phase)
            weight = phase - base
            a, b = base % period, (base + 1) % period
            strand = (1 - weight) * streaks[a] + weight * streaks[b]
            strand *= 0.77 + 0.22 * math.sin(y * 0.11 + x * 0.13)
            fleck = rng.uniform(-3, 3)
            value = strand + tones[(((x - 48) % period) // 4) * 4] + fleck
            texels.extend(round(v + value * scale) for v, scale in ((73, 1), (51, 0.82), (37, 0.70)))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">2I5B", width, height, 8, 2, 0, 0, 0))
        + png_chunk(b"IDAT", zlib.compress(texels, 9))
        + png_chunk(b"IEND", b"")
    )


def link_hair_grain(tree, geometry, tint):
    for polygon in geometry.polygons:
        first = None
        for corner in polygon.loop_indices:
            x, depth, height = geometry.vertices[geometry.loops[corner].vertex_index].co
            u = (math.atan2(x + 0.027, -depth - 0.034) / math.tau + 0.5) % 1
            if first is None:
                first = u
            u = first + (u - first + 0.5) % 1 - 0.5
            geometry.uv_layers.active.data[corner].uv = ((u + 0.15) / 1.3, (height - 1.527) / 0.200)
    path = root / "hair-grain.png"
    hair_albedo(path)
    texture = tree.nodes.new("ShaderNodeTexImage")
    texture.image = bpy.data.images.load(str(path))
    tree.links.new(texture.outputs["Color"], tree.nodes["Principled BSDF"].inputs["Base Color"])
    # glTF's color channel multiplies the albedo. Keep it linear in Blender.
    multiply = tree.nodes.new("ShaderNodeMixRGB")
    multiply.blend_type = "MULTIPLY"
    multiply.inputs["Fac"].default_value = 1
    tree.links.new(texture.outputs["Color"], multiply.inputs[1])
    tree.links.new(tint.outputs["Color"], multiply.inputs[2])
    tree.links.new(multiply.outputs["Color"], tree.nodes["Principled BSDF"].inputs["Base Color"])


def crown():
    points = []
    polygons = []
    indices = {}
    for poly in mesh.polygons:
        corners = [
            (mesh.vertices[i].co.copy(), mesh.vertices[i].normal.copy())
            for i in poly.vertices
        ]
        clipped = []
        for i, (start, direction) in enumerate(corners):
            end, next_direction = corners[(i + 1) % len(corners)]
            a, b = hairline(start), hairline(end)
            if a >= 0:
                clipped.append((start, direction))
            if (a >= 0) != (b >= 0):
                t = a / (a - b)
                clipped.append((start.lerp(end, t), direction.lerp(next_direction, t)))
        face = []
        for p, n in clipped:
            # Close-cropped hair follows the actual scalp with light crown volume.
            shape = 0.0006 + 0.004 * smooth(0, 0.032, hairline(p))
            point = tuple(round(v, 6) for v in p + n.normalized() * shape)
            if point not in indices:
                indices[point] = len(points)
                points.append(point)
            face.append(indices[point])
        if len(face) >= 3 and len(set(face)) == len(face):
            polygons.append(face)
    material = brown_material("Tobacco brown hair", (0.046, 0.027, 0.017))
    geometry = surface_object("Close-cropped scalp", points, polygons, material)
    colors = geometry.color_attributes.new(name="Hair variation", type="FLOAT_COLOR", domain="POINT")
    tree = material.node_tree
    color = tree.nodes.new("ShaderNodeVertexColor")
    color.layer_name = colors.name
    link_hair_grain(tree, geometry, color)
    for v in geometry.vertices:
        x, depth, height = v.co
        along = math.atan2(x + 0.027, -depth - 0.034)
        hair_weight = smooth(0, 0.023, hairline(v.co))
        variation = 0.08 * math.cos(along * 37 + height * 70) + 0.07 * math.sin(depth * 121 + x * 98)
        value = 0.77 + 0.16 * hair_weight + variation
        colors.data[v.index].color = (value, value * 0.98, value * 0.96, 1)


def eyebrows():
    surface = BVHTree.FromPolygons([v.co for v in mesh.vertices], [tuple(p.vertices) for p in mesh.polygons])
    points = []
    polygons = []
    for side in (-1, 1):
        start = len(points)
        for n in range(19):
            t = n / 18
            x = -0.027 + side * (0.017 + 0.043 * t)
            y = 1.597 + 0.006 * math.sin(t * math.pi * 0.94) - 0.004 * t
            thickness = 0.0042 * max(0.12, math.sin(math.pi * (0.15 + 0.84 * t)))
            for edge in (-0.44, 0.63):
                height = y + thickness * edge
                point, normal, _face, _distance = surface.ray_cast(Vector((x, -0.23, height)), Vector((0, 1, 0)))
                if point is None:
                    raise ValueError("Eyebrow crossed the fitted forehead")
                points.append(point + normal * 0.00065)
        for n in range(18):
            corner = start + 2 * n
            row = (corner, corner + 1, corner + 3, corner + 2)
            polygons.append(row[::-1] if side > 0 else row)
    surface_object("Tapered eyebrow profiles", points, polygons,
                   brown_material("Tobacco brown eyebrows", (0.056, 0.034, 0.022)))


crown()
eyebrows()


bpy.ops.export_scene.gltf(
    filepath=str((root / "starter-head.blender.glb").resolve()),
    export_format="GLB",
    export_yup=True,
)
print("Starter head:", len(mesh.vertices), "vertices,", len(mesh.polygons), "faces")
