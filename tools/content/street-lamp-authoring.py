"""Author the bank's period street lamp: timber post, wrought bracket and kerosene lantern.

Run inside Blender 4.5 (Blender MCP or `blender -b -P`). Procedural weathered timber and
rusted iron are baked by Cycles into one PBR atlas; the lantern glass keeps its own small
emissive map so night lighting is a native material channel. Writes
`tools/art/environments/street-lamp.glb` with three meshes: `lamp-post` (post and bracket),
`lamp-lantern` (iron lantern body) and `lamp-glass` (panes), all in metres, +Y up, the post
foot at the origin and the bracket reaching along +X.
"""

import math
from pathlib import Path

import bpy
import bmesh
from mathutils import Matrix, Vector

try:
    ROOT = Path(__file__).resolve().parents[2]
except NameError:
    ROOT = Path("/tmp/out-west-swarm/wt-lighting")
OUTPUT = ROOT / "tools/art/environments/street-lamp.glb"
ATLAS = 512
# Lantern hangs from the bracket hook; glass centre is the light's authored position.
HOOK = Vector((0.60, 0.0, 2.86))
GLASS_BOTTOM, GLASS_TOP = 2.33, 2.59

# The authoring instance is dedicated to this asset: start from an empty scene.
scene = bpy.context.scene
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
for block in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.images):
    for item in list(block):
        if item.users == 0:
            block.remove(item)


def link(obj):
    scene.collection.objects.link(obj)
    return obj


def from_bmesh(name, build):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    build(bm)
    bm.to_mesh(mesh)
    bm.free()
    return link(bpy.data.objects.new(name, mesh))


def box(name, size, center, bevel=0.0, taper=1.0):
    def build(bm):
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
            if v.co.z > 0 and taper != 1.0:
                v.co.x *= taper
                v.co.y *= taper
            v.co += Vector(center)
        if bevel > 0:
            bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, segments=2, affect="EDGES", profile=0.5)

    return from_bmesh(name, build)


def frustum(name, bottom, top, z0, z1, center=(0, 0), sides=4, caps=True):
    """Square (sides=4) or round frustum; bottom/top are half-widths for squares."""

    def build(bm):
        rings = []
        for z, half in ((z0, bottom), (z1, top)):
            ring = []
            for i in range(sides):
                if sides == 4:
                    a = math.pi / 4 + i * math.pi / 2
                    r = half * math.sqrt(2)
                else:
                    a = i * 2 * math.pi / sides
                    r = half
                ring.append(bm.verts.new((center[0] + math.cos(a) * r, center[1] + math.sin(a) * r, z)))
            rings.append(ring)
        for i in range(sides):
            j = (i + 1) % sides
            bm.faces.new((rings[0][i], rings[0][j], rings[1][j], rings[1][i]))
        if caps:
            bm.faces.new(list(reversed(rings[0])))
            bm.faces.new(rings[1])
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])

    return from_bmesh(name, build)


def tube(name, points, radius, sides=8):
    """Round iron bar along a polyline (curve converted to mesh)."""
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = max(1, sides // 4 - 1)
    curve.use_fill_caps = True
    spline = curve.splines.new("POLY")
    spline.points.add(len(points) - 1)
    for point, co in zip(spline.points, points):
        point.co = (*co, 1)
    obj = link(bpy.data.objects.new(name, curve))
    bpy.context.view_layer.objects.active = obj
    for other in scene.objects:
        other.select_set(other == obj)
    bpy.ops.object.convert(target="MESH")
    return bpy.context.view_layer.objects.active


def arc(center, radius, start, end, steps, plane="XZ"):
    out = []
    for i in range(steps + 1):
        a = start + (end - start) * i / steps
        if plane == "XZ":
            out.append((center[0] + math.cos(a) * radius, center[1], center[2] + math.sin(a) * radius))
        else:
            out.append((center[0] + math.cos(a) * radius, center[1] + math.sin(a) * radius, center[2]))
    return out


def ring(name, center, major, minor, axis="Y"):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major, minor_radius=minor, major_segments=16, minor_segments=6, location=center
    )
    obj = bpy.context.active_object
    obj.name = name
    if axis == "Y":
        obj.rotation_euler = (math.pi / 2, 0, 0)
    elif axis == "X":
        obj.rotation_euler = (math.pi / 2, 0, math.pi / 2)
    return obj


