"""Author textured, hair-carded animals against their canonical native rigs.

Blender --background --factory-startup --python tools/content/animal-authoring.py -- horse

Reads tools/art/characters/<animal>.gltf (rig, clips, body), poses the body from its node defaults,
adds tack and alpha hair cards, bakes procedural PBR maps in Cycles, then inverse-skins every new
vertex back into the canonical bind space. Writes <animal>-parts.glb and animal-textures/<animal>-*.png.
"""

import json
import math
import random
import struct
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform

ROOT = Path(globals().get("OUT_WEST_ROOT") or Path(__file__).resolve().parents[2])
ART = ROOT / "tools/art/characters"
ANIMAL = globals().get("ANIMAL") or (sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "horse")


# ---------------------------------------------------------------- glTF access


class Gltf:
    def __init__(self, path):
        self.g = json.loads(path.read_text())
        self.blob = path.with_suffix(".bin").read_bytes()

    def acc(self, i):
        a = self.g["accessors"][i]
        view = self.g["bufferViews"][a["bufferView"]]
        n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[a["type"]]
        f = {5126: "f", 5123: "H", 5121: "B", 5125: "I"}[a["componentType"]]
        stride = view.get("byteStride", struct.calcsize(f) * n)
        offset = view.get("byteOffset", 0) + a.get("byteOffset", 0)
        rows = [struct.unpack_from("<" + f * n, self.blob, offset + k * stride) for k in range(a["count"])]
        if a.get("normalized"):
            d = {5121: 255.0, 5123: 65535.0}[a["componentType"]]
            rows = [tuple(x / d for x in r) for r in rows]
        return rows

    def local(self, n):
        node = self.g["nodes"][n]
        if "matrix" in node:
            m = node["matrix"]
            return Matrix([m[0:4], m[4:8], m[8:12], m[12:16]]).transposed()
        r = node.get("rotation", [0, 0, 0, 1])
        return (
            Matrix.Translation(Vector(node.get("translation", [0, 0, 0])))
            @ Quaternion((r[3], r[0], r[1], r[2])).to_matrix().to_4x4()
            @ Matrix.Diagonal((*node.get("scale", [1, 1, 1]), 1))
        )

    def skin(self):
        parent = {c: i for i, n in enumerate(self.g["nodes"]) for c in n.get("children", [])}
        cache = {}

        def world(i):
            if i not in cache:
                cache[i] = (world(parent[i]) if i in parent else Matrix.Identity(4)) @ self.local(i)
            return cache[i]

        skin = self.g["skins"][0]
        ibm = self.acc(skin["inverseBindMatrices"])
        mats = [world(n) @ Matrix([m[0:4], m[4:8], m[8:12], m[12:16]]).transposed() for n, m in zip(skin["joints"], ibm)]
        return mats, [self.g["nodes"][n]["name"] for n in skin["joints"]]


def blend(mats, joints, weights):
    m = Matrix(((0.0,) * 4,) * 4)
    for j, w in zip(joints, weights):
        if w > 0:
            m = m + mats[j] * w
    return m


def to_bl(v):
    return Vector((v[0], -v[2], v[1]))


def to_gl(v):
    return Vector((v[0], v[2], -v[1]))


# ---------------------------------------------------------------- scene helpers


def reset():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.actions):
        for item in list(coll):
            coll.remove(item)


def link(name, me, material, skin):
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(material)
    ob["skin"] = skin
    return ob


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


class Body:
    """The canonical body posed by its node defaults, with region and skin lookups."""

    def __init__(self, spec):
        self.gltf = Gltf(ART / f"{ANIMAL}.gltf")
        prim = self.gltf.g["meshes"][0]["primitives"][0]
        attrs = prim["attributes"]
        self.bind = self.gltf.acc(attrs["POSITION"])
        self.bind_normals = self.gltf.acc(attrs["NORMAL"])
        self.joints = self.gltf.acc(attrs["JOINTS_0"])
        self.weights = self.gltf.acc(attrs["WEIGHTS_0"])
        colors = self.gltf.acc(attrs["COLOR_0"])
        index = [i[0] for i in self.gltf.acc(prim["indices"])]
        self.mats, self.names = self.gltf.skin()
        self.posed, normals = [], []
        for p, n, j, w in zip(self.bind, self.bind_normals, self.joints, self.weights):
            m = blend(self.mats, j, w)
            self.posed.append(to_bl(m @ Vector(p)))
            normals.append(to_bl((m.to_3x3().inverted().transposed() @ Vector(n)).normalized()))
        triangles = [index[i : i + 3] for i in range(0, len(index), 3)]
        regions = spec["regions"]
        self.region = []
        for t in triangles:
            key = tuple(round(x, 3) for x in colors[t[0]][:3])
            if key not in regions:
                raise ValueError(f"{ANIMAL}: unmapped body colour {key}")
            self.region.append(regions[key])
        self.skin_faces = [t for t, r in zip(triangles, self.region) if r != "remove"]
        self.skin_region = [r for r in self.region if r != "remove"]
        cut = spec.get("cut", lambda body, face, region: region)
        kept = [(t, cut(self, t, r)) for t, r in zip(self.skin_faces, self.skin_region)]
        kept = [(t, r) for t, r in kept if r]
        self.faces = [t for t, _ in kept]
        self.face_region = [r for _, r in kept]
        me = bpy.data.meshes.new("Body")
        me.from_pydata(self.posed, [], self.faces)
        me.shade_smooth()
        me.normals_split_custom_set_from_vertices(normals)
        for name in spec.get("masks", ("muzzle", "eyering", "blaze")):
            layer = me.attributes.new(name, "FLOAT", "POINT")
            touched = {v for f, r in zip(self.faces, self.face_region) if r == name for v in f}
            for v in touched:
                layer.data[v].value = 1.0
        for poly, region in zip(me.polygons, self.face_region):
            poly.material_index = spec["slots"].index(spec["surface"][region])
        self.mesh = me
        self.bvh = BVHTree.FromPolygons(self.posed, self.faces)

    def dominant(self, face):
        score = {}
        for v in face:
            for j, w in zip(self.joints[v], self.weights[v]):
                score[j] = score.get(j, 0) + w
        return self.names[max(score, key=score.get)]

    def group(self, predicate):
        chosen = [f for f, r in zip(self.skin_faces, self.skin_region) if predicate(self.dominant(f), r)]
        return chosen, BVHTree.FromPolygons(self.posed, chosen)

    def ray(self, origin, direction):
        loc, normal, _, _ = self.bvh.ray_cast(Vector(origin), Vector(direction).normalized())
        if loc is None:
            return None, None
        if normal.dot(Vector(direction)) < 0:
            normal = -normal
        return loc, normal

    def nearest(self, p):
        loc, normal, _, _ = self.bvh.find_nearest(Vector(p))
        return loc, normal


def weights_from(body, faces, tree, p):
    loc, _, i, _ = tree.find_nearest(Vector(p))
    a, b, c = (body.posed[v] for v in faces[i])
    bary = barycentric_transform(loc, a, b, c, Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
    score = {}
    for v, k in zip(faces[i], bary):
        for j, w in zip(body.joints[v], body.weights[v]):
            score[j] = score.get(j, 0) + w * max(0.0, k)
    top = sorted(score.items(), key=lambda kv: -kv[1])[:4]
    total = sum(w for _, w in top) or 1
    joints = [j for j, _ in top] + [0] * (4 - len(top))
    weights = [w / total for _, w in top] + [0.0] * (4 - len(top))
    return joints, weights


# ---------------------------------------------------------------- tack geometry


class Builder:
    """Indexed sheet geometry with per-vertex tack parameters (along, across, border)."""

    def __init__(self):
        self.verts, self.faces, self.params = [], [], []

    def add(self, p, param=(0, 0, 1)):
        self.verts.append(Vector(p))
        self.params.append(param)
        return len(self.verts) - 1

    def grid(self, rows, params, flip=False):
        ids = [[self.add(p, q) for p, q in zip(row, prow)] for row, prow in zip(rows, params)]
        for i in range(len(ids) - 1):
            for j in range(len(ids[0]) - 1):
                quad = [ids[i][j], ids[i][j + 1], ids[i + 1][j + 1], ids[i + 1][j]]
                self.faces.append(quad[::-1] if flip else quad)
        return ids

    def slab(self, outer, inner, params, closed_u=False, underside=True):
        """outer/inner are [i][j] point grids; walls get border=0 so leather edges read as cut edges."""
        self.grid(outer, params)
        if underside:
            self.grid(inner, params, flip=True)
        n, m = len(outer), len(outer[0])
        edges = []
        if not closed_u:
            edges.append([(i, 0) for i in range(n)][::-1])
            edges.append([(i, m - 1) for i in range(n)])
        edges.append([(0, j) for j in range(m)])
        edges.append([(n - 1, j) for j in range(m)][::-1])
        for edge in edges:
            a = [outer[i][j] for i, j in edge]
            b = [inner[i][j] for i, j in edge]
            wall_params = [[(params[i][j][0], params[i][j][1], 0.0) for i, j in edge]] * 2
            self.grid([a, b], wall_params, flip=True)

    def mesh(self, name):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.verts, [], self.faces)
        me.validate()
        me.shade_smooth()
        layer = me.attributes.new("tack", "FLOAT_VECTOR", "POINT")
        for i, q in enumerate(self.params):
            layer.data[i].vector = q
        return me


