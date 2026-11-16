"""Original metre-scale freight cases. Run only in the integrator's Blender lane."""
import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import bpy
from mathutils import Vector

ARGS = argparse.ArgumentParser()
ARGS.add_argument('--stage', required=True)
args = ARGS.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
stage = Path(args.stage).resolve()
project = Path(__file__).resolve().parents[2]
for protected in ('public', 'src', 'tools/art'):
    if stage == project / protected or project / protected in stage.parents:
        raise ValueError('Authoring output must be outside protected source/public directories')
job_path = stage / 'authoring-job.json'
job = json.loads(job_path.read_text())

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

for record in job['inputs'] + job['scripts']:
    if sha(record['path']) != record['sha256']:
        raise ValueError('Changed freight authoring input: ' + record['path'])
if sha(stage / 'source/receipt.json') != job['sourceReceipt']:
    raise ValueError('Changed licensed source receipt')
source = json.loads((stage / 'source/receipt.json').read_text())
for record in source['files'] + source['metadata']:
    if sha(stage / 'source' / record['file']) != record['sha256']:
        raise ValueError('Changed licensed source image/metadata')
atlas = json.loads((stage / 'atlas-receipt.json').read_text())
for record in atlas['maps']:
    if sha(record['path']) != record['sha256']:
        raise ValueError('Changed shared atlas')
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
material = bpy.data.materials.new('Freight scanned atlas')
material.use_nodes = True
nodes = material.node_tree.nodes
links = material.node_tree.links
principled = nodes.get('Principled BSDF')
images = {}
for role in ('albedo', 'normal', 'arm'):
    image = bpy.data.images.load(str(stage / 'maps' / ('freight-' + role + '.png')))
    image.colorspace_settings.name = 'sRGB' if role == 'albedo' else 'Non-Color'
    images[role] = image
    texture = nodes.new('ShaderNodeTexImage')
    texture.image = image
    if role == 'albedo':
        links.new(texture.outputs['Color'], principled.inputs['Base Color'])
    elif role == 'normal':
        normal = nodes.new('ShaderNodeNormalMap')
        normal.inputs['Strength'].default_value = 1
        links.new(texture.outputs['Color'], normal.inputs['Color'])
        links.new(normal.outputs['Normal'], principled.inputs['Normal'])
    else:
        channels = nodes.new('ShaderNodeSeparateColor')
        links.new(texture.outputs['Color'], channels.inputs['Color'])
        links.new(channels.outputs['Green'], principled.inputs['Roughness'])
        links.new(channels.outputs['Blue'], principled.inputs['Metallic'])
STRIPS = ((.075, .155), (.185, .265), (.295, .375), (.41, .49), (.52, .60), (.635, .715))
BOARD = .022
CLEAT = .025
reports = []
piece_reports = []
built_roots = []


def uv_box(obj, size, role, index, offset=(0, 0, 0), stamp=False):
    """Metred scan crops: independent longitudinal phase and frame/panel finish patches."""
    mesh = obj.data
    layer = mesh.uv_layers.active or mesh.uv_layers.new()
    layer.name = 'Freight UV metres'
    long_axis = max(range(3), key=lambda axis: size[axis])
    frame = any(word in obj.name for word in ('cleat', 'corner-post', 'brace', 'lid-frame'))
    strip = STRIPS[((index & 255) % 3) * 2 + (0 if frame else 1)]
    phase = ((index >> 8) % 11) / 10
    reverse = bool((index >> 19) & 1)
    for face in mesh.polygons:
        normal_axis = max(range(3), key=lambda axis: abs(face.normal[axis]))
        axes = [axis for axis in range(3) if axis != normal_axis]
        end = normal_axis == long_axis and role == 'wood'
        grain = long_axis if long_axis in axes else axes[1]
        across = next(axis for axis in axes if axis != grain)
        for loop in face.loop_indices:
            absolute = mesh.vertices[mesh.loops[loop].vertex_index].co
            point = [absolute[axis] - offset[axis] for axis in range(3)]
            along = point[grain] + size[grain] / 2
            cross = point[across] + size[across] / 2
            if role == 'metal':
                u, v = .81 + cross / max(size[across], .001) * .12, .03 + along / max(size[grain], .001) * .18
            elif stamp and normal_axis == 2 and face.normal.z > .5:
                # One metred projection across the centre boards; glyph centre is atlas(.875,.75).
                u, v = .875 + absolute.x / 2, .75 + absolute.y / 2
            elif end:
                u, v = .80 + cross / 2, .29 + along / 2
            else:
                u = strip[0] + cross / 2
                span = max(0, .96 - size[grain] / 2 - .02)
                v = .02 + phase * span + ((size[grain] - along) if reverse else along) / 2
            layer.data[loop].uv = (u, v)


