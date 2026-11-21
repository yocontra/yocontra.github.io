"""Build the eight Outfitter hats around one fitted oval."""

import math
import runpy
import sys
from dataclasses import dataclass
from pathlib import Path

import bpy

mesh = runpy.run_path(str(Path(__file__).with_name("hat-mesh.py")))
material = mesh["material"]
surface = mesh["surface"]
steps = 56


@dataclass(frozen=True)
class Hat:
    width: float
    length: float
    height: float
    side_roll: float
    front_drop: float
    dent: float
    silhouette: tuple
    band_width: float
    trim: tuple
    finish: str


open_crown = (
    (1, 0),
    (1, 0.28),
    (0.97, 0.65),
    (0.85, 0.92),
    (0.63, 1),
    (0.29, 0.98),
    (0.005, 0.96),
)
creased = (
    (1, 0),
    (0.99, 0.28),
    (0.93, 0.65),
    (0.86, 0.94),
    (0.65, 1.0),
    (0.32, 0.96),
    (0.005, 0.89),
)
flat_top = (
    (1, 0),
    (0.97, 0.14),
    (0.92, 0.43),
    (0.93, 0.78),
    (1, 0.98),
    (0.97, 1),
    (0.35, 1),
    (0.005, 1),
)
cone = (
    (1, 0),
    (1.03, 0.16),
    (0.86, 0.48),
    (0.65, 0.77),
    (0.42, 0.95),
    (0.23, 1),
    (0.005, 1),
)

hats = {
    "plainsman": Hat(
        0.150,
        0.171,
        0.106,
        0.010,
        0.007,
        0,
        open_crown,
        0.020,
        (0.067, 0.035, 0.016),
        "buckle",
    ),
    "sombrero": Hat(
        0.239, 0.253, 0.166, 0.064, 0.004, 0, cone, 0.025, (0.33, 0.19, 0.069), "braid"
    ),
    "stovepipe": Hat(
        0.126,
        0.144,
        0.191,
        0.018,
        0.002,
        0,
        flat_top,
        0.031,
        (0.033, 0.026, 0.023),
        "bow",
    ),
    "rattler-band": Hat(
        0.178,
        0.196,
        0.105,
        0.051,
        0.016,
        0.027,
        creased,
        0.023,
        (0.24, 0.128, 0.049),
        "scales",
    ),
    "ghost-white": Hat(
        0.181,
        0.190,
        0.116,
        0.034,
        0.011,
        0.014,
        open_crown,
        0.021,
        (0.42, 0.34, 0.24),
        "bow",
    ),
    "yellow": Hat(
        0.158,
        0.183,
        0.124,
        0.026,
        0.019,
        0.026,
        creased,
        0.018,
        (0.25, 0.12, 0.034),
        "buckle",
    ),
    "bronze-band": Hat(
        0.178,
        0.192,
        0.118,
        0.044,
        0.009,
        0.021,
        creased,
        0.022,
        (0.26, 0.147, 0.053),
        "bronze",
    ),
    "holed-stetson": Hat(
        0.185,
        0.195,
        0.119,
        0.031,
        0.018,
        0.019,
        creased,
        0.019,
        (0.12, 0.063, 0.033),
        "tear",
    ),
}


