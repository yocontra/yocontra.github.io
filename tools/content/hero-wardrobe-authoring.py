"""Editable felt-hat and folded-collar construction for the anatomical hero."""
import math
import struct
import zlib

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

TO_BLENDER = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))
FABRIC_REPEAT = 0.008


def fabric(directory):
    """Author an eight-millimeter cotton twill repeat with independent PBR channels."""
    size, threads = 512, 16
    y, x = np.mgrid[0:size, 0:size] / size * threads
    warp, weft = np.cos(x * math.tau), np.cos(y * math.tau)
    over = ((np.floor(x) + np.floor(y)) % 4) < 2
    height = np.where(over, warp * 0.000_035, weft * 0.000_035)
    height += 0.000_004 * np.sin((x * 7 + y * 11) * math.tau)
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / (2 * FABRIC_REPEAT / size)
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) / (2 * FABRIC_REPEAT / size)
    normal = np.stack([-dx, -dy, np.ones_like(dx)], axis=2)
    normal /= np.linalg.norm(normal, axis=2, keepdims=True)
    thread = np.where(over, warp, weft)
    color = np.array([0.09, 0.14, 0.2])[None, None, :] * (1 + thread[:, :, None] * 0.055)
    color *= (1 + 0.012 * np.sin(x * math.tau / 8))[:, :, None]
    color = np.where(color <= 0.0031308, color * 12.92, 1.055 * color ** (1 / 2.4) - 0.055)
    arm = np.stack([0.98 + thread * 0.02, 0.8 - thread * 0.035, np.zeros_like(x)], axis=2)
    directory.mkdir(parents=True, exist_ok=True)
    def png(name, pixels):
        data = np.clip(np.rint(pixels * 255), 0, 255).astype(np.uint8)
        def chunk(kind, content):
            return struct.pack(">I", len(content)) + kind + content + struct.pack(">I", zlib.crc32(kind + content))
        raw = b"".join(b"\0" + row.tobytes() for row in data)
        payload = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
        path = directory / name
        path.write_bytes(payload)
        return path
    paths = {"color": png("shirt-twill.color.png", color), "normal": png("shirt-twill.normal.png", normal * 0.5 + 0.5), "arm": png("shirt-twill.arm.png", arm)}
    cloth = material("Hero woven blue shirt", (0.09, 0.14, 0.2), 0.8)
    nodes, links = cloth.node_tree.nodes, cloth.node_tree.links
    shader = nodes.get("Principled BSDF")
    textures = {}
    for kind, path in paths.items():
        node = nodes.new("ShaderNodeTexImage")
        node.image = bpy.data.images.load(str(path), check_existing=True)
        node.image.colorspace_settings.name = "sRGB" if kind == "color" else "Non-Color"
        textures[kind] = node
    links.new(textures["color"].outputs["Color"], shader.inputs["Base Color"])
    normal_node = nodes.new("ShaderNodeNormalMap")
    normal_node.inputs["Strength"].default_value = 0.6
    links.new(textures["normal"].outputs["Color"], normal_node.inputs["Color"])
    links.new(normal_node.outputs["Normal"], shader.inputs["Normal"])
    channels = nodes.new("ShaderNodeSeparateColor")
    links.new(textures["arm"].outputs["Color"], channels.inputs["Color"])
    links.new(channels.outputs["Green"], shader.inputs["Roughness"])
    return cloth


def material(name, color, roughness):
    value = bpy.data.materials.new(name)
    value.use_nodes = True
    shader = value.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = roughness
    value.diffuse_color = (*color, 1)
    return value


def mesh_object(name, vertices, faces, surface, thickness=0):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    bm = bmesh.new(); bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh); bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    mesh.materials.append(surface)
    for face in mesh.polygons:
        face.use_smooth = True
    if thickness:
        bpy.context.view_layer.objects.active = obj
        modifier = obj.modifiers.new("Material edge thickness", "SOLIDIFY")
        modifier.thickness, modifier.offset = thickness, 0
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    return obj


