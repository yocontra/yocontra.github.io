"""Shape the starter head from CC0 anatomy and scanned skin maps."""

import math
import struct
import sys
import zlib
from pathlib import Path

import bpy
import numpy as np
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
    # Keep the existing neck envelope. Shape the jaw above it and take the
    # surprise out of the gaze with a lower upper lid and higher lower lid.
    lateral = abs(across + 0.027)
    jaw = smooth(1.47, 1.49, up) * (1 - smooth(1.512, 1.548, up))
    across += math.copysign(0.004 * jaw * smooth(0.019, 0.056, lateral), across + 0.027)
    socket = (1 - smooth(0.014, 0.030, abs(lateral - 0.033))) * smooth(0.083, 0.105, front)
    upper = smooth(1.582, 1.592, up) * (1 - smooth(1.596, 1.612, up))
    lower = smooth(1.564, 1.573, up) * (1 - smooth(1.577, 1.584, up))
    up += socket * (0.0015 * lower - 0.0028 * upper)
    # Break the round cheek plane and give the bridge a shallow irregularity.
    # The change stays above the collar and away from the socket centers.
    cheek = smooth(0.035, 0.061, lateral) * smooth(0.031, 0.080, front)
    cheek *= smooth(1.514, 1.540, up) * (1 - smooth(1.549, 1.571, up))
    front -= 0.0031 * cheek
    bridge = (1 - smooth(0.011, 0.025, lateral)) * smooth(0.105, 0.131, front)
    bridge *= smooth(1.548, 1.559, up) * (1 - smooth(1.574, 1.596, up))
    across -= 0.00165 * bridge
    front += 0.0031 * bridge
    # Round the upper lip into the muzzle and soften the step into the chin.
    # The sculpt is confined to the mouth, leaving the eyes and neck bind alone.
    mouth = (1 - smooth(0.022, 0.039, lateral)) * smooth(0.108, 0.125, front)
    upper_lip = math.exp(-((up - 1.522) / 0.007) ** 2)
    lower_lip = math.exp(-((up - 1.512) / 0.0046) ** 2)
    chin_fold = math.exp(-((up - 1.496) / 0.0075) ** 2)
    front += mouth * (-0.0055 * upper_lip + 0.0010 * lower_lip + 0.0024 * chin_fold)
    corner = math.exp(-((lateral - 0.028) / 0.009) ** 2 - ((up - 1.518) / 0.0055) ** 2)
    up += (0.00135 if across < -0.027 else 0.00085) * corner * smooth(0.095, 0.113, front)
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

def png_chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))


def write_png(path, pixels):
    height, width, channels = pixels.shape
    rows = b"".join(b"\0" + row.tobytes() for row in pixels)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">2I5B", width, height, 8, 6 if channels == 4 else 2, 0, 0, 0))
        + png_chunk(b"IDAT", zlib.compress(rows, 9))
        + png_chunk(b"IEND", b"")
    )


def smooth_array(start, end, value):
    t = np.clip((value - start) / (end - start), 0, 1)
    return t * t * (3 - 2 * t)


def hairline(point):
    x, depth, height = point
    lateral = x + 0.027
    angle = np.arctan2(lateral, -depth - 0.034)
    face = np.cos(angle)
    front = -depth
    temple = smooth_array(0.010, 0.055, abs(lateral)) * smooth_array(0.26, 0.83, face)
    brow = smooth_array(-0.38, 0.93, face)
    part = np.exp(-((lateral + 0.020) / 0.028) ** 2)
    sweep = np.exp(-((lateral - 0.010) / 0.034) ** 2)
    base = 1.547 + 0.092 * brow + 0.013 * temple
    base += brow * (0.004 * part - 0.0045 * sweep)
    base += 0.007 * temple * smooth_array(-0.037, 0.037, lateral)
    side = smooth_array(0.052, 0.082, abs(lateral))
    ear = smooth_array(-0.008, 0.024, front) * (1 - smooth_array(0.075, 0.104, front))
    base += 0.033 * side * ear
    scattered = 0.0011 * np.sin(angle * 13 + 0.9) + 0.0007 * np.sin(angle * 23 - 0.8)
    return height - base + scattered


