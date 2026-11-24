"""Bake face contours, beard shadow and facial roughness from the two Blender head meshes."""

import json
import os
import shutil
import struct
import subprocess
import tempfile
import zlib
from pathlib import Path

import bpy
import numpy as np

root = Path(__file__).resolve().parents[2]
art = root / "tools/art/characters"
output = art / "saloon-cast"
texture_root = root / "public/experiments/out-west/3d/native-v2/characters"


def png(path, pixels):
    data = np.uint8(np.clip(pixels, 0, 1) * 255 + 0.5)
    height, width, _ = data.shape

    def chunk(kind, payload):
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload))
        )

    rows = b"".join(b"\x00" + row.tobytes() for row in data[::-1])
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows, 9))
        + chunk(b"IEND", b"")
    )


def footprint(mesh, size):
    """Project Blender loop triangles to their original UVs, retaining metre-scale coordinates."""
    mesh.calc_loop_triangles()
    uvs = mesh.uv_layers.active.data
    position = np.full((size, size, 3), np.nan, dtype=np.float32)
    for tri in mesh.loop_triangles:
        uv = np.array([uvs[i].uv[:] for i in tri.loops]) * size - 0.5
        xyz = np.array([mesh.vertices[i].co[:] for i in tri.vertices])
        low = np.maximum(0, np.ceil(uv.min(0)).astype(int))
        high = np.minimum(size - 1, np.floor(uv.max(0)).astype(int))
        x0, y0 = low
        x1, y1 = high + 1
        if x1 <= x0 or y1 <= y0:
            continue
        a, b = uv[1] - uv[0], uv[2] - uv[0]
        det = a[0] * b[1] - a[1] * b[0]
        if abs(det) < 1e-9:
            continue
        y, x = np.mgrid[y0:y1, x0:x1] - uv[0][::-1, None, None]
        u, v = (x * b[1] - y * b[0]) / det, (y * a[0] - x * a[1]) / det
        mask = (u >= 0) & (v >= 0) & (u + v <= 1)
        position[y0:y1, x0:x1][mask] = (
            xyz[0]
            + (xyz[1] - xyz[0]) * u[mask, None]
            + (xyz[2] - xyz[0]) * v[mask, None]
        )
    return position


