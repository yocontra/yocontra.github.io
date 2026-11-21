"""Refit two-piece linen sleeves on each native body and keep their original skin."""

import importlib.util
import math
from pathlib import Path

from mathutils import Vector

spec = importlib.util.spec_from_file_location(
    "portable_garment", Path(__file__).with_name("coat-sleeves-authoring.py")
)
portable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portable)


def sleeve(source, body):
    original = next(
        (r for r in body["ranges"] if r.get("name") == "WesternSleeves"), None
    )
    if not original:
        return None
    start = original["start"]
    stop = start + original["count"]
    attrs = body["attrs"]
    uv = attrs["TEXCOORD_0"]
    min_u = min(uv[i][0] for i in range(start, stop))
    max_u = max(uv[i][0] for i in range(start, stop))
    min_v = min(uv[i][1] for i in range(start, stop))
    max_v = max(uv[i][1] for i in range(start, stop))
    positions, coordinates, joints, weights, faces = [], [], [], [], []
    vertices = {}

    def vertex(a, b):
        key = tuple(sorted((a, b)))
        if key in vertices:
            return vertices[key]
        p = Vector(attrs["POSITION"][a]).lerp(Vector(attrs["POSITION"][b]), 0.5)
        normal = Vector(attrs["NORMAL"][a]).lerp(Vector(attrs["NORMAL"][b]), 0.5).normalized()
        tex = [(uv[a][i] + uv[b][i]) * 0.5 for i in range(2)]
        u = (tex[0] - min_u) / (max_u - min_u)
        v = (tex[1] - min_v) / (max_v - min_v)
        seam = math.exp(-((math.sin(math.tau * (u + 0.11)) / 0.21) ** 2))
        cuff = 0.0044 * math.exp(-(((v - 0.095) / 0.040) ** 2))
        pinch = -0.0019 * math.exp(-(((v - 0.141) / 0.025) ** 2))
        wrinkles = 0.0036 * math.exp(-(((v - 0.43) / 0.23) ** 2))
        wrinkles *= math.sin(38 * v + 2.8 * math.sin(math.tau * u))
        inset = max(0.0, min(1.0, v * 18, (1 - v) * 15))
        p += normal * inset * (cuff + pinch + wrinkles + 0.0020 * seam)

        influence = {}
        for i in (a, b):
            for joint, weight in zip(attrs["JOINTS_0"][i], attrs["WEIGHTS_0"][i]):
                influence[joint] = influence.get(joint, 0) + weight * 0.5
        ranked = sorted(influence.items(), key=lambda item: -item[1])[:4]
        total = sum(weight for _, weight in ranked)
        vertices[key] = len(positions)
        positions.append(list(p))
        coordinates.append(tex)
        joints.append([joint for joint, _ in ranked])
        weights.append([weight / total for _, weight in ranked])
        return vertices[key]

    indices = body["indices"]
    for i in range(0, len(indices), 3):
        a, b, c = indices[i : i + 3]
        if not all(start <= index < stop for index in (a, b, c)):
            continue
        aa, bb, cc = vertex(a, a), vertex(b, b), vertex(c, c)
        ab, bc, ca = vertex(a, b), vertex(b, c), vertex(c, a)
        faces.extend(((aa, ab, ca), (ab, bb, bc), (ca, bc, cc), (ab, bc, ca)))
    if not faces:
        raise ValueError(f"{source.path.stem}: no linen sleeve faces")

    obj = portable.author_mesh(
        "Sewn linen sleeves", positions, faces, coordinates, joints, weights
    )
    output = portable.output_arrays()
    portable.extract(obj, output, {**original, "sourceStyleIndex": start})
    return output, {
        "replaceRanges": [{"start": start, "count": stop - start}],
        "removeTriangles": [],
        "preserveRangeOrder": True,
    }


if __name__ == "__main__":
    portable.run(sleeve, "coat-sleeves")
