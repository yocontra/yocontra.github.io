"""Unfold the small male underside fan with native interior dissolve/triangulation.

First run head-throat-authoring.ts to prepare the explicit family plan.
Blender --background --factory-startup --python-exit-code 1 --python this-file --
  --plan .out-west-qa/head-throat/family/plans.json --output .out-west-qa/head-throat/art
Canonical positions, UVs, weights and all fixed boundary vertices stay exact.
This private candidate must pass native art review before publication.
"""
import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

spec = importlib.util.spec_from_file_location("collar_portable", Path(__file__).with_name("coat-collars-authoring.py"))
portable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portable)
common = portable.common


def geometry_key(point):
    return tuple(round(value, 7) for value in point)


def oriented_cycle(face):
    return min(tuple(face[k:] + face[:k]) for k in range(len(face)))


def native_unowned_faces(bm, source_index, unowned_keys):
    """Preserve the native import baseline, including its existing winding repair."""
    return sorted(oriented_cycle([vertex[source_index] for vertex in face.verts])
                  for face in bm.faces
                  if tuple(sorted(vertex[source_index] for vertex in face.verts)) in unowned_keys)


def merge_owned_region(bm, source_index, source_faces, fan):
    """Join residual ngons strictly inside the reviewed original triangle region."""
    source_lookup = dict(source_faces)
    owned = set(fan["removeTriangles"])
    owned_vertices = {vertex for triangle in owned for vertex in source_lookup[triangle]}
    boundary = set(fan["boundary"])
    original_keys = {tuple(sorted(face)) for _, face in source_faces}
    region = [face for face in bm.faces
              if tuple(sorted(vertex[source_index] for vertex in face.verts)) not in original_keys
              and {vertex[source_index] for vertex in face.verts} <= owned_vertices]
    if len(region) < 2 or any(len(face.verts) < 4 for face in region):
        raise ValueError("Constrained region does not contain only its residual native polygons")
    enclosed = {vertex[source_index] for face in region for vertex in face.verts} - boundary
    incident = {vertex: [triangle for triangle, face in source_faces if vertex in face]
                for vertex in enclosed}
    if not enclosed or any(not triangles or any(triangle not in owned for triangle in triangles)
                           for triangles in incident.values()):
        raise ValueError("Constrained region bridge has an unowned original incident face")
    # Prove the residual region already has exactly the approved outer loop.
    # Only internal edges can disappear; no boundary donor is dissolved.
    edges = {}
    for face in region:
        ids = [vertex[source_index] for vertex in face.verts]
        for index, first in enumerate(ids):
            second = ids[(index + 1) % len(ids)]
            edges.setdefault(tuple(sorted((first, second))), []).append((first, second))
    expected = {(first, fan["boundary"][(index + 1) % len(fan["boundary"])])
                for index, first in enumerate(fan["boundary"])}
    actual = {pairs[0] for pairs in edges.values() if len(pairs) == 1}
    if actual != expected or any(len(pairs) > 2 or len(pairs) == 2 and pairs[0] != pairs[1][::-1]
                                 for pairs in edges.values()):
        raise ValueError("Constrained residual region changed its exact directed boundary")
    before = [[vertex[source_index] for vertex in face.verts] for face in region]
    bmesh.ops.dissolve_faces(bm, faces=region, use_verts=False)
    # Deliberately retain isolated vertices: use_verts=True could dissolve a
    # protected boundary donor. Unreferenced interior vertices are never emitted.
    return {"originalOwnedTriangles": sorted(owned), "beforePolygons": before,
            "enclosedBridgeVertices": sorted(enclosed), "bridgeIncidentTriangles": incident,
            "newPositionEdits": 0, "newOriginalTriangleOwnership": 0}


def native_geometry_snapshot(bm, source_index):
    return {"positions": sorted((vertex[source_index], tuple(vertex.co)) for vertex in bm.verts),
            "faces": sorted(oriented_cycle([vertex[source_index] for vertex in face.verts])
                            for face in bm.faces),
            "edges": sorted(tuple(sorted(vertex[source_index] for vertex in edge.verts))
                            for edge in bm.edges)}


