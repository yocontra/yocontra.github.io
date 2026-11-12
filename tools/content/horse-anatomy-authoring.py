"""Author the horse's anatomical body, rig and clips.

Blender --background --factory-startup --python tools/content/horse-anatomy-authoring.py

Sculpts a quarter-horse body from signed-distance muscle masses over a horse skeleton (scapula, humerus, forearm,
cannon, pastern and hoof; femur, tibia, hock), skins it, keys idles, a spook and speed-matched gaits, and
writes tools/art/characters/horse.gltf. animal-authoring.py then fits tack and hair cards and bakes the coat.
Coordinates are Blender's: +x is the horse's left, -y is forward, +z is up; the hooves stand on z = 0.
"""

import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

ROOT = Path(globals().get("OUT_WEST_ROOT") or Path(__file__).resolve().parents[2])
ART = ROOT / "tools/art/characters"
FPS = 30


# ---------------------------------------------------------------- skeleton


def side(name, s):
    return name.replace("#", "L" if s > 0 else "R")


def mirror(p, s):
    return Vector((p[0] * s, p[1], p[2]))


# Joint landmarks for the left side; the right mirrors x.
J = {
    "root": (0, -0.1, 1.2),
    "lumbar": (0, 0.08, 1.4),
    "sacrum": (0, 0.56, 1.46),
    "tailhead": (0, 0.8, 1.42),
    "thorax": (0, -0.3, 1.42),
    "withers": (0, -0.52, 1.44),
    "neckbase": (0, -0.74, 1.32),
    "neck1": (0, -0.86, 1.5),
    "neck2": (0, -0.98, 1.7),
    "poll": (0, -1.12, 1.9),
    "muzzle": (0, -1.5, 1.44),
    "jaw": (0, -1.2, 1.72),
    "chin": (0, -1.47, 1.37),
    "ear": (0.065, -1.15, 1.98),
    "ear_mid": (0.085, -1.14, 2.06),
    "ear_tip": (0.1, -1.13, 2.15),
    "scapula": (0.15, -0.5, 1.4),
    "shoulder": (0.19, -0.8, 1.11),
    "elbow": (0.2, -0.58, 0.86),
    "knee": (0.19, -0.6, 0.48),
    "fetlock": (0.18, -0.6, 0.21),
    "coronet": (0.18, -0.645, 0.085),
    "toe": (0.18, -0.705, 0.0),
    "hip": (0.19, 0.6, 1.17),
    "stifle": (0.22, 0.42, 0.9),
    "hock": (0.18, 0.78, 0.55),
    "hfetlock": (0.17, 0.77, 0.21),
    "hcoronet": (0.17, 0.725, 0.085),
    "htoe": (0.17, 0.67, 0.0),
}
J = {k: Vector(v) for k, v in J.items()}
TAIL = [Vector(p) for p in ((0, 0.8, 1.42), (0, 0.86, 1.38), (0, 0.91, 1.3), (0, 0.94, 1.2), (0, 0.96, 1.06), (0, 0.97, 0.88), (0, 0.98, 0.7), (0, 0.99, 0.52))]


def bones():
    """(name, parent, head, tail) in the rest pose."""
    out = [
        ("Body", None, J["root"], J["root"] + Vector((0, -0.25, 0))),
        ("Back", "Body", J["lumbar"], J["sacrum"]),
        ("Hips", "Back", J["sacrum"], J["sacrum"] + Vector((0, 0.3, -0.12))),
        ("Torso", "Body", J["lumbar"] + Vector((0, -0.02, 0)), J["thorax"]),
        ("Torso2", "Torso", J["thorax"], J["withers"]),
        ("Torso3", "Torso2", J["withers"], J["neckbase"]),
        ("Neck1", "Torso3", J["neckbase"], J["neck1"]),
        ("Neck2", "Neck1", J["neck1"], J["neck2"]),
        ("Neck3", "Neck2", J["neck2"], J["poll"]),
        ("Head", "Neck3", J["poll"], J["muzzle"]),
        ("Jaw", "Head", J["jaw"], J["chin"]),
    ]
    for s in (1, -1):
        out += [
            (side("Ear1#", s), "Head", mirror(J["ear"], s), mirror(J["ear_mid"], s)),
            (side("Ear2#", s), side("Ear1#", s), mirror(J["ear_mid"], s), mirror(J["ear_tip"], s)),
            (side("FrontShoulder#", s), "Torso2", mirror(J["scapula"], s), mirror(J["shoulder"], s)),
            (side("FrontUpperLeg#", s), side("FrontShoulder#", s), mirror(J["shoulder"], s), mirror(J["elbow"], s)),
            (side("FrontLowerLeg#", s), side("FrontUpperLeg#", s), mirror(J["elbow"], s), mirror(J["knee"], s)),
            (side("FrontCannon#", s), side("FrontLowerLeg#", s), mirror(J["knee"], s), mirror(J["fetlock"], s)),
            (side("FrontPastern#", s), side("FrontCannon#", s), mirror(J["fetlock"], s), mirror(J["coronet"], s)),
            (side("FrontHoof#", s), side("FrontPastern#", s), mirror(J["coronet"], s), mirror(J["toe"], s)),
            (side("BackUpperLeg#", s), "Hips", mirror(J["hip"], s), mirror(J["stifle"], s)),
            (side("BackLowerLeg#", s), side("BackUpperLeg#", s), mirror(J["stifle"], s), mirror(J["hock"], s)),
            (side("BackCannon#", s), side("BackLowerLeg#", s), mirror(J["hock"], s), mirror(J["hfetlock"], s)),
            (side("BackPastern#", s), side("BackCannon#", s), mirror(J["hfetlock"], s), mirror(J["hcoronet"], s)),
            (side("BackHoof#", s), side("BackPastern#", s), mirror(J["hcoronet"], s), mirror(J["htoe"], s)),
        ]
    parent = "Hips"
    for k in range(len(TAIL) - 1):
        out.append((f"Tail{k + 1}", parent, TAIL[k], TAIL[k + 1]))
        parent = f"Tail{k + 1}"
    return out


# ---------------------------------------------------------------- sculpt


