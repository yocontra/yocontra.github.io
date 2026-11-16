"""Original stage-only near saguaro; retained GLB supplies envelope/pivot (no recovered source claim).

Blender builtins author ridge-aligned areoles/spines and bake their real geometry. Reference only:
https://www.nps.gov/articles/saguaro-cactus-facts.htm
https://www.desertmuseum.org/books/nhsd_cactus_.php/nhsd_cactus2.php
No external photograph, mesh, texture or paid provider is used. Run only in the granted CPU lane.
"""
import argparse
import hashlib
import json
import math
import random
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

parser = argparse.ArgumentParser()
parser.add_argument('--stage', required=True)
parser.add_argument('--diagnostic-first-bake', action='store_true')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
stage = Path(args.stage).resolve()
project = Path(__file__).resolve().parents[2]
if stage == project or project in stage.parents:
    raise ValueError('Cactus output must be outside this checkout')
job_path = stage / 'authoring-job.json'
job = json.loads(job_path.read_text())
sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
for record in job['inputs'] + job['scripts']:
    if sha(record['path']) != record['sha256']:
        raise ValueError('Changed cactus input/script: ' + record['path'])
if job['budget'] != 20000:
    raise ValueError('Unexpected near triangle budget')
stage.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 32
scene.render.threads_mode = 'FIXED'
scene.render.threads = 2
scene.view_settings.view_transform = 'Standard'
rng = random.Random(20261115)
tile = .36
size = 512


def material(name, color, roughness):
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    bsdf = result.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = 0
    return result


if job.get('reusedMaps'):
    import shutil
    for record in job['reusedMaps']:
        shutil.copyfile(record['path'], stage / Path(record['path']).name)
