"""Fit the four woven poncho necks and recover the original skin under their openings.

Blender --background --factory-startup --python tools/content/poncho-collars-authoring.py
Set OUT_WEST_GARMENT_OUTPUT to stage the portable GLBs.
"""
import hashlib
import importlib.util
import math
import os
import sys
from pathlib import Path

from mathutils import Matrix, Vector

sys.dont_write_bytecode = True
writer_path = Path(__file__).with_name("coat-collars-authoring.py")
spec = importlib.util.spec_from_file_location("woven_garment_writer", writer_path)
portable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portable)
common = portable.common

PONCHOS = {"outfit.striped-poncho", "outfit.striped-poncho.pair", "outlaw-6", "outlaw-15"}
RIM_POINTS = 28
HEAD_VERTICES = 1555
REFERENCE_CROWN = 0.1997265059272746
RIM_BLEND = (1.0, 0.50, 0.24, 0.11, 0.03)
NECK_WEIGHT = (1.0, 0.72, 0.42, 0.18, 0.04)
STYLE = ("COLOR_0", "_DYE", "_STYLE_LUMINANCE", "_STYLE_MATERIAL")
STREAMS = {
    "POSITION": "POSITION", "NORMAL": "NORMAL", "TEXCOORD_0": "TEXCOORD_0",
    "_AUTHOR_JOINTS": "JOINTS_0", "_AUTHOR_WEIGHTS": "WEIGHTS_0",
    **{"_AUTHOR_" + name.lstrip("_"): name for name in STYLE},
}


def head_inverse_bind(source, body):
    node = source.doc["nodes"][body["sourcePrimitive"]["nodeIndex"]]
    skin = source.doc["skins"][node["skin"]]
    joint = body["jointNames"].index("Head")
    inverse = source.accessor(skin["inverseBindMatrices"])[joint]
    return Matrix([[inverse[column * 4 + row] for column in range(4)] for row in range(4)])


def triangles_inside(body, start, end):
    indices = body["indices"]
    return [indices[offset:offset + 3] for offset in range(0, len(indices), 3)
            if all(start <= vertex < end for vertex in indices[offset:offset + 3])]


def fit_opening(attrs, selected, bind, scale):
    points = [(bind @ Vector(attrs["POSITION"][vertex])) / scale for vertex in selected]
    uv_rows = [round(attrs["TEXCOORD_0"][vertex][1], 5) for vertex in selected]
    order = {value: row for row, value in enumerate(sorted(set(uv_rows)))}
    rows = [order[value] for value in uv_rows]
    if len(order) != 24 or rows[:RIM_POINTS] != [0] * RIM_POINTS or rows.count(0) != RIM_POINTS:
        raise ValueError("The woven poncho lost its ordered collar rings")
    to_source = bind.inverted()
    positions = [attrs["POSITION"][vertex][:] for vertex in selected]
    for index, (point, row) in enumerate(zip(points, rows)):
        if row >= len(RIM_BLEND):
            continue
        rim_point = points[index % RIM_POINTS]
        depth = rim_point.z + 0.017
        radial = math.hypot(rim_point.x / 0.087, depth / 0.092)
        limit = 1 / max(1, radial)
        collar = Vector((rim_point.x * limit,
                         -0.073 + 0.044 * max(0, depth * limit / 0.092),
                         depth * limit - 0.017))
        # Taper the new neckline into the intact woven rows.
        positions[index] = list(to_source @ ((point + (collar - rim_point) * RIM_BLEND[row]) * scale))
    return positions, rows


def reweight_opening(attrs, selected, rows, joint_names):
    neck, chest = (joint_names.index(name) for name in ("Neck", "Chest"))
    joints = []
    weights = []
    for vertex, row in zip(selected, rows):
        if row >= len(NECK_WEIGHT):
            joints.append(attrs["JOINTS_0"][vertex][:])
            weights.append(attrs["WEIGHTS_0"][vertex][:])
            continue
        amount = NECK_WEIGHT[row]
        influences = {neck: 0.30 * amount, chest: 0.70 * amount}
        for joint, weight in zip(attrs["JOINTS_0"][vertex], attrs["WEIGHTS_0"][vertex]):
            influences[joint] = influences.get(joint, 0) + weight * (1 - amount)
        strongest = sorted(influences.items(), key=lambda entry: (-entry[1], entry[0]))[:4]
        total = sum(weight for _, weight in strongest)
        joints.append([joint for joint, _ in strongest] + [0] * (4 - len(strongest)))
        weights.append([weight / total for _, weight in strongest] + [0] * (4 - len(strongest)))
    return joints, weights


