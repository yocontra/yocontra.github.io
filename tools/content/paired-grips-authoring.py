"""Bake paired revolver hand seats while preserving authored world-space gun paths.

Run headlessly with Blender. This offline artifact is not applied until native
motion, material, and game-camera validation passes. No runtime hand solver.
"""
import sys
sys.dont_write_bytecode = True
import copy
import hashlib
import importlib.util
import json
import math
import struct
from pathlib import Path
from types import SimpleNamespace

import bmesh
import numpy as np
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'tools/art/characters'
OUTPUT = SOURCE / 'paired-grips'


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


g = module('longgun_grips', 'longgun-grips-authoring.py')
writer = module('paired_poses', 'paired-poses-authoring.py')
# Small authored changes from the original right-hand ready pose; thumb MCP
# opposition is retained. Values: MCP flex, PIP flex, DIP flex, MCP splay.
DELTAS = {
    'L': {'Middle': (10, -1, -6, 0), 'Ring': (1, -15, -7, -8),
          'Pinky': (0, -20, -12, 0), 'Index': (0, 30, -1, 40), 'Thumb': (-18, 0, -14, -9)},
    'R': {'Middle': (6, -18, 12, -18), 'Ring': (0, -20, 5, -7),
          'Pinky': (0, -20, -11, 0), 'Index': (0, 30, 0, 39), 'Thumb': (-18, 0, -13, -9)},
}


class NativeClips(g.Clips):
    """Match PlayCanvas AnimCache LINEAR interpolation and AnimBlend normalization."""

    def sample(self, clip, time):
        out = {}
        for (name, path), (times, values, interpolation) in self.tracks[clip].items():
            k = max(0, min(int(np.searchsorted(times, time, side='right')) - 1, len(times) - 1))
            value = values[k].copy()
            if k + 1 < len(times) and interpolation != 'STEP' and time > times[k]:
                alpha = (time - times[k]) / (times[k + 1] - times[k])
                after = values[k + 1]
                if path == 'rotation' and np.dot(value, after) < 0:
                    after = -after
                value = value * (1 - alpha) + after * alpha
            if path == 'rotation':
                value = value / np.linalg.norm(value)
            out.setdefault(name, {})[path] = [float(v) for v in value]
        return out


def finger_pose(sample, side):
    result = {}
    for digit, (a, b, c, spread) in DELTAS[side].items():
        for j, delta in enumerate((a, b, c), 1):
            q = sample[f'{digit}{j}R']['rotation']
            ref = Quaternion((q[3], q[0], q[1] * (-1 if side == 'L' else 1), q[2] * (-1 if side == 'L' else 1)))
            if j == 1:
                ref = ref @ Quaternion((0, 0, 1), math.radians(spread * (-1 if side == 'L' else 1)))
            result[f'{digit}{j}{side}'] = (ref @ Quaternion((1, 0, 0), math.radians(delta))).normalized()
    return result


def gun_child(gun, side):
    mount = gun.doc['nodes'][gun.names[f'mount.Wrist{side}.drawn']]
    return next(gun.doc['nodes'][i] for i in mount['children'] if 'mesh' in gun.doc['nodes'][i])


def surface(gun):
    primitive = gun.doc['meshes'][0]['primitives'][0]
    points = gun.accessor(primitive['attributes']['POSITION'])
    triangles = gun.accessor(primitive['indices'])[:, 0].reshape(-1, 3)
    bm = bmesh.new()
    verts = [bm.verts.new(p) for p in points]
    for tri in triangles:
        try:
            bm.faces.new([verts[int(i)] for i in tri])
        except ValueError:
            pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    tree = BVHTree.FromBMesh(bm)

    def signed(ps):
        values = []
        for point in ps:
            p = Vector(point)
            hit, normal, _, distance = tree.find_nearest(p, .3)
            values.append(.3 if hit is None else distance if (p - hit).dot(normal) >= 0 else -distance)
        return np.array(values)
    return bm, signed