else:
    skin = material('Original waxy cactus skin', (.78, .80, .74), .61)
    pad = material('Original pale woolly areole', (.59, .54, .40), .73)
    spine = material('Original dry radial spine', (.71, .64, .47), .76)
    # Waxy skin and dry pads/spines have distinct roughness, baked from their separate geometry.
    # Do not impose an unrelated grayscale stripe/noise gradient or flatten all tissues to matte.

    # A periodic four-rib tile. High source geometry receives shadows only through AO baking.
    grid = 128
    vertices = []
    for y in range(grid + 1):
        for x in range(grid + 1):
            u, v = x / grid, y / grid
            crest = (.5 + .5 * math.cos((u - .125) * math.pi * 8)) ** 3
            ripple = .00018 * math.sin(u * math.pi * 64) * math.sin(v * math.pi * 52)
            vertices.append((u * tile, v * tile, .009 * crest + ripple))
    faces = []
    for y in range(grid):
        for x in range(grid):
            a = y * (grid + 1) + x
            faces.append((a, a + 1, a + grid + 2, a + grid + 1))
    mesh = bpy.data.meshes.new('High rib skin')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    high = bpy.data.objects.new('High rib skin', mesh)
    scene.collection.objects.link(high)
    mesh.materials.append(skin)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    high_objects = [high]


    def cone_between(start, end, radius, name):
        delta = end - start
        bpy.ops.mesh.primitive_cone_add(vertices=5, radius1=radius, radius2=.00003,
                                        depth=delta.length, location=(start + end) / 2)
        obj = bpy.context.object
        obj.name = name
        obj.rotation_euler = delta.to_track_quat('Z', 'Y').to_euler()
        obj.data.materials.append(spine)
        high_objects.append(obj)


    for rib in range(4):
        for row in range(14):
            # Cluster centres follow rib crests; spacing/radial rays vary independently and repeat.
            x = (rib + .5) * tile / 4
            y = (row + .5) * tile / 14 + rng.uniform(-.0012, .0012)
            rays = [(ray * math.tau / 9 + rng.uniform(-.2, .2), rng.uniform(.006, .014),
                     rng.uniform(.45, .95)) for ray in range(9)]
            for wrap in (-tile, 0, tile):
                centre = Vector((x, y + wrap, .010))
                bpy.ops.mesh.primitive_uv_sphere_add(segments=10, ring_count=6, location=centre)
                obj = bpy.context.object
                obj.name = 'High raised oval areole'
                obj.scale = (.0018, .0024, .0011)
                obj.data.materials.append(pad)
                high_objects.append(obj)
                for angle, length, elevation in rays:
                    direction = Vector((math.cos(angle), math.sin(angle), elevation)).normalized()
                    cone_between(centre, centre + direction * length, .00023, 'High radial spine')

    # Flat bake receiver has exactly the existing periodic tile contract, not an atlas repack.
    bpy.ops.mesh.primitive_plane_add(size=tile, location=(tile / 2, tile / 2, 0))
    receiver = bpy.context.object
    receiver.name = 'Tangent-space bake receiver'
    receiver.data.materials.append(material('Bake target', (1, 1, 1), 1))
    target_material = receiver.data.materials[0]
    image_node = target_material.node_tree.nodes.new('ShaderNodeTexImage')
    target_material.node_tree.nodes.active = image_node
    scene.render.bake.use_selected_to_active = True
    scene.render.bake.use_cage = False
    scene.render.bake.cage_extrusion = .055
    scene.render.bake.max_ray_distance = .10
    scene.render.bake.margin = 8
    scene.render.bake.use_pass_direct = False
    scene.render.bake.use_pass_indirect = False
    scene.render.bake.use_pass_color = True
    scene.render.bake.normal_space = 'TANGENT'
    maps = {}
    diagnostic_saved = False


    def triangle_stats(coordinates, triangles):
        """World-space square metres; tiny is diagnostic, not an automatic art-cleanup threshold."""
        result = {'triangles': len(triangles), 'invalidIndices': 0, 'nonfiniteTriangles': 0,
                  'zeroAreaTriangles': 0, 'tinyTriangles': 0, 'tinyAreaThresholdM2': 1e-12,
                  'minimumPositiveAreaM2': None}
        for indices in triangles:
            if len(indices) != 3 or any(i < 0 or i >= len(coordinates) for i in indices):
                result['invalidIndices'] += 1
                continue
            a, b, c = [coordinates[i] for i in indices]
            ab = [b[i] - a[i] for i in range(3)]
            ac = [c[i] - a[i] for i in range(3)]
            area = math.hypot(ab[1] * ac[2] - ab[2] * ac[1],
                              ab[2] * ac[0] - ab[0] * ac[2],
                              ab[0] * ac[1] - ab[1] * ac[0]) / 2
            if not math.isfinite(area):
                result['nonfiniteTriangles'] += 1
            elif area == 0:
                result['zeroAreaTriangles'] += 1
            else:
                if area <= result['tinyAreaThresholdM2']:
                    result['tinyTriangles'] += 1
                previous = result['minimumPositiveAreaM2']
                result['minimumPositiveAreaM2'] = area if previous is None else min(area, previous)
        return result


    def geometry_fingerprint(mesh):
        payload = {'vertices': [list(v.co) for v in mesh.vertices],
                   'edges': [list(edge.vertices) for edge in mesh.edges],
                   'faces': [list(face.vertices) for face in mesh.polygons],
                   'loops': [loop.vertex_index for loop in mesh.loops]}
        return hashlib.sha256(json.dumps(payload, allow_nan=True).encode()).hexdigest()


    def mesh_report(mesh, matrix):
        coordinates = [list(vertex.co) for vertex in mesh.vertices]
        world_coordinates = [list(matrix @ vertex.co) for vertex in mesh.vertices]
        count = len(coordinates)
        invalid_edges = sum(any(i < 0 or i >= count for i in edge.vertices) for edge in mesh.edges)
        invalid_loops = sum(loop.vertex_index < 0 or loop.vertex_index >= count for loop in mesh.loops)
        invalid_faces = sum(len(face.vertices) < 3 or len(set(face.vertices)) != len(face.vertices)
                            or any(i < 0 or i >= count for i in face.vertices)
                            or face.loop_start < 0 or face.loop_start + face.loop_total > len(mesh.loops)
                            for face in mesh.polygons)
        # These are cache updates, not topology cleaning. Never call validate on the authored mesh.
        triangles = []
        if not (invalid_faces or invalid_loops):
            mesh.calc_loop_triangles()
            triangles = [list(face.vertices) for face in mesh.loop_triangles]
        before = geometry_fingerprint(mesh)
        disposable = mesh.copy()
        try:
            validation_changed = disposable.validate(verbose=True, clean_customdata=False)
            cleaned_counts = {'vertices': len(disposable.vertices), 'edges': len(disposable.edges),
                              'faces': len(disposable.polygons), 'loops': len(disposable.loops)}
        finally:
            bpy.data.meshes.remove(disposable)
        if geometry_fingerprint(mesh) != before:
            raise ValueError('Disposable-copy validation changed authored geometry')
        return {'mesh': mesh.name_full, 'pointer': mesh.as_pointer(), 'vertices': count,
                'edges': len(mesh.edges), 'faces': len(mesh.polygons), 'loops': len(mesh.loops),
                'nonfiniteLocalCoordinates': sum(not math.isfinite(v) for p in coordinates for v in p),
                'nonfiniteWorldCoordinates': sum(not math.isfinite(v) for p in world_coordinates for v in p),
                'invalidEdges': invalid_edges, 'invalidLoops': invalid_loops, 'invalidFaces': invalid_faces,
                'triangleStats': triangle_stats(world_coordinates, triangles),
                'geometrySHA256': before, 'copyValidationChanged': validation_changed,
                'copyValidatedCounts': cleaned_counts, 'originalUnchanged': True}


    def save_prebake_diagnostic(role, kind, label):
        # Ensure newly-created geometry/transforms are evaluated before snapshotting the actual bake.
        bpy.context.view_layer.update()
        graph = bpy.context.evaluated_depsgraph_get()
        graph.update()
        selected = list(bpy.context.selected_objects)
        active = bpy.context.view_layer.objects.active
        snapshot = stage / ('high-' + label + '-prebake.blend')
        bpy.ops.wm.save_as_mainfile(filepath=str(snapshot))
        report = {'role': role, 'bakeType': kind, 'blender': bpy.app.version_string,
            'jobSHA256': sha(job_path), 'sourceSHA256': sha(__file__), 'snapshotSHA256': sha(snapshot),
            'contextMode': bpy.context.mode, 'scene': scene.name, 'viewLayer': bpy.context.view_layer.name,
            'depsgraphMode': graph.mode, 'depsgraphPointer': graph.as_pointer(),
            'renderEngine': scene.render.engine, 'device': scene.cycles.device,
            'threads': scene.render.threads, 'seed': scene.cycles.seed,
            'animatedSeed': scene.cycles.use_animated_seed,
            'active': active.name_full if active else None,
            'selected': [obj.name_full for obj in selected], 'rows': []}
        (stage / ('topology-' + label + '-context.json')).write_text(json.dumps(report, indent=2) + '\n')
        malformed = []
        with (stage / ('topology-' + label + '-meshes.jsonl')).open('w') as journal:
            for obj in selected:
                row = {'object': obj.name_full, 'pointer': obj.as_pointer(), 'type': obj.type,
                       'selected': obj.select_get(), 'mode': obj.mode,
                       'hideRender': obj.hide_render, 'hideViewport': obj.hide_viewport,
                       'nonfiniteMatrixValues': sum(not math.isfinite(v) for line in obj.matrix_world for v in line),
                       'matrixWorld': [[v if math.isfinite(v) else repr(v) for v in line]
                                       for line in obj.matrix_world]}
                if obj.type == 'MESH':
                    row['raw'] = mesh_report(obj.data, obj.matrix_world)
                    evaluated = obj.evaluated_get(graph)
                    mesh = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=graph)
                    try:
                        row['evaluated'] = mesh_report(mesh, evaluated.matrix_world)
                    finally:
                        evaluated.to_mesh_clear()
                    for state in ('raw', 'evaluated'):
                        data = row[state]
                        if (data['copyValidationChanged'] or data['invalidEdges'] or data['invalidLoops']
                            or data['invalidFaces'] or data['nonfiniteLocalCoordinates']
                            or data['nonfiniteWorldCoordinates'] or data['triangleStats']['invalidIndices']
                            or data['triangleStats']['nonfiniteTriangles']
                            or data['triangleStats']['zeroAreaTriangles']):
                            malformed.append({'object': obj.name_full, 'state': state})
                journal.write(json.dumps(row) + '\n')
                journal.flush()
                report['rows'].append(row)
        report['malformed'] = malformed
        report['selectionMatchesRecipe'] = (active == receiver and set(selected) == set(high_objects + [receiver]))
        (stage / ('topology-' + label + '-report.json')).write_text(json.dumps(report, indent=2) + '\n')
        if malformed or not report['selectionMatchesRecipe']:
            raise ValueError('Pre-bake diagnostic rejected malformed geometry/selection; inspect retained report')
        return report


    def world_triangles(objects, graph, evaluated):
        """Oriented world triangles with actual per-corner shading and material-name bindings."""
        records = []
        for original in objects:
            obj = original.evaluated_get(graph) if evaluated else original
            mesh = obj.to_mesh(preserve_all_data_layers=True, depsgraph=graph) if evaluated else obj.data
            try:
                mesh.calc_loop_triangles()
                normal_matrix = obj.matrix_world.to_3x3().inverted().transposed()
                for triangle in mesh.loop_triangles:
                    polygon = mesh.polygons[triangle.polygon_index]
                    material_index = polygon.material_index
                    material_name = (mesh.materials[material_index].name_full
                                     if material_index < len(mesh.materials) and mesh.materials[material_index]
                                     else None)
                    positions = [list(obj.matrix_world @ mesh.vertices[i].co) for i in triangle.vertices]
                    normals = [list((normal_matrix @ mesh.corner_normals[i].vector).normalized())
                               for i in triangle.loops]
                    if any(not math.isfinite(v) for p in positions + normals for v in p):
                        raise ValueError('Nonfinite world triangle/shading data before join comparison')
                    if any(math.hypot(*normal) < .99 for normal in normals):
                        raise ValueError('Invalid corner normal before join comparison')
                    records.append({'positions': positions, 'normals': normals,
                                    'smooth': polygon.use_smooth, 'material': material_name})
            finally:
                if evaluated:
                    obj.to_mesh_clear()
        return records


    def compare_world_triangles(before, after):
        """Conservative oriented multiset bijection; ambiguous matches fail rather than being hidden."""
        scale = max([1e-3] + [abs(v) for row in before for p in row['positions'] for v in p])
        # Float32 matrix multiplication/join rounding allowance; never expanded after a failed run.
        position_tolerance = 16 * 2 ** -23 * scale
        normal_tolerance = 32 * 2 ** -23
        bucket = lambda row: tuple(math.floor(sum(p[a] for p in row['positions']) / 3 / position_tolerance)
                                   for a in range(3))
        buckets = {}
        for index, row in enumerate(before):
            buckets.setdefault(bucket(row), []).append(index)
        used = set()
        report = {'originalTriangles': len(before), 'joinedTriangles': len(after),
                  'positionToleranceM': position_tolerance, 'normalVectorTolerance': normal_tolerance,
                  'maxMatchedPositionErrorM': 0, 'maxMatchedNormalVectorError': 0,
                  'maxMatchedNormalAngleDegrees': 0, 'unmatchedJoinedTriangles': 0,
                  'ambiguousMatches': 0, 'materialMismatches': 0, 'smoothMismatches': 0,
                  'normalMismatches': 0, 'changedNormalTriangles': 0,
                  'changedTriangleCornerNormals': 0, 'examples': []}
        for new in after:
            centre = bucket(new)
            matches = []
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        for index in buckets.get((centre[0] + dx, centre[1] + dy, centre[2] + dz), []):
                            if index in used:
                                continue
                            old = before[index]
                            for shift in range(3):
                                error = max(math.dist(old['positions'][i], new['positions'][(i + shift) % 3])
                                            for i in range(3))
                                if error <= position_tolerance:
                                    matches.append((error, index, shift))
            if not matches:
                report['unmatchedJoinedTriangles'] += 1
                if len(report['examples']) < 5:
                    report['examples'].append({'unmatchedJoinedTriangle': new})
                continue
            if len(matches) != 1:
                report['ambiguousMatches'] += 1
            error, index, shift = min(matches)
            used.add(index)
            old = before[index]
            report['maxMatchedPositionErrorM'] = max(report['maxMatchedPositionErrorM'], error)
            errors = []
            for i in range(3):
                a, b = old['normals'][i], new['normals'][(i + shift) % 3]
                normal_error = math.dist(a, b)
                errors.append(normal_error)
                dot = sum(a[k] * b[k] for k in range(3)) / (math.hypot(*a) * math.hypot(*b))
                angle = math.degrees(math.acos(max(-1, min(1, dot))))
                report['maxMatchedNormalAngleDegrees'] = max(report['maxMatchedNormalAngleDegrees'], angle)
            report['maxMatchedNormalVectorError'] = max(report['maxMatchedNormalVectorError'], *errors)
            report['changedNormalTriangles'] += any(error > 0 for error in errors)
            report['changedTriangleCornerNormals'] += sum(error > 0 for error in errors)
            report['normalMismatches'] += max(errors) > normal_tolerance
            report['materialMismatches'] += old['material'] != new['material']
            report['smoothMismatches'] += old['smooth'] != new['smooth']
        report['unmatchedOriginalTriangles'] = len(before) - len(used)
        bounds = lambda rows: ([min(p[a] for row in rows for p in row['positions']) for a in range(3)] +
                               [max(p[a] for row in rows for p in row['positions']) for a in range(3)])
        report['boundsMaxAbsErrorM'] = (max(abs(a - b) for a, b in zip(bounds(before), bounds(after)))
                                       if before and after else None)
        report['passed'] = bool(before and len(before) == len(after)
            and not any(report[key] for key in ('unmatchedOriginalTriangles', 'unmatchedJoinedTriangles',
                'ambiguousMatches', 'materialMismatches', 'smoothMismatches', 'normalMismatches'))
            and report['boundsMaxAbsErrorM'] <= position_tolerance)
        return report


    def authored_join_variant(result):
        """Root-approved NEW unpublished art variant, explicitly separate from strict equivalence."""
        states = result['comparisons']
        geometry_ok = set(states) == {'raw', 'evaluated'} and all(report['originalTriangles'] > 0
            and report['originalTriangles'] == report['joinedTriangles']
            and not any(report[key] for key in ('unmatchedOriginalTriangles', 'unmatchedJoinedTriangles',
                'ambiguousMatches', 'materialMismatches', 'smoothMismatches'))
            and report['maxMatchedPositionErrorM'] <= report['positionToleranceM']
            and report['boundsMaxAbsErrorM'] is not None
            and report['boundsMaxAbsErrorM'] <= report['positionToleranceM']
            for report in states.values())
        normals_ok = all(0 <= report['maxMatchedNormalAngleDegrees'] <= .15
                         for report in states.values())
        unchanged = (result['anchorIdentity'] and result['receiverUnchanged']
            and set(result['counts']) == {'raw', 'evaluated'}
            and all(pair['original'] == pair['joined'] for pair in result['counts'].values()))
        return {'policy': 'Intentional unpublished high-surface normal refresh, not join-only equivalence',
            'maximumAllowedNormalAngleDegrees': .15,
            'strictSurfaceEquivalent': result['passed'],
            'accepted': bool(geometry_ok and normals_ok and unchanged),
            'geometryMaterialSmoothAndCountGatesUnchanged': geometry_ok and unchanged,
            'measured': {state: {key: report.get(key) for key in
                ('changedNormalTriangles', 'changedTriangleCornerNormals', 'normalMismatches',
                 'maxMatchedNormalVectorError', 'maxMatchedNormalAngleDegrees')}
                for state, report in states.items()},
            'qualification': 'Changed counts count nonzero measured world-vector differences; strict mismatch counts use the original unchanged strict vector tolerance. No identical-normal claim.'}


    def join_high_sources(role, kind):
        """Built-in object composition only: no weld, triangulation, decimation or validation cleaning."""
        global high_objects
        original = save_prebake_diagnostic(role, kind, 'original')
        graph = bpy.context.evaluated_depsgraph_get()
        before = {state: world_triangles(high_objects, graph, state == 'evaluated')
                  for state in ('raw', 'evaluated')}
        receiver_before = (geometry_fingerprint(receiver.data), [list(row) for row in receiver.matrix_world])
        names = [obj.name_full for obj in high_objects]
        anchor = bpy.data.objects.new('High joined identity anchor', bpy.data.meshes.new('High joined surface'))
        scene.collection.objects.link(anchor)
        anchor.matrix_world = Matrix.Identity(4)
        bpy.ops.object.select_all(action='DESELECT')
        for obj in high_objects:
            obj.select_set(True)
        anchor.select_set(True)
        bpy.context.view_layer.objects.active = anchor
        bpy.context.view_layer.update()
        bpy.ops.object.join()
        high_objects = [anchor]
        receiver.select_set(True)
        bpy.context.view_layer.objects.active = receiver
        bpy.context.view_layer.update()
        graph = bpy.context.evaluated_depsgraph_get()
        graph.update()
        joined = save_prebake_diagnostic(role, kind, 'joined')
        comparisons = {state: compare_world_triangles(before[state],
                        world_triangles(high_objects, graph, state == 'evaluated'))
                       for state in ('raw', 'evaluated')}
        receiver_after = (geometry_fingerprint(receiver.data), [list(row) for row in receiver.matrix_world])
        counts = lambda report, state: {key: sum(row[state][key] for row in report['rows'])
                                        for key in ('vertices', 'edges', 'faces', 'loops')}
        identity = all(value == (1 if row == col else 0)
                       for row, line in enumerate(anchor.matrix_world) for col, value in enumerate(line))
        result = {'hypothesis': 'Joined source organization plus explicit unpublished normal refresh; no engine-cause assertion',
            'sourceObjectsBefore': names, 'sourceObjectsAfter': [anchor.name_full],
            'anchorIdentity': identity, 'receiverUnchanged': receiver_before == receiver_after,
            'comparisons': comparisons,
            'counts': {state: {'original': counts(original, state), 'joined': counts(joined, state)}
                       for state in ('raw', 'evaluated')}}
        result['passed'] = (identity and result['receiverUnchanged']
            and all(report['passed'] for report in comparisons.values())
            and all(pair['original'] == pair['joined'] for pair in result['counts'].values()))
        result['authoredVariant'] = authored_join_variant(result)
        (stage / 'join-comparison.json').write_text(json.dumps(result, indent=2) + '\n')
        if not result['authoredVariant']['accepted']:
            raise ValueError('Unpublished joined variant exceeded approved normal or unchanged geometry gates; no bake')


    def bake(role, kind):
        global diagnostic_saved
        image = bpy.data.images.new('Cactus near ' + role, width=size, height=size, alpha=False)
        image.colorspace_settings.name = 'sRGB' if role == 'albedo' else 'Non-Color'
        image_node.image = image
        bpy.ops.object.select_all(action='DESELECT')
        for obj in high_objects:
            obj.select_set(True)
        receiver.select_set(True)
        bpy.context.view_layer.objects.active = receiver
        bpy.context.view_layer.update()
        if not diagnostic_saved:
            join_high_sources(role, kind)
            diagnostic_saved = True
        bpy.ops.object.bake(type=kind)
        image.filepath_raw = str(stage / ('near-' + role + '.png'))
        image.file_format = 'PNG'
        image.save()
        maps[role] = image
        return image


    bake('albedo', 'DIFFUSE')
    if args.diagnostic_first_bake:
        for record in job['inputs'] + job['scripts']:
            if sha(record['path']) != record['sha256']:
                raise ValueError('Input changed during cactus diagnostic')
        names = ['near-albedo.png', 'join-comparison.json']
        for label in ('original', 'joined'):
            names += ['high-' + label + '-prebake.blend']
            names += ['topology-' + label + '-' + suffix for suffix in
                      ('context.json', 'meshes.jsonl', 'report.json')]
        joined_surface = json.loads((stage / 'join-comparison.json').read_text())
        receipt = {'status': 'First bake diagnostic only; no candidate/art acceptance',
                   'jobSHA256': sha(job_path),
                   'strictSurfaceEquivalent': joined_surface['passed'],
                   'authoredNormalVariant': joined_surface['authoredVariant'],
                   'files': [{'path': str(stage / name), 'sha256': sha(stage / name)} for name in names]}
        (stage / 'diagnostic-result.json').write_text(json.dumps(receipt, indent=2) + '\n')
        raise SystemExit(0)
    bake('normal', 'NORMAL')
    bake('ao', 'AO')
    for image in maps.values():
        image.pack()
    bpy.ops.wm.save_as_mainfile(filepath=str(stage / 'tile-source.blend'))
    # Bake real authored roughness through an emission output, with no light/exposure contribution.
    for mat in (skin, pad, spine):
        tree = mat.node_tree
        bsdf = tree.nodes.get('Principled BSDF')
        emit = tree.nodes.new('ShaderNodeEmission')
        source = bsdf.inputs['Roughness']
        if source.is_linked:
            tree.links.new(source.links[0].from_socket, emit.inputs['Color'])
        else:
            value = source.default_value
            emit.inputs['Color'].default_value = (value, value, value, 1)
        tree.links.new(emit.outputs['Emission'], tree.nodes.get('Material Output').inputs['Surface'])
    bake('roughness', 'EMIT')
    arm = bpy.data.images.new('Cactus near ARM', width=size, height=size, alpha=False)
    arm.colorspace_settings.name = 'Non-Color'
    ao_pixels, rough_pixels = list(maps['ao'].pixels), list(maps['roughness'].pixels)
    pixels = []
    for i in range(0, len(ao_pixels), 4):
        pixels.extend((ao_pixels[i], rough_pixels[i], 0, 1))
    arm.pixels.foreach_set(pixels)
    arm.filepath_raw = str(stage / 'near-arm.png')
    arm.file_format = 'PNG'
    arm.save()