class Field:
    """A signed distance field on a voxel grid, built by smooth unions of anatomical primitives."""

    def __init__(self, lo, hi, h):
        self.lo, self.h = np.array(lo, np.float32), h
        self.shape = tuple(int(math.ceil((b - a) / h)) + 1 for a, b in zip(lo, hi))
        self.d = np.full(self.shape, 1.0, np.float32)

    def region(self, lo, hi):
        a = np.clip(np.floor((np.array(lo) - self.lo) / self.h).astype(int), 0, np.array(self.shape) - 1)
        b = np.clip(np.ceil((np.array(hi) - self.lo) / self.h).astype(int) + 1, 0, np.array(self.shape))
        sl = tuple(slice(i, j) for i, j in zip(a, b))
        axes = [self.lo[k] + self.h * np.arange(a[k], b[k], dtype=np.float32) for k in range(3)]
        return sl, np.meshgrid(*axes, indexing="ij")

    def apply(self, dist, lo, hi, k, op="union"):
        sl, (x, y, z) = self.region(np.array(lo) - k, np.array(hi) + k)
        if x.size == 0:
            return
        b = dist(x, y, z)
        a = self.d[sl]
        if op == "union":
            h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
            self.d[sl] = b * (1 - h) + a * h - k * h * (1 - h)
        else:
            h = np.clip(0.5 - 0.5 * (a + b) / k, 0, 1)
            self.d[sl] = a * (1 - h) + (-b) * h + k * h * (1 - h)

    def ellipsoid(self, c, r, k, along=None, op="union"):
        c, r = Vector(c), Vector(r)
        rot = frame(Vector(along)) if along is not None else Quaternion()
        m = np.array(rot.to_matrix().transposed(), np.float32)
        reach = max(r)

        def dist(x, y, z):
            p = np.stack([x - c.x, y - c.y, z - c.z], -1) @ m.T
            k0 = np.linalg.norm(p / np.array(r, np.float32), axis=-1)
            k1 = np.linalg.norm(p / np.array(r, np.float32) ** 2, axis=-1)
            return k0 * (k0 - 1) / np.maximum(k1, 1e-6)

        self.apply(dist, c - Vector((reach,) * 3), c + Vector((reach,) * 3), k, op)

    def cone(self, a, b, ra, rb, k, flat=1.0, op="union"):
        """A round cone a->b; flat < 1 narrows it laterally (x) for blade-like limbs."""
        a, b = Vector(a), Vector(b)
        reach = max(ra, rb)

        def dist(x, y, z):
            px, py, pz = (x - a.x) / flat, y - a.y, z - a.z
            bx, by, bz = (b.x - a.x) / flat, b.y - a.y, b.z - a.z
            l2 = bx * bx + by * by + bz * bz
            rr = ra - rb
            a2 = l2 - rr * rr
            il2 = 1.0 / l2
            yv = px * bx + py * by + pz * bz
            zv = yv - l2
            qx, qy, qz = px * l2 - bx * yv, py * l2 - by * yv, pz * l2 - bz * yv
            x2 = qx * qx + qy * qy + qz * qz
            y2 = yv * yv * l2
            z2 = zv * zv * l2
            kk = np.sign(rr) * rr * rr * x2
            out = np.where(
                np.sign(zv) * a2 * z2 > kk,
                np.sqrt(x2 + z2) * il2 - rb,
                np.where(np.sign(yv) * a2 * y2 < kk, np.sqrt(x2 + y2) * il2 - ra, (np.sqrt(x2 * a2 * il2) + yv * rr) * il2 - ra),
            )
            return out * min(1.0, flat)

        lo = Vector([min(a[i], b[i]) - reach for i in range(3)])
        hi = Vector([max(a[i], b[i]) + reach for i in range(3)])
        self.apply(dist, lo, hi, k, op)

    def chain(self, points, radii, k, flat=1.0):
        for i in range(len(points) - 1):
            self.cone(points[i], points[i + 1], radii[i], radii[i + 1], k, flat)

    def torus(self, c, axis, major, minor, k, op="union"):
        c = Vector(c)
        m = np.array(frame(Vector(axis)).to_matrix().transposed(), np.float32)

        def dist(x, y, z):
            p = np.stack([x - c.x, y - c.y, z - c.z], -1) @ m.T
            q = np.sqrt(p[..., 0] ** 2 + p[..., 2] ** 2) - major
            return np.sqrt(q * q + p[..., 1] ** 2) - minor

        reach = major + minor
        self.apply(dist, c - Vector((reach,) * 3), c + Vector((reach,) * 3), k, op)

    def mesh(self, name):
        """Naive surface nets: one vertex per sign-changing cell, one quad per sign-changing edge."""
        d = self.d
        inside = d < 0
        nx, ny, nz = d.shape
        acc = np.zeros((nx - 1, ny - 1, nz - 1, 3), np.float32)
        cnt = np.zeros((nx - 1, ny - 1, nz - 1), np.float32)
        for axis in range(3):
            a = d
            b = np.roll(d, -1, axis)
            sl = [slice(None)] * 3
            sl[axis] = slice(0, d.shape[axis] - 1)
            a, b = a[tuple(sl)], b[tuple(sl)]
            cross = (a < 0) != (b < 0)
            t = np.where(cross, a / np.where(cross, a - b, 1), 0).astype(np.float32)
            grid = np.indices(a.shape, dtype=np.float32)
            grid[axis] += t
            pos = np.moveaxis(grid, 0, -1) * cross[..., None]
            others = [k for k in range(3) if k != axis]
            for o1 in (0, 1):
                for o2 in (0, 1):
                    s = [slice(None)] * 3
                    for o, k in ((o1, others[0]), (o2, others[1])):
                        s[k] = slice(o, o + (nx, ny, nz)[k] - 1)
                    s[axis] = slice(0, (nx, ny, nz)[axis] - 1)
                    acc += pos[tuple(s)]
                    cnt += cross[tuple(s)]
        active = cnt > 0
        index = np.full(active.shape, -1, np.int64)
        index[active] = np.arange(int(active.sum()))
        verts = acc[active] / cnt[active][:, None]
        verts = verts * self.h + self.lo
        faces = []
        for axis in range(3):
            a = inside
            b = np.roll(inside, -1, axis)
            change = (a != b)
            sl = [slice(None)] * 3
            sl[axis] = slice(0, d.shape[axis] - 1)
            others = [k for k in range(3) if k != axis]
            for k in others:
                sl[k] = slice(1, d.shape[k] - 1)
            change = change[tuple(sl)]
            flip = inside[tuple(sl)]
            idx = np.argwhere(change)
            idx[:, others[0]] += 1
            idx[:, others[1]] += 1
            flips = flip[change]

            def cell(o1, o2):
                q = idx.copy()
                q[:, others[0]] -= o1
                q[:, others[1]] -= o2
                return index[q[:, 0], q[:, 1], q[:, 2]]

            quad = np.stack([cell(1, 1), cell(0, 1), cell(0, 0), cell(1, 0)], -1)
            parity = axis == 1
            quad = np.where((flips != parity)[:, None], quad, quad[:, ::-1])
            faces.append(quad)
        faces = np.concatenate(faces)
        me = bpy.data.meshes.new(name)
        me.vertices.add(len(verts))
        me.vertices.foreach_set("co", verts.astype(np.float32).ravel())
        me.loops.add(len(faces) * 4)
        me.loops.foreach_set("vertex_index", faces.astype(np.int32).ravel())
        me.polygons.add(len(faces))
        me.polygons.foreach_set("loop_start", np.arange(0, len(faces) * 4, 4, dtype=np.int32))
        me.update()
        me.validate()
        return me


def frame(d):
    """Quaternion turning local +y onto d while keeping local +x near world +x (the lateral axis)."""
    y = d.normalized()
    x = Vector((1, 0, 0))
    x = x - y * x.dot(y)
    if x.length < 1e-4:
        x = Vector((0, 0, 1)) - y * y.z
    x.normalize()
    z = x.cross(y)
    return Matrix((x, y, z)).transposed().to_quaternion()


EYE = Vector((0.098, -1.285, 1.8))
EYE_AXIS = Vector((0.92, -0.33, 0.18)).normalized()
EYE_RADIUS = 0.024
# The globe sits back in the socket so the lids, not the sphere, make the silhouette.
EYE_BALL = EYE - EYE_AXIS * 0.008


