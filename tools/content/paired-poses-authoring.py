"""Bake bounded paired left-arm corrections using Blender's native IK solver.

Blender --background --factory-startup --python tools/content/paired-poses-authoring.py
Only inward, nearly overlapping hands are corrected. Existing holstered,
Flinch and natural Spin poses remain authored; no runtime IK is required.
"""

import copy
import hashlib
import importlib.util
import json
import math
import struct
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector

spec = importlib.util.spec_from_file_location("garments", Path(__file__).with_name("coat-sleeves-authoring.py"))
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
ROOT = common.ROOT
BASE = ROOT / "tools/art/characters/moves.gltf"
PAIR = ROOT / "tools/art/characters/character-pair-actions.glb"
OUTPUT = ROOT / "tools/art/characters/paired-poses/left-arm.glb"
CHANGED = ["UpperArmL", "LowerArmL", "WristL"]
CLIPS = ["Draw_Pair", "Idle_Gun_Pointing_Pair", "Gun_Shoot_Pair", "Spin_Pair", "Flinch_Pair"]


def read_glb(path):
    raw = path.read_bytes()
    size = struct.unpack_from("<I", raw, 12)[0]
    reader = object.__new__(common.Source)
    reader.doc = json.loads(raw[20:20 + size])
    reader.buffers = [raw[28 + size:]]
    return reader


def transform(node):
    q = node.get("rotation", [0, 0, 0, 1])
    return Matrix.LocRotScale(Vector(node.get("translation", [0, 0, 0])), Quaternion((q[3], *q[:3])), Vector(node.get("scale", [1, 1, 1])))


class Poses:
    def __init__(self, reader, skeleton):
        self.reader = reader
        self.nodes = skeleton["nodes"]
        self.ids = {node.get("name"): i for i, node in enumerate(self.nodes)}
        self.parents = {child: i for i, node in enumerate(self.nodes) for child in node.get("children", [])}
        self.samples = {}
        for clip in reader.doc["animations"]:
            tracks = []
            for channel in clip["channels"]:
                name = reader.doc["nodes"][channel["target"]["node"]].get("name")
                sampler = clip["samplers"][channel["sampler"]]
                if sampler.get("interpolation", "LINEAR") not in ("LINEAR", "STEP"):
                    raise ValueError("Pair authoring expects finite linear/step source tracks")
                tracks.append((name, channel["target"]["path"], [v[0] for v in reader.accessor(sampler["input"])], reader.accessor(sampler["output"]), sampler.get("interpolation", "LINEAR")))
            self.samples[clip["name"]] = tracks

    def evaluate(self, clip, time):
        nodes = [dict(node) for node in self.nodes]
        for name, path, times, values, interpolation in self.samples[clip]:
            index = self.ids.get(name)
            if index is None:
                continue
            k = max([i for i, t in enumerate(times) if t <= time] + [0])
            value = values[k]
            if k + 1 < len(times) and interpolation != "STEP":
                alpha = (time - times[k]) / (times[k + 1] - times[k])
                nxt = values[k + 1]
                if path == "rotation":
                    q = Quaternion((value[3], *value[:3])).slerp(Quaternion((nxt[3], *nxt[:3])), alpha)
                    value = [q.x, q.y, q.z, q.w]
                else:
                    value = [a + (b - a) * alpha for a, b in zip(value, nxt)]
            nodes[index][path] = value
        local = [transform(node) for node in nodes]
        world = {}

        def at(index):
            if index not in world:
                world[index] = at(self.parents[index]) @ local[index] if index in self.parents else local[index]
            return world[index]

        for i in range(len(nodes)):
            at(i)
        return local, world


def smooth(value):
    value = min(1, max(0, value))
    return value * value * (3 - 2 * value)


