"""Author a sewn waistcoat over the canonical shirt using Blender's native mesh pipeline."""

import bpy
import bmesh
import json
import math
import sys
from pathlib import Path
from mathutils import Vector
from mathutils.geometry import delaunay_2d_cdt

input_path, output_path = sys.argv[sys.argv.index("--") + 1 :]
settings = json.load(open(Path(__file__).with_name("waistcoat-pattern.json")))
src = json.load(open(input_path))
attrs = src["attrs"]
uvs = attrs["TEXCOORD_0"]
pts = attrs["POSITION"]
lo = [min(v[k] for v in uvs) for k in range(2)]
hi = [max(v[k] for v in uvs) for k in range(2)]
uvs = [[(v[k] - lo[k]) / (hi[k] - lo[k]) for k in range(2)] for v in uvs]
cdt = delaunay_2d_cdt([Vector(uv) for uv in uvs], [], [], 0, 1e-8)
remap = [
    min(range(len(uvs)), key=lambda i: (v.x - uvs[i][0]) ** 2 + (v.y - uvs[i][1]) ** 2)
    for v in cdt[0]
]
faces = [[remap[i] for i in tri] for tri in cdt[2]]


def source(i):
    inf = {}
    for j, w in zip(attrs["JOINTS_0"][i], attrs["WEIGHTS_0"][i]):
        inf[int(j)] = inf.get(int(j), 0) + w
    return {"p": pts[i], "n": attrs["NORMAL"][i], "uv": uvs[i], "weights": inf}


def mix(a, b, t):
    keys = a["weights"].keys() | b["weights"].keys()
    return {
        "p": [x + (y - x) * t for x, y in zip(a["p"], b["p"])],
        "uv": [x + (y - x) * t for x, y in zip(a["uv"], b["uv"])],
        "n": [x + (y - x) * t for x, y in zip(a["n"], b["n"])],
        "weights": {
            k: a["weights"].get(k, 0) * (1 - t) + b["weights"].get(k, 0) * t
            for k in keys
        },
    }


def field(q):
    u, v = q["uv"]
    front = min(u, 1 - u)
    back = abs(u - 0.5)
    neck = (
        (settings["frontDepth"] + settings["frontSlope"] * front - v)
        if front < settings["frontWidth"]
        else 10
    )
    backneck = (
        (settings["backDepth"] + settings["backSlope"] * back - v)
        if back < settings["backWidth"]
        else 10
    )
    arm = (
        min(
            ((u - side) / settings["armWidth"]) ** 2
            + ((v - settings["armLevel"]) / settings["armHeight"]) ** 2
            - 1
            for side in settings["armCenters"]
        )
        * 0.1
    )
    return min(neck, backneck, arm, v - settings["hem"])


def clip(poly):
    out = []
    for i, a in enumerate(poly):
        b = poly[(i + 1) % len(poly)]
        fa, fb = field(a), field(b)
        if fa >= 0:
            out.append(a)
        if (fa >= 0) != (fb >= 0):
            low, high = 0.0, 1.0
            for _ in range(20):
                mid = (low + high) / 2
                if (field(mix(a, b, mid)) >= 0) == (fa >= 0):
                    low = mid
                else:
                    high = mid
            out.append(mix(a, b, (low + high) / 2))
    return out


bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
vertices = []
triangles = []
for tri in faces:
    a, b, c = [source(i) for i in tri]

    def at(u, v):
        return mix(mix(a, b, u / (1 - v) if v < 1 else 0), c, v)

    for i in range(3):
        for j in range(3 - i):
            parts = [[at(i / 3, j / 3), at((i + 1) / 3, j / 3), at(i / 3, (j + 1) / 3)]]
            if j < 2 - i:
                parts.append(
                    [
                        at((i + 1) / 3, j / 3),
                        at((i + 1) / 3, (j + 1) / 3),
                        at(i / 3, (j + 1) / 3),
                    ]
                )
            for part in parts:
                poly = clip(part)
                for n in range(1, len(poly) - 1):
                    start = len(vertices)
                    vertices.extend([poly[0], poly[n], poly[n + 1]])
                    pa, pb, pc = [Vector(v["p"]) for v in vertices[start : start + 3]]
                    outward = sum(
                        (Vector(v["n"]) for v in vertices[start : start + 3]), Vector()
                    )
                    triangle = (start, start + 1, start + 2)
                    if (pb - pa).cross(pc - pa).dot(outward) < 0:
                        triangle = (start, start + 2, start + 1)
                    triangles.append(triangle)
mesh = bpy.data.meshes.new("Tailored waistcoat")


