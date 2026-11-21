"""Blender mesh helpers for fitted hats."""

import math

import bpy


def material(name, color, roughness, metal=0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metal
    return mat


def surface(name, rings, steps, mat, invert=False, seal=False, omit=None):
    verts = [ring(i * math.tau / steps) for ring in rings for i in range(steps)]
    faces = []
    for j in range(len(rings) - 1):
        for i in range(steps):
            if omit and omit(j, i):
                continue
            a = j * steps + i
            b = j * steps + (i + 1) % steps
            face = (a, b, b + steps, a + steps)
            faces.append(face[::-1] if invert else face)
    if seal:
        faces.append(tuple(range(len(verts) - steps, len(verts))))
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    data.materials.append(mat)
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    uv = data.uv_layers.new(name="Felt")
    for face in data.polygons:
        face.use_smooth = len(face.vertices) == 4
        base = min(data.loops[i].vertex_index % steps for i in face.loop_indices)
        for j in face.loop_indices:
            index = data.loops[j].vertex_index
            t = index % steps
            if (
                base == 0
                and t == 0
                and any(
                    data.loops[i].vertex_index % steps == steps - 1
                    for i in face.loop_indices
                )
            ):
                t = steps
            uv.data[j].uv = (t / steps, (index // steps) / (len(rings) - 1))
    return obj
