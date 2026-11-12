"""Bake long-gun support-hand grips against canonical held-gun geometry.

Blender --background --factory-startup --python tools/content/longgun-grips-authoring.py [-- rifle shotgun]
The left arm is retargeted offline (analytic two-bone IK) so an authored palm frame stays fixed on the
fore-end at every source key. Digits flex only about their native hinge axis (bone-local X) with a fixed
knuckle spread, so no axial twist is introduced; flexion is solved against actual skinned flesh. Every
unowned channel and every source key time is copied unchanged. No runtime IK.
"""

import copy
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import bmesh
import numpy as np
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "tools/art/characters"
OUTPUT = SOURCE / "longgun-grips"
DIGITS = ("Index", "Middle", "Ring", "Pinky", "Thumb")
ARM = ["ShoulderL", "UpperArmL", "LowerArmL", "WristL"]
COMPONENTS = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8, 5122: np.int16}
WIDTHS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}

# Gun frame: x toward the muzzle, y up, z toward the shooter's right. Angles in degrees.
# hand: direction from wrist to middle knuckle (yaw toward +z, pitch toward +y); roll turns the palm
# about that direction (0 = palm as close to +y as possible). knuckle: middle knuckle joint start point,
# then the palm slides along its normal until skin contact. protract: clavicle swing toward the muzzle.
# elbowDrop: swing of the elbow pole from the source pose toward gun-down.
# spread: knuckle splay about bone-local Z. sight: flesh within z of the bore axis must stay below y so the
# wrap never rises into the sight line (fingers beside the barrel are free).
GRIPS = {
    "rifle": {
        "knuckle": (0.215, -0.05, 0.025),
        "protract": 26,
        "elbowDrop": 45,
        "hand": {"yaw": 60, "pitch": 5, "roll": -15},
        "sight": {"y": 0.012, "z": 0.014},
        "spread": {"Index": 0, "Middle": 0, "Ring": 0, "Pinky": 0},
    },
    "shotgun": {
        "knuckle": (0.13, -0.04, -0.04),
        "protract": 12,
        "hand": {"yaw": 60, "pitch": 10, "roll": 45},
        "sight": {"y": 0.045, "z": 0.02},
        "spread": {"Index": 0, "Middle": 0, "Ring": 0, "Pinky": 0},
    },
}
PALM_CONTACT = 0.0005
FLESH_LIMIT = 0.001
SLIDE = 0.03
SYNERGY = 0.0004


class Doc:
    def __init__(self, path):
        path = Path(path)
        self.path = path
        if path.suffix == ".glb":
            raw = path.read_bytes()
            size = struct.unpack_from("<I", raw, 12)[0]
            self.doc = json.loads(raw[20:20 + size])
            self.buffers = [raw[28 + size:]]
            self.files = [path]
        else:
            self.doc = json.loads(path.read_text())
            self.files = [path] + [path.parent / b["uri"] for b in self.doc["buffers"]]
            self.buffers = [f.read_bytes() for f in self.files[1:]]
        self.names = {n.get("name"): i for i, n in enumerate(self.doc["nodes"]) if n.get("name")}
        self.parents = {c: i for i, n in enumerate(self.doc["nodes"]) for c in n.get("children", [])}

    def accessor(self, index):
        a = self.doc["accessors"][index]
        view = self.doc["bufferViews"][a["bufferView"]]
        kind = np.dtype(COMPONENTS[a["componentType"]])
        width = WIDTHS[a["type"]]
        offset = view.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = view.get("byteStride", kind.itemsize * width)
        data = self.buffers[view["buffer"]]
        rows = [np.frombuffer(data, kind, width, offset + i * stride) for i in range(a["count"])] if stride != kind.itemsize * width else None
        array = np.array(rows) if rows is not None else np.frombuffer(data, kind, a["count"] * width, offset).reshape(a["count"], width)
        return array.astype(np.float64) if kind == np.float32 else array.astype(np.int64)


def trs(node):
    if "matrix" in node:
        m = node["matrix"]
        return Matrix([[m[c * 4 + r] for c in range(4)] for r in range(4)])
    q = node.get("rotation", [0, 0, 0, 1])
    return Matrix.LocRotScale(Vector(node.get("translation", [0, 0, 0])), Quaternion((q[3], *q[:3])), Vector(node.get("scale", [1, 1, 1])))