# Rebuild the unpublished NEAR silhouette. Far/shared donor stays untouched.
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=job['donor'])
original = next(obj for obj in scene.objects if obj.type == 'MESH' and obj.data.name.startswith('cactus.saguaro_one_arm'))
original_world = [original.matrix_world @ vertex.co for vertex in original.data.vertices]
old_min = Vector(tuple(min(v[a] for v in original_world) for a in range(3)))
old_max = Vector(tuple(max(v[a] for v in original_world) for a in range(3)))
for obj in list(scene.objects):
    bpy.data.objects.remove(obj, do_unlink=True)


def tube(name, centres, radii, ribs, segments=96):
    vertices, faces = [], []
    for ring, (centre, radius) in enumerate(zip(centres, radii)):
        tangent = (centres[min(ring + 1, len(centres) - 1)] - centres[max(ring - 1, 0)]).normalized()
        axis = Vector((0, 1, 0))
        side = tangent.cross(axis).normalized()
        up = side.cross(tangent).normalized()
        for i in range(segments):
            angle = i * math.tau / segments
            # Actual 12–18 mm rounded longitudinal ribs, not only a painted normal stripe.
            ridge = .5 + .5 * math.cos(angle * ribs)
            r = radius * (.88 + .12 * ridge ** .8)
            vertices.append(centre + (side * math.cos(angle) + up * math.sin(angle)) * r)
        if ring:
            for i in range(segments):
                a = (ring - 1) * segments + i
                b = (ring - 1) * segments + (i + 1) % segments
                c = ring * segments + (i + 1) % segments
                d = ring * segments + i
                faces.append((a, d, c, b))
    faces.append(tuple(range(segments)))
    faces.append(tuple((len(centres) - 1) * segments + i for i in reversed(range(segments))))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    return obj


