"""Bake a seated idle for the native horse and human skeletons.

Run Blender in the background with --python tools/content/mounted-rider-authoring.py.
Pass an output path after -- to stage the portable clip away from the repository.
The horse is stationary and the rider rests at the saddle horn, clear of the long
unloaded stirrups. Both animations start at the same time on the same origin.
"""
import copy
import hashlib
import importlib.util
import math
import sys
from pathlib import Path
from types import SimpleNamespace

sys.dont_write_bytecode = True
import bpy
from mathutils import Matrix, Quaternion, Vector

HELPER = Path(__file__).with_name("tip-hat-authoring.py")
spec = importlib.util.spec_from_file_location("mounted_gesture", HELPER)
gesture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gesture)

ROOT = gesture.ROOT
ART = ROOT / "tools/art/characters"
HORSE = ART / "horse.gltf"
RATE = 30
AXIS_X = Vector((1, 0, 0))
AXIS_Z = Vector((0, 0, 1))
LIMB_KEYS = ("UpperArmR", "LowerArmR", "WristR")
SOURCE = gesture.helper.common.Source


def place_joint(local, rig, name, position):
    index = rig.ids[name]
    parent = gesture.worlds(local, rig.parents)[rig.parents[index]]
    local[index].translation = parent.inverted() @ Vector(position)


def solve_limb(local, rig, names, goal, pole):
    indices = {key: rig.ids[name] for key, name in zip(LIMB_KEYS, names)}
    # The same fixed-length two-bone solve supports a leg or an arm.
    return gesture.solve(local, SimpleNamespace(ids=indices, parents=rig.parents), Vector(goal), Vector(pole))


def rider_pose(rig, rest, phase):
    local = [matrix.copy() for matrix in rest]
    place_joint(local, rig, "Hips", (0, 1.713, 0.165))
    breath = math.sin(math.tau * phase)
    for name, pitch in (("Hips", -0.11), ("Abdomen", 0.11), ("Torso", 0.16), ("Chest", 0.08 + 0.014 * breath)):
        gesture.turn(local, rig, name, AXIS_X, pitch)
    gesture.turn(local, rig, "Head", AXIS_X, -0.08 + 0.04 * breath)
    gesture.turn(local, rig, "Head", AXIS_Z, 0.024 * breath)

    rest_world = gesture.worlds(rest, rig.parents)
    errors = []
    for side, sign in (("L", 1), ("R", -1)):
        foot_names = [part + side for part in ("UpperLeg", "LowerLeg", "Foot")]
        errors.append(solve_limb(local, rig, foot_names, (sign * 0.39, 0.955, 0.15), (sign * 0.64, 1.25, 0.82)))
        foot = rest_world[rig.ids["Foot" + side]].to_quaternion()
        gesture.set_world_rotation(local, rig, "Foot" + side, Quaternion(AXIS_X, 0.22) @ foot)

        arm_names = [part + side for part in ("UpperArm", "LowerArm", "Wrist")]
        height = 1.816 if side == "L" else 1.844
        errors.append(solve_limb(local, rig, arm_names, (sign * 0.05, height, 0.375), (sign * 0.36, 2.04, -0.025)))
        palm, fingers = Vector((0, -sign, 0)), Vector((0, 0, 1))
        downturned = Matrix((palm, fingers, palm.cross(fingers))).transposed().to_quaternion()
        gesture.set_world_rotation(local, rig, "Wrist" + side, downturned)
    return local, max(errors)