def drape_woven_panels(positions, rows, bind, scale):
    to_source = bind.inverted()
    last = max(rows)
    for i, row in enumerate(rows):
        if row < len(RIM_BLEND):
            continue
        point = (bind @ Vector(positions[i])) / scale
        angle = math.atan2(point.z + .024, point.x)
        span = (row - len(RIM_BLEND)) / (last - len(RIM_BLEND))
        ease = span * span * (3 - 2 * span)
        ribs = math.sin(5 * angle + span * 1.7) + .42 * math.cos(11 * angle - .7 * span)
        surface = ease * (0.031 * ribs + .014 * math.sin(21 * angle) * span)
        front = max(0.0, math.sin(angle))
        surface += ease * (.011 + .021 * front)
        point.x += surface * math.cos(angle)
        point.z += surface * math.sin(angle)
        rear = max(0.0, -math.sin(angle))
        # Keep loose cloth outside the leather carrier in crouch and stride.
        point.z -= .076 * rear ** 4 * math.exp(-((span - .79) / .34) ** 2)
        point.y -= ease * (.037 + .036 * math.sin(angle - .18) ** 2)
        point.y += ease * .030 * math.cos(3 * angle + .52)
        positions[i] = list(to_source @ (point * scale))


def append_rolled_hem(output, target, attrs, faces, rows, start):
    counts = {}
    for a, b, c in faces:
        for edge in ((a, b), (b, c), (c, a)):
            key = tuple(sorted(edge))
            counts[key] = counts.get(key, 0) + 1
    hem = [edge for edge, count in counts.items() if count == 1 and min(rows[i] for i in edge) >= max(rows) - 2]
    if not hem:
        raise ValueError("Missing woven hem edges")
    first = len(output["POSITION"])

    def add_vertex(vertex, point, tint):
        output["POSITION"].append(list(point))
        for name in ("NORMAL", "TEXCOORD_0", "_AUTHOR_JOINTS", "_AUTHOR_WEIGHTS"):
            output[name].append(output[name][vertex][:])
        for attribute in STYLE:
            field = "_AUTHOR_" + attribute.lstrip("_")
            if field in output:
                sample = attrs[attribute][vertex + start][:]
                if attribute == "COLOR_0":
                    sample = [value * (tint[i] if i < 3 else 1) for i, value in enumerate(sample)]
                output[field].append(sample)

    for strand, (a, b) in enumerate(hem):
        base = len(output["POSITION"])
        for vertex, inset in ((a, False), (b, False), (b, True), (a, True)):
            normal = Vector(output["NORMAL"][vertex]).normalized()
            point = Vector(output["POSITION"][vertex])
            point += normal * (.0025 if not inset else -.0014)
            if inset:
                point.y -= .0064
            add_vertex(vertex, point, (.90, .85, .76))
        output["indices"].extend([base, base + 1, base + 2, base, base + 2, base + 3])

        # Two irregular yarn ends per hem segment, weighted to the actual cloth edge.
        p, q = (Vector(output["POSITION"][vertex]) for vertex in (a, b))
        tangent = (q - p).normalized()
        normal = Vector(output["NORMAL"][a]).normalized()
        for offset in (.29, .73):
            root = p.lerp(q, offset) + normal * .0031
            phase = 13.7 * strand + 2.1 * offset
            tip = root + Vector((.005 * math.sin(phase), -.027 - .013 * math.cos(phase), 0))
            tip += normal * (.005 + .003 * math.sin(phase))
            for width in (tangent * .0017, normal * .0013):
                base = len(output["POSITION"])
                for point in (root - width, root + width, tip + width * .62, tip - width * .62):
                    add_vertex(a if offset < .5 else b, point, (.89, .81, .64))
                output["indices"].extend([base, base + 1, base + 2, base, base + 2, base + 3,
                                          base, base + 2, base + 1, base, base + 3, base + 2])
    output["pieces"].append({
        **target, "name": "Rolled woven hem and knotted fringe", "start": first,
        "count": len(output["POSITION"]) - first, "sourceStyleIndex": start,
    })