def intent(poses, world):
    ids = poses.ids
    frame = world[ids["Root"]]
    inverse = frame.inverted()
    right = inverse @ world[ids["WristR"]].translation
    left = inverse @ world[ids["WristL"]].translation
    mirrored = right.copy()
    mirrored.x *= -1
    # Full correction for the confirmed crossed ready/fire stance. Two smooth
    # spatial ramps protect already-separated holstered/flinch/spin movement.
    amount = smooth((0.20 - left.x) / 0.20) * smooth((0.45 - (left - right).length) / 0.20)
    goal = frame @ left.lerp(mirrored, amount)
    elbow = world[ids["LowerArmL"]].translation
    right_elbow = inverse @ world[ids["LowerArmR"]].translation
    right_elbow.x *= -1
    pole = elbow.lerp(frame @ right_elbow, amount)
    return amount, goal, pole


class NativeArm:
    def __init__(self, poses):
        local, world = poses.evaluate("Idle_Gun_Pointing_Pair", 0)
        armature = bpy.data.armatures.new("Offline paired left arm")
        self.object = bpy.data.objects.new("Offline paired left arm", armature)
        bpy.context.collection.objects.link(self.object)
        bpy.context.view_layer.objects.active = self.object
        self.object.select_set(True)
        bpy.ops.object.mode_set(mode="EDIT")
        for name, parent in [("ShoulderL", None), ("UpperArmL", "ShoulderL"), ("LowerArmL", "UpperArmL"), ("WristL", "LowerArmL")]:
            bone = armature.edit_bones.new(name)
            bone.head = (0, 0, 0)
            bone.tail = (0, 0.1, 0)
            bone.matrix = world[poses.ids[name]]
            bone.length = {"UpperArmL": local[poses.ids["LowerArmL"]].translation.length, "LowerArmL": local[poses.ids["WristL"]].translation.length}.get(name, 0.1)
            if parent:
                bone.parent = armature.edit_bones[parent]
        bpy.ops.object.mode_set(mode="OBJECT")
        self.goal = bpy.data.objects.new("Baked wrist goal", None)
        bpy.context.collection.objects.link(self.goal)
        self.constraint = self.object.pose.bones["LowerArmL"].constraints.new("IK")
        self.constraint.target = self.goal
        self.constraint.chain_count = 2
        self.constraint.use_stretch = False
        self.constraint.iterations = 128
        self.ids = poses.ids

    def solve(self, local, world, goal, _guide):
        constraint = self.constraint
        constraint.influence = 0
        for name in ["ShoulderL", *CHANGED]:
            self.object.pose.bones[name].matrix = world[self.ids[name]]
            bpy.context.view_layer.update()
        upper = self.object.pose.bones["UpperArmL"]
        lower = self.object.pose.bones["LowerArmL"]
        upper.ik_stretch = 0
        lower.ik_stretch = 0
        upper_length = local[self.ids["LowerArmL"]].translation.length
        lower_length = local[self.ids["WristL"]].translation.length
        shoulder = world[self.ids["UpperArmL"]].translation
        axis = goal - shoulder
        distance = axis.length
        if not abs(upper_length - lower_length) + 1e-5 < distance < upper_length + lower_length - 1e-5:
            raise ValueError(f"Mirrored wrist outside original arm reach: {distance}")
        self.goal.location = goal
        constraint.influence = 1
        bpy.context.view_layer.update()
        up_world, lo_world = upper.matrix.copy(), lower.matrix.copy()
        endpoint = lo_world @ local[self.ids["WristL"]].translation
        error = (endpoint - goal).length
        if error > 0.0005:
            raise ValueError(f"Native left wrist IK residual {error}m")
        parent = world[self.ids["ShoulderL"]]
        wrist = world[self.ids["WristL"]].copy()
        wrist.translation = endpoint
        quats = [(parent.inverted() @ up_world).to_quaternion().normalized(), (up_world.inverted() @ lo_world).to_quaternion().normalized(), (lo_world.inverted() @ wrist).to_quaternion().normalized()]
        return {name: [q.x, q.y, q.z, q.w] for name, q in zip(CHANGED, quats)}, error


