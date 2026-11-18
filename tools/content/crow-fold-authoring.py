"""Bake articulated crow shoulder/elbow/wrist clips with headless Blender math.

blender --background --factory-startup --python tools/content/crow-fold-authoring.py
Writes a review candidate outside public. Replaces wing plates with layered coverts;
retains existing flight feathers, UV atlas, head motion and two-second clips. The separate
three-second campaign crow cue is not an input to this authoring pass.
"""
import json
import math
import struct
import sys
from pathlib import Path

from mathutils import Matrix, Quaternion, Vector

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'tools/art/environments/crow-articulated-base.glb'
arguments = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUTPUT = Path(arguments[0]) if arguments else Path('/tmp/out-west-crow-fold/crow.glb')


class Asset:
    def __init__(self, path):
        raw = path.read_bytes()
        size = struct.unpack_from('<I', raw, 12)[0]
        self.doc = json.loads(raw[20:20 + size])
        self.blob = bytearray(raw[28 + size:])

    def read(self, index):
        a = self.doc['accessors'][index]
        view = self.doc['bufferViews'][a['bufferView']]
        n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[a['type']]
        fmt = {5126: 'f', 5123: 'H', 5121: 'B', 5125: 'I'}[a['componentType']]
        stride = view.get('byteStride', struct.calcsize(fmt) * n)
        offset = view.get('byteOffset', 0) + a.get('byteOffset', 0)
        return [struct.unpack_from('<' + fmt * n, self.blob, offset + i * stride)
                for i in range(a['count'])]

    def add(self, rows, kind, integer=False):
        while len(self.blob) % 4:
            self.blob.append(0)
        offset = len(self.blob)
        flat = [v for row in rows for v in row]
        self.blob.extend(struct.pack('<' + ('H' if integer else 'f') * len(flat), *flat))
        views = self.doc['bufferViews']
        views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(self.blob) - offset})
        accessor = {'bufferView': len(views) - 1, 'componentType': 5123 if integer else 5126,
                    'count': len(rows), 'type': kind}
        if kind == 'SCALAR':
            accessor.update(min=[min(flat)], max=[max(flat)])
        elif kind == 'VEC3':
            accessor.update(min=[min(row[i] for row in rows) for i in range(3)],
                            max=[max(row[i] for row in rows) for i in range(3)])
        self.doc['accessors'].append(accessor)
        return len(self.doc['accessors']) - 1

    def save(self, path):
        self.doc['buffers'] = [{'byteLength': len(self.blob)}]
        data = json.dumps(self.doc, separators=(',', ':')).encode()
        data += b' ' * (-len(data) % 4)
        self.blob += b'\0' * (-len(self.blob) % 4)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(struct.pack('<III', 0x46546C67, 2, 28 + len(data) + len(self.blob))
                         + struct.pack('<II', len(data), 0x4E4F534A) + data
                         + struct.pack('<II', len(self.blob), 0x004E4942) + self.blob)


def rotation(y, z):
    q = Quaternion((0, 1, 0), y) @ Quaternion((0, 0, 1), z)
    return [q.x, q.y, q.z, q.w]


def smooth(a, b, value):
    t = min(1, max(0, (value - a) / (b - a)))
    return t * t * (3 - 2 * t)