def complexion_masks(x, front, y):
    lateral = abs(x + 0.027)
    cheeks = smooth(0.025, 0.055, lateral)
    ceiling = 1.516 + 0.036 * cheeks
    beard = 1 - smooth(ceiling - 0.015, ceiling + 0.013, y)
    beard *= smooth(1.439, 1.466, y) * smooth(0.004, 0.057, front)
    lip_center = 1 - smooth(0.016, 0.039, lateral)
    mustache = smooth(1.525, 1.535, y) * (1 - smooth(1.543, 1.552, y))
    mustache *= lip_center * smooth(0.083, 0.112, front)
    blush = smooth(1.539, 1.565, y) * (1 - smooth(1.575, 1.599, y))
    blush *= smooth(0.019, 0.057, lateral) * smooth(0.02, 0.085, front)
    eye = (1 - smooth(0.011, 0.028, abs(lateral - 0.034))) * smooth(0.074, 0.101, front)
    lid = eye * (1 - smooth(0.0025, 0.007, abs(y - (1.564 - lateral * 0.07))))
    groove_center = 1.554 - 1.42 * (lateral - 0.018)
    groove = (1 - smooth(0.001, 0.0042, abs(y - groove_center)))
    groove *= smooth(0.015, 0.023, lateral) * (1 - smooth(0.045, 0.065, lateral))
    groove *= smooth(0.075, 0.105, front) * smooth(1.511, 1.527, y)
    lips = (1 - smooth(0.025, 0.035, lateral)) * smooth(0.107, 0.119, front)
    lips *= smooth(1.505, 1.512, y) * (1 - smooth(1.522, 1.528, y))
    return max(beard, 0.58 * mustache), blush, max(0.78 * lid, groove), lips


def pad_uv_seams(pigment, painted):
    # The inherited scalp uses more than one UV island. Hold color past each
    # sampled edge so the native reduced map does not reveal a pale seam.
    shifts = [(1, 0), (-1, 0), (1, 1), (-1, 1)]
    for _ in range(18):
        occupied = painted.copy()
        for shift, axis in shifts:
            edge = np.roll(occupied, shift, axis=axis) & ~painted
            if axis == 0:
                edge[(0 if shift == 1 else -1), :] = False
            else:
                edge[:, (0 if shift == 1 else -1)] = False
            pigment[edge] = np.roll(pigment, shift, axis=axis)[edge]
            painted[edge] = True


