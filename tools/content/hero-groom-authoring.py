"""Author short eyebrow fibers against the actual anatomical facial surface."""
import math
import random

import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

TO_BLENDER = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))


def eyebrows(positions, faces, groups, transform):
    surface = BVHTree.FromPolygons(positions, [[i for i, _ in face] for face in faces])
    head, anchor, rotation, scale = transform
    def fitted(point):
        return TO_BLENDER @ (anchor + rotation @ (point - head) * scale)
    material = bpy.data.materials.new("Hero short brown brow fibers")
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (0.022, 0.009, 0.003, 1)
    shader.inputs["Roughness"].default_value = 0.78
    rng = random.Random(2371)
    objects = []
    for side, sign in [("l", 1), ("r", -1)]:
        center = sum((positions[i] for i in groups["joint-" + side + "-eye"]), Vector()) / len(groups["joint-" + side + "-eye"])
        vertices, polygons = [], []
        for strand in range(480):
            t = (strand + rng.random()) / 480
            breadth = 0.0025 * max(0.2, math.sin(t * math.pi))
            sample = center + Vector((sign * (t - 0.5) * 0.044, 0.015 + 0.004 * math.sin(t * math.pi) + rng.uniform(-breadth, breadth), 0.017))
            point, normal, _, _ = surface.find_nearest(sample)
            if point is None:
                raise ValueError("Eyebrow lost its anatomical surface")
            direction = Vector((sign * (0.5 + t), -0.22, 0))
            direction -= normal * direction.dot(normal)
            direction.normalize()
            width = normal.cross(direction).normalized()
            length = rng.uniform(0.0035, 0.0055) * (0.8 + 0.2 * math.sin(t * math.pi))
            start = len(vertices)
            for section in range(3):
                along = section / 2
                at = point + normal * (0.0003 + math.sin(along * math.pi) * 0.00018) + direction * length * along
                half = 0.00022 * (1 - 0.92 * along)
                vertices.extend([fitted(at - width * half), fitted(at + width * half)])
            polygons.extend([(start, start + 2, start + 3, start + 1), (start + 2, start + 4, start + 5, start + 3)])
        mesh = bpy.data.meshes.new("Short brow fibers " + side)
        mesh.from_pydata(vertices, [], polygons); mesh.update()
        obj = bpy.data.objects.new(mesh.name, mesh)
        bpy.context.collection.objects.link(obj)
        mesh.materials.append(material)
        objects.append(obj)
    return objects