def xyzw(q):
    return [q.x, q.y, q.z, q.w]


class Clips:
    def __init__(self, doc):
        self.doc = doc
        self.tracks = {}
        for clip in doc.doc.get("animations", []):
            tracks = {}
            for channel in clip["channels"]:
                sampler = clip["samplers"][channel["sampler"]]
                if sampler.get("interpolation", "LINEAR") not in ("LINEAR", "STEP"):
                    raise ValueError("Grip authoring expects linear/step source tracks")
                name = doc.doc["nodes"][channel["target"]["node"]].get("name")
                tracks[(name, channel["target"]["path"])] = (doc.accessor(sampler["input"])[:, 0], doc.accessor(sampler["output"]), sampler.get("interpolation", "LINEAR"))
            self.tracks[clip["name"]] = tracks

    def times(self, clip):
        return sorted({float(t) for times, _, _ in self.tracks[clip].values() for t in times})

    def sample(self, clip, time):
        out = {}
        for (name, path), (times, values, interpolation) in self.tracks[clip].items():
            k = max(0, min(int(np.searchsorted(times, time, side="right")) - 1, len(times) - 1))
            value = values[k]
            if k + 1 < len(times) and interpolation != "STEP" and time > times[k]:
                alpha = (time - times[k]) / (times[k + 1] - times[k])
                after = values[k + 1]
                if path == "rotation":
                    value = xyzw(Quaternion((value[3], *value[:3])).slerp(Quaternion((after[3], *after[:3])), alpha))
                else:
                    value = [a + (b - a) * alpha for a, b in zip(value, after)]
            out.setdefault(name, {})[path] = [float(v) for v in value]
        return out


class Skeleton:
    def __init__(self, doc):
        self.doc = doc
        self.nodes = doc.doc["nodes"]
        self.rest = {n.get("name"): Quaternion((n.get("rotation", [0, 0, 0, 1])[3], *n.get("rotation", [0, 0, 0, 1])[:3])) for n in self.nodes}

    def world(self, overrides):
        local = []
        for n in self.nodes:
            node = dict(n)
            if n.get("name") in overrides:
                node.pop("matrix", None)
                node.update(overrides[n["name"]])
            local.append(trs(node))
        world = {}

        def at(i):
            if i not in world:
                p = self.doc.parents.get(i)
                world[i] = at(p) @ local[i] if p is not None else local[i]
            return world[i]

        return {self.nodes[i].get("name") or i: at(i) for i in range(len(self.nodes))}


class Skin:
    def __init__(self, doc):
        d = doc.doc
        node = next(n for n in d["nodes"] if n.get("skin") is not None)
        skin = d["skins"][node["skin"]]
        self.joints = [d["nodes"][j]["name"] for j in skin["joints"]]
        self.ibm = np.transpose(doc.accessor(skin["inverseBindMatrices"]).reshape(-1, 4, 4), (0, 2, 1))
        primitive = d["meshes"][node["mesh"]]["primitives"][0]
        self.position = doc.accessor(primitive["attributes"]["POSITION"])
        self.joint = doc.accessor(primitive["attributes"]["JOINTS_0"])
        self.weight = doc.accessor(primitive["attributes"]["WEIGHTS_0"])
        self.indices = doc.accessor(primitive["indices"])[:, 0]

    def matrices(self, world):
        return np.array([np.array(world[n]) for n in self.joints]) @ self.ibm

    def deform(self, mats, subset=slice(None)):
        p = np.c_[self.position[subset], np.ones(len(self.position[subset]))]
        out = np.zeros((len(p), 3))
        for k in range(4):
            m = mats[self.joint[subset, k]]
            out += self.weight[subset, k:k + 1] * np.einsum("nij,nj->ni", m, p)[:, :3]
        return out


