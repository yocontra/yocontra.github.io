"""Restore missing shirt-front underlayer faces from canonical donor vertices.

Blender --background --factory-startup --python this-file -- [coat source IDs]
Only the approved front/above-belt UV region is restored; all source attributes,
existing faces and other garments remain unchanged. No runtime surface is added.
"""

import hashlib
import importlib.util
import os
from pathlib import Path

from mathutils import Vector
from mathutils.geometry import delaunay_2d_cdt

spec = importlib.util.spec_from_file_location("portable_coat_surface", Path(__file__).with_name("coat-collars-authoring.py"))
portable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portable)
common = portable.common

FRONT_U = 0.28125
BELT_V = 0.1875

# Native source inventory pins: original faces, missing ROI faces, donor vertices.
EXPECTED_TOPOLOGY = {
    'outfit.gamblers-frock': (164, 271, 180),
    'outfit.gamblers-frock.pair': (164, 271, 180),
    'outfit.midnight-coat': (190, 258, 172),
    'outfit.midnight-coat.pair': (190, 258, 172),
    'outfit.undertakers-black': (164, 271, 180),
    'outfit.undertakers-black.pair': (164, 271, 180),
    'outfit.wool-duster': (190, 258, 172),
    'outfit.wool-duster.pair': (190, 258, 172),
    'outlaw-11': (163, 263, 176),
    'outlaw-12': (204, 256, 170),
    'outlaw-14': (170, 274, 180),
    'outlaw-16': (190, 266, 176),
    'outlaw-7': (198, 255, 170),
    'outlaw-8': (200, 234, 160),
    'outlaw-9': (179, 273, 180),
}