def blur(grid, passes=2):
    n, m = len(grid), len(grid[0])
    for _ in range(passes):
        out = [row[:] for row in grid]
        for i in range(n):
            for j in range(m):
                acc, k = 0.0, 0
                for di in (-1, 0, 1):
                    for dj in (-1, 0, 1):
                        ii, jj = i + di, j + dj
                        if 0 <= ii < n and 0 <= jj < m:
                            acc += grid[ii][jj]
                            k += 1
                out[i][j] = acc / k
        grid = out
    return grid


def rounded(u, v, half_u, half_v, radius):
    """Map a unit square onto a rounded rectangle so sheet borders stay smooth silhouettes."""
    if abs(u) < 1e-9 and abs(v) < 1e-9:
        return 0.0, 0.0
    d = Vector((u * half_u, v * half_v))
    square = max(abs(u), abs(v))

    def sdf(p):
        q = Vector((abs(p.x) - half_u + radius, abs(p.y) - half_v + radius))
        return Vector((max(q.x, 0), max(q.y, 0))).length + min(max(q.x, q.y), 0) - radius

    direction = d.normalized()
    lo, hi = 0.0, half_u + half_v
    for _ in range(30):
        mid = (lo + hi) / 2
        if sdf(direction * mid) < 0:
            lo = mid
        else:
            hi = mid
    p = direction * lo * square
    return p.x / half_u, p.y / half_v


class Barrel:
    """Rays from the trunk axis give a smooth wrap surface for blankets, skirts and cinches."""

    def __init__(self, body):
        self.body = body

    def center(self, y):
        top, _ = self.body.ray((0, y, 4), (0, 0, -1))
        bottom, _ = self.body.ray((0, y, -1), (0, 0, 1))
        return ((top.z if top else 1.6) + (bottom.z if bottom else 1.0)) / 2

    def point(self, y, angle, offset):
        c = Vector((0, y, self.center(y)))
        d = Vector((math.sin(angle), 0, math.cos(angle)))
        hit, _ = self.body.ray(c, d)
        r = (hit - c).length if hit else 0.25
        return c, d, r + offset

    def sheet(self, y0, y1, a0, a1, ny, na, offset, thickness, shape=None, smooth=2, lift=None):
        centers, dirs, radii = [], [], []
        for i in range(ny + 1):
            row_c, row_d, row_r = [], [], []
            for j in range(na + 1):
                u, v = j / na * 2 - 1, i / ny * 2 - 1
                if shape:
                    u, v = shape(u, v)
                y = y0 + (v + 1) / 2 * (y1 - y0)
                a = a0 + (u + 1) / 2 * (a1 - a0)
                c, d, r = self.point(y, a, 0)
                row_c.append(c)
                row_d.append(d)
                row_r.append(r)
            centers.append(row_c)
            dirs.append(row_d)
            radii.append(row_r)
        radii = blur(radii, smooth)
        outer, inner, params = [], [], []
        for i in range(ny + 1):
            o_row, i_row, p_row = [], [], []
            for j in range(na + 1):
                extra = lift(i / ny, j / na) if lift else 0.0
                c, d, r = centers[i][j], dirs[i][j], radii[i][j] + offset + extra
                o_row.append(c + d * (r + thickness))
                i_row.append(c + d * r)
                along = (y1 - y0) * i / ny
                across = (a1 - a0) * j / na * 0.3
                border = min(i, ny - i) / ny * (y1 - y0), min(j, na - j) / na * (a1 - a0) * 0.3
                p_row.append((along, across, min(border)))
            outer.append(o_row)
            inner.append(i_row)
            params.append(p_row)
        return outer, inner, params


def ribbon(path, normals, width, thickness, builder, closed=False):
    """A strap laid along a surface path: width across the path, thickness along the surface normal."""
    outer, inner, params = [], [], []
    length = 0.0
    for k, (p, n) in enumerate(zip(path, normals)):
        if k:
            length += (p - path[k - 1]).length
        tangent = (path[min(k + 1, len(path) - 1)] - path[max(k - 1, 0)]).normalized()
        side = tangent.cross(n).normalized()
        o_row = [p + n * thickness - side * width / 2, p + n * thickness + side * width / 2]
        i_row = [p - side * width / 2, p + side * width / 2]
        outer.append(o_row)
        inner.append(i_row)
        params.append([(length, 0.0, 0.004), (length, width, 0.004)])
    builder.slab(outer, inner, params, closed_u=False)


def surface_path(body, points, samples, offset):
    """Catmull-Rom through control points, each sample projected back onto the body surface."""
    pts = [Vector(p) for p in points]
    out, normals = [], []
    for s in range(samples + 1):
        t = s / samples * (len(pts) - 1)
        i = min(int(t), len(pts) - 2)
        f = t - i
        p0, p1, p2, p3 = pts[max(i - 1, 0)], pts[i], pts[i + 1], pts[min(i + 2, len(pts) - 1)]
        q = 0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f ** 3)
        loc, normal = body.nearest(q)
        if (q - loc).dot(normal) < 0 and (q - loc).length > 0.002:
            normal = -normal
        outer = loc + normal * offset
        out.append(outer if (q - loc).length < offset else q)
        normals.append(normal)
    return out, normals


def torus(builder, center, axis, major, minor, segments=20, sides=8):
    axis = Vector(axis).normalized()
    ref = Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((1, 0, 0))
    u = axis.cross(ref).normalized()
    v = axis.cross(u)
    ids = []
    for i in range(segments):
        a = 2 * math.pi * i / segments
        ring = u * math.cos(a) + v * math.sin(a)
        row = []
        for j in range(sides):
            b = 2 * math.pi * j / sides
            p = Vector(center) + ring * (major + minor * math.cos(b)) + axis * minor * math.sin(b)
            row.append(builder.add(p, (a * major, b * minor, 1.0)))
        ids.append(row)
    for i in range(segments):
        for j in range(sides):
            a, b = ids[i][j], ids[(i + 1) % segments][j]
            c, d = ids[(i + 1) % segments][(j + 1) % sides], ids[i][(j + 1) % sides]
            builder.faces.append([a, b, c, d])


def cylinder(builder, start, end, radius, segments=16, cap=True, radius_end=None):
    start, end = Vector(start), Vector(end)
    axis = (end - start).normalized()
    ref = Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((1, 0, 0))
    u = axis.cross(ref).normalized()
    v = axis.cross(u)
    length = (end - start).length
    rings = []
    for k, (c, r) in enumerate(((start, radius), (end, radius_end or radius))):
        rings.append(
            [builder.add(c + (u * math.cos(2 * math.pi * i / segments) + v * math.sin(2 * math.pi * i / segments)) * r, (k * length, 2 * math.pi * r * i / segments, 1.0)) for i in range(segments)]
        )
    for i in range(segments):
        builder.faces.append([rings[0][i], rings[0][(i + 1) % segments], rings[1][(i + 1) % segments], rings[1][i]])
    if cap:
        for k, c, sign in ((0, start, -1), (1, end, 1)):
            r = radius if k == 0 else (radius_end or radius)
            ring = [builder.add(c + (u * math.cos(2 * math.pi * i / segments) + v * math.sin(2 * math.pi * i / segments)) * r, (0, 0, 1.0)) for i in range(segments)]
            centre = builder.add(c, (0, 0, 1.0))
            for i in range(segments):
                tri = [ring[i], ring[(i + 1) % segments], centre]
                builder.faces.append(tri[::-1] if sign < 0 else tri)


