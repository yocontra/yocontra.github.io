"""Rebuild the duster's lower panels and add folded seams and inset welt pockets."""
import hashlib
import importlib.util
import json
import math
import os
import sys
from pathlib import Path

from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.dont_write_bytecode = True
profile_path = Path(__file__).with_name("coat-profiles.json")
profiles = json.loads(profile_path.read_text())
root = Path(__file__).resolve().parents[2]
library = root / "tools/content/poncho-collars-authoring.py"
spec = importlib.util.spec_from_file_location("wear", library)
wear = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wear)
common = wear.common
semantics = wear.STYLE


def smooth(value):
    value = max(0, min(1, value))
    return value * value * (3 - 2 * value)


def fit(source, body):
    profile = profiles.get(source.path.stem.removesuffix(".pair"))
    if profile is None:
        return None
    attrs = body["attrs"]
    parts = [piece for piece in body["ranges"] if piece.get("swatch") == "wool"]
    upper, *tails = parts[:3]
    if [piece["count"] for piece in (upper, *tails)] != [403, 165, 165]:
        raise ValueError("Unexpected duster wool panels")
    bind = wear.head_inverse_bind(source, body)
    inverse = bind.inverted()
    normal_basis = bind.to_3x3()
    to_source_normal = normal_basis.inverted()
    scale = max((bind @ Vector(p)).y for p in attrs["POSITION"][:wear.HEAD_VERTICES]) / wear.REFERENCE_CROWN
    local = [(bind @ Vector(point)) / scale for point in attrs["POSITION"]]
    output = common.output_arrays()
    for name in semantics:
        if name in attrs:
            output["_AUTHOR_" + name.lstrip("_")] = []
    changed_faces = []

    def append(vertex, point, normal, tint=(1, 1, 1)):
        output["POSITION"].append(list(inverse @ (point * scale)))
        output["NORMAL"].append(list((to_source_normal @ normal).normalized()))
        for key, original in [
            ("TEXCOORD_0", "TEXCOORD_0"),
            ("_AUTHOR_JOINTS", "JOINTS_0"),
            ("_AUTHOR_WEIGHTS", "WEIGHTS_0"),
            *(("_AUTHOR_" + name.lstrip("_"), name) for name in semantics if name in attrs),
        ]:
            value = attrs[original][vertex][:]
            if original == "COLOR_0":
                value = [channel * (tint[i] if i < 3 else 1) for i, channel in enumerate(value)]
            output[key].append(value)
        return len(output["POSITION"]) - 1

    def piece(name, start, source_part):
        output["pieces"].append({
            **source_part, "name": name, "start": start,
            "count": len(output["POSITION"]) - start,
            "sourceStyleIndex": source_part["start"],
        })

    def band(name, source_part, line, width, raised, tint):
        """Fold tape along a seam, preserving every corner's skin weights."""
        start = len(output["POSITION"])
        for index, (vertex, point, normal) in enumerate(line):
            a = line[max(0, index - 1)][1]
            b = line[min(len(line) - 1, index + 1)][1]
            across = (b - a).cross(normal).normalized()
            for side in (-1, 1):
                append(vertex, point + normal * raised + across * (width * side), normal, tint)
        for j in range(start, len(output["POSITION"]) - 2, 2):
            output["indices"].extend([j, j+1, j+2, j+1, j+3, j+2, j, j+2, j+1, j+1, j+2, j+3])
        piece(name, start, source_part)

    skin_node = source.doc["nodes"][body["sourcePrimitive"]["nodeIndex"]]
    inverse_binds = source.accessor(source.doc["skins"][skin_node["skin"]]["inverseBindMatrices"])
    def joint_point(name):
        values = inverse_binds[body["jointNames"].index(name)]
        matrix = Matrix([[values[column * 4 + row] for column in range(4)] for row in range(4)])
        return bind @ matrix.inverted().translation / scale

    for panel, side in zip(tails, ("R", "L")):
        a = panel["start"]
        b = a + panel["count"]
        chosen = range(a, b)
        faces = []
        for i in range(0, len(body["indices"]), 3):
            tri = body["indices"][i:i+3]
            if all(a <= v < b for v in tri):
                changed_faces.append(i // 3)
                faces.append([v - a for v in tri])
        rings = {}
        for v in chosen:
            rings.setdefault(round(attrs["TEXCOORD_0"][v][1], 5), []).append(v)
        layer_keys = sorted(rings, key=lambda key: -sum(local[v].y for v in rings[key]) / len(rings[key]))
        row_of = {vertex: i for i, key in enumerate(layer_keys) for vertex in rings[key]}
        normals = {}
        deformed = {}
        direction = -1 if side == "R" else 1
        hip = joint_point("UpperLeg" + side)
        knee = joint_point("LowerLeg" + side)
        column = {}
        waist = sorted(rings[layer_keys[0]], key=lambda v: attrs["TEXCOORD_0"][v][0])
        reverse = local[waist[0]].z > local[waist[-1]].z
        for key in layer_keys:
            ordered = sorted(rings[key], key=lambda v: attrs["TEXCOORD_0"][v][0], reverse=reverse)
            for index, vertex in enumerate(ordered):
                column[vertex] = index / max(1, len(ordered) - 1)

        for v in chosen:
            p = local[v].copy()
            normal = (normal_basis @ Vector(attrs["NORMAL"][v])).normalized()
            angle = math.atan2(p.z + .035, p.x)
            height = row_of[v] / (len(layer_keys) - 1)
            amount = smooth(height)
            # The waist stays pinned. Folds run down to each separate skirt's weighted hem.
            cloth = amount * (.014 * math.sin(7.0 * angle + .45 * height)
                             + .009 * math.sin(16 * angle - 2.1 * height) + .012)
            # Shape each half around its own thigh. The open front falls away
            # from the knees as the two sides pass one another in a stride.
            drape = smooth((height - .12) / .88) * profile.get("tailFit", 1)
            axis = hip.lerp(knee, min(1.24, height * 1.24))
            arc = column[v] * math.pi * .84
            tail = Vector((
                axis.x + direction * (.018 + profile["skirtWidth"] * math.sin(arc)),
                p.y + profile["hemLift"] * height ** 2,
                axis.z - .172 * math.cos(arc) - profile["rearEase"],
            ))
            p = p.lerp(tail, drape)
            p += normal * cloth * profile["foldDepth"]
            p.y += amount * (.012 * math.cos(4 * angle + .71) + .008 * math.sin(9 * angle))
            deformed[v] = p
            normals[v] = normal
        ref = common.author_mesh(
            "Pressed wool skirt panel",
            [list(inverse @ (deformed[v] * scale)) for v in chosen], faces,
            [attrs["TEXCOORD_0"][v] for v in chosen],
            [attrs["JOINTS_0"][v] for v in chosen],
            [attrs["WEIGHTS_0"][v] for v in chosen],
        )
        start = len(output["POSITION"])
        for v in chosen:
            blender_normal = ref.data.vertices[v - a].normal
            corrected = (normal_basis @ Vector((blender_normal.x, blender_normal.z, -blender_normal.y))).normalized()
            if corrected.dot(normals[v]) < 0:
                corrected = -corrected
            normals[v] = normals[v].lerp(corrected, .63).normalized()
            append(v, deformed[v], normals[v])
        output["indices"].extend(start + v for tri in faces for v in tri)
        piece("Gathered wool skirt", start, panel)
        final_row = sorted(rings[layer_keys[-1]], key=lambda v: attrs["TEXCOORD_0"][v][0])
        band("Turned lower edge", panel, [(v, deformed[v], normals[v]) for v in final_row], .004, .002, (.74,.68,.63))

    # Sample the front wool, leaving the existing lined opening and upper back untouched.
    ua = upper["start"]
    ub = ua + upper["count"]
    upper_faces = [tuple(v - ua for v in body["indices"][i:i+3])
                   for i in range(0,len(body["indices"]),3)
                   if all(ua <= v < ub for v in body["indices"][i:i+3])]
    bvh = BVHTree.FromPolygons(local[ua:ub], upper_faces, all_triangles=True)

    def project(x, y):
        point, normal, face, _ = bvh.ray_cast(Vector((x,y,.62)), Vector((0,0,-1)), .75)
        if point is None or normal is None or point.z < .025:
            return None
        if normal.z < 0:
            normal = -normal
        v = min((ua+i for i in upper_faces[face]), key=lambda i: (point-local[i]).length_squared)
        return v, point, normal

    for side in (-1, 1):
        probes = [project(side * (.091 + .0063 * i), -.39 - profile["weltTilt"] * i) for i in range(10)]
        line = [point for point in probes if point is not None]
        if len(line)<5:
            raise ValueError(f"{source.path.stem}: missing front coat surface near its pocket")

        band("Pocket welt shadow", upper, line, .009, .004, (.47,.39,.29))
        band("Turned wool pocket welt", upper, [(v,p+Vector((0,.007,0)),n) for v,p,n in line],
             .0045,.006,(.83,.79,.72))
        stitch = [(v,p+Vector((0,.014,0)),n) for v,p,n in line]
        for a,b in zip(stitch[::2],stitch[1::2]):
            band("Welt stitches", upper, [a,b], .0011,.006,(.94,.87,.72))

    input_root = common.ROOT
    copy_of_author = Path(__file__).resolve()
    return output, {
        "replaceRanges": tails, "removeTriangles": changed_faces,
        "sourceInputs": [{"path":str(path.relative_to(input_root)), "sha256":hashlib.sha256(path.read_bytes()).hexdigest()}
                         for path in (copy_of_author, profile_path, library, library.with_name("coat-collars-authoring.py"), library.with_name("coat-sleeves-authoring.py"))],
        "woolDuster": {"panels":len(tails), "retainedCollar":True, "weltPockets":2},
    }


if __name__ == "__main__":
    common.run(fit, os.environ.get("OUT_WEST_GARMENT_OUTPUT", "coat-tails"))