def sculpt(h=0.008):
    f = Field((-0.36, -1.72, -0.02), (0.36, 1.08, 2.1), h)
    both = (1, -1)
    # Trunk: ribcage barrel, deep chest, belly, loin, topline and withers.
    f.ellipsoid((0, -0.18, 1.12), (0.28, 0.52, 0.3), 0.1)
    f.ellipsoid((0, -0.5, 1.07), (0.23, 0.2, 0.31), 0.12)
    f.ellipsoid((0, 0.05, 0.98), (0.21, 0.38, 0.16), 0.15)
    f.ellipsoid((0, 0.32, 1.2), (0.26, 0.3, 0.24), 0.15)
    f.chain([(0, -0.48, 1.46), (0, 0.02, 1.39), (0, 0.5, 1.45)], [0.08, 0.1, 0.11], 0.12)
    f.ellipsoid((0, -0.44, 1.46), (0.055, 0.17, 0.07), 0.08)
    for s in both:
        # Breast: twin pectorals with a cleft between the forelegs.
        f.ellipsoid((s * 0.075, -0.71, 1.02), (0.085, 0.1, 0.16), 0.06)
        # Hindquarters: gluteals, point of hip, buttock, quadriceps, hamstrings, gaskin.
        f.ellipsoid((s * 0.13, 0.56, 1.33), (0.13, 0.28, 0.15), 0.08)
        f.ellipsoid((s * 0.19, 0.4, 1.36), (0.05, 0.07, 0.05), 0.1)
        f.ellipsoid((s * 0.1, 0.82, 1.22), (0.095, 0.1, 0.15), 0.08)
        f.ellipsoid((s * 0.17, 0.62, 1.06), (0.11, 0.19, 0.18), 0.1)
        f.cone((s * 0.19, 0.48, 1.2), (s * 0.225, 0.43, 0.95), 0.12, 0.07, 0.07, flat=0.8)
        f.cone((s * 0.12, 0.8, 1.2), (s * 0.17, 0.74, 0.82), 0.1, 0.065, 0.06, flat=0.85)
        f.ellipsoid((s * 0.215, 0.44, 0.92), (0.045, 0.055, 0.055), 0.05)
        f.cone((s * 0.2, 0.58, 0.88), (s * 0.18, 0.76, 0.62), 0.088, 0.045, 0.06, flat=0.68)
        f.cone((s * 0.18, 0.84, 0.62), (s * 0.18, 0.75, 0.86), 0.022, 0.04, 0.05)
        # Hock, point of hock, hind cannon and tendon, fetlock, ergot and pastern.
        f.ellipsoid((s * 0.18, 0.78, 0.55), (0.04, 0.055, 0.055), 0.03)
        f.cone((s * 0.18, 0.8, 0.58), (s * 0.18, 0.845, 0.62), 0.03, 0.024, 0.03)
        f.cone((s * 0.18, 0.78, 0.5), (s * 0.17, 0.77, 0.23), 0.034, 0.031, 0.02, flat=0.85)
        f.cone((s * 0.175, 0.808, 0.47), (s * 0.17, 0.795, 0.24), 0.017, 0.019, 0.015)
        f.ellipsoid((s * 0.17, 0.778, 0.2), (0.036, 0.042, 0.036), 0.03)
        f.ellipsoid((s * 0.17, 0.81, 0.18), (0.018, 0.02, 0.018), 0.015)
        f.cone((s * 0.17, 0.775, 0.19), (s * 0.17, 0.73, 0.095), 0.03, 0.034, 0.015)
        # Shoulder: scapula plate over the ribs, point of shoulder, triceps, arm, elbow.
        f.cone((s * 0.13, -0.5, 1.38), (s * 0.165, -0.75, 1.13), 0.11, 0.09, 0.08, flat=0.6)
        f.ellipsoid((s * 0.16, -0.8, 1.09), (0.07, 0.07, 0.08), 0.06)
        f.cone((s * 0.16, -0.67, 1.06), (s * 0.18, -0.53, 0.9), 0.12, 0.07, 0.06, flat=0.75)
        f.cone((s * 0.17, -0.8, 1.05), (s * 0.19, -0.63, 0.86), 0.07, 0.055, 0.05)
        f.ellipsoid((s * 0.18, -0.51, 0.88), (0.035, 0.035, 0.045), 0.03)
        # Forearm, knee and accessory carpal, front cannon and tendon, fetlock, ergot, pastern.
        f.cone((s * 0.19, -0.6, 0.86), (s * 0.19, -0.6, 0.52), 0.09, 0.045, 0.05, flat=0.8)
        f.ellipsoid((s * 0.19, -0.6, 0.48), (0.04, 0.045, 0.05), 0.025)
        f.ellipsoid((s * 0.19, -0.56, 0.49), (0.02, 0.02, 0.026), 0.02)
        f.cone((s * 0.19, -0.605, 0.44), (s * 0.18, -0.6, 0.23), 0.033, 0.03, 0.02, flat=0.85)
        f.cone((s * 0.185, -0.572, 0.42), (s * 0.18, -0.572, 0.24), 0.015, 0.017, 0.015)
        f.ellipsoid((s * 0.18, -0.597, 0.2), (0.035, 0.041, 0.035), 0.03)
        f.ellipsoid((s * 0.18, -0.562, 0.18), (0.017, 0.018, 0.017), 0.015)
        f.cone((s * 0.18, -0.6, 0.19), (s * 0.18, -0.64, 0.095), 0.029, 0.033, 0.015)
    # Neck: deep and flat-sided at the base, crest arching to the poll, brachiocephalics below.
    f.chain([(0, -0.6, 1.22), (0, -0.82, 1.42), (0, -0.96, 1.6), (0, -1.08, 1.76)], [0.28, 0.2, 0.15, 0.115], 0.1, flat=0.6)
    f.chain([(0, -0.46, 1.47), (0, -0.78, 1.67), (0, -0.98, 1.85), (0, -1.1, 1.95)], [0.07, 0.065, 0.055, 0.045], 0.1, flat=0.8)
    for s in both:
        f.cone((s * 0.06, -0.82, 1.14), (s * 0.04, -1.07, 1.65), 0.06, 0.04, 0.06)
    f.ellipsoid((0, -1.08, 1.68), (0.065, 0.06, 0.07), 0.06)
    # Head: cranium, jowls, flat face, muzzle, nostrils, lips, jaw line, brows and eye sockets.
    f.ellipsoid((0, -1.17, 1.88), (0.085, 0.1, 0.085), 0.05)
    f.cone((0, -1.25, 1.85), (0, -1.46, 1.53), 0.075, 0.055, 0.04, flat=1.05)
    f.ellipsoid((0, -1.5, 1.44), (0.06, 0.066, 0.068), 0.05)
    f.cone((0, -1.2, 1.74), (0, -1.45, 1.46), 0.11, 0.062, 0.05, flat=0.72)
    f.ellipsoid((0, -1.53, 1.395), (0.048, 0.04, 0.03), 0.02)
    f.ellipsoid((0, -1.48, 1.36), (0.04, 0.05, 0.03), 0.03)
    for s in both:
        f.ellipsoid((s * 0.06, -1.2, 1.69), (0.052, 0.115, 0.1), 0.06, along=(0, -0.6, -0.8))
        f.ellipsoid((s * 0.037, -1.535, 1.46), (0.026, 0.03, 0.03), 0.02)
        f.cone((s * 0.035, -1.2, 1.66), (s * 0.025, -1.44, 1.39), 0.035, 0.026, 0.04)
        f.ellipsoid((s * 0.08, -1.26, 1.845), (0.03, 0.04, 0.025), 0.03)
        f.ellipsoid((s * 0.058, -1.15, 1.965), (0.025, 0.025, 0.03), 0.03)
    for s in both:
        eye = mirror(EYE, s)
        axis = mirror(EYE_AXIS, s)
        f.ellipsoid(eye - axis * 0.004, (EYE_RADIUS + 0.002,) * 3, 0.006, op="subtract")
        f.torus(eye - axis * 0.006, axis, EYE_RADIUS + 0.001, 0.007, 0.012)
        f.ellipsoid((s * 0.045, -1.558, 1.462), (0.009, 0.016, 0.012), 0.008, along=(s * 0.4, -0.7, -0.1), op="subtract")
    f.ellipsoid((0, -1.535, 1.374), (0.05, 0.045, 0.003), 0.004, op="subtract")
    # Tail dock.
    f.cone((0, 0.79, 1.42), (0, 0.93, 1.12), 0.055, 0.03, 0.05)
    return f


# ---------------------------------------------------------------- parts

REGION = {"coat": 0.0, "hair": 1 / 3, "hoof": 2 / 3, "eye": 1.0}
CREST = [Vector(p) for p in ((0, -0.46, 1.52), (0, -0.78, 1.72), (0, -0.98, 1.9), (0, -1.1, 1.99))]


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def crest_height(y):
    """The top of the neck's crest at y, or None outside the mane's run."""
    for a, b in zip(CREST, CREST[1:]):
        if b.y <= y <= a.y:
            t = (y - a.y) / (b.y - a.y)
            return a.z + (b.z - a.z) * t
    return None


def link(name, me):
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def loft(bm, rings, cap_top=True, cap_bottom=True):
    verts = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings[0])
    for a, b in zip(verts, verts[1:]):
        for i in range(n):
            bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    if cap_top:
        bm.faces.new(verts[0][::-1])
    if cap_bottom:
        bm.faces.new(verts[-1])
    return verts


def hoof_mesh():
    """Hoof capsules: the wall slopes from the coronet band to a flared bearing edge; hinds are narrower."""
    bm = bmesh.new()
    for s in (1, -1):
        for coronet, toe, width in ((J["coronet"], J["toe"], 1.0), (J["hcoronet"], J["htoe"], 0.92)):
            rings = []
            top = coronet.z + 0.012
            for k in range(9):
                t = k / 8
                z = top * (1 - t) + 0.002 * t
                cy = coronet.y + (toe.y - coronet.y) * 0.55 * t
                rx = (0.04 + 0.022 * t ** 0.8) * width
                ry = 0.046 + 0.019 * t ** 0.8
                ring = []
                for i in range(20):
                    a = 2 * math.pi * i / 20
                    heel = max(0.0, math.cos(a)) ** 2
                    zz = z + heel * 0.025 * (1 - t) - heel * 0.004
                    ring.append(Vector((s * coronet.x + rx * math.sin(a), cy + ry * math.cos(a) * (1 - 0.12 * heel), max(0.0, zz))))
                rings.append(ring)
            loft(bm, rings)
    me = bpy.data.meshes.new("Hooves")
    bm.to_mesh(me)
    bm.free()
    return link("Hooves", me)


