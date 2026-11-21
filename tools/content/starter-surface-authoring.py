"""Refine the starter rider folds, hand silhouettes and revolver surfaces in Blender.

Export only edited vertex channels. The canonical meshes own the indices, rig,
weights, UVs, equipment transforms and animation tracks.
"""

import gzip
import hashlib
import json
import struct
import sys
from pathlib import Path

import bmesh
from mathutils import Vector

root = Path(sys.argv[sys.argv.index("--") + 1])
art = root / "tools/art/characters"
output = art / "starter-surfaces"
targets = ("player", "outfit.trail-duds", "outfit.trail-duds.pair", "gun.rusty-six")


def accessor(doc, binary, index):
    entry = doc["accessors"][index]
    view = doc["bufferViews"][entry["bufferView"]]
    assert view["buffer"] == 0 and "sparse" not in entry and not entry.get("normalized")
    dims = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[entry["type"]]
    pattern = struct.Struct(
        "<" + {5123: "H", 5125: "I", 5126: "f"}[entry["componentType"]] * dims
    )
    base = view.get("byteOffset", 0) + entry.get("byteOffset", 0)
    stride = view.get("byteStride", pattern.size)
    return [
        pattern.unpack_from(binary, base + i * stride) for i in range(entry["count"])
    ]


def rounded(coords, normals, triangles, ids, movement, strength):
    mesh = bmesh.new()
    keys = {}
    link = {}
    for index in ids:
        key = tuple(round(axis, 5) for axis in coords[index])
        if key not in keys:
            keys[key] = mesh.verts.new(coords[index])
        link[index] = keys[key]
    for triangle in triangles:
        verts = [link[index] for index in triangle]
        if len(set(verts)) == 3:
            try:
                mesh.faces.new(verts)
            except ValueError:
                pass
    mesh.normal_update()
    smooth = [
        vert
        for vert in keys.values()
        if len(vert.link_faces) >= 3 and not vert.is_boundary and vert.is_manifold
    ]
    for _ in range(2):
        bmesh.ops.smooth_vert(
            mesh,
            verts=smooth,
            factor=strength,
            use_axis_x=True,
            use_axis_y=True,
            use_axis_z=True,
        )
    mesh.normal_update()
    active = set(smooth)
    edits = []
    for index, vert in link.items():
        if vert not in active:
            continue
        old = Vector(coords[index])
        delta = vert.co - old
        if delta.length > movement:
            delta = delta.normalized() * movement
        normal = Vector(normals[index])
        # Preserve authored edges where the old and new normals belong to different surfaces.
        if normal.dot(vert.normal) > 0.72:
            normal = normal.lerp(vert.normal, 0.44).normalized()
        edits.append([index, list(old + delta), list(normal)])
    mesh.free()
    return edits


def appearance(color, pbr, coords):
    paint = []
    for index, (metal, roughness) in enumerate(pbr):
        r, g, b = color[index][:3]
        mean = r * 0.28 + g * 0.55 + b * 0.17
        if 0.45 < metal < 0.6:
            # Dark steel keeps the original patchy patina with less orange broad reflection.
            rgb = [
                mean * 0.73 + (r - mean) * 0.24,
                mean * 0.73 + (g - mean) * 0.24,
                mean * 0.76 + (b - mean) * 0.24,
            ]
            finish = [metal + 0.13, roughness + 0.045]
        elif metal < 0.01 and 0.65 < roughness < 0.8 and coords[index][0] < -0.07:
            rgb = [r * 0.72, g * 0.55, b * 0.36]
            finish = [metal, roughness - 0.12]
        else:
            continue
        paint.append([index, [*rgb, *color[index][3:]], finish])
    return paint


for name in targets:
    source = (art / f"{name}.gltf").read_bytes()
    doc = json.loads(source)
    binary = (art / doc["buffers"][0]["uri"]).read_bytes()
    edits = []
    for mi, mesh in enumerate(doc["meshes"]):
        for pi, primitive in enumerate(mesh["primitives"]):
            attrs = primitive["attributes"]
            rigid = "_PBR" in attrs
            ranges = primitive.get("extras", {}).get("pieceRanges") or []
            if not (ranges or rigid):
                continue
            positions = accessor(doc, binary, attrs["POSITION"])
            normals = accessor(doc, binary, attrs["NORMAL"])
            index_data = [i[0] for i in accessor(doc, binary, primitive["indices"])]
            triangles = [index_data[i : i + 3] for i in range(0, len(index_data), 3)]
            shape, paint = [], []
            if rigid:
                # Keep all mechanical seats and flat metal faces fixed. Round just the grip.
                colors = accessor(doc, binary, attrs["COLOR_0"])
                pbr = accessor(doc, binary, attrs["_PBR"])
                paint = appearance(colors, pbr, positions)
                ids = {
                    i
                    for i, point in enumerate(positions)
                    if point[0] < -0.082 and pbr[i][0] < 0.01 and pbr[i][1] < 0.8
                }
                faces = [tri for tri in triangles if set(tri) <= ids]
                shape.extend(
                    rounded(positions, normals, faces, sorted(ids), 0.0011, 0.17)
                )
            else:
                for piece in ranges:
                    part = piece.get("name")
                    hand = part == "Skin" and piece["start"] > 0
                    if not (hand or part in ("WesternSleeves", "Pants")):
                        continue
                    ids = set(range(piece["start"], piece["start"] + piece["count"]))
                    faces = [tri for tri in triangles if set(tri) <= ids]
                    # Fitted boot bridges mate to exact trouser positions.
                    # Smooth the trouser lighting without moving that seam.
                    movement = 0 if part == "Pants" else (0.0026 if hand else 0.014)
                    shape.extend(
                        rounded(
                            positions,
                            normals,
                            faces,
                            sorted(ids),
                            movement,
                            0.21 if hand else 0.49,
                        )
                    )
            if shape or paint:
                edits.append(
                    {"mesh": mi, "primitive": pi, "shape": shape, "paint": paint}
                )
    if not edits:
        raise ValueError(f"No starter surface changes for {name}")
    output.mkdir(exist_ok=True)
    serialized = json.dumps(
        {"source": hashlib.sha256(source + binary).hexdigest(), "edits": edits},
        separators=(",", ":"),
    )
    (output / f"{name}.json.gz").write_bytes(
        gzip.compress(serialized.encode(), mtime=0)
    )
    print(
        name, sum(len(p["shape"]) for p in edits), sum(len(p["paint"]) for p in edits)
    )
