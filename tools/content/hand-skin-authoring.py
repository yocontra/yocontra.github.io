"""Subdivide and sculpt the fitted hand skin without crossing finger or garment joints."""

import importlib.util
import math
import sys
from pathlib import Path

from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

output_root = Path(sys.argv[sys.argv.index("--")+1])
assets = sys.argv[sys.argv.index("--")+2:]
sys.dont_write_bytecode = True
project = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("portable", project / "tools/content/coat-collars-authoring.py")
portable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portable)
digits = ("Thumb", "Index", "Middle", "Ring", "Pinky")
uv_box = ((0.08292034602165223, 0.2458810623884201), (0.6599249873161316, 0.783837851524353))


def hand_joints(source, body):
    node = source.doc["nodes"][body["sourcePrimitive"]["nodeIndex"]]
    skin = source.doc["skins"][node["skin"]]
    bind = source.accessor(skin["inverseBindMatrices"])
    landmarks = {}
    for name, values in zip(body["jointNames"], bind):
        if name.startswith(("Wrist", *digits)):
            inverse = Matrix([[values[column * 4 + row] for column in range(4)] for row in range(4)])
            landmarks[name] = inverse.inverted().translation
    return landmarks



def palm(landmarks, side):
    start = landmarks["Wrist" + side]
    center = landmarks["Middle1"+side]
    along = (center-start).normalized()
    across = (landmarks["Pinky1"+side]-landmarks["Index1"+side]).normalized()
    dorsal = along.cross(across).normalized()
    if dorsal.dot(landmarks["Middle2"+side]-center)>0:
        dorsal = -dorsal
    return start,along,across,dorsal


def thin_fingernails(output, names, palms, landmarks):
    """Project thin nail plates onto distal weighted skin, including curved corners."""
    positions = [Vector(point) for point in output["POSITION"]]
    indices = output["indices"]
    triangles = [tuple(indices[i:i+3]) for i in range(0, len(indices), 3)]
    bins = {}
    for i, joints in enumerate(output["_AUTHOR_JOINTS"]):
        joint = names[joints[0]]
        if joint.endswith(("3L", "3R")) and joint.startswith(digits):
            bins.setdefault(joint, []).append(i)

    for joint, selected in sorted(bins.items()):
        side = joint[-1]
        tip = landmarks[joint]
        distal = sum((positions[i]-tip for i in selected), Vector()) / len(selected)
        along = distal.normalized()
        _,_,palm_width,palm_back = palms[side]
        outward = along.cross(palm_width).normalized()
        if outward.dot(palm_back) < 0:
            outward = -outward
        across = outward.cross(along).normalized()
        points = [(positions[v]-tip).dot(across) for v in selected]
        center = (min(points)+max(points))*.5
        half_width = min(.0056, (max(points)-min(points))*.29)
        reach = max((positions[i]-tip).dot(along) for i in selected)
        if half_width < .001 or reach < .008:
            continue
        selected_set = set(selected)
        surface = [tri for tri in triangles if any(v in selected_set for v in tri)]
        mesh = BVHTree.FromPolygons(positions, surface, all_triangles=True)
        rings, columns = 5, 9
        patch = []
        for row in range(rings):
            progress = row/(rings-1)
            extent = .70 + .30 * math.sin(math.pi * progress)
            longitudinal = reach - .0038 - .0088 * (1 - progress)
            for column in range(columns):
                width = (2 * column/(columns-1)-1)*half_width*extent
                origin = tip + along*(longitudinal-.0016*(width/half_width)**2) + across*(center+width)
                point, normal, face_index, _ = mesh.ray_cast(origin+outward*.044,-outward,.085)
                if point is None or normal is None or normal.dot(outward) < .38:
                    patch = []
                    break
                tri = surface[face_index]
                skin = min(tri, key=lambda i:(positions[i]-point).length_squared)
                patch.append((skin, point + normal * (.00035 + .00036*math.sin(math.pi*progress)), normal, progress))
            if not patch:
                break
        if len(patch) != rings*columns:
            continue

        first = len(output["POSITION"])
        for skin, point, normal, progress in patch:
            output["POSITION"].append(list(point))
            output["NORMAL"].append(list(normal))
            for field, stream in output.items():
                if field in ("POSITION","NORMAL","indices","pieces"):
                    continue
                values = stream[skin][:]
                if field == "_AUTHOR_COLOR_0":
                    edge = progress ** 4
                    pale = (1.22+.13*edge, 1.37+.16*edge, 1.45+.16*edge)
                    values = [min(1,x*pale[i]) if i < 3 else x for i,x in enumerate(values)]
                if field == "_AUTHOR_STYLE_MATERIAL":
                    values[0] *= .77
                stream.append(values)
        for row in range(rings-1):
            for column in range(columns-1):
                i = first+row*columns+column
                a,b,c = (Vector(output["POSITION"][k]) for k in (i,i+1,i+columns))
                if (b-a).cross(c-a).dot(Vector(output["NORMAL"][i])) >= 0:
                    indices.extend((i,i+1,i+columns, i+1,i+columns+1,i+columns))
                else:
                    indices.extend((i,i+columns,i+1, i+1,i+columns,i+columns+1))
        print(joint, len(patch), "fitted nail vertices")

