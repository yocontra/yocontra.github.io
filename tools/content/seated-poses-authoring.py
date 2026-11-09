"""Author per-body bench poses with Blender's native offline limb IK.

Run with Blender --background --factory-startup --python this-file -- outlaw-2 outlaw-6.
Only portable animation artifacts are written; canonical models remain read-only.
"""

import copy
import hashlib
import importlib.util
import json
import math
import struct
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector

spec = importlib.util.spec_from_file_location("paired_authoring", Path(__file__).with_name("paired-poses-authoring.py"))
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
ROOT = shared.ROOT
SOURCE = ROOT / "tools/art/characters"
EVIDENCE = Path("/tmp/out-west-seated-poses")
FLOOR, SEAT = 0.06, 0.556151


def fk(local, parents):
    result = {}

    def at(index):
        if index not in result:
            result[index] = at(parents[index]) @ local[index] if index in parents else local[index]
        return result[index]

    for index in range(len(local)):
        at(index)
    return result


def rigid(matrix):
    return Matrix.LocRotScale(matrix.translation, matrix.to_quaternion(), Vector((1, 1, 1)))


def rotate(local, index, quaternion):
    local[index] = Matrix.LocRotScale(local[index].translation, quaternion, local[index].to_scale())


class Body:
    def __init__(self, id):
        self.id = id
        self.source = shared.common.Source(SOURCE / (id + ".gltf"))
        self.stance_path = SOURCE / "stances" / (id + ".glb")
        self.stance = shared.read_glb(self.stance_path)
        self.poses = shared.Poses(self.stance, self.source.doc)
        self.ids, self.parents = self.poses.ids, self.poses.parents
        self.local, self.world = self.poses.evaluate("Idle_Character", 0)
        self.source_trs = {(name, path): values[0] for name, path, _times, values, _interpolation in self.poses.samples["Idle_Character"]}
        self.scale = self.world[self.ids["Hips"]].to_scale().x
        self.body = next(self.source.bodies())
        self.node = self.source.doc["nodes"][self.body["sourcePrimitive"]["nodeIndex"]]
        self.skin = self.source.doc["skins"][self.node["skin"]]
        self.names = self.body["jointNames"]
        self.inverse = [Matrix([[row[col * 4 + line] for col in range(4)] for line in range(4)]) for row in self.source.accessor(self.skin["inverseBindMatrices"])]
        self.geometry = []
        for primitive in self.source.doc["meshes"][self.node["mesh"]]["primitives"]:
            attrs = {name: self.source.accessor(index) for name, index in primitive["attributes"].items()}
            indices = [row[0] for row in self.source.accessor(primitive["indices"])]
            if "JOINTS_0" in attrs:
                self.geometry.append((attrs, indices))
        self.ik_errors = []
        self.hand_supports = {}

    def update(self):
        self.world = fk(self.local, self.parents)

    def global_rotation(self, name, quaternion):
        index = self.ids[name]
        parent = self.world[self.parents[index]].to_quaternion()
        rotate(self.local, index, parent.inverted() @ quaternion)
        self.update()

    def skin_points(self, geometry):
        attrs, indices = geometry
        matrices = [self.world[node] @ inverse for node, inverse in zip(self.skin["joints"], self.inverse)]
        result = {}
        for index in set(indices):
            point = Vector((*attrs["POSITION"][index], 1))
            posed = Vector((0, 0, 0, 0))
            for joint, weight in zip(attrs["JOINTS_0"][index], attrs["WEIGHTS_0"][index]):
                if weight:
                    posed += (matrices[int(joint)] @ point) * weight
            result[index] = posed.to_3d()
        return result

    def sole_orientation(self, side):
        index = self.names.index("Foot" + side)
        quaternion = self.inverse[index].inverted().to_quaternion()
        forward = quaternion @ Vector((0, 1, 0))
        quaternion = Quaternion((0, 1, 0), -math.atan2(forward.x, forward.z)) @ quaternion
        rotation = Matrix.LocRotScale(Vector((0, 0, 0)), quaternion, Vector((self.scale,) * 3))
        offsets = []
        for attrs, indices in self.geometry:
            for vertex in set(indices):
                weight = sum(w for j, w in zip(attrs["JOINTS_0"][vertex], attrs["WEIGHTS_0"][vertex]) if int(j) == index)
                if weight > 0.6:
                    offsets.append((rotation @ self.inverse[index] @ Vector((*attrs["POSITION"][vertex], 1))).y)
        return quaternion, FLOOR - min(offsets)

    def palm_offset(self, side, quaternion):
        joint = self.names.index("Wrist" + side)
        rotation = Matrix.LocRotScale(Vector((0, 0, 0)), quaternion, Vector((self.scale,) * 3))
        offsets = []
        for attrs, indices in self.geometry:
            for vertex in set(indices):
                weight = sum(w for j, w in zip(attrs["JOINTS_0"][vertex], attrs["WEIGHTS_0"][vertex]) if int(j) == joint)
                local = self.inverse[joint] @ Vector((*attrs["POSITION"][vertex], 1))
                if weight > 0.6 and 0.035 < local.y < 0.105:
                    offsets.append((rotation @ local).y)
        if not offsets:
            raise ValueError(f"{self.id}: no native palm contact vertices")
        return min(offsets)

    def pants(self):
        attrs, indices = self.body["attrs"], self.body["indices"]
        ranges = [r for r in self.body["ranges"] if r.get("name") == "WesternTrousers" or r.get("slot") == "pants"]
        if not ranges:
            raise ValueError(f"{self.id}: native trouser contact surface missing")
        points = self.skin_points((attrs, indices))
        return {i: point for i, point in points.items() if any(r["start"] <= i < r["start"] + r["count"] for r in ranges)}

    def butt(self):
        hip = self.world[self.ids["Hips"]].translation
        attrs = self.body["attrs"]
        points = []
        for index, point in self.pants().items():
            weight = sum(w for j, w in zip(attrs["JOINTS_0"][index], attrs["WEIGHTS_0"][index]) if self.names[int(j)] == "Hips")
            if weight > 0.4 and point.z < hip.z + 0.015 and abs(point.x - hip.x) < 0.17 * self.scale:
                points.append(point)
        if not points:
            raise ValueError(f"{self.id}: pelvis contact sample empty")
        return min(point.y for point in points), len(points)