def feather_coverts(asset, primitive, side):
    """Replace the connected rectangular wing plate with overlapping curved coverts."""
    attributes = primitive['attributes']
    data = {key: list(asset.read(index)) for key, index in attributes.items()}
    positions = data['POSITION']
    indices = [row[0] for row in asset.read(primitive['indices'])]
    parents = list(range(len(positions)))
    def find(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index
    welded = {}
    for i, point in enumerate(positions):
        key = tuple(round(v, 5) for v in point)
        if key in welded:
            parents[find(i)] = find(welded[key])
        else:
            welded[key] = i
    for i in range(0, len(indices), 3):
        for j in (1, 2):
            parents[find(indices[i + j])] = find(indices[i])
    components = {}
    for i in range(0, len(indices), 3):
        components.setdefault(find(indices[i]), []).extend(indices[i:i + 3])
    plate = max(components, key=lambda key: len(components[key]))
    if len(components[plate]) != 288:
        raise RuntimeError('Canonical rectangular wing plate changed; inspect its topology')
    indices = [v for key, triangles in components.items() if key != plate for v in triangles]
    closed = {}
    feathers = [triangles for key, triangles in components.items() if key != plate]
    if len(feathers) != 15:
        raise RuntimeError('Canonical secondary/primary feather grouping changed')
    for k, triangles in enumerate(feathers):
        if k < 8:
            u = (k + 0.5) / 8
            base = Vector((side * (0.045 + 0.13 * u), 0.118 - 0.004 * (k % 2), -0.02))
            along = Vector((side * 0.35, -0.05, -1)).normalized()
            target = Vector((side * (0.04 + 0.001 * k), 0.123 - 0.003 * k, -0.008 - 0.011 * k))
        else:
            primary = k - 8
            fan = math.radians(3 + 4 * primary)
            base = Vector((side * 0.16, 0.12 - 0.003 * (primary % 2), 0.03 - 0.012 * primary))
            along = Vector((side * math.cos(fan), -0.04, -math.sin(fan))).normalized()
            target = Vector((side * (0.027 + 0.003 * primary), 0.102 - 0.001 * primary, -0.067))
        turn = along.rotation_difference(Vector((-side * 0.08, -0.15, -1)).normalized())
        for index in set(triangles):
            closed[index] = target + turn @ (Vector(positions[index]) - base)
    # Reuse one authored feather's atlas island, not the removed plate's broad UV region.
    island = next(triangles for key, triangles in components.items() if key != plate)
    triangles = [[data['TEXCOORD_0'][index] for index in island[i:i + 3]]
                 for i in range(0, len(island), 3)]
    def area(triangle):
        a, b, c = triangle
        return abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
    atlas = max(triangles, key=area)
    for row in range(4):
        for column in range(6):
            start = len(positions)
            span = 0.045 + column * 0.024 + row * 0.003
            front = 0.034 - row * 0.012
            length = 0.042 + 0.004 * row
            width = 0.016 - 0.001 * column
            for underside in (False, True):
                for i in range(7):
                    u = i / 6
                    radius = width * max(0.06, math.sin(math.pi * u) ** 0.65)
                    for j in range(5):
                        across = (j / 4) * 2 - 1
                        x = side * (span + across * radius + 0.006 * u)
                        y = 0.123 + row * 0.0012 + 0.002 * math.sin(math.pi * u) * (1 - across * across)
                        y -= 0.0012 if underside else 0
                        positions.append((x, y, front - length * u))
                        closed[len(positions) - 1] = Vector((
                            side * (0.034 + row * 0.003 + across * radius + 0.002 * u),
                            0.126 - 0.22 * (0.01 + column * 0.021 + length * u)
                            - row * 0.002 - (0.0012 if underside else 0),
                            -0.01 - column * 0.021 - length * u,
                        ))
                        data['NORMAL'].append((0, -1 if underside else 1, 0))
                        data['TANGENT'].append((side, 0, 0, 1))
                        data['COLOR_0'].append((1, 1, 1))
                        # Stay inside a real atlas triangle: its axis-aligned rectangle can
                        # contain another island's eye/skin texels and produce mottled feathers.
                        weights = (1 - u, u * j / 4, u * (1 - j / 4))
                        data['TEXCOORD_0'].append(tuple(sum(atlas[k][axis] * weights[k]
                                                          for k in range(3)) for axis in range(2)))
                offset = start + (35 if underside else 0)
                for i in range(6):
                    for j in range(4):
                        a = offset + i * 5 + j
                        face = [a, a + 5, a + 1, a + 1, a + 5, a + 6]
                        if underside != (side > 0):
                            face = [v for k in range(0, len(face), 3) for v in face[k:k + 3][::-1]]
                        indices.extend(face)
    # The wrist stays covered during the fold, beneath the overlapping feather tips.
    # Taper both ends so only the flexible central vane is exposed in flight.
    start = len(positions)
    span_segments, chord_segments = 12, 8
    for underside in (False, True):
        for i in range(span_segments + 1):
            u = i / span_segments
            taper = max(0.12, math.sin(math.pi * u) ** 0.4)
            for j in range(chord_segments + 1):
                v = j / chord_segments
                chord = v * 2 - 1
                lower = 0.0018 if underside else 0
                x = side * (0.110 + 0.106 * u)
                y = 0.116 + 0.0028 * math.sin(math.pi * v) - lower
                z = -0.023 + chord * 0.032 * taper + 0.016 * u
                positions.append((x, y, z))
                closed[len(positions) - 1] = Vector((
                    side * (0.041 + chord * 0.013 * taper),
                    0.116 - 0.031 * u + 0.002 * math.sin(math.pi * v) - lower,
                    -0.022 - 0.122 * u,
                ))
                data['NORMAL'].append((0, -1 if underside else 1, 0))
                data['TANGENT'].append((side, 0, 0, 1))
                data['COLOR_0'].append((0.88, 0.88, 0.88))
                weights = (1 - u, u * v, u * (1 - v))
                data['TEXCOORD_0'].append(tuple(sum(atlas[k][axis] * weights[k]
                                                  for k in range(3)) for axis in range(2)))
        stride = chord_segments + 1
        offset = start + ((span_segments + 1) * stride if underside else 0)
        for i in range(span_segments):
            for j in range(chord_segments):
                a = offset + i * stride + j
                face = [a, a + stride, a + 1, a + 1, a + stride, a + stride + 1]
                if underside != (side > 0):
                    face = [v for k in range(0, len(face), 3) for v in face[k:k + 3][::-1]]
                indices.extend(face)
    for key, rows in data.items():
        attributes[key] = asset.add(rows, 'VEC' + str(len(rows[0])))
    primitive['indices'] = asset.add([(index,) for index in indices], 'SCALAR', True)
    return closed


asset = Asset(Path(arguments[1]) if len(arguments) > 1 else SOURCE)
doc = asset.doc
if doc.get('extras', {}).get('articulatedCrowFold'):
    raise RuntimeError('Rebuild the canonical bird parts before reauthoring the fold')
nodes = doc['nodes']
root = next(i for i, node in enumerate(nodes) if node.get('name') == 'crow')
wing_hinges = {i for i, node in enumerate(nodes) if node.get('name') in
               ('hinge-1', 'hinge-2', 'hinge-3', 'hinge-4')}
rigs = []
wing_meshes = []
FOLDED = (50, 100, -60)
for side, hinge in ((1, 'hinge-1'), (-1, 'hinge-2')):
    parent = next(node for node in nodes if node.get('name') == hinge)
    mesh_node_index = next(i for i in parent['children'] if 'mesh' in nodes[i])
    mesh_node = nodes[mesh_node_index]
    parent['children'].remove(mesh_node_index)
    nodes[root]['children'].append(mesh_node_index)
    mesh_node.pop('translation', None)
    mesh_node['name'] = 'feathers.right' if side > 0 else 'feathers.left'
    points = [Vector((side * x, 0.12, z)) for x, z in
              ((0.04, 0), (0.105, -0.02), (0.175, 0.02))]
    joints = []
    for j, label in enumerate(('shoulder', 'elbow', 'wrist')):
        index = len(nodes)
        local = points[j] - points[j - 1] if j else points[j]
        nodes.append({'name': f'crow.{side}.{label}', 'translation': list(local)})
        nodes[joints[-1] if joints else root].setdefault('children', []).append(index)
        joints.append(index)
    inverse = [tuple(Matrix.Translation(-point)[row][col]
                     for col in range(4) for row in range(4)) for point in points]
    skins = doc.setdefault('skins', [])
    mesh_node['skin'] = len(skins)
    skins.append({'name': f'crow.{side}.wing', 'skeleton': joints[0], 'joints': joints,
                  'inverseBindMatrices': asset.add(inverse, 'MAT4')})
    posed = Matrix.Identity(4)
    matrices = []
    for j, point in enumerate(points):
        offset = point - points[j - 1] if j else point
        q = Quaternion((0, 1, 0), math.radians(FOLDED[j]) * side)
        posed = posed @ Matrix.Translation(offset) @ q.to_matrix().to_4x4()
        matrices.append(posed @ Matrix.Translation(-point))
    for primitive in doc['meshes'][mesh_node['mesh']]['primitives']:
        closed = feather_coverts(asset, primitive, side)
        positions = asset.read(primitive['attributes']['POSITION'])
        weights = []
        for x, _, _ in positions:
            elbow = smooth(0.09, 0.12, abs(x))
            wrist = smooth(0.15, 0.18, abs(x))
            weights.append((1 - elbow, elbow * (1 - wrist), elbow * wrist, 0))
        primitive['attributes']['JOINTS_0'] = asset.add([(0, 1, 2, 0)] * len(weights), 'VEC4', True)
        primitive['attributes']['WEIGHTS_0'] = asset.add(weights, 'VEC4')
        # A baked corrective closes the feather fan while the actual wing joints fold.
        # Feather lengths stay intact; no runtime IK or vertex callback is introduced.
        delta = []
        for i, point in enumerate(positions):
            if i not in closed:
                delta.append((0, 0, 0))
                continue
            blend = Matrix([[sum(matrices[j][r][c] * weights[i][j] for j in range(3))
                             for c in range(4)] for r in range(4)])
            delta.append(tuple(blend.inverted() @ closed[i] - Vector(point)))
        primitive['targets'] = [{'POSITION': asset.add(delta, 'VEC3')}]
    doc['meshes'][mesh_node['mesh']]['weights'] = [1]
    wing_meshes.append(mesh_node_index)
    rigs.append((side, joints))

times = [(i / 30,) for i in range(61)]
timeline = asset.add(times, 'SCALAR')
for clip in doc['animations']:
    clip['channels'] = [c for c in clip['channels'] if c['target']['node'] not in wing_hinges]
    idle = clip['name'] == 'Idle'
    for side, joints in rigs:
        for joint, node in enumerate(joints):
            keys = []
            for (t,) in times:
                if idle:
                    y = math.radians(FOLDED[joint]) * side
                    z = side * (0.015 * math.sin(math.pi * t) if joint == 0 else 0)
                else:
                    phase = 2 * math.pi * 3 * t
                    y = side * (0, 0.12, -0.08)[joint] * (0.5 + 0.5 * math.sin(phase))
                    z = side * (0.8, 0.16, 0.12)[joint] * math.sin(phase - joint * 0.25)
                keys.append(rotation(y, z))
            sampler = len(clip['samplers'])
            clip['samplers'].append({'input': timeline, 'output': asset.add(keys, 'VEC4'),
                                     'interpolation': 'LINEAR'})
            clip['channels'].append({'sampler': sampler, 'target': {'node': node, 'path': 'rotation'}})
            if idle:
                nodes[node]['rotation'] = keys[0]
    for node in wing_meshes:
        sampler = len(clip['samplers'])
        clip['samplers'].append({'input': timeline,
                                 'output': asset.add([(1 if idle else 0,)] * len(times), 'SCALAR'),
                                 'interpolation': 'LINEAR'})
        clip['channels'].append({'sampler': sampler, 'target': {'node': node, 'path': 'weights'}})
doc.setdefault('extras', {})['articulatedCrowFold'] = {'jointsPerWing': 3, 'clipSeconds': 2}
for material in doc['materials']:
    pbr = material.get('extras', {}).get('nativePbr')
    if pbr:
        pbr.pop('normalScale', None)
        pbr['normalScale'] = 0.4
asset.save(OUTPUT)
print(f'Articulated crow candidate: {OUTPUT}')
