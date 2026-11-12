"""Author the shared head's occiput volume and its neck skin texels.

Blender --background --factory-startup --python this-file

The Quaternius head keeps a flat skull back that drops straight into the nape, and its
neck UV island lies on unrelated hand/shoulder texels of the shared skin atlas. Blender
authors two portable artifacts from the canonical player head, read only:

* `lattice.json`, a native linear Lattice (in Head-joint space) that rounds the occiput
  and lets the nape sit in front of it. The content baker deforms every fitted body.
* `neck-*.png`, atlas-space replacement texels for the neck island: albedo filled
  harmonically from the colors across its UV seams with Cycles-baked skin mottling,
  a Cycles-baked fine skin normal, and the face's own ARM response.
"""

import hashlib
import json
import struct
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / "tools/art/characters"
OUTPUT = SOURCES / "head-nape"
REFERENCE = SOURCES / "player.gltf"
# Head-joint-relative glTF bounds of the lattice (meters at the player's head scale).
BOUNDS = ((-0.13, -0.09, -0.14), (0.13, 0.23, 0.1))
RESOLUTION = (9, 11, 9)
OCCIPUT_DEPTH = 0.4
NAPE_TUCK = 0.12
COMPONENTS = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}
WIDTHS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class Source:
    def __init__(self, path):
        self.path = path
        self.doc = json.loads(path.read_text())
        self.buffers = [(path.parent / b["uri"]).read_bytes() for b in self.doc["buffers"]]

    def accessor(self, index):
        a = self.doc["accessors"][index]
        view = self.doc["bufferViews"][a["bufferView"]]
        dtype = np.dtype(COMPONENTS[a["componentType"]])
        width = WIDTHS[a["type"]]
        stride = view.get("byteStride", 0) or dtype.itemsize * width
        start = view.get("byteOffset", 0) + a.get("byteOffset", 0)
        raw = np.frombuffer(self.buffers[view["buffer"]], np.uint8, stride * (a["count"] - 1) + dtype.itemsize * width, start)
        rows = np.lib.stride_tricks.as_strided(raw, (a["count"], dtype.itemsize * width), (stride, 1)).copy()
        values = rows.view(dtype).reshape(a["count"], width)
        if a.get("normalized"):
            values = values.astype(np.float32) / np.iinfo(dtype).max
        return values

    def image(self, texture):
        return self.path.parent / self.doc["images"][self.doc["textures"][texture]["source"]]["uri"]

    def world(self, name):
        parents = {c: i for i, n in enumerate(self.doc["nodes"]) for c in n.get("children", [])}
        index = next(i for i, n in enumerate(self.doc["nodes"]) if n.get("name") == name)
        matrix = np.eye(4)
        while index is not None:
            node = self.doc["nodes"][index]
            x, y, z, w = node.get("rotation", (0, 0, 0, 1))
            rotation = np.array([
                [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
            ])
            local = np.eye(4)
            local[:3, :3] = rotation @ np.diag(node.get("scale", (1, 1, 1)))
            local[:3, 3] = node.get("translation", (0, 0, 0))
            matrix = local @ matrix
            index = parents.get(index)
        return matrix[:3, 3]


def smoothstep(edge0, edge1, x):
    t = np.clip((x - edge0) / (edge1 - edge0), 0, 1)
    return t * t * (3 - 2 * t)


def occiput(local):
    """Round the skull out behind the ears and tuck the nape under it; face, crown and collar stay."""
    x, y, z = local[..., 0], local[..., 1], local[..., 2]
    skull = smoothstep(0.015, 0.075, y) * (1 - smoothstep(0.11, 0.18, y))
    nape = smoothstep(-0.045, -0.01, y) * (1 - smoothstep(0.015, 0.05, y))
    behind = np.minimum(z, 0) * smoothstep(0.0, -0.035, z)
    width = 1 - smoothstep(0.075, 0.12, np.abs(x + 0.002))
    offset = np.zeros_like(local)
    offset[..., 2] = (OCCIPUT_DEPTH * skull - NAPE_TUCK * nape) * behind * width
    return offset


def author_lattice(head):
    lattice = bpy.data.lattices.new("Head occiput")
    lattice.points_u, lattice.points_v, lattice.points_w = RESOLUTION[0], RESOLUTION[2], RESOLUTION[1]
    for axis in ("u", "v", "w"):
        setattr(lattice, f"interpolation_type_{axis}", "KEY_LINEAR")
    obj = bpy.data.objects.new("Head occiput", lattice)
    bpy.context.collection.objects.link(obj)
    lo, hi = np.array(BOUNDS[0]), np.array(BOUNDS[1])
    center, size = (lo + hi) / 2 + head, hi - lo
    obj.location = (center[0], -center[2], center[1])
    obj.scale = (size[0], size[2], size[1])
    grid = np.stack(np.meshgrid(*[np.linspace(lo[k], hi[k], RESOLUTION[k]) for k in range(3)], indexing="ij"), -1)
    offsets = occiput(grid)
    # Blender's lattice point order is u fastest (glTF X), then v (glTF -Z), then w (glTF Y).
    k = 0
    for w in range(RESOLUTION[1]):
        for v in range(RESOLUTION[2]):
            for u in range(RESOLUTION[0]):
                zi = RESOLUTION[2] - 1 - v
                o = offsets[u, w, zi]
                point = lattice.points[k]
                point.co_deform = Vector(point.co) + Vector((o[0] / size[0], -o[2] / size[2], o[1] / size[1]))
                k += 1
    return obj, offsets


def head_mesh(source):
    node = next(n for n in source.doc["nodes"] if n.get("name") == "Character" and "mesh" in n)
    primitive = source.doc["meshes"][node["mesh"]]["primitives"][0]
    positions = source.accessor(primitive["attributes"]["POSITION"])
    uvs = source.accessor(primitive["attributes"]["TEXCOORD_0"])
    indices = source.accessor(primitive["indices"]).reshape(-1, 3)
    skin = node["extras"]["pieceRanges"][0]
    inside = ((indices >= skin["start"]) & (indices < skin["start"] + skin["count"])).all(1)
    return positions, uvs, indices[inside], indices[~inside]


def islands(triangles, count):
    parent = np.arange(count)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b, c in triangles:
        parent[find(a)] = find(b)
        parent[find(b)] = find(c)
    return np.array([find(t[0]) for t in triangles])


def srgb_to_linear(v):
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(v):
    v = np.clip(v, 0, 1)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055)