def eye_mesh():
    bm = bmesh.new()
    for s in (1, -1):
        geom = bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=EYE_RADIUS)
        axis = mirror(EYE_AXIS, s)
        rot = Vector((0, 0, 1)).rotation_difference(axis).to_matrix().to_4x4()
        squash = Matrix.Diagonal((1.0, 1.0, 0.85, 1.0))
        bmesh.ops.transform(bm, matrix=Matrix.Translation(mirror(EYE_BALL, s)) @ rot @ squash, verts=geom["verts"])
    me = bpy.data.meshes.new("Eyes")
    bm.to_mesh(me)
    bm.free()
    return link("Eyes", me)


def ear_mesh():
    """Cupped ears opening forward and out; the inner skin is flagged so the coat can darken it."""
    bm = bmesh.new()
    inner = set()
    for s in (1, -1):
        base, tip = mirror(J["ear"], s) + Vector((0, 0, -0.03)), mirror(J["ear_tip"], s)
        up = (tip - base).normalized()
        front = mirror(Vector((0.45, -0.88, 0.1)), s)
        front = (front - up * front.dot(up)).normalized()
        across = up.cross(front)
        length = (tip - base).length
        outer_rows, inner_rows = [], []
        for k in range(13):
            u = k / 12
            w = (0.046 * (1 - u ** 2.4) + 0.003) * (0.8 + 0.2 * smoothstep(0.0, 0.3, u))
            cup = 0.024 * (1 - u) ** 0.8
            o_row, i_row = [], []
            for j in range(9):
                v = j / 8 * 2 - 1
                p = base + up * length * u + across * w * v - front * cup * (1 - v * v)
                o_row.append(p)
                i_row.append(p + front * (0.006 * (1 - 0.6 * u)) * (1 - abs(v) ** 6))
            outer_rows.append(o_row)
            inner_rows.append(i_row)
        ov = [[bm.verts.new(p) for p in row] for row in outer_rows]
        iv = [[bm.verts.new(p) for p in row] for row in inner_rows]
        for k in range(12):
            for j in range(8):
                quad = (ov[k][j], ov[k + 1][j], ov[k + 1][j + 1], ov[k][j + 1])
                bm.faces.new(quad if s > 0 else quad[::-1])
                quad = (iv[k][j], iv[k][j + 1], iv[k + 1][j + 1], iv[k + 1][j])
                face = bm.faces.new(quad if s > 0 else quad[::-1])
                inner.add(face)
        for k in range(12):
            for j in (0, 8):
                quad = (ov[k][j], iv[k][j], iv[k + 1][j], ov[k + 1][j])
                bm.faces.new(quad if (s > 0) == (j == 0) else quad[::-1])
        for j in range(8):
            quad = (ov[0][j], ov[0][j + 1], iv[0][j + 1], iv[0][j])
            bm.faces.new(quad if s > 0 else quad[::-1])
    bmesh.ops.recalc_face_normals(bm, faces=[f for f in bm.faces])
    me = bpy.data.meshes.new("Ears")
    flags = [f in inner for f in bm.faces]
    bm.to_mesh(me)
    bm.free()
    layer = me.attributes.new("inner", "FLOAT", "FACE")
    layer.data.foreach_set("value", [float(f) for f in flags])
    return link("Ears", me)


def body_mesh(h, triangles):
    f = sculpt(h)
    me = f.mesh("HorseBody")
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for _ in range(2):
        bmesh.ops.smooth_vert(bm, verts=bm.verts, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.to_mesh(me)
    bm.free()
    ob = link("HorseBody", me)
    dense = sum(len(p.vertices) - 2 for p in me.polygons)
    mod = ob.modifiers.new("decimate", "DECIMATE")
    mod.ratio = triangles / dense
    mod.use_symmetry = True
    mod.symmetry_axis = "X"
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return ob


def regions(ob, kind):
    """Colour attribute: r muzzle, g eye ring / inner ear / iris, b region code."""
    me = ob.data
    col = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    values = []
    for v in me.vertices:
        p = v.co
        r = g = 0.0
        code = REGION["coat"]
        if kind == "body":
            q = Vector(((p.x) / 0.085, (p.y + 1.5) / 0.12, (p.z - 1.41) / 0.11))
            r = 1 - smoothstep(0.75, 1.1, q.length)
            eye = min((p - mirror(EYE, s)).length for s in (1, -1))
            g = 1 - smoothstep(0.028, 0.05, eye)
            top = crest_height(p.y)
            if top is not None and abs(p.x) < 0.03 + 0.02 * smoothstep(-0.6, -1.0, p.y) and p.z > top - 0.05:
                code = REGION["hair"]
            if p.y > 0.84 and p.z < 1.36 and abs(p.x) < 0.07:
                code = REGION["hair"]
        elif kind == "hoof":
            code = REGION["hoof"]
        elif kind == "eye":
            s = 1 if p.x > 0 else -1
            g = (p - mirror(EYE_BALL, s)).normalized().dot(mirror(EYE_AXIS, s))
            code = REGION["eye"]
        values += [r, g, code, 1.0]
    col.data.foreach_set("color", values)
    if kind == "ear":
        inner = me.attributes["inner"].data
        data = col.data
        for poly in me.polygons:
            if inner[poly.index].value:
                for v in poly.vertices:
                    data[v].color = (0.0, 1.0, REGION["coat"], 1.0)
    me.color_attributes.active_color = col


# ---------------------------------------------------------------- rig


def armature():
    data = bpy.data.armatures.new("HorseRig")
    ob = link("AnimalArmature", data)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode="EDIT")
    for name, parent, head, tail in bones():
        eb = data.edit_bones.new(name)
        eb.head, eb.tail = head, tail
        d = (tail - head).normalized()
        lateral = Vector((1, 0, 0))
        eb.align_roll(lateral.cross(d) if abs(d.x) < 0.9 else Vector((0, 0, 1)))
        if parent:
            eb.parent = data.edit_bones[parent]
            eb.use_connect = (eb.parent.tail - head).length < 1e-5
    bpy.ops.object.mode_set(mode="OBJECT")
    return ob


def skin(rig, body, parts):
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    # Ears and hooves are separate shells; keep their bones off the body skin.
    groups = body.vertex_groups
    head = groups.get("Head") or groups.new(name="Head")
    for v in body.data.vertices:
        stray = 0.0
        for g in list(v.groups):
            name = groups[g.group].name
            if name.startswith("Ear"):
                stray += g.weight
                groups[g.group].remove([v.index])
        if stray:
            head.add([v.index], stray, "ADD")
    for ob, assign in parts:
        for v in ob.data.vertices:
            for name, w in assign(v.co):
                group = ob.vertex_groups.get(name) or ob.vertex_groups.new(name=name)
                group.add([v.index], w, "REPLACE")
        ob.parent = rig
        ob.modifiers.new("rig", "ARMATURE").object = rig


def hoof_weights(p):
    return [(("Front" if p.y < 0 else "Back") + "Hoof" + ("L" if p.x > 0 else "R"), 1.0)]


def ear_weights(p):
    s = 1 if p.x > 0 else -1
    base, tip = mirror(J["ear"], s), mirror(J["ear_tip"], s)
    t = (p - base).dot(tip - base) / (tip - base).length_squared
    head = 1 - smoothstep(-0.15, 0.12, t)
    tip_w = smoothstep(0.35, 0.7, t) * (1 - head)
    side_name = "L" if s > 0 else "R"
    out = [("Head", head), (f"Ear1{side_name}", 1 - head - tip_w), (f"Ear2{side_name}", tip_w)]
    return [(n, w) for n, w in out if w > 1e-4]


# ---------------------------------------------------------------- pose solving
# Legs are solved in the sagittal (y, z) plane of armature space: hooves are planted on z = 0 in stance
# and fly an arc in swing; x follows the leg from its top joint to the hoof.

LEGS = {
    "LF": ("Front", 1),
    "RF": ("Front", -1),
    "LH": ("Back", 1),
    "RH": ("Back", -1),
}
FRONT_CHAIN = ["FrontShoulder#", "FrontUpperLeg#", "FrontLowerLeg#", "FrontCannon#", "FrontPastern#", "FrontHoof#"]
HIND_CHAIN = ["BackUpperLeg#", "BackLowerLeg#", "BackCannon#", "BackPastern#", "BackHoof#"]
FRONT_JOINTS = ["scapula", "shoulder", "elbow", "knee", "fetlock", "coronet", "toe"]
HIND_JOINTS = ["hip", "stifle", "hock", "hfetlock", "hcoronet", "htoe"]


