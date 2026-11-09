"""Author a sewn waistcoat over the canonical shirt using Blender's native mesh pipeline."""

import bpy
import bmesh
import json
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
offset = [
    Vector(v["p"]) + Vector(v["n"]).normalized() * settings["clearance"]
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


def detail(u, v, size, sphere, tint, roughness, name):
    anchor = surface_at(u, v)
    center = Vector((anchor["p"][0], -anchor["p"][2] - 0.011, anchor["p"][1]))
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


for v in [0.17, 0.25, 0.33, 0.41]:
    detail(
        0, v, (0.0036, 0.0018, 0.0036), True, [0.23, 0.2, 0.16], 0.72, "WaistcoatButton"
    )
for u in [0.075, 0.925]:
    detail(
        u, 0.285, (0.028, 0.0015, 0.004), False, [0.65, 0.63, 0.6], 1, "WaistcoatPocket"
    )

json.dump(result, open(output_path, "w"))
print("GARMENT", len(mesh.vertices), len(mesh.loop_triangles))