def hat(head):
    """A seated oval crown, cattleman crease, curled brim and separate leather band."""
    frame = head.to_3x3().normalized()
    origin = head.translation
    def at(x, y, z):
        return TO_BLENDER @ (origin + frame @ Vector((x, y - 0.022, z)))
    felt = material("Hero warm brown felt", (0.12, 0.069, 0.034), 0.86)
    leather = material("Hero hat leather band", (0.034, 0.016, 0.008), 0.58)
    binding = material("Hero rolled brim binding", (0.072, 0.034, 0.015), 0.74)
    segments = 96
    vertices, faces = [], []
    rows = 9
    for ring in range(rows):
        t = ring / (rows - 1)
        rx, rz = 0.091 + t * 0.125, 0.112 + t * 0.071
        for i in range(segments):
            angle = math.tau * i / segments
            # Quarter-roll sides and a dropped front/back retain a working hat silhouette.
            y = 0.113 + 0.035 * t ** 3 * math.cos(angle) ** 8 - 0.009 * t ** 2 * math.sin(angle) ** 2
            vertices.append(at(rx * math.cos(angle), y, rz * math.sin(angle)))
            if ring:
                a, b = (ring - 1) * segments + i, (ring - 1) * segments + (i + 1) % segments
                faces.append((a, b, b + segments, a + segments))
    brim = mesh_object("Felt brim with rolled sides", vertices, faces, felt, 0.0026)
    vertices, faces = [], []
    profiles = [(0.112, 1), (0.132, 1.01), (0.165, 0.99), (0.205, 0.97), (0.242, 0.91), (0.252, 0.83)]
    for ring, (height, radius) in enumerate(profiles):
        for i in range(segments):
            angle = math.tau * i / segments
            x, z = 0.092 * radius * math.cos(angle), 0.113 * radius * math.sin(angle)
            pinch = 1 - 0.06 * max(0, math.sin(angle)) * ring / (len(profiles) - 1)
            y = height - (0.021 * math.exp(-(x / 0.026) ** 2) if ring == len(profiles) - 1 else 0)
            vertices.append(at(x * pinch, y, z))
            if ring:
                a, b = (ring - 1) * segments + i, (ring - 1) * segments + (i + 1) % segments
                faces.append((a, a + segments, b + segments, b))
    # Concentric top panels preserve a longitudinal crease instead of a flat cap.
    for ring in range(1, 6):
        factor = 1 - ring / 6
        offset = len(vertices)
        for i in range(segments):
            angle = math.tau * i / segments
            x, z = 0.092 * 0.83 * factor * math.cos(angle), 0.113 * 0.83 * factor * math.sin(angle)
            vertices.append(at(x, 0.252 - 0.021 * math.exp(-(x / 0.026) ** 2), z))
            a, b = offset - segments + i, offset - segments + (i + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    center = len(vertices); vertices.append(at(0, 0.231, 0))
    for i in range(segments):
        faces.append((center, center - segments + i, center - segments + (i + 1) % segments))
    crown = mesh_object("Cattleman crown with center crease", vertices, faces, felt, 0.0026)
    vertices, faces = [], []
    for ring, y in enumerate([0.133, 0.155, 0.167]):
        for i in range(segments):
            angle = math.tau * i / segments
            vertices.append(at(0.0945 * math.cos(angle), y, 0.1155 * math.sin(angle)))
            if ring:
                a, b = (ring - 1) * segments + i, (ring - 1) * segments + (i + 1) % segments
                faces.append((a, a + segments, b + segments, b))
    band = mesh_object("Separate leather crown band", vertices, faces, leather, 0.0015)
    vertices, faces = [], []
    for ring in range(8):
        turn = math.tau * ring / 8
        for i in range(segments):
            angle = math.tau * i / segments
            radius = 0.0018 * math.cos(turn)
            y = 0.113 + 0.035 * math.cos(angle) ** 8 - 0.009 * math.sin(angle) ** 2 + 0.0018 * math.sin(turn)
            vertices.append(at((0.216 + radius) * math.cos(angle), y, (0.183 + radius) * math.sin(angle)))
            a, b = ring * segments + i, ring * segments + (i + 1) % segments
            c, d = ((ring + 1) % 8) * segments + i, ((ring + 1) % 8) * segments + (i + 1) % segments
            faces.append((a, c, d, b))
    edge = mesh_object("Bound and rolled brim edge", vertices, faces, binding)
    return [brim, crown, band, edge]


def collar(neck, names, common, cloth):
    """A continuous stand and two turned-down collar leaves, with native cloth weights."""
    frame = neck.to_3x3().normalized()
    origin = neck.translation
    vertices, faces, uvs, joints, weights = [], [], [], [], []
    steps = 80
    for ring in range(5):
        t = ring / 4
        # Inner stand rolls outward over the upper edge into the collar leaf.
        radius = 0.052 + (0 if t < 0.5 else (t - 0.5) * 0.049)
        for i in range(steps + 1):
            angle = 0.19 + (math.tau - 0.38) * i / steps
            tip = math.exp(-((min(angle, math.tau - angle) - 0.3) / 0.36) ** 2)
            y = -0.009 + t * 0.056 if t <= 0.5 else 0.019 - (t - 0.5) * (0.068 + 0.07 * tip)
            local = Vector((radius * math.sin(angle), y, radius * 0.87 * math.cos(angle)))
            vertices.append(origin + frame @ local)
            uvs.append((i / steps * math.tau * 0.062 / FABRIC_REPEAT, t * 0.07 / FABRIC_REPEAT))
            joints.append([names.index("Chest"), names.index("Neck"), 0, 0])
            neck_weight = 0.18 * (1 - abs(t - 0.5) * 2)
            weights.append([1 - neck_weight, neck_weight, 0, 0])
            if ring and i:
                a = (ring - 1) * (steps + 1) + i - 1
                faces.append((a, a + 1, a + steps + 2, a + steps + 1))
    obj = common.author_mesh("Folded Western shirt collar", vertices, faces, uvs, joints, weights)
    obj.data.materials.append(cloth)
    bpy.context.view_layer.objects.active = obj
    solid = obj.modifiers.new("Collar seam allowance", "SOLIDIFY")
    solid.thickness, solid.offset = 0.0012, 0
    bpy.ops.object.modifier_apply(modifier=solid.name)
    return obj


def sleeves(bind, names, common, cloth):
    """Cut full sleeves around the real arm chain, including elbow ease and turned cuffs."""
    result = []
    for side in ["L", "R"]:
        shoulder = bind["UpperArm" + side].translation
        elbow = bind["LowerArm" + side].translation
        wrist = bind["Wrist" + side].translation
        a, b = (elbow - shoulder).length, (wrist - elbow).length
        split = a / (a + b)
        inward = bind["Shoulder" + side].translation - shoulder
        cap = shoulder + inward * 0.55
        def center(t):
            if t < 0:
                return cap.lerp(shoulder, max(0, (t + 0.2) / 0.2))
            return shoulder.lerp(elbow, t / split) if t <= split else elbow.lerp(wrist, (t - split) / (1 - split))
        def radius(t):
            if t < 0:
                return 0.002 + 0.065 * math.sin(max(0, (t + 0.2) / 0.2) * math.pi / 2)
            controls = [(-0.08, 0.067), (0.12, 0.072), (0.35, 0.064), (split, 0.066), (0.76, 0.055), (0.94, 0.043), (1.02, 0.044)]
            for (start, first), (end, last) in zip(controls, controls[1:]):
                if t <= end:
                    factor = max(0, min(1, (t - start) / (end - start)))
                    return first + (last - first) * factor
            return controls[-1][1]
        vertices, faces, uvs, joints, weights = [], [], [], [], []
        rings, segments = 37, 48
        for ring in range(rings):
            t = -0.2 + ring / (rings - 1) * 1.22
            at = center(t)
            along = (center(t + 0.04) - center(t - 0.04)).normalized()
            across = along.cross(Vector((0, 0, 1))).normalized()
            normal = across.cross(along).normalized()
            for segment in range(segments + 1):
                angle = math.tau * segment / segments
                # Elbow ease is cut into the sleeve; inner folds have more slack than the outer elbow.
                ease = math.exp(-((t - split) / 0.16) ** 2)
                fold = 0.0036 * ease * math.cos((t - split) * 76 + math.cos(angle) * 1.3) * (0.35 + 0.65 * max(0, math.sin(angle)))
                seam = 0.0015 * math.exp(-((t - 0.04) / 0.015) ** 2)
                p = at + (across * math.cos(angle) + normal * math.sin(angle)) * (radius(t) + fold + seam)
                vertices.append(p)
                uvs.append((segment / segments * math.tau * 0.06 / FABRIC_REPEAT, (t + 0.08) * (a + b) / FABRIC_REPEAT))
                blend = max(0, min(1, (t - split + 0.14) / 0.28))
                blend = blend * blend * (3 - 2 * blend)
                cuff = max(0, min(0.18, (t - 0.9) * 1.5))
                shoulder_weight = max(0, min(1, (0.08 - t) / 0.25))
                shoulder_weight = shoulder_weight * shoulder_weight * (3 - 2 * shoulder_weight)
                joints.append([names.index("UpperArm" + side), names.index("LowerArm" + side), names.index("Wrist" + side), names.index("Shoulder" + side)])
                weights.append([(1 - blend) * (1 - shoulder_weight), blend * (1 - cuff), blend * cuff, (1 - blend) * shoulder_weight])
                if ring and segment:
                    i = (ring - 1) * (segments + 1) + segment - 1
                    faces.append((i, i + 1, i + segments + 2, i + segments + 1))
        sleeve = common.author_mesh("Shaped Western shirt sleeve " + side, vertices, faces, uvs, joints, weights)
        sleeve.data.materials.append(cloth)
        bpy.context.view_layer.objects.active = sleeve
        solid = sleeve.modifiers.new("Sewn sleeve edge thickness", "SOLIDIFY")
        solid.thickness, solid.offset = 0.0013, -0.5
        bpy.ops.object.modifier_apply(modifier=solid.name)
        for polygon in sleeve.data.polygons:
            polygon.use_smooth = True
        result.append(sleeve)
        # A separate doubled cuff has a rolled edge and an opening for the hand.
        vertices, faces, uvs, joints, weights = [], [], [], [], []
        for ring, (t, r) in enumerate([(0.91, 0.0445), (0.92, 0.047), (1.005, 0.047), (1.015, 0.0445)]):
            along = (wrist - elbow).normalized()
            across = along.cross(Vector((0, 0, 1))).normalized()
            normal = across.cross(along).normalized()
            for segment in range(segments + 1):
                angle = math.tau * segment / segments
                vertices.append(center(t) + (across * math.cos(angle) + normal * math.sin(angle)) * r)
                uvs.append((segment / segments * math.tau * 0.047 / FABRIC_REPEAT, (t - 0.91) * (a + b) / FABRIC_REPEAT))
                joints.append([names.index("LowerArm" + side), names.index("Wrist" + side), 0, 0])
                weights.append([0.9, 0.1, 0, 0])
                if ring and segment:
                    i = (ring - 1) * (segments + 1) + segment - 1
                    faces.append((i, i + 1, i + segments + 2, i + segments + 1))
        cuff = common.author_mesh("Turned shirt cuff " + side, vertices, faces, uvs, joints, weights)
        cuff.data.materials.append(cloth)
        bpy.context.view_layer.objects.active = cuff
        solid = cuff.modifiers.new("Doubled cuff thickness", "SOLIDIFY")
        solid.thickness, solid.offset = 0.0015, -0.5
        bpy.ops.object.modifier_apply(modifier=solid.name)
        result.append(cuff)
    return result


def shirt(bind, names, common, cloth):
    """Construct the shirt body, shoulder yoke and front placket around the native torso."""
    profiles = [(0.935, 0.145, 0.105), (1.02, 0.147, 0.108), (1.14, 0.16, 0.112), (1.25, 0.174, 0.112), (1.335, 0.173, 0.095), (1.38, 0.134, 0.075), (1.437, 0.055, 0.048)]
    bones = ["Hips", "Abdomen", "Torso", "Chest", "Neck"]
    anchors = sorted([(bind[name].translation.y, name, bind[name].translation) for name in bones])
    right = (bind["UpperArmL"].translation - bind["UpperArmR"].translation).normalized()
    def center(y):
        for (low, _, a), (high, _, b) in zip(anchors, anchors[1:]):
            if y <= high:
                return a.lerp(b, (y - low) / (high - low))
        low, _, a = anchors[-2]
        high, _, b = anchors[-1]
        return a.lerp(b, (y - low) / (high - low))
    def profile(y):
        for (lo, ax, az), (hi, bx, bz) in zip(profiles, profiles[1:]):
            if y <= hi:
                t = (y - lo) / (hi - lo)
                t = max(0, min(1, t))
                return ax + (bx - ax) * t, az + (bz - az) * t
        return profiles[-1][1:]
    vertices, faces, uvs, joints, weights = [], [], [], [], []
    rings, segments = 49, 80
    for ring in range(rings):
        y = profiles[0][0] + ring / (rings - 1) * (profiles[-1][0] - profiles[0][0])
        at = center(y)
        up = (center(y + 0.002) - center(y - 0.002)).normalized()
        across = (right - up * right.dot(up)).normalized()
        front = across.cross(up).normalized()
        rx, rz = profile(y)
        lo, hi = next(((a, b) for a, b in zip(anchors, anchors[1:]) if y <= b[0]), (anchors[-2], anchors[-1]))
        blend = max(0, min(1, (y - lo[0]) / (hi[0] - lo[0])))
        for segment in range(segments + 1):
            angle = math.tau * segment / segments
            side = math.sin(angle)
            # Tail ease and small tension folds run into the waistband, with a sewn back yoke.
            slack = math.exp(-((y - 1.01) / 0.07) ** 2)
            fold = 0.0028 * slack * math.sin(angle * 9 + y * 25) * (0.3 + 0.7 * abs(side))
            yoke = 0.0012 * math.exp(-((y - 1.32) / 0.006) ** 2) * max(0, -math.cos(angle))
            front_angle = min(angle, math.tau - angle)
            placket = 0.0014 if front_angle < 0.075 else 0
            vertices.append(at + across * side * (rx + fold) + front * math.cos(angle) * (rz + fold + yoke + placket))
            uvs.append((segment / segments * math.tau * 0.14 / FABRIC_REPEAT, (y - profiles[0][0]) / FABRIC_REPEAT))
            shoulder_weight = max(0, min(0.65, (y - 1.28) / 0.14 * abs(side) ** 4))
            if y > 1.38:
                shoulder_weight *= max(0, (1.437 - y) / 0.057)
            shoulder = "ShoulderL" if side >= 0 else "ShoulderR"
            joints.append([names.index(lo[1]), names.index(hi[1]), names.index(shoulder), 0])
            weights.append([(1 - blend) * (1 - shoulder_weight), blend * (1 - shoulder_weight), shoulder_weight, 0])
            if ring and segment:
                i = (ring - 1) * (segments + 1) + segment - 1
                faces.append((i, i + 1, i + segments + 2, i + segments + 1))
    obj = common.author_mesh("Constructed Western shirt body and yoke", vertices, faces, uvs, joints, weights)
    obj.data.materials.append(cloth)
    bpy.context.view_layer.objects.active = obj
    solid = obj.modifiers.new("Shirt hem and placket thickness", "SOLIDIFY")
    solid.thickness, solid.offset = 0.0013, -0.5
    bpy.ops.object.modifier_apply(modifier=solid.name)
    return obj
