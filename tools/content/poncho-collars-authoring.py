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
RIM_BLEND = (1.0, 0.58, 0.33, 0.16, 0.06)
NECK_WEIGHT = (1.0, 0.72, 0.42, 0.18, 0.04)
STYLE = ("COLOR_0", "_DYE", "_STYLE_LUMINANCE", "_STYLE_MATERIAL")
STREAMS = {
    "POSITION": "POSITION", "NORMAL": "NORMAL", "TEXCOORD_0": "TEXCOORD_0",
    "_AUTHOR_JOINTS": "JOINTS_0", "_AUTHOR_WEIGHTS": "WEIGHTS_0",
    **{"_AUTHOR_" + name.lstrip("_"): name for name in STYLE},
}


def joint_inverse_bind(source, body, name):
    node = source.doc["nodes"][body["sourcePrimitive"]["nodeIndex"]]
    skin = source.doc["skins"][node["skin"]]
    joint = body["jointNames"].index(name)
    inverse = source.accessor(skin["inverseBindMatrices"])[joint]
    return Matrix([[inverse[column * 4 + row] for column in range(4)] for row in range(4)])



def head_inverse_bind(source, body):
    return joint_inverse_bind(source, body, "Head")

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
                         -0.096 + 0.022 * max(0, depth * limit / 0.092),
                         depth * limit - 0.017))
        # Taper the new neckline into the intact woven rows.
        positions[index] = list(to_source @ ((point + (collar - rim_point) * RIM_BLEND[row]) * scale))
    return positions, rows


def reweight_woven_panel(attrs, selected, positions, rows, joint_names, bind, scale):
    neck, chest, torso, abdomen, hips = (
        joint_names.index(name) for name in ("Neck", "Chest", "Torso", "Abdomen", "Hips")
    )
    arms = {side: joint_names.index("UpperArm" + side) for side in ("L", "R")}
    joints = []
    weights = []
    for vertex, position, row in zip(selected, positions, rows):
        point = (bind @ Vector(position)) / scale
        angle = math.atan2(point.z + .024, point.x)
        rear = max(0, -math.sin(angle))
        side = abs(math.cos(angle))
        collar = NECK_WEIGHT[row] if row < len(NECK_WEIGHT) else 0

        # Let the back hang from the torso. Only the shoulder sides follow reach,
        # with a small amount of the original leg movement left at the low tips.
        upper = smoothstep(.16, .37, -point.y)
        middle = smoothstep(.31, .56, -point.y)
        lower = smoothstep(.54, .83, -point.y)
        drape = (1 - collar) * smoothstep(.12, .76, rear) * (.94 - .14 * lower)
        arm = .58 * side ** 3 * smoothstep(.14, .28, abs(point.x))
        arm *= (1 - collar - drape) * (1 - smoothstep(.35, .60, -point.y))
        influences = {
            neck: .23 * collar,
            chest: .77 * collar + drape * (1 - upper),
            torso: drape * upper * (1 - middle),
            abdomen: drape * upper * middle * (1 - lower),
            hips: drape * upper * middle * lower,
            arms["L" if point.x > 0 else "R"]: arm,
        }
        for joint, weight in zip(attrs["JOINTS_0"][vertex], attrs["WEIGHTS_0"][vertex]):
            influences[joint] = influences.get(joint, 0) + weight * (1 - collar - drape - arm)
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
        drop = -point.y

        # Shape one shoulder-to-hem curve. A separate belt clearance bulge
        # creates a shelf midway down the back when the actor turns sideways.
        back_depth = -.109 - .059 * smoothstep(.09, .29, drop)
        back_depth += .017 * smoothstep(.40, .76, drop)
        back_blend = rear ** 1.55 * smoothstep(0, 2, row)
        point.z += (back_depth - point.z) * back_blend

        # Let the front fall over the chest and belt instead of pitching away
        # from the wearer. Keep the opening curved around the upper sleeves.
        front_depth = .104 + .102 * smoothstep(.13, .53, drop)
        front_blend = .40 * front ** 1.7 * neckline * smoothstep(.23, .55, drop)
        point.z += (front_depth - point.z) * front_blend
        outer_shoulder = smoothstep(.19, .37, abs(point.x))
        point.x *= 1 - neckline * (.08 + .13 * outer_shoulder)
        # Leave a narrow overhang above the sleeve opening so the weave has room
        # to follow the upper arm when the rider brings it forward.
        lip = .017 * neckline * side ** 5 * smoothstep(.16, .23, abs(point.x))
        lip *= 1 - smoothstep(.28, .46, drop)
        point.x += math.copysign(lip, point.x)
        sleeve_edge = neckline * side ** 4
        point.y += max(0, -.11 - point.y) * .13 * sleeve_edge
        point.y -= .018 * sleeve_edge * smoothstep(-.47, -.13, point.y)

        # Low folds soften the tip without adding angular spikes along the back.
        fall = smoothstep(9, last, row)
        folds = math.sin(5 * angle + .8 * fall) + .28 * math.cos(9 * angle)
        depth = .008 * fall * folds
        point.x += depth * math.cos(angle)
        point.z += depth * math.sin(angle)
        point.y += fall * (.010 * math.cos(3 * angle + .52) - .014 + .046 * front ** 1.6)
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
    start, end = piece["start"], piece["start"] + piece["count"]
    for index in range(start, end):
        point = (bind @ Vector(output["POSITION"][index])) / scale
        # Seat the shirt under the drape and keep its folded edge below the opening.
        tuck = smoothstep(-.63, -.46, point.y) * (1 - smoothstep(-.12, -.048, point.y))
        point.x *= 1 - .06 * tuck
        rear = 1 - smoothstep(-.045, .007, point.z)
        front = smoothstep(.030, .096, point.z)
        point.z += tuck * (.092 * rear - .052 * front)
        point.y -= .062 * smoothstep(-.17, -.045, point.y)
        output["POSITION"][index] = list(to_source @ (point * scale))


def fit_sleeve_volume(source, body, output, bind, scale):
    to_source = bind.inverted()
    axes = {}
    for side in ("L", "R"):
        shoulder, elbow, wrist = (
            (bind @ joint_inverse_bind(source, body, bone + side).inverted().translation) / scale
            for bone in ("UpperArm", "LowerArm", "Wrist")
        )
        upper = elbow - shoulder
        forearm = wrist - elbow
        axes[side] = shoulder, elbow, upper, forearm, (upper.normalized() + forearm.normalized()).normalized()

    for index, position in enumerate(output["POSITION"]):
        point = (bind @ Vector(position)) / scale
        shoulder, elbow, upper, forearm, transition = axes["L" if point.x > 0 else "R"]
        # Blend across the elbow so its change in axis does not create a ridge.
        blend = smoothstep(-.026, .026, (point - elbow).dot(transition))
        upper_t = (point - shoulder).dot(upper) / upper.length_squared
        fore_t = (point - elbow).dot(forearm) / forearm.length_squared
        upper_radial = point - (shoulder + upper_t * upper)
        fore_radial = point - (elbow + fore_t * forearm)
        upper_tuck = .42 + .15 * (1 - smoothstep(.22, .89, upper_t))
        # Fade to the original sleeve before the last cuff ring.
        fore_tuck = .42 * (1 - smoothstep(.58, .93, fore_t))
        point -= (upper_radial * upper_tuck).lerp(fore_radial * fore_tuck, blend)
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
    fit_sleeve_volume(source, body, output, bind, scale)
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