class ContactArm(g.Authoring):
    """Keep draw/false-draw grips on the authored prop without stretching the arm."""

    def arm(self, clip, time):
        if clip not in ('Draw_Pair', 'Flinch_Pair'):
            return super().arm(clip, time)
        source_clips, source_gun, source_fingers = self.clips, self.gun_world, self.finger_rotations
        sample = source_clips.sample(clip, time)
        world = self.skeleton.world(sample)
        side = self.side
        mechanism = self.mechanisms.sample('Weapon_' + clip.replace('_Pair', '') + '_' + side, time)
        gun = world['Wrist' + side] @ g.trs(mechanism['mount.Wrist' + side + '.drawn']) @ self.old_child
        target = (gun @ self.new_child.inverted()).translation
        pivot = world['Shoulder' + side].translation
        clavicle = world['UpperArm' + side].translation - pivot
        axis = target - pivot
        reach = sum(self.lengths.values()) * world['Wrist' + side].to_scale()[0] - .0005
        if (target - world['UpperArm' + side].translation).length > reach:
            cosine = (axis.length_squared + clavicle.length_squared - reach * reach) / (2 * axis.length * clavicle.length)
            if cosine > 1:
                raise ValueError('Authored paired draw is outside clavicle and arm reach')
            angle = max(0, clavicle.angle(axis) - math.acos(max(-1, cosine)))
            if angle > math.radians(25):
                raise ValueError('Paired draw requires more than25degrees of clavicle movement')
            rotation = Quaternion(clavicle.cross(axis).normalized(), angle) @ world['Shoulder' + side].to_quaternion()
            local = (world['Chest'].to_quaternion().inverted() @ rotation).normalized()
            sample['Shoulder' + side]['rotation'] = g.xyzw(local)
            self.maximum_clavicle_swing = max(self.maximum_clavicle_swing, math.degrees(angle))
        self.clips = SimpleNamespace(sample=lambda _clip, _time: sample)
        self.gun_world = lambda _clip, _time, _world: gun
        self.finger_rotations = self.closed_pose
        try:
            return super().arm(clip, time)
        finally:
            self.clips, self.gun_world, self.finger_rotations = source_clips, source_gun, source_fingers


def authoring(player, actions, skeleton, skin, gun, signed, side):
    a = object.__new__(ContactArm)
    a.side, a.skeleton, a.skin, a.clips = side, skeleton, skin, actions
    sample = actions.sample('Idle_Gun_Pointing_Pair', 0)
    a.world0 = world = skeleton.world(sample)
    a.hand = hand = g.Hand(skeleton, skin, sample, side)
    wrist = world['Wrist' + side]
    old = g.trs(gun_child(gun, side))
    a.G0 = wrist @ old
    a.Gi0 = np.array(a.G0.inverted())
    a.gun = SimpleNamespace(signed=signed)
    a.scale = wrist.to_scale()[0]
    a.local_direction, a.local_normal = a.palm_frame(world)
    a.knuckle_local = wrist.inverted() @ world['Middle1' + side].translation * a.scale
    roots = np.isin(hand.dominant, [d + '1' + side for d in g.DIGITS[:4]]) & hand.palmar & (hand.bind[:, 1] < .015)
    a.contact = ((hand.dominant == 'Wrist' + side) & (hand.bind @ np.array(a.local_normal) > .005)) | roots
    a.relaxed = {d + str(j) + side: hand.rotation(d, j, 30) for d in g.DIGITS[:4] for j in (1, 2, 3)}
    right = g.Hand(skeleton, skin, sample, 'R')
    rw = world['WristR']
    rg = rw @ g.trs(gun_child(gun, 'R'))
    direction, normal = g.Authoring.palm_frame(SimpleNamespace(side='R', hand=right), world)
    direction = (rg.inverted().to_3x3() @ rw.to_3x3() @ direction).normalized()
    normal = (rg.inverted().to_3x3() @ rw.to_3x3() @ normal).normalized()
    mid = rg.inverted() @ world['Middle1R'].translation
    if side == 'L':
        direction.z *= -1
        normal.z *= -1
    up = Vector((0, 1, 0))
    up = (up - up.project(direction)).normalized()
    roll = math.degrees(math.atan2(direction.cross(up).dot(normal), up.dot(normal)))
    a.grip = {'knuckle': (mid.x, mid.y, -.025 if side == 'L' else .025),
              'hand': {'yaw': math.degrees(math.atan2(direction.z, direction.x)),
                       'pitch': math.degrees(math.asin(direction.y)), 'roll': roll}}
    placed = a.place(a.grip)
    if placed is None:
        raise ValueError('No bounded palm contact for ' + side)
    position, rotation, _ = placed
    target = a.wrist_world(position, rotation)
    new = target.inverted() @ a.G0
    a.wrist_local = a.G0.inverted() @ target.translation
    a.wrist_rotation = a.G0.to_3x3().normalized().inverted() @ target.to_3x3().normalized()
    a.lengths = {name: Vector({**skeleton.nodes[player.names[name + side]], **sample.get(name + side, {})}['translation']).length for name in ['LowerArm', 'Wrist']}
    def reach_safe_frame(clip, time, w):
        target = w['Wrist' + side] @ old @ new.inverted()
        shoulder = w['UpperArm' + side].translation
        axis = target.translation - shoulder
        reach = sum(a.lengths.values()) * w['Wrist' + side].to_scale()[0] - .0002
        if axis.length > reach:
            target.translation = shoulder + axis.normalized() * reach
        return target @ new
    a.gun_world = reach_safe_frame
    a.old_child, a.new_child = old, new
    a.mechanisms = NativeClips(g.Doc(SOURCE / 'gun-actions.pair.glb'))
    a.maximum_clavicle_swing = 0
    pose = finger_pose(sample, side)
    a.closed_pose = pose
    offsets = {bone: g.trs({'rotation': sample[bone]['rotation']}).to_quaternion().inverted() @ q for bone, q in pose.items()}
    return a, old, new, offsets


