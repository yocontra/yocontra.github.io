"""Author fitted 1880s riding boots and tuck each actor's trousers into them offline.

The canonical boot (cowboy-boot-model.py) is placed on every actor from its own
bind skeleton: the tread sits on the original ground contact, the toe follows
the foot joint and the shaft follows the shin through ordinary two-joint skin
weights. The original knee-high boot triangles are replaced. Trouser legs are
pulled radially inside the new shaft, reweighted to the shin where they enter,
and continued a few centimetres down inside the boot so the opening never shows
a gap. Run through Blender background with optional source IDs; an absolute
OUT_WEST_GARMENT_OUTPUT stages prototypes without changing primary artifacts.
"""

import hashlib
import importlib.util
import math
import os
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location("garment_authoring", HERE.with_name("coat-sleeves-authoring.py"))
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
model_spec = importlib.util.spec_from_file_location("cowboy_boot_model", HERE.with_name("cowboy-boot-model.py"))
model = importlib.util.module_from_spec(model_spec)
model_spec.loader.exec_module(model)

TEXTURES = common.SOURCES / "textures"
REFERENCE_SHIN = 0.443
# Darker leathers for formal and city outfits, russet for trail wear.
VARIANTS = {
    "outfit.undertakers-black": "black", "outfit.midnight-coat": "black", "outfit.gamblers-frock": "black",
    "outfit.trail-duds": "russet", "outfit.striped-poncho": "russet", "outfit.bandolier-rig": "russet",
}
OUTLAW_VARIANTS = ["chocolate", "black", "russet"]


def variant(source_id):
    base = source_id.removesuffix(".pair")
    if base in VARIANTS:
        return VARIANTS[base]
    if base.startswith("outlaw-"):
        return OUTLAW_VARIANTS[int(base.split("-")[1]) % len(OUTLAW_VARIANTS)]
    return "chocolate"


def texture_paths(name):
    return {"albedo": TEXTURES / f"cowboy-boot.{name}.albedo.png",
            "normal": TEXTURES / "cowboy-boot.normal.png", "arm": TEXTURES / "cowboy-boot.arm.png"}


_canonical = None


def canonical():
    global _canonical
    if _canonical is None:
        _canonical = model.build()
    return _canonical


def write_textures():
    m, _ = canonical()
    TEXTURES.mkdir(parents=True, exist_ok=True)
    for name in model.VARIANTS:
        maps = model.paint(m, name)
        paths = texture_paths(name)
        model.write_png(paths["albedo"], maps["albedo"])
    model.write_png(paths["normal"], maps["normal"])
    model.write_png(paths["arm"], maps["arm"])


def rotation_between(a, b):
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    v, c = np.cross(a, b), float(a @ b)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3)
    k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + k + k @ k / (1 + c)


class Placement:
    """Canonical boot frame -> this actor's bind pose for one side."""

    def __init__(self, body, side, inverse):
        attrs, names = body["attrs"], body["jointNames"]
        self.side = side
        self.foot, self.leg = names.index("Foot" + side), names.index("LowerLeg" + side)
        foot_bind = inverse[self.foot].inverted()
        self.ankle = np.array(foot_bind.translation)
        self.knee = np.array(inverse[self.leg].inverted().translation)
        old = next(r for r in body["ranges"] if r.get("name") == "RidingBoot" and int(attrs["JOINTS_0"][r["start"]][0]) == self.foot)
        self.ground = min(attrs["POSITION"][i][1] for i in range(old["start"], old["start"] + old["count"]))
        toe = np.array(foot_bind.to_3x3()) @ np.array([0, 1.0, 0])
        toe[1] = 0
        self.z = toe / np.linalg.norm(toe)
        self.y = np.array([0, 1.0, 0])
        self.x = np.cross(self.y, self.z) * (1 if side == "L" else -1)
        self.mirror = side == "R"
        self.scale = float(np.linalg.norm(self.knee - self.ankle) / REFERENCE_SHIN)
        self.shin = rotation_between(self.y, self.knee - self.ankle)
        self.origin = np.array([self.ankle[0], self.ground, self.ankle[2]])
        self.basis = np.stack([self.x, self.y, self.z], 1)
        self.old_top = max(float(self.leg_inverse(attrs["POSITION"][i])[1]) for i in range(old["start"], old["start"] + old["count"]))
        self.knee_height = float(self.leg_inverse(self.knee)[1])

    def foot_point(self, p):
        return self.origin + self.scale * (self.basis @ np.asarray(p, float))

    def leg_point(self, p):
        return self.ankle + self.shin @ (self.foot_point(p) - self.ankle)

    def place(self, p, leg_weight):
        return (1 - leg_weight) * self.foot_point(p) + leg_weight * self.leg_point(p)

    def leg_inverse(self, world):
        local = self.shin.T @ (np.asarray(world, float) - self.ankle) + self.ankle
        return self.basis.T @ (local - self.origin) / self.scale