def disc(builder, center, normal, radius, thickness):
    n = Vector(normal).normalized()
    cylinder(builder, Vector(center) - n * thickness / 2, Vector(center) + n * thickness / 2, radius, segments=16)


def card(builder, path, normals, width, row, rows):
    """A single alpha hair card; u runs root->tip, v spans one strand row of the hair texture."""
    length = sum((path[k] - path[k - 1]).length for k in range(1, len(path)))
    run = 0.0
    left, right, params = [], [], []
    for k, (p, n) in enumerate(zip(path, normals)):
        if k:
            run += (p - path[k - 1]).length
        tangent = (path[min(k + 1, len(path) - 1)] - path[max(k - 1, 0)]).normalized()
        side = tangent.cross(n).normalized()
        taper = width * (1.0 - 0.35 * run / length)
        left.append(p - side * taper / 2)
        right.append(p + side * taper / 2)
        params.append([(run / length, row / rows, 1.0), (run / length, (row + 1) / rows, 1.0)])
    builder.grid([[a, b] for a, b in zip(left, right)], params)


# ---------------------------------------------------------------- horse tack and hair


def horse_tack(body, barrel, materials, objects):
    torso = "torso"
    # Navajo saddle blanket under a rounded Western skirt.
    b = Builder()
    outer, inner, params = barrel.sheet(-0.64, 0.16, -1.36, 1.36, 20, 26, 0.006, 0.014)
    b.slab(outer, inner, params, underside=False)
    objects.append(link("Blanket", b.mesh("Blanket"), materials["wool"], torso))

    b = Builder()
    outer, inner, params = barrel.sheet(-0.53, 0.09, -1.1, 1.1, 18, 22, 0.024, 0.011, shape=lambda u, v: rounded(u, v, 1.0, 1.0, 0.42))
    b.slab(outer, inner, params, underside=False)
    objects.append(link("Skirt", b.mesh("Skirt"), materials["leather"], torso))

    # Seat with a tall fork and cantle; the lift profile is the saddle tree.
    def lift(v, u):
        fork = 0.085 * (1 - smoothstep(0.0, 0.22, v))
        cantle = 0.11 * smoothstep(0.74, 1.0, v)
        roll = 0.02 * (2 * u - 1) ** 2
        return fork + cantle - roll

    b = Builder()
    outer, inner, params = barrel.sheet(-0.45, 0.03, -0.66, 0.66, 20, 16, 0.036, 0.028, shape=lambda u, v: rounded(u, v, 1.0, 1.0, 0.3), lift=lift)
    b.slab(outer, inner, params, underside=False)
    objects.append(link("Seat", b.mesh("Seat"), materials["leather"], torso))

    fork_top, _ = body.ray((0, -0.43, 4), (0, 0, -1))
    fork_top = Vector((0, -0.425, fork_top.z + 0.036 + 0.028 + 0.08))
    b = Builder()
    cylinder(b, fork_top - Vector((0, 0, 0.03)), fork_top + Vector((0, -0.01, 0.05)), 0.026, radius_end=0.021)
    cylinder(b, fork_top + Vector((0, -0.01, 0.05)), fork_top + Vector((0, -0.013, 0.064)), 0.043, segments=20)
    objects.append(link("Horn", b.mesh("Horn"), materials["darkleather"], torso))

    # Fenders, stirrup leathers and oxbow stirrups on both sides.
    b = Builder()
    stirrups = Builder()
    metal = Builder()
    for side in (-1, 1):
        rows = []
        top_z = barrel.center(-0.25) + 0.12
        drop = 0.46
        for k in range(15):
            t = k / 14
            z = top_z - t * drop
            half = 0.085 - 0.03 * t
            row = []
            for j in range(5):
                y = -0.25 + (j / 2 - 1) * half
                hit, _ = body.ray((side * 2, y, z), (-side, 0, 0))
                row.append((y, z, abs(hit.x) if hit else 0.0, j / 2 * half))
            rows.append(row)
        floor = 0.0
        outer, inner, params = [], [], []
        for k, row in enumerate(rows):
            floor = max(floor, max(r[2] for r in row))
            o_row, i_row, p_row = [], [], []
            width = 2 * (0.085 - 0.03 * k / 14)
            for y, z, _, across in row:
                x = side * (floor + 0.04)
                along = k / 14 * drop
                o_row.append(Vector((x + side * 0.009, y, z)))
                i_row.append(Vector((x, y, z)))
                p_row.append((along, across, min(along, drop - along, across, width - across)))
            outer.append(o_row)
            inner.append(i_row)
            params.append(p_row)
        if side > 0:
            outer, inner, params = ([row[::-1] for row in grid] for grid in (outer, inner, params))
        b.slab(outer, inner, params)
        bottom = Vector((side * (floor + 0.045), -0.25, top_z - drop))
        path = [bottom + Vector((0, 0, -0.02 * k)) for k in range(6)]
        ribbon(path, [Vector((side, 0, 0))] * len(path), 0.05, 0.007, b)
        # Oxbow stirrup: a leather-wrapped rounded loop in the plane across the horse.
        centre = bottom + Vector((0, 0, -0.16))
        loop = []
        for k in range(25):
            a = 2 * math.pi * k / 24
            loop.append(centre + Vector((0.065 * math.sin(a), 0, 0.075 * math.cos(a) - 0.02 * max(0, -math.cos(a)))))
        ribbon(loop, [(p - centre).normalized() for p in loop], 0.06, 0.016, stirrups)
        # Cinch rings and brass conchos.
        c, d, r = barrel.point(-0.37, side * 1.32, 0.03)
        torus(metal, c + d * r, d, 0.034, 0.006)
        for y, a in ((-0.47, 0.98), (0.03, 0.98), (-0.2, 0.62)):
            c, d, r = barrel.point(y, side * a, 0.024 + 0.011 + 0.004)
            disc(metal, c + d * r, d, 0.022, 0.006)
    objects.append(link("Fenders", b.mesh("Fenders"), materials["leather"], torso))
    objects.append(link("Stirrups", stirrups.mesh("Stirrups"), materials["darkleather"], torso))
    objects.append(link("Fittings", metal.mesh("Fittings"), materials["brass"], torso))

    b = Builder()
    outer, inner, params = barrel.sheet(-0.41, -0.33, 1.3, 2 * math.pi - 1.3, 3, 28, 0.004, 0.012)
    b.slab(outer, inner, params, underside=False)
    objects.append(link("Cinch", b.mesh("Cinch"), materials["cinch"], torso))

    # Bedroll behind the cantle with two latigo straps.
    top, _ = body.ray((0, 0.12, 4), (0, 0, -1))
    centre = Vector((0, 0.12, top.z + 0.03 + 0.07))
    b = Builder()
    cylinder(b, centre - Vector((0.3, 0, 0)), centre + Vector((0.3, 0, 0)), 0.07, segments=20)
    objects.append(link("Bedroll", b.mesh("Bedroll"), materials["bedroll"], torso))
    b = Builder()
    for x in (-0.19, 0.19):
        cylinder(b, centre + Vector((x - 0.016, 0, 0)), centre + Vector((x + 0.016, 0, 0)), 0.074, segments=20)
    objects.append(link("Straps", b.mesh("Straps"), materials["darkleather"], torso))


def ring_path(body, centre, axis, start, end, samples, offset):
    axis = Vector(axis).normalized()
    u = Vector((1, 0, 0))
    v = axis.cross(u).normalized()
    path, normals = [], []
    for k in range(samples + 1):
        t = math.radians(start + (end - start) * k / samples)
        d = u * math.cos(t) + v * math.sin(t)
        hit, n = body.ray(centre, d)
        path.append(hit + n * offset)
        normals.append(n)
    return path, normals