# The inset seams remain flush. Short bias folds live inside the cloth panels.
def tailoring_relief(vertex):
    u, v = vertex["uv"]
    seam = max(0, min(1, field(vertex) / 0.045))
    bias = math.sin(31 * v + 18 * u) * math.cos(12 * u)
    gathers = 0.84 * math.exp(-(((v - 0.35) / 0.18) ** 2)) + 0.16
    return seam * gathers * bias * 0.0022


offset = [
    Vector(v["p"])
    + Vector(v["n"]).normalized() * (settings["clearance"] + tailoring_relief(v))
    for v in vertices
]
mesh.from_pydata([(v.x, -v.z, v.y) for v in offset], [], triangles)
mesh.update()
obj = bpy.data.objects.new("Waistcoat", mesh)
bpy.context.collection.objects.link(obj)
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
uv = mesh.uv_layers.new(name="Tailoring")
for loop in mesh.loops:
    uv.data[loop.index].uv = vertices[loop.vertex_index]["uv"]
groups = {}
for i, v in enumerate(vertices):
    for joint, weight in v["weights"].items():
        if weight <= 0:
            continue
        if joint not in groups:
            groups[joint] = obj.vertex_groups.new(name=f"joint.{joint}")
        groups[joint].add([i], weight, "REPLACE")
bm = bmesh.new()
bm.from_mesh(mesh)
bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.00001)
bm.to_mesh(mesh)
bm.free()
mesh.update()
simplify = obj.modifiers.new("Mobile cloth budget", "DECIMATE")
simplify.ratio = min(1, 900 / len(mesh.polygons))
bpy.ops.object.modifier_apply(modifier=simplify.name)
solid = obj.modifiers.new("Folded edge", "SOLIDIFY")
solid.thickness = 0.0025
solid.offset = -1
solid.use_rim_only = True
bpy.ops.object.modifier_apply(modifier=solid.name)
for p in mesh.polygons:
    p.use_smooth = True
mesh.update()
mesh.set_sharp_from_angle(angle=0.7)
mesh.calc_loop_triangles()
groups = {v.index: int(v.name.split(".")[1]) for v in obj.vertex_groups}
result = {
    "positions": [],
    "normals": [],
    "uvs": [],
    "joints": [],
    "weights": [],
    "triangles": [],
}
for tri in mesh.loop_triangles:
    face = []
    for loop_id in tri.loops:
        loop = mesh.loops[loop_id]
        v = mesh.vertices[loop.vertex_index]
        normal = mesh.corner_normals[loop_id].vector
        inf = sorted(
            [(groups[g.group], g.weight) for g in v.groups], key=lambda x: -x[1]
        )[:4]
        total = sum(w for j, w in inf)
        face.append(len(result["positions"]))
        result["positions"].append([v.co.x, v.co.z, -v.co.y])
        result["normals"].append([normal.x, normal.z, -normal.y])
        result["uvs"].append(list(mesh.uv_layers.active.data[loop_id].uv))
        result["joints"].append([inf[k][0] if k < len(inf) else 0 for k in range(4)])
        result["weights"].append(
            [inf[k][1] / total if k < len(inf) else 0 for k in range(4)]
        )
    result["triangles"].append(face)

# Horn buttons and two welt pockets give the garment an actual Western waistcoat silhouette.
# Both use the same native shirt parameterization and inherited skin, with no runtime mounts.
result["pieces"] = [
    {
        "start": 0,
        "count": len(result["positions"]),
        "name": "Waistcoat",
        "tint": [1, 1, 1],
        "roughness": 1,
    }
]


def surface_at(u, v):
    for face in faces:
        a, b, c = [source(i) for i in face]
        au, av = a["uv"]
        bu, bv = b["uv"]
        cu, cv = c["uv"]
        det = (bv - cv) * (au - cu) + (cu - bu) * (av - cv)
        if abs(det) < 1e-10:
            continue
        wa = ((bv - cv) * (u - cu) + (cu - bu) * (v - cv)) / det
        wb = ((cv - av) * (u - cu) + (au - cu) * (v - cv)) / det
        wc = 1 - wa - wb
        if min(wa, wb, wc) >= -1e-6:
            return mix(mix(a, b, wb / (wa + wb) if wa + wb else 0), c, wc)
    raise ValueError(f"No shirt surface at {u},{v}")


