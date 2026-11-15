"""Bake first-person long-gun elbow poses, retaining every authored wrist/finger/gun frame.

Blender --background --factory-startup --python tools/content/first-person-poses-authoring.py
Only the isolated viewmodel derivatives consume these overrides. World-body clips
remain unchanged; native skeletal animation plays the baked result without IK.
"""
import copy
import hashlib
import importlib.util
import math
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
HELPER = Path(__file__).with_name('paired-poses-authoring.py')
spec = importlib.util.spec_from_file_location('pose_helpers', HELPER)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
SOURCE = ROOT / 'public/experiments/out-west/3d/native-v2/baked/moves.glb'
OUTPUT = ROOT / 'tools/art/characters/first-person-poses.glb'
CHANGED = [bone + side for side in ['L', 'R'] for bone in ['UpperArm', 'LowerArm', 'Wrist']]
CLIPS = [stance + action + kind for stance in ['', 'Crouch_'] for action in ['Hold_', 'Shoot_'] for kind in ['rifle', 'shotgun']]


def worlds(local, parents):
    result = {}
    def at(i):
        if i not in result:
            result[i] = at(parents[i]) @ local[i] if i in parents else local[i].copy()
        return result[i]
    for i in range(len(local)):
        at(i)
    return result


def set_rotation(local, poses, name, q):
    i = poses.ids[name]
    parent = worlds(local, poses.parents)[poses.parents[i]].to_quaternion().normalized()
    location, _, scale = local[i].decompose()
    local[i] = Matrix.LocRotScale(location, parent.inverted() @ q, scale)


def solve(local, poses, side):
    names = ['UpperArm' + side, 'LowerArm' + side, 'Wrist' + side]
    ids = [poses.ids[name] for name in names]
    world = worlds(local, poses.parents)
    shoulder, elbow, hand = [world[i].translation.copy() for i in ids]
    wrist_rotation = world[ids[2]].to_quaternion().normalized()
    a, b = (elbow - shoulder).length, (hand - elbow).length
    axis = (hand - shoulder).normalized()
    distance = (hand - shoulder).length
    if not abs(a - b) + 1e-6 < distance < a + b - 1e-6:
        raise ValueError(f'Unreachable canonical {side} wrist')
    # Tuck the elbow below its shoulder, slightly outboard. The hand stays on its exact grip.
    pole = Vector((0.12 if side == 'L' else -0.12, -1, 0))
    guide = (pole - axis * pole.dot(axis)).normalized()
    cosine = min(1, max(-1, (a * a + distance * distance - b * b) / (2 * a * distance)))
    desired = shoulder + axis * (a * cosine) + guide * (a * math.sqrt(1 - cosine * cosine))
    swing = (elbow - shoulder).normalized().rotation_difference((desired - shoulder).normalized())
    set_rotation(local, poses, names[0], swing @ world[ids[0]].to_quaternion().normalized())
    world = worlds(local, poses.parents)
    elbow, moved = world[ids[1]].translation, world[ids[2]].translation
    swing = (moved - elbow).normalized().rotation_difference((hand - elbow).normalized())
    set_rotation(local, poses, names[1], swing @ world[ids[1]].to_quaternion().normalized())
    set_rotation(local, poses, names[2], wrist_rotation)
    final = worlds(local, poses.parents)
    return (final[ids[2]].translation - hand).length


def main():
    source = helper.read_glb(SOURCE)
    poses = helper.Poses(source, source.doc)
    output = {'asset': {'version': '2.0', 'generator': f'Blender {bpy.app.version_string} offline viewmodel elbows'}, 'nodes': [{k: copy.deepcopy(v) for k, v in n.items() if k in ('name', 'children', 'translation', 'rotation', 'scale', 'matrix')} for n in source.doc['nodes']], 'scenes': copy.deepcopy(source.doc['scenes']), 'scene': source.doc.get('scene', 0), 'animations': []}
    arrays, reports = [], []
    for clip in source.doc['animations']:
        name = clip['name']
        if name not in CLIPS:
            continue
        keys = sorted({t for _, _, ts, _, _ in poses.samples[name] for t in ts})
        duration = keys[-1]
        times = sorted(set(keys + [i / 120 for i in range(math.floor(duration * 120) + 1)]))
        solved, max_error = {}, 0
        for time in times:
            local, _ = poses.evaluate(name, time)
            max_error = max(max_error, solve(local, poses, 'L'), solve(local, poses, 'R'))
            solved[time] = {bone: local[poses.ids[bone]].to_quaternion().normalized() for bone in CHANGED}
        if max_error > 0.0001:
            raise ValueError(f'{name} shifted the hand grip: {max_error}m')
        new = {'name': name, 'channels': [], 'samplers': [], 'extras': {'firstPersonPose': True}}
        for channel in clip['channels']:
            sampler = clip['samplers'][channel['sampler']]
            inputs, values = source.accessor(sampler['input']), source.accessor(sampler['output'])
            bone = source.doc['nodes'][channel['target']['node']].get('name')
            if bone in CHANGED and channel['target']['path'] == 'rotation':
                inputs, values, previous = [[t] for t in times], [], None
                for time in times:
                    q = solved[time][bone].copy()
                    if previous is not None and previous.dot(q) < 0:
                        q.negate()
                    previous = q.copy()
                    values.append([q.x, q.y, q.z, q.w])
            index = len(arrays)
            arrays.extend([(inputs, 1), (values, len(values[0]))])
            new['channels'].append({'target': copy.deepcopy(channel['target']), 'sampler': len(new['samplers'])})
            new['samplers'].append({'input': index, 'output': index + 1, 'interpolation': 'LINEAR'})
        output['animations'].append(new)
        reports.append({'clip': name, 'duration': duration, 'sampleCount': len(times), 'wristErrorMeters': max_error})
    if len(output['animations']) != len(CLIPS):
        raise ValueError('Missing source long-gun/crouch clip')
    inputs = [SOURCE, Path(__file__), HELPER, HELPER.with_name('coat-sleeves-authoring.py')]
    output['extras'] = {'sourceInputs': [{'path': str(p.relative_to(ROOT)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in inputs], 'changedBones': CHANGED, 'report': reports, 'authoring': 'Offline first-person elbow tuck; original wrist frames, fingers, gun/body tracks and full shot timing preserved'}
    helper.OUTPUT = OUTPUT
    helper.pack(output, arrays)
    # Validate the actual exported interpolation between every 120 Hz sample.
    baked = helper.Poses(helper.read_glb(OUTPUT), source.doc)
    for report in reports:
        name, duration = report['clip'], report['duration']
        maximum_position, maximum_angle = 0, 0
        for i in range(math.ceil(duration * 240) + 1):
            time = min(duration, i / 240)
            _, before = poses.evaluate(name, time)
            _, after = baked.evaluate(name, time)
            for side in ['L', 'R']:
                idx = poses.ids['Wrist' + side]
                maximum_position = max(maximum_position, (before[idx].translation - after[idx].translation).length)
                qa, qb = before[idx].to_quaternion().normalized(), after[idx].to_quaternion().normalized()
                maximum_angle = max(maximum_angle, math.degrees(2 * math.acos(min(1, abs(qa.dot(qb))))))
        report['interpolatedWristErrorMeters'] = maximum_position
        report['interpolatedWristAngleDegrees'] = maximum_angle
        if maximum_position > 0.0005 or maximum_angle > 0.1:
            raise ValueError(f'Interpolated hand contact drift: {report}')
        print('FP_POSE', report)
    helper.pack(output, arrays)


if __name__ == '__main__':
    main()