def horse_bridle(body, materials, objects):
    head_axis = Vector((0, -0.74, -0.67))
    b = Builder()
    path, normals = ring_path(body, Vector((0, -1.47, 1.765)), head_axis, -180, 180, 48, 0.006)
    ribbon(path, normals, 0.03, 0.007, b)
    crown, crown_n = ring_path(body, Vector((0, -1.17, 1.93)), Vector((0, -0.9, -0.42)), -15, 195, 40, 0.006)
    ribbon(crown, crown_n, 0.028, 0.007, b)
    brow, brow_n = ring_path(body, Vector((0, -1.27, 1.95)), head_axis, 15, 165, 24, 0.008)
    ribbon(brow, brow_n, 0.022, 0.006, b)
    throat, throat_n = ring_path(body, Vector((0, -1.17, 1.93)), Vector((0, -0.6, 0.8)), 195, 345, 24, 0.016)
    ribbon(throat, throat_n, 0.02, 0.006, b)
    metal = Builder()
    bits = []
    for side, end in ((-1, crown[-1]), (1, crown[0])):
        hit, n = body.ray((side * 1, -1.545, 1.665), (-side, 0, 0))
        bit = hit + Vector((side * 0.018, 0, 0))
        bits.append(bit)
        torus(metal, bit, (1, 0, 0), 0.027, 0.0045)
        cheek, cheek_n = surface_path(body, [end, end.lerp(bit, 0.5) + Vector((side * 0.01, 0, 0)), bit + Vector((0, 0.0, 0.03))], 16, 0.007)
        ribbon(cheek, cheek_n, 0.024, 0.007, b)
        rein = [
            bit + Vector((side * 0.012, 0.0, -0.024)),
            Vector((side * 0.075, -1.36, 1.52)),
            Vector((side * 0.17, -1.05, 1.58)),
            Vector((side * 0.19, -0.8, 1.72)),
            Vector((side * 0.08, -0.6, 1.86)),
            Vector((0, -0.55, 1.88)),
        ]
        path, normals = surface_path(body, rein, 40, 0.012)
        normals = [(n if n.length else Vector((side, 0, 0))) for n in normals]
        ribbon(path, normals, 0.02, 0.006, b)
    objects.append(link("Bridle", b.mesh("Bridle"), materials["darkleather"], "head"))
    objects.append(link("Bits", metal.mesh("Bits"), materials["iron"], "head"))


def horse_hair(body, barrel, material, objects, rows):
    rng = random.Random(7)
    mane = Builder()
    for layer, (count, spread, length, fluff) in enumerate(((30, 0.0, 0.3, 0.012), (24, 0.018, 0.24, 0.03))):
        for k in range(count):
            t = (k + rng.random() * 0.6) / count
            y = -1.17 + t * 0.6
            span = length * (0.75 + 0.35 * math.sin(math.pi * min(1, t * 1.3))) * (0.85 + 0.3 * rng.random())
            path, normals = [], []
            for s in range(9):
                f = s / 8
                angle = -(math.radians(8 + layer * 10) + f * span / 0.2)
                c, d, r = barrel.point(y + 0.05 * f, angle, 0.012 + fluff * f + spread)
                path.append(c + d * r)
                normals.append(d)
            card(mane, path, normals, 0.055, rng.randrange(rows), rows)
    for k in range(26):
        y = -1.15 + 0.58 * rng.random()
        span = 0.03 + 0.11 * rng.random() ** 1.5
        lift = math.radians(rng.uniform(2, 14))
        path, normals = [], []
        for s_ in range(5):
            f = s_ / 4
            c, d, r = barrel.point(y + rng.uniform(0.01, 0.05) * f, lift + f * span / 0.2, 0.012 + 0.012 * f)
            path.append(c + d * r)
            normals.append(d)
        card(mane, path, normals, rng.uniform(0.05, 0.1), rng.randrange(rows), rows)
    for k in range(7):
        x = (k - 3) * 0.014
        top, _ = body.ray((x, -1.13 - 0.03 * rng.random(), 4), (0, 0, -1))
        tip = 1.86 + 0.06 * rng.random()
        points = [top + Vector((0, 0, 0.012)), Vector((x * 1.5, -1.3, 2.0)), Vector((x * 2, -1.37, tip))]
        path, normals = surface_path(body, points, 8, 0.014)
        card(mane, path, normals, 0.045, rng.randrange(rows), rows)
    objects.append(link("ManeCards", mane.mesh("ManeCards"), material, "mane"))

    slab = [body.posed[v] for f, r in zip(body.skin_faces, body.skin_region) if r == "hair" for v in f if body.posed[v].y > 0.6]
    zmin, zmax = min(p.z for p in slab), max(p.z for p in slab)
    spine = []
    for k in range(12):
        z0 = zmax - (zmax - zmin) * k / 11
        near = [p for p in slab if abs(p.z - z0) < 0.06]
        spine.append(sum(near, Vector()) / len(near))
    tail = Builder()
    direction = (spine[-1] - spine[-2]).normalized()
    spine = spine + [spine[-1] + direction * 0.06, spine[-1] + direction * 0.12]
    for k in range(34):
        phi = 2 * math.pi * k / 34 + rng.random() * 0.4
        start = 0.05 + 0.25 * rng.random()
        flare = 0.03 + 0.07 * rng.random()
        reach = len(spine) - 1 - rng.randrange(3)
        path, normals = [], []
        for s_ in range(9):
            f = s_ / 8
            t = start + (reach - start) * f
            i = min(int(t), len(spine) - 2)
            base = spine[i].lerp(spine[i + 1], t - i)
            radial = Vector((math.cos(phi), math.sin(phi) * 0.7, 0)) * (0.015 + flare * f ** 0.8)
            path.append(base + radial)
            normals.append(radial.normalized() if k % 3 else Vector((math.cos(phi + 1.2), math.sin(phi + 1.2), 0)))
        card(tail, path, normals, 0.07 + 0.04 * rng.random(), rng.randrange(rows), rows)
    objects.append(link("TailCards", tail.mesh("TailCards"), material, "tail"))


# ---------------------------------------------------------------- procedural surfaces