def pack(document, arrays):
    blob = bytearray()
    document["accessors"] = []
    document["bufferViews"] = []
    for array, width in arrays:
        offset = len(blob)
        flat = [value for row in array for value in row]
        blob.extend(struct.pack("<" + "f" * len(flat), *flat))
        document["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob) - offset})
        accessor = {"bufferView": len(document["bufferViews"]) - 1, "componentType": 5126, "count": len(array), "type": {1: "SCALAR", 3: "VEC3", 4: "VEC4"}[width]}
        if width == 1:
            accessor.update({"min": [min(flat)], "max": [max(flat)]})
        document["accessors"].append(accessor)
    document["buffers"] = [{"byteLength": len(blob)}]
    raw = json.dumps(document, separators=(",", ":")).encode()
    raw += b" " * (-len(raw) % 4)
    blob.extend(b"\x00" * (-len(blob) % 4))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(struct.pack("<III", 0x46546C67, 2, 28 + len(raw) + len(blob)) + struct.pack("<II", len(raw), 0x4E4F534A) + raw + struct.pack("<II", len(blob), 0x004E4942) + blob)


def hash_values(values):
    flat = [value for row in values for value in row]
    return hashlib.sha256(struct.pack("<" + "f" * len(flat), *flat)).hexdigest()


def main():
    source = read_glb(PAIR)
    skeleton = common.Source(BASE)
    poses = Poses(source, skeleton.doc)
    if [clip["name"] for clip in source.doc["animations"]] != CLIPS:
        raise ValueError("Canonical paired clip inventory changed")
    arm = NativeArm(poses)
    output = {"asset": {"version": "2.0", "generator": "Blender native offline paired-arm IK"}, "nodes": [{k: copy.deepcopy(v) for k, v in node.items() if k in ("name", "children", "translation", "rotation", "scale", "matrix")} for node in source.doc["nodes"]], "scenes": copy.deepcopy(source.doc["scenes"]), "scene": source.doc.get("scene", 0), "animations": []}
    arrays, receipts, report = [], [], []
    for clip in source.doc["animations"]:
        name = clip["name"]
        times = sorted({t for _, _, times, _, _ in poses.samples[name] for t in times})
        original_times = times[:]
        duration = times[-1]
        rate = 480 if name in ("Draw_Pair", "Spin_Pair") else 120
        candidates = sorted(set(times + [struct.unpack("<f", struct.pack("<f", i / rate))[0] for i in range(math.floor(duration * rate) + 1)]))
        active = [intent(poses, poses.evaluate(name, t)[1])[0] > 1e-7 for t in candidates]
        supplements = [t for i, t in enumerate(candidates) if t not in times and any(active[max(0, i - 1):i + 2])]
        times = sorted(set(times + supplements))
        solved = {}
        originals = {}
        count = 0
        max_error = 0
        for time in times:
            local, world = poses.evaluate(name, time)
            originals[time] = {}
            for bone in CHANGED:
                q = local[poses.ids[bone]].to_quaternion()
                originals[time][bone] = [q.x, q.y, q.z, q.w]
            amount, goal, guide = intent(poses, world)
            if amount > 1e-7:
                solved[time], error = arm.solve(local, world, goal, guide)
                count += 1
                max_error = max(max_error, error)
        new_clip = {"name": name, "channels": [], "samplers": []}
        for channel in clip["channels"]:
            sampler = clip["samplers"][channel["sampler"]]
            input_values = source.accessor(sampler["input"])
            output_values = source.accessor(sampler["output"])
            bone = source.doc["nodes"][channel["target"]["node"]].get("name")
            changed = bone in CHANGED and channel["target"]["path"] == "rotation"
            receipt = {"clip": name, "bone": bone, "path": channel["target"]["path"], "inputSHA256": hash_values(input_values), "sourceOutputSHA256": hash_values(output_values)}
            if changed:
                corrected = []
                values_by_time = {row[0]: value for row, value in zip(input_values, output_values)}
                input_values = [[t] for t in sorted(set(values_by_time) | set(supplements))]
                for row in input_values:
                    value = values_by_time.get(row[0], originals[row[0]][bone])
                    authored = solved.get(row[0], {}).get(bone)
                    if authored is not None and sum(a * b for a, b in zip(value, authored)) < 0:
                        authored = [-v for v in authored]
                    corrected.append(authored if authored is not None else value)
                output_values = corrected
            receipt["outputInputSHA256"] = hash_values(input_values)
            receipt["outputSHA256"] = hash_values(output_values)
            receipt["permittedChange"] = changed
            if not changed and receipt["sourceOutputSHA256"] != receipt["outputSHA256"]:
                raise ValueError("Offline pose authoring modified an unowned channel")
            receipts.append(receipt)
            input_index = len(arrays)
            arrays.extend([(input_values, 1), (output_values, len(output_values[0]))])
            new_clip["channels"].append({"target": copy.deepcopy(channel["target"]), "sampler": len(new_clip["samplers"])})
            new_clip["samplers"].append({"input": input_index, "output": input_index + 1, "interpolation": sampler.get("interpolation", "LINEAR")})
        output["animations"].append(new_clip)
        report.append({"clip": name, "sourceKeys": len(original_times), "correctionSampleRateHz": rate, "supplementalRotationKeysPerChangedBone": len(supplements), "correctedKeys": count, "nativeIKMaximumWristErrorMeters": max_error})
        print("PAIR", report[-1])
    inputs = [{"path": str(PAIR.relative_to(ROOT)), "sha256": hashlib.sha256(PAIR.read_bytes()).hexdigest()}, {"path": str(BASE.relative_to(ROOT)), "sha256": hashlib.sha256(BASE.read_bytes()).hexdigest()}]
    inputs.extend({"path": str((BASE.parent / b["uri"]).relative_to(ROOT)), "sha256": hashlib.sha256(data).hexdigest()} for b, data in zip(skeleton.doc["buffers"], skeleton.buffers))
    output["extras"] = {"sourceInputs": inputs, "changedBones": CHANGED, "reflectionPlane": "actor-localX0", "preservationReceipt": receipts, "authoring": "Blender native two-bone IK; bounded crossed-hand correction; no runtime IK", "nativeIKReport": report}
    pack(output, arrays)
    # Validate actual glTF quaternion interpolation, including between the new
    # finite correction keys. This catches wrist drift hidden by key-only QA.
    baked = Poses(read_glb(OUTPUT), skeleton.doc)
    for row in report:
        name = row["clip"]
        keys = sorted({t for _, _, ts, _, _ in baked.samples[name] for t in ts})
        probes = sorted(set(keys + [(x + y) / 2 for x, y in zip(keys, keys[1:])]))
        error, angle = 0, 0
        for t in probes:
            _, original = poses.evaluate(name, t)
            _, final = baked.evaluate(name, t)
            _, goal, _ = intent(poses, original)
            old = original[poses.ids["WristL"]]
            new = final[poses.ids["WristL"]]
            error = max(error, (goal - new.translation).length)
            qa, qb = old.to_quaternion().normalized(), new.to_quaternion().normalized()
            angle = max(angle, math.degrees(2 * math.acos(min(1, abs(qa.dot(qb))))))
        row["maximumInterpolatedWristGoalErrorMeters"] = error
        row["maximumInterpolatedWristDirectionErrorDegrees"] = angle
        if error > 0.015 or angle > 1:
            raise ValueError(f"Supplemental native interpolation residual too large: {row}")
    pack(output, arrays)
    evidence = Path("/tmp/out-west-paired-poses")
    evidence.mkdir(exist_ok=True)
    (evidence / "authoring-report.json").write_text(json.dumps(report, indent=2))
    print("WROTE", OUTPUT)


if __name__ == "__main__":
    main()