class Gun:
    """Canonical held-gun geometry in its mount-relative gun frame."""

    def __init__(self, kind):
        self.doc = Doc(SOURCE / f"held-{kind}.gltf")
        nodes = self.doc.doc["nodes"]
        parents = self.doc.parents
        mount = self.doc.names["mount.Chest.long"]
        group = nodes[mount]["children"][0]
        self.frame = trs(nodes[group])

        def chain(i):
            m = Matrix.Identity(4)
            while i != group:
                m = trs(nodes[i]) @ m
                i = parents[i]
            return m

        holder = next(i for i, n in enumerate(nodes) if n.get("extras", {}).get("longAnatomy"))
        self.anatomy = {k: chain(holder) @ Vector((v["x"], v["y"], v["z"])) for k, v in nodes[holder]["extras"]["longAnatomy"].items()}
        mesh = holder if "mesh" in nodes[holder] else next(c for c in nodes[holder]["children"] if "mesh" in nodes[c] and not nodes[c].get("extras", {}).get("lod"))
        transform = chain(mesh)
        points, triangles = [], []
        for primitive in self.doc.doc["meshes"][nodes[mesh]["mesh"]]["primitives"]:
            base = len(points)
            points.extend(transform @ Vector(v) for v in self.doc.accessor(primitive["attributes"]["POSITION"]))
            triangles.extend(tuple(int(i) + base for i in t) for t in self.doc.accessor(primitive["indices"])[:, 0].reshape(-1, 3))
        mesh = bmesh.new()
        verts = [mesh.verts.new(p) for p in points]
        for t in triangles:
            try:
                mesh.faces.new([verts[i] for i in t])
            except ValueError:
                pass
        # Source winding is not reliably outward; rebuild closed parts with consistent outward normals.
        bmesh.ops.remove_doubles(mesh, verts=mesh.verts, dist=1e-5)
        bmesh.ops.recalc_face_normals(mesh, faces=mesh.faces)
        mesh.normal_update()
        self.points = np.array([v.co[:] for v in mesh.verts])
        self.tree = BVHTree.FromBMesh(mesh)
        self.bmesh = mesh

    def signed(self, points):
        out = np.empty(len(points))
        for i, p in enumerate(points):
            p = Vector(p)
            hit, normal, _, distance = self.tree.find_nearest(p, 0.25)
            out[i] = 0.25 if hit is None else (distance if (p - hit).dot(normal) >= 0 else -distance)
        return out


class Hand:
    """Skinned hand flesh driven by native finger hinges."""

    def __init__(self, skeleton, skin, sample, side):
        self.side = side
        self.skeleton = skeleton
        self.skin = skin
        self.bones = [f"Wrist{side}"] + [f"{d}{i}{side}" for d in DIGITS for i in (1, 2, 3, 4)]
        self.local = {}
        for b in self.bones:
            node = dict(skeleton.nodes[skeleton.doc.names[b]])
            node.update(sample.get(b, {}))
            self.local[b] = node
        ids = [skin.joints.index(b) for b in self.bones if b in skin.joints]
        on_hand = np.isin(skin.joint, ids) * skin.weight
        self.subset = np.where(on_hand.sum(1) > 0.999)[0]
        dominant = skin.joint[self.subset, np.argmax(skin.weight[self.subset], 1)]
        self.dominant = np.array([skin.joints[j] for j in dominant])
        bind = np.einsum("nij,nj->ni", skin.ibm[dominant], np.c_[skin.position[self.subset], np.ones(len(self.subset))])[:, :3]
        # The bind pose is a loose fist: every digit joint curls toward bone-local +Z about local X.
        self.palmar = bind[:, 2] > 0
        self.bind = bind
        rest = skeleton.world({})
        self.curl = {}
        for d in DIGITS:
            joints = [rest[f"Wrist{side}"].translation] + [rest[f"{d}{i}{side}"].translation for i in (1, 2, 3, 4)]
            segments = [b - a for a, b in zip(joints, joints[1:])]
            for i in (1, 2, 3):
                self.curl[f"{d}{i}{side}"] = math.degrees(segments[i - 1].angle(segments[i]))

    def rotation(self, digit, joint, flex, spread=0.0):
        """Anatomical flexion: 0 is straight along the parent segment, positive curls toward the palm."""
        bone = f"{digit}{joint}{self.side}"
        return self.skeleton.rest[bone] @ Quaternion((0, 0, 1), math.radians(spread)) @ Quaternion((1, 0, 0), math.radians(flex - self.curl[bone]))

    def world(self, wrist, rotations):
        out = {f"Wrist{self.side}": wrist}
        for d in DIGITS:
            parent = wrist
            for i in (1, 2, 3, 4):
                b = f"{d}{i}{self.side}"
                node = dict(self.local[b])
                if b in rotations:
                    node["rotation"] = xyzw(rotations[b])
                parent = out[b] = parent @ trs(node)
        return out

    def flesh(self, base, wrist, rotations, mask=None):
        world = dict(base)
        world.update(self.world(wrist, rotations))
        return self.skin.deform(self.skin.matrices(world), self.subset if mask is None else self.subset[mask])

    def mask(self, digit, joints=(1, 2, 3, 4), palmar=False):
        names = [f"{digit}{i}{self.side}" for i in joints]
        m = np.isin(self.dominant, names)
        return m & self.palmar if palmar else m


