"""Prepare a closed chin-fitted beard from Hardin's original open goatee.

Blender --background --factory-startup --python-exit-code 1 --python this-file
This source is prepared before its first authoring/native qualification window.
Canonical input files and the accepted Handlebar patch remain read only.
"""
import hashlib
import importlib.util
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

spec = importlib.util.spec_from_file_location("handlebar", Path(__file__).with_name("handlebar-authoring.py"))
handlebar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handlebar)
common = handlebar.common


def smooth(low, high, value):
    t = max(0, min(1, (value - low) / (high - low)))
    return t * t * (3 - 2 * t)


def goatee_faces(body):
    beard, moustache = handlebar.moustache_faces(body)
    removed = [i // 3 for i in range(0, len(body["indices"]), 3)
               if i // 3 not in moustache and all(beard["start"] <= v < beard["start"] + beard["count"]
                                                for v in body["indices"][i:i + 3])]
    if len(removed) != 136 or set(removed) & set(moustache):
        raise ValueError("Hardin beard ownership must be the 136 non-moustache faces")
    return beard, removed


def export_head_object(obj, frame, body, output, name, style):
    inverse = frame.inverted()
    for vertex in obj.data.vertices:
        point = inverse @ vertex.co
        vertex.co = (point.x, -point.z, point.y)
    group = obj.vertex_groups.new(name=f"joint.{body['jointNames'].index('Head')}")
    group.add(list(range(len(obj.data.vertices))), 1, "REPLACE")
    common.extract(obj, output, {"name": name, "slot": "beard", "swatch": "atlas",
                                 "surface": "handlebar-hair", "variant": "hardin", "sourceStyleIndex": style})