def limb(body, upper_name, lower_name, end_name, goal, end_rotation, guide):
    """Solve a finite static limb using native Blender IK, without stretch."""
    armature = bpy.data.armatures.new("Offline contact rig")
    obj = bpy.data.objects.new("Offline contact rig", armature)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    parent_index = body.parents[body.ids[upper_name]]
    matrices = [body.world[parent_index], body.world[body.ids[upper_name]], body.world[body.ids[lower_name]], body.world[body.ids[end_name]]]
    names = ["Parent", upper_name, lower_name, end_name]
    lengths = [0.1, body.local[body.ids[lower_name]].translation.length * body.scale, body.local[body.ids[end_name]].translation.length * body.scale, 0.1]
    for index, name in enumerate(names):
        bone = armature.edit_bones.new(name)
        bone.head, bone.tail = (0, 0, 0), (0, 0.1, 0)
        bone.matrix = rigid(matrices[index])
        bone.length = lengths[index]
        if index:
            bone.parent = armature.edit_bones[names[index - 1]]
    bpy.ops.object.mode_set(mode="OBJECT")
    target = bpy.data.objects.new("Offline contact target", None)
    pole = bpy.data.objects.new("Offline bend guide", None)
    bpy.context.collection.objects.link(target)
    bpy.context.collection.objects.link(pole)
    target.location, pole.location = goal, guide
    lower = obj.pose.bones[lower_name]
    upper = obj.pose.bones[upper_name]
    constraint = lower.constraints.new("IK")
    constraint.target, constraint.pole_target = target, pole
    constraint.chain_count, constraint.iterations = 2, 128
    constraint.use_stretch = False
    upper.ik_stretch = lower.ik_stretch = 0
    bpy.context.view_layer.update()
    shoulder = matrices[1].translation
    axis = goal - shoulder
    distance = axis.length
    if not abs(lengths[1] - lengths[2]) + 1e-5 < distance < lengths[1] + lengths[2] - 1e-5:
        raise ValueError(f"{body.id} {upper_name}: unreachable contact {distance}, lengths {lengths[1:3]}")
    axis.normalize()
    along = (lengths[1] ** 2 - lengths[2] ** 2 + distance ** 2) / (2 * distance)
    center = shoulder + axis * along
    desired = guide - center
    desired -= axis * desired.dot(axis)
    desired = center + desired.normalized() * math.sqrt(max(0, lengths[1] ** 2 - along ** 2))
    pole.location = desired
    bpy.context.view_layer.update()
    current = lower.matrix.translation - center
    current -= axis * current.dot(axis)
    desired_vector = desired - center
    angle = math.atan2(axis.dot(current.cross(desired_vector)), current.dot(desired_vector))
    scores = []
    for trial in (angle, -angle):
        constraint.pole_angle = trial
        bpy.context.view_layer.update()
        scores.append(((lower.matrix.translation - desired).length, trial))
    constraint.pole_angle = min(scores)[1]
    bpy.context.view_layer.update()
    up, lo = upper.matrix.copy(), lower.matrix.copy()
    endpoint = lo @ Vector((0, lengths[2], 0))
    error = (endpoint - goal).length
    if error > 0.0005:
        raise ValueError(f"{body.id} native limb contact residual {error}")
    parent_rotation = body.world[parent_index].to_quaternion()
    rotate(body.local, body.ids[upper_name], parent_rotation.inverted() @ up.to_quaternion())
    rotate(body.local, body.ids[lower_name], up.to_quaternion().inverted() @ lo.to_quaternion())
    rotate(body.local, body.ids[end_name], lo.to_quaternion().inverted() @ end_rotation)
    body.update()
    body.ik_errors.append(error)
    for disposable in (obj, target, pole):
        bpy.data.objects.remove(disposable, do_unlink=True)
    bpy.data.armatures.remove(armature)