def skinned_mesh(name, positions, faces, uvs, joints, weights):
    """Like the shared author_mesh, but keeps the canonical outward winding."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(p[0], -p[2], p[1]) for p in positions], [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    uv = mesh.uv_layers.new(name="Canonical garment swatch")
    for loop in mesh.loops:
        uv.data[loop.index].uv = uvs[loop.vertex_index]
    groups = {}
    for i, (js, ws) in enumerate(zip(joints, weights)):
        for j, w in zip(js, ws):
            if w <= 0:
                continue
            if int(j) not in groups:
                groups[int(j)] = obj.vertex_groups.new(name=f"joint.{int(j)}")
            groups[int(j)].add([i], w, "REPLACE")
    return obj


def author_boot(placement, output, source_id, style_index):
    m, _ = canonical()
    positions = [list(placement.place(p, w)) for p, w in zip(m.p, m.leg)]
    faces = [f[::-1] for f in m.f] if placement.mirror else [list(f) for f in m.f]
    joints = [[placement.foot, placement.leg, 0, 0] for _ in m.p]
    weights = [[1 - w, w, 0, 0] for w in m.leg]
    obj = skinned_mesh("Riding boot " + placement.side, positions, faces, m.uv, joints, weights)
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    # Weld the back seam and toe pole; per-loop UV seams remain intact.
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-7)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    common.extract(obj, output, {"name": "CowboyBoot" + placement.side, "slot": "boots", "swatch": "leather",
                                 "surface": "cowboy-boot", "variant": variant(source_id), "sourceStyleIndex": style_index})


def shaft_radius(y, direction):
    centre = np.array([[0, y, float(model.pchip(model.SH_Y, model.SH_CZ, y))]])
    return float(np.linalg.norm(model.cast(centre, direction[None], limit=0.12)[0] - centre[0]))


def soft_min(a, b, k=0.006):
    h = max(k - abs(a - b), 0) / k
    return min(a, b) - h * h * k / 4


def tucked(placement, world):
    """Radial trouser position inside (below the rim) or tapering into the shaft."""
    p = placement.leg_inverse(world)
    y = float(p[1])
    # The blouse used to overhang the knee-high top; let it fall to the lower rim.
    hinge, blouse = placement.knee_height + 0.015, placement.old_top - 0.03
    stretch = (hinge - (model.RIM_FRONT + 0.012)) / max(hinge - blouse, 0.02)
    d = np.array([p[0], 0.0, p[2] - float(model.pchip(model.SH_Y, model.SH_CZ, y))])
    if y < hinge and stretch > 1:
        y = hinge - (hinge - y) * stretch
    cz = float(model.pchip(model.SH_Y, model.SH_CZ, y))
    r = float(np.linalg.norm(d))
    if r < 1e-6:
        return None
    unit = d / r
    theta = math.atan2(unit[0], -unit[2])
    rim = float(model.rim_height(theta))
    if y >= hinge and y > rim + 0.075:
        return None
    if y > rim + 0.075:
        target = r
    elif y <= rim:
        target = soft_min(r, shaft_radius(y, unit) - 0.0068)
    else:
        allowance = shaft_radius(min(y, 0.45), unit) + 0.0016 + (y - rim) * 0.85
        target = soft_min(r, allowance)
    q = np.array([0, y, cz]) + unit * target
    return placement.leg_point(q), rim, y, unit


def tuck_trousers(body, placements, output):
    attrs, names, indices = body["attrs"], body["jointNames"], body["indices"]
    removed, changed = [], []
    for pants in [r for r in body["ranges"] if r.get("slot") == "pants"]:
        start, end = pants["start"], pants["start"] + pants["count"]
        source_faces = [(k // 3, indices[k:k + 3]) for k in range(0, len(indices), 3) if all(start <= i < end for i in indices[k:k + 3])]
        positions = [attrs["POSITION"][i][:] for i in range(start, end)]
        joints = [attrs["JOINTS_0"][i][:] for i in range(start, end)]
        weights = [attrs["WEIGHTS_0"][i][:] for i in range(start, end)]
        edited = {}
        for placement in placements:
            side = placement.side
            for i in range(start, end):
                if common.influence(attrs, i, names, lambda n: n in ("UpperLeg" + side, "LowerLeg" + side)) < 0.6:
                    continue
                result = tucked(placement, attrs["POSITION"][i])
                if result is None:
                    continue
                point, rim, y, _ = result
                blend = float(model.smoothstep(rim + 0.04, rim - 0.004, y))
                influence = {}
                for j, w in zip(attrs["JOINTS_0"][i], attrs["WEIGHTS_0"][i]):
                    influence[int(j)] = influence.get(int(j), 0) + w * (1 - blend)
                influence[placement.leg] = influence.get(placement.leg, 0) + blend
                top = sorted([(j, w) for j, w in influence.items() if w > 1e-6], key=lambda row: -row[1])[:4]
                total = sum(w for _, w in top)
                positions[i - start] = list(point)
                joints[i - start] = [top[k][0] if k < len(top) else 0 for k in range(4)]
                weights[i - start] = [top[k][1] / total if k < len(top) else 0 for k in range(4)]
                edited[i] = placement
        if not edited:
            continue
        touched = [k for k, (_, face) in enumerate(source_faces) if any(i in edited for i in face)]
        faces = [[i - start for i in source_faces[k][1]] for k in touched]
        uvs = [attrs["TEXCOORD_0"][i][:] for i in range(start, end)]
        # Continue each hem a few centimetres down inside its boot.
        for placement in placements:
            loops = [loop for loop in boundaries(body, pants) if sum(1 for i in loop if edited.get(i) is placement) > 0.8 * len(loop)]
            if not loops:
                continue
            hem = min(loops, key=lambda loop: sum(attrs["POSITION"][i][1] for i in loop) / len(loop))
            ring_ids = [[i - start for i in hem]]
            for depth in (0.022, 0.055):
                ring = []
                for i in hem:
                    p = placement.leg_inverse(positions[i - start])
                    cz = float(model.pchip(model.SH_Y, model.SH_CZ, p[1]))
                    d = np.array([p[0], 0.0, p[2] - cz])
                    unit = d / max(np.linalg.norm(d), 1e-6)
                    rim = float(model.rim_height(math.atan2(unit[0], -unit[2])))
                    y = min(float(p[1]), rim) - depth
                    ycz = float(model.pchip(model.SH_Y, model.SH_CZ, y))
                    q = np.array([0, y, ycz]) + unit * (shaft_radius(y, unit) - 0.0085)
                    positions.append(list(placement.leg_point(q)))
                    joints.append([placement.leg, 0, 0, 0])
                    weights.append([1, 0, 0, 0])
                    uvs.append(attrs["TEXCOORD_0"][i][:])
                    ring.append(len(positions) - 1)
                ring_ids.append(ring)
            for a, b in zip(ring_ids, ring_ids[1:]):
                for k in range(len(hem)):
                    faces.append([a[k], a[(k + 1) % len(hem)], b[(k + 1) % len(hem)], b[k]])
        obj = common.author_mesh("Tucked trousers", positions, faces, uvs, joints, weights)
        normals = attrs["NORMAL"]
        alignment = sum(obj.data.vertices[i - start].normal.dot(Vector((normals[i][0], -normals[i][2], normals[i][1]))) for i in edited)
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        if alignment < 0:
            bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        bm.to_mesh(obj.data)
        bm.free()
        common.extract(obj, output, {"name": "TuckedTrousers", "slot": "pants", "swatch": pants["swatch"], "sourceStyleIndex": start})
        removed.extend(source_faces[k][0] for k in touched)
        changed.extend(sorted(edited))
    return removed, changed


def boundaries(body, piece):
    """Recover the actual open source loops after welding duplicated normals/UVs."""
    attrs, indices = body["attrs"], body["indices"]
    start, end = piece["start"], piece["start"] + piece["count"]
    bm = bmesh.new()
    vertices = [bm.verts.new(attrs["POSITION"][i]) for i in range(start, end)]
    for i in range(0, len(indices), 3):
        tri = indices[i:i + 3]
        if all(start <= v < end for v in tri):
            try:
                bm.faces.new([vertices[v - start] for v in tri])
            except ValueError:
                pass
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-6)
    edges = {edge for edge in bm.edges if edge.is_boundary}
    loops = []
    while edges:
        edge = min(edges, key=lambda e: sorted(tuple(v.co) for v in e.verts))
        first = min(edge.verts, key=lambda v: tuple(v.co))
        vertex = first
        loop = []
        while True:
            candidates = sorted([e for e in vertex.link_edges if e in edges], key=lambda e: tuple(e.other_vert(vertex).co))
            if not candidates:
                break
            next_edge = candidates[0]
            edges.remove(next_edge)
            loop.append(min(range(start, end), key=lambda i: (Vector(attrs["POSITION"][i]) - vertex.co).length_squared))
            vertex = next_edge.other_vert(vertex)
            if vertex == first:
                break
        if vertex == first and len(loop) >= 3:
            loops.append(loop)
    bm.free()
    return loops


def boots(source, body):
    attrs = body["attrs"]
    old = [r for r in body["ranges"] if r.get("name") == "RidingBoot"]
    if not old:
        return None
    node = source.doc["nodes"][body["sourcePrimitive"]["nodeIndex"]]
    skin = source.doc["skins"][node["skin"]]
    inverse = [Matrix([[row[c * 4 + r] for c in range(4)] for r in range(4)]) for row in source.accessor(skin["inverseBindMatrices"])]
    placements = [Placement(body, side, inverse) for side in ("L", "R")]
    output = common.output_arrays()
    for placement, piece in zip(placements, sorted(old, key=lambda r: int(attrs["JOINTS_0"][r["start"]][0]) != placements[0].foot)):
        author_boot(placement, output, source.path.stem, piece["start"])
    removed, changed = tuck_trousers(body, placements, output)
    name = variant(source.path.stem)
    inputs = [source.path, *(source.path.parent / entry["uri"] for entry in source.doc["buffers"]),
              HERE.with_name("cowboy-boot-model.py"), *texture_paths(name).values()]
    provenance = [{"path": str(path.relative_to(common.ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in dict.fromkeys(inputs)]
    return output, {"replaceRanges": [{"start": r["start"], "count": r["count"]} for r in old], "removeTriangles": sorted(removed),
                    "bootVariant": name, "tuckedTrouserVertices": len(changed), "sourceInputs": provenance,
                    "scale": [round(p.scale, 4) for p in placements]}


if __name__ == "__main__":
    write_textures()
    common.run(boots, os.environ.get("OUT_WEST_GARMENT_OUTPUT", "boot-bridges"))