def face_albedo():
    size = 1024
    original = bpy.data.images.load(str(root / "face-freckles.png"))
    original.scale(size, size)
    base = np.empty(size * size * 4, dtype=np.float32)
    original.pixels.foreach_get(base)
    base = base.reshape((size, size, 4))
    masks = np.zeros((size, size, 4), dtype=np.float32)
    scalp = np.zeros((size, size), dtype=np.float32)
    points_by_vertex = np.array([v.co for v in mesh.vertices], dtype=np.float32)
    painted = np.zeros((size, size), dtype=np.bool_)
    mask_by_point = np.array(
        [complexion_masks(v.co.x, -v.co.y, v.co.z) for v in mesh.vertices],
        dtype=np.float32,
    )
    mesh.calc_loop_triangles()
    for tri in mesh.loop_triangles:
        uv = np.array([uv_layer.data[corner].uv for corner in tri.loops]) * size - 0.5
        lo = np.maximum(0, np.floor(uv.min(axis=0)).astype(int))
        hi = np.minimum(size - 1, np.ceil(uv.max(axis=0)).astype(int))
        x, y = np.meshgrid(np.arange(lo[0], hi[0] + 1), np.arange(lo[1], hi[1] + 1))
        a, b, c = uv
        denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(denominator) < 1e-6:
            continue
        u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / denominator
        v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / denominator
        w = 1 - u - v
        covered = (u > -0.008) & (v > -0.008) & (w > -0.008)
        weights = np.stack([u[covered], v[covered], w[covered]], axis=-1)
        indices = list(tri.vertices)
        rows, columns = y[covered], x[covered]
        masks[rows, columns] = np.clip(weights @ mask_by_point[indices], 0, 1)
        # Sample the hairline per texel so coarse skin triangles don't drag
        # a dark band beyond the tapered hair geometry along the nape.
        edge = hairline((weights @ points_by_vertex[indices]).T)
        scalp[rows, columns] = smooth_array(-0.0045, 0.0035, edge)
        painted[rows, columns] = True

    rng = np.random.default_rng(173)
    whisker = rng.random((size, size))
    tips = np.maximum(0, 1 - whisker * 6.0)
    # Short clustered tips keep a rubbed appearance under the mip chain.
    tips = 0.68 * tips + 0.22 * np.roll(tips, 1, axis=0) + 0.1 * np.roll(tips, 1, axis=1)
    follicles = masks[:, :, 0] * (0.29 + 0.42 * tips)
    shadow = np.array([0.20, 0.165, 0.139], dtype=np.float32)
    pigment = base[:, :, :3] * (1 - follicles[:, :, None]) + shadow * follicles[:, :, None]
    pigment += masks[:, :, 1, None] * np.array([0.013, -0.025, -0.040])
    pigment -= masks[:, :, 2, None] * np.array([0.059, 0.052, 0.039])
    root_tone = np.array([0.226, 0.172, 0.140], dtype=np.float32)
    short_grain = tips + 0.55 * np.roll(tips, 2, axis=0)
    shade = root_tone + short_grain[:, :, None] * np.array([0.074, 0.063, 0.051])
    fade = np.clip(scalp[:, :, None] * (1 + 0.10 * tips[:, :, None]), 0, 1)
    pigment = pigment * (1 - fade) + shade * fade
    # Keep the scanned contours while reducing the pink band on the lower lip.
    vermilion = masks[:, :, 3, None]
    pigment *= 1 + vermilion * np.array([-0.078, -0.020, 0.012], dtype=np.float32)
    pad_uv_seams(pigment, painted)
    encoded = np.rint(np.clip(pigment, 0, 1)[::-1] * 255).astype(np.uint8)
    path = root / "face-trail.png"
    write_png(path, encoded)
    return bpy.data.images.load(str(path))


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
albedo.image = face_albedo()
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


surface = BVHTree.FromPolygons([v.co for v in mesh.vertices], [tuple(p.vertices) for p in mesh.polygons])