def pose_lower(body, hip_y):
    reference = shared.common.Source(SOURCE / "character-actions.gltf")
    reference_poses = shared.Poses(reference, body.source.doc)
    _, old = reference_poses.evaluate("Town_Sit", 0)
    hip = old[body.ids["Hips"]].translation.copy()
    hip.y = hip_y
    parent = body.world[body.parents[body.ids["Hips"]]]
    body.local[body.ids["Hips"]] = parent.inverted() @ Matrix.LocRotScale(hip, Quaternion(), Vector((body.scale,) * 3))
    body.update()
    for name in ("Abdomen", "Torso", "Chest"):
        body.global_rotation(name, Quaternion((1, 0, 0), math.radians(3)))
    for name in ("Neck", "Head"):
        body.global_rotation(name, Quaternion())
    for side, sign in (("L", 1), ("R", -1)):
        foot_rotation, ankle_y = body.sole_orientation(side)
        upper_length = body.local[body.ids["LowerLeg" + side]].translation.length * body.scale
        goal = Vector((hip.x + sign * 0.15 * body.scale, ankle_y, hip.z + upper_length * 0.95))
        lower_length = body.local[body.ids["Foot" + side]].translation.length * body.scale
        upper_head = body.world[body.ids["UpperLeg" + side]].translation
        distance_squared = upper_length ** 2 + lower_length ** 2 - 2 * upper_length * lower_length * math.cos(math.radians(110))
        forward_squared = distance_squared - (goal.x - upper_head.x) ** 2 - (goal.y - upper_head.y) ** 2
        goal.z = min(goal.z, upper_head.z + math.sqrt(max(0, forward_squared)))
        guide = Vector((goal.x, hip_y + 0.05, hip.z + upper_length + 0.2))
        limb(body, "UpperLeg" + side, "LowerLeg" + side, "Foot" + side, goal, foot_rotation, guide)


