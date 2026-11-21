"""Author the small props for all four Quick Draw scenes."""

import math
import sys
from pathlib import Path

import bpy

destination = Path(sys.argv[sys.argv.index("--") + 1])
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)


def material(name, rgb, roughness, metalness=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*rgb, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Metallic"].default_value = metalness
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


mat_oak = material("Oak end grain", (0.68, 0.46, 0.24), 0.80)
mat_worn_oak = material("Oak worn boards", (0.74, 0.54, 0.31), 0.84)
mat_iron = material("Riveted dark iron", (0.19, 0.15, 0.11), 0.70, 0.82)
mat_tin = material("Tarnished soldered tin", (0.39, 0.36, 0.29), 0.73, 0.76)
mat_mouth = material("Dark tin inner face", (0.24, 0.22, 0.18), 0.81, 0.64)
mat_hemp = material("Twisted hemp cord", (0.52, 0.36, 0.16), 0.89)
mat_hemp_wear = material("Faded hemp cord", (0.62, 0.43, 0.22), 0.88)
mat_glass = material("Dark green bottle glass", (0.10, 0.16, 0.07), 0.46, 0.04)
mat_paper = material("Scuffed cream paper", (0.67, 0.52, 0.31), 0.86)
mat_burlap = material("Burlap sack weave", (0.43, 0.30, 0.16), 0.94)
mat_cork = material("Old bottle cork", (0.33, 0.22, 0.10), 0.97)


def model(name):
    root = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(root)
    return root


def mesh(root, name, coords, faces, mat, smooth=False):
    shape = bpy.data.meshes.new(name)
    shape.from_pydata(coords, [], faces)
    shape.update()
    obj = bpy.data.objects.new(name, shape)
    bpy.context.collection.objects.link(obj)
    obj.parent = root
    obj.data.materials.append(mat)
    for face in shape.polygons:
        face.use_smooth = smooth
    return obj


def box(root, name, center, size, mat, bevel=0.004):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.parent = root
    obj.data.materials.append(mat)
    if bevel:
        edge = obj.modifiers.new("Worn arris", "BEVEL")
        edge.width = bevel
        edge.segments = 2
    return obj


def lathe(root, name, rings, mat, sides=37, dents=0.0):
    coords, faces = [], []
    for row, (height, radius) in enumerate(rings):
        for i in range(sides):
            a = i * math.tau / sides
            r = radius * (1 + dents * math.sin(a * 6 + row * 0.23))
            coords.append((r * math.cos(a), r * math.sin(a), height))
    for row in range(len(rings) - 1):
        lower, upper = row * sides, (row + 1) * sides
        for i in range(sides):
            j = (i + 1) % sides
            faces.append((lower + i, lower + j, upper + j, upper + i))
    return mesh(root, name, coords, faces, mat, True)


def cord(root, name, samples, radius, mat):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = 2
    curve.resolution_u = 1
    curve.use_fill_caps = True
    strand = curve.splines.new("POLY")
    strand.points.add(len(samples) - 1)
    for point, xyz in zip(strand.points, samples):
        point.co = (*xyz, 1)
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.parent = root
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.object.convert(target="MESH")
    obj.data.materials.append(mat)


pail = model("k_bucket_kit")
count = 15
for i in range(count):
    t = i * math.tau / count
    angle = math.pi / count - 0.014
    wide = 0.25 + 0.004 * math.sin(i * 2.83)
    levels = ((0.02, 0.204), (0.15, 0.218), (0.42, wide))
    vertices = [
        (rad * math.cos(a), rad * math.sin(a), h)
        for h, r in levels
        for rad, a in ((r - 0.017, t - angle), (r, t - angle), (r, t + angle), (r - 0.017, t + angle))
    ]
    faces = [(3, 2, 1, 0), (8, 9, 10, 11)]
    for row in range(2):
        k = row * 4
        faces.extend((k + j, k + (j + 1) % 4, k + (j + 1) % 4 + 4, k + j + 4) for j in range(4))
    mesh(pail, "Coopered oak stave", vertices, faces, mat_worn_oak if i % 4 == 1 else mat_oak)
for z, radius in ((0.065, 0.212), (0.32, 0.245)):
    lathe(pail, "Forged band", [(z, radius - 0.009), (z, radius), (z + 0.038, radius + 0.001), (z + 0.04, radius - 0.012)], mat_iron)
lathe(pail, "Oak interior floor", [(0.016, .0), (0.025, 0.202), (0.034, 0.202), (0.04, 0.0)], mat_oak)
cord(pail, "Wire bail handle", [(0.245 * math.cos(t), 0.02, 0.36 + 0.21 * math.sin(t)) for t in [i * math.pi / 27 for i in range(28)]], 0.007, mat_iron)

pail = model("k_bucket_metal_kit")
lathe(pail, "Dented tin body", [(0.012, 0), (0.012, .176), (.024, .182), (.061, .177), (.405, .239), (.426, .244), (.435, .239), (.428, .224), (.404, .225), (.042, .161), (.035, 0)], mat_tin, dents=0.019)
lathe(pail, "Dark neck rim", [(.415, .232), (.418, .245), (.436, .244), (.438, .229)], mat_mouth, dents=.009)
cord(pail, "Wire bail handle", [(0.239 * math.cos(t), 0.0, 0.35 + 0.2 * math.sin(t)) for t in [i * math.pi / 27 for i in range(28)]], 0.006, mat_iron)

sack = model("k_sack_kit")
lathe(sack, "Seamed hessian sack", [
    (0, 0), (.008, .18), (.044, .267), (.18, .30), (.29, .28),
    (.37, .21), (.42, .093), (.45, .075), (.485, .13), (.505, .12),
    (.496, .091), (.47, .06), (.46, 0),
], mat_burlap, sides=35, dents=.079)
for strand in range(2):
    cord(sack, "Waxed drawstring", [
        ((.08 + .003 * math.sin(a * 7)) * math.cos(a), (.08 + .003 * math.sin(a * 7)) * math.sin(a), .438 + strand * .005 + .006 * math.sin(a * 2))
        for a in [i * math.tau / 48 for i in range(49)]
    ], .0042, mat_hemp)

rope = model("k_rope_kit")
for strand in range(3):
    points = []
    for i in range(248):
        u = i / 247
        turn = u * 5.0
        a = turn * math.tau
        angle = a * 9 + strand * math.tau / 3
        tail = max(0, (u - .90) * 10)
        r = 0.181 + .091 * u + .055 * tail**2 + .0038 * math.cos(angle)
        z = 0.014 + u * 0.01 + .0041 * math.sin(angle)
        points.append((r * math.cos(a), r * math.sin(a), z))
    cord(rope, "Laid hemp strand", points, .0037, mat_hemp if strand != 1 else mat_hemp_wear)

bottle = model("k_bottle_kit")
lathe(bottle, "Mold-blown dark glass", [(0, 0), (.006, .058), (.024, .066), (.145, .064), (.172, .060), (.190, .045), (.207, .027), (.264, .024), (.278, .029), (.289, .028), (.289, .018), (.276, .016), (.253, .016)], mat_glass, sides=33, dents=.016)
lathe(bottle, "Wraparound paper label", [(.066, .066), (.074, .067), (.14, .0657), (.144, .0644)], mat_paper, sides=33, dents=.016)
lathe(bottle, "Cork", [(.258, .014), (.292, .018), (.302, .019), (.304, 0)], mat_cork, sides=22)

for name, size in (("k_farmcrate_kit", (.68, .48, .48)), ("k_crate_big_kit", (1.05, .73, .79))):
    crate = model(name)
    width, depth, height = size
    for i in range(4):
        z = height * (i + 0.5) / 4
        board = mat_oak if i % 3 == 0 else mat_worn_oak
        for side in (-1, 1):
            box(crate, "Sawn horizontal oak slat", (0, side * (depth / 2 - .018), z), (width, .036, height / 4 - .007), board)
            box(crate, "Sawn oak end slat", (side * (width / 2 - .018), 0, z), (.035, depth - .071, height / 4 - .007), board)
    for side in (-1, 1):
        for x in (-width * .39, width * .39):
            box(crate, "Raised nailed corner cleat", (x, side * (depth / 2 + .003), height / 2), (.071, .028, height), mat_oak)
            for z in (height * .16, height * .45, height * .82):
                box(crate, "Square nail", (x, side * (depth / 2 + .019), z), (.012, .005, .011), mat_iron, .0015)
    for i in range(4):
        x = -width / 2 + width * (i + .5) / 4
        lid = name == "k_crate_big_kit"
        z = height - .015 if lid else .017
        board = "Removable lid plank" if lid else "Crate floor slat"
        box(crate, board, (x, 0, z), (width / 4 - .005, depth, .031), mat_oak if i % 2 else mat_worn_oak)

# Combine components with the same material to keep the batch small.
for root in [obj for obj in bpy.context.scene.objects if obj.type == "EMPTY"]:
    groups = {}
    for child in root.children:
        bpy.context.view_layer.objects.active = child
        bpy.ops.object.select_all(action="DESELECT")
        child.select_set(True)
        for modifier in list(child.modifiers):
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        groups.setdefault(child.data.materials[0].name, []).append(child)
    for mat, objects in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if len(objects) > 1:
            bpy.ops.object.join()
        objects[0].name = mat

bpy.ops.export_scene.gltf(filepath=str(destination), export_format="GLB", export_yup=True)