def load_pixels(path):
    image = bpy.data.images.load(str(path))
    image.colorspace_settings.name = "Non-Color"
    w, h = image.size
    pixels = np.empty(w * h * 4, np.float32)
    image.pixels.foreach_get(pixels)
    # Blender stores rows bottom-up; glTF UV v=0 is the top row.
    return pixels.reshape(h, w, 4)[::-1].copy()


def sample(pixels, uv):
    h, w = pixels.shape[:2]
    x = np.clip((uv[:, 0] * w).astype(int), 0, w - 1)
    y = np.clip((uv[:, 1] * h).astype(int), 0, h - 1)
    return pixels[y, x]


def seam_fill(positions, uvs, triangles, neck, albedo):
    """Harmonic linear-light skin color from the neighbouring islands across every UV seam."""
    vertices = np.unique(triangles[neck])
    others = np.unique(triangles[~neck])
    key = {tuple(np.round(positions[v] / 1e-5).astype(np.int64)): v for v in others}
    around = {}
    for t in triangles[~neck]:
        for v in t:
            around.setdefault(v, []).append(uvs[t].mean(0))
    known = {}
    for v in vertices:
        twin = key.get(tuple(np.round(positions[v] / 1e-5).astype(np.int64)))
        if twin is not None:
            # Sample slightly inside the neighbouring island, away from its own edge texels.
            inward = uvs[twin] * 0.75 + np.array(around[twin]) * 0.25
            known[v] = srgb_to_linear(sample(albedo, inward)[:, :3]).mean(0)
    order = {v: i for i, v in enumerate(vertices)}
    neighbours = [set() for _ in vertices]
    for t in triangles[neck]:
        for a in t:
            for b in t:
                if a != b:
                    neighbours[order[a]].add(order[b])
    values = np.tile(np.mean(list(known.values()), 0), (len(vertices), 1))
    fixed = np.zeros(len(vertices), bool)
    for v, color in known.items():
        values[order[v]] = color
        fixed[order[v]] = True
    for _ in range(4000):
        values[~fixed] = np.array([values[list(neighbours[i])].mean(0) for i in np.flatnonzero(~fixed)])
    return vertices, values, len(known)