def swing(a, b):
    return a.rotation_difference(b).to_matrix()


def twist_angle(q, axis):
    p = Vector((q.x, q.y, q.z)).project(axis)
    t = Quaternion((q.w, p.x, p.y, p.z))
    if t.magnitude < 1e-9:
        return 0.0
    t.normalize()
    angle = 2 * math.atan2(Vector((t.x, t.y, t.z)).dot(axis.normalized()), t.w)
    return (angle + math.pi) % (2 * math.pi) - math.pi


class Authoring:
    def __init__(self, kind):
        self.kind = kind
        self.player = Doc(SOURCE / "player.gltf")
        self.skeleton = Skeleton(self.player)
        self.skin = Skin(self.player)
        self.actions = Doc(SOURCE / f"held-actions-{kind}.glb")
        self.clips = Clips(self.actions)
        self.gun = Gun(kind)
        self.grip = GRIPS[kind]
        sample = self.clips.sample(f"Hold_{kind}", 0)
        self.hand = Hand(self.skeleton, self.skin, sample, "L")
        self.lengths = {b: Vector(self.hand.local[b].get("translation", [0, 0, 0])).length if b in self.hand.local else None for b in ARM}
        for b in ("LowerArmL", "WristL"):
            node = dict(self.skeleton.nodes[self.skeleton.doc.names[b]])
            node.update(sample.get(b, {}))
            self.lengths[b] = Vector(node["translation"]).length
        self.world0 = self.skeleton.world(sample)
        self.G0 = self.gun_world(f"Hold_{kind}", 0, self.world0)
        self.Gi0 = np.array(self.G0.inverted())
        self.scale = self.world0["WristL"].to_scale()[0]
        self.local_direction, self.local_normal = self.palm_frame(self.world0)
        self.knuckle_local = self.world0["WristL"].inverted() @ self.world0["Middle1L"].translation * self.scale
        hand = self.hand
        roots = np.isin(hand.dominant, [f"{d}1L" for d in DIGITS[:4]]) & hand.palmar & (hand.bind[:, 1] < 0.015)
        self.contact = ((hand.dominant == "WristL") & (hand.bind @ np.array(self.local_normal) > 0.005)) | roots
        self.relaxed = {f"{d}{i}L": hand.rotation(d, i, 30) for d in DIGITS[:4] for i in (1, 2, 3)}

    def gun_world(self, clip, time, world):
        mechanism = ("Weapon_Shoot_" if clip.startswith("Shoot") else "Weapon_Idle_") + self.kind
        mount = trs(self.clips.sample(mechanism, time).get("mount.Chest.long", {}))
        return world["Chest"] @ mount @ self.gun.frame

    def palm_frame(self, world):
        """Hand direction and palm normal in WristL-local axes, measured from the rig."""
        wrist = world["WristL"]
        inverse = wrist.inverted()
        direction = (inverse @ world["Middle1L"].translation).normalized()
        straight = self.hand.world(wrist, {"Middle1L": self.hand.rotation("Middle", 1, 0)})["Middle2L"].translation
        bent = self.hand.world(wrist, {"Middle1L": self.hand.rotation("Middle", 1, 30)})["Middle2L"].translation
        normal = (inverse.to_3x3() @ (bent - straight))
        normal = (normal - normal.project(direction)).normalized()
        return direction, normal

    def target_rotation(self, hand):
        yaw, pitch, roll = (math.radians(hand[k]) for k in ("yaw", "pitch", "roll"))
        direction = Vector((math.cos(pitch) * math.cos(yaw), math.sin(pitch), math.cos(pitch) * math.sin(yaw)))
        up = Vector((0, 1, 0))
        normal = Quaternion(direction, roll) @ (up - up.project(direction)).normalized()
        a = Matrix((self.local_direction, self.local_normal, self.local_direction.cross(self.local_normal))).transposed()
        b = Matrix((direction, normal, direction.cross(normal))).transposed()
        return b @ a.inverted(), normal

    def wrist_world(self, position, rotation):
        G = self.G0
        return Matrix.LocRotScale(G @ Vector(position), (G.to_3x3().normalized() @ rotation).to_quaternion(), Vector((self.scale,) * 3))

    def gun_space(self, points):
        return points @ self.Gi0[:3, :3].T + self.Gi0[:3, 3]

    def place(self, grip):
        """Wrist position and rotation in the gun frame with the palm resting on the wood."""
        rotation, normal = self.target_rotation(grip["hand"])
        start = Vector(grip["knuckle"]) - rotation @ self.knuckle_local
        contact = self.contact

        def depth(s):
            flesh = self.gun_space(self.hand.flesh(self.world0, self.wrist_world(start + normal * s, rotation), self.relaxed, contact))
            return -self.gun.signed(flesh).min()

        if depth(-SLIDE) > PALM_CONTACT:
            return None
        hi = next((s for s in np.arange(-SLIDE, SLIDE, 0.002) if depth(s) > PALM_CONTACT), None)
        if hi is None:
            return None
        lo = hi - 0.002
        for _ in range(24):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if depth(mid) < PALM_CONTACT else (lo, mid)
        return start + normal * lo, rotation, lo

    def digit(self, wrist, rotations, digit, grip):
        """Hinge-only flexion with pads on the wood, no flesh inside it and the wrap out of the sight line."""
        members = self.hand.mask(digit)
        pads = [self.hand.mask(digit, (i,), True)[members] for i in (1, 2, 3)]
        thumb = digit == "Thumb"

        def pose(c):
            if thumb:
                a, s, b, e = c
                return {"Thumb1L": self.hand.rotation("Thumb", 1, a, s), "Thumb2L": self.hand.rotation("Thumb", 2, b), "Thumb3L": self.hand.rotation("Thumb", 3, e)}
            a, b = c
            return {f"{digit}1L": self.hand.rotation(digit, 1, a, grip["spread"][digit]), f"{digit}2L": self.hand.rotation(digit, 2, b), f"{digit}3L": self.hand.rotation(digit, 3, 0.7 * b)}

        def score(c):
            trial = dict(rotations)
            trial.update(pose(c))
            flesh = self.gun_space(self.hand.flesh(self.world0, wrist, trial, members))
            d = self.gun.signed(flesh)
            gaps = [max(0.0, d[p].min()) for p in pads]
            over = self.intrusion(flesh, grip)
            depth = max(0.0, -d.min() - FLESH_LIMIT)
            loft = max(0.0, flesh[:, 1].max() - grip["sight"]["y"] - 0.01)
            cost = gaps[0] * 0.5 + gaps[1] + gaps[2] * 1.5 + 4 * over + 2 * loft + 20 * depth + 0.00002 * sum(abs(v) for v in c)
            if not thumb:
                # Natural flexion synergy: knuckle and middle joint bend together, no hooked fingers.
                cost += SYNERGY * max(0.0, abs(c[1] - c[0]) - 35)
            if thumb:
                joints = self.hand.world(wrist, trial)
                tip = self.G0.inverted() @ joints["Thumb4L"].translation
                base = self.G0.inverted() @ joints["Thumb2L"].translation
                cost += 0.02 * max(0.0, 0.5 - (tip - base).normalized().x)
            return cost, gaps, -d.min(), over

        if thumb:
            grid = [(a, s, b, e) for a in range(-30, 61, 10) for s in range(-40, 41, 10) for b in range(0, 61, 15) for e in range(0, 61, 15)]
            best = min(((score(c), c) for c in grid), key=lambda r: r[0][0])
            for _ in range(2):
                around = [tuple(v + (k - 1) * 5 for v, k in zip(best[1], ks)) for ks in np.ndindex(3, 3, 3, 3)]
                best = min([best] + [(score(c), c) for c in around], key=lambda r: r[0][0])
        else:
            best = min(((score(c), c) for c in ((a, b) for a in range(-10, 91, 5) for b in range(0, 106, 5))), key=lambda r: r[0][0])
            best = min([best] + [(score((best[1][0] + i, best[1][1] + j)), (best[1][0] + i, best[1][1] + j)) for i in range(-4, 5) for j in range(-4, 5)], key=lambda r: r[0][0])
        (cost, gaps, depth, over), c = best
        report = {"angles": list(c), "padGapsMm": [round(g * 1000, 2) for g in gaps], "maxDepthMm": round(depth * 1000, 2), "sightIntrusionMm": round(over * 1000, 2), "cost": cost}
        return pose(c), report, cost

    @staticmethod
    def intrusion(flesh, grip):
        near = np.abs(flesh[:, 2]) < grip["sight"]["z"]
        return max(0.0, flesh[near, 1].max() - grip["sight"]["y"]) if near.any() else 0.0

    def comfort(self):
        """Wrist extension and deviation (degrees) between forearm and hand axes at the source Hold pose."""
        wrist = self.arm(f"Hold_{self.kind}", 0)["WristL"].to_matrix()
        direction, normal = wrist @ self.local_direction, wrist @ self.local_normal
        forearm = Vector((0, 1, 0))
        along = forearm.dot(direction)
        return (round(math.degrees(math.atan2(forearm.dot(normal), along)), 1),
                round(math.degrees(math.atan2(forearm.dot(direction.cross(normal)), along)), 1))

    def solve(self, grip=None, log=print):
        grip = grip or self.grip
        self.grip = grip
        placed = self.place(grip)
        if placed is None:
            raise ValueError(f"Palm cannot rest on the {self.kind} fore-end")
        self.wrist_local, self.wrist_rotation, slide = placed
        wrist = self.wrist_world(self.wrist_local, self.wrist_rotation)
        rotations, total = {}, 0.0
        report = {"wrist": [round(v, 4) for v in self.wrist_local], "palmSlide": round(slide, 4)}
        for digit in DIGITS:
            pose, report[digit], cost = self.digit(wrist, rotations, digit, grip)
            rotations.update(pose)
            total += cost
            log(digit, report[digit])
        self.finger_rotations = rotations
        report["wristExtensionDegrees"], report["wristDeviationDegrees"] = self.comfort()
        report["cost"] = total
        self.report = report
        return report

    def arm(self, clip, time):
        """Left-arm and digit local rotations for one source sample."""
        sample = self.clips.sample(clip, time)
        world = self.skeleton.world(sample)
        G = self.gun_world(clip, time, world)
        # Bounded clavicle protraction: swing the shoulder joint toward the muzzle.
        clavicle = world["UpperArmL"].translation - world["ShoulderL"].translation
        axis = clavicle.cross(G.to_3x3() @ Vector((1, 0, 0))).normalized()
        shoulder = Matrix.Rotation(math.radians(self.grip.get("protract", 0)), 3, axis) @ world["ShoulderL"].to_3x3().normalized()
        clavicle_local = (world["Chest"].to_3x3().normalized().inverted() @ shoulder).to_quaternion().normalized()
        sample.setdefault("ShoulderL", {})["rotation"] = xyzw(clavicle_local)
        world = self.skeleton.world(sample)
        scale = world["WristL"].to_scale()[0]
        target = Matrix.LocRotScale(G @ self.wrist_local, (G.to_3x3().normalized() @ self.wrist_rotation).to_quaternion(), Vector((scale,) * 3))
        shoulder = world["UpperArmL"].translation
        elbow0 = world["LowerArmL"].translation
        a = self.lengths["LowerArmL"] * scale
        b = self.lengths["WristL"] * scale
        goal = target.translation
        axis = goal - shoulder
        distance = axis.length
        if not abs(a - b) + 1e-4 < distance < a + b - 1e-4:
            raise ValueError(f"Grip outside arm reach at {clip} {time}: {distance} of {a + b}")
        axis.normalize()
        cos = (a * a + distance * distance - b * b) / (2 * a * distance)
        pole = elbow0 - shoulder
        pole = (pole - pole.project(axis)).normalized()
        down = G.to_3x3() @ Vector((0, -1, 0))
        down = (down - down.project(axis)).normalized()
        drop = min(math.radians(self.grip.get("elbowDrop", 0)), pole.angle(down))
        pole = Matrix.Rotation(drop, 3, pole.cross(down).normalized()) @ pole if drop > 0 else pole
        elbow = shoulder + axis * a * cos + pole * a * math.sqrt(max(0.0, 1 - cos * cos))
        upper0 = world["UpperArmL"].to_3x3().normalized()
        lower0 = world["LowerArmL"].to_3x3().normalized()
        upper = swing(upper0.col[1], elbow - shoulder) @ upper0
        lower = upper @ upper0.inverted() @ lower0
        lower = swing(lower.col[1], goal - elbow) @ lower
        hand = target.to_3x3().normalized()
        rest_twist = twist_angle(self.skeleton.rest["WristL"], Vector((0, 1, 0)))
        relative = (lower.inverted() @ hand).to_quaternion()
        lower = lower @ Matrix.Rotation(twist_angle(relative, Vector((0, 1, 0))) - rest_twist, 3, "Y")
        parent = world["ShoulderL"].to_3x3().normalized()
        out = {
            "ShoulderL": clavicle_local,
            "UpperArmL": (parent.inverted() @ upper).to_quaternion().normalized(),
            "LowerArmL": (upper.inverted() @ lower).to_quaternion().normalized(),
            "WristL": (lower.inverted() @ hand).to_quaternion().normalized(),
        }
        out.update(getattr(self, "finger_rotations", {}))
        return out

    def overrides(self, clip, time):
        return {b: {"rotation": xyzw(q)} for b, q in self.arm(clip, time).items()}