def fitted_volume(source, body):
    beard, removed = goatee_faces(body)
    frame = handlebar.head_frame(source, body)
    skin_front = handlebar.face_surface(source, body)
    selected = sorted({i for triangle in removed for i in body["indices"][triangle * 3:triangle * 3 + 3]})
    mapping = {index: local for local, index in enumerate(selected)}
    positions = [frame @ Vector(body["attrs"]["POSITION"][i]) for i in selected]
    faces = [[mapping[i] for i in body["indices"][triangle * 3:triangle * 3 + 3]] for triangle in removed]
    mesh = bpy.data.meshes.new("Original open Hardin beard disk")
    mesh.from_pydata(positions, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Fitted closed Hardin goatee", mesh)
    bpy.context.collection.objects.link(obj)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    subdivision = obj.modifiers.new("Round original angular beard boundary", "SUBSURF")
    subdivision.levels = 1
    bpy.ops.object.modifier_apply(modifier=subdivision.name)
    chin_depth = skin_front(-.0018, 0)
    for vertex in obj.data.vertices:
        point = vertex.co
        # Keep the upper beard rooted to the actual lower face. Below the jaw,
        # hair hangs as a compact volume; it must not be projected onto the neck.
        point.x = point.x * .94 - .0018
        point.y = point.y if point.y >= -.006 else -.006 + (point.y + .006) * .8
        root_ceiling = .015 - .018 * smooth(.009, .026, abs(point.x + .0018))
        point.y = min(point.y, root_ceiling)
        contact = smooth(-.010, .002, point.y)
        free_depth = chin_depth - .018 * (1 - smooth(-.043, -.006, point.y))
        depth = max(point.z, free_depth)
        if contact:
            depth = depth * (1 - contact) + (skin_front(point.x, point.y) + .002) * contact
        point.z = depth
    obj.data.update()
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    if sum(face.normal.z * face.calc_area() for face in bm.faces) < 0:
        bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    thickness = obj.vertex_groups.new(name="temporary.beard-thickness")
    for vertex in obj.data.vertices:
        t = max(0, min(1, (.016 - vertex.co.y) / .06))
        thickness.add([vertex.index], .25 + .75 * math.sin(math.pi * t), "REPLACE")
    solidify = obj.modifiers.new("Closed tapered beard thickness", "SOLIDIFY")
    solidify.thickness = .007
    solidify.offset = -1
    solidify.use_rim = True
    solidify.vertex_group = thickness.name
    solidify.thickness_vertex_group = .15
    bpy.ops.object.modifier_apply(modifier=solidify.name)
    live_thickness = obj.vertex_groups.get("temporary.beard-thickness")
    if live_thickness is not None:
        obj.vertex_groups.remove(live_thickness)
    # The old disk folds back under the jaw. Native voxel union removes internal
    # overlap after fitting, and leaves one closed volume with a rounded tip.
    remesh = obj.modifiers.new("Unify closed chin hair volume", "REMESH")
    remesh.mode = "VOXEL"
    remesh.voxel_size = .0012
    remesh.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    smoothing = obj.modifiers.new("Soften voxel perimeter", "SMOOTH")
    smoothing.factor = .35
    smoothing.iterations = 2
    bpy.ops.object.modifier_apply(modifier=smoothing.name)
    uv = obj.data.uv_layers.new(name="Hair follows chin to tip")
    for loop in obj.data.loops:
        point = obj.data.vertices[loop.vertex_index].co
        uv.data[loop.index].uv = (max(0, min(1, (.017 - point.y) / .063)),
                                 max(0, min(1, (point.x + .030) / .060)))
    tree = BVHTree.FromPolygons([v.co.copy() for v in obj.data.vertices],
                               [list(face.vertices) for face in obj.data.polygons])

    def beard_front(x, y):
        hit = tree.ray_cast(Vector((x, y, .3)), Vector((0, 0, -1)), .4)[0]
        if hit is None:
            raise ValueError(f"Missing beard clump support at {x},{y}")
        # The shared native bevel's centreline sits 3.5 mm outside its donor.
        return hit.z - .0025

    tip_y = min(vertex.co.y for vertex in obj.data.vertices) + .004
    output = common.output_arrays()
    export_head_object(obj, frame, body, output, "FittedHardinGoatee", beard["start"])
    clump = [(.006, .010, .28), (.010, -.004, .48), (.007, -.018, .40),
             (0, max(-.034, tip_y), .035)]
    for side in (-1, 0, 1):
        tuft = handlebar.curve_volume(beard_front, clump, 1, 0, side, "Natural goatee clump")
        export_head_object(tuft, frame, body, output, f"HardinBeardClump{side}", beard["start"])
    accepted = common.SOURCES / "facial-hair/outlaw-16.glb"
    inputs = [source.path, *(source.path.parent / entry["uri"] for entry in source.doc["buffers"]),
              accepted, Path(__file__), Path(handlebar.__file__), Path(common.__file__),
              *(common.SOURCES / "textures" / name for name in
                ("handlebar-hair.hardin.albedo.png", "handlebar-hair.normal.png", "handlebar-hair.arm.png"))]
    return output, {"replaceRanges": [], "removeTriangles": removed,
                    "sourceInputs": [{"path": str(path.relative_to(common.ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                                     for path in dict.fromkeys(inputs)],
                    "goateeFit": {"originalTriangles": 136, "headWeight": 1, "rootClearanceMM": 2,
                                  "maximumThicknessMM": 7, "acceptedMoustacheSHA256": hashlib.sha256(accepted.read_bytes()).hexdigest(),
                                  "method": "Native Subdivision/Solidify/VoxelRemesh/Smooth, same-head BVH root fit, tapered bevel clumps; existing matte Hardin hair PBR"}}


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else ["outlaw-16"]
    if args != ["outlaw-16"]:
        raise ValueError("This author owns only outlaw-16")
    source = common.Source(common.SOURCES / "outlaw-16.gltf")
    body = next(source.bodies())
    arrays, metadata = fitted_volume(source, body)
    metadata.update({"jointNames": body["jointNames"], "sourceId": "outlaw-16", "sourceSHA256": source.digest(),
                     "sourcePrimitive": body["sourcePrimitive"]})
    common.write_glb(common.SOURCES / "beards/outlaw-16.glb", arrays, metadata)
    print(json.dumps({"id": "outlaw-16", "triangles": len(arrays["indices"]) // 3, "fit": metadata["goateeFit"]}))