def fit(source, body):
    landmarks = hand_joints(source, body)
    attrs,names = body["attrs"],body["jointNames"]
    skin = next(piece for piece in body["ranges"] if piece.get("name")=="Skin" and piece["start"]>0)
    start,end = skin["start"],skin["start"]+skin["count"]
    output = portable.common.output_arrays()
    streams = {f"_AUTHOR_{key.lstrip('_')}": key for key in ("COLOR_0","_DYE","_STYLE_LUMINANCE","_STYLE_MATERIAL") if key in attrs}
    for field in streams:
        output[field]=[]
    seen={}
    asset = source.path.stem
    palms = {side:palm(landmarks, side) for side in "LR"}

    def fit_vertex(a,b):
        key = tuple(sorted((a,b)))
        if key in seen:
            return seen[key]
        point = (Vector(attrs["POSITION"][a])+Vector(attrs["POSITION"][b]))*.5
        normal = (Vector(attrs["NORMAL"][a])+Vector(attrs["NORMAL"][b])).normalized()
        weight_by_joint={}
        for i in (a,b):
            for j,w in zip(attrs["JOINTS_0"][i],attrs["WEIGHTS_0"][i]):
                weight_by_joint[j]=weight_by_joint.get(j,0)+w*.5
        best=sorted(weight_by_joint.items(),key=lambda item:(-item[1],item[0]))[:4]
        total=sum(w for _,w in best)
        joint=names[best[0][0]]
        redness, dry, white, tendon, crease=0,0,0,0,0
        if joint in landmarks and joint[-1] in palms:
            side=joint[-1]
            origin,along,across,dorsal=palms[side]
            rel=point-origin
            width=rel.dot(across)
            down=rel.dot(along)
            front=max(0,normal.dot(dorsal))
            over_bone=max(math.exp(-((width-shift+.009*math.sin(down*14))/.0055)**2)
                          for shift in (-.019, 0.0, .016))
            tendon=front**2*over_bone*math.exp(-((down-.052)/.032)**2)
            dry=max(0,-normal.dot(dorsal))*math.exp(-((down-.046)/.057)**2)
            if joint.startswith(digits):
                distance=(point-landmarks[joint]).length
                redness=front*math.exp(-((distance-.0075)/.013)**2)
                crease=front*math.exp(-((distance-.010)/.004)**2)
                if joint[-2]=="3":
                    axis=(landmarks[joint]-landmarks[joint[:-2]+"2"+side]).normalized()
                    polish=normal.dot(axis.cross(across).normalized())
                    tip=(point-landmarks[joint]).dot(axis)
                    white=max(0,abs(polish)-.35)*math.exp(-((tip-.011)/.0058)**2)
            if a!=b:
                # Preserve the existing palm, fingertip and all grip contact anchors.
                chord=Vector(attrs["POSITION"][a])-Vector(attrs["POSITION"][b])
                point+=normal*min(.0012,chord.length*.095)*(0.75*tendon+.3*redness-.22*crease)
        index=len(output["POSITION"])
        output["POSITION"].append(list(point))
        output["NORMAL"].append(list(normal))
        uv = [(u+v)*.5 for u,v in zip(attrs["TEXCOORD_0"][a],attrs["TEXCOORD_0"][b])]
        output["TEXCOORD_0"].append([(value-low)/(high-low) for value,(low,high) in zip(uv,uv_box)])
        output["_AUTHOR_JOINTS"].append([j for j,_ in best]+[0]*(4-len(best)))
        output["_AUTHOR_WEIGHTS"].append([w/total for _,w in best]+[0]*(4-len(best)))
        for field,key_stream in streams.items():
            average=[(u+v)*.5 for u,v in zip(attrs[key_stream][a],attrs[key_stream][b])]
            if key_stream=="COLOR_0":
                r,g,blue=average[:3]
                warm=[1+.105*redness+.08*white,1-.085*redness+.14*white+.036*dry,1-.088*redness+.16*white+.026*tendon]
                for k,value in enumerate((r,g,blue)):
                    average[k]=min(1,value*warm[k]*(1-.026*crease))
            if key_stream=="_STYLE_MATERIAL":
                average[0]*=1.07-.16*white
            output[field].append(average)
        seen[key]=index
        return index

    triangles=body["indices"]
    for i in range(0,len(triangles),3):
        a,b,c=triangles[i:i+3]
        if not all(start<=v<end for v in (a,b,c)):
            continue
        a0,b0,c0=fit_vertex(a,a),fit_vertex(b,b),fit_vertex(c,c)
        ab,bc,ca=fit_vertex(a,b),fit_vertex(b,c),fit_vertex(c,a)
        output["indices"].extend((a0,ab,ca,ab,b0,bc,ca,bc,c0,ab,bc,ca))
    thin_fingernails(output, names, palms, landmarks)
    output["pieces"]=[{**skin,"name":"Hands","start":0,"count":len(output["POSITION"]),"sourceStyleIndex":start,"surface":"field-hands"}]
    metadata={
        "jointNames":names,"sourceId":asset,"sourceSHA256":source.digest(),
        "sourcePrimitive":body["sourcePrimitive"],"replaceRanges":[{"start":start,"count":end-start}],
        "removeTriangles":[],"authoring":"Subdivided and sculpted native hand skin",
    }
    portable.write_style_surface(output_root / f"{asset}.glb",output,metadata)
    print(asset,len(seen),len(output["indices"])//3)


output_root.mkdir(parents=True, exist_ok=True)
for asset in assets:
    source = portable.common.Source(project / "tools/art/characters" / f"{asset}.gltf")
    for body in source.bodies():
        fit(source, body)