def sample(rig, horse, rest):
    body = horse.ids["Body"]
    root = rig.ids["Root"]
    bind = [gesture.helper.transform(node) for node in horse.nodes]
    inverse = gesture.worlds(bind, horse.parents)[body].inverted()
    duration = max(track[2][-1] for track in horse.samples["Idle"])
    steps = round(duration * RATE)
    times = [duration * i / steps for i in range(steps + 1)]
    frames = []
    worst_error = 0
    for time in times:
        local, error = rider_pose(rig, rest, time / duration)
        worst_error = max(worst_error, error)
        _, mount = horse.evaluate("Idle", time)
        local[root] = mount[body] @ inverse @ local[root]
        frames.append(local)
    if worst_error > 0.001:
        raise ValueError(f"Mounted pose has an unreachable wrist or ankle: {worst_error} m")
    loop_error = max(
        abs(a[row][column] - b[row][column])
        for a, b in zip(frames[0], frames[-1])
        for row in range(4)
        for column in range(4)
    )
    if loop_error > 0.001:
        raise ValueError(f"Mounted idle does not close: {loop_error}")
    return times, frames, worst_error, loop_error


def channel_values(frames, index, component):
    previous = None
    rows = []
    for frame in frames:
        value = frame[index].decompose()[component]
        if component == 1:
            value.normalize()
            if previous is not None and previous.dot(value) < 0:
                value.negate()
            previous = value.copy()
            value = (value.x, value.y, value.z, value.w)
        rows.append(list(value))
    return rows


def portable_animation(nodes, times, frames):
    clip = {"name": "Mounted_Idle", "channels": [], "samplers": [], "extras": {"mountClip": "Idle"}}
    arrays = [([[time] for time in times], 1), ([[0], [times[-1]]], 1)]
    for index, node in enumerate(nodes):
        if not node.get("name") or node["name"] == "Armature":
            continue
        for component, path in enumerate(("translation", "rotation", "scale")):
            values = channel_values(frames, index, component)
            constant = all(
                abs(a - b) < 1e-6 for value in values for a, b in zip(value, values[0])
            )
            clip["channels"].append({"target": {"node": index, "path": path}, "sampler": len(clip["samplers"])})
            clip["samplers"].append({"input": int(constant), "output": len(arrays), "interpolation": "LINEAR"})
            arrays.append((values[:1] * 2 if constant else values, len(values[0])))
    return clip, arrays


def main():
    skeleton = SOURCE(gesture.SKELETON)
    rider = gesture.helper.Poses(SOURCE(gesture.SOURCE), skeleton.doc)
    horse_source = SOURCE(HORSE)
    horse = gesture.helper.Poses(horse_source, horse_source.doc)
    rest, _ = rider.evaluate("Idle_Neutral", 0)
    times, frames, contact_error, loop_error = sample(rider, horse, rest)
    keys = {"name", "children", "translation", "rotation", "scale", "matrix"}
    nodes = [{key: copy.deepcopy(value) for key, value in node.items() if key in keys} for node in rider.nodes]
    clip, arrays = portable_animation(nodes, times, frames)
    inputs = [Path(__file__).resolve(), HELPER, gesture.HELPER, gesture.HELPER.with_name("coat-sleeves-authoring.py")]
    inputs.append(ART / "horse-parts.glb")
    for source in (gesture.SOURCE, gesture.SKELETON, HORSE):
        inputs.extend((source, source.with_suffix(".bin")))
    document = {
        "asset": {"version": "2.0", "generator": f"Blender {bpy.app.version_string} mounted rider"},
        "nodes": nodes,
        "scenes": copy.deepcopy(skeleton.doc["scenes"]),
        "scene": skeleton.doc.get("scene", 0),
        "animations": [clip],
        "extras": {
            "sourceInputs": [
                {"path": str(path.relative_to(ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                for path in inputs
            ],
            "sampleRateHz": RATE,
            "durationSeconds": times[-1],
            "maximumJointTargetErrorMeters": contact_error,
            "maximumLoopMatrixError": loop_error,
        },
    }
    gesture.helper.OUTPUT = Path(sys.argv[sys.argv.index("--") + 1]) if "--" in sys.argv else ART / "gestures/mounted-idle.glb"
    gesture.helper.pack(document, arrays)
    print(f"{len(times)} poses, {contact_error:.6f} m target error, {loop_error:.6f} loop error")


if __name__ == "__main__":
    main()
