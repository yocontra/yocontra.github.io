"""Refit baked wool sleeves without changing the shirt or cuff geometry."""

import hashlib
import importlib.util
from pathlib import Path

from mathutils import Vector

base_path = Path(__file__).with_name("coat-sleeves-authoring.py")
spec = importlib.util.spec_from_file_location("coat_sleeve_surface", base_path)
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def smoothstep(t):
    t = min(1, max(0, t))
    return t * t * (3 - 2 * t)


def accept_shape(original, target, indices, triangles):
    faces = []
    for offset in range(0, len(triangles), 3):
        a, b, c = triangles[offset:offset + 3]
        if a not in indices:
            continue
        normal = (original[b] - original[a]).cross(original[c] - original[a])
        if normal.length > 1e-11:
            faces.append((a, b, c, normal))
    # Narrow folds have less room for tailoring. Use the largest tested step
    # that retains their orientation and at least a quarter of their area.
    strength = 1.0
    for _ in range(10):
        proposed = {index: original[index].lerp(target[index], strength) for index in indices}
        for a, b, c, normal in faces:
            slope = (proposed[b] - proposed[a]).cross(proposed[c] - proposed[a])
            if normal.dot(slope) < normal.length_squared * 0.25:
                break
        else:
            return proposed
        strength *= 0.5
    return original


def tailored_sleeves(source, body):
    result = base.sleeves(source, body)
    if result is None:
        return None
    arrays, metadata = result
    positions, uv = (arrays[key] for key in ("POSITION", "TEXCOORD_0"))
    for piece in arrays["pieces"]:
        indices = range(piece["start"], piece["start"] + piece["count"])
        original = {index: Vector(positions[index]) for index in indices}
        target = original.copy()
        wrist = min(uv[index][1] for index in indices)
        shoulder = max(uv[index][1] for index in indices)
        rings = {}
        for index in indices:
            rings.setdefault(uv[index][1], []).append(index)
        for row, members in sorted(rings.items()):
            length = (row - wrist) / (shoulder - wrist)
            ease = smoothstep((length - 0.18) / 0.22) * smoothstep((1 - length) / 0.20)
            if ease == 0:
                continue
            # Scale each cross-section around its own centre. The folded inside and
            # outside move together, so the narrow sewn band does not turn inside out.
            unique = sorted({tuple(positions[index]) for index in members})
            center = sum((Vector(point) for point in unique), Vector((0, 0, 0))) / len(unique)
            radius = max((Vector(point) - center).length for point in unique)
            if radius > 0:
                scale = 1 - min(0.16, 0.010 / radius) * ease
                for index in members:
                    target[index] = center + (original[index] - center) * scale
        for index, position in accept_shape(original, target, indices, arrays["indices"]).items():
            positions[index] = list(position)
    inputs = [Path(__file__), base_path]
    metadata["sourceInputs"] = [
        {"path": str(p.relative_to(base.ROOT)), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
        for p in inputs
    ]
    return arrays, metadata


if __name__ == "__main__":
    base.run(tailored_sleeves, "coat-sleeves")