main_centres = [Vector((.003 * math.sin(i / 36 * math.pi), 0, -.08 + i / 36 * 1.76)) for i in range(37)]
main_radii = [.168 - .012 * i / 36 for i in range(37)]
for i in range(1, 13):
    phi = i / 12 * math.pi / 2
    main_centres.append(Vector((0, 0, 1.68 + .156 * math.sin(phi))))
    main_radii.append(max(.0003, .156 * math.cos(phi)))
trunk = tube('Continuous ribbed trunk and rounded crown', main_centres, main_radii, 12)
arm_centres = []
for i in range(29):
    t = i / 28
    a, b, c, d = [Vector(v) for v in ((-.015, .015, .80), (-.025, .16, .86), (-.14, .30, .92), (-.14, .30, 1.16))]
    arm_centres.append(a * (1-t)**3 + b * (3*(1-t)**2*t) + c * (3*(1-t)*t*t) + d*t**3)
for i in range(1, 17):
    arm_centres.append(Vector((-.14, .30, 1.16 + i / 16 * .30)))
arm_radii = [.109 - .008 * i / (len(arm_centres)-1) for i in range(len(arm_centres))]
for i in range(1, 11):
    phi = i / 10 * math.pi / 2
    arm_centres.append(Vector((-.14, .30, 1.46 + .101 * math.sin(phi))))
    arm_radii.append(max(.0003, .101 * math.cos(phi)))