def hash_values(values):
    flat = [float(v) for row in values for v in row]
    return hashlib.sha256(struct.pack("<" + "f" * len(flat), *flat)).hexdigest()


def write(kind, authoring):
    source = authoring.actions
    clips = [f"Hold_{kind}", f"Shoot_{kind}"]
    changed = set(ARM) | set(authoring.finger_rotations)
    document = {
        "asset": {"version": "2.0", "generator": "Blender offline long-gun grip authoring"},
        "nodes": [{k: copy.deepcopy(v) for k, v in n.items() if k in ("name", "children", "translation", "rotation", "scale", "matrix")} for n in source.doc["nodes"]],
        "scenes": copy.deepcopy(source.doc["scenes"]),
        "scene": source.doc.get("scene", 0),
        "animations": [],
    }
    arrays, receipts = [], []
    for clip in source.doc["animations"]:
        if clip["name"] not in clips:
            continue
        out = {"name": clip["name"], "channels": [], "samplers": []}
        cache = {}
        for channel in clip["channels"]:
            sampler = clip["samplers"][channel["sampler"]]
            times = source.accessor(sampler["input"])
            values = source.accessor(sampler["output"])
            bone = source.doc["nodes"][channel["target"]["node"]].get("name")
            owned = bone in changed and channel["target"]["path"] == "rotation"
            receipt = {"clip": clip["name"], "bone": bone, "path": channel["target"]["path"], "inputSHA256": hash_values(times), "sourceOutputSHA256": hash_values(values), "permittedChange": owned}
            if owned:
                authored = []
                previous = None
                for (t,) in times:
                    if t not in cache:
                        cache[t] = authoring.arm(clip["name"], float(t))
                    q = cache[t][bone].copy()
                    if previous is not None and q.dot(previous) < 0:
                        q.negate()
                    previous = q
                    authored.append(xyzw(q))
                values = np.array(authored)
            receipt["outputSHA256"] = hash_values(values)
            if not owned and receipt["outputSHA256"] != receipt["sourceOutputSHA256"]:
                raise ValueError("Grip authoring modified an unowned channel")
            receipts.append(receipt)
            index = len(arrays)
            arrays.extend([(times, 1), (values, values.shape[1])])
            out["channels"].append({"target": {"node": channel["target"]["node"], "path": channel["target"]["path"]}, "sampler": len(out["samplers"])})
            out["samplers"].append({"input": index, "output": index + 1, "interpolation": sampler.get("interpolation", "LINEAR")})
        document["animations"].append(out)
    inputs = []
    for doc in (source, authoring.gun.doc, authoring.player):
        inputs.extend({"path": str(f.relative_to(ROOT)), "sha256": hashlib.sha256(f.read_bytes()).hexdigest()} for f in doc.files)
    document["extras"] = {"sourceInputs": inputs, "changedBones": sorted(changed), "authoring": "Offline analytic two-bone left-arm retarget to a gun-fixed palm frame; native hinge-only digit flexion solved against skinned flesh; no runtime IK", "grip": GRIPS[kind], "report": authoring.report, "preservationReceipt": receipts}
    blob = bytearray()
    document["accessors"], document["bufferViews"] = [], []
    for array, width in arrays:
        offset = len(blob)
        flat = np.asarray(array, dtype=np.float32).ravel()
        blob.extend(flat.tobytes())
        document["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob) - offset})
        accessor = {"bufferView": len(document["bufferViews"]) - 1, "componentType": 5126, "count": len(array), "type": {1: "SCALAR", 3: "VEC3", 4: "VEC4"}[width]}
        if width == 1:
            accessor.update({"min": [float(flat.min())], "max": [float(flat.max())]})
        document["accessors"].append(accessor)
    document["buffers"] = [{"byteLength": len(blob)}]
    raw = json.dumps(document, separators=(",", ":")).encode()
    raw += b" " * (-len(raw) % 4)
    blob.extend(b"\x00" * (-len(blob) % 4))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    path = OUTPUT / f"{kind}.glb"
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 28 + len(raw) + len(blob)) + struct.pack("<II", len(raw), 0x4E4F534A) + raw + struct.pack("<II", len(blob), 0x004E4942) + blob)
    print("WROTE", path)
    return path