def lid_plank(parent, name, left, right, depth, height, near, stamp):
    """Closed22mm plank with <=0.4mm interior top seam; flush rim seals both ends."""
    cut, spread = (.0004, .0008) if near else (0, 0)
    profile = [(left, height - BOARD), (right, height - BOARD)]
    profile += ([(right, height - cut), (right - spread, height),
                 (left + spread, height), (left, height - cut)] if near else
                [(right, height), (left, height)])
    count = len(profile)
    vertices = [(x, y, z) for y in (-depth / 2, depth / 2) for x, z in profile]
    faces = [tuple(range(count)), tuple(reversed(range(count, count * 2)))]
    faces += [(i, i + count, (i + 1) % count + count, (i + 1) % count) for i in range(count)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new('freight-skin:' + name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.parent = parent
    obj['freightRole'] = 'body'
    obj.data.materials.append(material)
    stable = int(hashlib.sha256((parent.name.rsplit(':', 1)[0] + ':' + name).encode()).hexdigest()[:8], 16)
    uv_box(obj, (right - left, depth, BOARD), 'wood', stable,
           ((left + right) / 2, 0, height - BOARD / 2), stamp)
    return obj


def box(parent, name, center, size, near=True, role='wood', rotation=0, bounds=None):
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.object
    obj.name = ('hardware:' if role == 'metal' else 'freight-skin:') + name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    stable = int(hashlib.sha256((parent.name.rsplit(':', 1)[0] + ':' + name).encode()).hexdigest()[:8], 16)
    uv_box(obj, size, role, stable)
    # Bake from double-precision authored edges once, rather than adding separately
    # rounded object centres and half widths in the exported scene graph.
    low, high = bounds if bounds else ([center[a] - size[a] / 2 for a in range(3)],
                                      [center[a] + size[a] / 2 for a in range(3)])
    for vertex in obj.data.vertices:
        point = [high[a] if vertex.co[a] > 0 else low[a] for a in range(3)]
        if rotation:
            x, z = point[0] - center[0], point[2] - center[2]
            point[0] = center[0] + math.cos(rotation) * x + math.sin(rotation) * z
            point[2] = center[2] - math.sin(rotation) * x + math.cos(rotation) * z
        vertex.co = point
    obj.data.update()
    obj.parent = parent
    obj.data.materials.append(material)
    obj['freightRole'] = 'hardware' if role == 'metal' else 'body'
    if near and not name.startswith(('lid', 'floor')):
        bevel = obj.modifiers.new('Cut plank edges', 'BEVEL')
        bevel.width = min(.0015, min(size) / 4)
        bevel.segments = 1
        bevel.affect = 'EDGES'
        weighted = obj.modifiers.new('Board face normals', 'WEIGHTED_NORMAL')
        weighted.keep_sharp = True
    return obj


def planks(parent, width, depth, height, side, near, family):
    """Closed butt-jointed planks; structural cleats project only25mm from their face."""
    t = BOARD
    if side == 'lid':
        rim = .035
        inner_width, inner_depth = width - 2 * rim, depth - 2 * rim
        for sign in (-1, 1):
            box(parent, 'lid-frame-end-' + str(sign), (0, sign * (depth - rim) / 2, height - t / 2), (width, rim, t), near)
            box(parent, 'lid-frame-side-' + str(sign), (sign * (width - rim) / 2, 0, height - t / 2), (rim, inner_depth, t), near)
        count = max(1, round(inner_width / .13))
        edges = [-inner_width / 2 + inner_width * i / count for i in range(count + 1)]
        for i in range(count):
            left, right = edges[i:i + 2]
            marked = family == 'mercantile' and left >= -.25 and right <= .25
            lid_plank(parent, 'lid-panel-' + str(i), left, right, inner_depth, height, near, marked)
        # Frame joins are also sampled; no lid groove reaches an outer contact face.
        return [[1, 1, 0, edge] for edge in edges] + [[1, 1, 2, value] for value in (-inner_depth / 2, inner_depth / 2)]
    if side == 'floor':
        count = max(1, round(width / .13))
        edges = [-width / 2 + width * i / count for i in range(count + 1)]
        for i in range(count):
            left, right = edges[i:i + 2]
            box(parent, side + '-' + str(i), ((left + right) / 2, 0, t / 2), (right - left, depth, t), near,
                bounds=([left, -depth / 2, 0], [right, depth / 2, t]))
        return [[1, -1, 0, edge] for edge in edges[1:-1]]
    normal = 1 if side in ('front', 'back') else 0
    sign = -1 if side in ('front', 'left') else 1
    span = width - 2 * CLEAT if normal == 1 else depth - 2 * CLEAT
    count = max(1, round(span / .13))
    edges = [-span / 2 + span * i / count for i in range(count + 1)]
    inset = (depth if normal == 1 else width) / 2 - CLEAT - t / 2
    for i in range(count):
        left, right = edges[i:i + 2]
        part = right - left
        along = (left + right) / 2
        center = (along, sign * inset, height / 2) if normal == 1 else (sign * inset, along, height / 2)
        size = (part, t, height - 2 * t) if normal == 1 else (t, part, height - 2 * t)
        low = [center[a] - size[a] / 2 for a in range(3)]
        high = [center[a] + size[a] / 2 for a in range(3)]
        low[1 - normal], high[1 - normal] = left, right
        box(parent, side + '-plank-' + str(i), center, size, near, bounds=(low, high))
    # Exporter is Y-up: Blender's positive Y becomes negative glTF Z.
    return [[2 if normal == 1 else 0, -sign if normal == 1 else sign,
             0 if normal == 1 else 2, edge if normal == 1 else -edge]
            for edge in edges[1:-1]]


def nail(parent, center, normal, index):
    """Small real fastener, inset so its head never exceeds the structural envelope."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=.0033, depth=.0014, location=center)
    obj = bpy.context.object
    obj.name = 'hardware:nail-' + str(index)
    obj.rotation_euler = Vector((0, 0, 1)).rotation_difference(Vector(normal)).to_euler()
    obj.parent = parent
    obj['freightRole'] = 'hardware'
    obj.data.materials.append(material)
    for loop in obj.data.uv_layers.active.data:
        loop.uv = (.84 + loop.uv.x * .015, .08 + loop.uv.y * .015)


def build(model, tier):
    width, height, depth = model['dimensions']
    near = tier == 'near'
    family = model['family']
    root = bpy.data.objects.new('freight:' + model['model'] + ':' + tier, None)
    bpy.context.collection.objects.link(root)
    root['freightDimensions'] = [width, height, depth]
    root['freightFamily'] = family
    root['freightTier'] = tier
    joints = []
    for face in ('lid', 'floor', 'front', 'back', 'left', 'right'):
        joints.extend(planks(root, width, depth, height, face, near, family))
    root['freightJointPlanes'] = json.dumps(joints)
    # The posts are genuinely structural wood; no nail-only bound can enlarge the case.
    for x in (-1, 1):
        for y in (-1, 1):
            box(root, 'corner-post', (x * (width / 2 - .0275), y * (depth / 2 - .0275), height / 2), (.055, .055, height - 2 * BOARD), near)
    for side in (-1, 1):
        for z in (.07, height - .07):
            box(root, 'end-cleat', (0, side * (depth / 2 - CLEAT / 2), z), (width, CLEAT, .075), near)
            box(root, 'side-cleat', (side * (width / 2 - CLEAT / 2), 0, z), (CLEAT, depth - 2 * CLEAT, .075), near)
    if family == 'braced':
        length = math.hypot(width - .19, height - .25)
        angle = -math.atan2(height - .25, width - .19)
        for side in (-1, 1):
            box(root, 'diagonal-brace', (0, side * (depth / 2 - CLEAT / 2), height / 2), (length, CLEAT, .065), near, rotation=angle * side)
    if family == 'mercantile':
        for side in (-1, 1):
            for x in (-width / 2 + .10, width / 2 - .10):
                box(root, 'iron-end-strap', (x, side * (depth / 2 - .020), height / 2), (.025, .002, height - .12), near, 'metal')
    if near:
        for x in (-1, 1):
            for y in (-1, 1):
                nail(root, (x * (width / 2 - .0175), y * (depth / 2 - .0175), height - .0008), (0, 0, 1), 8 + (x + 1) + (y + 1) // 2)
        index = 0
        for side in (-1, 1):
            for x in (-width / 2 + .045, width / 2 - .045):
                for z in (.07, height - .07):
                    nail(root, (x, side * (depth / 2 - .0008), z), (0, side, 0), index)
                    index += 1
    return root


for model in job['models']:
    for tier in ('near', 'far'):
        root = build(model, tier)
        built_roots.append(root)
        objects = [child for child in root.children_recursive if child.type == 'MESH']
        triangles = 0
        graph = bpy.context.evaluated_depsgraph_get()
        for obj in objects:
            evaluated = obj.evaluated_get(graph)
            mesh = evaluated.to_mesh()
            mesh.calc_loop_triangles()
            triangles += len(mesh.loop_triangles)
            evaluated.to_mesh_clear()
        reports.append({'model': model['model'], 'tier': tier, 'family': model['family'], 'dimensions': model['dimensions'], 'triangles': triangles})
# UV provenance is captured from the final complete scene, not per-model construction states.
bpy.context.view_layer.update()
graph = bpy.context.evaluated_depsgraph_get()
for root in built_roots:
    for obj in (child for child in root.children_recursive if child.type == 'MESH'):
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        if len(mesh.uv_layers) != 1:
            raise ValueError('Freight source must have exactly one authored UV0 layer')
        values = set()
        for triangle in mesh.loop_triangles:
            for loop in triangle.loops:
                uv = mesh.uv_layers.active.data[loop].uv
                values.add(struct.pack('<ff', uv.x, 1.0 - uv.y).hex())
        ordered = sorted(values)
        piece_reports.append({'name': obj.name, 'uv0ValueSetSHA256': hashlib.sha256('\n'.join(ordered).encode()).hexdigest(), 'uv0UniqueValues': len(values), 'uv0Values': [list(struct.unpack('<ff', bytes.fromhex(value))) for value in ordered]})
        evaluated.to_mesh_clear()
for image in images.values():
    image.pack()
blend = stage / 'author.blend'
output = stage / 'crate-library.glb'
bpy.ops.wm.save_as_mainfile(filepath=str(blend))
bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', export_yup=True, export_apply=True, export_materials='NONE', export_extras=True)
inputs = [{'path': str(job_path), 'sha256': sha(job_path)}, {'path': str(Path(__file__).resolve()), 'sha256': sha(__file__)}, {'path': str(stage / 'atlas-receipt.json'), 'sha256': sha(stage / 'atlas-receipt.json')}]
outputs = [{'path': str(path), 'sha256': sha(path), 'bytes': path.stat().st_size} for path in (blend, output)]
(stage / 'author-receipt.json').write_text(json.dumps({'status': 'original staged freight source; no native/art acceptance', 'blender': bpy.app.version_string, 'inputs': inputs, 'outputs': outputs, 'models': reports, 'pieces': piece_reports, 'limits': ['First-look subset only unless job explicitly selected all covers', 'Source scan and authored endgrain/stencil require actual daylight acceptance', 'No runtime/public/manifests were edited']}, indent=2) + '\n')