class Graph:
    def __init__(self, material):
        material.use_nodes = True
        self.nt = material.node_tree
        self.nt.nodes.clear()
        self.out = self.nt.nodes.new("ShaderNodeOutputMaterial")
        self.p = self.n("ShaderNodeTexCoord").outputs["Object"]

    def n(self, kind, **attrs):
        node = self.nt.nodes.new(kind)
        for k, v in attrs.items():
            setattr(node, k, v)
        return node

    def put(self, socket, value):
        if isinstance(value, bpy.types.NodeSocket):
            self.nt.links.new(value, socket)
        elif socket.type == "RGBA" and isinstance(value, (int, float)):
            socket.default_value = (value, value, value, 1)
        elif isinstance(value, (tuple, list)) and socket.type == "RGBA" and len(value) == 3:
            socket.default_value = (*value, 1)
        else:
            socket.default_value = value

    def math(self, op, a, b=0.0, c=0.0, clamp=False):
        node = self.n("ShaderNodeMath", operation=op, use_clamp=clamp)
        for socket, v in zip(node.inputs, (a, b, c)):
            self.put(socket, v)
        return node.outputs[0]

    def vec(self, op, a, b=(0, 0, 0), scale=None):
        node = self.n("ShaderNodeVectorMath", operation=op)
        self.put(node.inputs[0], a)
        self.put(node.inputs[1], b)
        if scale is not None:
            self.put(node.inputs[3], scale)
        return node.outputs["Value" if op in ("LENGTH", "DISTANCE", "DOT_PRODUCT") else "Vector"]

    def mix(self, fac, a, b):
        node = self.n("ShaderNodeMix", data_type="RGBA")
        self.put(node.inputs[0], fac)
        self.put(node.inputs[6], a)
        self.put(node.inputs[7], b)
        return node.outputs[2]

    def scale(self, color, k):
        return self.vec("SCALE", color, scale=k)

    def noise(self, vector, scale, detail=2.0, rough=0.5, distortion=0.0):
        node = self.n("ShaderNodeTexNoise")
        self.put(node.inputs["Vector"], vector)
        self.put(node.inputs["Scale"], scale)
        self.put(node.inputs["Detail"], detail)
        self.put(node.inputs["Roughness"], rough)
        self.put(node.inputs["Distortion"], distortion)
        return node.outputs["Fac"]

    def voronoi(self, vector, scale, feature="F1"):
        node = self.n("ShaderNodeTexVoronoi", feature=feature)
        self.put(node.inputs["Vector"], vector)
        self.put(node.inputs["Scale"], scale)
        return node.outputs["Distance"]

    def smooth(self, a, b, x):
        node = self.n("ShaderNodeMapRange", interpolation_type="SMOOTHSTEP")
        self.put(node.inputs["Value"], x)
        self.put(node.inputs["From Min"], a)
        self.put(node.inputs["From Max"], b)
        return node.outputs["Result"]

    def xyz(self, vector):
        node = self.n("ShaderNodeSeparateXYZ")
        self.put(node.inputs[0], vector)
        return node.outputs

    def attr(self, name, kind="Fac"):
        return self.n("ShaderNodeAttribute", attribute_name=name).outputs[kind]

    def stretch(self, factors):
        return self.vec("MULTIPLY", self.p, factors)

    def finish(self, color, rough, metal, height, strength):
        bsdf = self.n("ShaderNodeBsdfPrincipled")
        self.put(bsdf.inputs["Base Color"], color)
        self.put(bsdf.inputs["Roughness"], rough)
        self.put(bsdf.inputs["Metallic"], metal)
        bump = self.n("ShaderNodeBump")
        self.put(bump.inputs["Strength"], strength)
        self.put(bump.inputs["Distance"], 0.004)
        self.put(bump.inputs["Height"], height)
        self.put(bsdf.inputs["Normal"], bump.outputs["Normal"])
        emit = self.n("ShaderNodeEmission")
        self.sockets = {"albedo": color, "rough": rough, "metal": metal}
        self.emit, self.bsdf = emit, bsdf
        self.target = self.n("ShaderNodeTexImage")
        self.nt.nodes.active = self.target
        self.nt.links.new(bsdf.outputs[0], self.out.inputs["Surface"])

    def show(self, role):
        if role in ("normal", "ao", "shaded"):
            self.nt.links.new(self.bsdf.outputs[0], self.out.inputs["Surface"])
        else:
            self.put(self.emit.inputs["Color"], self.sockets[role])
            self.nt.links.new(self.emit.outputs[0], self.out.inputs["Surface"])


def coat_graph(g, coat):
    p = g.p
    z = g.xyz(p)[2]
    x = g.xyz(p)[0]
    legs = g.math("SUBTRACT", 1.0, g.smooth(0.82, 1.02, z))
    body_flow = g.noise(g.stretch((70, 7, 70)), 1.0, 3.0, 0.55)
    leg_flow = g.noise(g.stretch((70, 70, 7)), 1.0, 3.0, 0.55)
    streak = g.mix(legs, body_flow, leg_flow)
    streak = g.xyz(streak)[0]
    tone = g.noise(p, 2.4, 4.0, 0.6)
    base = g.mix(g.smooth(0.3, 0.7, tone), coat["dark"], coat["light"])
    dapple = g.voronoi(g.vec("MULTIPLY", p, (1, 1, 1.3)), 7.5, "SMOOTH_F1")
    base = g.scale(base, g.math("ADD", 0.9, g.math("MULTIPLY", 0.1, g.smooth(0.12, 0.42, dapple))))
    dorsal = g.math("MULTIPLY", g.smooth(1.42, 1.72, z), g.math("SUBTRACT", 1.0, g.smooth(0.04, 0.2, g.math("ABSOLUTE", x))))
    base = g.mix(g.math("MULTIPLY", dorsal, 0.55), base, coat["dark"])
    base = g.scale(base, g.math("ADD", 0.9, g.math("MULTIPLY", 0.2, streak)))
    jitter = g.math("MULTIPLY", g.math("SUBTRACT", g.noise(p, 9.0, 3.0), 0.5), 0.12)
    points = g.math("SUBTRACT", 1.0, g.smooth(coat["points"] - 0.08, coat["points"] + 0.08, g.math("ADD", z, jitter)))
    base = g.mix(points, base, coat["point"])
    muzzle = g.math("MULTIPLY", g.attr("muzzle"), 0.92)
    mottle = g.noise(p, 60.0, 2.0)
    base = g.mix(muzzle, base, g.mix(g.smooth(0.4, 0.7, mottle), coat["muzzle"], (0.09, 0.055, 0.045)))
    base = g.mix(g.math("MULTIPLY", g.attr("eyering"), 0.35), base, coat["dark"])
    star_d = g.vec("DISTANCE", g.vec("MULTIPLY", p, (1, 1, 0.75)), g.vec("MULTIPLY", coat["star"], (1, 1, 0.75)))
    star_d = g.math("ADD", star_d, g.math("MULTIPLY", g.math("SUBTRACT", g.noise(p, 35.0, 2.0), 0.5), 0.03))
    star = g.math("SUBTRACT", 1.0, g.smooth(0.025, 0.04, star_d))
    white = (0.62, 0.57, 0.5)
    base = g.mix(star, base, white)
    sock = coat_sock(g, p, jitter)
    base = g.mix(sock, base, white)
    rough = g.math("ADD", 0.5, g.math("MULTIPLY", 0.12, streak))
    rough = g.math("ADD", rough, g.math("MULTIPLY", -0.08, muzzle))
    rough = g.math("ADD", rough, g.math("MULTIPLY", 0.06, points))
    fine = g.noise(p, 420.0, 1.0)
    height = g.math("ADD", g.math("MULTIPLY", streak, 1.0), g.math("MULTIPLY", fine, 0.25))
    g.finish(base, rough, 0.0, height, 0.32)


def shiba_graph(g, coat):
    """Red sesame over cream urajiro; the cream mask is a per-vertex blend so the border feathers."""
    p = g.p
    q = g.xyz(p)
    flow = g.xyz(g.noise(g.stretch((240, 24, 240)), 1.0, 3.0, 0.55))[0]
    tone = g.noise(p, 7.0, 4.0, 0.6)
    base = g.mix(g.smooth(0.3, 0.7, tone), coat["dark"], coat["light"])
    sesame = g.math("MULTIPLY", g.smooth(0.38, 0.5, q[2]), g.math("SUBTRACT", 1.0, g.smooth(0.02, 0.07, g.math("ABSOLUTE", q[0]))))
    tips = g.smooth(0.55, 0.75, g.noise(g.stretch((300, 40, 300)), 1.0, 2.0))
    base = g.mix(g.math("MULTIPLY", sesame, g.math("ADD", 0.35, g.math("MULTIPLY", 0.45, tips))), base, coat["sesame"])
    jitter = g.math("MULTIPLY", g.math("SUBTRACT", g.noise(p, 40.0, 3.0), 0.5), 0.5)
    cream = g.smooth(0.25, 0.75, g.math("ADD", g.attr("cream"), jitter))
    cream_tone = g.mix(g.smooth(0.3, 0.7, tone), coat["cream"], coat["cream_light"])
    base = g.mix(cream, base, cream_tone)
    base = g.scale(base, g.math("ADD", 0.88, g.math("MULTIPLY", 0.24, flow)))
    rough = g.math("ADD", g.math("ADD", 0.62, g.math("MULTIPLY", 0.1, cream)), g.math("MULTIPLY", 0.12, flow))
    fine = g.noise(p, 1200.0, 1.0)
    height = g.math("ADD", flow, g.math("MULTIPLY", fine, 0.25))
    g.finish(base, rough, 0.0, height, 0.3)


def coat_sock(g, p, jitter):
    q = g.xyz(p)
    hind_left = g.math("MULTIPLY", g.smooth(0.0, 0.03, q[0]), g.smooth(0.45, 0.55, q[1]))
    low = g.math("SUBTRACT", 1.0, g.smooth(0.2, 0.26, g.math("ADD", q[2], jitter)))
    return g.math("MULTIPLY", hind_left, low)


