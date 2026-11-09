"""Build portable, natively skinned wool sleeves from each actor's fitted shirt.

Run with Blender --background --factory-startup --python this-file -- [source ids].
Canonical glTF inputs are read only. The resulting GLBs are joined into the
original clothing primitive by the content baker, before its atlas conversion.
"""

import hashlib
import json
import struct
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector
from mathutils.geometry import delaunay_2d_cdt

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / "tools/art/characters"


class Source:
    def __init__(self, path):
        self.path = path
        self.doc = json.loads(path.read_text())
        self.buffers = [(path.parent / b["uri"]).read_bytes() for b in self.doc["buffers"]]

    def accessor(self, index):
        a = self.doc["accessors"][index]
        view = self.doc["bufferViews"][a["bufferView"]]
        fmt = {5126: "f", 5123: "H", 5125: "I", 5121: "B", 5122: "h", 5120: "b"}[a["componentType"]]
        width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[a["type"]]
        offset = view.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = view.get("byteStride", struct.calcsize(fmt) * width)
        values = [list(struct.unpack_from("<" + fmt * width, self.buffers[view["buffer"]], offset + i * stride)) for i in range(a["count"])]
        if a.get("normalized") and fmt != "f":
            maximum = {"B": 255, "H": 65535, "b": 127, "h": 32767}[fmt]
            values = [[max(-1, v / maximum) for v in row] for row in values]
        return values

    def bodies(self):
        for ni, node in enumerate(self.doc.get("nodes", [])):
            ranges = node.get("extras", {}).get("pieceRanges")
            if not (ranges and "mesh" in node and "skin" in node):
                continue
            joints = [self.doc["nodes"][j].get("name", "") for j in self.doc["skins"][node["skin"]]["joints"]]
            for pi, primitive in enumerate(self.doc["meshes"][node["mesh"]]["primitives"]):
                if "_STYLE_LUMINANCE" not in primitive["attributes"]:
                    continue
                attrs = {name: self.accessor(index) for name, index in primitive["attributes"].items()}
                indices = [i[0] for i in self.accessor(primitive["indices"])]
                yield {"attrs": attrs, "indices": indices, "ranges": ranges, "jointNames": joints,
                       "sourcePrimitive": {"nodeIndex": ni, "meshIndex": node["mesh"], "primitiveIndex": pi}}

    def digest(self):
        h = hashlib.sha256(self.path.read_bytes())
        for data in self.buffers:
            h.update(data)
        return h.hexdigest()


def influence(attrs, index, names, predicate):
    return sum(w for j, w in zip(attrs["JOINTS_0"][index], attrs["WEIGHTS_0"][index]) if predicate(names[int(j)]))


