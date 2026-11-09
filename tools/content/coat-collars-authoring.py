"""Fit a bounded coat upper back/collar to its own native shirt surface.

Blender --background --factory-startup --python this-file -- outfit.wool-duster
Optional OUT_WEST_GARMENT_OUTPUT stages the portable prototype in /tmp.
"""

import hashlib
import importlib.util
import json
import os
import struct
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector
from mathutils.geometry import delaunay_2d_cdt

spec = importlib.util.spec_from_file_location("garment_surface", Path(__file__).with_name("coat-sleeves-authoring.py"))
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)


def shirt_surface(attrs, shirt):
    selected = list(range(shirt["start"], shirt["start"] + shirt["count"]))
    uv = [attrs["TEXCOORD_0"][i] for i in selected]
    lo = [min(p[k] for p in uv) for k in range(2)]
    hi = [max(p[k] for p in uv) for k in range(2)]
    parameter = [[(p[k] - lo[k]) / (hi[k] - lo[k]) for k in range(2)] for p in uv]
    cdt = delaunay_2d_cdt([Vector(p) for p in parameter], [], [], 0, 1e-8)
    mapping = [min(range(len(parameter)), key=lambda i: (p - Vector(parameter[i])).length_squared) for p in cdt[0]]
    faces = [[mapping[i] for i in tri] for tri in cdt[2]]

    def sample(u, v):
        for face in faces:
            p, q, r = [parameter[i] for i in face]
            det = (q[1] - r[1]) * (p[0] - r[0]) + (r[0] - q[0]) * (p[1] - r[1])
            if abs(det) < 1e-12:
                continue
            a = ((q[1] - r[1]) * (u - r[0]) + (r[0] - q[0]) * (v - r[1])) / det
            b = ((r[1] - p[1]) * (u - r[0]) + (p[0] - r[0]) * (v - r[1])) / det
            c = 1 - a - b
            if min(a, b, c) < -1e-6:
                continue
            position, normal = Vector((0, 0, 0)), Vector((0, 0, 0))
            for i, weight in zip(face, (a, b, c)):
                position += Vector(attrs["POSITION"][selected[i]]) * weight
                normal += Vector(attrs["NORMAL"][selected[i]]) * weight
            return position, normal.normalized()
        raise ValueError(f"Missing native shirt surface at {u},{v}")

    obj = common.author_mesh("Native same-body shirt donor", [attrs["POSITION"][i] for i in selected], faces, parameter,
                             [attrs["JOINTS_0"][i] for i in selected], [attrs["WEIGHTS_0"][i] for i in selected])
    return obj, sample