def surface_graph(material, kind, coat):
    g = Graph(material)
    p = g.p
    tack = g.attr("tack", "Vector")
    t = g.xyz(tack)
    if kind == "coat":
        (shiba_graph if "sesame" in coat else coat_graph)(g, coat)
    elif kind == "nose":
        cells = g.voronoi(p, 900.0, "SMOOTH_F1")
        color = g.scale((0.012, 0.009, 0.008), g.math("ADD", 0.8, g.math("MULTIPLY", 0.4, cells)))
        g.finish(color, g.math("ADD", 0.16, g.math("MULTIPLY", 0.2, cells)), 0.0, cells, 0.5)
    elif kind == "mane":
        strands = g.noise(g.stretch((110, 110, 5)), 1.0, 3.0, 0.6)
        color = g.scale(coat["hair"], g.math("ADD", 0.65, g.math("MULTIPLY", 0.8, strands)))
        g.finish(color, g.math("ADD", 0.68, g.math("MULTIPLY", 0.12, strands)), 0.0, strands, 0.5)
    elif kind == "hoof":
        rings = g.noise(g.stretch((150, 150, 9)), 1.0, 3.0, 0.6)
        sock = coat_sock(g, p, 0.0)
        color = g.mix(sock, coat["hoof"], (0.25, 0.19, 0.12))
        color = g.scale(color, g.math("ADD", 0.75, g.math("MULTIPLY", 0.5, rings)))
        g.finish(color, g.math("ADD", 0.42, g.math("MULTIPLY", 0.15, rings)), 0.0, rings, 0.4)
    elif kind == "eye":
        g.finish((0.018, 0.011, 0.007), 0.04, 0.0, 0.0, 0.0)
    elif kind in ("leather", "darkleather"):
        dark = kind == "darkleather"
        base = (0.05, 0.023, 0.01) if dark else (0.12, 0.052, 0.021)
        worn = (0.12, 0.068, 0.038) if dark else (0.24, 0.125, 0.06)
        wear = g.math("MULTIPLY", g.smooth(0.58, 0.8, g.noise(p, 5.0, 3.0, 0.55)), 0.6)
        edge = g.math("SUBTRACT", 1.0, g.smooth(0.0, 0.012, t[2]))
        wear = g.math("MAXIMUM", wear, g.math("MULTIPLY", edge, 0.8))
        color = g.mix(wear, base, worn)
        grime = g.noise(p, 3.0, 3.0)
        color = g.scale(color, g.math("ADD", 0.8, g.math("MULTIPLY", 0.3, grime)))
        stitch_band = g.math("MULTIPLY", g.smooth(0.006, 0.008, t[2]), g.math("SUBTRACT", 1.0, g.smooth(0.010, 0.012, t[2])))
        dash = g.smooth(0.35, 0.45, g.math("PINGPONG", g.math("ADD", t[0], t[1]), 0.012))
        stitch = g.math("MULTIPLY", stitch_band, dash)
        color = g.mix(stitch, color, (0.42, 0.33, 0.2))
        grain = g.noise(p, 380.0, 2.0)
        crease = g.noise(p, 26.0, 3.0, 0.7, 1.5)
        height = g.math("ADD", g.math("MULTIPLY", grain, 0.35), g.math("MULTIPLY", crease, 0.5))
        height = g.math("ADD", height, g.math("MULTIPLY", stitch, -0.6))
        rough = g.math("SUBTRACT", 0.62, g.math("MULTIPLY", wear, 0.18))
        g.finish(color, rough, 0.0, height, 0.45)
    elif kind == "wool":
        # Navajo saddle blanket: bound edge, stepped zigzag bands, diamond field under the skirt.
        b = t[2]
        along = g.math("ADD", t[0], t[1])
        red, cream, black, indigo = (0.3, 0.035, 0.022), (0.5, 0.42, 0.28), (0.02, 0.017, 0.015), (0.035, 0.045, 0.1)
        zig = g.math("PINGPONG", along, 0.025)
        stepped = g.math("SNAP", zig, 0.006)
        color = g.mix(g.math("LESS_THAN", b, 0.012), red, black)
        cream_band = g.math("MULTIPLY", g.math("GREATER_THAN", b, 0.024), g.math("LESS_THAN", b, 0.052))
        color = g.mix(cream_band, color, cream)
        zigzag = g.math("LESS_THAN", g.math("ABSOLUTE", g.math("SUBTRACT", b, g.math("ADD", 0.028, stepped))), 0.0045)
        color = g.mix(g.math("MULTIPLY", cream_band, zigzag), color, black)
        indigo_band = g.math("MULTIPLY", g.math("GREATER_THAN", b, 0.06), g.math("LESS_THAN", b, 0.075))
        color = g.mix(indigo_band, color, indigo)
        diamond = g.math("ADD", g.math("ABSOLUTE", g.math("SUBTRACT", g.math("PINGPONG", t[0], 0.07), 0.035)), g.math("ABSOLUTE", g.math("SUBTRACT", g.math("PINGPONG", t[1], 0.07), 0.035)))
        field = g.math("GREATER_THAN", b, 0.09)
        motif = g.math("MULTIPLY", field, g.math("MULTIPLY", g.math("LESS_THAN", diamond, 0.03), g.math("GREATER_THAN", diamond, 0.018)))
        color = g.mix(motif, color, cream)
        weave = g.math("MULTIPLY", g.math("SINE", g.math("MULTIPLY", t[0], 1400)), g.math("SINE", g.math("MULTIPLY", t[1], 1400)))
        fuzz = g.noise(p, 160.0, 4.0, 0.7)
        color = g.scale(color, g.math("ADD", 0.82, g.math("MULTIPLY", 0.3, fuzz)))
        dust = g.smooth(0.5, 0.8, g.noise(p, 4.0, 3.0))
        color = g.mix(g.math("MULTIPLY", dust, 0.35), color, (0.32, 0.24, 0.16))
        g.finish(color, 0.95, 0.0, g.math("ADD", g.math("MULTIPLY", weave, 0.3), fuzz), 0.5)
    elif kind == "cinch":
        cord = g.math("PINGPONG", t[1], 0.006)
        color = g.mix(g.math("GREATER_THAN", g.math("FRACT", g.math("MULTIPLY", t[1], 7.0)), 0.5), (0.4, 0.33, 0.22), (0.11, 0.06, 0.03))
        g.finish(color, 0.88, 0.0, g.math("MULTIPLY", cord, 100), 0.5)
    elif kind == "bedroll":
        fuzz = g.noise(p, 140.0, 4.0, 0.7)
        check = g.math("MULTIPLY", g.math("PINGPONG", g.xyz(p)[0], 0.05), 20)
        color = g.mix(g.smooth(0.3, 0.5, check), (0.07, 0.05, 0.032), (0.11, 0.08, 0.05))
        color = g.scale(color, g.math("ADD", 0.8, g.math("MULTIPLY", 0.35, fuzz)))
        g.finish(color, 0.93, 0.0, fuzz, 0.4)
    elif kind == "brass":
        tarnish = g.smooth(0.45, 0.7, g.noise(p, 40.0, 4.0))
        color = g.mix(tarnish, (0.6, 0.38, 0.12), (0.22, 0.14, 0.05))
        g.finish(color, g.math("ADD", 0.3, g.math("MULTIPLY", tarnish, 0.35)), g.math("SUBTRACT", 1.0, g.math("MULTIPLY", tarnish, 0.3)), g.noise(p, 300.0, 2.0), 0.15)
    elif kind == "iron":
        rust = g.smooth(0.55, 0.75, g.noise(p, 50.0, 4.0))
        color = g.mix(rust, (0.2, 0.19, 0.18), (0.22, 0.09, 0.035))
        g.finish(color, g.math("ADD", 0.42, g.math("MULTIPLY", rust, 0.45)), g.math("SUBTRACT", 1.0, rust), g.noise(p, 260.0, 2.0), 0.2)
    return g


# ---------------------------------------------------------------- baking and images