arm_body = tube('Ribbed curved arm and rounded crown', arm_centres, arm_radii, 10, 80)
bpy.ops.object.select_all(action='DESELECT')
trunk.select_set(True)
arm_body.select_set(True)
bpy.context.view_layer.objects.active = trunk
bpy.ops.object.join()
body = trunk
# Built-in voxel union creates one continuous skin at the arm root. No overlapping cut panel.
remesh = body.modifiers.new('Organic continuous branch union', 'REMESH')
remesh.mode = 'VOXEL'
remesh.voxel_size = .0055
remesh.use_smooth_shade = True
bpy.ops.object.modifier_apply(modifier=remesh.name)
smooth = body.modifiers.new('Soften union and crown', 'SMOOTH')
smooth.factor = .32
smooth.iterations = 3
bpy.ops.object.modifier_apply(modifier=smooth.name)
body.data.calc_loop_triangles()
decimate = body.modifiers.new('Near authored body budget', 'DECIMATE')
decimate.ratio = min(1, 10500 / len(body.data.loop_triangles))
bpy.ops.object.modifier_apply(modifier=decimate.name)
tri = body.modifiers.new('Native skin triangles', 'TRIANGULATE')
bpy.ops.object.modifier_apply(modifier=tri.name)
new_min = Vector(tuple(min(v.co[a] for v in body.data.vertices) for a in range(3)))
new_max = Vector(tuple(max(v.co[a] for v in body.data.vertices) for a in range(3)))
for vertex in body.data.vertices:
    for axis in range(3):
        vertex.co[axis] = old_min[axis] + (vertex.co[axis] - new_min[axis]) / (new_max[axis] - new_min[axis]) * (old_max[axis] - old_min[axis])