def pack(document, arrays, path):
    # The existing writer has one module-local output path; this offline run is serial.
    previous = writer.OUTPUT
    try:
        writer.OUTPUT = path
        writer.pack(document, arrays)
    finally:
        writer.OUTPUT = previous


def metadata(files):
    return [{'path': str(p.relative_to(ROOT)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(set(files))]


def bake_body(source, actions, authors, inputs):
    owned = {n + side for side in authors for n in ('Shoulder', 'UpperArm', 'LowerArm', 'Wrist')}
    owned.update(bone for _, _, _, offsets in authors.values() for bone in offsets)
    doc = {k: copy.deepcopy(source.doc[k]) for k in ('asset', 'nodes', 'scenes', 'scene') if k in source.doc}
    doc['asset']['generator'] = 'Blender offline paired revolver grips'
    arrays, clips, receipts = [], [], []
    for clip in source.doc['animations']:
        name = clip['name']
        duration = max(float(source.accessor(s['input'])[-1, 0]) for s in clip['samplers'])
        rate = 960 if name in ('Draw_Pair', 'Spin_Pair', 'Flinch_Pair') else 240
        times = sorted({float(t) for s in clip['samplers'] for t in source.accessor(s['input'])[:, 0]} |
                       {struct.unpack('<f', struct.pack('<f', i / rate))[0] for i in range(math.floor(duration * rate) + 1)})
        samples = {}
        for t in times:
            sample = actions.sample(name, t)
            rotations = {}
            for a, _, _, offsets in authors.values():
                a.finger_rotations = {bone: g.trs({'rotation': sample[bone]['rotation']}).to_quaternion() @ offset for bone, offset in offsets.items()}
                rotations.update(a.arm(name, t))
            samples[t] = rotations
        out = {'name': name, 'channels': [], 'samplers': []}
        for channel in clip['channels']:
            sampler = clip['samplers'][channel['sampler']]
            ts, values = source.accessor(sampler['input']).tolist(), source.accessor(sampler['output']).tolist()
            bone = source.doc['nodes'][channel['target']['node']]['name']
            changed = bone in owned and channel['target']['path'] == 'rotation'
            receipt = {'clip': name, 'bone': bone, 'path': channel['target']['path'],
                       'inputSHA256': writer.hash_values(ts), 'sourceOutputSHA256': writer.hash_values(values), 'permittedChange': changed}
            if changed:
                ts, values = [[t] for t in times], [g.xyzw(samples[t][bone].normalized()) for t in times]
                for i in range(1, len(values)):
                    if sum(a * b for a, b in zip(values[i - 1], values[i])) < 0:
                        values[i] = [-v for v in values[i]]
            receipt.update(outputInputSHA256=writer.hash_values(ts), outputSHA256=writer.hash_values(values))
            receipts.append(receipt)
            index = len(arrays)
            arrays.extend([(ts, 1), (values, len(values[0]))])
            out['channels'].append({'target': copy.deepcopy(channel['target']), 'sampler': len(out['samplers'])})
            out['samplers'].append({'input': index, 'output': index + 1, 'interpolation': sampler.get('interpolation', 'LINEAR')})
        clips.append(out)
        print('BAKED', name, len(times), flush=True)
    doc['animations'] = clips
    doc['extras'] = {'sourceInputs': inputs, 'changedBones': sorted(owned), 'preservationReceipt': receipts, 'maximumClavicleSwingDegrees': {side: a.maximum_clavicle_swing for side, (a, _, _, _) in authors.items()},
                     'gunFrames': {side: {'old': [list(row) for row in old], 'new': [list(row) for row in new]} for side, (_, old, new, _) in authors.items()}}
    pack(doc, arrays, OUTPUT / 'body.glb')


def bake_mechanisms(source, original, final, skeleton, authors, inputs):
    doc = {k: copy.deepcopy(source.doc[k]) for k in ('asset', 'nodes', 'scenes', 'scene') if k in source.doc}
    actions = NativeClips(source)
    arrays, clips = [], []
    frames = {side: (old, new) for side, (_, old, new, _) in authors.items()}
    for clip in source.doc['animations']:
        name = clip['name']
        _, action, side = name.split('_')
        body = {'Idle': 'Idle_Gun_Pointing', 'Shoot': 'Gun_Shoot'}.get(action, action) + '_Pair'
        duration = max(float(source.accessor(s['input'])[-1, 0]) for s in clip['samplers'])
        rate = 960 if action in ('Draw', 'Spin', 'Flinch') else 240
        times = sorted({float(t) for s in clip['samplers'] for t in source.accessor(s['input'])[:, 0]} |
                       {struct.unpack('<f', struct.pack('<f', i / rate))[0] for i in range(math.floor(duration * rate) + 1)})
        old, new = frames[side]
        mount = 'mount.Wrist' + side + '.drawn'
        values = {'translation': [], 'rotation': [], 'scale': []}
        for t in times:
            was = skeleton.world(original.sample(body, t))['Wrist' + side]
            now = skeleton.world(final.sample(body, t))['Wrist' + side]
            matrix = now.inverted() @ was @ g.trs(actions.sample(name, t)[mount]) @ old @ new.inverted()
            position, rotation, scale = matrix.decompose()
            q = g.xyzw(rotation.normalized())
            if values['rotation'] and sum(a * b for a, b in zip(values['rotation'][-1], q)) < 0:
                q = [-v for v in q]
            values['translation'].append(list(position))
            values['rotation'].append(q)
            values['scale'].append(list(scale))
        out = {'name': name, 'channels': [], 'samplers': []}
        for channel in clip['channels']:
            path = channel['target']['path']
            if source.doc['nodes'][channel['target']['node']]['name'] != mount:
                raise ValueError('Unexpected paired mechanism target')
            index = len(arrays)
            arrays.extend([([[t] for t in times], 1), (values[path], len(values[path][0]))])
            out['channels'].append({'target': copy.deepcopy(channel['target']), 'sampler': len(out['samplers'])})
            out['samplers'].append({'input': index, 'output': index + 1, 'interpolation': 'LINEAR'})
        clips.append(out)
    doc['animations'] = clips
    doc['extras'] = {'sourceInputs': inputs, 'gunFrames': {side: {'old': [list(row) for row in old], 'new': [list(row) for row in new]} for side, (old, new) in frames.items()}}
    pack(doc, arrays, OUTPUT / 'mechanisms.glb')


def main():
    player = g.Doc(SOURCE / 'player.gltf')
    source = g.Doc(SOURCE / 'paired-poses/left-arm.glb')
    gun = g.Doc(SOURCE / 'gun.hardins-pair.gltf')
    mechanisms = g.Doc(SOURCE / 'gun-actions.pair.glb')
    actions, skeleton, skin = NativeClips(source), g.Skeleton(player), g.Skin(player)
    bm, signed = surface(gun)
    try:
        authors = {side: authoring(player, actions, skeleton, skin, gun, signed, side) for side in ('L', 'R')}
        files = player.files + source.files + gun.files + mechanisms.files + [Path(__file__).resolve(), Path(g.__file__).resolve(), Path(writer.__file__).resolve()]
        bake_body(source, actions, authors, metadata(files))
        final = g.Doc(OUTPUT / 'body.glb')
        bake_mechanisms(mechanisms, actions, NativeClips(final), skeleton, authors,
                        metadata(files + mechanisms.files + final.files))
        print('PAIRED_GRIPS_COMPLETE', flush=True)
    finally:
        bm.free()


if __name__ == '__main__':
    main()