def linear_to_srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def image(name, w, h):
    img = bpy.data.images.new(name, w, h, alpha=True, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    return img


def pixels(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def save_png(rgba, path):
    h, w = rgba.shape[:2]
    out = bpy.data.images.new(path.stem, w, h, alpha=True)
    out.colorspace_settings.name = "Non-Color"
    out.pixels.foreach_set(np.clip(rgba, 0, 1).astype(np.float32).ravel())
    out.filepath_raw = str(path)
    out.file_format = "PNG"
    path.parent.mkdir(parents=True, exist_ok=True)
    out.save()
    bpy.data.images.remove(out)


def bake(objects, graphs, size, samples, reach):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.render.bake.margin = 6
    scene.render.bake.margin_type = "EXTEND"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("World")
    scene.world.light_settings.distance = reach
    for ob in bpy.context.scene.objects:
        ob.select_set(ob in objects)
        ob.hide_render = ob not in objects
    bpy.context.view_layer.objects.active = objects[0]
    results = {}
    for role, kind, count in (("albedo", "EMIT", 4), ("rough", "EMIT", 4), ("metal", "EMIT", 1), ("ao", "AO", samples), ("normal", "NORMAL", 4)):
        img = image(f"{ANIMAL}-{role}", size, size)
        for g in graphs:
            g.target.image = img
            g.nt.nodes.active = g.target
            g.show(role)
        scene.cycles.samples = count
        bpy.ops.object.bake(type=kind, normal_space="TANGENT", use_clear=True, margin=6)
        results[role] = pixels(img)
    for ob in bpy.context.scene.objects:
        ob.hide_render = False
    return results


def hair_texture(width, height, rows, coat, seed=11):
    """Alpha strand clumps: one clump per row, roots opaque, tips feathered."""
    rng = np.random.default_rng(seed)
    color = np.zeros((height, width, 3), np.float32)
    alpha = np.zeros((height, width), np.float32)
    normal_y = np.zeros((height, width), np.float32)
    rough = np.full((height, width), 0.74, np.float32)
    row_h = height / rows
    xs = np.arange(width, dtype=np.float32)
    base = np.array(coat["hair"], np.float32)
    for r in range(rows):
        for _ in range(46):
            length = width * rng.uniform(0.35, 1.0)
            y0 = r * row_h + row_h * rng.uniform(0.12, 0.88)
            wave = rng.uniform(0.4, 1.6) * np.sin(xs / width * rng.uniform(2, 7) + rng.uniform(0, 6.3))
            drift = (rng.uniform(-0.12, 0.12) * row_h) * (xs / width)
            ys = y0 + wave + drift
            ys = np.clip(ys, r * row_h + 1, (r + 1) * row_h - 2)
            w = rng.uniform(1.4, 2.6) * (1 - 0.55 * xs / width)
            a = np.clip((length - xs) / (0.28 * length), 0, 1) * (xs < length)
            tint = base * rng.uniform(0.6, 1.5) * (np.array((2.8, 2.2, 1.8), np.float32) if rng.random() < 0.12 else 1.0)
            for dy in range(-3, 4):
                py = np.floor(ys).astype(int) + dy
                cover = np.clip(w / 2 + 0.5 - np.abs(py + 0.5 - ys), 0, 1) * a
                ok = (py >= 0) & (py < height) & (cover > 0)
                cols, prow = xs[ok].astype(int), py[ok]
                take = cover[ok] > alpha[prow, cols]
                cols, prow = cols[take], prow[take]
                alpha[prow, cols] = cover[ok][take]
                color[prow, cols] = tint
                normal_y[prow, cols] = np.clip((prow + 0.5 - ys[ok][take]) / (w[ok][take] / 2 + 0.5), -1, 1)
                rough[prow, cols] = 0.64 + 0.14 * rng.random()
    root = np.clip(1 - xs / (0.04 * width), 0, 1)[None, :]
    for r in range(rows):
        band = slice(int(r * row_h + row_h * 0.25), int((r + 1) * row_h - row_h * 0.25))
        alpha[band] = np.maximum(alpha[band], root)
        color[band] = np.where(alpha[band][..., None] > 0, color[band], base)
    color[alpha <= 0] = base
    shade = (0.55 + 0.45 * np.clip(xs / (0.35 * width), 0, 1))[None, :]
    albedo = np.dstack([linear_to_srgb(color), alpha])
    ny = normal_y * 0.7
    nz = np.sqrt(np.clip(1 - ny * ny, 0, 1))
    normal = np.dstack([np.full_like(ny, 0.5), ny * 0.5 + 0.5, nz * 0.5 + 0.5, np.ones_like(ny)])
    arm = np.dstack([np.broadcast_to(shade, alpha.shape), rough, np.zeros_like(rough), np.ones_like(rough)])
    return albedo, normal, arm


# ---------------------------------------------------------------- export


def export(body, groups, trees, path):
    blob = bytearray()
    doc = {"asset": {"version": "2.0", "generator": "Out West animal authoring"}, "accessors": [], "bufferViews": [], "buffers": [], "meshes": [], "nodes": [], "scenes": [{"nodes": []}], "scene": 0}
    doc["extras"] = {"animal": ANIMAL, "jointNames": body.names}

    def accessor(rows, fmt, component, kind):
        while len(blob) % 4:
            blob.append(0)
        offset = len(blob)
        flat = [v for row in rows for v in row]
        blob.extend(struct.pack("<" + fmt * len(flat), *flat))
        doc["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob) - offset})
        a = {"bufferView": len(doc["bufferViews"]) - 1, "componentType": component, "count": len(rows), "type": kind}
        if kind == "VEC3" and fmt == "f":
            a["min"] = [min(r[k] for r in rows) for k in range(3)]
            a["max"] = [max(r[k] for r in rows) for k in range(3)]
        doc["accessors"].append(a)
        return len(doc["accessors"]) - 1

    for name, objects in groups.items():
        keys, rows, indices = {}, [], []
        for ob in objects:
            me = ob.data
            if me.uv_layers.get("UVMap"):
                me.calc_tangents(uvmap="UVMap")
            uv_layer = me.uv_layers.get("UVMap")
            params = me.attributes.get("tack")
            skin = ob["skin"]
            cache = {}
            for poly in me.polygons:
                loops = list(poly.loop_indices)
                for k in range(1, len(loops) - 1):
                    for li in (loops[0], loops[k], loops[k + 1]):
                        loop = me.loops[li]
                        v = loop.vertex_index
                        if skin == "orig":
                            joints, weights = list(body.joints[v]), list(body.weights[v])
                        else:
                            if v not in cache:
                                cache[v] = weights_from(body, *trees[skin], me.vertices[v].co)
                            joints, weights = cache[v]
                        m = blend(body.mats, joints, weights)
                        m3 = m.to_3x3()
                        inv = m.inverted()
                        if skin == "orig":
                            pos, nrm = Vector(body.bind[v]), Vector(body.bind_normals[v])
                        else:
                            pos = inv @ to_gl(me.vertices[v].co)
                            nrm = (m3.transposed() @ to_gl(loop.normal)).normalized()
                        if uv_layer:
                            uv = uv_layer.data[li].uv
                            tangent = (m3.inverted() @ to_gl(loop.tangent)).normalized()
                            sign = loop.bitangent_sign * (-1 if m3.determinant() < 0 else 1)
                        else:
                            q = params.data[v].vector
                            uv = (q[0], q[1])
                            tangent, sign = None, 1.0
                        row = (
                            tuple(round(c, 6) for c in pos),
                            tuple(round(c, 5) for c in nrm),
                            (round(uv[0], 6), round(1 - uv[1], 6)),
                            tuple(joints),
                            tuple(round(w, 5) for w in weights),
                            tuple(round(c, 5) for c in tangent) + (sign,) if tangent else None,
                        )
                        if row not in keys:
                            keys[row] = len(rows)
                            rows.append(row)
                        indices.append(keys[row])
            if uv_layer:
                me.free_tangents()
        attributes = {
            "POSITION": accessor([r[0] for r in rows], "f", 5126, "VEC3"),
            "NORMAL": accessor([r[1] for r in rows], "f", 5126, "VEC3"),
            "TEXCOORD_0": accessor([r[2] for r in rows], "f", 5126, "VEC2"),
            "JOINTS_0": accessor([r[3] for r in rows], "H", 5123, "VEC4"),
            "WEIGHTS_0": accessor([r[4] for r in rows], "f", 5126, "VEC4"),
        }
        if all(r[5] for r in rows):
            attributes["TANGENT"] = accessor([r[5] for r in rows], "f", 5126, "VEC4")
        primitive = {"attributes": attributes, "indices": accessor([[i] for i in indices], "I", 5125, "SCALAR"), "extras": {"surface": name}}
        doc["meshes"].append({"name": name, "primitives": [primitive]})
        doc["nodes"].append({"name": f"{ANIMAL}.{name}", "mesh": len(doc["meshes"]) - 1})
        doc["scenes"][0]["nodes"].append(len(doc["nodes"]) - 1)
        print(f"{ANIMAL} {name}: {len(rows)} vertices, {len(indices) // 3} triangles")
    doc["buffers"] = [{"byteLength": len(blob)}]
    encoded = json.dumps(doc, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    blob.extend(b"\x00" * (-len(blob) % 4))
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(encoded) + 8 + len(blob)) + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded + struct.pack("<II", len(blob), 0x004E4942) + blob)


# ---------------------------------------------------------------- animals

POLL_CUT = -1.12


def horse_tail_cut(body, face, region):
    """Below the dock the tail slab gives way to alpha cards; ahead of the poll the mane slab becomes coat under the forelock."""
    if region != "hair":
        return region
    if not hasattr(body, "dock"):
        tail = [body.posed[v] for f, r in zip(body.skin_faces, body.skin_region) if r == "hair" for v in f if body.posed[v].y > 0.6]
        body.dock = max(p.z for p in tail) - 0.13
    centre = sum((body.posed[v] for v in face), Vector()) / 3
    if centre.y > 0.6 and centre.z < body.dock:
        return None
    return "coat" if centre.y < POLL_CUT else region


SPECS = {
    "horse": {
        "regions": {
            (0.072, 0.025, 0.01): "coat",
            (0.042, 0.018, 0.008): "remove",
            (0.068, 0.019, 0.012): "remove",
            (0.023, 0.01, 0.005): "remove",
            (0.007, 0.004, 0.003): "hair",
            (0.127, 0.051, 0.021): "eyering",
            (0.016, 0.012, 0.009): "hoof",
            (0.03, 0.012, 0.005): "blaze",
            (0.018, 0.01, 0.007): "muzzle",
            (0.007, 0.007, 0.007): "eye",
            (0.392, 0.392, 0.392): "eye",
        },
        "surface": {"coat": "coat", "eyering": "coat", "blaze": "coat", "muzzle": "coat", "hair": "mane", "hoof": "hoof", "eye": "eye"},
        "slots": ["coat", "mane", "hoof", "eye"],
        "cut": horse_tail_cut,
        "coat": {
            "dark": (0.075, 0.022, 0.008),
            "light": (0.2, 0.068, 0.024),
            "point": (0.012, 0.009, 0.007),
            "points": 0.5,
            "muzzle": (0.025, 0.018, 0.015),
            "hair": (0.02, 0.011, 0.006),
            "hoof": (0.035, 0.03, 0.026),
            "star": (0.0, -1.43, 1.99),
        },
        "size": 1024,
        "occlusion": 0.4,
        "hair": (1024, 256, 8),
    },
    "dog": {
        "regions": {
            (0.254, 0.102, 0.027): "coat",
            (0.292, 0.301, 0.266): "cream",
            (0.022, 0.022, 0.022): "nose",
            (0.025, 0.014, 0.006): "eye",
            (0.005, 0.005, 0.005): "eye",
            (0.694, 0.694, 0.694): "eye",
        },
        "surface": {"coat": "coat", "cream": "coat", "nose": "nose", "eye": "eye"},
        "slots": ["coat", "nose", "eye"],
        "masks": ("cream",),
        "coat": {
            "dark": (0.2, 0.062, 0.016),
            "light": (0.36, 0.13, 0.04),
            "sesame": (0.07, 0.03, 0.012),
            "cream": (0.26, 0.19, 0.12),
            "cream_light": (0.36, 0.28, 0.18),
        },
        "size": 512,
        "occlusion": 0.12,
    },
}


def skin_trees(body):
    torso = {"Body", "Back", "Torso", "Torso2", "Torso3"}
    return {
        "torso": body.group(lambda joint, region: joint in torso and region != "hair"),
        "head": body.group(lambda joint, region: joint in ("Head",) and region not in ("hair",)),
        "mane": body.group(lambda joint, region: region == "hair" and (joint.startswith("Neck") or joint == "Head")),
        "tail": body.group(lambda joint, region: region == "hair" and joint.startswith("Tail")),
    }


def build(spec):
    reset()
    materials = {}
    for kind in ("coat", "mane", "hoof", "eye", "nose", "leather", "darkleather", "wool", "cinch", "bedroll", "brass", "iron", "hair"):
        materials[kind] = bpy.data.materials.new(f"{ANIMAL} {kind}")
    body = Body(spec)
    ob = bpy.data.objects.new("Body", body.mesh)
    bpy.context.scene.collection.objects.link(ob)
    for slot in spec["slots"]:
        body.mesh.materials.append(materials[slot])
    ob["skin"] = "orig"
    objects, cards = [ob], []
    if ANIMAL == "horse":
        barrel = Barrel(body)
        horse_tack(body, barrel, materials, objects)
        horse_bridle(body, materials, objects)
        horse_hair(body, barrel, materials["hair"], cards, spec["hair"][2])
    return body, materials, objects, cards


def unwrap(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for ob in objects:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004, area_weight=0.0, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    # Eyes get extra texels so their wet roughness survives the half-resolution ARM map.
    me = objects[0].data
    eye = [s for s, m in enumerate(me.materials) if m.name.endswith(" eye")]
    uv = me.uv_layers.active.data
    for poly in me.polygons:
        if poly.material_index in eye:
            loops = list(poly.loop_indices)
            centre = sum((uv[i].uv for i in loops), Vector((0, 0))) / len(loops)
            for i in loops:
                uv[i].uv = centre + (uv[i].uv - centre) * 4
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.uv.pack_islands(margin=0.004, rotate=True)
    bpy.ops.object.mode_set(mode="OBJECT")


def author():
    spec = SPECS[ANIMAL]
    body, materials, objects, cards = build(spec)
    unwrap(objects)
    graphs = []
    for kind, material in materials.items():
        if kind != "hair" and material.users:
            graphs.append(surface_graph(material, kind, spec["coat"]))
    maps = bake(objects, graphs, spec["size"], 48, spec["occlusion"])
    textures = ART / "animal-textures"
    albedo = maps["albedo"].copy()
    albedo[..., :3] = linear_to_srgb(albedo[..., :3])
    albedo[..., 3] = 1
    arm = np.dstack([maps["ao"][..., 0], maps["rough"][..., 0], maps["metal"][..., 0], np.ones(maps["ao"].shape[:2], np.float32)])
    # Occlusion, roughness and metal are low frequency; half resolution keeps the download small.
    arm = arm.reshape(arm.shape[0] // 2, 2, arm.shape[1] // 2, 2, 4).mean(axis=(1, 3))
    normal = maps["normal"].copy()
    normal[..., 3] = 1
    save_png(albedo, textures / f"{ANIMAL}-coat-albedo.png")
    save_png(normal, textures / f"{ANIMAL}-coat-normal.png")
    save_png(arm, textures / f"{ANIMAL}-coat-arm.png")
    groups = {"coat": objects}
    if cards:
        w, h, rows = spec["hair"]
        hair = hair_texture(w, h, rows, spec["coat"])
        for role, data in zip(("albedo", "normal", "arm"), hair):
            save_png(data, textures / f"{ANIMAL}-hair-{role}.png")
        groups["hair"] = cards
    export(body, groups, skin_trees(body), ART / f"{ANIMAL}-parts.glb")


if __name__ == "__main__" and not globals().get("STAGE"):
    author()