def author_mesh(name, positions, faces, uvs, joints, weights):
    """Use Blender's native mesh/normal/weight representation throughout authoring."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(p[0], -p[2], p[1]) for p in positions], [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    uv = mesh.uv_layers.new(name="Canonical garment swatch")
    for loop in mesh.loops:
        uv.data[loop.index].uv = uvs[loop.vertex_index]
    groups = {}
    for i, (js, ws) in enumerate(zip(joints, weights)):
        for j, w in zip(js, ws):
            if w <= 0:
                continue
            j = int(j)
            if j not in groups:
                groups[j] = obj.vertex_groups.new(name=f"joint.{j}")
            groups[j].add([i], w, "REPLACE")
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    return obj


def extract(obj, output, piece):
    mesh = obj.data
    for poly in mesh.polygons:
        poly.use_smooth = True
    mesh.update()
    mesh.set_sharp_from_angle(angle=0.9)
    mesh.calc_loop_triangles()
    group_ids = {group.index: int(group.name.split(".")[1]) for group in obj.vertex_groups}
    start = len(output["POSITION"])
    for tri in mesh.loop_triangles:
        indices = []
        for loop_id in tri.loops:
            loop = mesh.loops[loop_id]
            vertex = mesh.vertices[loop.vertex_index]
            normal = mesh.corner_normals[loop_id].vector
            influences = sorted([(group_ids[g.group], g.weight) for g in vertex.groups if g.weight > 0], key=lambda p: -p[1])[:4]
            total = sum(w for _, w in influences)
            if total <= 0:
                raise ValueError("Authored garment lost its canonical skin")
            indices.append(len(output["POSITION"]))
            output["POSITION"].append([vertex.co.x, vertex.co.z, -vertex.co.y])
            output["NORMAL"].append([normal.x, normal.z, -normal.y])
            output["TEXCOORD_0"].append(list(mesh.uv_layers.active.data[loop_id].uv))
            output["_AUTHOR_JOINTS"].append([influences[k][0] if k < len(influences) else 0 for k in range(4)])
            output["_AUTHOR_WEIGHTS"].append([influences[k][1] / total if k < len(influences) else 0 for k in range(4)])
        output["indices"].extend(indices)
    output["pieces"].append({**piece, "start": start, "count": len(output["POSITION"]) - start, "tint": [1, 1, 1], "roughness": 1})
    bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.meshes.remove(mesh)


def output_arrays():
    return {name: [] for name in ["POSITION", "NORMAL", "TEXCOORD_0", "_AUTHOR_JOINTS", "_AUTHOR_WEIGHTS", "indices", "pieces"]}


def write_glb(path, arrays, extras):
    """Portable glTF attributes keep the canonical joint IDs without a new rig."""
    blob = bytearray()
    doc = {"asset": {"version": "2.0", "generator": "Blender native garment authoring"}, "accessors": [], "bufferViews": [], "buffers": [], "meshes": [], "nodes": [{"name": path.stem, "mesh": 0}], "scenes": [{"nodes": [0]}], "scene": 0, "extras": extras}
    attrs = {}
    for name in ["POSITION", "NORMAL", "TEXCOORD_0", "_AUTHOR_JOINTS", "_AUTHOR_WEIGHTS", "indices"]:
        rows = [[i] for i in arrays[name]] if name == "indices" else arrays[name]
        width = len(rows[0])
        fmt, component = ("I", 5125) if name == "indices" else (("H", 5123) if name == "_AUTHOR_JOINTS" else ("f", 5126))
        while len(blob) % 4:
            blob.append(0)
        offset = len(blob)
        flat = [v for row in rows for v in row]
        blob.extend(struct.pack("<" + fmt * len(flat), *flat))
        view = len(doc["bufferViews"])
        doc["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob) - offset})
        accessor = {"bufferView": view, "componentType": component, "count": len(rows), "type": {1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4"}[width]}
        if name == "POSITION":
            accessor["min"] = [min(row[k] for row in rows) for k in range(width)]
            accessor["max"] = [max(row[k] for row in rows) for k in range(width)]
        attrs[name] = len(doc["accessors"])
        doc["accessors"].append(accessor)
    doc["meshes"] = [{"primitives": [{"attributes": {k: v for k, v in attrs.items() if k != "indices"}, "indices": attrs["indices"], "extras": {"pieceRanges": arrays["pieces"]}}]}]
    doc["buffers"] = [{"byteLength": len(blob)}]
    encoded = json.dumps(doc, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    blob.extend(b"\x00" * (-len(blob) % 4))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(encoded) + 8 + len(blob)) + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded + struct.pack("<II", len(blob), 0x004E4942) + blob)


def sleeve_ranges(body):
    a, names = body["attrs"], body["jointNames"]
    return [r for r in body["ranges"] if r.get("swatch") == "wool" and sum(influence(a, i, names, lambda n: n.startswith(("UpperArm", "LowerArm", "Wrist"))) for i in range(r["start"], r["start"] + r["count"])) / r["count"] > 0.6]


def sleeves(source, body):
    a, names = body["attrs"], body["jointNames"]
    targets = sleeve_ranges(body)
    donor = next((r for r in body["ranges"] if r.get("name") == "WesternSleeves" and r.get("swatch") == "linen"), None)
    if not targets:
        return None
    if not donor:
        raise ValueError(f"{source.path.stem}: wool sleeves have no native shirt donor")
    output = output_arrays()
    wool_uv = [a["TEXCOORD_0"][i] for i in range(targets[0]["start"], targets[0]["start"] + targets[0]["count"])]
    wool_lo = [min(p[k] for p in wool_uv) for k in range(2)]
    wool_hi = [max(p[k] for p in wool_uv) for k in range(2)]
    for side in ("L", "R"):
        selected = []
        for i in range(donor["start"], donor["start"] + donor["count"]):
            left = influence(a, i, names, lambda n: n.endswith("L"))
            right = influence(a, i, names, lambda n: n.endswith("R"))
            assigned = "L" if left > right else "R" if right > left else ("L" if a["POSITION"][i][0] > 0 else "R")
            if assigned == side:
                selected.append(i)
        uv = [a["TEXCOORD_0"][i] for i in selected]
        lo = [min(p[k] for p in uv) for k in range(2)]
        hi = [max(p[k] for p in uv) for k in range(2)]
        normalized = [[(p[k] - lo[k]) / (hi[k] - lo[k]) for k in range(2)] for p in uv]
        cdt = delaunay_2d_cdt([Vector(p) for p in normalized], [], [], 0, 1e-8)
        mapping = [min(range(len(uv)), key=lambda i: (p - Vector(normalized[i])).length_squared) for p in cdt[0]]
        faces = [[mapping[i] for i in tri] for tri in cdt[2]]
        # The native donor parameterization omits the duplicated wrap column.
        # Close that sewn longitudinal seam, never bridge overlapping L/R islands.
        left = sorted([i for i, p in enumerate(normalized) if p[0] < 1e-5], key=lambda i: normalized[i][1])
        right = sorted([i for i, p in enumerate(normalized) if p[0] > 1 - 1e-5], key=lambda i: normalized[i][1])
        if len(left) != len(right):
            raise ValueError(f"{source.path.stem} {side}: unmatched sleeve seam")
        for k in range(len(left) - 1):
            faces.extend([[right[k], left[k], left[k + 1]], [right[k], left[k + 1], right[k + 1]]])
        obj = author_mesh(f"Continuous wool sleeve {side}", [a["POSITION"][i] for i in selected], faces,
                          [[wool_lo[k] + p[k] * (wool_hi[k] - wool_lo[k]) for k in range(2)] for p in normalized],
                          [a["JOINTS_0"][i] for i in selected], [a["WEIGHTS_0"][i] for i in selected])
        mesh = obj.data
        alignment = sum(mesh.vertices[k].normal.dot(Vector((a["NORMAL"][i][0], -a["NORMAL"][i][2], a["NORMAL"][i][1]))) for k, i in enumerate(selected))
        if alignment < 0:
            bm = bmesh.new()
            bm.from_mesh(mesh)
            bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
            bm.to_mesh(mesh)
            bm.free()
            mesh.update()
        for vertex in mesh.vertices:
            vertex.co += vertex.normal * 0.017
        mesh.update()
        # A small folded boundary closes the cuff without a detached cuff mesh.
        fold = obj.modifiers.new("Sewn wool edge", "SOLIDIFY")
        fold.thickness = 0.003
        fold.offset = -1
        fold.use_rim_only = True
        bpy.ops.object.modifier_apply(modifier=fold.name)
        style = max(targets, key=lambda r: sum(influence(a, i, names, lambda n: n.endswith(side)) for i in range(r["start"], r["start"] + r["count"])))
        extract(obj, output, {"name": "ContinuousCoatSleeve" + side, "slot": "coat", "swatch": "wool", "sourceStyleIndex": style["start"]})
    return output, {"replaceRanges": [{"start": r["start"], "count": r["count"]} for r in targets], "removeTriangles": []}


def run(author, directory):
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    chosen = set(args)
    inventory = []
    for path in sorted(SOURCES.glob("*.gltf")):
        if chosen and path.stem not in chosen:
            continue
        source = Source(path)
        for body in source.bodies():
            result = author(source, body)
            if result is None:
                continue
            arrays, metadata = result
            destination = SOURCES / directory / (path.stem + ".glb")
            extras = {"jointNames": body["jointNames"], "sourceId": path.stem, "sourceSHA256": source.digest(), "sourcePrimitive": body["sourcePrimitive"], **metadata,
                      "authoring": "Blender native mesh, UV reconstruction and skin groups; offline only"}
            write_glb(destination, arrays, extras)
            row = {"id": path.stem, "triangles": len(arrays["indices"]) // 3, "vertices": len(arrays["POSITION"]), "sourceSHA256": extras["sourceSHA256"], **metadata}
            inventory.append(row)
            print("AUTHORED", json.dumps(row))
    report = Path("/tmp/out-west-garment-authoring")
    report.mkdir(exist_ok=True)
    (report / (directory + "-inventory.json")).write_text(json.dumps(inventory, indent=2))


if __name__ == "__main__":
    run(sleeves, "coat-sleeves")
