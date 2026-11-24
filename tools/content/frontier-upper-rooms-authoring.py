"""Perdition's upper rooms, in metres. Blender --background --python <file> -- [plan.json] [out.glb]."""

import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

ART = Path(__file__).resolve().parents[1] / "art" / "environments"
args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
layout = json.loads(Path(args[0] if args else ART / "frontier.plan.json").read_text())[
    "layout"
]
out = Path(args[1]) if len(args) > 1 else ART / "frontier-upper-rooms.glb"
bpy.ops.wm.read_factory_settings(use_empty=True)


def finish(name, color, roughness, metallic=0, surface=None):
    mat = bpy.data.materials.new("Upper " + name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    mat.use_backface_culling = surface != "cloth"
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    if surface:
        mat["surface"] = surface
    return mat


oak = finish("oiled oak", (0.52, 0.318, 0.166), 0.61, surface="floor")
trim = finish("worn stair nosings", (0.62, 0.42, 0.225), 0.54, surface="floor")
walnut = finish("ebonized joinery", (0.20, 0.105, 0.060), 0.58, surface="floor")
brass = finish("old brass", (0.49, 0.315, 0.114), 0.35, 0.73)
iron = finish("blue black iron", (0.075, 0.085, 0.09), 0.56, 0.52)
enamel = finish("cream stoneware", (0.82, 0.74, 0.58), 0.21)
blue = finish("indigo glaze", (0.049, 0.118, 0.19), 0.32)
red = finish("woven oxblood", (0.53, 0.155, 0.109), 0.91, surface="cloth")
flax = finish("woven flax", (0.81, 0.64, 0.424), 0.91, surface="cloth")
sage = finish("woven bottle green", (0.162, 0.303, 0.235), 0.9, surface="cloth")
paper = finish("rag paper", (0.77, 0.66, 0.46), 0.88)
leather = finish("saddle leather", (0.28, 0.119, 0.057), 0.68)
ink = finish("black ink", (0.06, 0.044, 0.032), 0.72)


# Each building bakes to a mesh with one primitive per material. Axis 2 is height in this authoring
# space. Mirror the footprint and winding together when converting south-positive Z to Blender Y.
class Batch:
    def __init__(self, name):
        self.name = name
        self.v, self.faces, self.materials, self.indices, self.smooth = (
            [],
            [],
            [],
            [],
            [],
        )

    def shape(self, verts, faces, mat, smooth=False):
        if mat not in self.materials:
            self.materials.append(mat)
        start = len(self.v)
        self.v.extend((x, -z, h) for x, z, h in verts)
        for f in faces:
            self.faces.append(tuple(start + i for i in reversed(f)))
            self.indices.append(self.materials.index(mat))
            self.smooth.append(smooth and len(f) == 4)

    def export(self):
        data = bpy.data.meshes.new(self.name)
        data.from_pydata(self.v, [], self.faces)
        for material in self.materials:
            data.materials.append(material)
        data.update()
        uv = data.uv_layers.new(name="metre grain")
        for face, index, smooth in zip(data.polygons, self.indices, self.smooth):
            face.material_index = index
            face.use_smooth = smooth
            drop = max(range(3), key=lambda i: abs(face.normal[i]))
            axes = [i for i in range(3) if i != drop]
            for i in face.loop_indices:
                point = data.vertices[data.loops[i].vertex_index].co
                uv.data[i].uv = (point[axes[0]] / 1.18, point[axes[1]] / 0.62)
        obj = bpy.data.objects.new(self.name, data)
        bpy.context.collection.objects.link(obj)
        return obj


def block(x, z, h, w, d, height, mat, chamfer=0):
    # An octagonal plan catches light on the edges of mouldings and furniture.
    a, b = w / 2, d / 2
    c = min(chamfer, a * 0.5, b * 0.5)
    ring = (
        [(-a, -b), (a, -b), (a, b), (-a, b)]
        if not c
        else [
            (-a + c, -b),
            (a - c, -b),
            (a, -b + c),
            (a, b - c),
            (a - c, b),
            (-a + c, b),
            (-a, b - c),
            (-a, -b + c),
        ]
    )
    n = len(ring)
    verts = [(x + i, z + j, k) for k in (h, h + height) for i, j in ring]
    faces = [list(reversed(range(n))), list(range(n, 2 * n))]
    faces.extend((i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n))
    batch.shape(verts, faces, mat)


def lathe(x, z, h, profile, mat, sides=16):
    verts = [
        (
            x + r * math.cos(i * math.tau / sides),
            z + r * math.sin(i * math.tau / sides),
            h + level,
        )
        for level, r in profile
        for i in range(sides)
    ]
    faces = [
        (j + i, j + (i + 1) % sides, j + (i + 1) % sides + sides, j + i + sides)
        for j in range(0, len(verts) - sides, sides)
        for i in range(sides)
    ]
    # A bowl's inward profile closes its base or neck as part of the same mesh.
    faces.extend(
        (list(reversed(range(sides))), list(range(len(verts) - sides, len(verts))))
    )
    batch.shape(verts, faces, mat, True)


def beam(start, end, radius, mat, sides=8):
    a, b = Vector(start), Vector(end)
    axis = (b - a).normalized()
    u = axis.cross(
        Vector((0, 0, 1)) if abs(axis.z) < 0.92 else Vector((0, 1, 0))
    ).normalized()
    v = axis.cross(u)
    verts = [
        tuple(
            p
            + radius
            * (u * math.cos(i * math.tau / sides) + v * math.sin(i * math.tau / sides))
        )
        for p in (a, b)
        for i in range(sides)
    ]
    faces = [
        (i, (i + 1) % sides, (i + 1) % sides + sides, i + sides) for i in range(sides)
    ]
    faces.extend((list(reversed(range(sides))), list(range(sides, 2 * sides))))
    batch.shape(verts, faces, mat, True)


def washset(x, z, h, glaze):
    # Hollow glazed basin, contrasting rim, ewer with open neck and pull handle.
    lathe(
        x - 0.16,
        z + 0.015,
        h,
        [
            (0, 0.095),
            (0.018, 0.11),
            (0.045, 0.135),
            (0.09, 0.198),
            (0.125, 0.22),
            (0.14, 0.219),
            (0.143, 0.205),
            (0.119, 0.20),
            (0.081, 0.165),
            (0.025, 0.092),
        ],
        enamel,
        24,
    )
    lathe(
        x - 0.16,
        z + 0.015,
        h + 0.129,
        [(0, 0.219), (0.008, 0.221), (0.012, 0.217)],
        glaze,
        24,
    )
    px, pz = x + 0.165, z - 0.07
    lathe(
        px,
        pz,
        h,
        [
            (0, 0.061),
            (0.014, 0.079),
            (0.05, 0.077),
            (0.111, 0.108),
            (0.181, 0.105),
            (0.232, 0.063),
            (0.25, 0.054),
            (0.299, 0.055),
            (0.311, 0.068),
            (0.32, 0.067),
            (0.32, 0.056),
            (0.269, 0.051),
        ],
        enamel,
        20,
    )
    for j in range(8):
        lo, hi = (math.pi * j / 8, math.pi * (j + 1) / 8)

        def handle(t):
            return (
                px + 0.061 + 0.098 * math.sin(t),
                pz,
                h + 0.191 + 0.082 * math.cos(t),
            )

        beam(handle(lo), handle(hi), 0.012, glaze)
    lathe(px, pz, h + 0.104, [(0, 0.108), (0.012, 0.110), (0.015, 0.108)], glaze, 20)


def book(x, z, h, w, d, thick, cover):
    block(x, z, h, w, d, 0.009, cover, 0.008)
    block(x, z, h + 0.009, w - 0.014, d - 0.019, thick - 0.018, paper, 0.003)
    block(x, z, h + thick - 0.009, w, d, 0.009, cover, 0.008)
    block(x - w * 0.5 + 0.009, z, h, 0.018, d, thick, cover, 0.003)
    for dy in (-d * 0.29, d * 0.29):
        block(x - w * 0.5 + 0.036, z + dy, h + thick, 0.057, 0.012, 0.002, brass)


def ledger(x, z, h):
    # Open folio has bowed sheets and ruled double-entry columns.
    block(x, z, h, 0.63, 0.44, 0.025, leather, 0.012)
    for side in (-1, 1):
        near = x + side * 0.008
        middle = x + side * 0.125
        far = x + side * 0.299
        profile = [(near, h + 0.044), (middle, h + 0.063), (far, h + 0.046)]
        for (a, ah), (b, bh) in zip(profile, profile[1:]):
            verts = [
                (a, z - 0.20, ah),
                (b, z - 0.20, bh),
                (b, z + 0.20, bh),
                (a, z + 0.20, ah),
            ]
            batch.shape(verts, [(0, 1, 2, 3) if side > 0 else (3, 2, 1, 0)], paper)
            for k in range(9):
                row = z - 0.158 + k * 0.034
                batch.shape(
                    [
                        (a, row, ah + 0.001),
                        (b, row, bh + 0.001),
                        (b, row + 0.002, bh + 0.001),
                        (a, row + 0.002, ah + 0.001),
                    ],
                    [(0, 1, 2, 3) if side > 0 else (3, 2, 1, 0)],
                    ink,
                )
        block(middle, z, h + 0.063, 0.003, 0.39, 0.002, red)
    lathe(
        x + 0.43,
        z - 0.105,
        h,
        [(0, 0.055), (0.012, 0.061), (0.064, 0.054), (0.079, 0.04), (0.093, 0.033)],
        ink,
        8,
    )
    beam((x + 0.43, z - 0.105, h + 0.09), (x + 0.49, z - 0.16, h + 0.26), 0.004, trim)
    book(x - 0.53, z + 0.035, h, 0.24, 0.34, 0.053, sage)


def trunk(x, z, h, w=0.82):
    d = 0.40
    block(x, z, h, w, d, 0.265, leather, 0.032)
    for j, (width, depth) in enumerate(
        ((w, d), (w - 0.018, d - 0.022), (w - 0.046, d - 0.061))
    ):
        block(x, z, h + 0.265 + j * 0.018, width, depth, 0.019, leather, 0.018)
    for side in (-1, 1):
        sx = x + side * w * 0.32
        block(sx, z, h + 0.316, 0.046, d - 0.062, 0.008, trim)
        for face in (-1, 1):
            block(
                sx, z + face * (d * 0.5 - 0.003), h + 0.012, 0.046, 0.012, 0.284, trim
            )
            block(sx, z + face * d * 0.5, h + 0.19, 0.053, 0.014, 0.042, brass)
    for dx in (-0.08, 0.08):
        beam(
            (x + dx, z + d / 2, h + 0.18),
            (x + dx, z + d / 2 + 0.025, h + 0.16),
            0.01,
            brass,
        )
    beam(
        (x - 0.08, z + d / 2 + 0.025, h + 0.16),
        (x + 0.08, z + d / 2 + 0.025, h + 0.16),
        0.013,
        leather,
    )


def rug(x, z, w, d, field):
    # Separate nested woven bands, stepped corner motifs and individual short warp fringes.
    for i, (inset, mat) in enumerate(
        (
            (0, flax),
            (0.026, field),
            (0.053, flax),
            (0.066, field),
            (0.105, walnut),
            (0.118, flax),
            (0.135, field),
        )
    ):
        block(x, z, 3.313 + i * 0.0017, w - 2 * inset, d - 2 * inset, 0.0015, mat)
    for side in (-1, 1):
        for nx in range(1, 24):
            xx = x + w * (nx / 24 - 0.5)
            block(xx, z + side * (d * 0.5 + 0.024), 3.315, 0.012, 0.054, 0.002, flax)
        for xx in (x - w * 0.32, x, x + w * 0.32):
            zz = z + side * (d * 0.5 - 0.26)
            for i in range(5):
                block(
                    xx,
                    zz + (i - 2) * 0.02,
                    3.326,
                    0.035 * (3 - abs(2 - i)),
                    0.022,
                    0.0017,
                    flax,
                )


def staircase(stair, tower):
    x, topz, w, d = stair["x"], stair["z"], stair["w"], stair["d"]
    bottom, top = stair["fromY"], stair["toY"]
    direction = -1 if stair["dir"] == "n" else 1
    startz = topz + d if direction < 0 else topz
    rise = top - bottom
    n = math.ceil(rise / 0.195)
    for i in range(n):
        z0 = startz + direction * d * i / n
        surface = bottom + rise * (i + 1) / n
        depth = d / n
        block(
            x + w / 2,
            z0 + direction * depth / 2,
            surface - rise / n,
            w - 0.024,
            depth - 0.001,
            rise / n,
            oak if i % 4 else walnut,
        )
        block(
            x + w / 2,
            z0 + direction * 0.018,
            surface - 0.018,
            w - 0.017,
            0.047,
            0.021,
            trim,
            0.005,
        )
    # Wall-side rail brackets stay inside the stair envelope and preserve clear landing width.
    edge = x + 0.105 if not tower or direction < 0 else x + w - 0.105

    def rail(t):
        return (edge, startz + direction * d * t, bottom + rise * t + 0.85)

    beam(rail(0.035), rail(0.965), 0.041, trim, 12)
    for t in (0.075, 0.33, 0.65, 0.925):
        xx, zz, hh = rail(t)
        beam((xx, zz, hh - 0.82), (xx, zz, hh - 0.02), 0.034, walnut)
        lathe(
            xx, zz, hh - 0.21, [(0, 0.039), (0.022, 0.045), (0.034, 0.035)], brass, 10
        )
    if tower:
        return
    # The closed half-walls are already solid collision. Cep and panel them on the room side.
    for xx in (x - 0.0425, x + w + 0.0425):
        block(
            xx, topz + (d + 0.55) * 0.5, top + 0.856, 0.15, d - 0.52, 0.063, trim, 0.009
        )
        for zz in (topz + 0.59, topz + d - 0.04):
            block(xx, zz, top, 0.126, 0.128, 0.94, walnut, 0.009)
            lathe(
                xx,
                zz,
                top + 0.937,
                [(0, 0.068), (0.034, 0.08), (0.073, 0.055), (0.113, 0.02)],
                trim,
                12,
            )
    block(
        x + w / 2, topz + d + 0.0425, top + 0.856, w + 0.054, 0.148, 0.063, trim, 0.008
    )


def letters(x, z, h, text, size, along_x):
    curve = bpy.data.curves.new("Letterpress", type="FONT")
    curve.body = text
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.size = size
    curve.resolution_u = 3
    obj = bpy.data.objects.new(text, curve)
    bpy.context.collection.objects.link(obj)
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    coords = [
        (x + v.co.x, z, h + v.co.y) if along_x else (x, z - v.co.x, h + v.co.y)
        for v in mesh.vertices
    ]
    # Face the reader on the south/east side of each doorway.
    batch.shape(
        coords, [tuple(reversed(t.vertices)) for t in mesh.loop_triangles], brass
    )
    evaluated.to_mesh_clear()
    bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.curves.remove(curve)


def portal(left, near, width, thick, along_x, label):
    def part(u, v, h, w, d, height, mat):
        if along_x:
            block(left + u, near + v, h, w, d, height, mat, 0.009)
        else:
            block(left + v, near + u, h, d, w, height, mat, 0.009)

    for face in (-0.025, thick + 0.025):
        for u in (-0.058, width + 0.058):
            part(u, face, 3.301, 0.115, 0.06, 2.42, walnut)
            part(u, face, 3.303, 0.15, 0.072, 0.19, trim)
            part(u, face, 5.60, 0.15, 0.074, 0.116, trim)
        part(width / 2, face, 5.70, width + 0.27, 0.075, 0.115, oak)
        part(width / 2, face, 5.81, width + 0.36, 0.095, 0.045, trim)
    part(width / 2, thick + 0.036, 5.91, 1.18, 0.056, 0.253, walnut)
    part(width / 2, thick + 0.070, 5.923, 1.14, 0.016, 0.225, brass)
    part(width / 2, thick + 0.084, 5.935, 1.118, 0.018, 0.202, ink)
    if along_x:
        letters(left + width / 2, near + thick + 0.096, 6.034, label, 0.121, True)
    else:
        letters(left + thick + 0.096, near + width / 2, 6.034, label, 0.121, False)


def card_parlor(x, z, h):
    block(x, z, h, 1.35, 0.73, 0.006, sage, 0.032)
    white, black = 0.082, 0.057
    for j, (dx, dz) in enumerate(
        ((-0.4, -0.12), (-0.31, -0.15), (0.38, 0.07), (0.28, 0.1), (0.06, -0.08))
    ):
        block(x + dx, z + dz, h + 0.006, white, black, 0.003, paper, 0.004)
        block(x + dx, z + dz, h + 0.010, 0.017, 0.019, 0.001, red if j % 2 else ink)
    for k, (dx, dz) in enumerate(((-0.21, 0.21), (0.27, -0.17), (0.1, 0.13))):
        for i in range(k + 2):
            lathe(
                x + dx,
                z + dz,
                h + 0.009 + i * 0.009,
                [(0, 0.025), (0.008, 0.025)],
                red if i % 2 else flax,
                12,
            )


def curtains(building, window, color):
    """Hung cloth beside the opening. Both tied edges stop outside the clear glass."""
    side = window["side"]
    along = (building["x"] if side in "ns" else building["z"]) + window["at"]
    wall = {
        "w": building["x"] + 0.5,
        "e": building["x"] + building["w"] - 0.5,
        "n": building["z"] + 0.5,
        "s": building["z"] + building["d"] - 0.5,
    }[side]
    inward = 1 if side in "nw" else -1

    def world(u, off, h):
        depth = wall + inward * off
        return (u, depth, h) if side in "ns" else (depth, u, h)

    ceiling = window["top"] + 0.14
    beam(
        world(along - 0.39, 0.155, ceiling),
        world(along + window["width"] + 0.39, 0.155, ceiling),
        0.025,
        brass,
        10,
    )
    for end in (-1, 1):
        edge = along + (window["width"] if end == 1 else 0)
        anchor = edge + end * 0.29
        beam(
            world(anchor, 0, ceiling - 0.055), world(anchor, 0.16, ceiling), 0.021, iron
        )
        # The tie gathers the lower third into a narrow waist. Folds open again at the hem.
        sections = [
            (0, 0.235, 0.02),
            (0.36, 0.205, 0.04),
            (0.61, 0.07, 0.14),
            (0.72, 0.11, 0.105),
            (1, 0.225, 0.042),
        ]
        vertices = []
        n = 10
        for t, span, margin in sections:
            for i in range(n + 1):
                u = i / n
                fold = math.cos(5 * math.pi * u + 0.55 * t)
                height = ceiling - 0.037 - t * (window["top"] - window["sill"] + 0.14)
                if t == 1:
                    height += 0.026 * fold
                vertices.append(
                    world(
                        edge + end * (margin + u * span), 0.120 + 0.040 * fold, height
                    )
                )
        faces = [
            (j + i, j + i + 1, j + i + n + 2, j + i + n + 1)
            for j in range(0, (len(sections) - 1) * (n + 1), n + 1)
            for i in range(n)
        ]
        # The cloth material is two-sided so its reverse shows through the glass.
        batch.shape(vertices, faces, color)
        for i in range(4):
            u = (i + 0.3) / 4
            beam(
                world(edge + end * (0.02 + u * 0.235), 0.145, ceiling - 0.039),
                world(edge + end * (0.02 + u * 0.235), 0.154, ceiling + 0.014),
                0.008,
                brass,
            )
        tie = ceiling - 0.037 - 0.61 * (window["top"] - window["sill"] + 0.14)
        beam(
            world(edge + end * 0.14, 0.169, tie),
            world(edge + end * 0.21, 0.173, tie - 0.032),
            0.012,
            flax,
        )
        beam(
            world(edge + end * 0.21, 0.173, tie - 0.032),
            world(edge + end * 0.245, 0.148, tie - 0.18),
            0.009,
            flax,
        )


def pendant(x, z, base):
    """A counterweight oil pendant with a turned reservoir and a flared enamel shade."""
    beam((x, z, base + 0.41), (x, z, 7.37), 0.012, iron)
    lathe(
        x,
        z,
        base,
        [
            (0, 0.038),
            (0.034, 0.071),
            (0.072, 0.106),
            (0.104, 0.093),
            (0.126, 0.052),
            (0.17, 0.041),
        ],
        brass,
        16,
    )
    lathe(
        x,
        z,
        base + 0.126,
        [(0, 0.041), (0.016, 0.058), (0.084, 0.052), (0.16, 0.032), (0.185, 0.031)],
        enamel,
        16,
    )
    lathe(
        x,
        z,
        base + 0.264,
        [
            (0, 0.228),
            (0.013, 0.235),
            (0.032, 0.21),
            (0.064, 0.16),
            (0.086, 0.086),
            (0.105, 0.062),
            (0.12, 0.06),
            (0.127, 0.04),
        ],
        enamel,
        24,
    )
    for dx in (-0.156, 0.156):
        beam((x + dx, z, base + 0.287), (x, z, base + 0.458), 0.009, brass)
    lathe(x, z, 7.32, [(0, 0.049), (0.015, 0.077), (0.05, 0.093)], walnut, 16)


def belfry():
    # The little sheave and belaying cleat live on the west pier above the ringing floor.
    for dx in (-0.07, 0.07):
        block(79.78 + dx, 23.07, 13.31, 0.035, 0.25, 0.34, iron, 0.014)
    beam((79.66, 23.07, 13.49), (79.90, 23.07, 13.49), 0.044, brass, 12)
    for i in range(3):
        dx = 79.75 + i * 0.034
        beam(
            (dx, 23.07, 13.49),
            (dx + 0.032, 23.07, 13.49),
            0.136 if i != 1 else 0.116,
            oak,
            18,
        )
    beam((81.96, 24.98, 13.59), (79.78, 23.07, 13.61), 0.016, flax, 8)
    beam((79.78, 22.95, 13.5), (79.78, 22.95, 11.79), 0.018, flax, 8)
    block(79.57, 22.95, 11.45, 0.105, 0.39, 0.28, oak, 0.017)
    beam((79.61, 22.75, 11.60), (79.78, 23.13, 11.70), 0.029, iron)
    beam((79.79, 22.75, 11.69), (79.61, 23.13, 11.59), 0.029, iron)
    for k in range(3):
        for j in range(16):
            a, b = math.tau * j / 16, math.tau * (j + 1) / 16

            def coil(t):
                return (
                    79.71 + k * 0.024,
                    22.95 + 0.147 * math.cos(t),
                    11.37 + 0.27 * math.sin(t),
                )

            beam(coil(a), coil(b), 0.012, flax)


def top(kind, x, z):
    for item in layout["cover"]:
        if (
            item["kind"] == kind
            and abs(item["x"] - x) < 0.001
            and abs(item["z"] - z) < 0.001
            and item.get("y0") == 3.3
        ):
            return item["x"] + item["w"] / 2, item["z"] + item["d"] / 2, item["top"]
    raise ValueError(f"Missing upstairs {kind} at {x}, {z}")


for building in layout["buildings"]:
    if building["id"] not in ("saloon", "hotel", "bank", "church_tower"):
        continue
    name = building["id"]
    batch = Batch("Upper fittings " + name)
    for stair in building["stairs"]:
        staircase(stair, name == "church_tower")
    if name == "saloon":
        portal(32, 27.5, 1.8, 0.18, False, "PRIVATE")
        portal(33.10, 37, 1.80, 0.5, True, "OFFICE")
        portal(35, 32, 2, 0.5, True, "LODGINGS")
        washset(*top("table", 28, 30), blue)
        card_parlor(*top("table", 24.6, 35.75))
        ledger(*top("table", 32.1, 40.35))
        trunk(*top("crates", 40, 26))
        rug(28.8, 28.3, 2.4, 2.55, red)
        rug(29.6, 37.7, 1.50, 4.8, sage)
    elif name == "hotel":
        portal(49.9, 32.5, 1.75, 0.5, True, "ROOM 1")
        portal(53, 33.6, 1.9, 0.5, False, "GUEST ROOMS")
        portal(54.7, 36, 1.8, 0.5, True, "ROOM 3")
        for i, (x, z) in enumerate(((46.0, 28.95), (57.7, 29.2), (59.45, 40.95))):
            washset(*top("table", x, z), blue if i != 1 else sage)
        trunk(*top("bench", 54.1, 39.7))
        trunk(*top("bench", 58.5, 33.8), 0.72)
        rug(51.30, 38.50, 1.48, 4.8, red)
        rug(50.35, 30.80, 1.35, 2.16, sage)
        rug(58.92, 31.75, 1.6, 2.4, red)
    elif name == "bank":
        portal(45, 69.1, 2, 0.5, True, "ACCOUNTS")
        portal(50, 67.5, 2, 0.5, True, "RECORDS")
        ledger(*top("counter", 42, 62))
        ledger(*top("table", 47, 72.7))
        x, z, h = top("table", 48.2, 61.75)
        for j in range(4):
            for k in range(1 + j % 3):
                book(
                    x - 0.56 + j * 0.35,
                    z + (0.03 if k % 2 else 0),
                    h + 0.060 * k,
                    0.26,
                    0.40,
                    0.06,
                    (red, leather, sage)[(j + k) % 3],
                )
        rug(44.1, 65.7, 2.15, 2.45, sage)
        rug(46, 70.6, 3.1, 1.28, red)
    else:
        belfry()
    if name in ("hotel", "saloon"):
        for window in building["windows"]:
            if window["floor"] != 1:
                continue
            side, offset = window["side"], window["at"]
            if name == "hotel" and (side == "n" or (side == "e" and offset > 7)):
                curtains(building, window, sage if offset > 7 else red)
            elif name == "saloon" and (
                side == "w" and offset > 8 or side == "n" and offset < 7
            ):
                curtains(building, window, red)
    if name == "saloon":
        pendant(25.6, 36.3, 5.41)
        pendant(33.2, 40.8, 5.47)
    elif name == "bank":
        pendant(43.45, 62.46, 5.55)
        pendant(48.1, 73.13, 5.51)
    batch.export()

bpy.ops.export_scene.gltf(
    filepath=str(out),
    export_format="GLB",
    export_extras=True,
    export_cameras=False,
    export_lights=False,
)