def recover_neck_faces(source, body, reference, bind):
    """The old garment cut away faces from a shared head topology, with the vertex streams intact."""
    original = triangles_inside(body, 0, HEAD_VERTICES)
    occupied = {tuple(sorted(face)) for face in original}
    positions = body["attrs"]["POSITION"]
    restored = []
    for face in triangles_inside(reference, 0, HEAD_VERTICES):
        if tuple(sorted(face)) in occupied:
            continue
        center = sum((bind @ Vector(positions[vertex]) for vertex in face), Vector()) / 3
        if -0.15 < center.y < -0.014 and center.z > -0.015:
            restored.append(face)
    expected = 46 if source.path.stem == "outlaw-15" else 44
    if len(restored) != expected:
        raise ValueError(f"{source.path.stem}: lower-neck topology changed ({len(restored)} faces)")
    # Keep the two lower edge fans on the repaired diagonals used by the other riders.
    for original_fan, repaired_fan in [
        ([[151, 147, 146], [151, 146, 152], [151, 152, 153]], [[151, 147, 153], [147, 146, 153]]),
        ([[177, 176, 178], [177, 178, 179], [177, 179, 6]], [[177, 176, 6], [176, 179, 6]]),
    ]:
        for face in original_fan:
            restored.remove(face)
        restored.extend(repaired_fan)
    return restored


def append_skin(output, attrs, triangles):
    start = len(output["POSITION"])
    vertices = sorted({vertex for face in triangles for vertex in face})
    remap = {vertex: start + index for index, vertex in enumerate(vertices)}
    for field, attribute in STREAMS.items():
        if field in output:
            output[field].extend(attrs[attribute][vertex][:] for vertex in vertices)
    output["indices"].extend(remap[vertex] for face in triangles for vertex in face)
    output["pieces"].append({
        "start": start, "count": len(vertices), "name": "RestoredPonchoNeck",
        "slot": "skin", "swatch": "atlas", "sourceStyleIndex": vertices[0],
    })


def fit(source, body):
    if source.path.stem not in PONCHOS:
        return None
    attrs = body["attrs"]
    target = next(piece for piece in body["ranges"]
                  if piece.get("swatch") == "hessian" and piece["count"] == 1120)
    start = target["start"]
    end = start + target["count"]
    selected = list(range(start, end))
    bind = head_inverse_bind(source, body)
    scale = max((bind @ Vector(point)).y for point in attrs["POSITION"][:HEAD_VERTICES]) / REFERENCE_CROWN
    positions, rows = fit_opening(attrs, selected, bind, scale)
    drape_woven_panels(positions, rows, bind, scale)
    joints, weights = reweight_opening(attrs, selected, rows, body["jointNames"])
    faces = [[vertex - start for vertex in face] for face in triangles_inside(body, start, end)]
    if len(faces) != 2184:
        raise ValueError("The original woven panel triangle count changed")
    uvs = [attrs["TEXCOORD_0"][vertex][:] for vertex in selected]
    native = common.author_mesh("Fitted woven poncho", positions, faces, uvs, joints, weights)
    normals = [attrs["NORMAL"][vertex][:] for vertex in selected]
    for index, row in enumerate(rows):
        normal = native.data.vertices[index].normal
        original = Vector(normals[index])
        authored = Vector((normal.x, normal.z, -normal.y))
        if original.dot(authored) < 0:
            authored = -authored
        normals[index] = list(original.lerp(authored, min(1, 2 * RIM_BLEND[row]) if row < len(RIM_BLEND) else .62).normalized())
    output = common.output_arrays()
    output.update({
        "POSITION": positions, "NORMAL": normals, "TEXCOORD_0": uvs,
        "_AUTHOR_JOINTS": joints, "_AUTHOR_WEIGHTS": weights,
        "indices": [vertex for face in faces for vertex in face],
        "pieces": [{**target, "start": 0, "sourceStyleIndex": start}],
    })
    for attribute in STYLE:
        if attribute in attrs:
            output["_AUTHOR_" + attribute.lstrip("_")] = [
                attrs[attribute][vertex][:] for vertex in selected
            ]
    reference = common.Source(common.SOURCES / "player.gltf")
    restored = recover_neck_faces(source, body, next(reference.bodies()), bind)
    append_skin(output, attrs, restored)
    append_rolled_hem(output, target, attrs, faces, rows, start)
    inputs = [Path(__file__).resolve(), writer_path.resolve(), writer_path.with_name("coat-sleeves-authoring.py").resolve(),
              reference.path, *(reference.path.parent / entry["uri"] for entry in reference.doc["buffers"])]
    return output, {
        "replaceRanges": [target], "removeTriangles": [], "preserveRangeOrder": True,
        "sourceInputs": [
            {"path": str(path.relative_to(common.ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            for path in inputs
        ],
        "ponchoFit": {"changedRows": list(range(max(rows) + 1)), "rimWidthsM": [0.174, 0.184],
                     "originalTriangles": len(faces), "restoredSkinTriangles": len(restored)},
    }


if __name__ == "__main__":
    common.run(fit, os.environ.get("OUT_WEST_GARMENT_OUTPUT", "coat-collars"))
