"""Author supple ankle transitions and closed inner boot-cuff linings offline.

This replaces actual mixed-joint triangles, not a presumed gap inferred from
separate weight-group bounds. Sole vertices, endpoint positions and UVs remain
exactly canonical. The upper lining joins actual boot and trouser boundaries
with Blender's native unequal-loop bridge, preserving both endpoint skins.
Run through Blender background with optional source IDs; an absolute
OUT_WEST_GARMENT_OUTPUT stages prototypes without changing primary artifacts.
"""

import importlib.util
import hashlib
import os
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

spec = importlib.util.spec_from_file_location("garment_authoring", Path(__file__).with_name("coat-sleeves-authoring.py"))
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)

pose_spec = importlib.util.spec_from_file_location("pose_authoring", Path(__file__).with_name("paired-poses-authoring.py"))
pose_tools = importlib.util.module_from_spec(pose_spec)
pose_spec.loader.exec_module(pose_tools)


def boundaries(body, piece):
    """Recover the actual open source loops after welding duplicated normals/UVs."""
    attrs, indices = body["attrs"], body["indices"]
    start, end = piece["start"], piece["start"] + piece["count"]
    bm = bmesh.new()
    vertices = [bm.verts.new(attrs["POSITION"][i]) for i in range(start, end)]
    for i in range(0, len(indices), 3):
        tri = indices[i:i + 3]
        if all(start <= v < end for v in tri):
            bm.faces.new([vertices[v - start] for v in tri])
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


def closed_projection_volume(target, rim_world, lower_world, local_rim):
    """Temporary, genuinely manifold inner calf volume; never a shipping cap."""
    bm = bmesh.new()
    bm.from_mesh(target.data)
    before = sum(edge.is_boundary for edge in bm.edges)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-6)
    anchor = rim_world[0]
    anchor = Vector((anchor.x, -anchor.z, anchor.y))
    seed = min(bm.verts, key=lambda v: (v.co - anchor).length_squared)
    connected = set(seed.link_faces)
    pending = list(connected)
    while pending:
        face = pending.pop()
        for edge in face.edges:
            for other in edge.link_faces:
                if other not in connected:
                    connected.add(other)
                    pending.append(other)
    bmesh.ops.delete(bm, geom=[face for face in bm.faces if face not in connected], context="FACES_ONLY")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bmesh.ops.holes_fill(bm, edges=[edge for edge in bm.edges if edge.is_boundary], sides=0)
    # End the fitting volume below the LOWEST real rim, so "inside" also means
    # physically tucked under the opening rather than visible through its mouth.
    cutoff = max(point.y for point in local_rim) + 0.002 / lower_world.to_scale().y
    point = lower_world @ Vector((0, cutoff, 0))
    normal = (lower_world.to_3x3() @ Vector((0, -1, 0))).normalized()
    point, normal = Vector((point.x, -point.z, point.y)), Vector((normal.x, -normal.z, normal.y))
    bmesh.ops.bisect_plane(bm, geom=[*bm.verts, *bm.edges, *bm.faces], dist=1e-6, plane_co=point, plane_no=normal, clear_outer=True)
    bmesh.ops.holes_fill(bm, edges=[edge for edge in bm.edges if edge.is_boundary], sides=0)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    if bm.calc_volume(signed=True) < 0:
        bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
    boundary = sum(edge.is_boundary for edge in bm.edges)
    nonmanifold = sum(not edge.is_manifold for edge in bm.edges)
    volume = bm.calc_volume(signed=True)
    if boundary or nonmanifold or volume <= 1e-8:
        raise ValueError(f"Projection target is not a closed outward boot volume: {boundary}/{nonmanifold}/{volume}")
    bmesh.ops.triangulate(bm, faces=list(bm.faces))
    bm.to_mesh(target.data)
    bm.free()
    target.data.update()
    return {"originalBoundaryEdges": before, "boundaryEdges": boundary, "nonManifoldEdges": nonmanifold, "positiveVolumeMeters3": volume, "calfCutoffY": cutoff, "rimInsetMeters": 0.002}


