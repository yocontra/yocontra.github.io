"""Fit a licensed human head/hands to the existing hero skin, entirely offline.

blender --background --factory-startup --python tools/content/hero-foundation-authoring.py
This is an isolated reference candidate, not a replacement of the live catalog.
The saved .blend keeps the imported CC0 topology, UVs and native joint weights
editable. No MPFB addon or runtime procedural character generator is required.
"""
import copy
import gzip
import hashlib
import importlib.util
import json
import math
import struct
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / "tools/art/characters/hero"
CC0 = DIRECTORY / "cc0"
spec = importlib.util.spec_from_file_location("garments", Path(__file__).with_name("coat-sleeves-authoring.py"))
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
wardrobe_spec = importlib.util.spec_from_file_location("hero_wardrobe", Path(__file__).with_name("hero-wardrobe-authoring.py"))
wardrobe = importlib.util.module_from_spec(wardrobe_spec)
wardrobe_spec.loader.exec_module(wardrobe)
groom_spec = importlib.util.spec_from_file_location("hero_groom", Path(__file__).with_name("hero-groom-authoring.py"))
groom = importlib.util.module_from_spec(groom_spec)
groom_spec.loader.exec_module(groom)
MORPHS = {
    "caucasian-male-young.target.gz": 0.78,
    "caucasian-male-old.target.gz": 0.22,
    "universal-male-young-maxmuscle-averageweight.target.gz": 0.25,
}
BASE_NAMES = {"head": "Head", "neck_01": "Neck", "pelvis": "Hips", "spine_01": "Abdomen", "spine_02": "Torso", "spine_03": "Chest"}
SIDE_NAMES = {"clavicle": "Shoulder", "upperarm": "UpperArm", "lowerarm": "LowerArm", "hand": "Wrist", "thigh": "UpperLeg", "calf": "LowerLeg", "foot": "Foot", "ball": "Foot"}
TO_BLENDER = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))


def mapped(name):
    if name in BASE_NAMES:
        return BASE_NAMES[name]
    stem, side = name.rsplit("_", 1) if "_" in name else (name, "")
    if stem in SIDE_NAMES:
        return SIDE_NAMES[stem] + side.upper()
    if "_" in stem:
        finger, number = stem.split("_")
        if finger in ["thumb", "index", "middle", "ring", "pinky"]:
            return finger.capitalize() + str(int(number)) + side.upper()
    return None