def bake_mesh(positions, uvs, triangles, colors=None, vertices=None):
    mesh = bpy.data.meshes.new("Neck island")
    mesh.from_pydata([(p[0], -p[2], p[1]) for p in positions], [], triangles.tolist())
    mesh.update()
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    layer = mesh.uv_layers.new(name="Atlas")
    loops = np.array([loop.vertex_index for loop in mesh.loops])
    flipped = uvs[loops].copy()
    flipped[:, 1] = 1 - flipped[:, 1]
    layer.data.foreach_set("uv", flipped.ravel())
    if colors is not None:
        attribute = mesh.color_attributes.new("Seam fill", "FLOAT_COLOR", "POINT")
        rgba = np.ones((len(positions), 4), np.float32)
        rgba[vertices, :3] = colors
        attribute.data.foreach_set("color", rgba.ravel())
    obj = bpy.data.objects.new("Neck island", mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def skin_material(obj, image):
    material = bpy.data.materials.new("Neck skin bake")
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    emission = nodes.new("ShaderNodeEmission")
    bsdf = nodes.new("ShaderNodeBsdfDiffuse")
    fill = nodes.new("ShaderNodeVertexColor")
    fill.layer_name = "Seam fill"
    coords = nodes.new("ShaderNodeTexCoord")
    # Broad blotches plus tighter freckle-scale mottling, in object space so texel stretch is irrelevant.
    blotch = nodes.new("ShaderNodeTexNoise")
    blotch.inputs["Scale"].default_value = 28
    blotch.inputs["Detail"].default_value = 4
    freckle = nodes.new("ShaderNodeTexVoronoi")
    freckle.inputs["Scale"].default_value = 420
    freckle.feature = "F1"
    pores = nodes.new("ShaderNodeTexNoise")
    pores.inputs["Scale"].default_value = 900
    pores.inputs["Detail"].default_value = 2
    pores.inputs["Roughness"].default_value = 0.7
    links.new(coords.outputs["Object"], blotch.inputs["Vector"])
    links.new(coords.outputs["Object"], freckle.inputs["Vector"])
    links.new(coords.outputs["Object"], pores.inputs["Vector"])
    tone = nodes.new("ShaderNodeMapRange")
    tone.inputs["To Min"].default_value = 0.93
    tone.inputs["To Max"].default_value = 1.06
    links.new(blotch.outputs["Fac"], tone.inputs["Value"])
    redness = nodes.new("ShaderNodeCombineColor")
    redness.inputs["Red"].default_value = 1.0
    shade = nodes.new("ShaderNodeMapRange")
    shade.inputs["From Min"].default_value = 0.0
    shade.inputs["From Max"].default_value = 0.35
    shade.inputs["To Min"].default_value = 0.955
    shade.inputs["To Max"].default_value = 1.0
    links.new(freckle.outputs["Distance"], shade.inputs["Value"])
    links.new(shade.outputs["Result"], redness.inputs["Green"])
    links.new(shade.outputs["Result"], redness.inputs["Blue"])
    tint = nodes.new("ShaderNodeMix")
    tint.data_type = "RGBA"
    tint.blend_type = "MULTIPLY"
    tint.inputs["Factor"].default_value = 1
    links.new(fill.outputs["Color"], tint.inputs["A"])
    links.new(redness.outputs["Color"], tint.inputs["B"])
    lum = nodes.new("ShaderNodeMix")
    lum.data_type = "RGBA"
    lum.blend_type = "MULTIPLY"
    lum.inputs["Factor"].default_value = 1
    links.new(tint.outputs["Result"], lum.inputs["A"])
    links.new(tone.outputs["Result"], lum.inputs["B"])
    links.new(lum.outputs["Result"], emission.inputs["Color"])
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.22
    bump.inputs["Distance"].default_value = 0.0006
    relief = nodes.new("ShaderNodeMath")
    relief.operation = "MULTIPLY_ADD"
    relief.inputs[1].default_value = 0.6
    links.new(pores.outputs["Fac"], relief.inputs[0])
    links.new(freckle.outputs["Distance"], relief.inputs[2])
    links.new(relief.outputs["Value"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    target = nodes.new("ShaderNodeTexImage")
    target.image = image
    nodes.active = target
    obj.data.materials.append(material)
    return material, bsdf, emission, output, target


def bake(obj, material, kind, image, nodes):
    bsdf, emission, output, target = nodes
    links = material.node_tree.links
    shader = emission if kind == "EMIT" else bsdf
    links.new(shader.outputs[0], output.inputs["Surface"])
    target.image = image
    material.node_tree.nodes.active = target
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.render.bake.margin = 3
    scene.render.bake.margin_type = "EXTEND"
    scene.render.bake.use_clear = False
    image.pixels.foreach_set(np.zeros(len(image.pixels), np.float32))
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if kind == "NORMAL":
        scene.render.bake.normal_space = "TANGENT"
    bpy.ops.object.bake(type=kind)
    w, h = image.size
    pixels = np.empty(w * h * 4, np.float32)
    image.pixels.foreach_get(pixels)
    return pixels.reshape(h, w, 4)[::-1].copy()


def coverage(uvs, triangles, shape):
    """Atlas texels owned by other islands; the replacement never paints over them."""
    h, w = shape
    mask = np.zeros(shape, bool)
    for t in triangles:
        p = uvs[t] * (w, h)
        x0, y0 = np.floor(p.min(0)).astype(int)
        x1, y1 = np.ceil(p.max(0)).astype(int)
        if x1 - x0 > w / 2 or y1 - y0 > h / 2:
            continue
        ys, xs = np.mgrid[max(0, y0):min(h, y1 + 1), max(0, x0):min(w, x1 + 1)]
        px, py = xs + 0.5, ys + 0.5
        (ax, ay), (bx, by), (cx, cy) = p
        d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(d) < 1e-9:
            continue
        l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d
        l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d
        inside = (l1 >= -0.01) & (l2 >= -0.01) & (1 - l1 - l2 >= -0.01)
        mask[ys[inside], xs[inside]] = True
    return mask


def write(name, pixels, alpha, box):
    x0, y0, x1, y1 = box
    crop = pixels[y0:y1, x0:x1].copy()
    crop[..., 3] = alpha[y0:y1, x0:x1]
    image = bpy.data.images.new(name, width=x1 - x0, height=y1 - y0, alpha=True)
    image.colorspace_settings.name = "Non-Color"
    image.pixels.foreach_set(crop[::-1].ravel())
    image.filepath_raw = str(OUTPUT / f"{name}.png")
    image.file_format = "PNG"
    image.save()


def main():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    source = Source(REFERENCE)
    head = source.world("Head")
    lattice, offsets = author_lattice(head)
    positions, uvs, triangles, rest = head_mesh(source)
    labels = islands(triangles, len(positions))
    neck = labels == labels[np.argmin(positions[triangles].mean(1)[:, 1])]
    material_textures = source.doc["materials"][
        source.doc["meshes"][next(n for n in source.doc["nodes"] if n.get("name") == "Character" and "mesh" in n)["mesh"]]["primitives"][0]["material"]
    ]
    albedo_path = source.image(material_textures["pbrMetallicRoughness"]["baseColorTexture"]["index"])
    normal_path = source.image(material_textures["normalTexture"]["index"])
    arm_path = source.image(material_textures["pbrMetallicRoughness"]["metallicRoughnessTexture"]["index"])
    albedo = load_pixels(albedo_path)
    arm = load_pixels(arm_path)
    vertices, colors, seams = seam_fill(positions, uvs, triangles, neck, albedo)
    obj = bake_mesh(positions, uvs, triangles[neck], colors, vertices)
    modifier = obj.modifiers.new("Occiput", "LATTICE")
    modifier.object = lattice
    h, w = albedo.shape[:2]
    color_image = bpy.data.images.new("Neck albedo", width=w, height=h, alpha=True, float_buffer=True)
    nh, nw = load_pixels(normal_path).shape[:2]
    normal_image = bpy.data.images.new("Neck normal", width=nw, height=nh, alpha=True, float_buffer=True)
    normal_image.colorspace_settings.name = "Non-Color"
    material, bsdf, emission, output, target = skin_material(obj, color_image)
    baked_color = bake(obj, material, "EMIT", color_image, (bsdf, emission, output, target))
    baked_normal = bake(obj, material, "NORMAL", normal_image, (bsdf, emission, output, target))
    other_uv = np.concatenate([triangles[~neck], rest])
    taken = coverage(uvs, other_uv, albedo.shape[:2])
    color_alpha = (baked_color[..., 3] > 0.5) & ~taken
    color_out = baked_color.copy()
    color_out[..., :3] = linear_to_srgb(baked_color[..., :3])
    ys, xs = np.nonzero(color_alpha)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    write("neck-albedo", color_out, color_alpha.astype(np.float32), box)
    taken_half = taken[::2, ::2][:nh, :nw]
    normal_alpha = (baked_normal[..., 3] > 0.5) & ~taken_half
    nbox = tuple(int(v) // 2 for v in box)
    nbox = (nbox[0], nbox[1], -(-box[2] // 2), -(-box[3] // 2))
    write("neck-normal", baked_normal, normal_alpha.astype(np.float32), nbox)
    face = labels == np.bincount(labels).argmax()
    face_arm = np.median(sample(arm, uvs[np.unique(triangles[face])]), 0)
    arm_out = np.zeros((nh, nw, 4), np.float32)
    arm_out[...] = face_arm
    write("neck-arm", arm_out, normal_alpha.astype(np.float32), nbox)
    digest = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (albedo_path, normal_path, arm_path)}
    lo, hi = BOUNDS
    (OUTPUT / "lattice.json").write_text(json.dumps({
        "reference": {"head": head.round(6).tolist(), "crown": float(positions[np.unique(triangles), 1].max() - head[1])},
        "bounds": [list(lo), list(hi)],
        "resolution": list(RESOLUTION),
        "offsets": np.round(offsets, 6).reshape(-1, 3).tolist(),
        "atlas": {
            "albedo": {"sha256": digest[albedo_path.name], "x": box[0], "y": box[1], "image": "neck-albedo.png"},
            "normal": {"sha256": digest[normal_path.name], "x": nbox[0], "y": nbox[1], "image": "neck-normal.png"},
            "arm": {"sha256": digest[arm_path.name], "x": nbox[0], "y": nbox[1], "image": "neck-arm.png"},
        },
    }, indent=1) + "\n")
    print(f"neck island {int(neck.sum())} triangles, {seams} seam vertices, albedo box {box}, face ARM {face_arm.round(3).tolist()}")


main()
