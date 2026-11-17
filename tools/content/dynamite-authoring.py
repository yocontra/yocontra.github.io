"""Bake the dynamite toss on the canonical rig; no runtime IK or bone offsets.

Blender --background --factory-startup --python tools/content/dynamite-authoring.py
The visual stick leaves the right hand at 0.2 s. Authority starts its fuse on
acceptance, independently of this presentation. Both endpoints retain gun-ready.
"""
import copy
import hashlib
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

sys.dont_write_bytecode = True
import bpy
from mathutils import Vector

HELPER = Path(__file__).with_name('tip-hat-authoring.py')
spec = importlib.util.spec_from_file_location('gesture', HELPER)
gesture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gesture)
helper = gesture.helper
ROOT = gesture.ROOT
SOURCE = gesture.SOURCE
SKELETON = gesture.SKELETON
OUTPUT = ROOT / 'tools/art/characters/gestures/dynamite.glb'
DURATION = 0.7
RELEASE = 0.2
RATE = 60
CHANGED = ['Chest', 'UpperArmR', 'LowerArmR', 'WristR', 'UpperArmL', 'LowerArmL', 'WristL']


def pose_at(poses, rest, time):
    local = [matrix.copy() for matrix in rest]
    world = gesture.worlds(rest, poses.parents)
    shoulder = world[poses.ids['UpperArmR']].translation
    hand = world[poses.ids['WristR']].translation
    # Character forward is +Z. Keep the overarm wind-up outside the head.
    keys = [
        (0, hand),
        (0.12, shoulder + Vector((-0.12, 0.23, -0.16))),
        (RELEASE, shoulder + Vector((0.10, 0.10, 0.39))),
        (0.32, shoulder + Vector((0.03, -0.23, 0.31))),
        (DURATION, hand),
    ]
    start, end = next((a, b) for a, b in zip(keys, keys[1:]) if time <= b[0] + 1e-8)
    blend = helper.smooth((time - start[0]) / (end[0] - start[0]))
    goal = start[1].lerp(end[1], blend)
    envelope = min(helper.smooth(time / 0.12), helper.smooth((DURATION - time) / 0.38))
    gesture.turn(local, poses, 'Chest', Vector((0, 1, 0)), -0.10 * envelope)
    pole = shoulder + Vector((-0.55, 0.05, -0.10))
    error = gesture.solve(local, poses, goal, pole) if 0 < time < DURATION else 0
    # Lower the supporting arm while the right arm throws; do not leave an empty
    # two-handed gun grip pointing in front of the rider.
    if 0 < time < DURATION:
        left = SimpleNamespace(ids={**poses.ids, **{name + 'R': poses.ids[name + 'L'] for name in ['UpperArm', 'LowerArm', 'Wrist']}}, parents=poses.parents)
        shoulder_left = world[poses.ids['UpperArmL']].translation
        hand_left = world[poses.ids['WristL']].translation
        goal_left = hand_left.lerp(shoulder_left + Vector((0.10, -0.39, 0.10)), envelope)
        error = max(error, gesture.solve(local, left, goal_left, shoulder_left + Vector((0.45, -0.2, -0.15))))
    return local, error


def main():
    source, skeleton = helper.common.Source(SOURCE), helper.common.Source(SKELETON)
    poses = helper.Poses(source, skeleton.doc)
    rest, initial = poses.evaluate('Idle_Gun_Pointing', 0)
    times = [i / RATE for i in range(round(DURATION * RATE) + 1)]
    samples = [pose_at(poses, rest, time) for time in times]
    error = max(error for _, error in samples)
    if error > 0.001:
        raise ValueError(f'Unreachable dynamite wrist path: {error}m')
    foot_error = max((gesture.worlds(local, poses.parents)[poses.ids[foot]].translation - initial[poses.ids[foot]].translation).length for local, _ in samples for foot in ['FootL', 'FootR'])
    if foot_error > 1e-6:
        raise ValueError(f'Dynamite moved the feet: {foot_error}m')
    nodes = [{k: copy.deepcopy(v) for k, v in node.items() if k in ('name', 'children', 'translation', 'rotation', 'scale', 'matrix')} for node in skeleton.doc['nodes']]
    clip = {'name': 'Throw_Dynamite', 'channels': [], 'samplers': [], 'extras': {'releaseSeconds': RELEASE}}
    arrays = [([[time] for time in times], 1)]
    for index, node in enumerate(nodes):
        if 'name' not in node or node['name'] == 'Armature':
            continue
        for path, component, width in [('translation', 0, 3), ('rotation', 1, 4), ('scale', 2, 3)]:
            values, previous = [], None
            for local, _ in samples:
                value = local[index].decompose()[component] if path == 'rotation' and node['name'] in CHANGED else rest[index].decompose()[component]
                if path == 'rotation':
                    value = value.normalized()
                    if previous is not None and previous.dot(value) < 0:
                        value.negate()
                    previous = value.copy()
                    value = [value.x, value.y, value.z, value.w]
                else:
                    value = list(value)
                values.append(value)
            clip['channels'].append({'target': {'node': index, 'path': path}, 'sampler': len(clip['samplers'])})
            clip['samplers'].append({'input': 0, 'output': len(arrays), 'interpolation': 'LINEAR'})
            arrays.append((values, width))
    inputs = [SOURCE, SOURCE.with_suffix('.bin'), SKELETON, SKELETON.with_suffix('.bin'), Path(__file__), HELPER, gesture.HELPER, gesture.HELPER.with_name('coat-sleeves-authoring.py')]
    output = {
        'asset': {'version': '2.0', 'generator': f'Blender {bpy.app.version_string} offline dynamite toss'},
        'nodes': nodes, 'scenes': copy.deepcopy(skeleton.doc['scenes']), 'scene': skeleton.doc.get('scene', 0), 'animations': [clip],
        'extras': {
            'sourceInputs': [{'path': str(path.relative_to(ROOT)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in inputs],
            'changedBones': CHANGED, 'durationSeconds': DURATION, 'releaseSeconds': RELEASE,
            'sampleRateHz': RATE, 'maximumWristTargetErrorMeters': error, 'maximumFootMotionMeters': foot_error,
        },
    }
    helper.OUTPUT = OUTPUT
    helper.pack(output, arrays)
    print('DYNAMITE', {'samples': len(samples), 'wristError': error, 'footMotion': foot_error})


if __name__ == '__main__':
    main()