def fit_posed_knee(source, body, pants, obj, inverse):
    """Correct only the pixel-verified knee fold, then bake it back through skin."""
    import hashlib
    reference = common.Source(common.SOURCES / "outlaw-2.gltf")
    reference_body = next(reference.bodies())
    # Exact source correspondence from the accepted native camera/ray audit.
    # The second set is the original source of three visible replacement faces.
    verified_triangles = [9563, 9565, 9567, *range(9647, 9655)]
    reference_ids = {i for k in verified_triangles for i in reference_body["indices"][k * 3:k * 3 + 3]}
    reference_uvs = {tuple(reference_body["attrs"]["TEXCOORD_0"][i]) for i in reference_ids}
    pose_path = common.SOURCES / "seated-poses" / (source.path.stem + ".glb")
    if not pose_path.exists():
        pose_path = common.SOURCES / "seated-poses/outlaw-2.glb"
    pose = pose_tools.read_glb(pose_path)
    _, world = pose_tools.Poses(pose, source.doc).evaluate("Town_Sit", 0)
    node = source.doc["nodes"][body["sourcePrimitive"]["nodeIndex"]]
    skin = source.doc["skins"][node["skin"]]
    matrices = [world[joint] @ ibm for joint, ibm in zip(skin["joints"], inverse)]
    attrs, names, indices = body["attrs"], body["jointNames"], body["indices"]
    start, end = pants["start"], pants["start"] + pants["count"]

    def weighted(index):
        result = Matrix.Identity(4) * 0
        for joint, weight in zip(attrs["JOINTS_0"][index], attrs["WEIGHTS_0"][index]):
            if weight:
                result += matrices[int(joint)] * weight
        return result

    skin_matrices = {i: weighted(i) for i in range(start, end)}
    posed = {i: skin_matrices[i] @ Vector((*attrs["POSITION"][i], 1)) for i in range(start, end)}
    source_faces = [[v - start for v in indices[k:k + 3]] for k in range(0, len(indices), 3) if all(start <= v < end for v in indices[k:k + 3])]
    temporary = common.author_mesh("Pixel-verified posed knee fit", [list(posed[i][:3]) for i in range(start, end)], source_faces,
                                   [attrs["TEXCOORD_0"][i] for i in range(start, end)], [attrs["JOINTS_0"][i] for i in range(start, end)], [attrs["WEIGHTS_0"][i] for i in range(start, end)])
    edited = set()
    volumes = {}
    for side in ("L", "R"):
        lower, foot = names.index("LowerLeg" + side), names.index("Foot" + side)
        boot = next(r for r in body["ranges"] if r.get("name") == "RidingBoot" and int(attrs["JOINTS_0"][r["start"]][0]) == foot)
        loops = [loop for loop in boundaries(body, boot) if len(loop) >= 12 and sum(common.influence(attrs, i, names, lambda n: n == "LowerLeg" + side) for i in loop) / len(loop) > 0.8]
        rim = max(loops, key=lambda loop: sum(attrs["POSITION"][i][1] for i in loop) / len(loop))
        rim_world = [weighted(i) @ Vector((*attrs["POSITION"][i], 1)) for i in rim]
        local_rim = [inverse[lower] @ Vector((*attrs["POSITION"][i], 1)) for i in rim]
        knee_y = world[skin["joints"][lower]].translation.y
        group_name = "temporary.verified-knee." + side
        group = temporary.vertex_groups.new(name=group_name)
        for i in range(start, end):
            if tuple(attrs["TEXCOORD_0"][i]) not in reference_uvs or common.influence(attrs, i, names, lambda n: n in ("UpperLeg" + side, "LowerLeg" + side)) < 0.85:
                continue
            bind_local = inverse[lower] @ Vector((*attrs["POSITION"][i], 1))
            if bind_local.y < -0.12:
                continue
            amount = min(1, max(0, (knee_y + 0.015 - posed[i].y) / 0.020))
            amount = amount * amount * (3 - 2 * amount)
            if amount > 1e-6:
                edited.add(i)
                group.add([i - start], amount * 0.96, "REPLACE")
        bs, be = boot["start"], boot["start"] + boot["count"]
        boot_positions = [list((weighted(i) @ Vector((*attrs["POSITION"][i], 1)))[:3]) for i in range(bs, be)]
        boot_faces = [[v - bs for v in indices[k:k + 3]] for k in range(0, len(indices), 3) if all(bs <= v < be for v in indices[k:k + 3])]
        target = common.author_mesh("Temporary closed boot volume", boot_positions, boot_faces,
                                    [attrs["TEXCOORD_0"][i] for i in range(bs, be)], [attrs["JOINTS_0"][i] for i in range(bs, be)], [attrs["WEIGHTS_0"][i] for i in range(bs, be)])
        volumes[side] = closed_projection_volume(target, rim_world, world[skin["joints"][lower]], local_rim)
        bpy.context.view_layer.objects.active = temporary
        modifier = temporary.modifiers.new("Inside actual posed boot mouth " + side, "SHRINKWRAP")
        modifier.target, modifier.vertex_group = target, group_name
        modifier.wrap_method, modifier.wrap_mode, modifier.offset = "NEAREST_SURFACEPOINT", "INSIDE", 0.002
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        temporary.vertex_groups.remove(temporary.vertex_groups[group_name])
        target_mesh = target.data
        bpy.data.objects.remove(target, do_unlink=True)
        bpy.data.meshes.remove(target_mesh)
    maximum = 0
    for i in edited:
        point = temporary.data.vertices[i - start].co
        desired = Vector((point.x, point.z, -point.y, 1))
        maximum = max(maximum, (desired.to_3d() - posed[i].to_3d()).length)
        bind = skin_matrices[i].inverted() @ desired
        bind /= bind.w
        attrs["POSITION"][i] = list(bind[:3])
        obj.data.vertices[i - start].co = (bind.x, -bind.z, bind.y)
    obj.data.update()
    mesh = temporary.data
    bpy.data.objects.remove(temporary, do_unlink=True)
    bpy.data.meshes.remove(mesh)
    return edited, {"referenceSourceId": "outlaw-2", "referenceSourceSHA256": reference.digest(), "referenceSourceTriangles": verified_triangles,
                    "posePath": str(pose_path.relative_to(common.ROOT)), "poseSHA256": hashlib.sha256(pose_path.read_bytes()).hexdigest(),
                    "changedVertices": sorted(edited), "maximumPoseDisplacementMeters": maximum,
                    "closedProjectionVolumes": volumes,
                    "method": "Pixel-verified fold only; native posed inside Shrinkwrap and inverse-skin bind bake; temporary target cap is not exported"}