def v2(p):
    return Vector((p.y, p.z))


def rot2(v, degrees):
    a = math.radians(degrees)
    c, s = math.cos(a), math.sin(a)
    return Vector((v.x * c - v.y * s, v.x * s + v.y * c))


def angle2(a, b):
    """Signed angle from a to b, degrees."""
    return math.degrees(math.atan2(a.x * b.y - a.y * b.x, a.dot(b)))


def ik2(a, target, l1, l2, bend):
    d = target - a
    dist = min(max(d.length, abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4)
    cos_a = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)
    mid = a + rot2(d.normalized(), bend * math.degrees(math.acos(max(-1.0, min(1.0, cos_a))))) * l1
    return mid, d.length - (l1 + l2)


class Leg:
    def __init__(self, key):
        kind, s = LEGS[key]
        self.key, self.kind, self.s = key, kind, s
        names = FRONT_JOINTS if kind == "Front" else HIND_JOINTS
        self.rest = [mirror(J[n], s) for n in names]
        self.rest2 = [v2(p) for p in self.rest]
        self.lengths = [(b - a).length for a, b in zip(self.rest2, self.rest2[1:])]
        self.bones = [side(n, s) for n in (FRONT_CHAIN if kind == "Front" else HIND_CHAIN)]
        r = self.rest2
        if kind == "Front":
            self.knee_rest = angle2(r[3] - r[2], r[4] - r[3])
        else:
            self.stifle_rest = angle2(r[1] - r[0], r[2] - r[1])
            self.hock_rest = angle2(r[2] - r[1], r[3] - r[2])
        self.fetlock_rest = angle2(r[-3] - r[-4], r[-2] - r[-3])
        self.coffin_rest = angle2(r[-2] - r[-3], r[-1] - r[-2])

    @property
    def toe(self):
        return self.rest[-1]

    def ground(self, toe, breakover, load):
        """Coronet and fetlock from a planted toe: breakover tips the hoof up onto its toe, load sinks the fetlock."""
        r = self.rest2
        coronet = toe + rot2(r[-2] - r[-1], breakover)
        fetlock = coronet + rot2(r[-3] - r[-2], breakover - load)
        return fetlock, coronet

    def upper(self, top, fetlock, knee, girdle):
        """Joints above the fetlock. Front: scapula swing + knee flex. Hind: stifle and hock flex together."""
        r, L = self.rest2, self.lengths
        if self.kind == "Front":
            sweep = angle2(r[4] - r[0], fetlock - top)
            shoulder = top + rot2(girdle, 0.4 * sweep) * L[0]
            forearm = Vector((0, -1))
            cannon = rot2(forearm, self.knee_rest + knee)
            compound = forearm * L[2] + cannon * L[3]
            offset = angle2(compound, forearm)
            elbow, miss = ik2(shoulder, fetlock, L[1], compound.length, 1)
            fore = rot2((fetlock - elbow).normalized(), offset)
            knee_p = elbow + fore * L[2]
            return [top, shoulder, elbow, knee_p, fetlock], miss
        hock = self.hock_rest
        for _ in range(8):
            tibia = Vector((0, -1))
            compound = tibia * L[1] + rot2(tibia, hock) * L[2]
            offset = angle2(compound, tibia)
            stifle, miss = ik2(top, fetlock, L[0], compound.length, -1)
            tib = rot2((fetlock - stifle).normalized(), offset)
            stifle_angle = angle2(stifle - top, tib)
            hock = self.hock_rest - 1.15 * (stifle_angle - self.stifle_rest) - knee
        hock_p = stifle + tib * L[1]
        return [top, stifle, hock_p, fetlock], miss


class Rig:
    def __init__(self, ob):
        self.ob = ob
        self.order = [name for name, *_ in bones()]
        self.rest = {b.name: b.matrix_local.copy() for b in ob.data.bones}
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in ob.data.bones}
        self.legs = {k: Leg(k) for k in LEGS}
        self.miss = 0.0

    def fk(self, basis):
        pose = {}
        for name in self.order:
            par = self.parent[name]
            local = basis.get(name, Matrix.Identity(4))
            if par:
                pose[name] = pose[par] @ self.rest[par].inverted() @ self.rest[name] @ local
            else:
                pose[name] = self.rest[name] @ local
        return pose

    def to_basis(self, pose, name, desired):
        par = self.parent[name]
        frame_ = (pose[par] @ self.rest[par].inverted() @ self.rest[name]) if par else self.rest[name]
        return frame_.inverted() @ desired

    def aim(self, name, head, tail):
        """Armature-space matrix for a bone at head pointing at tail, keeping its rest roll."""
        rest = self.rest[name].to_3x3()
        q = rest.col[1].normalized().rotation_difference((tail - head).normalized())
        return Matrix.Translation(head) @ (q.to_matrix() @ rest).to_4x4()

    def leg_top(self, pose, leg):
        name = leg.bones[0]
        par = self.parent[name]
        m = pose[par] @ self.rest[par].inverted() @ self.rest[name]
        return m.translation, m

    def solve_leg(self, pose, leg, state):
        """state: ('stance', toe3, breakover, load) or ('swing', fetlock3, knee, fetlock_flex, coffin_flex)."""
        top3, frame_ = self.leg_top(pose, leg)
        top = v2(top3)
        girdle = None
        if leg.kind == "Front":
            girdle = v2(frame_.to_3x3() @ Vector((0, 1, 0)))
            girdle = Vector((girdle.x, girdle.y)).normalized()
        if state[0] == "stance":
            toe3, breakover, load = state[1:]
            fetlock, coronet = leg.ground(v2(toe3), breakover, load)
            joints, miss = leg.upper(top, fetlock, 0.0, girdle)
            chain = joints + [coronet, v2(toe3)]
            foot_x = toe3.x
        else:
            f3, knee, flex, coffin = state[1:]
            joints, miss = leg.upper(top, v2(f3), knee, girdle)
            cannon = (joints[-1] - joints[-2]).normalized()
            pastern = rot2(cannon, leg.fetlock_rest + flex)
            coronet = joints[-1] + pastern * leg.lengths[-2]
            hoof = rot2(pastern, leg.coffin_rest + coffin)
            chain = joints + [coronet, coronet + hoof * leg.lengths[-1]]
            foot_x = f3.x
        self.miss = max(self.miss, miss)
        pts = []
        for k, p in enumerate(chain):
            t = min(1.0, max(0.0, (top3.z - p.y) / max(top3.z, 0.1)))
            x = leg.rest[k].x + (top3.x - leg.rest[0].x) * (1 - t) + (foot_x - leg.rest[-1].x) * t
            pts.append(Vector((x, p.x, p.y)))
        return pts

    def relative(self, pts, leg):
        r = [v2(p) for p in pts]
        return angle2(r[-3] - r[-4], r[-2] - r[-3]) - leg.fetlock_rest, angle2(r[-2] - r[-3], r[-1] - r[-2]) - leg.coffin_rest

    def pose(self, basis, legs):
        """basis: bone -> local matrix for the trunk, neck, head and tail; legs: key -> state. Returns basis for all bones."""
        pose = self.fk(basis)
        out = dict(basis)
        for key, leg in self.legs.items():
            pts = self.solve_leg(pose, leg, legs[key])
            for k, name in enumerate(leg.bones):
                desired = self.aim(name, pts[k], pts[k + 1])
                local = self.to_basis(pose, name, desired)
                local = local.to_quaternion().to_matrix().to_4x4()
                out[name] = local
                pose[name] = (pose[self.parent[name]] @ self.rest[self.parent[name]].inverted() @ self.rest[name]) @ local
        return out


def turn(x=0.0, y=0.0, z=0.0):
    """Local bone rotation in degrees: x bends in the sagittal plane, z swings sideways, y twists."""
    return Matrix.Rotation(math.radians(z), 4, "Z") @ Matrix.Rotation(math.radians(y), 4, "Y") @ Matrix.Rotation(math.radians(x), 4, "X")


# ---------------------------------------------------------------- clips


def wave(t, period, phase=0.0):
    return math.sin(2 * math.pi * (t / period + phase))


def pulse(t, start, length):
    """0 -> 1 -> 0 over [start, start + length] with smooth shoulders."""
    if t <= start or t >= start + length:
        return 0.0
    return math.sin(math.pi * (t - start) / length) ** 2