body.data.update()
for face in body.data.polygons:
    face.use_smooth = True
# New cylindrical UVs use measured physical density; split only at the back seam.
uv = body.data.uv_layers.new(name='UVMap')
colors = body.data.color_attributes.new(name='SkinAndDrySpines', type='FLOAT_COLOR', domain='CORNER')
physical_tile = 512 / 1705.5703337395114
for face in body.data.polygons:
    points = [body.data.vertices[body.data.loops[i].vertex_index].co for i in face.loop_indices]
    center = sum(points, Vector()) / len(points)
    arm_patch = center.y > .16 and center.z > .94
    cx, cy, radius = (-.14, .30, .103) if arm_patch else (0, 0, .16)
    angles = [math.atan2(p.y-cy, p.x-cx) for p in points]
    if max(angles)-min(angles) > math.pi:
        angles = [a+math.tau if a<0 else a for a in angles]
    for loop, point, angle in zip(face.loop_indices, points, angles):
        uv.data[loop].uv = (angle*radius/physical_tile, point.z/physical_tile)
        variation = 1 + .055*math.sin(point.z*7.1+point.x*12) + .025*math.sin(point.y*31)
        colors.data[loop].color = (.125*variation, .215*variation, .066*variation, 1)

# Actual low-poly spine clusters: nine radial needles, staggered along rib crests.
# Ray casting places each cluster on the evaluated authored skin, including the bent arm.
bpy.context.view_layer.update()
vertices = [v.co.copy() for v in body.data.vertices]
faces = [tuple(p.vertices) for p in body.data.polygons]
uv_faces = [[tuple(uv.data[i].uv) for i in p.loop_indices] for p in body.data.polygons]
color_faces = [[tuple(colors.data[i].color) for i in p.loop_indices] for p in body.data.polygons]
spine_count = clusters = 0