def cylinder(name, radius, z0, z1, center=(0, 0), sides=12, radius_top=None):
    if radius_top is None:
        radius_top = radius
    return frustum(name, radius, radius_top, z0, z1, center, sides)


def spiral(center, r0, r1, turns, steps, start=0.0):
    out = []
    for i in range(steps + 1):
        t = i / steps
        a = start + t * turns * 2 * math.pi
        r = r0 + (r1 - r0) * t
        out.append((center[0] + math.cos(a) * r, center[1], center[2] + math.sin(a) * r))
    return out


# --- Timber post -----------------------------------------------------------------------
wood = []
wood.append(box("plinth", (0.22, 0.22, 0.10), (0, 0, 0.05), bevel=0.012))
post_timber = box("post", (0.13, 0.13, 2.92), (0, 0, 0.10 + 1.46), bevel=0.014, taper=0.88)
# Separate stacked UV islands keep the long post from limiting the atlas's texel density.
bm = bmesh.new()
bm.from_mesh(post_timber.data)
for height in (1.07, 2.04):
    cut = bmesh.ops.bisect_plane(
        bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, height), plane_no=(0, 0, 1)
    )["geom_cut"]
    bmesh.ops.split_edges(bm, edges=[edge for edge in cut if isinstance(edge, bmesh.types.BMEdge)])
bm.to_mesh(post_timber.data)
bm.free()
wood.append(post_timber)
wood.append(box("cap-board", (0.17, 0.17, 0.03), (0, 0, 3.035), bevel=0.006))
wood.append(frustum("cap", 0.075, 0.012, 3.05, 3.12))
# Short knee braces along the boardwalk edge tie the post into the planks.
for sign in (1, -1):
    brace = box(f"knee-{sign}", (0.05, 0.05, 0.42), (0, 0, 0))
    brace.rotation_euler = (sign * math.radians(38), 0, 0)
    brace.location = (0, sign * 0.16, 0.17)
    wood.append(brace)

# --- Wrought-iron bracket ---------------------------------------------------------------
iron = []
iron.append(box("mount-plate", (0.008, 0.075, 0.52), (0.069, 0, 2.66), bevel=0.002))
for z in (2.46, 2.86):
    for y in (-0.022, 0.022):
        bolt = cylinder("bolt", 0.009, 0.0, 0.012, sides=8)
        bolt.rotation_euler = (0, math.pi / 2, 0)
        bolt.location = (0.073, y, z)
        iron.append(bolt)
iron.append(box("arm", (0.60, 0.018, 0.034), (0.068 + 0.30, 0, 2.90), bevel=0.003))
# Arm ends in a small downward scroll; the hook hangs just inside it.
iron.append(tube("arm-scroll", spiral((0.668, 0, 2.87), 0.032, 0.008, 0.85, 20, start=math.pi / 2), 0.008))
iron.append(tube("brace", [(0.073, 0, 2.47)] + arc((0.073 + 0.40, 0, 2.47), 0.40, math.pi, math.pi * 0.52, 14), 0.010))
iron.append(tube("scroll-a", spiral((0.24, 0, 2.735), 0.075, 0.012, 1.15, 34, start=math.pi * 0.25), 0.007))
iron.append(tube("scroll-b", spiral((0.43, 0, 2.83), 0.045, 0.008, 1.0, 26, start=math.pi * 1.2), 0.006))
iron.append(ring("hook", HOOK + Vector((0, 0, -0.005)), 0.022, 0.0055, axis="Y"))
iron.append(ring("bail", HOOK + Vector((0, 0, -0.045)), 0.026, 0.006, axis="X"))

# --- Kerosene street lantern ------------------------------------------------------------
lantern = []
cx = (HOOK.x, 0)
lantern.append(cylinder("chimney", 0.028, 2.70, 2.765, cx))
lantern.append(frustum("chimney-cap", 0.05, 0.008, 2.765, 2.80, cx, sides=12))
lantern.append(frustum("hood", 0.145, 0.034, 2.615, 2.705, cx))
lantern.append(box("hood-lip", (0.30, 0.30, 0.012), (cx[0], 0, 2.612), bevel=0.003))
lantern.append(box("top-band", (0.225, 0.225, 0.028), (cx[0], 0, 2.592), bevel=0.003))
lantern.append(box("bottom-band", (0.185, 0.185, 0.03), (cx[0], 0, 2.322), bevel=0.003))
lantern.append(frustum("font", 0.092, 0.03, 2.307, 2.255, cx))
lantern.append(cylinder("finial", 0.012, 2.225, 2.258, cx, sides=10, radius_top=0.02))
# Pane frame: wireframe of the glass frustum.
frame = frustum("pane-frame", 0.087, 0.107, GLASS_BOTTOM, GLASS_TOP, cx, caps=False)
modifier = frame.modifiers.new("frame", "WIREFRAME")
modifier.thickness = 0.011
modifier.use_even_offset = True
modifier.use_replace = True
lantern.append(frame)
glass = frustum("lamp-glass", 0.085, 0.105, GLASS_BOTTOM, GLASS_TOP, cx, caps=False)