def inputs():
    manifest = json.loads((CC0 / "provenance.json").read_text())
    result = []
    for entry in manifest["files"]:
        path = ROOT / entry["path"]
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != entry["sha256"]:
            raise ValueError(f"CC0 source changed: {path}")
        result.append({"path": entry["path"], "sha256": digest})
    for path in [CC0 / "provenance.json", Path(__file__), Path(common.__file__), Path(wardrobe.__file__), Path(groom.__file__), DIRECTORY.parent / "player.gltf", DIRECTORY.parent / "player.bin"]:
        result.append({"path": str(path.relative_to(ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    return result


def source_mesh():
    positions, uv, faces, groups, group = [], [], [], {}, ""
    for line in (CC0 / "base.obj").read_text().splitlines():
        row = line.split()
        if not row or row[0].startswith("#"):
            continue
        if row[0] == "v":
            positions.append(Vector(map(float, row[1:4])))
        elif row[0] == "vt":
            uv.append(tuple(map(float, row[1:3])))
        elif row[0] == "g":
            group = row[1]
            groups.setdefault(group, set())
        elif row[0] == "f":
            corners = [tuple(int(i) - 1 for i in item.split("/")[:2]) for item in row[1:]]
            groups[group].update(i for i, _ in corners)
            if group == "body":
                faces.append(corners)
    for name, amount in MORPHS.items():
        for line in gzip.decompress((CC0 / name).read_bytes()).decode().splitlines():
            row = line.split()
            if row and not row[0].startswith("#"):
                positions[int(row[0])] += Vector(map(float, row[1:4])) * amount
    # MakeHuman graphic coordinates are decimeters, Y up, facing +Z.
    positions = [p * 0.1 for p in positions]
    return positions, uv, faces, groups


def landmark(definition, positions, groups):
    if definition["strategy"] == "CUBE":
        indices = groups[definition["cube_name"]]
    elif definition["strategy"] == "MEAN":
        indices = definition["vertex_indices"]
    else:
        raise ValueError(f"Unknown rig landmark strategy {definition}")
    return sum((positions[i] for i in indices), Vector()) / len(indices)


def fit(positions, groups, source):
    skin = source.doc["skins"][0]
    names = [source.doc["nodes"][n]["name"] for n in skin["joints"]]
    bind = {}
    for name, values in zip(names, source.accessor(skin["inverseBindMatrices"])):
        bind[name] = Matrix([values[i:i + 4] for i in range(0, 16, 4)]).transposed().inverted()
    rig = json.loads((CC0 / "rig.game_engine.json").read_text())
    raw_weights = json.loads((CC0 / "weights.game_engine.json").read_text())["weights"]
    weights = [[] for _ in positions]
    transforms, landmarks = {}, {}
    donor = bpy.data.armatures.new("CC0 landmark rig")
    arm = bpy.data.objects.new("CC0 landmark rig", donor)
    bpy.context.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for name, definition in rig.items():
        target = mapped(name)
        if not target or target not in bind:
            continue
        head = landmark(definition["head"], positions, groups)
        tail = landmark(definition["tail"], positions, groups)
        bone = donor.edit_bones.new(name)
        bone.head, bone.tail = TO_BLENDER @ head, TO_BLENDER @ tail
        bone.roll = definition["roll"]
        frame = TO_BLENDER.transposed() @ bone.matrix.to_3x3()
        canonical = bind[target].to_3x3().normalized()
        # Lengths are retargeted at authoring time; the native skin keeps its bind matrices.
        target_node = source.doc["nodes"][skin["joints"][names.index(target)]]
        children = [source.doc["nodes"][n].get("name") for n in target_node.get("children", [])]
        child = next((child for child in children if child in bind and child not in ["ShoulderL", "ShoulderR"]), None)
        scale = (bind[child].translation - bind[target].translation).length / (tail - head).length if child else 1.05
        if target in ["Head", "Neck"]:
            scale = 1.05
        transforms[name] = (head, bind[target].translation, canonical @ frame.transposed(), scale)
        landmarks[name] = {"sourceHead": list(head), "targetHead": list(bind[target].translation), "scale": scale}
        for index, weight in raw_weights.get(name, []):
            if weight > 0:
                weights[index].append((name, target, weight))
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.data.objects.remove(arm, do_unlink=True)
    # Bone roll is a rig convention, not anatomy. Construct the hand frames
    # from metacarpal landmarks so donor palm/finger surfaces keep their side.
    def frame(axis, forward):
        y = axis.normalized()
        x = y.cross(forward).normalized()
        z = x.cross(y).normalized()
        return Matrix((x, y, z)).transposed()
    for side in ["l", "r"]:
        upper = side.upper()
        wrist = landmark(rig["hand_" + side]["head"], positions, groups)
        middle = landmark(rig["middle_01_" + side]["head"], positions, groups)
        index = landmark(rig["index_01_" + side]["head"], positions, groups)
        pinky = landmark(rig["pinky_01_" + side]["head"], positions, groups)
        target_wrist = bind["Wrist" + upper].translation
        target_middle = bind["Middle1" + upper].translation
        target_index = bind["Index1" + upper].translation
        target_pinky = bind["Pinky1" + upper].translation
        donor_normal = (index - pinky).cross(middle - wrist).normalized()
        target_normal = (target_index - target_pinky).cross(target_middle - target_wrist).normalized()
        for name in transforms:
            if not name.endswith("_" + side) or not name.startswith(("hand_", "lowerarm_", "thumb_", "index_", "middle_", "ring_", "pinky_")):
                continue
            target = mapped(name)
            head = landmark(rig[name]["head"], positions, groups)
            tail = landmark(rig[name]["tail"], positions, groups)
            target_head = bind[target].translation
            if name.startswith("hand_"):
                tail, target_tail = middle, target_middle
            elif name.startswith("lowerarm_"):
                target_tail = target_wrist
            else:
                stem, number, _ = name.split("_")
                next_target = stem.capitalize() + str(int(number) + 1) + upper
                if next_target in bind:
                    target_tail = bind[next_target].translation
                else:
                    previous = stem.capitalize() + str(int(number) - 1) + upper
                    previous_source = stem + "_" + str(int(number) - 1).zfill(2) + "_" + side
                    previous_head = landmark(rig[previous_source]["head"], positions, groups)
                    ratio = (target_head - bind[previous].translation).length / (head - previous_head).length
                    target_tail = target_head + bind[target].to_3x3().normalized() @ Vector((0, (tail - head).length * ratio, 0))
            scale = (target_tail - target_head).length / (tail - head).length
            rotation = frame(target_tail - target_head, target_normal) @ frame(tail - head, donor_normal).transposed()
            transforms[name] = (head, target_head, rotation, scale)
            landmarks[name]["scale"] = scale
    output, joint_rows, weight_rows = [], [], []
    for i, point in enumerate(positions):
        row = sorted(weights[i], key=lambda v: -v[2])[:4]
        total = sum(w for _, _, w in row)
        if total <= 0:
            output.append(point.copy())
            joint_rows.append([0] * 4)
            weight_rows.append([0] * 4)
            continue
        placed = Vector()
        merged = {}
        for bone, target, weight in row:
            head, anchor, rotation, scale = transforms[bone]
            placed += (anchor + rotation @ (point - head) * scale) * (weight / total)
            merged[names.index(target)] = merged.get(names.index(target), 0) + weight / total
        pairs = sorted(merged.items(), key=lambda value: -value[1])
        output.append(placed)
        joint_rows.append([pairs[k][0] if k < len(pairs) else 0 for k in range(4)])
        weight_rows.append([pairs[k][1] if k < len(pairs) else 0 for k in range(4)])
    # The face and neck are one continuous anatomical surface. A common fitted
    # frame avoids importing unrelated donor/native axial roll conventions into
    # that surface; native neck/head weights still drive subsequent deformation.
    head, anchor, rotation, scale = transforms["head"]
    for i, point in enumerate(positions):
        if point.y > 0.65:
            fitted = point.copy()
            if point.y < 0.74:
                blend = max(0, min(1, (0.74 - point.y) / 0.06))
                blend = blend * blend * (3 - 2 * blend)
                center_z = head.z + (point.y - head.y) * 0.1
                radius = math.hypot(point.x / 0.05, (point.z - center_z) / 0.046)
                if radius > 1:
                    fitted.x *= 1 - blend + blend / radius
                    fitted.z = center_z + (point.z - center_z) * (1 - blend + blend / radius)
            output[i] = anchor + rotation @ (fitted - head) * scale
    return output, joint_rows, weight_rows, names, landmarks, weights, bind, transforms


def material():
    value = bpy.data.materials.new("Hero skin · CC0 diffuse reference")
    value.use_nodes = True
    bsdf = value.node_tree.nodes.get("Principled BSDF")
    image = bpy.data.images.load(str(next(CC0.glob("*.png"))))
    image.colorspace_settings.name = "sRGB"
    node = value.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = image
    value.node_tree.links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.48
    bsdf.inputs["Subsurface Weight"].default_value = 0.07
    return value


def create_patch(positions, uvs, faces, joints, weights, selected, label, skin):
    lookup, vertices, texcoords, jrows, wrows, polys = {}, [], [], [], [], []
    for face in faces:
        if not all(i in selected for i, _ in face):
            continue
        corners = []
        for i, uv in face:
            if i not in lookup:
                lookup[i] = len(vertices)
                vertices.append(positions[i]); texcoords.append(uvs[uv])
                jrows.append(joints[i]); wrows.append(weights[i])
            corners.append(lookup[i])
        polys.append(corners)
    obj = common.author_mesh(label, vertices, polys, texcoords, jrows, wrows)
    kept = [face for face in faces if all(i in selected for i, _ in face)]
    for polygon, face in zip(obj.data.polygons, kept):
        for loop, (_, uv) in zip(polygon.loop_indices, face):
            obj.data.uv_layers.active.data[loop].uv = uvs[uv]
    obj.data.materials.append(skin)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def add_eyes(original, groups, transform):
    head, anchor, rotation, scale = transform
    sclera = bpy.data.materials.new("Sclera reference")
    sclera.diffuse_color = (0.67, 0.64, 0.58, 1)
    sclera.use_nodes = True
    sclera.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = sclera.diffuse_color
    sclera.node_tree.nodes.get("Principled BSDF").inputs["Roughness"].default_value = 0.28
    iris = bpy.data.materials.new("Brown iris reference")
    iris.use_nodes = True
    iris.node_tree.nodes.get("Principled BSDF").inputs["Roughness"].default_value = 0.3
    color = iris.node_tree.nodes.new("ShaderNodeVertexColor")
    color.layer_name = "Iris pigment"
    iris.node_tree.links.new(color.outputs["Color"], iris.node_tree.nodes.get("Principled BSDF").inputs["Base Color"])
    objects = []
    radius = 0.0128
    for side in ["l", "r"]:
        center = sum((original[i] for i in groups["joint-" + side + "-eye"]), Vector()) / len(groups["joint-" + side + "-eye"])
        center.z += 0.0007
        def fitted(point):
            return TO_BLENDER @ (anchor + rotation @ (point - head) * scale)
        bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=radius, location=fitted(center))
        eye = bpy.context.object
        eye.name = "Reference sclera " + side
        eye.scale = (scale, scale, scale)
        eye.data.materials.append(sclera)
        for polygon in eye.data.polygons:
            polygon.use_smooth = True
        vertices, faces, colors = [], [], []
        # Dense concentric rings stay outside the sclera between vertices; the old
        # five-ring disc intersected the sphere and produced white iris artifacts.
        rings = []
        for ring in range(25):
            iris_radius = 0.0058 * ring / 24
            value = 0.001 if iris_radius < 0.0019 else (0.012 if iris_radius > 0.0053 else 0.065)
            rings.append((iris_radius, value))
        for iris_radius, value in rings:
            for segment in range(96):
                angle = segment * math.tau / 96
                z = math.sqrt(radius ** 2 - iris_radius ** 2) + 0.00012
                vertices.append(fitted(center + Vector((math.cos(angle) * iris_radius, math.sin(angle) * iris_radius, z))))
                pigment = value * (0.8 + 0.2 * math.sin(segment * 13))
                colors.append((pigment, pigment * 0.63, pigment * 0.31, 1))
        for ring in range(len(rings) - 1):
            for segment in range(96):
                a, b = ring * 96 + segment, ring * 96 + (segment + 1) % 96
                faces.append((a, a + 96, b + 96, b))
        mesh = bpy.data.meshes.new("Reference iris " + side)
        mesh.from_pydata(vertices, [], faces); mesh.update()
        obj = bpy.data.objects.new(mesh.name, mesh)
        bpy.context.collection.objects.link(obj)
        mesh.materials.append(iris)
        attribute = mesh.color_attributes.new(name="Iris pigment", type="FLOAT_COLOR", domain="POINT")
        for index, color in enumerate(colors):
            attribute.data[index].color = color
        objects.extend([eye, obj])
    return objects


def native_rig(source, bind, names, objects):
    data = bpy.data.armatures.new("Canonical hero rig")
    arm = bpy.data.objects.new("Canonical hero rig", data)
    bpy.context.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    conversion = TO_BLENDER.to_4x4()
    for name in names:
        bone = data.edit_bones.new(name)
        bone.matrix = conversion @ bind[name]
        bone.length = 0.05
    parents = {child: i for i, node in enumerate(source.doc["nodes"]) for child in node.get("children", [])}
    for node in source.doc["skins"][0]["joints"]:
        name = source.doc["nodes"][node]["name"]
        parent = parents.get(node)
        if parent is not None and source.doc["nodes"][parent].get("name") in names:
            data.edit_bones[name].parent = data.edit_bones[source.doc["nodes"][parent]["name"]]
    bpy.ops.object.mode_set(mode="OBJECT")
    for obj in objects:
        for group in obj.vertex_groups:
            if group.name.startswith("joint."):
                group.name = names[int(group.name.split(".")[1])]
        if not obj.vertex_groups:
            obj.vertex_groups.new(name="Head").add(list(range(len(obj.data.vertices))), 1, "REPLACE")
        modifier = obj.modifiers.new("Canonical native skin", "ARMATURE")
        modifier.object = arm
    arm.show_in_front = True
    return arm


def glb_metadata(path, report, skin_texture=None, surface=None, fabric=False):
    data = path.read_bytes()
    size = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20:20 + size])
    document["extras"] = report
    if skin_texture:
        document["images"] = [{"uri": "cc0/" + skin_texture.name}]
        document["textures"] = [{"source": 0}]
        document["materials"] = [{"name": "Hero anatomical skin reference", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0, "roughnessFactor": 0.48}}]
        document["meshes"][0]["primitives"][0]["material"] = 0
    elif fabric:
        document["images"] = [{"uri": "fabric/shirt-twill." + kind + ".png"} for kind in ["color", "normal", "arm"]]
        document["textures"] = [{"source": i} for i in range(3)]
        document["materials"] = [{"name": "Hero woven blue shirt", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0, "roughnessFactor": 1, "metallicRoughnessTexture": {"index": 2}}, "normalTexture": {"index": 1, "scale": 0.6}, "occlusionTexture": {"index": 2}}]
        document["meshes"][0]["primitives"][0]["material"] = 0
    elif surface:
        document["materials"] = [surface]
        document["meshes"][0]["primitives"][0]["material"] = 0
    encoded = json.dumps(document, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary = data[20 + size:]
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 20 + len(encoded) + len(binary)) + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded + binary)