def cuff_lining(body, boot, pants_loops, output):
    attrs, names = body["attrs"], body["jointNames"]
    side = names[int(attrs["JOINTS_0"][boot["start"]][0])][-1]

    def belongs(loop):
        return sum(common.influence(attrs, i, names, lambda n: n == "LowerLeg" + side) for i in loop) / len(loop) > 0.8

    cuffs = [loop for loop in pants_loops if belongs(loop)]
    rims = [loop for loop in boundaries(body, boot) if len(loop) >= 12 and belongs(loop)]
    if not cuffs or not rims:
        return False
    inner = min(cuffs, key=lambda loop: sum(attrs["POSITION"][i][1] for i in loop) / len(loop))
    outer = max(rims, key=lambda loop: sum(attrs["POSITION"][i][1] for i in loop) / len(loop))
    # Native unequal-loop bridging preserves every source endpoint. This lining
    # closes the otherwise empty annulus revealed when trousers bend at knees.
    selected = outer + inner
    bm = bmesh.new()
    verts = [bm.verts.new(attrs["POSITION"][i]) for i in selected]
    edges = []
    for start, length in [(0, len(outer)), (len(outer), len(inner))]:
        edges.extend(bm.edges.new((verts[start + i], verts[start + (i + 1) % length])) for i in range(length))
    bmesh.ops.bridge_loops(bm, edges=edges, use_pairs=True)
    bmesh.ops.triangulate(bm, faces=list(bm.faces))
    bm.verts.index_update()
    if len(bm.verts) != len(selected) or not bm.faces:
        raise ValueError("Native cuff bridge changed its endpoint topology")
    faces = [[v.index for v in face.verts] for face in bm.faces]
    bm.free()
    uvs = [attrs["TEXCOORD_0"][i][:] for i in outer]
    vspan = max(uv[1] for uv in uvs) - min(uv[1] for uv in uvs)
    # The leather swatch is uniform around the ring; use its original U seam
    # and continue a shallow V fold inside the same authored palette rectangle.
    all_uv = attrs["TEXCOORD_0"][boot["start"]:boot["start"] + boot["count"]]
    low_v = min(uv[1] for uv in all_uv)
    depth = max(vspan, (max(uv[1] for uv in all_uv) - low_v) * 0.1)
    for i in inner:
        nearest = min(outer, key=lambda j: (Vector(attrs["POSITION"][i]) - Vector(attrs["POSITION"][j])).length_squared)
        uv = attrs["TEXCOORD_0"][nearest]
        uvs.append([uv[0], max(low_v, uv[1] - depth)])
    obj = common.author_mesh("Inner riding-boot cuff " + side, [attrs["POSITION"][i] for i in selected], faces, uvs,
                             [attrs["JOINTS_0"][i] for i in selected], [attrs["WEIGHTS_0"][i] for i in selected])
    # Upward-facing boot lining must remain visible through the mouth.
    if sum(face.normal.z * face.area for face in obj.data.polygons) < 0:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
        bm.to_mesh(obj.data)
        bm.free()
    common.extract(obj, output, {"name": "BootCuffLining" + side, "slot": "boots", "swatch": boot["swatch"], "sourceStyleIndex": outer[0]})
    return True


