"""Author fitted, closed handlebar volumes with native Blender beveled curves.

Blender --background --factory-startup --python this-file -- [three source IDs].
Canonical bodies are read only; portable patches replace only moustache faces.
"""
import hashlib
import importlib.util
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import interpolate_bezier

spec = importlib.util.spec_from_file_location("portable", Path(__file__).with_name("coat-sleeves-authoring.py"))
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
IDS = ("extra.handlebar", "outlaw-5", "outlaw-16")


def matrix(values):
    return Matrix([[values[column * 4 + row] for column in range(4)] for row in range(4)])


def head_frame(source, body):
    node = source.doc["nodes"][body["sourcePrimitive"]["nodeIndex"]]
    skin = source.doc["skins"][node["skin"]]
    return matrix(source.accessor(skin["inverseBindMatrices"])[body["jointNames"].index("Head")])


def moustache_faces(body):
    beard = next(r for r in body["ranges"] if r.get("name") == "Beard")
    reference = common.Source(common.SOURCES / "extra.handlebar.gltf")
    original = next(reference.bodies())
    start = original["ranges"][0]["start"]
    triples = {tuple(i - start for i in original["indices"][k:k + 3]) for k in range(0, len(original["indices"]), 3)}
    selected = [k // 3 for k in range(0, len(body["indices"]), 3)
                if tuple(i - beard["start"] for i in body["indices"][k:k + 3]) in triples]
    if len(selected) != 46:
        raise ValueError("Handlebar source must contain exactly the original 46 faces")
    return beard, selected


def face_surface(source, body):
    head = next(r for r in body["ranges"] if r.get("slot") == "skin")
    transform = head_frame(source, body)
    points = [transform @ Vector(p) for p in body["attrs"]["POSITION"]]
    faces = [body["indices"][k:k + 3] for k in range(0, len(body["indices"]), 3)
             if all(head["start"] <= i < head["start"] + head["count"] for i in body["indices"][k:k + 3])]
    tree = BVHTree.FromPolygons(points, faces, all_triangles=True)

    def front(x, y):
        hit = tree.ray_cast(Vector((x, y, 0.3)), Vector((0, 0, -1)), 0.4)[0]
        if hit is None:
            raise ValueError(f"Missing upper-lip/cheek surface at {x},{y}")
        return hit.z
    return front


def curve_volume(front, controls, width, y_offset, side, name):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 6
    # A native lobed bevel forms coarse swept hair bundles, not a smooth tube.
    profile = bpy.data.curves.new("Directional hair clump bevel", "CURVE")
    profile.dimensions = "2D"
    ring = profile.splines.new("POLY")
    ring.points.add(15)
    ring.use_cyclic_u = True
    for i, point in enumerate(ring.points):
        angle = i * 2 * math.pi / 16
        radius = .0042 * (1 + .13 * math.cos(6 * angle))
        point.co = (math.cos(angle) * radius, math.sin(angle) * radius, 0, 1)
    bevel = bpy.data.objects.new("Temporary hair clump profile", profile)
    bpy.context.collection.objects.link(bevel)
    curve.bevel_mode = "OBJECT"
    curve.bevel_object = bevel
    curve.use_fill_caps = True
    curve.twist_mode = "MINIMUM"
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(len(controls) - 1)
    for point, (x, y, radius) in zip(spline.bezier_points, controls):
        x = x * width * side - .0018
        y += y_offset
        point.co = (x, y, front(x, y) + .0035 + max(0, abs(x) - .024) * .22)
        point.radius = radius
        point.handle_left_type = point.handle_right_type = "AUTO"
    obj = bpy.data.objects.new("Closed curled moustache", curve)
    bpy.context.collection.objects.link(obj)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    centers = []
    for a, b in zip(spline.bezier_points, list(spline.bezier_points)[1:]):
        centers.extend(interpolate_bezier(a.co, a.handle_right, b.handle_left, b.co, 13)[:-1])
    centers.append(spline.bezier_points[-1].co.copy())
    bpy.ops.object.convert(target="MESH")
    mesh = obj.data
    uv = mesh.uv_layers.new(name="Hair follows the curl")
    lengths = [0.0]
    for a, b in zip(centers, centers[1:]):
        lengths.append(lengths[-1] + (b - a).length)
    for loop in mesh.loops:
        position = mesh.vertices[loop.vertex_index].co
        index = min(range(len(centers)), key=lambda i: (position - centers[i]).length_squared)
        tangent = (centers[min(index + 1, len(centers) - 1)] - centers[max(0, index - 1)]).normalized()
        normal = tangent.cross(Vector((0, 0, 1))).normalized()
        binormal = tangent.cross(normal).normalized()
        radial = position - centers[index]
        uv.data[loop.index].uv = (lengths[index] / lengths[-1], (math.atan2(radial.dot(binormal), radial.dot(normal)) / (2 * math.pi)) % 1)
    bpy.data.curves.remove(curve)
    bpy.data.objects.remove(bevel, do_unlink=True)
    bpy.data.curves.remove(profile)
    return obj


