"""Fit the sewn layers and leather carriers below the two NPC ponchos.

Run after poncho-collars-authoring.py for the two authored outlaws.
"""
import hashlib
import importlib.util
import sys
from pathlib import Path

from mathutils import Vector

sys.dont_write_bytecode = True
base = Path(__file__).with_name("poncho-collars-authoring.py")
spec = importlib.util.spec_from_file_location("poncho", base)
poncho = importlib.util.module_from_spec(spec)
spec.loader.exec_module(poncho)
common = poncho.common
smoothstep = poncho.smoothstep
OUTLAWS = {"outlaw-6", "outlaw-15"}


def fit_layers(source, body, output, metadata, name):
    piece = next(part for part in output["pieces"] if part.get("name") == name)
    bind = poncho.head_inverse_bind(source, body)
    to_source = bind.inverted()
    scale = max((bind @ Vector(point)).y for point in body["attrs"]["POSITION"][:poncho.HEAD_VERTICES])
    scale /= poncho.REFERENCE_CROWN
    start, count = piece["start"], piece["count"]
    for index in range(start, start + count):
        point = (bind @ Vector(output["POSITION"][index])) / scale
        rear = 1 - smoothstep(-.052, .017, point.z)
        upper = smoothstep(-.52, -.32, point.y) * (1 - smoothstep(-.15, -.067, point.y))
        point.z += rear * upper * (.045 if name == "WesternSleeves" else .048)
        if name == "WesternSleeves":
            point.x *= 1 - .16 * rear * upper
        output["POSITION"][index] = list(to_source @ (point * scale))
    pin = Path(__file__).resolve()
    metadata["sourceInputs"] += [pin_entry(pin)]
    return bind, scale


def pin_entry(path):
    return {"path": str(path.relative_to(common.ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def fit_bands(output, metadata, body, bind, scale, double_bandolier):
    ranges = body["ranges"]
    belt = [part for part in ranges if part.get("name") == "Gunbelt" and part["count"] in (144, 80, 10)]
    bandolier = []
    if double_bandolier:
        bandolier = [
            part for part in ranges
            if not part.get("name") and part["count"] in (245, 34)
            and part.get("swatch") in ("leather", "metal")
        ]
        if len(bandolier) != 14:
            raise ValueError("The crossed bandoliers lost their leather or cartridge ranges")
    to_source = bind.inverted()
    source_indices = body["indices"]
    removed = set(metadata["removeTriangles"])
    for region in bandolier + belt:
        start = region["start"]
        end = start + region["count"]
        is_belt = region in belt
        tris = poncho.triangles_inside(body, start, end)
        if not tris:
            raise ValueError("A fitted leather or metal range has no triangles")
        poncho.append_restored_faces(output, body["attrs"], tris, region)
        fitted = output["pieces"][-1]
        local = [
            (bind @ Vector(output["POSITION"][index])) / scale
            for index in range(fitted["start"], fitted["start"] + fitted["count"])
        ]

        def tuck(point):
            if is_belt:
                amount = smoothstep(-.72, -.57, point.y) if region["count"] == 10 else 1
                return Vector((point.x * (1 - .16 * amount), point.y,
                               point.z + (.057 - point.z) * .28 * amount))
            rear = 1 - smoothstep(-.068, .012, point.z)
            return Vector((point.x * .77, point.y - .020 * smoothstep(-.32, -.09, point.y),
                           .033 + .47 * (point.z - .033) + .060 * rear))

        if region.get("swatch") == "metal":
            center = sum(local, Vector((0, 0, 0))) / len(local)
            shift = tuck(center) - center
            local = [point + shift for point in local]
        else:
            local = [tuck(point) for point in local]
        for index, point in enumerate(local, fitted["start"]):
            output["POSITION"][index] = list(to_source @ (point * scale))
        removed.update(
            offset // 3 for offset in range(0, len(source_indices), 3)
            if all(start <= vertex < end for vertex in source_indices[offset:offset + 3])
        )
    metadata["removeTriangles"] = sorted(removed)
    metadata["ponchoFit"]["tuckedBandolierParts"] = len(bandolier)
    metadata["ponchoFit"]["tuckedGunbeltParts"] = len(belt)


def torso(source, body):
    if source.path.stem not in OUTLAWS:
        return None
    output, metadata = poncho.fit(source, body)
    bind, scale = fit_layers(source, body, output, metadata, "WesternShirt")
    fit_bands(output, metadata, body, bind, scale, source.path.stem == "outlaw-15")
    return output, metadata


def sleeves(source, body):
    if source.path.stem not in OUTLAWS:
        return None
    output, metadata = poncho.fit_sleeves(source, body)
    fit_layers(source, body, output, metadata, "WesternSleeves")
    return output, metadata


if __name__ == "__main__":
    common.run(torso, "coat-collars")
    common.run(sleeves, "poncho-sleeves")
