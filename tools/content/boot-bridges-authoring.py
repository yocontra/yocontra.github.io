"""Subdivide the canonical boot's hard Foot/LowerLeg transition offline.

This replaces actual mixed-joint triangles, not a presumed gap inferred from
separate weight-group bounds. Sole vertices, endpoint positions and UVs remain
exactly canonical. Run through Blender background with optional source IDs.
"""

import importlib.util
from pathlib import Path

import bmesh

spec = importlib.util.spec_from_file_location("garment_authoring", Path(__file__).with_name("coat-sleeves-authoring.py"))
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)


def bridges(source, body):
    a, names, indices = body["attrs"], body["jointNames"], body["indices"]
    output = common.output_arrays()
    removed = []
    for boot in [r for r in body["ranges"] if r.get("name") == "RidingBoot"]:
        start, end = boot["start"], boot["start"] + boot["count"]
        triangles = []
        for ordinal in range(len(indices) // 3):
            tri = indices[ordinal * 3:ordinal * 3 + 3]
            if not all(start <= i < end for i in tri):
                continue
            owners = {names[int(a["JOINTS_0"][i][0])] for i in tri}
            if any(n.startswith("Foot") for n in owners) and any(n.startswith("LowerLeg") for n in owners):
                triangles.append(tri)
                removed.append(ordinal)
        if not triangles:
            continue
        selected = sorted({i for tri in triangles for i in tri})
        foot = sorted([i for i in selected if names[int(a["JOINTS_0"][i][0])].startswith("Foot")], key=lambda i: a["TEXCOORD_0"][i][0])
        calf = sorted([i for i in selected if names[int(a["JOINTS_0"][i][0])].startswith("LowerLeg")], key=lambda i: a["TEXCOORD_0"][i][0])
        if len(foot) != len(calf) or len(foot) < 4:
            raise ValueError(f"{source.path.stem}: boot boundary rings do not match")
        if any(abs(a["TEXCOORD_0"][i][0] - a["TEXCOORD_0"][j][0]) > 1e-5 for i, j in zip(foot, calf)):
            raise ValueError(f"{source.path.stem}: boot UV seam correspondence changed")
        positions, uv, joints, weights, faces = [], [], [], [], []
        for row in range(5):
            t = row / 4
            blend = t * t * (3 - 2 * t)
            for f, c in zip(foot, calf):
                positions.append([x + (y - x) * t for x, y in zip(a["POSITION"][f], a["POSITION"][c])])
                uv.append([x + (y - x) * t for x, y in zip(a["TEXCOORD_0"][f], a["TEXCOORD_0"][c])])
                joints.append([int(a["JOINTS_0"][f][0]), int(a["JOINTS_0"][c][0]), 0, 0])
                weights.append([1 - blend, blend, 0, 0])
        width = len(foot)
        for row in range(4):
            for column in range(width - 1):
                lo = row * width + column
                faces.append([lo, lo + 1, lo + width + 1, lo + width])
        obj = common.author_mesh("Supple leather ankle", positions, faces, uv, joints, weights)
        # Native welded normals join the UV seam while leaving sole geometry alone.
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-6)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bmesh.ops.triangulate(bm, faces=list(bm.faces))
        bm.to_mesh(obj.data)
        bm.free()
        obj.data.update()
        side = names[int(a["JOINTS_0"][foot[0]][0])][-1]
        first = len(output["POSITION"])
        common.extract(obj, output, {"name": "BootAnkleBridge" + side, "slot": "boots", "swatch": boot["swatch"], "sourceStyleIndex": foot[0]})
        # These vertices meet unchanged canonical shell triangles. Keep their
        # exact shading normals as well as their original positions/UV/weights.
        for vertex in range(first, len(output["POSITION"])):
            point = output["POSITION"][vertex]
            endpoint = next((i for i in foot + calf if sum((point[k] - a["POSITION"][i][k]) ** 2 for k in range(3)) < 1e-14), None)
            if endpoint is not None:
                output["NORMAL"][vertex] = a["NORMAL"][endpoint][:]
    if not removed:
        return None
    return output, {"replaceRanges": [], "removeTriangles": sorted(removed)}


if __name__ == "__main__":
    common.run(bridges, "boot-bridges")
