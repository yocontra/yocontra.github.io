"""Bake only the actual unfolded anterior skin normal mask with native Cycles.

Blender --background --factory-startup --python-exit-code 1 --python this-file --
 --input .out-west-qa/head-throat/normal-art/input.json --output .out-west-qa/head-throat/normal-art
Original PNGs/lattice/accepted posterior texels remain read only. No normal clamp.
"""
import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import bpy
import numpy as np

spec = importlib.util.spec_from_file_location("native_skin_bake", Path(__file__).with_name("head-nape-authoring.py"))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def dilate(mask, pixels):
    result = mask.copy()
    for _ in range(pixels):
        padded = np.pad(result, 1)
        result = np.logical_or.reduce([padded[y:y + mask.shape[0], x:x + mask.shape[1]]
                                       for y in range(3) for x in range(3)])
    return result


def strict_coverage(triangles, shape):
    """Pixel-centre coverage; no loose barycentric halo or hand-painted mask."""
    height, width = shape
    result = np.zeros(shape, bool)
    for triangle in triangles:
        points = np.asarray(triangle) * (width, height)
        lo, hi = np.floor(points.min(0)).astype(int), np.ceil(points.max(0)).astype(int)
        ys, xs = np.mgrid[max(0, lo[1]):min(height, hi[1] + 1), max(0, lo[0]):min(width, hi[0] + 1)]
        weights = barycentric(points, xs + .5, ys + .5)
        if weights is not None:
            inside = np.min(weights, axis=0) >= -1e-9
            result[ys[inside], xs[inside]] = True
    return result


def barycentric(points, x, y):
    (ax, ay), (bx, by), (cx, cy) = points
    denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if abs(denominator) < 1e-15:
        return None
    u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator
    v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator
    return np.stack((u, v, 1 - u - v))


def pixel_hash(mask):
    return hashlib.sha256(np.flatnonzero(mask).astype("<u4").tobytes()).hexdigest()


def consumer_protection(consumer, candidate, shape):
    """Check interpolated physical ownership of every candidate texel on every consumer."""
    height, width = shape
    ys, xs = np.nonzero(candidate)
    px, py = (xs + .5) / width, (ys + .5) / height
    forbidden = np.zeros(len(xs), bool)
    head_hit = np.zeros(len(xs), bool)
    for surface in consumer["surfaces"]:
        points = np.asarray(surface["uvs"])
        weights = barycentric(points, px, py)
        if weights is None:
            continue
        hit = np.min(weights, axis=0) >= -1e-9
        if not hit.any():
            continue
        if not surface["head"]:
            forbidden |= hit
            continue
        head_hit |= hit
        physical = weights.T @ np.asarray(surface["points"])
        inside = ((np.abs(physical[:, 0]) < .07) & (physical[:, 1] > -.1)
                  & (physical[:, 1] < .025) & (physical[:, 2] > .015))
        forbidden |= hit & ~inside
    protected = np.zeros(shape, bool)
    protected[ys[forbidden], xs[forbidden]] = True
    return protected, {"id": consumer["id"], "headPixels": int(head_hit.sum()),
                       "forbiddenPixels": int(forbidden.sum()), "unusedPixels": int((~head_hit).sum())}