def author(source, body, alternate=False):
    beard, removed = moustache_faces(body)
    donor_id = "outlaw-8" if alternate else "player" if source.path.stem == "extra.handlebar" else source.path.stem
    donor = common.Source(common.SOURCES / f"{donor_id}.gltf")
    donor_body = next(donor.bodies())
    front = face_surface(donor, donor_body)
    frame = head_frame(source, body)
    selected = {i for triangle in removed for i in body["indices"][triangle * 3:triangle * 3 + 3]}
    old = [frame @ Vector(body["attrs"]["POSITION"][i]) for i in selected]
    width = (max(p.x for p in old) - min(p.x for p in old)) / .0859442
    y_offset = (max(p.y for p in old) + min(p.y for p in old)) * .5 - .0421032
    if alternate:
        width, y_offset = .84, .005
    # Narrow roots split below the philtrum; the accepted lip envelope and curl
    # control points stay fixed away from that small centre part.
    sweep = [(.0016, .0445, .45), (.010, .0425, 1.30), (.021, .0405, 1.15),
             (.030, .0395, .85), (.038, .043, .55), (.039, .050, .35),
             (.034, .053, .21), (.032, .049, .07)]
    strand = [(.025, .040, .13), (.033, .041, .12), (.0395, .047, .08),
              (.0375, .0515, .025)]
    inverse = frame.inverted()
    output = common.output_arrays()
    variant = {"extra.handlebar": "brown", "outlaw-5": "delmer", "outlaw-16": "hardin"}[source.path.stem]
    for side in (-1, 1):
        for name, controls in (("HairSweep", sweep), ("TaperedStrand", strand)):
            obj = curve_volume(front, controls, width, y_offset, side, name)
            # Convert from Head space into the unchanged canonical mesh frame.
            for vertex in obj.data.vertices:
                p = inverse @ vertex.co
                vertex.co = (p.x, -p.z, p.y)
            group = obj.vertex_groups.new(name=f"joint.{body['jointNames'].index('Head')}")
            group.add(list(range(len(obj.data.vertices))), 1, "REPLACE")
            common.extract(obj, output, {"name": f"Handlebar{name}{side}", "slot": "beard", "swatch": "atlas", "surface": "handlebar-hair", "variant": variant, "sourceStyleIndex": beard["start"]})
    paths = [source.path, *(source.path.parent / b["uri"] for b in source.doc["buffers"]), donor.path,
             *(donor.path.parent / b["uri"] for b in donor.doc["buffers"]), Path(__file__), Path(common.__file__),
             Path(__file__).with_name("handlebar-textures-authoring.py"),
             *(donor.path.parent / image["uri"] for image in donor.doc.get("images", []) if "uri" in image),
             *(common.SOURCES / "textures" / name for name in (f"handlebar-hair.{variant}.albedo.png", "handlebar-hair.normal.png", "handlebar-hair.arm.png"))]
    return output, {"replaceRanges": [], "removeTriangles": removed,
                    "sourceInputs": [{"path": str(p.relative_to(common.ROOT)), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in dict.fromkeys(paths)],
                    "handlebarFit": {"donor": donor_id, "headTopology": 1644 if alternate else 1555, "headWeight": 1,
                                     "sourceMoustacheTriangles": 46, "preservedGoateeTriangles": 136 if source.path.stem == "outlaw-16" else 0,
                                     "method": "Native Blender parted Bezier sweeps, lobed clump bevel, tapered strand forks, closed caps, canonical Head inverse bind, UV follows curve"}}


if __name__ == "__main__":
    chosen = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else list(IDS)
    if not chosen or any(id not in IDS for id in chosen):
        raise ValueError("Select only the three actual handlebar sources")
    for id in chosen:
        source = common.Source(common.SOURCES / f"{id}.gltf")
        body = next(source.bodies())
        arrays, metadata = author(source, body)
        metadata.update({"jointNames": body["jointNames"], "sourceId": id, "sourceSHA256": source.digest(), "sourcePrimitive": body["sourcePrimitive"]})
        common.write_glb(common.SOURCES / "facial-hair" / f"{id}.glb", arrays, metadata)
        print(json.dumps({"id": id, "triangles": len(arrays["indices"]) // 3, "fit": metadata["handlebarFit"]}))
    if "extra.handlebar" in chosen:
        source = common.Source(common.SOURCES / "extra.handlebar.gltf")
        body = next(source.bodies())
        arrays, metadata = author(source, body, alternate=True)
        metadata.update({"jointNames": body["jointNames"], "sourceId": "extra.handlebar", "sourceSHA256": source.digest(), "sourcePrimitive": body["sourcePrimitive"]})
        common.write_glb(common.ROOT / ".out-west-qa/handlebar/alternate-fit.glb", arrays, metadata)