def pose_arms(body):
    # The per-body idle supplies anatomy; soften its closed fingers toward the
    # canonical neutral finger frames, independently of its raised arm pose.
    neutral = shared.Poses(body.source, body.source.doc)
    neutral_local, _ = neutral.evaluate("Idle_Neutral", 0)
    for name, index in body.ids.items():
        if name and name.startswith(("Index", "Middle", "Ring", "Pinky", "Thumb")):
            q = neutral_local[index].to_quaternion().slerp(body.local[index].to_quaternion(), 0.15 if not name.startswith("Thumb") else 0.25)
            rotate(body.local, index, q)
    body.update()
    pants = body.pants()
    for side, sign in (("L", 1), ("R", -1)):
        upper = body.world[body.ids["UpperLeg" + side]].translation
        knee = body.world[body.ids["LowerLeg" + side]].translation
        point = upper.lerp(knee, 0.28)
        nearby = [p for p in pants.values() if abs(p.x - point.x) < 0.075 * body.scale and abs(p.z - point.z) < 0.055 * body.scale]
        if not nearby:
            raise ValueError(f"{body.id}: thigh support patch missing")
        top = max(p.y for p in nearby)
        # Local hand Y runs toward fingers; palm normal is mirrored local X.
        x = Vector((0, -sign, 0))
        y = Vector((0, 0, 1))
        z = x.cross(y)
        orientation = Matrix((x, y, z)).transposed().to_quaternion()
        goal = Vector((point.x, top - body.palm_offset(side, orientation), point.z - 0.015))
        body.hand_supports[side] = {"thighTopY": top, "thighPatchCenter": list(point), "wristGoal": list(goal)}
        shoulder = body.world[body.ids["UpperArm" + side]].translation
        guide = Vector((shoulder.x + sign * 0.12, goal.y + 0.13, shoulder.z - 0.06))
        limb(body, "UpperArm" + side, "LowerArm" + side, "Wrist" + side, goal, orientation, guide)


def contacts(body):
    hip = body.world[body.ids["Hips"]].translation
    result = {"hips": list(hip), "buttMinimumY": body.butt()[0], "buttSamples": body.butt()[1], "soles": {}, "knees": {}, "wrists": {}, "elbows": {}, "palms": {}, "kneeAnglesDegrees": {}}
    all_points = [(attrs, body.skin_points((attrs, indices))) for attrs, indices in body.geometry]
    for side in ("L", "R"):
        joint = body.names.index("Foot" + side)
        values = []
        for attrs, points in all_points:
            for vertex, point in points.items():
                weight = sum(w for j, w in zip(attrs["JOINTS_0"][vertex], attrs["WEIGHTS_0"][vertex]) if int(j) == joint)
                if weight > 0.6:
                    values.append(point.y)
        result["soles"][side] = min(values)
        knee = body.world[body.ids["LowerLeg" + side]].translation
        upper = body.world[body.ids["UpperLeg" + side]].translation
        ankle = body.world[body.ids["Foot" + side]].translation
        result["knees"][side] = list(knee)
        result["wrists"][side] = list(body.world[body.ids["Wrist" + side]].translation)
        result["elbows"][side] = list(body.world[body.ids["LowerArm" + side]].translation)
        result["kneeAnglesDegrees"][side] = math.degrees((upper - knee).angle(ankle - knee))
        wrist = body.names.index("Wrist" + side)
        palm = []
        for attrs, points in all_points:
            for vertex, point in points.items():
                weight = sum(w for j, w in zip(attrs["JOINTS_0"][vertex], attrs["WEIGHTS_0"][vertex]) if int(j) == wrist)
                local = body.inverse[wrist] @ Vector((*attrs["POSITION"][vertex], 1))
                if weight > 0.6 and 0.035 < local.y < 0.105:
                    palm.append(point.y)
        result["palms"][side] = {**body.hand_supports[side], "actualMinimumY": min(palm), "supportDifferenceY": min(palm) - body.hand_supports[side]["thighTopY"]}
    result["hipAboveSeat"] = hip.y - SEAT
    result["maximumNativeIKResidualMeters"] = max(body.ik_errors)
    return result


