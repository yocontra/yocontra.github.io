"""Bake shared strand-direction hair maps with stock Blender Cycles nodes."""
from pathlib import Path
import importlib.util

import bpy

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "tools/art/characters/textures"
spec = importlib.util.spec_from_file_location("portable", Path(__file__).with_name("coat-sleeves-authoring.py"))
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
DONORS = {"brown": "player", "delmer": "outlaw-5", "hardin": "outlaw-16"}
SIZE = 1024


def bake_maps():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.mesh.primitive_plane_add(size=1)
    plane = bpy.context.object
    material = bpy.data.materials.new("Matte directional moustache hair")
    material.use_nodes = True
    plane.data.materials.append(material)
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes.get("Principled BSDF")
    shader.inputs["Roughness"].default_value = .88
    shader.inputs["Metallic"].default_value = 0
    coordinate = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeVectorMath")
    mapping.operation = "MULTIPLY"
    mapping.inputs[1].default_value = (6, 170, 1)
    links.new(coordinate.outputs["UV"], mapping.inputs[0])
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 1
    noise.inputs["Detail"].default_value = 2
    noise.inputs["Roughness"].default_value = .65
    links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
    grain = nodes.new("ShaderNodeValToRGB")
    grain.color_ramp.elements[0].position = .2
    grain.color_ramp.elements[1].position = .8
    links.new(noise.outputs["Fac"], grain.inputs["Fac"])
    atlas_scale = nodes.new("ShaderNodeVectorMath")
    atlas_scale.operation = "MULTIPLY"
    atlas_offset = nodes.new("ShaderNodeVectorMath")
    atlas_offset.operation = "ADD"
    atlas = nodes.new("ShaderNodeTexImage")
    links.new(coordinate.outputs["UV"], atlas_scale.inputs[0])
    links.new(atlas_scale.outputs["Vector"], atlas_offset.inputs[0])
    links.new(atlas_offset.outputs["Vector"], atlas.inputs["Vector"])
    color_mix = nodes.new("ShaderNodeMixRGB")
    color_mix.blend_type = "MULTIPLY"
    color_mix.inputs[0].default_value = 1
    links.new(atlas.outputs["Color"], color_mix.inputs[1])
    links.new(grain.outputs["Color"], color_mix.inputs[2])
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = .65
    bump.inputs["Distance"].default_value = .003
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], shader.inputs["Normal"])
    links.new(color_mix.outputs["Color"], shader.inputs["Base Color"])
    target = nodes.new("ShaderNodeTexImage")
    nodes.active = target
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 4
    scene.render.bake.use_pass_direct = False
    scene.render.bake.use_pass_indirect = False
    scene.render.bake.use_pass_color = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "8"
    TARGET.mkdir(parents=True, exist_ok=True)
    for name, donor in DONORS.items():
        source = common.Source(common.SOURCES / f"{donor}.gltf")
        body = next(source.bodies())
        hair = next(piece for piece in body["ranges"] if piece.get("slot") == "hair")
        color = body["attrs"]["COLOR_0"][hair["start"]][:3]
        uvs = body["attrs"]["TEXCOORD_0"][hair["start"]:hair["start"] + hair["count"]]
        low = [min(uv[k] for uv in uvs) for k in range(2)]
        high = [max(uv[k] for uv in uvs) for k in range(2)]
        atlas_scale.inputs[1].default_value = (high[0] - low[0], low[1] - high[1], 1)
        atlas_offset.inputs[1].default_value = (low[0], 1 - low[1], 0)
        mesh = source.doc["meshes"][body["sourcePrimitive"]["meshIndex"]]
        primitive = mesh["primitives"][body["sourcePrimitive"]["primitiveIndex"]]
        original = source.doc["materials"][primitive["material"]]
        texture = original["pbrMetallicRoughness"]["baseColorTexture"]["index"]
        image = source.doc["textures"][texture]["source"]
        atlas.image = bpy.data.images.load(str(common.SOURCES / source.doc["images"][image]["uri"]), check_existing=True)
        for element, intensity in zip(grain.color_ramp.elements, (.68, 1.18)):
            element.color = (*[value * intensity for value in color], 1)
        image = bpy.data.images.new(f"Hair {name}", width=SIZE, height=SIZE)
        target.image = image
        bpy.ops.object.bake(type="DIFFUSE")
        image.filepath_raw = str(TARGET / f"handlebar-hair.{name}.albedo.png")
        image.file_format = "PNG"
        image.save()
        bpy.data.images.remove(image)
    normal = bpy.data.images.new("Hair tangent normal", width=SIZE, height=SIZE)
    normal.colorspace_settings.name = "Non-Color"
    target.image = normal
    bpy.ops.object.bake(type="NORMAL")
    normal.filepath_raw = str(TARGET / "handlebar-hair.normal.png")
    normal.file_format = "PNG"
    normal.save()
    arm = bpy.data.images.new("Hair AO roughness metalness", width=SIZE, height=SIZE)
    arm.colorspace_settings.name = "Non-Color"
    arm.pixels.foreach_set([1, .88, 0, 1] * (SIZE * SIZE))
    arm.filepath_raw = str(TARGET / "handlebar-hair.arm.png")
    arm.file_format = "PNG"
    arm.save()


if __name__ == "__main__":
    bake_maps()