def body_matrix(rig, dx=0.0, dy=0.0, dz=0.0, pitch=0.0, roll=0.0, yaw=0.0):
    rest = rig.rest["Body"]
    r = Matrix.Rotation(math.radians(yaw), 4, "Z") @ Matrix.Rotation(math.radians(roll), 4, "Y") @ Matrix.Rotation(math.radians(pitch), 4, "X")
    m = Matrix.Translation(rest.translation + Vector((dx, dy, dz))) @ r @ rest.to_3x3().to_4x4()
    return rest.inverted() @ m


class Motion:
    """Trunk, neck, head, ear and tail controls at time t. Angles in degrees."""

    def __init__(self):
        self.body = dict(dx=0.0, dy=0.0, dz=0.0, pitch=0.0, roll=0.0, yaw=0.0)
        self.bones = {}

    def add(self, name, x=0.0, y=0.0, z=0.0):
        a = self.bones.get(name, (0.0, 0.0, 0.0))
        self.bones[name] = (a[0] + x, a[1] + y, a[2] + z)

    def basis(self, rig):
        out = {name: turn(*v) for name, v in self.bones.items()}
        out["Body"] = body_matrix(rig, **self.body)
        return out


def breathe(m, t, rate=4.2, depth=1.0):
    b = wave(t, rate)
    m.body["dz"] += 0.003 * depth * b
    m.add("Torso2", x=0.25 * depth * b)
    m.add("Torso", x=-0.2 * depth * b)


def neck(m, pitch=0.0, yaw=0.0, roll=0.0, head=None):
    """Spread a neck gesture over the three neck bones; head pitch counters to keep the face near vertical."""
    for name, share in (("Neck1", 0.45), ("Neck2", 0.33), ("Neck3", 0.22)):
        m.add(name, x=pitch * share, z=yaw * share, y=roll * share)
    m.add("Head", x=(-0.35 * pitch if head is None else head), z=yaw * 0.3)


def tail(m, t, swish=0.0, sway=1.0, lift=0.0, clamp=0.0, period=3.1):
    for k in range(7):
        lag = k * 0.06
        side = sway * 2.5 * wave(t - lag * period, period) + swish * (6 + 3 * k) * math.sin(math.pi * min(1.0, k / 6 + 0.1)) * 1.0
        m.add(f"Tail{k + 1}", x=lift * (1.0 if k < 2 else 0.3) - clamp * (1.0 if k < 3 else 0.2) + (2.0 if k > 1 else 0.0) * 0.0, z=side)


def swish(t, start, length=0.9):
    """A fly-swatting sweep: out to one side, a whip back across and settle."""
    if t <= start or t >= start + length:
        return 0.0
    u = (t - start) / length
    return math.sin(2 * math.pi * u) * math.sin(math.pi * u)


def ears(m, left=(0.0, 0.0), right=(0.0, 0.0)):
    """(back, out) per ear: back rotates the opening toward the tail, out tips the ear sideways."""
    for name, (back, out), s in (("L", left, 1), ("R", right, -1)):
        m.add(f"Ear1{name}", x=back * 0.4, z=s * out * 0.6, y=s * back * 0.9)
        m.add(f"Ear2{name}", x=back * 0.2, z=s * out * 0.4)


def flick(t, start, length=0.45):
    return pulse(t, start, length)


class Clip:
    loop = True
    speed = 0.0
    turn_rate = 0.0

    def __init__(self, name, duration):
        self.name, self.duration = name, duration

    def motion(self, t):
        return Motion()

    def legs(self, rig, t):
        return {key: ("stance", leg.toe.copy(), 0.0, 2.0) for key, leg in rig.legs.items()}


class Gait(Clip):
    """A footfall-timed gait: stance hooves stay planted while the body travels at `speed`."""

    def __init__(self, name, period, speed, duty, touchdown, lift, knee, flex, load, reach=None, bob=0.0, pitch=0.0, nod=0.0, pump=0.0, spine=0.0, lower=0.0, phase=0.0, turn_rate=0.0):
        super().__init__(name, period)
        self.speed, self.turn_rate = speed, turn_rate
        self.duty, self.touchdown, self.lift, self.knee, self.flex, self.load = duty, touchdown, lift, knee, flex, load
        self.reach = reach or {}
        self.bob, self.pitch, self.nod, self.pump, self.spine, self.lower, self.phase = bob, pitch, nod, pump, spine, lower, phase

    def leg_phase(self, key, t):
        return ((t / self.duration) - self.touchdown[key]) % 1.0

    def stance_toe(self, rig, key, u):
        leg = rig.legs[key]
        travel = self.speed * self.duration * self.duty
        toe = leg.toe.copy()
        toe.y += self.reach.get(key[1], 0.0) - travel / 2 + travel * u
        if self.turn_rate:
            pivot = Vector((0, 0.72, 0))
            angle = math.radians(self.turn_rate * self.duration * self.duty * (u - 0.5))
            toe = pivot + Matrix.Rotation(-angle, 3, "Z") @ (toe - pivot)
        return toe

    def stance(self, rig, key, u):
        breakover = 55 * smoothstep(0.78, 1.0, u) - 6 * (1 - smoothstep(0.0, 0.1, u))
        return ("stance", self.stance_toe(rig, key, u), breakover, self.load * math.sin(math.pi * u))

    def legs(self, rig, t):
        out = {}
        for key, leg in rig.legs.items():
            p = self.leg_phase(key, t)
            if p < self.duty:
                out[key] = self.stance(rig, key, p / self.duty)
                continue
            s = (p - self.duty) / (1 - self.duty)
            t_off = t - (p - self.duty) * self.duration
            t_on = t + (1 - p) * self.duration
            ends = []
            for when, u in ((t_off, 1.0), (t_on, 0.0)):
                pose = rig.fk(self.motion(when % self.duration).basis(rig))
                pts = rig.solve_leg(pose, leg, self.stance(rig, key, u))
                # Express the fetlock relative to the leg's top so body motion between the ends carries it.
                top, _ = rig.leg_top(pose, leg)
                ends.append((pts[-3] - top, rig.relative(pts, leg)))
            pose = rig.fk(self.motion(t % self.duration).basis(rig))
            top, _ = rig.leg_top(pose, leg)
            e = smoothstep(0.0, 1.0, s)
            fetlock = top + ends[0][0].lerp(ends[1][0], e)
            front = leg.kind == "Front"
            fetlock.z += self.lift[0 if front else 1] * math.sin(math.pi * min(1.0, s * 1.15)) ** 1.2
            bend = math.sin(math.pi * min(1.0, s * 1.1)) ** 0.9
            knee = self.knee[0 if front else 1] * bend
            flex = ends[0][1][0] + (ends[1][1][0] - ends[0][1][0]) * e + self.flex * bend
            coffin = ends[0][1][1] + (ends[1][1][1] - ends[0][1][1]) * e + self.flex * 0.3 * bend
            out[key] = ("swing", fetlock, knee, flex, coffin)
        return out

    def motion(self, t):
        m = Motion()
        c = 2 * math.pi * (t / self.duration + self.phase)
        m.body["dz"] = -self.lower + self.bob * math.cos(2 * c if self.name in ("Walk", "Trot") else c)
        m.body["pitch"] = self.pitch * math.sin(c)
        m.body["roll"] = (1.2 if self.name == "Walk" else 0.6) * math.sin(c)
        m.add("Back", x=self.spine * math.sin(c + 0.6))
        m.add("Torso", x=-self.spine * 0.5 * math.sin(c + 0.6))
        neck(m, pitch=self.nod * math.sin((2 if self.name == "Walk" else 1) * c + 1.0) + self.pump * math.sin(c + 2.2) + 1.6 * max(0.0, self.speed - 3.0), head=-2.0 * max(0.0, self.speed - 3.0))
        ears(m, (-8 if self.speed > 4 else 0, 4), (-8 if self.speed > 4 else 0, 4))
        tail(m, t, sway=0.0, lift=min(14.0, self.speed * 2.2))
        for k in range(7):
            m.add(f"Tail{k + 1}", z=(2.5 + k * 0.6) * math.sin(c - k * 0.5) * (1.0 if self.name == "Walk" else 0.5), x=(0.0 if self.speed < 4 else 4.0 * math.sin(c - k * 0.45)))
        if self.turn_rate:
            m.add("Neck1", z=-math.copysign(8, self.turn_rate))
            m.add("Neck2", z=-math.copysign(6, self.turn_rate))
        return m