def split_constrained_diagonal(bm, source_index, face, va, vb):
    """Realize a reviewed diagonal without projecting a nonplanar polygon flat."""
    before = native_geometry_snapshot(bm, source_index)
    selected = oriented_cycle([vertex[source_index] for vertex in face.verts])
    result = bmesh.ops.connect_verts(bm, verts=[va, vb], check_degenerate=True)
    if len(result["edges"]) == 1:
        return None
    if result["edges"] or native_geometry_snapshot(bm, source_index) != before:
        raise ValueError("Rejected constrained connect partially changed native geometry")
    # connect_verts can return no edges for this reviewed nonplanar polygon.
    # The exact selected face/endpoints were checked by the caller; face_split
    # inserts that native topological edge without a triangulation search.
    split_face, split_loop = bmesh.utils.face_split(face, va, vb)
    edge = bm.edges.get((va, vb))
    if edge is None or split_loop.edge is not edge or len(edge.link_faces) != 2 or split_face not in edge.link_faces:
        raise ValueError("Native face_split did not create the exact constrained shared edge")
    after = native_geometry_snapshot(bm, source_index)
    if after["positions"] != before["positions"] or len(after["faces"]) != len(before["faces"]) + 1 or len(after["edges"]) != len(before["edges"]) + 1:
        raise ValueError("Native face_split changed a source point or unexpected topology")
    unaffected = before["faces"][:]
    unaffected.remove(selected)
    children = sorted(oriented_cycle([vertex[source_index] for vertex in child.verts])
                      for child in edge.link_faces)
    remaining = after["faces"][:]
    for child in children:
        remaining.remove(child)
    if remaining != unaffected:
        raise ValueError("Native face_split changed an unselected face")
    return {"method": "Native face_split after unchanged zero-edge connect rejection",
            "diagonal": [va[source_index], vb[source_index]], "selectedPolygon": list(selected),
            "resultPolygons": [list(child) for child in children],
            "sourcePositionsExact": True, "newVertices": 0, "unselectedFacesExact": True}