def bake_normal(obj, material, image, nodes):
    """Use the stock Cycles surface with this producer's actual two-pixel bake margin."""
    bsdf, _emission, output, target = nodes
    material.node_tree.links.new(bsdf.outputs[0], output.inputs["Surface"])
    target.image = image
    material.node_tree.nodes.active = target
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.render.bake.margin = 2
    scene.render.bake.margin_type = "EXTEND"
    scene.render.bake.use_clear = False
    scene.render.bake.normal_space = "TANGENT"
    image.pixels.foreach_set(np.zeros(len(image.pixels), np.float32))
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.bake(type="NORMAL", margin=2, margin_type="EXTEND")
    width, height = image.size
    pixels = np.empty(width * height * 4, np.float32)
    image.pixels.foreach_get(pixels)
    return pixels.reshape(height, width, 4)[::-1].copy()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    data = json.loads(args.input.read_text())
    inventory = json.loads(Path(__file__).with_name("head-throat-family.json").read_text())
    expected = [identifier for identifier in inventory["bodyIDs"] if identifier not in inventory["normalControls"]]
    if data["reference"] != "player" or len(expected) != 32 or data["sourceIds"] != expected:
        raise ValueError("Native anterior normal bake requires the exact approved 32 male consumers")
    for record in data["sourceInputs"]:
        if hashlib.sha256((native.ROOT / record["path"]).read_bytes()).hexdigest() != record["sha256"]:
            raise ValueError(f"Stale native normal input: {record['path']}")
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    positions, uvs = np.array(data["positions"]), np.array(data["uvs"])
    triangles, owned, other = [np.array(data[key], dtype=np.int32) for key in ("triangles", "owned", "other")]
    width, height = data["size"]
    obj = native.bake_mesh(positions, uvs, triangles)
    # Use the accepted custom geometric normals, not the old folded source normals.
    normals = np.array(data["normals"])
    obj.data.normals_split_custom_set_from_vertices(normals[:, (0, 2, 1)] * (1, -1, 1))
    image = bpy.data.images.new("Unfolded anterior skin normal", width=width, height=height,
                                alpha=True, float_buffer=True)
    image.colorspace_settings.name = "Non-Color"
    material, bsdf, emission, output, target = native.skin_material(obj, image)
    baked = bake_normal(obj, material, image, (bsdf, emission, output, target))
    domain = json.loads(Path(__file__).with_name("head-throat-normal-domain.json").read_text())
    if data["domain"] != domain or domain["paddingPixels"] != 2 or domain["size"] != [width, height]:
        raise ValueError("Normal ownership contract changed after source preparation")
    coverage = strict_coverage(data["ownedUVTriangles"], (height, width))
    if int(coverage.sum()) != domain["strictPixelCount"] or pixel_hash(coverage) != domain["strictPixelSHA256"]:
        raise ValueError("Native strict UV coverage differs from the approved geometric union")
    candidate = dilate(coverage, 2)
    reference_coverage = strict_coverage(uvs[triangles], (height, width))
    protected = np.zeros((height, width), bool)
    ownership = []
    if [consumer["id"] for consumer in data["consumers"]] != expected:
        raise ValueError("Normal ownership must check all32 actual consumers")
    for consumer in data["consumers"]:
        blocked, receipt = consumer_protection(consumer, candidate, (height, width))
        protected |= blocked
        ownership.append(receipt)
    if (coverage & protected).any() or (coverage & ~reference_coverage).any():
        raise ValueError("Strict anterior ownership crosses a protected island or uncovered reference surface")
    # Native bake margin provides real neighbouring surface normals. Padding may
    # extend only into unowned atlas space, never across another source island.
    mask = candidate & reference_coverage & ~protected & (baked[..., 3] > 0.5)
    if (coverage & ~mask).any():
        raise ValueError("Native bake did not cover every strict source texel")
    ys, xs = np.nonzero(coverage)
    lower_distance = min(int(np.maximum(np.abs(xs - x), np.abs(ys - y)).min())
                         for x, y in domain["lowerNeckExcludedPixels"])
    if lower_distance <= 2 or any(mask[y, x] for x, y in domain["lowerNeckExcludedPixels"]):
        raise ValueError("Anterior normal mask reached the separate lower-neck defect")
    vectors = baked[..., :3] * 2 - 1
    lengths = np.linalg.norm(vectors, axis=-1)
    invalid = mask & ((vectors[..., 2] <= 0) | (lengths < 0.98) | (lengths > 1.02))
    if not mask.any() or invalid.any():
        raise ValueError(f"Native anterior normal bake failed: owned={int(mask.sum())}, invalid={int(invalid.sum())}")
    ys, xs = np.nonzero(mask)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    args.output.mkdir(parents=True, exist_ok=True)
    native.OUTPUT = args.output
    native.write("anterior-normal", baked, mask.astype(np.float32), box)
    png = args.output / "anterior-normal.png"
    descriptor = {"asset": {"version": "2.0", "generator": "Blender native anterior skin normal bake"},
                  "extras": {"sourceInputs": data["sourceInputs"], "normalPatch": {
                      "sourceIds": data["sourceIds"], "sourceSHA256": hashlib.sha256((native.ROOT / data["normalPath"]).read_bytes()).hexdigest(),
                      "image": png.name, "imageSHA256": hashlib.sha256(png.read_bytes()).hexdigest(),
                      "x": box[0], "y": box[1], "width": box[2] - box[0], "height": box[3] - box[1]},
                      "nativeNormalBake": {"reference": "player", "ownedTriangles": len(data["ownedUVTriangles"]), "referencePatchTriangles": len(owned), "ownedPixels": int(mask.sum()),
                                           "paddingPixels": 2, "actualCyclesBakeMargin": int(bpy.context.scene.render.bake.margin),
                                           "strictPixels": int(coverage.sum()), "strictPixelSHA256": pixel_hash(coverage),
                                           "maskPixelSHA256": pixel_hash(mask), "sourceCoveredPadding": True,
                                           "candidateConsumerOwnership": ownership, "strictProtectedPixels": 0,
                                           "actualMaskForbiddenPixels": 0, "processedItemIds": expected,
                                           "lowerNeckStrictDistancePixels": lower_distance, "lowerNeckExcludedPixelsUnchanged": True,
                                           "otherIslandPixelsProtected": True,
                                           "outsideMaskPreservedByOverlay": True, "clampOrPaint": False,
                                           "minimumTangentZ": float(vectors[..., 2][mask].min()),
                                           "lengthBounds": [float(lengths[mask].min()), float(lengths[mask].max())],
                                           "inputGeometrySHA256": hashlib.sha256(args.input.read_bytes()).hexdigest()}}}
    (args.output / "atlas.gltf").write_text(json.dumps(descriptor, indent=2) + "\n")
    print(json.dumps(descriptor["extras"]["nativeNormalBake"]))


if __name__ == "__main__":
    main()