def look_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def reference_scene(objects):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 768, 768
    scene.render.resolution_percentage = 100
    scene.world.color = (0.12, 0.12, 0.12)
    scene.view_settings.view_transform = "AgX"
    for name, point, power, size in [("Key", (1.4, -2.4, 2.5), 150, 2), ("Fill", (-1.4, -1.4, 1.7), 50, 2), ("Rim", (0.5, 1.5, 2.2), 120, 1)]:
        light = bpy.data.lights.new(name, "AREA")
        light.energy, light.shape, light.size = power, "DISK", size
        obj = bpy.data.objects.new(name, light)
        scene.collection.objects.link(obj)
        obj.location = point
        look_at(obj, (0, 0, 1.5))
    camera = bpy.data.objects.new("Hero reference camera", bpy.data.cameras.new("Hero reference camera"))
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.data.lens = 65
    camera.location = (0.35, -0.85, 1.62)
    look_at(camera, (-0.02, 0, 1.56))
    for obj in objects:
        obj.select_set(True)


def main():
    receipts = inputs()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    source = common.Source(DIRECTORY.parent / "player.gltf")
    original, uvs, faces, groups = source_mesh()
    positions, joints, weights, names, landmarks, raw_weights, bind, transforms = fit(original, groups, source)
    head = {i for i, p in enumerate(original) if p.y > 0.665}
    hands = {i for i, row in enumerate(raw_weights) if sum(w for bone, _, w in row if bone.startswith(("hand", "thumb", "index", "middle", "ring", "pinky"))) > 0.02}
    # Extend through the shirt cuff without importing the hidden body/helper cages.
    for side in ["l", "r"]:
        wrist = Vector(landmarks["hand_" + side]["sourceHead"])
        hands.update(i for i, p in enumerate(original) if (p - wrist).length < 0.07)
    skin = material()
    head_object = create_patch(positions, uvs, faces, joints, weights, head, "Hero head and neck", skin)
    hand_object = create_patch(positions, uvs, faces, joints, weights, hands, "Hero hands and cuff transition", skin)
    bpy.context.view_layer.objects.active = head_object
    modifier = head_object.modifiers.new("Offline facial surface refinement", "SUBSURF")
    modifier.levels = 1
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    output = common.output_arrays()
    for obj in [head_object, hand_object]:
        duplicate = obj.copy(); duplicate.data = obj.data.copy()
        bpy.context.collection.objects.link(duplicate)
        common.extract(duplicate, output, {"name": obj.name, "swatch": "skin"})
    # Blender/OBJ UV origin is bottom-left; glTF image coordinates are top-left.
    output["TEXCOORD_0"] = [[u, 1 - v] for u, v in output["TEXCOORD_0"]]
    report = {"status": "reference candidate; not production accepted", "sourceInputs": receipts, "jointNames": names, "sourceId": "player", "sourceSHA256": source.digest(), "morphs": MORPHS, "landmarks": landmarks, "anatomyTriangles": len(output["indices"]) // 3, "textureDimensions": list(skin.node_tree.nodes.get("Image Texture").image.size), "limitations": ["Eyes, eyelids and hair require complete native close-up acceptance", "Hands require authored weapon contact poses and finger silhouette review", "Diffuse reference lacks dedicated scanned roughness/normal maps", "Vest, trousers and boots still use historical construction; new shirt requires native acceptance"]}
    common.write_glb(DIRECTORY / "hero-skin-reference.glb", output, report)
    glb_metadata(DIRECTORY / "hero-skin-reference.glb", report, next(CC0.glob("*.png")))
    (DIRECTORY / "reference-receipt.json").write_text(json.dumps(report, indent=2) + "\n")
    eyes = add_eyes(original, groups, transforms["head"])
    eyes.extend(groom.eyebrows(original, faces, groups, transforms["head"]))
    bpy.ops.object.select_all(action="DESELECT")
    for obj in eyes:
        obj.select_set(True)
    eye_path = DIRECTORY / "hero-eyes-reference.glb"
    bpy.ops.export_scene.gltf(filepath=str(eye_path), export_format="GLB", use_selection=True, export_animations=False, export_cameras=False, export_lights=False, export_yup=True)
    glb_metadata(eye_path, report)
    cloth = wardrobe.fabric(DIRECTORY / "fabric")
    collar = wardrobe.collar(bind["Neck"], names, common, cloth)
    collar_output = common.output_arrays()
    duplicate = collar.copy(); duplicate.data = collar.data.copy()
    bpy.context.collection.objects.link(duplicate)
    common.extract(duplicate, collar_output, {"name": "Folded Western shirt collar", "swatch": "linen"})
    collar_path = DIRECTORY / "hero-collar-reference.glb"
    original_body = next(source.bodies())
    obsolete = [piece for piece in original_body["ranges"] if piece.get("swatch") == "linen" and not piece.get("name") and max(p[1] for p in original_body["attrs"]["POSITION"][piece["start"]:piece["start"] + piece["count"]]) > 1.43]
    collar_report = {**report, "replaceRanges": obsolete, "trimTailoringAboveY": 1.4}
    common.write_glb(collar_path, collar_output, collar_report)
    glb_metadata(collar_path, collar_report, fabric=True)
    sleeves = wardrobe.sleeves(bind, names, common, cloth)
    sleeves.append(wardrobe.shirt(bind, names, common, cloth))
    sleeve_output = common.output_arrays()
    for obj in sleeves:
        duplicate = obj.copy(); duplicate.data = obj.data.copy()
        bpy.context.collection.objects.link(duplicate)
        common.extract(duplicate, sleeve_output, {"name": obj.name, "swatch": "linen"})
    sleeve_path = DIRECTORY / "hero-sleeves-reference.glb"
    common.write_glb(sleeve_path, sleeve_output, report)
    glb_metadata(sleeve_path, report, fabric=True)
    hats = wardrobe.hat(bind["Head"])
    bpy.ops.object.select_all(action="DESELECT")
    hat_copies = []
    transform = TO_BLENDER.to_4x4() @ bind["Head"].inverted() @ TO_BLENDER.transposed().to_4x4()
    for obj in hats:
        duplicate = obj.copy(); duplicate.data = obj.data.copy()
        duplicate.data.transform(transform)
        bpy.context.collection.objects.link(duplicate)
        duplicate.select_set(True)
        hat_copies.append(duplicate)
    hat_path = DIRECTORY / "hero-hat-reference.glb"
    bpy.ops.export_scene.gltf(filepath=str(hat_path), export_format="GLB", use_selection=True, export_animations=False, export_cameras=False, export_lights=False, export_yup=True)
    glb_metadata(hat_path, {**report, "coordinateSpace": "Head local"})
    for duplicate in hat_copies:
        bpy.data.objects.remove(duplicate, do_unlink=True)
    native_rig(source, bind, names, [head_object, hand_object, collar, *sleeves, *eyes, *hats])
    reference_scene([head_object, hand_object, collar, *sleeves, *eyes, *hats])
    for image in bpy.data.images:
        if image.source == "FILE":
            image.filepath = "//" + str(Path(image.filepath).relative_to(DIRECTORY))
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(DIRECTORY / "hero-reference.blend"), relative_remap=True)
    scene = bpy.context.scene
    scene.render.filepath = "/tmp/out-west-hero-foundation-head.png"
    bpy.ops.render.render(write_still=True)
    print("HERO_REFERENCE", json.dumps({k: report[k] for k in ["anatomyTriangles", "textureDimensions", "status"]}))


if __name__ == "__main__":
    main()
