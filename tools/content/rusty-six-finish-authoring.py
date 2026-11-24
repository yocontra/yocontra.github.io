"""Paint the Rusty Six finish into its five fitted UV bands using Blender.

blender -b -P tools/content/rusty-six-finish-authoring.py
"""

from pathlib import Path

import bpy
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / "tools/art/characters"
WIDTH, BAND = 1024, 128
rng = np.random.default_rng(1859)
y, x = np.mgrid[0:BAND, 0:WIDTH]
u, v = x / WIDTH, y / BAND


def noise(columns, rows):
    """Smooth, horizontally repeating variation across the wrap seam."""
    cells = rng.random((rows + 1, columns))
    gx, gy = u * columns, v * rows
    i, j = gx.astype(int), gy.astype(int)
    sx, sy = gx - i, gy - j
    sx, sy = sx * sx * (3 - 2 * sx), sy * sy * (3 - 2 * sy)
    low = cells[j, i] * (1 - sx) + cells[j, (i + 1) % columns] * sx
    high = cells[j + 1, i] * (1 - sx) + cells[j + 1, (i + 1) % columns] * sx
    return low * (1 - sy) + high * sy


def smooth(a, b, value):
    t = np.clip((value - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def scratching(count):
    marks = np.zeros((BAND, WIDTH))
    # Draw short tapered scuffs, wrapped at U, with a few crossing the dominant rub direction.
    for _ in range(count):
        xx, yy = rng.uniform(0, WIDTH), rng.uniform(-2, BAND + 2)
        length = rng.uniform(4, 30)
        slope = rng.normal(0, 0.22)
        dx = (x - xx + WIDTH / 2) % WIDTH - WIDTH / 2
        distance = abs(y - yy - slope * dx)
        mark = (1 - smooth(0.15, 1.25, distance)) * (1 - smooth(0.16, 1, abs(dx) / length))
        marks = np.maximum(marks, mark * rng.uniform(0.35, 0.93))
    return marks


def mix(a, b, factor):
    t = np.asarray(factor)[..., None]
    return a * (1 - t) + b * t


def save(name, bands):
    # Blender numbers image rows from the bottom. The glTF bands start at the top.
    rgb = np.concatenate(bands, axis=0)[::-1]
    pixels = np.concatenate((np.clip(rgb, 0, 1), np.ones((*rgb.shape[:2], 1))), axis=2)
    destination = ART / "revolver-exteriors" / f"rusty-six-{name}.png"
    image = bpy.data.images.new(destination.stem, WIDTH, BAND * 5)
    image.colorspace_settings.name = "Non-Color"
    image.pixels.foreach_set(pixels.astype(np.float32).ravel())
    image.filepath_raw = str(destination)
    image.file_format = "PNG"
    image.save()


albedos, arms, normals = [], [], []
for band in ("walnut", "bluing", "frame", "brass", "inlay"):
    cloud = noise(68, 11) * 0.42 + noise(141, 22) * 0.34 + noise(261, 43) * 0.24
    grain = noise(310, 65)
    pits = smooth(0.56, 0.75, cloud * 0.70 + grain * 0.30)
    cuts = scratching(85 if band == "walnut" else 155)
    if band == "walnut":
        bend = 1.8 * np.sin(4 * np.pi * u) + 5.7 * noise(12, 3)
        grain_lines = smooth(0.54, 0.96, np.cos(v * 68 + bend + 1.4 * noise(45, 5)))
        pores = grain_lines * (0.3 + noise(120, 21) * 0.7)
        figure = np.clip(0.30 + 0.65 * cloud + 0.12 * np.cos(v * 15 + bend) - 0.38 * pores, 0, 1)
        colour = mix(np.array([0.18, 0.081, 0.040]), np.array([0.49, 0.315, 0.185]), figure)
        colour = mix(colour, np.array([0.60, 0.40, 0.23]), cuts * 0.31)
        rough = 0.39 + 0.19 * pores + 0.10 * cloud
        metal = np.zeros_like(rough)
        relief = -pores * 0.55 - cuts * 0.59
    elif band in ("bluing", "frame"):
        # Bluing wears through to grey steel. Oxide remains in small matte pits.
        rubbed = smooth(0.50, 0.77, cloud + 0.09 * noise(12, 4))
        substrate = np.array([0.22, 0.235, 0.245]) if band == "bluing" else np.array([0.27, 0.255, 0.23])
        colour = mix(substrate, np.array([0.49, 0.49, 0.465]), rubbed * 0.51)
        oxide = smooth(0.50, 0.77, cloud * 0.64 + grain * 0.36) * (0.55 + 0.45 * pits)
        colour = mix(colour, np.array([0.325, 0.205, 0.143]), oxide * 0.66)
        colour = mix(colour, np.array([0.59, 0.58, 0.52]), cuts * 0.36)
        rough = 0.47 + 0.12 * cloud + 0.18 * oxide - 0.09 * cuts
        metal = 0.80 - 0.44 * oxide
        relief = (grain - 0.5) * 0.18 - pits * 0.60 - cuts * 0.67
    elif band == "brass":
        tarnish = smooth(0.38, 0.71, cloud)
        colour = mix(np.array([0.70, 0.51, 0.27]), np.array([0.36, 0.285, 0.192]), tarnish * 0.72)
        colour = mix(colour, np.array([0.80, 0.65, 0.41]), cuts * 0.35)
        rough = 0.36 + tarnish * 0.24
        metal = 0.87 - tarnish * 0.25
        relief = (grain - 0.5) * 0.12 - cuts * 0.54
    else:
        colour = mix(np.array([0.70, 0.69, 0.64]), np.array([0.87, 0.84, 0.75]), cloud)
        rough, metal = 0.52 + cloud * 0.13, np.zeros_like(cloud)
        relief = (grain - 0.5) * 0.10
    dx = (np.roll(relief, -1, axis=1) - np.roll(relief, 1, axis=1)) * 0.5
    dy = np.gradient(relief, axis=0)
    normal = np.stack((-dx * 0.40, dy * 0.40, np.ones_like(dx)), axis=2)
    normal /= np.linalg.norm(normal, axis=2, keepdims=True)
    albedos.append(colour)
    arms.append(np.stack((np.ones_like(rough), rough, metal), axis=2))
    normals.append(0.5 + 0.5 * normal)

save("albedo", albedos)
save("arm", arms)
save("normal", normals)