def author(source, body, plan, diagnostic_graph=None):
    attrs = body["attrs"]
    head = body["ranges"][0]
    inventory = json.loads(Path(__file__).with_name("head-throat-family.json").read_text())
    chin = inventory["chinFanOverrides"].get(plan["id"], {"interior": [495, 503, 504, 506], "triangles": 17})
    throat = ([{"interior": [19, 21, 23, 25, 27, 30, 32, 34, 36], "triangles": 38}]
              if plan["recipe"] == "merged" else
              [{"interior": [19, 21, 23, 25], "triangles": 18},
               {"interior": [30, 32, 34, 36], "triangles": 18}])
    expected_interior = [chin["interior"], *(fan["interior"] for fan in throat)]
    expected_removed = chin["triangles"] + sum(fan["triangles"] for fan in throat)
    constrained_path = Path(__file__).with_name("head-throat-recipes.json")
    constrained = next((recipe for recipe in json.loads(constrained_path.read_text())["recipes"]
                        if recipe["id"] == plan["id"]), None)
    if constrained:
        expected_interior = [fan["interior"] for fan in constrained["fans"]]
        expected_removed = sum(len(fan["removeOriginalPrimitiveTriangles"]) for fan in constrained["fans"])
        if plan["sourceInputs"] != constrained["sourcePins"]:
            raise ValueError("Constrained native source pins differ")
        for planned, fixed in zip(plan["fans"], constrained["fans"], strict=True):
            if (planned["boundary"] != fixed["boundary"]
                    or planned["removeTriangles"] != sorted(fixed["removeOriginalPrimitiveTriangles"])
                    or planned.get("constrainedDiagonals") != fixed["constrainedDiagonals"]
                    or planned.get("triangles") != fixed["triangles"]):
                raise ValueError("Constrained native fan differs from the reviewed source recipe")
    expected_new = sum(len(fan["boundary"]) - 2 for fan in plan["fans"])
    if head["start"] != 0 or head["count"] != 1555 or [fan["interior"] for fan in plan["fans"]] != expected_interior:
        raise ValueError("Unsupported anterior jaw source topology")
    interior = [i for fan in plan["fans"] for i in fan["interior"]]
    removed_ids = sorted(t for fan in plan["fans"] for t in fan["removeTriangles"])
    boundary = {i for fan in plan["fans"] for i in fan["boundary"]}
    source_faces = [(t // 3, body["indices"][t:t + 3]) for t in range(0, len(body["indices"]), 3)
                    if all(i < head["count"] for i in body["indices"][t:t + 3])]
    removed = [(t, face) for t, face in source_faces if any(i in interior for i in face)]
    if [t for t, _ in removed] != removed_ids or len(removed) != expected_removed:
        raise ValueError("Anterior jaw source fan changed")
    # The sole anatomical exception is an approved two-donor NPC15 contact-row edit.
    node = source.doc["nodes"][body["sourcePrimitive"]["nodeIndex"]]
    skin = source.doc["skins"][node["skin"]]
    inverse = source.accessor(skin["inverseBindMatrices"])[body["jointNames"].index("Head")]
    head_bind = Matrix([[inverse[column * 4 + row] for column in range(4)] for row in range(4)])
    head_scale = max((head_bind @ Vector(point)).y for point in attrs["POSITION"][:head["count"]]) / 0.1997265059272746
    approved = inventory["positionHeadYEdits"].get(plan["id"], {})
    position_edits = {}
    if plan["id"] != "outlaw-15" and approved:
        raise ValueError("Anterior position edits are owned only by NPC15")
    if {int(index) for index in approved} != {edit["sourceVertex"] for edit in plan["positionEdits"]}:
        raise ValueError("Anterior position edit inventory changed")
    for index, delta in approved.items():
        index = int(index)
        if index not in (83, 84) or delta != {83: -0.0048, 84: -0.0036}[index]:
            raise ValueError("Unapproved NPC15 contact-row target")
        before = Vector(attrs["POSITION"][index])
        if any(other != index and Vector(point) == before
               for other, point in enumerate(attrs["POSITION"][:head["count"]])):
            raise ValueError("NPC15 contact-row edit touches a position seam")
        source_delta = head_bind.inverted().to_3x3() @ Vector((0, delta * head_scale, 0))
        result = before + source_delta
        measured = (head_bind @ result - head_bind @ before) / head_scale
        if abs(measured.x) > 2e-7 or abs(measured.z) > 2e-7 or abs(measured.y - delta) > 2e-7:
            raise ValueError("NPC15 native Head-space delta changed X/Z or the approved Y target")
        edit = next(item for item in plan["positionEdits"] if item["sourceVertex"] == index)
        if (result - Vector(edit["sourceTarget"])).length > 3e-7:
            raise ValueError("Native/portable Head-space conversion differs")
        position_edits[index] = list(result)
    obj = common.author_mesh("Fixed-boundary anterior jaw", attrs["POSITION"][:head["count"]],
                             [face for _, face in source_faces], attrs["TEXCOORD_0"][:head["count"]],
                             attrs["JOINTS_0"][:head["count"]], attrs["WEIGHTS_0"][:head["count"]])
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    source_index = bm.verts.layers.int.new("canonical_source_vertex")
    for vertex in bm.verts:
        vertex[source_index] = vertex.index
    native_unowned_keys = {tuple(sorted(face)) for triangle, face in source_faces
                           if triangle not in removed_ids}
    native_unowned_baseline = (native_unowned_faces(bm, source_index, native_unowned_keys)
                              if constrained else None)
    region_dissolves = []
    constrained_face_splits = []
    bmesh.ops.dissolve_verts(bm, verts=[bm.verts[i] for i in interior],
                            use_face_split=False, use_boundary_tear=False)
    if constrained:
        # Insert reviewed source diagonals with native polygon splitting. Every
        # endpoint is an unchanged canonical boundary donor; no optimizer runs.
        vertices = {vertex[source_index]: vertex for vertex in bm.verts}
        for fan, planned_fan in zip(constrained["fans"], plan["fans"], strict=True):
            faces = [face for face in bm.faces if len(face.verts) > 3
                     and {vertex[source_index] for vertex in face.verts} == set(fan["boundary"])]
            if len(faces) != 1:
                region_dissolves.append(merge_owned_region(bm, source_index, source_faces, planned_fan))
                faces = [face for face in bm.faces if len(face.verts) > 3
                         and {vertex[source_index] for vertex in face.verts} == set(fan["boundary"])]
            if len(faces) != 1 or oriented_cycle([vertex[source_index] for vertex in faces[0].verts]) != oriented_cycle(fan["boundary"]):
                raise ValueError("Constrained dissolve did not produce its exact directed boundary polygon")
            if native_unowned_faces(bm, source_index, native_unowned_keys) != native_unowned_baseline:
                raise ValueError("Constrained dissolve changed an unowned native import face")
            for a, b in fan["constrainedDiagonals"]:
                va, vb = vertices[a], vertices[b]
                polygons = [face for face in bm.faces if va in face.verts and vb in face.verts]
                if len(polygons) != 1 or len(polygons[0].verts) <= 3 or bm.edges.get((va, vb)):
                    raise ValueError("Constrained diagonal is missing, repeated or crosses a native face")
                receipt = split_constrained_diagonal(bm, source_index, polygons[0], va, vb)
                if receipt is not None:
                    constrained_face_splits.append(receipt)
        def oriented(face):
            return oriented_cycle(face)
        expected_faces = {oriented(face) for fan in constrained["fans"] for face in fan["triangles"]}
        original_keys = {tuple(sorted(face)) for _, face in source_faces}
        actual_faces = [face for face in bm.faces
                        if tuple(sorted(vertex[source_index] for vertex in face.verts)) not in original_keys]
        if any(len(face.verts) != 3 for face in actual_faces) or {
                oriented([vertex[source_index] for vertex in face.verts]) for face in actual_faces
        } != expected_faces:
            raise ValueError("Native constrained fill changed a reviewed oriented triangle")
        if native_unowned_faces(bm, source_index, native_unowned_keys) != native_unowned_baseline:
            raise ValueError("Constrained split changed an unowned native import face")
    uv_fans = []
    if not constrained:
        if chin.get("triangulation") == "UV_BEAUTY":
            uv_fans.append(0)
        if plan["id"] in inventory["throatUVTriangulationIDs"]:
            uv_fans.extend(range(1, len(plan["fans"])))
    if uv_fans:
        boundaries = [set(plan["fans"][index]["boundary"]) for index in uv_fans]
        uv_faces = [face for face in bm.faces if len(face.verts) > 3
                    and {vertex[source_index] for vertex in face.verts} in boundaries]
        if len(uv_faces) != len(boundaries):
            raise ValueError("Distinct source requires each exact native fixed-boundary UV polygon")
        # Native UV-space triangulation avoids projected UV folds on these three
        # unusually indented chins. Restore every 3D point before geometry checks.
        coordinates = {vertex: vertex.co.copy() for vertex in bm.verts}
        for vertex in bm.verts:
            u, v = attrs["TEXCOORD_0"][vertex[source_index]]
            vertex.co = (u, v, 0)
        bm.normal_update()
        bmesh.ops.triangulate(bm, faces=uv_faces, quad_method="BEAUTY", ngon_method="BEAUTY")
        for vertex, point in coordinates.items():
            vertex.co = point
        bm.normal_update()
    bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method="BEAUTY", ngon_method="BEAUTY")
    # Rotate the approved donor diagonal only if native triangulation actually
    # creates its measured UV sliver. Healthy UVs must never receive a blind flip.
    def signed_uv_area(face):
        a, b, c = [attrs["TEXCOORD_0"][vertex[source_index]] for vertex in face.verts]
        return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2

    original_keys = {tuple(sorted(face)) for _, face in source_faces}
    invalid = [face for face in bm.faces
               if tuple(sorted(vertex[source_index] for vertex in face.verts)) not in original_keys
               and signed_uv_area(face) >= -1e-12]
    uv_rotation = None
    if invalid:
        old_pair = {frozenset((507, 505, 496)), frozenset((496, 494, 507))}
        edges = [edge for edge in bm.edges
                 if {vertex[source_index] for vertex in edge.verts} == {496, 507}]
        if len(invalid) != 1 or len(edges) != 1:
            raise ValueError(json.dumps({"id": plan["id"], "failure": "Unsupported native anterior UV fold; no automatic diagonal repair", "faces": [{"ids": [v[source_index] for v in face.verts], "signedArea": signed_uv_area(face)} for face in invalid]}))
        edge = edges[0]
        actual_pair = {frozenset(vertex[source_index] for vertex in face.verts) for face in edge.link_faces}
        if actual_pair != old_pair or invalid[0] not in edge.link_faces:
            raise ValueError("Anterior UV repair does not match the measured donor triangles")
        rotated = bmesh.ops.rotate_edges(bm, edges=[edge], use_ccw=False)
        if len(rotated["edges"]) != 1:
            raise ValueError("Native anterior UV diagonal rotation failed")
        new_pair = {frozenset(vertex[source_index] for vertex in face.verts)
                    for face in rotated["edges"][0].link_faces}
        if new_pair != {frozenset((505, 496, 494)), frozenset((505, 494, 507))}:
            raise ValueError("Native UV rotation crossed the fixed donor quad")
        uv_rotation = {"removedEdge": [496, 507], "replacementEdge": [494, 505],
                       "trigger": "one measured native positive-area UV sliver"}
    for vertex in bm.verts:
        target = position_edits.get(vertex[source_index])
        if target is not None:
            vertex.co = (target[0], -target[2], target[1])
    bm.normal_update()
    native_faces = [[vertex[source_index] for vertex in face.verts] for face in bm.faces]
    original_keys = {tuple(sorted(face)) for _, face in source_faces}
    new_faces = [face for face in native_faces if tuple(sorted(face)) not in original_keys]
    if len(new_faces) != expected_new or any(not set(face) <= boundary for face in new_faces):
        raise ValueError("Native dissolve must replace only the planned fan faces with their fixed-boundary triangulation")
    for fan in plan["fans"]:
        if sum(set(face) <= set(fan["boundary"]) for face in new_faces) != len(fan["boundary"]) - 2:
            raise ValueError("Native fill crossed a fixed fan boundary")
    for face in bm.faces:
        if face.calc_area() <= 1e-12:
            raise ValueError("Native anterior jaw contains a degenerate geometric triangle")
    front_vertices = set(plan["frontVertices"])
    front_edges = [(abs(edge.calc_face_angle()) * 180 / 3.141592653589793, edge)
                   for edge in bm.edges if len(edge.link_faces) == 2
                   and all(vertex[source_index] in front_vertices
                           for face in edge.link_faces for vertex in face.verts)]
    max_front_dihedral = max((angle for angle, _ in front_edges), default=0)
    # Check every new fan edge against its fixed neighbour, including physical
    # UV-seam copies that BMesh deliberately stores as separate vertices.
    native_face_objects = list(bm.faces)
    new_keys = {tuple(sorted(face)) for face in new_faces}
    changed_faces = {i for i, face in enumerate(native_faces)
                     if tuple(sorted(face)) in new_keys or any(v in position_edits for v in face)}
    edge_faces = {}
    for i, face in enumerate(native_faces):
        for corner in range(3):
            edge = tuple(sorted(geometry_key(attrs["POSITION"][face[k]])
                                for k in (corner, (corner + 1) % 3)))
            edge_faces.setdefault(edge, []).append(i)
    complete_constraints = []
    for edge, adjacent in edge_faces.items():
        if not any(i in changed_faces for i in adjacent):
            continue
        if len(adjacent) > 2:
            raise ValueError("Anterior native physical seam edge became nonmanifold")
        if len(adjacent) != 2:
            continue
        left, right = (native_face_objects[i] for i in adjacent)
        angle = left.normal.angle(right.normal) * 180 / 3.141592653589793
        complete_constraints.append({"angle": angle, "faces": [native_faces[i] for i in adjacent]})
    complete_max = max((item["angle"] for item in complete_constraints), default=0)
    max_front_dihedral = max(max_front_dihedral, complete_max)
    if diagnostic_graph is not None:
        # Preserve the complete actual BMesh before a guard exits Blender. This
        # receipt is never a portable authoring asset or a guard bypass.
        graph = {"id": plan["id"], "diagnosticOnly": True,
                 "nativeFaces": native_faces, "newFanFaces": new_faces,
                 "originalFanRemovedTriangles": removed_ids,
                 "vertices": [{"sourceIndex": vertex[source_index],
                               "sourcePosition": attrs["POSITION"][vertex[source_index]],
                               "nativeSourcePosition": [vertex.co.x, vertex.co.z, -vertex.co.y],
                               "uv": attrs["TEXCOORD_0"][vertex[source_index]]} for vertex in bm.verts],
                 "headInverseBind": inverse, "headScale": head_scale,
                 "positionEdits": plan["positionEdits"], "maxFrontDihedral": max_front_dihedral,
                 "completePhysicalConstraints": complete_constraints,
                 "sourceInputs": plan["sourceInputs"],
                 "producerSHA256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
        diagnostic_graph.parent.mkdir(parents=True, exist_ok=True)
        diagnostic_graph.write_text(json.dumps(graph, separators=(",", ":")) + "\n")
    if max_front_dihedral > 120:
        evidence = [{"angle": angle, "edge": [v[source_index] for v in edge.verts],
                     "faces": [[v[source_index] for v in face.verts] for face in edge.link_faces],
                     "points": [attrs["POSITION"][v[source_index]] for face in edge.link_faces for v in face.verts]}
                    for angle, edge in sorted(front_edges, key=lambda pair: pair[0], reverse=True)[:5]]
        raise ValueError(json.dumps({"id": plan["id"], "failure": "Native source-specific anterior fold remains",
                                     "uvRotation": uv_rotation, "edges": evidence,
                                     "completePhysicalWorst": sorted(complete_constraints, key=lambda item: item["angle"], reverse=True)[:5]}))
    for face in new_faces:
        a, b, c = [attrs["TEXCOORD_0"][i] for i in face]
        signed_uv_area = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2
        if signed_uv_area >= -1e-12:
            raise ValueError("Anterior jaw fill introduced a folded or zero-area UV triangle")
    # Every surviving vertex must retain its exact canonical point. Native dissolve
    # removes only the planned twelve/thirteen misplaced interior vertices; it does not move the boundary.
    for vertex in bm.verts:
        p = position_edits.get(vertex[source_index], attrs["POSITION"][vertex[source_index]])
        if (vertex.co - Vector((p[0], -p[2], p[1]))).length > 1e-7:
            raise ValueError("Native anterior jaw author moved a protected vertex")
    normals = {}
    for face in bm.faces:
        for vertex in face.verts:
            key = geometry_key(attrs["POSITION"][vertex[source_index]])
            normals[key] = normals.get(key, Vector()) + face.normal * face.calc_area()
    sculpt_ring = {i for _, face in source_faces if any(vertex in position_edits for vertex in face) for i in face}
    boundary_keys = {geometry_key(attrs["POSITION"][i]) for i in boundary | sculpt_ring}
    normal_vertices = {i for i in range(head["count"]) if geometry_key(attrs["POSITION"][i]) in boundary_keys}
    normal_faces = [(t, face) for t, face in source_faces
                    if t not in removed_ids and any(i in normal_vertices for i in face)]
    emitted_faces = new_faces + [face for _, face in normal_faces]
    corners = [i for face in emitted_faces for i in face]
    output = common.output_arrays()
    output["indices"] = list(range(len(corners)))
    output["pieces"] = [{"name": "AnteriorJaw", "slot": head["slot"], "swatch": head["swatch"],
                         "start": 0, "count": len(corners), "sourceStyleIndex": head["start"]}]
    output["POSITION"] = [position_edits.get(i, attrs["POSITION"][i])[:] for i in corners]
    output["TEXCOORD_0"] = [attrs["TEXCOORD_0"][i][:] for i in corners]
    for index in position_edits:
        if corners.count(index) != sum(index in face for face in native_faces):
            raise ValueError("NPC15 edit omitted an incident native corner")
    output["NORMAL"] = []
    for i in corners:
        if i in normal_vertices:
            normal = normals[geometry_key(attrs["POSITION"][i])].normalized()
            output["NORMAL"].append([normal.x, normal.z, -normal.y])
        else:
            output["NORMAL"].append(attrs["NORMAL"][i][:])
    # Copy donor influences/styles verbatim; do not normalize or transfer weights.
    for semantic in ("JOINTS_0", "WEIGHTS_0", "COLOR_0", "_DYE", "_STYLE_LUMINANCE", "_STYLE_MATERIAL"):
        if semantic in attrs:
            target = {"JOINTS_0": "_AUTHOR_JOINTS", "WEIGHTS_0": "_AUTHOR_WEIGHTS"}.get(semantic, "_AUTHOR_" + semantic.lstrip("_"))
            output[target] = [attrs[semantic][i][:] for i in corners]
    bm.free()
    bpy.data.objects.remove(obj, do_unlink=True)
    inputs = [source.path, *(source.path.parent / b["uri"] for b in source.doc["buffers"]),
              Path(__file__), Path(__file__).with_name("head-throat-plan.ts"),
              Path(__file__).with_name("head-throat-family.json"), constrained_path,
              Path(__file__).with_suffix(".ts"), Path(portable.__file__), Path(common.__file__)]
    metadata = {"replaceRanges": [], "removeTriangles": sorted(removed_ids + [t for t, _ in normal_faces]),
                "sourceInputs": [{"path": str(p.relative_to(common.ROOT)), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                                 for p in inputs],
                "anteriorJaw": {"method": "Native interior dissolve, shape guards and conditional measured UV diagonal with fixed boundary",
                                "recipe": plan["recipe"], "beforeShape": plan["shape"],
                                "nativeOwnedRegionDissolves": region_dissolves,
                                "nativeConstrainedFaceSplits": constrained_face_splits,
                                "unownedPostImportFacesExact": True if constrained else None,
                                "maxFrontDihedral": max_front_dihedral, "uvRotation": uv_rotation,
                                "completePhysicalEdgePairs": len(complete_constraints),
                                "completePhysicalMaxDihedral": complete_max,
                                "positionEdits": [{"sourceVertex": index, "sourcePosition": attrs["POSITION"][index],
                                                   "sourceTarget": point, "normalizedHeadDelta": [0, approved[str(index)], 0]}
                                                  for index, point in position_edits.items()],
                                "sculptNormalRingSourceVertices": sorted(sculpt_ring),
                                "fans": plan["fans"], "removedInteriorVertices": interior, "fixedBoundaryVertices": sorted(boundary),
                                "removedFanTriangles": removed_ids, "replacementFanTriangles": new_faces,
                                "normalOnlySourceVertices": sorted(normal_vertices), "sourceCorners": corners,
                                "survivingPositionsExactExceptApprovedTwoNPC15Donors": True,
                                "uvWeightsStylesExact": True}}
    return output, metadata


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--diagnostic-graph", type=Path, help="Lossless BMesh receipt only; never emits an art GLB")
    parser.add_argument("--ids", help="Explicit subset for a bounded failed-shape recovery; default authors all30")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    prepared = json.loads(args.plan.read_text())
    inventory_path = Path(__file__).with_name("head-throat-family.json")
    inventory = json.loads(inventory_path.read_text())
    expected = [identifier for identifier in inventory["bodyIDs"]
                if identifier not in inventory["geometryControls"]]
    plans = prepared["plans"]
    if (len(expected) != 30 or [p["id"] for p in plans] != expected
            or prepared["family"] != inventory
            or prepared["inventorySHA256"] != hashlib.sha256(inventory_path.read_bytes()).hexdigest()):
        raise ValueError("Anterior jaw author requires the exact current 30-source family inventory")
    selected = args.ids.split(",") if args.ids else expected
    if not selected or len(set(selected)) != len(selected) or any(identifier not in expected for identifier in selected):
        raise ValueError("Unknown or repeated native family subset")
    if args.diagnostic_graph is not None and len(selected) != 1:
        raise ValueError("Diagnostic graph requires one explicit shape")
    for plan in plans:
        if plan["id"] not in selected:
            continue
        recipe = "split" if plan["id"] in inventory["splitFanIDs"] else "merged"
        if plan["recipe"] != recipe:
            raise ValueError("Anterior jaw recipe differs from the shape-qualified family inventory")
        for pin in plan["sourceInputs"]:
            if hashlib.sha256((common.ROOT / pin["path"]).read_bytes()).hexdigest() != pin["sha256"]:
                raise ValueError("Canonical source changed after preparing its anterior jaw plan")
        source = common.Source(common.SOURCES / (plan["id"] + ".gltf"))
        body = next(source.bodies())
        arrays, metadata = author(source, body, plan, args.diagnostic_graph)
        if args.diagnostic_graph is not None:
            continue
        metadata.update({"jointNames": body["jointNames"], "sourceId": plan["id"],
                         "sourceSHA256": source.digest(), "sourcePrimitive": body["sourcePrimitive"]})
        common.write_glb(args.output / (plan["id"] + ".glb"), arrays, metadata)
        print(json.dumps({"id": plan["id"], "patchTriangles": len(arrays["indices"]) // 3,
                          "fanTriangles": len(metadata["anteriorJaw"]["replacementFanTriangles"])}))
