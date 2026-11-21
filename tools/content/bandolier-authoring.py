"""Model tapered, folded leather straps around the fitted bandolier hardware."""
import hashlib
import importlib.util
import math
import os
import sys
from pathlib import Path

from mathutils import Vector

sys.dont_write_bytecode = True
path = Path(__file__).resolve()
library = path.with_name("poncho-collars-authoring.py")
spec = importlib.util.spec_from_file_location("woven_fit", library)
shape = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shape)
common = shape.common


def fit(source, body):
    if source.path.stem not in {"outfit.bandolier-rig", "outfit.bandolier-rig.pair"}:
        return None
    attrs = body["attrs"]
    leather = [piece for piece in body["ranges"] if piece.get("swatch") == "leather" and piece["count"] == 245]
    if len(leather) != 2:
        raise ValueError("Missing crossed leather straps")
    bind = shape.head_inverse_bind(source, body)
    inverse = bind.inverted()
    inv_normals = inverse.to_3x3()
    output = common.output_arrays()
    styles = [key for key in shape.STYLE if key in attrs]
    for key in styles:
        output["_AUTHOR_" + key.lstrip("_")] = []

    def vertex(v, point, normal, uv, tint=(1, 1, 1), roughness=1):
        output["POSITION"].append(list(inverse @ point))
        output["NORMAL"].append(list((inv_normals @ normal).normalized()))
        output["TEXCOORD_0"].append(uv)
        output["_AUTHOR_JOINTS"].append(attrs["JOINTS_0"][v][:])
        output["_AUTHOR_WEIGHTS"].append(attrs["WEIGHTS_0"][v][:])
        for key in styles:
            value = attrs[key][v][:]
            if key == "COLOR_0":
                value = [channel * (tint[i] if i < 3 else 1) for i, channel in enumerate(value)]
            elif key == "_STYLE_MATERIAL":
                value[0] *= roughness
            output["_AUTHOR_" + key.lstrip("_")].append(value)
        return len(output["POSITION"]) - 1

    def quad(a,b,c,d):
        pa,pb,pc,normal = (Vector(output[k][v]) for k,v in (("POSITION",a),("POSITION",b),("POSITION",c),("NORMAL",a)))
        if (pb-pa).cross(pc-pa).dot(normal) < 0:
            output["indices"].extend([a,c,b,a,d,c])
        else:
            output["indices"].extend([a,b,c,a,c,d])

    for strap in leather:
        first = strap["start"]
        rings = 49
        groups = [tuple(first + row * 5 + n for n in range(4)) for row in range(rings)]
        centers = [sum((bind @ Vector(attrs["POSITION"][i]) for i in group), Vector()) / 4 for group in groups]
        frames = []
        for row, center in enumerate(centers):
            along = (centers[(row + 1) % rings] - centers[(row - 1) % rings]).normalized()
            # Outward around the chest, with top surface over each shoulder.
            side = Vector((center.x*.62, .85*max(0.0, center.y+.22), center.z+.028))
            outside = (side - along * along.dot(side)).normalized()
            across = along.cross(outside).normalized()
            progress = row/(rings-1)
            shoulder = math.exp(-((center.y+.107)/.064)**2)
            width = .0215 * (1-.11*math.cos(2*math.pi*progress)) * (1-.22*shoulder)
            center += Vector((math.copysign(.006*shoulder, center.x), -.015*shoulder, 0))
            frames.append((center+outside*(.0058-.013*shoulder), across, outside, width))
        count = 13
        base = len(output["POSITION"])
        for row, (center, across, outside, width) in enumerate(frames):
            source_index = groups[row][0]
            u = attrs["TEXCOORD_0"][source_index][0]
            for column in range(count):
                phase = column*math.tau/(count-1)
                # Flatten the leather's top and bottom while beveling the edges.
                x = math.cos(phase)
                y = math.sin(phase)
                x = math.copysign(abs(x)**.45, x)
                y = math.copysign(abs(y)**.54, y)
                normal = (x*.46*across + y*outside).normalized()
                color = (.69,.56,.43) if abs(x)>.93 else (.93,.87,.76)
                vertex(source_index, center+across*(width*x)+outside*(.0044*y),
                       normal, [u,.835+.079*column/(count-1)], color)
        for row in range(rings - 1):
            for i in range(count - 1):
                a = base+row*count+i
                quad(a,a+1,a+count+1,a+count)
        output["pieces"].append({**strap,"name":"Folded bandolier leather","start":base,
                                 "count":len(output["POSITION"])-base,"sourceStyleIndex":first})

        for edge in (-1,1):
            base = len(output["POSITION"])
            for row in range(2,rings-2):
                origin, across, normal, width = frames[row]
                other, next_across, next_normal, next_width = frames[row+1]
                for phase in (.17,.64):
                    f = origin.lerp(other,phase)
                    x = across.lerp(next_across,phase).normalized()
                    n = normal.lerp(next_normal,phase).normalized()
                    p = f+x*(width*(1-phase)+next_width*phase-.0044)*edge+n*.0046
                    for sign in (-1,1):
                        v=groups[row][1]
                        vertex(v,p+x*(.00103*sign),n,attrs["TEXCOORD_0"][v][:],(1.60,1.28,.94),.90)
                a=len(output["POSITION"])-4
                quad(a,a+1,a+3,a+2)
            output["pieces"].append({**strap,"name":"Saddle-stitched leather edge","start":base,
                                     "count":len(output["POSITION"])-base,"sourceStyleIndex":first})
    return output, {
        "replaceRanges":leather, "removeTriangles":[],
        "sourceInputs":[{"path":str(p.relative_to(common.ROOT)),"sha256":hashlib.sha256(p.read_bytes()).hexdigest()}
                        for p in (path,library,library.with_name("coat-collars-authoring.py"),library.with_name("coat-sleeves-authoring.py"))],
        "bandolierFit":{"straps":2,"retainsMetal":True,"stitchRuns":4},
    }


if __name__ == "__main__":
    common.run(fit, os.environ.get("OUT_WEST_GARMENT_OUTPUT", "shirt-fronts"))