def smooth(lo, hi, value):
    t = np.clip((value - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def sculpt(source, name):
    # Keep the original vertex order across the UV seams and skin binds. Blender
    # imports merge some seam vertices. Use the portable mesh for the brush samples.
    blob = source.read_bytes()
    end = 20 + struct.unpack_from("<I", blob, 12)[0]
    doc = json.loads(blob[20:end])
    shape = next(m for m in doc["meshes"] if "anatomical topology" in m["name"])
    attributes = shape["primitives"][0]["attributes"]

    def vectors(attribute, columns=3):
        acc = doc["accessors"][attributes[attribute]]
        view = doc["bufferViews"][acc["bufferView"]]
        base = end + 8 + view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        return np.ndarray(
            (acc["count"], columns),
            dtype="<f4",
            buffer=blob,
            offset=base,
            strides=(view.get("byteStride", columns * 4), 4),
        ).astype(np.float64)

    points, normals = vectors("POSITION"), vectors("NORMAL")

    def depth(p):
        x, y, z = p.T
        a = abs(x + 0.027)
        cheek = np.exp(-(((a - 0.050) / 0.023) ** 2) - ((y - 1.561) / 0.014) ** 2)
        jowl = np.exp(-(((a - 0.055) / 0.018) ** 2) - ((y - 1.521) / 0.027) ** 2)
        orbital = np.exp(-(((a - 0.034) / 0.016) ** 2) - ((y - 1.571) / 0.0038) ** 2)
        cheek_fold = np.exp(-(((a - (0.018 + (1.55 - y) * 0.39)) / 0.0038) ** 2))
        cheek_fold *= np.exp(-(((y - 1.535) / 0.014) ** 2))
        relief = 0.0034 * cheek - 0.004 * jowl + 0.0019 * orbital - 0.0021 * cheek_fold
        # Fitted eyebrow strands sit just above the existing brow line.
        relief *= 1 - smooth(1.579, 1.586, y)
        return smooth(0.075, 0.102, z) * relief * (0.70 if name == "greenhorn" else 1)

    delta = depth(points)
    step = np.eye(3) * 0.00002
    gradient = np.stack(
        [(depth(points + s) - depth(points - s)) / 0.00004 for s in step], axis=1
    )
    # Inverse-transpose of the local depth deformation preserves authored seam normals.
    sculpted = normals - gradient * (normals[:, 2] / (1 + gradient[:, 2]))[:, None]
    sculpted /= np.maximum(1e-9, np.linalg.norm(sculpted, axis=1))[:, None]
    # Front, back extrema stay fixed. The fitter uses these same anchors after quantization.
    anchors = [int(np.argmin(points[:, 2])), int(np.argmax(points[:, 2]))]
    edits = [
        [
            i,
            round(float(points[i, 2] + delta[i]), 7),
            *[round(float(n), 6) for n in sculpted[i]],
        ]
        for i in range(len(points))
        if abs(delta[i]) > 0.000025 and i not in anchors
    ]
    uv = vectors("TEXCOORD_0", 2)
    recipe = {
        "vertices": len(points),
        "anchors": anchors,
        "uvChecks": [
            [i, *uv[i].round(6).tolist()]
            for i in range(0, len(uv), max(1, len(uv) // 11))
        ],
        "depths": points[anchors, 2].tolist(),
        "edits": edits,
    }
    (output / f"{name}-sculpt.json").write_text(
        json.dumps(recipe, separators=(",", ":")) + "\n"
    )


def bake(model, name, original, inputs):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(art / model))
    skin = next(
        o.data
        for o in bpy.context.scene.objects
        if o.type == "MESH"
        and any(m and m.name == "Field-worn skin" for m in o.data.materials)
    )
    sculpt(art / model, name)
    size = 1536
    xyz = footprint(skin, size)
    covered = np.isfinite(xyz[:, :, 0])
    x, depth, y = np.nan_to_num(xyz).transpose(2, 0, 1)
    front = -depth
    lat = abs(x + 0.027)
    face = covered * smooth(0.023, 0.097, front)
    # The upper orbit is shaded by the brow. The lower lid stays moist and the cheek stays matte.
    orbit = np.exp(-(((lat - 0.033) / 0.021) ** 2) - ((y - 1.579) / 0.012) ** 2) * face
    temple = np.exp(-(((lat - 0.049) / 0.022) ** 2) - ((y - 1.552) / 0.017) ** 2) * face
    nose = np.exp(-((lat / 0.014) ** 2) - ((y - 1.558) / 0.03) ** 2) * face
    lips = np.exp(-((lat / 0.022) ** 4) - ((y - 1.518) / 0.005) ** 2) * face
    cheekline = 1.523 + 0.040 * smooth(0.029, 0.085, lat)
    beard = smooth(1.441, 1.475, y) * (
        1 - smooth(cheekline - 0.011, cheekline + 0.009, y)
    )
    beard *= smooth(-0.013, 0.070, front) * (1 - lips) * covered
    upper_lip = (
        np.exp(-(((y - 1.533) / 0.005) ** 2)) * (1 - smooth(0.016, 0.032, lat)) * face
    )
    hair = np.maximum(beard, upper_lip)
    # Cell jitter offsets short whiskers. Their direction follows the jaw toward the chin.
    lateral = x + 0.027
    horizontal = (lateral + 0.32 * np.sign(lateral) * (y - 1.50) + 0.22 * depth) * 540
    vertical = (y + front * 0.23) * 450
    cell_x, cell_y = np.floor(horizontal), np.floor(vertical)
    seed = np.sin(cell_x * 37.19 + cell_y * 79.31) * 17583.73
    jitter = seed - np.floor(seed)
    dx = (horizontal - cell_x) - (0.2 + 0.60 * jitter)
    dy = (vertical - cell_y) - (0.5 + 0.24 * np.sin(seed))
    follicle = np.exp(-((dx / 0.19) ** 2 + (dy / 0.38) ** 2)) * hair
    source = bpy.data.images.load(str(inputs / original))
    source.colorspace_settings.name = "Non-Color"
    source.scale(size, size)
    pixels = np.empty(size * size * 4, dtype=np.float32)
    source.pixels.foreach_get(pixels)
    color = pixels.reshape(size, size, 4)[:, :, :3].copy()
    shadow = (0.072 if name == "rider" else 0.038) * hair + 0.13 * follicle
    color *= 1 - shadow[:, :, None]
    color[:, :, 0] *= 1 - 0.055 * orbit + 0.028 * temple + 0.022 * nose
    color[:, :, 1] *= 1 - 0.088 * orbit - 0.023 * temple - 0.018 * nose
    color[:, :, 2] *= 1 - 0.078 * orbit - 0.033 * temple - 0.025 * nose
    rough = 0.81 - 0.22 * nose - 0.16 * lips - 0.11 * orbit + 0.055 * hair
    arm = np.stack([np.ones_like(rough), rough, np.zeros_like(rough)], axis=2)
    png(output / f"{name}-color.png", color)
    png(output / f"{name}-arm.png", arm[::2, ::2])
    print(name, int(covered.sum()), int((hair > 0.5).sum()), flush=True)


def hand_surface():
    # The portable sleeve source carries both hands with their final native UV layout.
    blob = (art / "coat-sleeves/outfit.trail-duds.glb").read_bytes()
    end = 20 + struct.unpack_from("<I", blob, 12)[0]
    doc = json.loads(blob[20:end])

    def stream(d, data, index, columns, dtype):
        a = d["accessors"][index]
        v = d["bufferViews"][a["bufferView"]]
        return np.ndarray(
            (a["count"], columns),
            dtype,
            buffer=data,
            offset=v.get("byteOffset", 0) + a.get("byteOffset", 0),
            strides=(
                v.get("byteStride", columns * np.dtype(dtype).itemsize),
                np.dtype(dtype).itemsize,
            ),
        )

    source = blob[end + 8 :]
    part = doc["meshes"][0]["primitives"][0]
    skin = next(r for r in part["extras"]["pieceRanges"] if r["name"] == "Hands")
    first, count = skin["start"], skin["count"]
    xyz = stream(doc, source, part["attributes"]["POSITION"], 3, "<f4")[
        first : first + count
    ]
    uv = stream(doc, source, part["attributes"]["TEXCOORD_0"], 2, "<f4")[
        first : first + count
    ]
    idx = part["indices"]
    faces = (
        stream(
            doc,
            source,
            idx,
            1,
            {5123: "<u2", 5125: "<u4"}[doc["accessors"][idx]["componentType"]],
        )
        .reshape(-1, 3)
        .astype(int)
    )
    faces = faces[np.all((faces >= first) & (faces < first + count), axis=1)] - first
    mesh = bpy.data.meshes.new("Fitted hands")
    mesh.from_pydata(xyz.tolist(), [], faces.tolist())
    layer = mesh.uv_layers.new()
    for loop in mesh.loops:
        u, v = uv[loop.vertex_index]
        layer.data[loop.index].uv = (u, 1 - v)
    size = 1024
    surface = footprint(mesh, size)
    covered = np.isfinite(surface[:, :, 0])
    point = np.nan_to_num(surface)
    raw = json.loads((art / "outfit.trail-duds.gltf").read_text())
    skeleton = raw["skins"][
        next(
            n["skin"]
            for n in raw["nodes"]
            if n.get("name") == "Character" and "mesh" in n
        )
    ]
    matrices = stream(
        raw,
        (art / "outfit.trail-duds.bin").read_bytes(),
        skeleton["inverseBindMatrices"],
        16,
        "<f4",
    )
    joints = {
        raw["nodes"][j]["name"]: np.linalg.inv(mat.reshape(4, 4).T)[:3, 3]
        for j, mat in zip(skeleton["joints"], matrices)
    }
    pigment = bpy.data.images.load(str(art / "textures/field-hands.default.albedo.png"))
    pigment.colorspace_settings.name = "Non-Color"
    pigment.scale(size, size)
    pixels = np.empty(size * size * 4, dtype=np.float32)
    pigment.pixels.foreach_get(pixels)
    color = pixels.reshape(size, size, 4)[:, :, :3].copy()
    for side in "LR":
        for digit in ("Index", "Middle", "Ring", "Pinky", "Thumb"):
            for joint in (1, 2):
                center = joints[f"{digit}{joint}{side}"]
                forward = joints[f"{digit}{joint + 1}{side}"] - center
                forward /= np.linalg.norm(forward)
                off = point - center
                along = np.sum(off * forward, axis=2)
                span = np.sum(off * off, axis=2) - along**2
                crown = (
                    np.exp(-np.maximum(0, span) / 0.00017 - (along / 0.012) ** 2)
                    * covered
                )
                fold = crown * np.exp(
                    -(((along + 0.001 * np.cos(point[:, :, 1] * 320)) / 0.0013) ** 2)
                )
                color[:, :, 0] *= 1 + 0.025 * crown - 0.08 * fold
                color[:, :, 1] *= 1 - 0.045 * crown - 0.10 * fold
                color[:, :, 2] *= 1 - 0.06 * crown - 0.10 * fold
    png(output / "hands-color.png", color)


output.mkdir(exist_ok=True)
ktx = os.environ.get("KTX_TOOL") or shutil.which("ktx")
if not ktx:
    raise RuntimeError("Set KTX_TOOL to the ktx executable from KTX-Software 4.4.2")
# Reuse the shipped CC0 skin maps as source paint. Keep the release input distinct
# from the new content-addressed output so the bake is repeatable.
with tempfile.TemporaryDirectory(prefix="out-west-saloon-skin-") as temp:
    inputs = Path(temp)
    for model, name, key in (
        ("rider-head.glb", "rider", "b0bf5869d901eb5b95ecc46e"),
        ("outlaw-faces/outlaw-0.glb", "greenhorn", "6f02e61bdb5b1ec9a93a387a"),
    ):
        image = f"{key}.png"
        subprocess.run(
            [
                ktx,
                "extract",
                "--transcode",
                "rgba8",
                str(texture_root / f"{key}.color.ktx2"),
                str(inputs / image),
            ],
            check=True,
        )
        bake(model, name, image, inputs)
hand_surface()
