"""Bake the campaign victory hat tip from canonical Idle, using Blender offline math.

Blender --background --factory-startup --python tools/content/tip-hat-authoring.py
The original gesture's 1.5 s envelope, wrist target and nod are retained. Every
lower-body transform stays at Idle(0), and both endpoints return to that pose.
The output is portable native glTF animation; no runtime IK is introduced.
"""
import copy
import hashlib
import importlib.util
import math
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector

HELPER = Path(__file__).with_name('paired-poses-authoring.py')
spec = importlib.util.spec_from_file_location('pose_helpers', HELPER)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'tools/art/characters/player.gltf'
SKELETON = ROOT / 'tools/art/characters/moves.gltf'
OUTPUT = ROOT / 'tools/art/characters/gestures/tip-hat.glb'
DURATION = 1.5
RATE = 60
CHANGED = ['Head', 'Chest', 'UpperArmR', 'LowerArmR', 'WristR']


def worlds(local, parents):
    result = {}
    def at(i):
        if i not in result:
            result[i] = at(parents[i]) @ local[i] if i in parents else local[i].copy()
        return result[i]
    for i in range(len(local)):
        at(i)
    return result


def set_world_rotation(local, poses, name, rotation):
    i = poses.ids[name]
    world = worlds(local, poses.parents)
    parent = world[poses.parents[i]].to_quaternion()
    location, _, scale = local[i].decompose()
    local[i] = helper.Matrix.LocRotScale(location, parent.inverted() @ rotation, scale)


def turn(local, poses, name, axis, angle):
    world = worlds(local, poses.parents)
    q = world[poses.ids[name]].to_quaternion()
    set_world_rotation(local, poses, name, Quaternion(axis, angle) @ q)


def solve(local, poses, goal, pole):
    world = worlds(local, poses.parents)
    upper, lower, wrist = [poses.ids[name] for name in ['UpperArmR', 'LowerArmR', 'WristR']]
    shoulder, elbow, hand = [world[i].translation for i in [upper, lower, wrist]]
    wrist_rotation = world[wrist].to_quaternion()
    a, b = (elbow - shoulder).length, (hand - elbow).length
    axis = (goal - shoulder).normalized()
    distance = min(a + b - 0.0001, max(abs(a - b) + 0.0001, (goal - shoulder).length))
    guide = pole - shoulder
    guide -= axis * guide.dot(axis)
    guide.normalize()
    cosine = min(1, max(-1, (a * a + distance * distance - b * b) / (2 * a * distance)))
    desired_elbow = shoulder + axis * (a * cosine) + guide * (a * math.sqrt(1 - cosine * cosine))
    swing = (elbow - shoulder).normalized().rotation_difference((desired_elbow - shoulder).normalized())
    set_world_rotation(local, poses, 'UpperArmR', swing @ world[upper].to_quaternion())
    world = worlds(local, poses.parents)
    elbow, hand = world[lower].translation, world[wrist].translation
    reachable = shoulder + axis * distance
    swing = (hand - elbow).normalized().rotation_difference((reachable - elbow).normalized())
    set_world_rotation(local, poses, 'LowerArmR', swing @ world[lower].to_quaternion())
    set_world_rotation(local, poses, 'WristR', wrist_rotation)
    return (worlds(local, poses.parents)[wrist].translation - goal).length


def pose_at(poses, rest, time):
    local = [m.copy() for m in rest]
    u = time / DURATION
    envelope = min(helper.smooth(u / 0.32), helper.smooth((1 - u) / 0.36))
    nod = math.sin(math.pi * min(1, max(0, (u - 0.25) / 0.5)))
    pitch = Vector((-1, 0, 0))
    turn(local, poses, 'Chest', pitch, -0.06 * nod)
    turn(local, poses, 'Head', pitch, -0.3 * nod)
    world = worlds(local, poses.parents)
    brim = world[poses.ids['Head']].translation + Vector((-0.07, 0.17, 0.15))
    goal = world[poses.ids['WristR']].translation.lerp(brim, envelope)
    error = 0
    if envelope > 0.000001:
        pole = world[poses.ids['UpperArmR']].translation + Vector((-0.5, -0.35, 0))
        error = solve(local, poses, goal, pole)
    return local, error


def main():
    source, skeleton = helper.common.Source(SOURCE), helper.common.Source(SKELETON)
    poses = helper.Poses(source, skeleton.doc)
    rest, initial = poses.evaluate('Idle', 0)
    times = [i / RATE for i in range(round(DURATION * RATE) + 1)]
    samples = [pose_at(poses, rest, time) for time in times]
    max_error = max(error for _, error in samples)
    if max_error > 0.001:
        raise ValueError(f'Hat tip wrist target is unreachable: {max_error}m')
    foot_error = max((worlds(local, poses.parents)[poses.ids[foot]].translation - initial[poses.ids[foot]].translation).length for local, _ in samples for foot in ['FootL', 'FootR'])
    if foot_error > 0.000001:
        raise ValueError(f'Hat tip moved the planted feet: {foot_error}m')
    nodes = [{k: copy.deepcopy(v) for k, v in node.items() if k in ('name', 'children', 'translation', 'rotation', 'scale', 'matrix')} for node in skeleton.doc['nodes']]
    clip = {'name': 'TipHat', 'channels': [], 'samplers': []}
    arrays = [([[t] for t in times], 1)]
    for i, node in enumerate(nodes):
        if 'name' not in node or node['name'] == 'Armature':
            continue
        decomposed = [local[i].decompose() for local, _ in samples]
        for path, component, width in [('translation', 0, 3), ('rotation', 1, 4), ('scale', 2, 3)]:
            values = []
            previous = None
            for trs in decomposed:
                value = trs[component] if path == 'rotation' and node['name'] in CHANGED else rest[i].decompose()[component]
                if path == 'rotation':
                    value = value.normalized()
                    if previous is not None and previous.dot(value) < 0:
                        value.negate()
                    previous = value.copy()
                    value = [value.x, value.y, value.z, value.w]
                else:
                    value = list(value)
                values.append(value)
            clip['channels'].append({'target': {'node': i, 'path': path}, 'sampler': len(clip['samplers'])})
            clip['samplers'].append({'input': 0, 'output': len(arrays), 'interpolation': 'LINEAR'})
            arrays.append((values, width))
    inputs = [SOURCE, SOURCE.with_suffix('.bin'), SKELETON, SKELETON.with_suffix('.bin'), Path(__file__), HELPER, HELPER.with_name('coat-sleeves-authoring.py')]
    output = {
        'asset': {'version': '2.0', 'generator': f'Blender {bpy.app.version_string} offline victory gesture'},
        'nodes': nodes, 'scenes': copy.deepcopy(skeleton.doc['scenes']), 'scene': skeleton.doc.get('scene', 0), 'animations': [clip],
        'extras': {
            'sourceInputs': [{'path': str(p.relative_to(ROOT)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in inputs],
            'authoring': 'Canonical Idle(0), offline two-bone wrist reach, original victory envelope; no runtime posing',
            'changedBones': CHANGED, 'durationSeconds': DURATION, 'sampleRateHz': RATE,
            'maximumWristTargetErrorMeters': max_error, 'maximumFootMotionMeters': foot_error,
        },
    }
    helper.OUTPUT = OUTPUT
    helper.pack(output, arrays)
    print('TIP_HAT', {'path': str(OUTPUT), 'samples': len(samples), 'wristError': max_error, 'footMotion': foot_error})


if __name__ == '__main__':
    main()