def needle(start, end, radius, color):
    global spine_count
    direction = (end-start).normalized()
    side = direction.cross(Vector((0,0,1)))
    if side.length < .1:
        side = direction.cross(Vector((0,1,0)))
    side.normalize()
    up = direction.cross(side).normalized()
    first = len(vertices)
    for i in range(3):
        a = i*math.tau/3
        vertices.append(start + (side*math.cos(a)+up*math.sin(a))*radius)
    vertices.append(end)
    for i in range(3):
        faces.append((first+i,first+(i+1)%3,first+3))
        uv_faces.append([(0,0),(.003/physical_tile,0),(0,(end-start).length/physical_tile)])
        color_faces.append([(*color,1)]*3)
    spine_count += 1

for branch in ('trunk','arm'):
    rows = 16 if branch=='trunk' else 6
    ribs = 12 if branch=='trunk' else 10
    for row in range(rows):
        height = .10 + row/15*1.52 if branch=='trunk' else 1.07+row/5*.38
        for rib in range(ribs):
            # Every second alternating rib-row receives a close-readable cluster.
            if (rib+row)%2:
                continue
            angle = rib*math.tau/ribs + math.pi
            cx,cy = (0,0) if branch=='trunk' else (-.14,.30)
            outward = Vector((math.cos(angle), math.sin(angle), 0))
            origin = Vector((cx,cy,height)) + outward*.25
            hit,point,normal,index = body.ray_cast(origin, -outward, distance=.35)
            if not hit or normal.dot(outward)<.4:
                continue
            # Reject hidden intersection-side arm spines and buried branch needles.
            if branch=='trunk' and .87<height<1.45 and point.y>.11:
                continue
            tangent = normal.cross(Vector((0,0,1))).normalized()
            vertical = tangent.cross(normal).normalized()
            start = point + normal*.001
            clusters += 1
            for ray in range(7):
                a = ray*math.tau/7 + rng.uniform(-.12,.12)
                direction = (normal*.42 + tangent*math.cos(a) + vertical*math.sin(a)).normalized()
                length = rng.uniform(.016,.026)
                needle(start, start+direction*length, .00072, (.59,.48,.29))
            needle(start, start+normal*rng.uniform(.027,.035), .0009, (.67,.56,.36))