class Idle(Clip):
    """Standing: breathing, ears working, the odd swish; variants rest a hind leg, graze, stamp or doze."""

    def __init__(self, name, duration, kind):
        super().__init__(name, duration)
        self.kind = kind

    def motion(self, t):
        m = Motion()
        k = self.kind
        breathe(m, t, depth=1.4 if k == "doze" else 1.0)
        drift = 0.5 * wave(t, self.duration) + 0.5 * wave(t, self.duration / 2, 0.3)
        if k == "stand":
            neck(m, pitch=2 + 3 * drift, yaw=6 * wave(t, self.duration, 0.1))
            m.body["dy"] = 0.01 * wave(t, self.duration, 0.2)
            ears(m, (40 * flick(t, 1.8, 0.7) + 10 * wave(t, self.duration), 6), (55 * flick(t, 5.0, 0.9) - 25 * flick(t, 6.4, 0.6), 4))
            tail(m, t, swish=0.9 * swish(t, 3.2) - 0.7 * swish(t, 7.0, 0.8))
        elif k == "rest":
            m.body["roll"] = 2.2
            m.body["dz"] = -0.012
            m.add("Hips", y=4.0)
            m.add("Back", z=-2.0)
            neck(m, pitch=10 + 2 * drift, yaw=-5 + 3 * wave(t, self.duration, 0.4))
            ears(m, (30, 18), (25 + 30 * flick(t, 4.1, 0.8), 18))
            tail(m, t, swish=0.7 * swish(t, 5.6), sway=0.6)
        elif k == "doze":
            neck(m, pitch=26 + 2 * drift, head=-4)
            m.body["dz"] = -0.01
            ears(m, (35, 28), (35, 28))
            tail(m, t, sway=0.5, swish=0.5 * swish(t, 4.4, 1.1))
        elif k == "graze":
            down = smoothstep(0.0, 1.2, t) * (1 - smoothstep(self.duration - 1.2, self.duration, t))
            down = max(down, 0.0)
            lift = pulse(t, 3.0, 2.4)
            reach = 1.0 - 0.75 * lift
            neck(m, pitch=(48 + 4 * wave(t, 1.7)) * reach + 8 * lift, head=(26 * reach - 6 * lift), yaw=6 * wave(t, 2.6) * reach)
            m.body["pitch"] = 2.5 * reach
            m.body["dy"] = -0.03 * reach
            m.add("Jaw", x=5 * max(0.0, wave(t, 0.62)))
            ears(m, (20 + 15 * lift, 12), (10 + 40 * flick(t, 1.3, 0.6), 12))
            tail(m, t, swish=0.8 * swish(t, 1.9))
            del down
        elif k == "stamp":
            toss = pulse(t, 2.2, 0.7)
            neck(m, pitch=4 - 22 * toss + 6 * pulse(t, 2.9, 0.5), yaw=12 * math.sin(2 * math.pi * max(0.0, t - 2.4) / 0.35) * pulse(t, 2.4, 0.7))
            m.add("Head", x=-10 * toss)
            ears(m, (-15 * toss + 45 * flick(t, 0.6, 0.5), 4), (-15 * toss, 4))
            tail(m, t, swish=1.0 * swish(t, 1.1, 0.75) - 0.8 * swish(t, 4.2, 0.8))
            m.body["dy"] = 0.012 * pulse(t, 0.7, 0.8)
            m.body["roll"] = -1.5 * pulse(t, 0.7, 0.8)
        return m

    def legs(self, rig, t):
        out = super().legs(rig, t)
        if self.kind == "rest":
            toe = rig.legs["LH"].toe.copy()
            toe.y -= 0.07
            toe.x -= 0.03
            out["LH"] = ("stance", toe, 62.0, 0.0)
        if self.kind == "graze":
            lift = pulse(t, 3.0, 2.4)
            for key in ("LF",):
                toe = rig.legs[key].toe.copy()
                toe.y -= 0.12
                out[key] = ("stance", toe, 0.0, 6.0)
            del lift
        if self.kind == "stamp":
            for key, start in (("RF", 0.7), ("RF", 1.45), ("LH", 4.6)):
                if start < t < start + 0.6:
                    leg = rig.legs[key]
                    s = (t - start) / 0.6
                    pose = rig.fk(self.motion(t).basis(rig))
                    pts = rig.solve_leg(pose, leg, ("stance", leg.toe.copy(), 0.0, 2.0))
                    lift = math.sin(math.pi * s) ** 1.5
                    f = pts[-3] + Vector((0, -0.02 * lift, (0.16 if key[1] == "F" else 0.1) * lift))
                    out[key] = ("swing", f, 70 * lift if key[1] == "F" else 25 * lift, 25 * lift, 10 * lift)
        return out


class Spook(Clip):
    """A gunshot startle: head flies up, ears pin forward then back, the body shies right on planted feet."""

    loop = False

    def motion(self, t):
        m = Motion()
        jolt = smoothstep(0.0, 0.12, t) * (1 - smoothstep(0.55, 1.5, t))
        m.body["dx"] = -0.1 * jolt
        m.body["dz"] = 0.03 * pulse(t, 0.0, 0.35) - 0.02 * jolt
        m.body["roll"] = -3 * jolt
        m.body["yaw"] = 6 * jolt
        m.body["pitch"] = -2.5 * pulse(t, 0.0, 0.5)
        neck(m, pitch=-30 * jolt, yaw=-14 * jolt, head=-8 * jolt)
        ears(m, (-25 * jolt + 30 * pulse(t, 0.7, 0.8), 0), (-25 * jolt + 30 * pulse(t, 0.7, 0.8), 0))
        tail(m, t, clamp=12 * jolt, swish=0.6 * swish(t, 0.9, 0.7))
        return m

    def legs(self, rig, t):
        out = super().legs(rig, t)
        for key, start, dx in (("RF", 0.06, -0.12), ("LF", 0.22, -0.1), ("RF", 0.95, 0.0), ("LF", 1.1, 0.0)):
            if start < t < start + 0.32:
                leg = rig.legs[key]
                s = (t - start) / 0.32
                pose = rig.fk(self.motion(t).basis(rig))
                toe = leg.toe.copy()
                pts = rig.solve_leg(pose, leg, ("stance", toe, 0.0, 2.0))
                lift = math.sin(math.pi * s)
                f = pts[-3] + Vector((dx * (s if start < 0.5 else 1 - s), 0, 0.14 * lift))
                out[key] = ("swing", f, 80 * lift, 30 * lift, 10 * lift)
        return out


def clips():
    lf = {"LH": 0.0, "LF": 0.25, "RH": 0.5, "RF": 0.75}
    return [
        Idle("Idle", 8.0, "stand"),
        Idle("Idle_2", 9.0, "rest"),
        Idle("Idle_Headlow", 7.0, "doze"),
        Idle("Eating", 6.0, "graze"),
        Idle("Idle_Stamp", 6.0, "stamp"),
        Spook("Idle_HitReact_Left", 1.6),
        Gait("Walk", 1.1, 1.6, 0.62, lf, (0.13, 0.1), (62, 18), 55, 6, bob=0.012, pitch=0.8, nod=4, reach={"F": -0.03, "H": 0.0}),
        Gait("Trot", 0.72, 3.6, 0.42, {"LF": 0.0, "RH": 0.0, "RF": 0.5, "LH": 0.5}, (0.2, 0.15), (95, 30), 75, 14, bob=0.028, pitch=0.6, nod=1, reach={"F": -0.05, "H": 0.02}),
        Gait("Canter", 0.62, 5.0, 0.4, {"LH": 0.0, "RH": 0.28, "LF": 0.3, "RF": 0.52}, (0.22, 0.17), (100, 35), 85, 18, bob=0.04, pitch=4.0, pump=7, spine=3, lower=0.06, reach={"F": -0.08, "H": 0.05}),
        Gait("Gallop", 0.46, 9.0, 0.3, {"LH": 0.0, "RH": 0.1, "LF": 0.38, "RF": 0.48}, (0.26, 0.22), (115, 45), 95, 24, bob=0.05, pitch=5.0, pump=10, spine=6, lower=0.1, reach={"F": -0.18, "H": 0.12}),
        Gait("Turn_L", 1.0, 0.0, 0.6, lf, (0.11, 0.07), (55, 15), 45, 4, turn_rate=22.0),
        Gait("Turn_R", 1.0, 0.0, 0.6, lf, (0.11, 0.07), (55, 15), 45, 4, turn_rate=-22.0),
    ]


# ---------------------------------------------------------------- authoring


COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def reduce_keys(doc, out):
    """Drop constant channels and keys that linear interpolation reproduces, then repack the buffer."""
    bin_path = out.with_name(doc["buffers"][0]["uri"])
    blob = bin_path.read_bytes()

    def read(i):
        a = doc["accessors"][i]
        view = doc["bufferViews"][a["bufferView"]]
        n = COMPONENTS[a["type"]]
        start = view.get("byteOffset", 0) + a.get("byteOffset", 0)
        dtype = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[a["componentType"]]
        stride = view.get("byteStride")
        size = np.dtype(dtype).itemsize * n
        if stride and stride != size:
            raw = np.frombuffer(blob, np.uint8, a["count"] * stride, start).reshape(-1, stride)[:, :size]
            return np.frombuffer(raw.tobytes(), dtype).reshape(a["count"], n)
        return np.frombuffer(blob, dtype, a["count"] * n, start).reshape(a["count"], n)

    nodes = doc["nodes"]
    anim_accessors = set()
    replaced = {}
    for animation in doc["animations"]:
        channels = []
        for channel in animation["channels"]:
            sampler = animation["samplers"][channel["sampler"]]
            anim_accessors.update((sampler["input"], sampler["output"]))
            times, values = read(sampler["input"])[:, 0], read(sampler["output"]).astype(np.float64)
            path = channel["target"]["path"]
            node = nodes[channel["target"]["node"]]
            rest = {"scale": [1, 1, 1], "translation": [0, 0, 0], "rotation": [0, 0, 0, 1]}[path]
            rest = np.array(node.get(path, rest))
            tol = 2e-4 if path != "translation" else 1e-4
            if np.abs(values - rest).max() < tol and path != "rotation":
                continue
            if path == "rotation":
                values *= np.where((values @ values[0]) < 0, -1, 1)[:, None]
            keep = [0]
            i = 0
            while i < len(times) - 1:
                j = i + 2
                while j < len(times):
                    span = (times[i + 1 : j] - times[i]) / (times[j] - times[i])
                    guess = values[i] + span[:, None] * (values[j] - values[i])
                    if np.abs(guess - values[i + 1 : j]).max() > tol:
                        break
                    j += 1
                i = j - 1
                keep.append(i)
            replaced[id(sampler)] = (sampler, times[keep], values[keep].astype(np.float32))
            channels.append(channel)
        animation["channels"] = channels
    live = {id(a["samplers"][c["sampler"]]) for a in doc["animations"] for c in a["channels"]}
    for animation in doc["animations"]:
        order = [s for s in animation["samplers"] if id(s) in live]
        index = {id(s): k for k, s in enumerate(animation["samplers"])}
        remap = {index[id(s)]: k for k, s in enumerate(order)}
        for channel in animation["channels"]:
            channel["sampler"] = remap[channel["sampler"]]
        animation["samplers"] = order

    accessors, views, out_blob = [], [], bytearray()
    accessor_map = {}

    def add(data, accessor):
        while len(out_blob) % 4:
            out_blob.append(0)
        views.append({"buffer": 0, "byteOffset": len(out_blob), "byteLength": len(data)})
        out_blob.extend(data)
        accessor = dict(accessor, bufferView=len(views) - 1)
        accessor.pop("byteOffset", None)
        accessors.append(accessor)
        return len(accessors) - 1

    for i, accessor in enumerate(doc["accessors"]):
        if i in anim_accessors:
            continue
        values = read(i)
        accessor_map[i] = add(values.tobytes(), accessor)
    for animation in doc["animations"]:
        for sampler in animation["samplers"]:
            _, times, values = replaced[id(sampler)]
            sampler["input"] = add(
                times.astype(np.float32).tobytes(),
                {"componentType": 5126, "count": len(times), "type": "SCALAR",
                 "min": [float(times.min())], "max": [float(times.max())]},
            )
            sampler["output"] = add(
                values.tobytes(),
                {"componentType": 5126, "count": len(values), "type": ["", "SCALAR", "", "VEC3", "VEC4"][values.shape[1]]},
            )
    for mesh in doc["meshes"]:
        for primitive in mesh["primitives"]:
            primitive["attributes"] = {k: accessor_map[v] for k, v in primitive["attributes"].items()}
            if "indices" in primitive:
                primitive["indices"] = accessor_map[primitive["indices"]]
    for skin in doc.get("skins", []):
        skin["inverseBindMatrices"] = accessor_map[skin["inverseBindMatrices"]]
    doc["accessors"], doc["bufferViews"] = accessors, views
    doc["buffers"][0]["byteLength"] = len(out_blob)
    bin_path.write_bytes(bytes(out_blob))


def animate(rig_ob, clip_list):
    rig = Rig(rig_ob)
    rig_ob.animation_data_create()
    for pb in rig_ob.pose.bones:
        pb.rotation_mode = "QUATERNION"
    report = {}
    for clip in clip_list:
        action = bpy.data.actions.new(clip.name)
        action.use_fake_user = True
        rig_ob.animation_data.action = action
        frames = round(clip.duration * FPS)
        keys = {}
        rig.miss = 0.0
        for f in range(frames + 1):
            t = min(f / FPS, clip.duration) % clip.duration if clip.loop else f / FPS
            if clip.loop and f == frames:
                t = 0.0
            basis = rig.pose(clip.motion(t).basis(rig), clip.legs(rig, t))
            for name in rig.order:
                m = basis.get(name, Matrix.Identity(4))
                q = m.to_quaternion()
                prev = keys.get(name)
                if prev:
                    q.make_compatible(prev[-1][1])
                keys.setdefault(name, []).append((f, q, m.translation.copy()))
        for name, rows in keys.items():
            path = f'pose.bones["{name}"]'
            channels = [("rotation_quaternion", i, [(f, q[i]) for f, q, _ in rows]) for i in range(4)]
            if name == "Body":
                channels += [("location", i, [(f, loc[i]) for f, _, loc in rows]) for i in range(3)]
            for prop, index, points in channels:
                fc = action.fcurve_ensure_for_datablock(rig_ob, f"{path}.{prop}", index=index)
                fc.keyframe_points.add(len(points))
                fc.keyframe_points.foreach_set("co", [c for p in points for c in p])
                for kp in fc.keyframe_points:
                    kp.interpolation = "LINEAR"
        report[clip.name] = round(rig.miss, 3)
    rig_ob.animation_data.action = None
    print("leg reach overshoot per clip (m):", report)
    return report


def author(out=None, triangles=8000, h=0.008):
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob)
    for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.actions):
        for item in list(coll):
            coll.remove(item)
    rig = armature()
    body = body_mesh(h, triangles)
    regions(body, "body")
    parts = [(hoof_mesh(), hoof_weights, "hoof"), (eye_mesh(), lambda p: [("Head", 1.0)], "eye"), (ear_mesh(), ear_weights, "ear")]
    for ob, _, kind in parts:
        regions(ob, kind)
    skin(rig, body, [(ob, fn) for ob, fn, _ in parts])
    bpy.ops.object.select_all(action="DESELECT")
    for ob, _, _ in parts:
        ob.select_set(True)
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    for mod in list(body.modifiers)[1:]:
        body.modifiers.remove(mod)
    bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
    body.data.shade_smooth()
    body.name = "Horse"
    clip_list = clips()
    animate(rig, clip_list)
    if out is None:
        return rig, body
    bpy.context.scene.render.fps = FPS
    bpy.context.scene.render.fps_base = 1.0
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=str(out),
        export_format="GLTF_SEPARATE",
        export_yup=True,
        export_texcoords=False,
        export_normals=True,
        export_materials="NONE",
        export_vertex_color="ACTIVE",
        export_skins=True,
        export_def_bones=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_frame_step=1,
        export_optimize_animation_size=False,
        export_anim_single_armature=True,
        export_reset_pose_bones=True,
        export_extras=False,
    )
    doc = json.loads(Path(out).read_text())
    meta = {clip.name: clip for clip in clip_list}
    for animation in doc.get("animations", []):
        clip = meta.get(animation["name"])
        if clip and (clip.speed or clip.turn_rate):
            animation["extras"] = {k: v for k, v in (("speed", clip.speed), ("turnRate", clip.turn_rate)) if v}
    reduce_keys(doc, Path(out))
    Path(out).write_text(json.dumps(doc, indent=1))
    print("wrote", out)
    return rig, body


if __name__ == "__main__" and not globals().get("STAGE"):
    author(ART / "horse.gltf")