# --- Procedural surfaces -----------------------------------------------------------------


def node_material(name):
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    return material, tree


def wood_material():
    material, tree = node_material("lamp-src-wood")
    n, l = tree.nodes, tree.links
    out = n.new("ShaderNodeOutputMaterial")
    bsdf = n.new("ShaderNodeBsdfPrincipled")
    l.new(bsdf.outputs[0], out.inputs[0])
    coord = n.new("ShaderNodeTexCoord")
    grain_map = n.new("ShaderNodeMapping")
    grain_map.inputs["Scale"].default_value = (34, 34, 1.4)
    l.new(coord.outputs["Object"], grain_map.inputs[0])
    grain = n.new("ShaderNodeTexNoise")
    grain.inputs["Scale"].default_value = 3.0
    grain.inputs["Detail"].default_value = 9
    grain.inputs["Roughness"].default_value = 0.62
    grain.inputs["Distortion"].default_value = 0.35
    l.new(grain_map.outputs[0], grain.inputs[0])
    cracks_map = n.new("ShaderNodeMapping")
    cracks_map.inputs["Scale"].default_value = (22, 22, 0.9)
    l.new(coord.outputs["Object"], cracks_map.inputs[0])
    cracks = n.new("ShaderNodeTexVoronoi")
    cracks.feature = "DISTANCE_TO_EDGE"
    cracks.inputs["Scale"].default_value = 2.2
    l.new(cracks_map.outputs[0], cracks.inputs[0])
    crack_ramp = n.new("ShaderNodeValToRGB")
    crack_ramp.color_ramp.elements[0].position = 0.0
    crack_ramp.color_ramp.elements[0].color = (0, 0, 0, 1)
    crack_ramp.color_ramp.elements[1].position = 0.035
    crack_ramp.color_ramp.elements[1].color = (1, 1, 1, 1)
    l.new(cracks.outputs["Distance"], crack_ramp.inputs[0])
    color_ramp = n.new("ShaderNodeValToRGB")
    ramp = color_ramp.color_ramp
    ramp.elements[0].position = 0.30
    ramp.elements[0].color = (0.115, 0.083, 0.058, 1)
    ramp.elements[1].position = 0.72
    ramp.elements[1].color = (0.25, 0.205, 0.16, 1)
    middle = ramp.elements.new(0.52)
    middle.color = (0.19, 0.14, 0.095, 1)
    l.new(grain.outputs["Fac"], color_ramp.inputs[0])
    # Sun-bleached faces, dark open cracks and a dusty foot where boots kick the boardwalk.
    crack_mix = n.new("ShaderNodeMix")
    crack_mix.data_type = "RGBA"
    crack_mix.inputs["B"].default_value = (0.045, 0.033, 0.024, 1)
    l.new(color_ramp.outputs[0], crack_mix.inputs["A"])
    invert = n.new("ShaderNodeMath")
    invert.operation = "SUBTRACT"
    invert.inputs[0].default_value = 1.0
    l.new(crack_ramp.outputs[0], invert.inputs[1])
    l.new(invert.outputs[0], crack_mix.inputs["Factor"])
    sep = n.new("ShaderNodeSeparateXYZ")
    l.new(coord.outputs["Object"], sep.inputs[0])
    dust = n.new("ShaderNodeMapRange")
    dust.inputs["From Min"].default_value = 0.55
    dust.inputs["From Max"].default_value = 0.05
    l.new(sep.outputs["Z"], dust.inputs[0])
    dust_noise = n.new("ShaderNodeTexNoise")
    dust_noise.inputs["Scale"].default_value = 18
    l.new(coord.outputs["Object"], dust_noise.inputs[0])
    dust_amount = n.new("ShaderNodeMath")
    dust_amount.operation = "MULTIPLY"
    l.new(dust.outputs[0], dust_amount.inputs[0])
    l.new(dust_noise.outputs["Fac"], dust_amount.inputs[1])
    dust_mix = n.new("ShaderNodeMix")
    dust_mix.data_type = "RGBA"
    dust_mix.inputs["B"].default_value = (0.43, 0.33, 0.24, 1)
    l.new(crack_mix.outputs["Result"], dust_mix.inputs["A"])
    l.new(dust_amount.outputs[0], dust_mix.inputs["Factor"])
    l.new(dust_mix.outputs["Result"], bsdf.inputs["Base Color"])
    rough = n.new("ShaderNodeMapRange")
    rough.inputs["To Min"].default_value = 0.93
    rough.inputs["To Max"].default_value = 0.72
    l.new(grain.outputs["Fac"], rough.inputs[0])
    l.new(rough.outputs[0], bsdf.inputs["Roughness"])
    bsdf.inputs["Metallic"].default_value = 0.0
    height = n.new("ShaderNodeMath")
    height.operation = "MULTIPLY"
    l.new(grain.outputs["Fac"], height.inputs[0])
    l.new(crack_ramp.outputs[0], height.inputs[1])
    bump = n.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.55
    bump.inputs["Distance"].default_value = 0.004
    l.new(height.outputs[0], bump.inputs["Height"])
    l.new(bump.outputs[0], bsdf.inputs["Normal"])
    return material