def write(body, measured):
    nodes = [{k: copy.deepcopy(v) for k, v in node.items() if k in ("name", "children", "translation", "rotation", "scale", "matrix")} for node in body.source.doc["nodes"]]
    doc = {"asset": {"version": "2.0", "generator": "Blender native offline seated contact IK"}, "nodes": nodes, "scenes": copy.deepcopy(body.source.doc["scenes"]), "scene": body.source.doc.get("scene", 0), "accessors": [], "bufferViews": [], "buffers": [], "animations": [{"name": "Town_Sit", "channels": [], "samplers": []}]}
    blob = bytearray()

    def array(rows):
        width = len(rows[0])
        flat = [v for row in rows for v in row]
        offset = len(blob)
        blob.extend(struct.pack("<" + "f" * len(flat), *flat))
        view = len(doc["bufferViews"])
        doc["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob) - offset})
        accessor = {"bufferView": view, "componentType": 5126, "type": {1: "SCALAR", 3: "VEC3", 4: "VEC4"}[width], "count": len(rows)}
        if width == 1:
            accessor.update({"min": [min(flat)], "max": [max(flat)]})
        doc["accessors"].append(accessor)
        return len(doc["accessors"]) - 1

    times = array([[0], [2]])
    animation = doc["animations"][0]
    animation["extras"] = {"seatedContact": {"sourceId": body.id, "seatY": SEAT, "floorY": FLOOR, "hipsAboveSeat": measured["hipAboveSeat"]}}
    target_names = {track[0] for track in body.poses.samples["Idle_Character"]}
    for name in sorted(target_names):
        if name not in body.ids:
            continue
        index = body.ids[name]
        translation, quaternion, scale = body.local[index].decompose()
        for path, value in [("translation", list(translation)), ("rotation", [quaternion.x, quaternion.y, quaternion.z, quaternion.w]), ("scale", list(scale))]:
            if path == "scale" or (path == "translation" and name != "Hips"):
                value = body.source_trs.get((name, path), value)
            output = array([value, value])
            sampler = len(animation["samplers"])
            animation["samplers"].append({"input": times, "output": output, "interpolation": "LINEAR"})
            animation["channels"].append({"sampler": sampler, "target": {"node": index, "path": path}})
    inputs = [body.source.path, body.stance_path, SOURCE / "character-actions.gltf"]
    inputs += [body.source.path.parent / b["uri"] for b in body.source.doc["buffers"]]
    reference = shared.common.Source(SOURCE / "character-actions.gltf")
    inputs += [reference.path.parent / b["uri"] for b in reference.doc["buffers"]]
    doc["extras"] = {"sourceId": body.id, "sourceInputs": [{"path": str(path.relative_to(ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in inputs], "authoring": "Blender native nonstretch limb IK, explicit pelvis/sole/thigh/palm contacts; finite static two-key loop", "contactFrame": {"floorY": FLOOR, "seatY": SEAT}, "contactTolerancesMeters": {"seat": 0.01, "soles": 0.005, "palms": 0.02}, "measuredContacts": measured, "clipDuration": 2, "placementRequirement": {"hipsAboveSeat": measured["hipAboveSeat"], "note": "Use measured hip-to-seat offset when explicitly placing Town_Sit; sole coordinates refer to the same seat/floor frame."}}
    doc["buffers"] = [{"byteLength": len(blob)}]
    raw = json.dumps(doc, separators=(",", ":")).encode()
    raw += b" " * (-len(raw) % 4)
    blob.extend(b"\x00" * (-len(blob) % 4))
    path = SOURCE / "seated-poses" / (body.id + ".glb")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 28 + len(raw) + len(blob)) + struct.pack("<II", len(raw), 0x4E4F534A) + raw + struct.pack("<II", len(blob), 0x004E4942) + blob)
    EVIDENCE.mkdir(exist_ok=True)
    (EVIDENCE / (body.id + "-contacts.json")).write_text(json.dumps(measured, indent=2))
    return path


def author(id):
    body = Body(id)
    hip_y = SEAT + 0.06
    for _ in range(4):
        pose_lower(body, hip_y)
        butt, _ = body.butt()
        if abs(butt - SEAT) < 0.002:
            break
        hip_y += SEAT - butt
    pose_arms(body)
    measured = contacts(body)
    if any(abs(y - FLOOR) > 0.005 for y in measured["soles"].values()) or abs(measured["buttMinimumY"] - SEAT) > 0.01:
        raise ValueError(f"{id}: native skin seat/sole contact failed {measured}")
    path = write(body, measured)
    print("SEATED", id, path, json.dumps(measured))
    return body


if __name__ == "__main__":
    ids = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else ["outlaw-2", "outlaw-6"]
    for id in ids:
        author(id)