def build(name, hat, destination):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for data in list(bpy.data.meshes):
        if data.users == 0:
            bpy.data.meshes.remove(data)
    for mat in list(bpy.data.materials):
        if mat.users == 0:
            bpy.data.materials.remove(mat)
    felt = material("Brim felt", (0.63, 0.54, 0.42), 0.87)
    binding = material("Bound brim", hat.trim, 0.8)
    band = material("Hatband", hat.trim, 0.78)
    stitch = material("Hatband trim", tuple(v * 1.37 for v in hat.trim), 0.70)
    metal = material("Hatband hardware", (0.42, 0.25, 0.097), 0.49, 0.70)

    def brim(t, fraction, depth=0):
        x, y = math.cos(t), math.sin(t)
        r = fraction
        side_curve = abs(x) ** (6 if name == "sombrero" else 4)
        height = 0.013 + r * r * (hat.side_roll * side_curve + hat.front_drop * y)
        height += 0.0025 * r * math.sin(3 * t + 0.4)
        if hat.finish == "tear":
            r -= r**4 * 0.16 * math.exp(-(((t - 4.78) / 0.057) ** 2))
        return (
            (0.085 + r * (hat.width - 0.085)) * x,
            (0.098 + r * (hat.length - 0.098)) * y,
            height + depth,
        )

    def crown(t, radius, height, depth=0):
        x, y = math.cos(t), math.sin(t)
        pinch = 1 - (min(1, height * 1.5) * max(0, -y) ** 2 * 0.21 if hat.dent else 0)
        z = 0.011 + hat.height * height - hat.dent * height**3 * abs(y) ** 3
        return (0.085 * radius + depth) * x * pinch, (0.098 * radius + depth) * y, z

    surface(
        "Felt upper brim",
        [lambda t, r=r: brim(t, r) for r in (1, 0.92, 0.64, 0.35, 0)],
        steps,
        felt,
    )
    surface(
        "Felt under brim",
        [lambda t, r=r: brim(t, r, -0.004) for r in (0, 0.34, 0.7, 0.95, 1)],
        steps,
        felt,
    )
    surface(
        "Bound brim edge",
        [
            lambda t, r=r, z=z: brim(t, r, z)
            for r, z in (
                (0.99, -0.004),
                (1.005, -0.0027),
                (1.006, -0.001),
                (0.993, 0.0007),
            )
        ],
        steps,
        binding,
    )
    surface(
        "Felt crown",
        [lambda t, r=r, h=h: crown(t, r, h) for r, h in hat.silhouette],
        steps,
        felt,
        seal=True,
        omit=(lambda row, sector: row == 2 and sector in (44, 45))
        if hat.finish == "tear"
        else None,
    )
    band_low = 0.006 / hat.height
    band_high = (hat.band_width + 0.006) / hat.height
    surface(
        "Fitted hatband",
        [
            lambda t, h=h, d=d: crown(t, 1, h, d)
            for h, d in (
                (band_low, 0.001),
                (band_low + 0.012, 0.0025),
                (band_high - 0.014, 0.0024),
                (band_high, 0.001),
            )
        ],
        steps,
        band,
    )

    if hat.finish == "braid":
        for phase in (0, math.pi):
            surface(
                "Braided cord",
                [
                    lambda t, offset=offset: crown(
                        t, 1, 0.112 + 0.017 * math.sin(18 * t + phase) + offset, 0.0033
                    )
                    for offset in (-0.008, 0.008)
                ],
                144,
                stitch,
            )
    else:
        for h in (band_low + 0.016, band_high - 0.018):
            surface(
                "Sewn band border",
                [
                    lambda t, height=h + offset: crown(t, 1, height, 0.003)
                    for offset in (-0.004, 0.004)
                ],
                steps,
                stitch,
            )

    def piece(label, t, height, width, length, thickness, mat, twist=0):
        bpy.ops.mesh.primitive_cube_add(size=1, location=crown(t, 1, height, 0.0038))
        obj = bpy.context.object
        obj.name = label
        obj.rotation_euler = (0, twist, t)
        obj.scale = (thickness, width, length)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        obj.data.materials.append(mat)
        bevel = obj.modifiers.new("Soft worked edges", "BEVEL")
        bevel.width = min(thickness / 2, 0.0013)
        bevel.segments = 1
        bpy.ops.object.modifier_apply(modifier=bevel.name)

    middle = (band_low + band_high) / 2
    if hat.finish == "buckle":
        for t in (2.99, 3.25):
            piece(
                "Buckle upright", t, middle, 0.002, hat.band_width * 0.70, 0.0025, metal
            )
        for h in (band_low + 0.027, band_high - 0.027):
            piece("Buckle crossbar", math.pi, h, 0.024, 0.002, 0.0025, metal)
    elif hat.finish == "bow":
        for t, twist in ((2.98, 0.14), (3.30, -0.18)):
            piece(
                "Folded ribbon bow",
                t,
                middle,
                0.022,
                hat.band_width * 0.71,
                0.0045,
                stitch,
                twist,
            )
        piece(
            "Ribbon knot", math.pi, middle, 0.008, hat.band_width * 0.71, 0.0055, band
        )
    elif hat.finish == "scales":
        for j in range(24):
            t = math.tau * j / 24
            piece(
                "Snakeskin chevron",
                t,
                middle,
                0.010,
                0.009,
                0.0017,
                stitch,
                (-1) ** j * 0.64,
            )
    elif hat.finish == "bronze":
        for j in range(16):
            piece(
                "Stamped bronze stud",
                math.tau * j / 16,
                middle,
                0.010,
                0.010,
                0.003,
                metal,
                math.pi / 4,
            )
    elif hat.finish == "tear":
        for t in (4.49, 4.55, 4.61):
            piece(
                "Band repair stitches", t, middle, 0.0015, 0.009, 0.0016, stitch, 0.18
            )

    bpy.ops.export_scene.gltf(
        filepath=str(destination / f"{name}.glb"), export_format="GLB", export_yup=True
    )


destination = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
destination.mkdir(parents=True, exist_ok=True)
for name, hat in hats.items():
    build(name, hat, destination)