new_mesh = bpy.data.meshes.new('cactus.saguaro_one_arm')
new_mesh.from_pydata(vertices, [], faces)
new_mesh.update()
old_mesh = body.data
body.data = new_mesh
bpy.data.meshes.remove(old_mesh)
new_uv = new_mesh.uv_layers.new(name='UVMap')
new_colors = new_mesh.color_attributes.new(name='SkinAndDrySpines', type='FLOAT_COLOR', domain='CORNER')
for polygon, uvs, cols in zip(new_mesh.polygons, uv_faces, color_faces):
    polygon.use_smooth = polygon.index < len(faces)-spine_count*3
    for loop, coord, color in zip(polygon.loop_indices, uvs, cols):
        new_uv.data[loop].uv = coord
        new_colors.data[loop].color = color
# Measure and normalize global density without changing the fixed physical geometry.
area = uv_area = 0
for polygon in new_mesh.polygons:
    ids = list(polygon.vertices)
    p = [new_mesh.vertices[i].co for i in ids]
    t = [Vector(new_uv.data[i].uv) for i in polygon.loop_indices]
    area += (p[1]-p[0]).cross(p[2]-p[0]).length/2
    uv_area += abs((t[1].x-t[0].x)*(t[2].y-t[0].y)-(t[1].y-t[0].y)*(t[2].x-t[0].x))/2
uv_density = 512*math.sqrt(uv_area/area)
uv_scale = 1705.5703337395114/uv_density
for loop in new_uv.data:
    loop.uv *= uv_scale
body.name = 'prefab.saguaro_one_arm'
body.data.name = 'cactus.saguaro_one_arm'
bpy.context.view_layer.update()
body.data.calc_loop_triangles()
triangles = len(body.data.loop_triangles)
if not 10000 <= triangles <= job['budget']:
    raise ValueError('Near cactus authored triangle budget: '+str(triangles))
bpy.ops.wm.save_as_mainfile(filepath=str(stage/'near-source.blend'))
bpy.ops.export_scene.gltf(filepath=str(stage/'near.glb'), export_format='GLB', use_selection=True,
    export_yup=True, export_materials='NONE', export_vertex_color='ACTIVE',
    export_active_vertex_color_when_no_material=True, export_normals=True,
    export_texcoords=True, export_animations=False)
for record in job['inputs'] + job['scripts']:
    if sha(record['path']) != record['sha256']:
        raise ValueError('Input changed during cactus authoring')
files = [stage / name for name in ('near.glb', 'near-albedo.png', 'near-normal.png', 'near-arm.png',
                                  'tile-source.blend', 'near-source.blend')]
receipt = {'status': 'Unaccepted original near art prototype', 'jobSHA256': sha(job_path),
    'blenderVersion': bpy.app.version_string, 'device': 'CPU', 'threads': 2, 'seed': 20261115,
    'triangles': triangles, 'tileMetres': tile, 'mapSize': size,
    'source': 'original procedural Blender skin/union/spines; retained donor supplies envelope/pivot only',
    'detail': 'Continuous voxel-unioned ribbed trunk/arm, rounded crowns, real clustered spine silhouettes; retained hash-bound original tile maps',
    'spineClusters': clusters, 'spines': spine_count, 'physicalTexelsPerMetre': 1705.5703337395114,
    'mapSource': job.get('reusedMaps', []),
    'files': [{'path': str(path), 'sha256': sha(path)} for path in files]}
(stage / 'authoring-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
