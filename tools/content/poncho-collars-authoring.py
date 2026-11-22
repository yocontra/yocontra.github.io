"""Fit the four woven ponchos and restore the hidden shirt and neckline faces.

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


def reweight_woven_panel(attrs, selected, positions, rows, joint_names, bind, scale):
    neck, chest = (joint_names.index(name) for name in ("Neck", "Chest"))
    arms = {side: joint_names.index("UpperArm" + side) for side in ("L", "R")}
    joints = []
    weights = []
    for vertex, position, row in zip(selected, positions, rows):
        point = (bind @ Vector(position)) / scale
        angle = math.atan2(point.z + .024, point.x)
        collar = NECK_WEIGHT[row] if row < len(NECK_WEIGHT) else 0
        # The outside seam follows the arm on reach. The front and back panels
        # retain their torso weights so they continue to hang from the shoulders.
        arm = .36 * abs(math.cos(angle)) ** 5 * smoothstep(.18, .34, abs(point.x))
        arm *= smoothstep(4, 10, row) * (1 - .36 * smoothstep(16, 23, row))
        if collar + arm == 0:
            joints.append(attrs["JOINTS_0"][vertex][:])
            weights.append(attrs["WEIGHTS_0"][vertex][:])
            continue
        influences = {neck: .30 * collar, chest: .70 * collar, arms["L" if point.x > 0 else "R"]: arm}
        for joint, weight in zip(attrs["JOINTS_0"][vertex], attrs["WEIGHTS_0"][vertex]):
            influences[joint] = influences.get(joint, 0) + weight * (1 - collar - arm)
        strongest = sorted(influences.items(), key=lambda entry: (-entry[1], entry[0]))[:4]
        total = sum(weight for _, weight in strongest)
        joints.append([joint for joint, _ in strongest] + [0] * (4 - len(strongest)))
        weights.append([weight / total for _, weight in strongest] + [0] * (4 - len(strongest)))
    return joints, weights


def smoothstep(low, high, value):
    t = max(0.0, min(1.0, (value - low) / (high - low)))
    return t * t * (3.0 - 2.0 * t)


def drape_woven_panels(positions, rows, bind, scale):
    to_source = bind.inverted()
    last = max(rows)
    for i, row in enumerate(rows):
        if row == 0:
            continue
        point = (bind @ Vector(positions[i])) / scale
        angle = math.atan2(point.z + .024, point.x)
        side = abs(math.cos(angle))
        rear = max(0.0, -math.sin(angle))
        front = max(0.0, math.sin(angle))
        neckline = smoothstep(0, 4, row)
        sleeve = smoothstep(.10, .25, abs(point.x))
        # Seat the back panel on the ribcage and taper it through the waist.
        # The sleeve side stays looser than the cloth over the spine.
        high_back = smoothstep(-.62, -.40, point.y)
        inner_back = .042 + .057 * high_back
        point.z += neckline * rear ** 1.35 * inner_back * (1.0 - .46 * sleeve)
        # Take out the front surplus without pinning the cloth to the shirt.
        waist = math.exp(-((point.y + .55) / .15) ** 2)
        point.z += neckline * front ** 1.35 * (.073 * waist - .031 - .025 * high_back)
        belt_clearance = math.exp(-((point.y + .56) / .13) ** 2)
        belt_clearance *= 1 - smoothstep(-.54, -.40, point.y)
        point.z -= neckline * rear ** 1.25 * .067 * belt_clearance
        point.x *= 1.0 - neckline * (.095 + .018 * high_back)
        point.y -= neckline * .027 * side ** 1.3 * smoothstep(-.55, -.18, point.y)
        # The sides hang above the end of the sleeves, with the front and back
        # panels retaining their length. Keep a small gap over each upper arm.
        sleeve_edge = neckline * side ** 5
        point.y += max(0.0, -.112 - point.y) * .29 * sleeve_edge
        point.x += math.copysign((.045 + .019 * high_back) * sleeve_edge, point.x)
        point.y += .022 * sleeve_edge * smoothstep(-.42, -.18, point.y)
        # Broad woven folds fan out toward the unpinned edges under gravity.
        fall = smoothstep(4, last, row)
        ribs = math.sin(5 * angle + fall * .9) + .34 * math.cos(11 * angle - fall * .5)
        depth = fall * (.013 * ribs + .003 * math.sin(21 * angle))
        point.x += depth * math.cos(angle)
        point.z += depth * math.sin(angle)
        point.y += fall * (.012 * math.cos(3 * angle + .52) - .023)
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


def append_restored_faces(output, attrs, triangles, style):
    if not triangles:
        return
    start = len(output["POSITION"])
    vertices = sorted({vertex for face in triangles for vertex in face})
    remap = {vertex: start + index for index, vertex in enumerate(vertices)}
    for field, attribute in STREAMS.items():
        if field in output:
            output[field].extend(attrs[attribute][vertex][:] for vertex in vertices)
    output["indices"].extend(remap[vertex] for face in triangles for vertex in face)
    output["pieces"].append({
        **style, "start": start, "count": len(vertices), "sourceStyleIndex": vertices[0],
    })


def restore_linen(output, body, donor_body, name):
    own = next(p for p in body["ranges"] if p.get("name") == name)
    donor = next(p for p in donor_body["ranges"] if p.get("name") == name)
    if own["count"] != donor["count"]:
        raise ValueError(f"Incompatible {name} topology")
    attrs = body["attrs"]
    start, donor_start = own["start"], donor["start"]
    donor_uv = donor_body["attrs"]["TEXCOORD_0"]
    own_uv = attrs["TEXCOORD_0"]
    for index in range(own["count"]):
        if any(abs(a - b) > .00001 for a, b in zip(own_uv[start + index], donor_uv[donor_start + index])):
            raise ValueError(f"{name} UVs differ from its donor")
    existing = {
        tuple(sorted(face)) for face in triangles_inside(body, start, start + own["count"])
    }
    full = [
        [vertex - donor_start + start for vertex in face]
        for face in triangles_inside(donor_body, donor_start, donor_start + donor["count"])
    ]
    if not existing.issubset({tuple(sorted(face)) for face in full}):
        raise ValueError(f"{name} faces differ from its donor")
    append_restored_faces(output, attrs, full, own)
    original_indices = body["indices"]
    removed = [
        offset // 3 for offset in range(0, len(original_indices), 3)
        if all(start <= vertex < start + own["count"] for vertex in original_indices[offset:offset + 3])
    ]
    return own, removed, len(full) - len(existing)


def tuck_linen(output, bind, scale):
    to_source = bind.inverted()
    piece = output["pieces"][-1]
    is_shirt = piece["name"] == "WesternShirt"
    start, end = piece["start"], piece["start"] + piece["count"]
    for index in range(start, end):
        point = (bind @ Vector(output["POSITION"][index])) / scale
        if is_shirt:
            # Seat the torso under the drape and leave its waistband and neckline in place.
            tuck = smoothstep(-.63, -.46, point.y) * (1 - smoothstep(-.12, -.048, point.y))
            point.x *= 1 - .06 * tuck
            rear = 1 - smoothstep(-.045, .007, point.z)
            front = smoothstep(.030, .096, point.z)
            point.z += tuck * (.092 * rear - .052 * front)
        else:
            # Narrow the upper sleeve inside the shoulder wrap while preserving its cuff.
            tuck = smoothstep(-.58, -.31, point.y) * smoothstep(.15, .30, abs(point.x))
            point.x *= 1 - .21 * tuck
            point.z = .036 + (point.z - .036) * (1 - .31 * tuck)
        output["POSITION"][index] = list(to_source @ (point * scale))


def linen_reference(source):
    donor_id = "outlaw-2" if source.path.stem == "outlaw-15" else "outfit.bandolier-rig"
    return common.Source(common.SOURCES / f"{donor_id}.gltf")


def source_pins(*assets):
    inputs = [Path(__file__).resolve(), writer_path.resolve(), writer_path.with_name("coat-sleeves-authoring.py").resolve()]
    for asset in assets:
        inputs.extend([asset.path, *(asset.path.parent / entry["uri"] for entry in asset.doc["buffers"])])
    return [
        {"path": str(path.relative_to(common.ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        for path in inputs
    ]


def fit_sleeves(source, body):
    if source.path.stem not in PONCHOS:
        return None
    donor = linen_reference(source)
    output = common.output_arrays()
    sleeve, _, installed_faces = restore_linen(output, body, next(donor.bodies()), "WesternSleeves")
    bind = head_inverse_bind(source, body)
    scale = max((bind @ Vector(point)).y for point in body["attrs"]["POSITION"][:HEAD_VERTICES]) / REFERENCE_CROWN
    tuck_linen(output, bind, scale)
    return output, {
        "replaceRanges": [sleeve], "removeTriangles": [], "preserveRangeOrder": True,
        "sourceInputs": source_pins(source, donor), "restoredSleeveTriangles": installed_faces,
    }


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
    joints, weights = reweight_woven_panel(attrs, selected, positions, rows, body["jointNames"], bind, scale)
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
    append_restored_faces(output, attrs, restored, {
        "name": "RestoredPonchoNeck", "slot": "skin", "swatch": "atlas",
    })
    append_rolled_hem(output, target, attrs, faces, rows, start)
    donor = linen_reference(source)
    _, removed, restored_linen = restore_linen(output, body, next(donor.bodies()), "WesternShirt")
    tuck_linen(output, bind, scale)
    return output, {
        "replaceRanges": [target], "removeTriangles": removed, "preserveRangeOrder": True,
        "sourceInputs": source_pins(reference, donor),
        "ponchoFit": {"changedRows": list(range(max(rows) + 1)), "rimWidthsM": [0.174, 0.184],
                     "originalTriangles": len(faces), "restoredSkinTriangles": len(restored),
                     "restoredLinenTriangles": restored_linen},
    }


if __name__ == "__main__":
    common.run(fit, os.environ.get("OUT_WEST_GARMENT_OUTPUT", "coat-collars"))
    common.run(fit_sleeves, os.environ.get("OUT_WEST_PONCHO_SLEEVE_OUTPUT", "poncho-sleeves"))