def upper_back(source, body):
    attrs, names = body["attrs"], body["jointNames"]
    shirt = next((r for r in body["ranges"] if r.get("name") == "WesternShirt"), None)
    candidates = []
    for piece in body["ranges"]:
        if piece.get("swatch") != "wool" or piece["count"] != 403:
            continue
        uv = [attrs["TEXCOORD_0"][i] for i in range(piece["start"], piece["start"] + piece["count"])]
        if len({round(v[0], 6) for v in uv}) == 31 and len({round(v[1], 6) for v in uv}) == 13:
            candidates.append(piece)
    if not candidates:
        return None
    if len(candidates) != 1 or not shirt:
        raise ValueError("Coat collar requires one native structured body and shirt donor")
    coat = candidates[0]
    start, end = coat["start"], coat["start"] + coat["count"]
    uv = [attrs["TEXCOORD_0"][i] for i in range(start, end)]
    us = sorted({round(v[0], 6) for v in uv})
    vs = sorted({round(v[1], 6) for v in uv})
    grid = {(vs.index(round(v[1], 6)), us.index(round(v[0], 6))): i for i, v in zip(range(start, end), uv)}
    source_faces = [(k // 3, body["indices"][k:k + 3]) for k in range(0, len(body["indices"]), 3) if all(start <= i < end for i in body["indices"][k:k + 3])]
    if len(source_faces) != 720:
        raise ValueError("Native coat loft triangle inventory changed")
    donor, sample = shirt_surface(attrs, shirt)
    obj = common.author_mesh("Fitted coat upper back", [attrs["POSITION"][i] for i in range(start, end)],
                             [[i - start for i in face] for _, face in source_faces], uv,
                             [attrs["JOINTS_0"][i] for i in range(start, end)], [attrs["WEIGHTS_0"][i] for i in range(start, end)])
    mask_name = "temporary.upper-back-fit"
    mask = obj.vertex_groups.new(name=mask_name)
    changed = set()
    normals = {}
    blends = {}
    for row in range(10):
        for column in range(4, 27):
            index = grid[row, column]
            side = min(1, max(0, min(column - 3, 27 - column) / 3))
            side = side * side * (3 - 2 * side)
            blend = side * [1, 1, 1, 1, 1, 1, 1, 1, 0.8, 0.35][row]
            if row < 2:
                parameter_v = [0.997, 0.955][row]
            else:
                # Preserve each original loft height while replacing its jagged
                # transverse contour with this body's sewn shirt surface.
                low, high = 0.0, 0.997
                desired_y = attrs["POSITION"][index][1]
                for _ in range(24):
                    middle = (low + high) * 0.5
                    if sample(column / 30, middle)[0].y < desired_y:
                        low = middle
                    else:
                        high = middle
                parameter_v = (low + high) * 0.5
            point, normal = sample(column / 30, parameter_v)
            point += normal * 0.016 + Vector((0, [0.015, 0.007][row] if row < 2 else 0, 0))
            point = Vector(attrs["POSITION"][index]).lerp(point, blend)
            obj.data.vertices[index - start].co = (point.x, -point.z, point.y)
            mask.add([index - start], blend, "REPLACE")
            changed.add(index)
            blends[index] = blend
            normals[index] = normal
    # Native Data Transfer interpolates the shirt's actual joint groups. The
    # bounded mask leaves front lapels, the lower seam and all tails untouched.
    for group in donor.vertex_groups:
        if group.name not in obj.vertex_groups:
            obj.vertex_groups.new(name=group.name)
    bpy.context.view_layer.objects.active = obj
    transfer = obj.modifiers.new("Native shirt skin transfer", "DATA_TRANSFER")
    transfer.object = donor
    transfer.use_vert_data = True
    transfer.data_types_verts = {"VGROUP_WEIGHTS"}
    transfer.vert_mapping = "POLYINTERP_NEAREST"
    transfer.layers_vgroup_select_src = "ALL"
    transfer.layers_vgroup_select_dst = "NAME"
    transfer.vertex_group = mask_name
    bpy.ops.object.modifier_apply(modifier=transfer.name)
    obj.vertex_groups.remove(obj.vertex_groups[mask_name])
    obj.data.update()
    groups = {group.index: int(group.name.split(".")[1]) for group in obj.vertex_groups}
    fitted = {}
    for index in changed:
        vertex = obj.data.vertices[index - start]
        influence = sorted([(groups[g.group], g.weight) for g in vertex.groups if g.weight > 0], key=lambda row: -row[1])[:4]
        total = sum(w for _, w in influence)
        fitted[index] = {"position": [vertex.co.x, vertex.co.z, -vertex.co.y], "joints": [influence[k][0] if k < len(influence) else 0 for k in range(4)],
                         "weights": [influence[k][1] / total if k < len(influence) else 0 for k in range(4)]}
    touched = [k for k, (_, face) in enumerate(source_faces) if any(i in changed for i in face)]
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[f for i, f in enumerate(bm.faces) if i not in set(touched)], context="FACES_ONLY")
    bm.to_mesh(obj.data)
    bm.free()
    output = common.output_arrays()
    common.extract(obj, output, {"name": "FittedCoatUpperBack", "slot": "coat", "swatch": "wool", "sourceStyleIndex": start})
    source_corners = []
    for face_index, original_face in enumerate(touched):
        for vertex in range(face_index * 3, face_index * 3 + 3):
            matches = [i for i in source_faces[original_face][1] if sum((output["POSITION"][vertex][k] - (fitted[i]["position"] if i in fitted else attrs["POSITION"][i])[k]) ** 2 for k in range(3)) < 1e-14 and output["TEXCOORD_0"][vertex] == attrs["TEXCOORD_0"][i]]
            if not matches:
                raise ValueError("Native upper-back authoring changed source UV correspondence")
            original_index = matches[0]
            source_corners.append(original_index)
            normal = Vector(attrs["NORMAL"][original_index]).lerp(Vector(output["NORMAL"][vertex]), blends.get(original_index, 0)).normalized()
            output["NORMAL"][vertex] = list(normal) if original_index in changed else attrs["NORMAL"][original_index][:]
    # A short folded inner rim has real thickness and inherited native skin.
    top = [grid[0, column] for column in range(4, 27)]
    positions = [fitted[i]["position"] for i in top]
    positions += [list(Vector(fitted[i]["position"]) - normals[i] * 0.003 - Vector((0, 0.006, 0))) for i in top]
    rim_uv = [attrs["TEXCOORD_0"][i][:] for i in top] + [[attrs["TEXCOORD_0"][i][0], attrs["TEXCOORD_0"][i][1] + 0.0015] for i in top]
    count = len(top)
    faces = [[i, i + 1, count + i + 1, count + i] for i in range(count - 1)]
    rim = common.author_mesh("Folded wool collar rim", positions, faces, rim_uv,
                             [fitted[i]["joints"] for i in top] * 2, [fitted[i]["weights"] for i in top] * 2)
    rim_start = len(output["POSITION"])
    common.extract(rim, output, {"name": "FoldedCoatCollarRim", "slot": "coat", "swatch": "wool", "sourceStyleIndex": start})
    for vertex in range(rim_start, len(output["POSITION"])):
        source_corners.append(min(top, key=lambda i: abs(attrs["TEXCOORD_0"][i][0] - output["TEXCOORD_0"][vertex][0])))
    for semantic in ("COLOR_0", "_DYE", "_STYLE_LUMINANCE", "_STYLE_MATERIAL"):
        if semantic in attrs:
            output["_AUTHOR_" + semantic.lstrip("_")] = [attrs[semantic][i][:] for i in source_corners]
    donor_mesh = donor.data
    bpy.data.objects.remove(donor, do_unlink=True)
    bpy.data.meshes.remove(donor_mesh)
    inputs = [source.path, *(source.path.parent / entry["uri"] for entry in source.doc["buffers"])]
    return output, {"replaceRanges": [], "removeTriangles": [source_faces[k][0] for k in touched],
                    "sourceInputs": [{"path": str(p.relative_to(common.ROOT)), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in inputs],
                    "coatCollarFit": {"range": coat, "donor": shirt, "changedVertices": sorted(changed), "changedRows": list(range(10)), "protectedFrontColumns": [0, 1, 2, 3, 27, 28, 29, 30], "unchangedLowerRows": list(range(10, 13)),
                                      "styleSourceCorners": source_corners, "boundaryNormalMethod": "Canonical-to-authored smooth fit-mask interpolation; untouched boundary exact",
                                      "method": "Same-body native Blender UV surface reconstruction and Data Transfer skin; continuous above-belt upper/mid-back patch plus folded collar rim"}}


def write_style_surface(path, arrays, extras):
    # Reuse the shared portable writer, then append this lane's optional exact
    # source style streams. No shared writer or canonical material is modified.
    original_write_glb(path, arrays, extras)
    data = path.read_bytes()
    json_length = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20 + json_length])
    binary_start = 20 + json_length + 8
    blob = bytearray(data[binary_start:])
    primitive = doc["meshes"][0]["primitives"][0]
    for name in ("_AUTHOR_COLOR_0", "_AUTHOR_DYE", "_AUTHOR_STYLE_LUMINANCE", "_AUTHOR_STYLE_MATERIAL"):
        if name not in arrays:
            continue
        rows = arrays[name]
        width = len(rows[0])
        flat = [v for row in rows for v in row]
        offset = len(blob)
        blob.extend(struct.pack("<" + "f" * len(flat), *flat))
        view = len(doc["bufferViews"])
        doc["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob) - offset})
        primitive["attributes"][name] = len(doc["accessors"])
        doc["accessors"].append({"bufferView": view, "componentType": 5126, "count": len(rows), "type": {1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4"}[width]})
    doc["buffers"][0]["byteLength"] = len(blob)
    encoded = json.dumps(doc, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    blob.extend(b"\x00" * (-len(blob) % 4))
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 28 + len(encoded) + len(blob)) + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded + struct.pack("<II", len(blob), 0x004E4942) + blob)


original_write_glb = common.write_glb
common.write_glb = write_style_surface

if __name__ == "__main__":
    common.run(upper_back, os.environ.get("OUT_WEST_GARMENT_OUTPUT", "coat-collars"))