def iron_material():
    material, tree = node_material("lamp-src-iron")
    n, l = tree.nodes, tree.links
    out = n.new("ShaderNodeOutputMaterial")
    bsdf = n.new("ShaderNodeBsdfPrincipled")
    l.new(bsdf.outputs[0], out.inputs[0])
    coord = n.new("ShaderNodeTexCoord")
    rust = n.new("ShaderNodeTexNoise")
    rust.inputs["Scale"].default_value = 26
    rust.inputs["Detail"].default_value = 8
    rust.inputs["Roughness"].default_value = 0.7
    l.new(coord.outputs["Object"], rust.inputs[0])
    mask = n.new("ShaderNodeValToRGB")
    mask.color_ramp.elements[0].position = 0.6
    mask.color_ramp.elements[1].position = 0.74
    l.new(rust.outputs["Fac"], mask.inputs[0])
    pitting = n.new("ShaderNodeTexNoise")
    pitting.inputs["Scale"].default_value = 160
    pitting.inputs["Detail"].default_value = 4
    l.new(coord.outputs["Object"], pitting.inputs[0])
    color = n.new("ShaderNodeMix")
    color.data_type = "RGBA"
    color.inputs["A"].default_value = (0.032, 0.03, 0.028, 1)
    color.inputs["B"].default_value = (0.17, 0.075, 0.03, 1)
    l.new(mask.outputs[0], color.inputs["Factor"])
    l.new(color.outputs["Result"], bsdf.inputs["Base Color"])
    metal = n.new("ShaderNodeMapRange")
    metal.inputs["To Min"].default_value = 0.85
    metal.inputs["To Max"].default_value = 0.15
    l.new(mask.outputs[0], metal.inputs[0])
    l.new(metal.outputs[0], bsdf.inputs["Metallic"])
    rough = n.new("ShaderNodeMapRange")
    rough.inputs["To Min"].default_value = 0.5
    rough.inputs["To Max"].default_value = 0.9
    l.new(mask.outputs[0], rough.inputs[0])
    l.new(rough.outputs[0], bsdf.inputs["Roughness"])
    height = n.new("ShaderNodeMath")
    height.operation = "ADD"
    l.new(pitting.outputs["Fac"], height.inputs[0])
    l.new(mask.outputs[0], height.inputs[1])
    bump = n.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.3
    bump.inputs["Distance"].default_value = 0.0015
    l.new(height.outputs[0], bump.inputs["Height"])
    l.new(bump.outputs[0], bsdf.inputs["Normal"])
    return material


wood_src = wood_material()
iron_src = iron_material()


def assign(objects, material):
    for obj in objects:
        obj.data.materials.clear()
        obj.data.materials.append(material)


assign(wood, wood_src)
assign(iron, iron_src)
assign(lantern, iron_src)


def join(name, objects):
    for obj in scene.objects:
        obj.select_set(False)
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.convert(target="MESH")
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = name
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return obj


post = join("lamp-post", wood + iron)
body = join("lamp-lantern", lantern)
for obj in (post, body):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.shade_auto_smooth(angle=math.radians(35))
    bpy.ops.object.convert(target="MESH")

