"""Bake first-person arm curves from the native rifle and shotgun action library.

blender --background --factory-startup --python-exit-code 1 \
  --python tools/content/viewmodel-longguns-authoring.py -- \
  public/experiments/out-west/3d/native-v2/dynamic/viewmodel-arm-curves.glb
The first-person actor overlays these arm curves on its existing native tracks.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import math
import struct
import sys
from pathlib import Path

from mathutils import Matrix, Vector

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
MOVES = ROOT / "public/experiments/out-west/3d/native-v2/baked/moves.glb"
HELPER = ROOT / "tools/content/longgun-grips-authoring.py"
spec = importlib.util.spec_from_file_location("grip_authoring", HELPER)
grip = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grip)

ACTIONS = tuple(f"{stance}{motion}_{weapon}"
                for stance in ("", "Crouch_")
                for weapon in ("rifle", "shotgun")
                for motion in ("Hold", "Shoot"))
SIDES = ("L", "R")
SEAT = {"L": Vector((0, -.09, .055)), "R": Vector((0, -.125, .065))}
FULL_REACH_MARGIN = .0001
RECOIL_SAMPLES_PER_SECOND = 240


def action_times(clips, name):
    keys = clips.times(name)
    if "Shoot_" in name:
        keys = sorted(set(keys) | {
            step / RECOIL_SAMPLES_PER_SECOND
            for step in range(math.ceil(keys[-1] * RECOIL_SAMPLES_PER_SECOND))
        })
    return keys


def arm_points(world, side):
    return tuple(world[bone + side].translation for bone in ("UpperArm", "LowerArm", "Wrist"))


def seated_offsets(holds_and_shots):
    """Hold the shoulder offset fixed through the hold/recoil pair."""
    offsets = {}
    for side in SIDES:
        samples = [arm_points(world, side) for world in holds_and_shots]
        scale = 1
        for _ in range(12):
            offset = SEAT[side] * scale
            if all(abs((elbow - shoulder).length - (wrist - elbow).length) + FULL_REACH_MARGIN
                   < (wrist - shoulder - offset).length
                   < (elbow - shoulder).length + (wrist - elbow).length - FULL_REACH_MARGIN
                   for shoulder, elbow, wrist in samples):
                offsets[side] = offset
                break
            scale *= .8
        else:
            raise ValueError(f"No reachable first-person sleeve seat for arm {side}")
    return offsets


def arm_curves(world, side, offset):
    upper, lower, wrist = (bone + side for bone in ("UpperArm", "LowerArm", "Wrist"))
    shoulder = "Shoulder" + side
    start, joint, hand = arm_points(world, side)
    upper_direction, lower_direction = joint - start, hand - joint
    upper_length, lower_length = upper_direction.length, lower_direction.length
    seated = start + offset
    axis = hand - seated
    distance = axis.length
    axis.normalize()
    along = (upper_length ** 2 + distance ** 2 - lower_length ** 2) / (2 * distance)
    pole = (upper_direction - upper_direction.project(axis)).normalized()
    down = Vector((0, -1, 0))
    down = (down - down.project(axis)).normalized()
    swing_axis = pole.cross(down)
    if swing_axis.length_squared > 1e-9:
        pole = Matrix.Rotation(min(math.radians(85), pole.angle(down)), 3, swing_axis.normalized()) @ pole
    elbow = seated + axis * along + pole * math.sqrt(max(0, upper_length ** 2 - along ** 2))
    upper_base = world[upper].to_3x3().normalized()
    lower_base = world[lower].to_3x3().normalized()
    hand_frame = world[wrist].to_3x3().normalized()
    turn = grip.swing(upper_direction, elbow - seated)
    upper_fit = turn @ upper_base
    lower_fit = grip.swing(turn @ lower_direction, hand - elbow) @ turn @ lower_base
    return {
        (upper, "translation"): list(world[shoulder].inverted() @ seated),
        (upper, "rotation"): grip.xyzw(
            (world[shoulder].to_3x3().normalized().inverted() @ upper_fit).to_quaternion().normalized()),
        (lower, "rotation"): grip.xyzw((upper_fit.inverted() @ lower_fit).to_quaternion().normalized()),
        (wrist, "rotation"): grip.xyzw((lower_fit.inverted() @ hand_frame).to_quaternion().normalized()),
    }


def next_sample(world, sample, skeleton, offsets):
    channels = {key: value for side in SIDES for key, value in arm_curves(world, side, offsets[side]).items()}
    for (bone, path), value in channels.items():
        sample.setdefault(bone, {})[path] = value
    evaluated = skeleton.world(sample)
    drift = max((world["Wrist" + side].translation - evaluated["Wrist" + side].translation).length
                for side in SIDES)
    if drift > .0001:
        raise ValueError(f"First-person wrist target drifted {drift} m")
    return channels


def append_animation(doc, writer, name, keys, channels, node_indices):
    times = writer([[t] for t in keys], "SCALAR")
    animation = {"name": name, "channels": [], "samplers": []}
    for (bone, path), values in channels.items():
        if path == "rotation":
            for index in range(1, len(values)):
                if sum(a * b for a, b in zip(values[index - 1], values[index])) < 0:
                    values[index] = [-value for value in values[index]]
        accessor = writer(values, "VEC4" if path == "rotation" else "VEC3")
        animation["channels"].append({"sampler": len(animation["samplers"]),
                                      "target": {"node": node_indices[bone], "path": path}})
        animation["samplers"].append({"input": times, "output": accessor, "interpolation": "LINEAR"})
    doc["animations"].append(animation)


def author(output):
    source = grip.Doc(MOVES)
    clips, skeleton = grip.Clips(source), grip.Skeleton(source)
    keys = {name: action_times(clips, name) for name in ACTIONS}
    poses = {name: [clips.sample(name, time) for time in keys[name]] for name in ACTIONS}
    worlds = {name: [skeleton.world(sample) for sample in poses[name]] for name in ACTIONS}
    doc = {
        "asset": {"version": "2.0", "generator": "Out West offline first-person arm authoring"},
        "nodes": copy.deepcopy(source.doc["nodes"]),
        "scenes": copy.deepcopy(source.doc["scenes"]),
        "scene": source.doc.get("scene", 0),
        "animations": [], "accessors": [], "bufferViews": [],
        "extras": {"sourceInputs": [
            {"path": str(path.relative_to(ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            for path in (MOVES, HELPER)
        ]},
    }
    blob = bytearray()

    def write_accessor(values, kind):
        flat = [float(item) for row in values for item in row]
        data = struct.pack("<" + "f" * len(flat), *flat)
        view = len(doc["bufferViews"])
        doc["bufferViews"].append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)})
        blob.extend(data)
        accessor = {"bufferView": view, "componentType": 5126, "count": len(values), "type": kind}
        if kind == "SCALAR":
            accessor.update(min=[min(flat)], max=[max(flat)])
        doc["accessors"].append(accessor)
        return len(doc["accessors"]) - 1

    for name in ACTIONS:
        hold = name.replace("Shoot_", "Hold_")
        shoot = name.replace("Hold_", "Shoot_")
        offsets = seated_offsets(worlds[hold] + worlds[shoot])
        channels = {}
        for world, sample in zip(worlds[name], poses[name]):
            for key, value in next_sample(world, sample, skeleton, offsets).items():
                channels.setdefault(key, []).append(value)
        append_animation(doc, write_accessor, name, keys[name], channels, source.names)
    doc["buffers"] = [{"byteLength": len(blob)}]
    content = json.dumps(doc, separators=(",", ":")).encode()
    content += b" " * (-len(content) % 4)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(struct.pack("<IIIII", 0x46546C67, 2, 28 + len(content) + len(blob),
                                 len(content), 0x4E4F534A) + content
                       + struct.pack("<II", len(blob), 0x004E4942) + blob)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    author(parser.parse_args(sys.argv[sys.argv.index("--") + 1:]).output)