def cross2(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def contains(point, triangle, uv):
    a, b, c = [uv[i] for i in triangle]
    determinant = cross2(a, b, c)
    if abs(determinant) < 1e-12:
        return False
    return min(cross2(point, b, c) / determinant, cross2(a, point, c) / determinant,
               cross2(a, b, point) / determinant) >= -1e-7


def overlap(first, second, uv):
    """Clip UV triangle interiors independently of the native CDT selection."""
    output = [uv[i] for i in first]
    clip = [uv[i] for i in second]
    direction = 1 if cross2(*clip) > 0 else -1
    for edge in range(3):
        if not output:
            break
        a, b = clip[edge], clip[(edge + 1) % 3]
        inputs, output = output, []
        previous = inputs[-1]
        previous_inside = cross2(a, b, previous) * direction >= -1e-12
        for current in inputs:
            current_inside = cross2(a, b, current) * direction >= -1e-12
            if current_inside != previous_inside:
                delta = [current[k] - previous[k] for k in range(2)]
                side = [b[k] - a[k] for k in range(2)]
                determinant = delta[0] * side[1] - delta[1] * side[0]
                if abs(determinant) > 1e-16:
                    t = ((a[0] - previous[0]) * side[1] - (a[1] - previous[1]) * side[0]) / determinant
                    output.append([previous[k] + t * delta[k] for k in range(2)])
            if current_inside:
                output.append(current)
            previous, previous_inside = current, current_inside
    return abs(sum(p[0] * output[(i + 1) % len(output)][1] - output[(i + 1) % len(output)][0] * p[1]
                   for i, p in enumerate(output))) / 2 if len(output) >= 3 else 0


def shirt_front(source, body):
    # Semantic coat inventory, rather than filenames or guessed vertex offsets.
    coats = [p for p in body["ranges"] if p.get("swatch") == "wool" and p["count"] == 403]
    if not coats:
        return None
    attrs = body["attrs"]
    coat_uv = [attrs["TEXCOORD_0"][i] for i in range(coats[0]["start"], coats[0]["start"] + coats[0]["count"])]
    if len(coats) != 1 or len({round(p[0], 6) for p in coat_uv}) != 31 or len({round(p[1], 6) for p in coat_uv}) != 13:
        raise ValueError("Expected the approved native 13 by 31 coat family")
    donor = next(p for p in body["ranges"] if p.get("name") == "WesternShirt")
    start, end = donor["start"], donor["start"] + donor["count"]
    uv = [attrs["TEXCOORD_0"][i] for i in range(start, end)]
    low = [min(p[k] for p in uv) for k in range(2)]
    high = [max(p[k] for p in uv) for k in range(2)]
    parameter = [[(p[k] - low[k]) / (high[k] - low[k]) for k in range(2)] for p in uv]
    originals = [(k // 3, [i - start for i in body["indices"][k:k + 3]])
                 for k in range(0, len(body["indices"]), 3)
                 if all(start <= i < end for i in body["indices"][k:k + 3])]
    old = [f for _, f in originals]
    edges = sorted({tuple(sorted((f[i], f[(i + 1) % 3]))) for f in old for i in range(3)})
    cdt = delaunay_2d_cdt([Vector(p) for p in parameter], edges, [], 0, 1e-8)
    mapping = [min(range(len(parameter)), key=lambda i: (p - Vector(parameter[i])).length_squared) for p in cdt[0]]
    if any((p - Vector(parameter[i])).length > 1e-7 for p, i in zip(cdt[0], mapping)):
        raise ValueError("Constrained shirt surface introduced a new vertex")
    faces = []
    for result in cdt[2]:
        face = [mapping[i] for i in result]
        if not all(parameter[i][1] >= BELT_V - 1e-6 and
                   (parameter[i][0] <= FRONT_U + 1e-6 or parameter[i][0] >= 1 - FRONT_U - 1e-6) for i in face):
            continue
        centroid = [sum(parameter[i][k] for i in face) / 3 for k in range(2)]
        if not any(contains(centroid, original, parameter) for original in old):
            faces.append(face)
    vertices = sorted({i for f in faces for i in f})
    if (len(old), len(faces), len(vertices)) != EXPECTED_TOPOLOGY.get(source.path.stem):
        raise ValueError(f"Approved shirt-front source topology drift for {source.path.stem}: {len(old)} old / {len(faces)} missing / {len(vertices)} vertices")
    old_keys = {tuple(sorted(f)) for f in old}
    keys = [tuple(sorted(f)) for f in faces]
    if len(set(keys)) != len(keys) or any(key in old_keys for key in keys):
        raise ValueError("Shirt restoration duplicated an existing face")
    maximum_overlap = max(overlap(face, other, parameter) for k, face in enumerate(faces) for other in old + faces[:k])
    if maximum_overlap > 1e-11:
        raise ValueError(f"Restored shirt faces overlap UV interiors: {maximum_overlap}")
    ordered = []
    for face in faces:
        p, q, r = [Vector(attrs["POSITION"][start + i]) for i in face]
        normal = sum((Vector(attrs["NORMAL"][start + i]) for i in face), Vector((0, 0, 0)))
        if (q - p).cross(r - p).dot(normal) < 0:
            face = [face[0], face[2], face[1]]
        ordered.append(face)
    source_vertices = [start + i for i in vertices]
    remap = {i: k for k, i in enumerate(vertices)}
    output = common.output_arrays()
    for target, original in [("POSITION", "POSITION"), ("NORMAL", "NORMAL"), ("TEXCOORD_0", "TEXCOORD_0"),
                             ("_AUTHOR_JOINTS", "JOINTS_0"), ("_AUTHOR_WEIGHTS", "WEIGHTS_0")]:
        output[target] = [attrs[original][i][:] for i in source_vertices]
    for semantic in ("COLOR_0", "_DYE", "_STYLE_LUMINANCE", "_STYLE_MATERIAL"):
        if semantic in attrs:
            output["_AUTHOR_" + semantic.lstrip("_")] = [attrs[semantic][i][:] for i in source_vertices]
    output["indices"] = [remap[i] for face in ordered for i in face]
    output["pieces"] = [{"name": "ContinuousShirtFrontUnderlayer", "slot": "shirt", "swatch": donor["swatch"],
                         "sourceStyleIndex": start, "start": 0, "count": len(vertices), "tint": [1, 1, 1], "roughness": 1}]
    inputs = [source.path, *(source.path.parent / b["uri"] for b in source.doc["buffers"]), Path(__file__),
              Path(__file__).with_name("coat-collars-authoring.py"), Path(__file__).with_name("coat-sleeves-authoring.py")]
    return output, {"replaceRanges": [], "removeTriangles": [],
                    "sourceInputs": [{"path": str(p.relative_to(common.ROOT)), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in inputs],
                    "shirtFrontUnderlayer": {"donor": donor, "normalizedUV": {"frontU": [[0, FRONT_U], [1 - FRONT_U, 1]], "V": [BELT_V, 1]},
                                             "rawUV": {"frontU": [[low[0], low[0] + FRONT_U * (high[0] - low[0])], [high[0] - FRONT_U * (high[0] - low[0]), high[0]]],
                                                       "V": [low[1] + BELT_V * (high[1] - low[1]), high[1]]},
                                             "missingFaces": [[start + i for i in face] for face in ordered], "sourceVertices": source_vertices,
                                             "originalShirtTriangleOrdinals": [k for k, _ in originals], "topologyCounts": {"originalFaces": len(old), "addedFaces": len(faces), "vertices": len(vertices)}, "maximumUVInteriorOverlap": maximum_overlap,
                                             "canonicalAllAttributesExact": True, "existingFacesUnchanged": True,
                                             "method": "Native Blender constrained UV CDT; append missing front underlayer faces with exact canonical attributes"}}


if __name__ == "__main__":
    common.run(shirt_front, os.environ.get("OUT_WEST_GARMENT_OUTPUT", "shirt-fronts"))
