"""Shape the starter head from CC0 anatomy and scanned skin maps."""

import sys
from pathlib import Path

import bpy

root = Path(sys.argv[sys.argv.index("--") + 1])
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for data in list(bpy.data.meshes):
    if not data.users:
        bpy.data.meshes.remove(data)
for mat in list(bpy.data.materials):
    if not mat.users:
        bpy.data.materials.remove(mat)

vertices = []
uvs = []
faces = []
group = ""
for line in (root / "base.obj").read_text().splitlines():
    command, *value = line.split() or [""]
    if command == "v":
        vertices.append(tuple(map(float, value[:3])))
    elif command == "vt":
        uvs.append(tuple(map(float, value[:2])))
    elif command == "g":
        group = value[0]
    elif command == "f" and group == "body":
        faces.append([tuple(int(n) - 1 for n in part.split("/")[:2]) for part in value])

for line in (root / "male-young.target").read_text().splitlines():
    fields = line.split()
    if fields and fields[0].isdigit():
        index = int(fields[0])
        vertices[index] = tuple(
            component + float(delta)
            for component, delta in zip(vertices[index], fields[1:])
        )


# Align the reconstructed head to the player's neutral pair of eye positions.
# All coordinates in the exported mesh are metres, in the player's bind pose.
def position(src):
    x, y, z = src
    across = -0.027 + x * 0.103
    up = 1.584 + (y - 8.2164) * 0.113
    front = 0.107 + (z - 1.304) * 0.094

    # Seat the new skin under the existing hair shell and scarf.
    scalp = max(0, min(1, (up - 1.543) / 0.052))
    rear = max(0, min(1, (0.068 - front) / 0.103))
    across = -0.027 + (across + 0.027) * (1 - 0.12 * scalp * rear)
    front += 0.019 * scalp * rear
    collar = max(0, min(1, (1.480 - up) / 0.048))
    across = -0.017 + (across + 0.017) * (1 - 0.27 * collar)
    front -= 0.029 * collar
    return across, -front, up


def clip_head(poly, height):
    out = []
    for i, a in enumerate(poly):
        b = poly[(i + 1) % len(poly)]
        ay, by = a[0][1], b[0][1]
        if ay >= height:
            out.append(a)
        if (ay >= height) == (by >= height):
            continue
        weight = (height - ay) / (by - ay)
        out.append(
            tuple(
                tuple(x + (y - x) * weight for x, y in zip(old, new))
                for old, new in zip(a, b)
            )
        )
    return out


points = []
index_by_point = {}
polys = []
uv_faces = []
for indices in faces:
    polygon = clip_head([(vertices[v], uvs[uv]) for v, uv in indices], 6.82)
    if len(polygon) < 3:
        continue
    face = []
    for origin, uv in polygon:
        p = tuple(round(x, 7) for x in position(origin))
        if p not in index_by_point:
            index_by_point[p] = len(points)
            points.append(p)
        face.append(index_by_point[p])
    if len(set(face)) == len(face):
        polys.append(face)
        uv_faces.append([uv for _, uv in polygon])

mesh = bpy.data.meshes.new("Neutral starter head, anatomical topology")
mesh.from_pydata(points, [], polys)
mesh.update()
uv_layer = mesh.uv_layers.new(name="Skin atlas")
for p in mesh.polygons:
    p.use_smooth = True
    for loop, value in zip(p.loop_indices, uv_faces[p.index]):
        uv_layer.data[loop].uv = value

head = bpy.data.objects.new("Starter head", mesh)
bpy.context.collection.objects.link(head)
material = bpy.data.materials.new("Field-worn skin")
material.use_nodes = True
nodes = material.node_tree.nodes
links = material.node_tree.links
skin = nodes["Principled BSDF"]
skin.inputs["Roughness"].default_value = 0.59
skin.inputs["Metallic"].default_value = 0
albedo = nodes.new("ShaderNodeTexImage")
albedo.image = bpy.data.images.load(str(root / "face-freckles.png"))
links.new(albedo.outputs["Color"], skin.inputs["Base Color"])
detail = nodes.new("ShaderNodeTexImage")
detail.image = bpy.data.images.load(str(root / "face-normal.png"))
detail.image.colorspace_settings.name = "Non-Color"
normal = nodes.new("ShaderNodeNormalMap")
normal.inputs["Strength"].default_value = 0.63
links.new(detail.outputs["Color"], normal.inputs["Color"])
links.new(normal.outputs["Normal"], skin.inputs["Normal"])
mesh.materials.append(material)

bpy.ops.export_scene.gltf(
    filepath=str((root / "starter-head.blender.glb").resolve()),
    export_format="GLB",
    export_yup=True,
)
print("Starter head:", len(mesh.vertices), "vertices,", len(mesh.polygons), "faces")
