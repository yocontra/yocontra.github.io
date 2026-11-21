"""Fit the elbow pleats and wool turnbacks of the riding duster."""
import hashlib
import importlib.util
import json
import math
import os
import sys
from pathlib import Path

from mathutils import Matrix, Vector

sys.dont_write_bytecode = True
profile_path = Path(__file__).with_name("coat-profiles.json")
profiles = json.loads(profile_path.read_text())
root = Path(__file__).resolve().parents[2]
library = root / "tools/content/coat-collars-authoring.py"
spec = importlib.util.spec_from_file_location("wool_sleeve_writer", library)
portable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portable)
source_code = Path(__file__).resolve()
common = portable.common
style_streams = ("COLOR_0", "_DYE", "_STYLE_LUMINANCE", "_STYLE_MATERIAL")


def smooth(t):
    t = max(0, min(1, t))
    return t*t*(3-2*t)


def pivot(source, body, joint_name):
    node = source.doc["nodes"][body["sourcePrimitive"]["nodeIndex"]]
    skin = source.doc["skins"][node["skin"]]
    values = source.accessor(skin["inverseBindMatrices"])[body["jointNames"].index(joint_name)]
    matrix = Matrix([[values[column * 4 + row] for column in range(4)] for row in range(4)])
    return matrix.inverted().translation


def fit(source, body):
    profile = profiles.get(source.path.stem.removesuffix(".pair"))
    if profile is None:
        return None
    output, extras = common.sleeves(source, body)
    attrs = body["attrs"]
    for name in style_streams:
        if name in attrs:
            output["_AUTHOR_" + name.lstrip("_")] = [None] * len(output["POSITION"])
    for piece in output["pieces"]:
        side = piece["name"][-1]
        start = piece["start"]
        stop = start + piece["count"]
        indices = range(start, stop)
        elbow = pivot(source, body, "LowerArm" + side)
        wrist = pivot(source, body, "Wrist" + side)
        arm = wrist-elbow
        direction = arm.normalized()
        ref = Vector((0, 0, 1))
        cross = ref.cross(direction).normalized()
        outward = direction.cross(cross).normalized()
        positions = [Vector(output["POSITION"][i]) for i in indices]
        tip = max((point-elbow).dot(direction) for point in positions)
        for i in indices:
            p = Vector(output["POSITION"][i])
            relative = p-elbow
            length = relative.dot(direction)
            radial = relative-direction*length
            angle = math.atan2(radial.dot(outward),radial.dot(cross))
            hem = max(0, tip-length)
            cuff = smooth((.057-hem)/.014)
            turnback = math.exp(-((hem-.050)/.010)**2)
            elbow_pleat = math.exp(-((length-.042)/.075)**2)
            depth = elbow_pleat*(.0058*math.cos(length*96 + 1.35*math.sin(angle)) + .0032*math.cos(length*161-angle*.6))
            depth += .005*turnback + .004*math.exp(-((hem-.003)/.004)**2)
            p += radial.normalized()*depth-radial*(profile["cuffTurn"]*cuff)
            output["POSITION"][i]=list(p)
            fold_shadow = max(0, -depth) / .009
            for name in style_streams:
                if name not in attrs:
                    continue
                values = attrs[name][piece["sourceStyleIndex"]][:]
                if name == "COLOR_0":
                    tint = (1-.24*cuff-.12*fold_shadow, 1-.26*cuff-.13*fold_shadow, 1-.20*cuff-.11*fold_shadow)
                    values = [channel*tint[j] if j<3 else channel for j,channel in enumerate(values)]
                output["_AUTHOR_"+name.lstrip("_")][i]=values

        faces = [tuple(v-start for v in output["indices"][t:t+3])
                 for t in range(0,len(output["indices"]),3)
                 if all(start<=v<stop for v in output["indices"][t:t+3])]
        fitted = common.author_mesh("Shaped wool sleeve "+side,
                                   [output["POSITION"][i] for i in indices], faces,
                                   [output["TEXCOORD_0"][i] for i in indices],
                                   [output["_AUTHOR_JOINTS"][i] for i in indices],
                                   [output["_AUTHOR_WEIGHTS"][i] for i in indices])
        seam_normals = {}
        for i in indices:
            normal = fitted.data.vertices[i-start].normal
            authored = Vector((normal.x, normal.z, -normal.y))
            original = Vector(output["NORMAL"][i])
            if authored.dot(original) < 0:
                authored = -authored
            key = tuple(round(value, 6) for value in (*positions[i-start], *original))
            seam_normals.setdefault(key, []).append((i, authored, original))
        for matches in seam_normals.values():
            averaged = sum((authored for _, authored, _ in matches), Vector()).normalized()
            for i, _, normal in matches:
                output["NORMAL"][i] = list(normal.lerp(averaged, .72).normalized())

    extras["sourceInputs"] = [{"path":str(path.relative_to(common.ROOT)), "sha256":hashlib.sha256(path.read_bytes()).hexdigest()}
                              for path in (source_code, profile_path, library, library.with_name("coat-sleeves-authoring.py"))]
    extras["woolSleeve"] = {"profile":"formed elbow pleats and sewn turnbacks","retainedNativeSkin":True}
    return output, extras


if __name__ == "__main__":
    common.run(fit, os.environ.get("OUT_WEST_GARMENT_OUTPUT", "coat-sleeves"))