def detail(u, v, size, sphere, tint, roughness, name, pad=0.003):
    anchor = surface_at(u, v)
    point = Vector(anchor["p"])
    direction = Vector(anchor["n"]).normalized()
    fitted = point + direction * (
        settings["clearance"] + tailoring_relief(anchor) + pad
    )
    center = Vector((fitted.x, -fitted.z, fitted.y))
    shape = bmesh.new()
    if sphere:
        bmesh.ops.create_uvsphere(shape, u_segments=10, v_segments=6, radius=1)
    else:
        bmesh.ops.create_cube(shape, size=2)
    bmesh.ops.scale(shape, vec=Vector(size), verts=list(shape.verts))
    bmesh.ops.translate(shape, vec=center, verts=list(shape.verts))
    bmesh.ops.triangulate(shape, faces=list(shape.faces))
    shape.normal_update()
    start = len(result["positions"])
    inf = sorted(anchor["weights"].items(), key=lambda x: -x[1])[:4]
    total = sum(w for j, w in inf)
    for face in shape.faces:
        tri = []
        for vert in face.verts:
            tri.append(len(result["positions"]))
            normal = vert.normal if sphere else face.normal
            result["positions"].append([vert.co.x, vert.co.z, -vert.co.y])
            result["normals"].append([normal.x, normal.z, -normal.y])
            result["uvs"].append(
                [
                    0.5 + (vert.co.x - center.x) / max(size[0], 0.001) * 0.025,
                    0.5 + (vert.co.z - center.z) / max(size[2], 0.001) * 0.025,
                ]
            )
            result["joints"].append(
                [inf[k][0] if k < len(inf) else 0 for k in range(4)]
            )
            result["weights"].append(
                [inf[k][1] / total if k < len(inf) else 0 for k in range(4)]
            )
        result["triangles"].append(tri)
    result["pieces"].append(
        {
            "start": start,
            "count": len(result["positions"]) - start,
            "name": name,
            "tint": tint,
            "roughness": roughness,
        }
    )
    shape.free()


for v in (0.17, 0.25, 0.33, 0.41):
    detail(
        0,
        v,
        (0.0049, 0.0022, 0.0049),
        True,
        [0.32, 0.25, 0.17],
        0.66,
        "HornWaistcoatButton",
    )
    detail(
        0,
        v,
        (0.0028, 0.0008, 0.0028),
        True,
        [0.52, 0.42, 0.29],
        0.58,
        "BurnishedButtonCentre",
        0.005,
    )


def sewn_panel(u, v, du, dv, tint, name, pad):
    """Follow the fitted surface between each pair of stitch positions."""
    width, height = 12, 3
    points, normals = [], []
    start = len(result["positions"])
    anchors = [
        surface_at(
            u + (2 * i / width - 1) * du,
            v + (2 * j / height - 1) * dv,
        )
        for j in range(height + 1)
        for i in range(width + 1)
    ]
    if min(field(anchor) for anchor in anchors) < 0.009:
        return
    for index, anchor in enumerate(anchors):
        normal = Vector(anchor["n"]).normalized()
        t = (index % (width + 1)) / width
        f = (index // (width + 1)) / height
        roll = math.sin(math.pi * t) * math.sin(math.pi * f) * 0.0016
        depth = settings["clearance"] + tailoring_relief(anchor) + pad + roll
        point = Vector(anchor["p"]) + normal * depth
        inf = sorted(anchor["weights"].items(), key=lambda item: -item[1])[:4]
        total = sum(value for _, value in inf)
        points.append(point)
        normals.append(normal)
        result["positions"].append(list(point))
        result["normals"].append(list(normal))
        result["uvs"].append([anchor["uv"][0], anchor["uv"][1]])
        result["joints"].append([inf[k][0] if k < len(inf) else 0 for k in range(4)])
        result["weights"].append(
            [inf[k][1] / total if k < len(inf) else 0 for k in range(4)]
        )
    for j in range(height):
        for i in range(width):
            a = j * (width + 1) + i
            b, c, d = a + 1, a + width + 2, a + width + 1
            for face in ((a, b, c), (a, c, d)):
                va, vb, vc = [points[k] for k in face]
                outward = sum((normals[k] for k in face), Vector())
                ordered = (
                    face if (vb - va).cross(vc - va).dot(outward) > 0 else face[::-1]
                )
                result["triangles"].append([start + k for k in ordered])
    result["pieces"].append(
        {
            "start": start,
            "count": len(points),
            "name": name,
            "tint": tint,
            "roughness": 0.94,
        }
    )


for u in (0.077, 0.923):
    for v in (0.245, 0.459):
        sewn_panel(u, v, 0.025, 0.021, [0.78, 0.72, 0.64], "LayeredPocketWelt", 0.0012)
        sewn_panel(
            u, v + 0.014, 0.024, 0.004, [0.49, 0.44, 0.40], "RecessedPocketLip", 0.0028
        )
        sewn_panel(
            u, v - 0.016, 0.023, 0.002, [0.93, 0.87, 0.77], "PocketBackstitch", 0.0022
        )

sewn_panel(0.5, 0.245, 0.079, 0.009, [0.66, 0.61, 0.54], "DrawnBackCinch", 0.0018)
sewn_panel(0.5, 0.245, 0.007, 0.013, [0.69, 0.51, 0.36], "CinchBrace", 0.0032)

json.dump(result, open(output_path, "w"))
print("GARMENT", len(mesh.vertices), len(mesh.loop_triangles))