# One shared atlas for both meshes: multi-object smart projection packs them together.
for obj in scene.objects:
    obj.select_set(obj in (post, body))
bpy.context.view_layer.objects.active = post
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(55), island_margin=0.006, area_weight=0.0, scale_to_bounds=False)
bpy.ops.uv.select_all(action="SELECT")
# Uniform texel density across post, bracket and lantern before packing.
bpy.ops.uv.average_islands_scale()
bpy.ops.uv.pack_islands(margin=0.004, rotate=True, rotate_method="AXIS_ALIGNED", shape_method="AABB")
bpy.ops.object.mode_set(mode="OBJECT")

# --- Bake ---------------------------------------------------------------------------------
scene.render.engine = "CYCLES"
scene.cycles.samples = 24
scene.cycles.device = "CPU"
scene.render.bake.margin = 4
scene.render.bake.use_selected_to_active = False


def bake_image(name, color):
    image = bpy.data.images.get(name)
    if image:
        bpy.data.images.remove(image)
    image = bpy.data.images.new(name, ATLAS, ATLAS, alpha=False)
    image.colorspace_settings.name = "sRGB" if color else "Non-Color"
    return image


def bake(kind, image, **kwargs):
    for material in (wood_src, iron_src):
        nodes = material.node_tree.nodes
        target = nodes.get("bake-target") or nodes.new("ShaderNodeTexImage")
        target.name = "bake-target"
        target.image = image
        nodes.active = target
    for obj in scene.objects:
        obj.select_set(obj in (post, body))
    bpy.context.view_layer.objects.active = post
    bpy.ops.object.bake(type=kind, **kwargs)


albedo = bake_image("street-lamp-albedo", True)
bake("DIFFUSE", albedo, pass_filter={"COLOR"})
normal = bake_image("street-lamp-normal", False)
bake("NORMAL", normal, normal_space="TANGENT")
roughness = bake_image("street-lamp-roughness", False)
bake("ROUGHNESS", roughness)
occlusion = bake_image("street-lamp-occlusion", False)
scene.cycles.samples = 64
bake("AO", occlusion)
scene.cycles.samples = 24

# Metallic comes from the procedural mask through an emission bake.
for material in (wood_src, iron_src):
    tree = material.node_tree
    bsdf = next(node for node in tree.nodes if node.type == "BSDF_PRINCIPLED")
    out = next(node for node in tree.nodes if node.type == "OUTPUT_MATERIAL")
    emit = tree.nodes.new("ShaderNodeEmission")
    source = bsdf.inputs["Metallic"]
    if source.is_linked:
        tree.links.new(source.links[0].from_socket, emit.inputs["Color"])
    else:
        emit.inputs["Color"].default_value = (source.default_value,) * 3 + (1,)
    tree.links.new(emit.outputs[0], out.inputs[0])
metallic = bake_image("street-lamp-metallic", False)
bake("EMIT", metallic)

# glTF ORM: R occlusion, G roughness, B metallic. AO also darkens albedo crevices slightly.
size = ATLAS * ATLAS * 4
ao = list(occlusion.pixels)
ro = list(roughness.pixels)
me = list(metallic.pixels)
orm = bpy.data.images.get("street-lamp-orm")
if orm:
    bpy.data.images.remove(orm)
orm = bpy.data.images.new("street-lamp-orm", ATLAS, ATLAS, alpha=False)
orm.colorspace_settings.name = "Non-Color"
packed = [0.0] * size
for i in range(0, size, 4):
    packed[i] = 0.35 + 0.65 * ao[i]
    packed[i + 1] = ro[i]
    packed[i + 2] = me[i]
    packed[i + 3] = 1.0
orm.pixels = packed
base = list(albedo.pixels)
for i in range(0, size, 4):
    shade = 0.7 + 0.3 * ao[i]
    base[i] *= shade
    base[i + 1] *= shade
    base[i + 2] *= shade
albedo.pixels = base

# Glass glow: a flame hot spot low in each pane fading to amber at the frame.
GLOW = 128
glow = bpy.data.images.get("street-lamp-glow")
if glow:
    bpy.data.images.remove(glow)