def fit_trouser_cuffs(source, body, output):
    """Tuck oversized native hems inside the actual shaft, never alter the thigh."""
    attrs, names, indices = body["attrs"], body["jointNames"], body["indices"]
    node = source.doc["nodes"][body["sourcePrimitive"]["nodeIndex"]]
    skin = source.doc["skins"][node["skin"]]
    inverse = [Matrix([[row[c * 4 + r] for c in range(4)] for r in range(4)]) for row in source.accessor(skin["inverseBindMatrices"])]
    removed, changed, maximum = [], [], 0
    pose_receipt = {}
    for pants in [r for r in body["ranges"] if r.get("slot") == "pants"]:
        start, end = pants["start"], pants["start"] + pants["count"]
        original = {i: attrs["POSITION"][i][:] for i in range(start, end)}
        original_normals = {i: attrs["NORMAL"][i][:] for i in range(start, end)}
        source_faces = [(k // 3, indices[k:k + 3]) for k in range(0, len(indices), 3) if all(start <= i < end for i in indices[k:k + 3])]
        obj = common.author_mesh("Fitted trouser cuffs", [attrs["POSITION"][i] for i in range(start, end)],
                                 [[i - start for i in face] for _, face in source_faces], [attrs["TEXCOORD_0"][i] for i in range(start, end)],
                                 [attrs["JOINTS_0"][i] for i in range(start, end)], [attrs["WEIGHTS_0"][i] for i in range(start, end)])
        factors = {}
        for side in ("L", "R"):
            lower = names.index("LowerLeg" + side)
            foot = names.index("Foot" + side)
            boot = next((r for r in body["ranges"] if r.get("name") == "RidingBoot" and int(attrs["JOINTS_0"][r["start"]][0]) == foot), None)
            if not boot:
                continue
            loops = [loop for loop in boundaries(body, boot) if len(loop) >= 12 and sum(common.influence(attrs, i, names, lambda n: n == "LowerLeg" + side) for i in loop) / len(loop) > 0.8]
            rim = max(loops, key=lambda loop: sum(attrs["POSITION"][i][1] for i in loop) / len(loop))
            ring = [inverse[lower] @ Vector((*attrs["POSITION"][i], 1)) for i in rim]
            center = sum((Vector((p.x, p.z)) for p in ring), Vector((0, 0))) / len(ring)
            group_name = "temporary.tuck." + side
            group = obj.vertex_groups.new(name=group_name)
            for i in range(start, end):
                if common.influence(attrs, i, names, lambda n: n in ("UpperLeg" + side, "LowerLeg" + side)) < 0.85:
                    continue
                point = inverse[lower] @ Vector((*original[i], 1))
                direction = Vector((point.x, point.z)) - center
                nearest = max(ring, key=lambda p: (Vector((p.x, p.z)) - center).normalized().dot(direction.normalized()))
                blend = min(1, max(0, (point.y - nearest.y + 0.03) / 0.05))
                blend = blend * blend * (3 - 2 * blend)
                if blend < 1e-6:
                    continue
                factors[i] = (lower, blend)
                # Leave a small fraction of native fold thickness: projecting
                # both sides of a cloth fold identically can collapse triangles.
                group.add([i - start], blend * 0.96, "REPLACE")
            bs, be = boot["start"], boot["start"] + boot["count"]
            target_faces = [[v - bs for v in indices[k:k + 3]] for k in range(0, len(indices), 3) if all(bs <= v < be for v in indices[k:k + 3])]
            target = common.author_mesh("Canonical boot shaft target", [attrs["POSITION"][i] for i in range(bs, be)], target_faces,
                                        [attrs["TEXCOORD_0"][i] for i in range(bs, be)], [attrs["JOINTS_0"][i] for i in range(bs, be)], [attrs["WEIGHTS_0"][i] for i in range(bs, be)])
            bpy.context.view_layer.objects.active = obj
            shrink = obj.modifiers.new("Tucked inside native boot " + side, "SHRINKWRAP")
            shrink.target, shrink.vertex_group = target, group.name
            shrink.wrap_method, shrink.wrap_mode, shrink.offset = "NEAREST_SURFACEPOINT", "INSIDE", 0.010
            bpy.ops.object.modifier_apply(modifier=shrink.name)
            obj.vertex_groups.remove(obj.vertex_groups[group_name])
            target_mesh = target.data
            bpy.data.objects.remove(target, do_unlink=True)
            bpy.data.meshes.remove(target_mesh)
        if not factors:
            continue
        joint_groups = {int(group.name.split(".")[1]): group for group in obj.vertex_groups if group.name.startswith("joint.")}
        for i, (lower, blend) in factors.items():
            influence = {}
            for j, w in zip(attrs["JOINTS_0"][i], attrs["WEIGHTS_0"][i]):
                influence[int(j)] = influence.get(int(j), 0) + w * (1 - blend)
            influence[lower] = influence.get(lower, 0) + blend
            for group in joint_groups.values():
                group.remove([i - start])
            for joint, weight in influence.items():
                if weight > 1e-8:
                    joint_groups[joint].add([i - start], weight, "REPLACE")
            values = sorted([(j, w) for j, w in influence.items() if w > 1e-8], key=lambda row: -row[1])[:4]
            total = sum(w for _, w in values)
            attrs["JOINTS_0"][i] = [values[k][0] if k < len(values) else 0 for k in range(4)]
            attrs["WEIGHTS_0"][i] = [values[k][1] / total if k < len(values) else 0 for k in range(4)]
            co = obj.data.vertices[i - start].co
            attrs["POSITION"][i] = [co.x, co.z, -co.y]
            maximum = max(maximum, (Vector(attrs["POSITION"][i]) - Vector(original[i])).length)
        pose_edited, pose_receipt = fit_posed_knee(source, body, pants, obj, inverse)
        edited = set(factors) | pose_edited
        maximum = max(maximum, max((Vector(attrs["POSITION"][i]) - Vector(original[i])).length for i in edited))
        touched = [k for k, (_, face) in enumerate(source_faces) if any(i in edited for i in face)]
        removed.extend(source_faces[k][0] for k in touched)
        changed.extend(sorted(edited))
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for i, f in enumerate(bm.faces) if i not in set(touched)], context="FACES_ONLY")
        bm.to_mesh(obj.data)
        bm.free()
        first = len(output["POSITION"])
        common.extract(obj, output, {"name": "TuckedTrouserCuffs", "slot": "pants", "swatch": pants["swatch"], "sourceStyleIndex": start})
        # Unmodified boundary vertices keep the source shading at the join.
        if len(output["POSITION"]) - first != len(touched) * 3:
            raise ValueError("Native cuff fit unexpectedly changed triangle topology")
        for face_index, original_face in enumerate(touched):
            for vertex in range(first + face_index * 3, first + face_index * 3 + 3):
                match = next((i for i in source_faces[original_face][1] if
                              sum((output["POSITION"][vertex][k] - attrs["POSITION"][i][k]) ** 2 for k in range(3)) < 1e-14 and
                              sum((output["TEXCOORD_0"][vertex][k] - attrs["TEXCOORD_0"][i][k]) ** 2 for k in range(2)) < 1e-14), None)
                if match is None:
                    raise ValueError("Native cuff fit changed an original triangle's UV correspondence")
                if match not in edited:
                    output["NORMAL"][vertex] = original_normals[match]
    return removed, {"changedVertices": changed, "changedTriangleOrdinals": removed[:], "maximumBindDisplacementMeters": maximum,
                     "changes": [{"vertex": i, "position": attrs["POSITION"][i], "joints": attrs["JOINTS_0"][i], "weights": attrs["WEIGHTS_0"][i]} for i in changed],
                     "poseSpaceFit": pose_receipt,
                     "method": "Blender native inside Shrinkwrap against canonical shaft, smooth lower-leg cuff weights; original UV and above-join data preserved"}