def eyebrows():
    points, polygons = [], []

    def place(x, height):
        point, normal, _face, _distance = surface.ray_cast(
            Vector((x, -0.23, height)), Vector((0, 1, 0))
        )
        if point is None:
            raise ValueError("Eyebrow crossed the fitted forehead")
        return point + normal * 0.00044

    for side in (-1, 1):
        for strand in range(126):
            t = (strand % 42 + 0.24 * (strand // 42)) / 42
            spread = (strand // 42 - 1) * 0.00105
            x = -0.027 + side * (0.016 + 0.045 * t)
            height = 1.594 + 0.0048 * math.sin(t * math.pi * 0.92) + 0.0012 * side * t
            height += spread + 0.00075 * math.sin(strand * 1.83 + side)
            reach = (0.0018 + 0.0021 * smooth(0.02, 0.67, t)) * (1 - 0.52 * smooth(0.77, 1, t))
            lift = 0.0028 * (1 - smooth(0.15, 0.84, t)) - 0.00075
            width = 0.00017 + 0.00012 * (1 + math.sin(strand * 2.11))
            index = len(points)
            for offset in (-width, width):
                points.append(place(x, height + offset))
            points.append(place(x + side * reach, height + lift))
            face = (index, index + 1, index + 2)
            polygons.append(face if side < 0 else face[::-1])
    surface_object("Swept eyebrow strands", points, polygons,
                   brown_material("Tobacco brown eyebrows", (0.043, 0.031, 0.023)))


def scalp_point(origin, angle, elevation):
    horizontal = math.cos(elevation)
    direction = Vector((horizontal * math.sin(angle), -horizontal * math.cos(angle), math.sin(elevation)))
    point, _normal, _face, _distance = surface.ray_cast(origin + direction * 0.35, -direction)
    if point is None:
        raise ValueError("Hair guide could not find the scalp")
    return point, direction


def scalp_edge(origin, angle):
    low, high = -0.50, 1.30
    for _ in range(17):
        middle = (low + high) / 2
        point, _direction = scalp_point(origin, angle, middle)
        if hairline(point) > -0.0018:
            high = middle
        else:
            low = middle
    return high


def combed_crop_material():
    material = brown_material("Tobacco brown hair", (1.0, 1.0, 1.0))
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes["Principled BSDF"]
    # Build continuous swept strands in scalp UVs. The separate albedo and normal
    # fields retain the direction of the crop as the texture mips down.
    u = np.linspace(0, 1, 1024, endpoint=False)[None, :]
    v = np.linspace(0, 1, 512, endpoint=True)[:, None]
    angle = 2 * np.pi * u
    rake = 0.12 * v + 0.027 * np.sin(2 * angle + 1.2) * v * v
    wave = angle + 2 * np.pi * rake
    lock = 0.5 + 0.5 * np.sin(wave * 52 + 0.35 * np.sin(wave * 19 - v * 41))
    filament = 0.5 + 0.5 * np.sin(wave * 191 + 0.91 * np.sin(9 * angle + v * 23))
    irregularity = 0.5 + 0.5 * np.sin(wave * 123 - v * 76 + np.sin(wave * 14 + v * 19))
    broken = 0.6 + 0.4 * np.sin(wave * 273 - v * 138 + np.sin(wave * 24))
    fade = np.clip(v * 14, 0, 1)
    grain = (0.11 * lock + 0.17 * filament ** 2 * broken + 0.09 * irregularity) * fade
    root_fade = np.clip(v * 7, 0, 1)[:, :, None]
    shade = np.array([34, 24, 20]) + root_fade * np.array([9, 7, 5])
    shade = shade + grain[:, :, None] * np.array([53, 46, 36])
    # Break the edge into sub-millimetre wisps with a wider taper at the nape.
    back = 0.5 - 0.5 * np.cos(angle)
    tips = 0.008 + 0.015 * back + 0.006 * np.sin(angle * 149) + 0.0045 * np.sin(angle * 83 + 1.2)
    opacity = np.clip((v - tips) * 170 + 0.5, 0, 1)
    rgba = np.concatenate((shade, opacity[:, :, None] * 255), axis=-1)
    pixels = np.rint(rgba[::-1]).astype(np.uint8)
    albedo_file = root / "cropped-hair-color.png"
    write_png(albedo_file, pixels)
    albedo = nodes.new("ShaderNodeTexImage")
    albedo.image = bpy.data.images.load(str(albedo_file))
    links.new(albedo.outputs["Color"], shader.inputs["Base Color"])
    links.new(albedo.outputs["Alpha"], shader.inputs["Alpha"])
    material.alpha_threshold = 0.5

    relief = (0.20 * lock + 0.22 * filament * broken + 0.13 * irregularity) * fade
    dx = 0.54 * (np.roll(relief, 1, axis=1) - np.roll(relief, -1, axis=1))
    dy = 0.54 * (np.roll(relief, 1, axis=0) - np.roll(relief, -1, axis=0))
    dy[[0, -1]] = 0
    tangent_normal = np.stack((dx, dy, np.ones_like(dx)), axis=-1)
    tangent_normal /= np.linalg.norm(tangent_normal, axis=-1, keepdims=True)
    bump_file = root / "cropped-hair-normal.png"
    write_png(bump_file, np.rint((0.5 + 0.5 * tangent_normal[::-1]) * 255).astype(np.uint8))
    bump = nodes.new("ShaderNodeTexImage")
    bump.image = bpy.data.images.load(str(bump_file))
    bump.image.colorspace_settings.name = "Non-Color"
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.inputs["Strength"].default_value = 0.66
    links.new(bump.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], shader.inputs["Normal"])
    return material


def combed_crop():
    origin = Vector((-0.027, -0.032, 1.603))
    sides, rings = 144, 29
    points, faces = [], []
    hair_angles = [2 * math.pi * side / sides for side in range(sides)]
    lowest = [scalp_edge(origin, angle) for angle in hair_angles]
    for row in range(rings):
        t = row / rings
        for angle, edge in zip(hair_angles, lowest):
            angle += 0.11 * math.sin(t * math.pi) + 0.03 * t * math.sin(angle * 2)
            elevation = edge + (math.pi * 0.5 - edge) * t
            point, ray = scalp_point(origin, angle, elevation)
            north = smooth(0.15, 1.42, elevation)
            fade = smooth(0, 0.28, t)
            scoop = 0.5 + 0.5 * math.sin(angle * 33 + 4 * t)
            crest = smooth(0.08, 0.48, t) * (1 - smooth(0.78, 0.99, t))
            depth = 0.0006 + fade * (0.0017 + 0.0038 * north + 0.0010 * scoop * crest)
            points.append(point + ray * depth)
    crown, ray = scalp_point(origin, 0, math.pi * 0.5)
    points.append(crown + ray * 0.0061)
    for row in range(rings):
        for side in range(sides):
            a = row * sides + side
            b = row * sides + (side + 1) % sides
            if row < rings - 1:
                faces.append((a, b, b + sides, a + sides))
            else:
                faces.append((a, b, len(points) - 1))
    geometry = surface_object("Close-combed scalp", points, faces, combed_crop_material())
    uv = geometry.uv_layers.active
    for face in geometry.polygons:
        row, side = divmod(face.index, sides)
        u0, u1 = side / sides, (side + 1) / sides
        v0, v1 = row / rings, (row + 1) / rings
        coords = [(u0, v0), (u1, v0)]
        coords += [(u1, v1), (u0, v1)] if row < rings - 1 else [((u0 + u1) * 0.5, v1)]
        for corner, coord in zip(face.loop_indices, coords):
            uv.data[corner].uv = coord


eyebrows()
combed_crop()


bpy.ops.export_scene.gltf(
    filepath=str((root / "starter-head.blender.glb").resolve()),
    export_format="GLB",
    export_yup=True,
)
print("Starter head:", len(mesh.vertices), "vertices,", len(mesh.polygons), "faces")


def fitted_handlebar():
    # Trace the reconstructed upper lip directly so the roots remain on the
    # skin and the fine curled ends cannot mask the mouth in profile.
    points, faces = [], []
    sections, circumference = 40, 24
    for side in (-1, 1):
        base = len(points)
        for step in range(sections + 1):
            t = step / sections
            x = -0.027 + side * (0.0025 + 0.038 * t)
            center = 1.5295 - 0.0046 * smooth(0.18, 0.70, t)
            center += (0.0096 + 0.0007 * side) * smooth(0.68, 1.0, t)
            fullness = smooth(0, 0.13, t) * (1 - smooth(0.55, 1, t))
            width = 0.00022 + 0.00325 * fullness
            depth = 0.00025 + 0.0018 * fullness
            for k in range(circumference):
                angle = 2 * math.pi * k / circumference
                height = center + width * math.cos(angle)
                hit, _normal, _face, _distance = surface.ray_cast(
                    Vector((x, -0.23, height)), Vector((0, 1, 0))
                )
                if hit is None:
                    raise ValueError("Moustache guide left the cheek")
                strand = 0.00019 * fullness * math.sin(11 * angle + t * 7)
                hit.y -= 0.0003 + depth * math.sin(angle) + strand
                points.append(hit)
        for step in range(sections):
            for k in range(circumference):
                a = base + step * circumference + k
                b = base + step * circumference + (k + 1) % circumference
                face = (a, b, b + circumference, a + circumference)
                faces.append(face if side > 0 else face[::-1])
        start_ring = tuple(range(base, base + circumference))
        end_ring = tuple(range(base + sections * circumference, len(points)))
        faces.extend((start_ring[::-1], end_ring) if side > 0 else (start_ring, end_ring[::-1]))
    geometry = surface_object("Swept cheek-fitted moustache", points, faces,
                              brown_material("Moustache bundles", (1, 1, 1)))
    obj = next(obj for obj in bpy.context.collection.objects if obj.data == geometry)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str((root / "handlebar.blender.glb").resolve()),
        export_format="GLB",
        export_yup=True,
        use_selection=True,
    )


fitted_handlebar()