glow = bpy.data.images.new("street-lamp-glow", GLOW, GLOW, alpha=False)
pixels = []
for y in range(GLOW):
    for x in range(GLOW):
        u, v = (x + 0.5) / GLOW, (y + 0.5) / GLOW
        d = math.hypot((u - 0.5) * 1.6, (v - 0.38) * 1.05)
        core = math.exp(-((d / 0.2) ** 2))
        halo = math.exp(-((d / 0.62) ** 2))
        edge = min(1.0, min(u, 1 - u, v, 1 - v) * 9)
        r = (0.16 + 0.5 * halo + 0.34 * core) * (0.55 + 0.45 * edge)
        g = (0.055 + 0.25 * halo + 0.45 * core) * (0.55 + 0.45 * edge)
        b = (0.01 + 0.05 * halo + 0.26 * core) * (0.55 + 0.45 * edge)
        pixels.extend((min(1, r), min(1, g), min(1, b), 1.0))
glow.pixels = pixels

# Panes: each face maps to the whole glow image.
bm = bmesh.new()
bm.from_mesh(glass.data)
uv = bm.loops.layers.uv.new("UVMap")
for face in bm.faces:
    loops = list(face.loops)
    zs = sorted(loop.vert.co.z for loop in loops)
    lowest = [loop for loop in loops if loop.vert.co.z <= zs[1] + 1e-6]
    center = face.calc_center_median()
    tangent = (lowest[1].vert.co - lowest[0].vert.co).normalized()
    for loop in loops:
        rel = loop.vert.co - center
        loop[uv].uv = (0.5 + rel.dot(tangent) / 0.24, (loop.vert.co.z - GLASS_BOTTOM) / (GLASS_TOP - GLASS_BOTTOM))
bm.to_mesh(glass.data)
bm.free()

# --- Final glTF materials -----------------------------------------------------------------
for image, file in (
    (albedo, "street-lamp-albedo.png"),
    (normal, "street-lamp-normal.png"),
    (orm, "street-lamp-orm.png"),
    (glow, "street-lamp-glow.png"),
):
    image.file_format = "PNG"
    image.filepath_raw = f"/tmp/out-west-swarm/lighting/{file}"
    image.save()

body_material, tree = node_material("StreetLamp")
n, l = tree.nodes, tree.links
out = n.new("ShaderNodeOutputMaterial")
bsdf = n.new("ShaderNodeBsdfPrincipled")
l.new(bsdf.outputs[0], out.inputs[0])
tex_albedo = n.new("ShaderNodeTexImage")
tex_albedo.image = albedo
l.new(tex_albedo.outputs[0], bsdf.inputs["Base Color"])
tex_orm = n.new("ShaderNodeTexImage")
tex_orm.image = orm
split = n.new("ShaderNodeSeparateColor")
l.new(tex_orm.outputs[0], split.inputs[0])
l.new(split.outputs["Green"], bsdf.inputs["Roughness"])
l.new(split.outputs["Blue"], bsdf.inputs["Metallic"])
tex_normal = n.new("ShaderNodeTexImage")
tex_normal.image = normal
normal_map = n.new("ShaderNodeNormalMap")
l.new(tex_normal.outputs[0], normal_map.inputs["Color"])
l.new(normal_map.outputs[0], bsdf.inputs["Normal"])

glass_material, tree = node_material("LampGlass")
n, l = tree.nodes, tree.links
out = n.new("ShaderNodeOutputMaterial")
bsdf = n.new("ShaderNodeBsdfPrincipled")
l.new(bsdf.outputs[0], out.inputs[0])
bsdf.inputs["Base Color"].default_value = (0.06, 0.05, 0.035, 1)
bsdf.inputs["Roughness"].default_value = 0.12
bsdf.inputs["Metallic"].default_value = 0.0
tex_glow = n.new("ShaderNodeTexImage")
tex_glow.image = glow
l.new(tex_glow.outputs[0], bsdf.inputs["Emission Color"])
bsdf.inputs["Emission Strength"].default_value = 1.0

assign([post, body], body_material)
assign([glass], glass_material)
glass.name = glass.data.name = "lamp-glass"

for obj in scene.objects:
    obj.select_set(obj in (post, body, glass))
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=str(OUTPUT),
    export_format="GLB",
    use_selection=True,
    export_yup=True,
    export_apply=True,
    export_texcoords=True,
    export_normals=True,
    export_tangents=False,
    export_materials="EXPORT",
    export_image_format="AUTO",
    export_animations=False,
    export_extras=False,
)
stats = {obj.name: (len(obj.data.vertices), len(obj.data.polygons)) for obj in (post, body, glass)}
print("street lamp", OUTPUT, stats)