def bridges(source, body):
    a, names, indices = body["attrs"], body["jointNames"], body["indices"]
    if not any(piece.get("name") == "RidingBoot" for piece in body["ranges"]):
        return None
    output = common.output_arrays()
    removed, cuff_repair = fit_trouser_cuffs(source, body, output)
    pants_loops = [loop for piece in body["ranges"] if piece.get("slot") == "pants" for loop in boundaries(body, piece)]
    cuff_count = 0
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
        cuff_count += cuff_lining(body, boot, pants_loops, output)
    if not removed:
        return None
    inputs = [source.path, *(source.path.parent / entry["uri"] for entry in source.doc["buffers"])]
    pose_input = cuff_repair.get("poseSpaceFit", {}).get("posePath")
    if pose_input:
        reference = common.Source(common.SOURCES / "outlaw-2.gltf")
        inputs.extend([reference.path, *(reference.path.parent / entry["uri"] for entry in reference.doc["buffers"]), common.ROOT / pose_input])
    provenance = [{"path": str(path.relative_to(common.ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in dict.fromkeys(inputs)]
    return output, {"replaceRanges": [], "removeTriangles": sorted(removed), "cuffLinings": cuff_count, "pantsCuffRepair": cuff_repair, "sourceInputs": provenance}


if __name__ == "__main__":
    common.run(bridges, os.environ.get("OUT_WEST_GARMENT_OUTPUT", "boot-bridges"))