def validate(kind, authoring, path, rate=120):
    """Sample the baked clips between keys: hand drift against the gun, flesh depth and palm contact."""
    baked = Clips(Doc(path))
    hand = authoring.hand
    palm = authoring.contact
    out = {}
    for clip in (f"Hold_{kind}", f"Shoot_{kind}"):
        end = max(baked.times(clip))
        worst = {"driftMm": 0.0, "turnDegrees": 0.0, "fleshDepthMm": 0.0, "palmGapMm": 0.0}
        for t in np.linspace(0, end, int(round(end * rate)) + 1):
            world = authoring.skeleton.world(baked.sample(clip, float(t)))
            G = authoring.gun_world(clip, float(t), world)
            target = G @ authoring.wrist_local
            turn = (G.to_3x3().normalized() @ authoring.wrist_rotation).to_quaternion().rotation_difference(world["WristL"].to_quaternion())
            mats = authoring.skin.matrices(world)
            flesh = authoring.skin.deform(mats, hand.subset)
            inverse = np.array(G.inverted())
            local = flesh @ inverse[:3, :3].T + inverse[:3, 3]
            d = authoring.gun.signed(local)
            worst["driftMm"] = max(worst["driftMm"], (target - world["WristL"].translation).length / G.to_scale()[0] * 1000)
            worst["turnDegrees"] = max(worst["turnDegrees"], math.degrees(abs(turn.angle if turn.angle <= math.pi else 2 * math.pi - turn.angle)))
            worst["fleshDepthMm"] = max(worst["fleshDepthMm"], -d.min() * 1000)
            worst["palmGapMm"] = max(worst["palmGapMm"], max(0.0, d[palm].min()) * 1000)
        out[clip] = {k: round(v, 2) for k, v in worst.items()}
    return out


def main():
    kinds = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else list(GRIPS)
    for kind in kinds:
        authoring = Authoring(kind)
        authoring.solve()
        path = write(kind, authoring)
        authoring.report["validation"] = validate(kind, authoring, path)
        print("VALIDATION", json.dumps(authoring.report["validation"]))
        write(kind, authoring)


if __name__ == "__main__":
    main()
