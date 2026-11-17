"""Author a closed, soft cloth band on the actual accepted cervical surface."""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
import bpy
from mathutils import Vector
from mathutils.geometry import convex_hull_2d

spec = importlib.util.spec_from_file_location("garment_portable", Path(__file__).with_name("coat-collars-authoring.py"))
portable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portable)
common = portable.common


def fitted_band(source, body, donor, skin_source, skin_body):
    attrs = body["attrs"]
    bands = [r for r in body["ranges"] if r.get("swatch") == "linen" and not r.get("name") and not r.get("slot") and r["count"] == 72]
    if not bands:
        return None
    if len(bands) != 1:
        raise ValueError("Ambiguous neckerchief band")
    band = bands[0]
    head = next(r for r in skin_body["ranges"] if r.get("slot") == "skin")
    if body["jointNames"] != skin_body["jointNames"]: raise ValueError("Donor rig order differs")
    skin_attrs = skin_body["attrs"]
    triangles = [skin_body["indices"][k:k + 3] for k in range(0, len(skin_body["indices"]), 3) if all(head["start"] <= i < head["start"] + head["count"] for i in skin_body["indices"][k:k+3])]
    positions, uvs, joints, weights = [], [], [], []
    for index in range(band["start"], band["start"] + band["count"]):
        original = Vector(attrs["POSITION"][index])
        intersections = []
        for face in triangles:
            points = []
            for k in range(3):
                a, b = face[k], face[(k+1)%3]
                pa, pb = Vector(donor[a]), Vector(donor[b])
                if (pa.y <= original.y < pb.y) or (pb.y <= original.y < pa.y):
                    t = (original.y-pa.y)/(pb.y-pa.y)
                    points.append((pa.lerp(pb, t), {a:1-t,b:t}))
            if len(points) == 2: intersections.append(points)
        if not intersections:
            raise ValueError("Missing cervical section")
        # Source outfits remove hidden skin faces. Blender's section hull closes
        # those donor-only gaps without adding or changing any skin geometry.
        section = [entry for segment in intersections for entry in segment]
        hull = convex_hull_2d([Vector((p.x,p.z)) for p,_ in section])
        intersections = [[section[hull[k]],section[hull[(k+1)%len(hull)]]] for k in range(len(hull))]
        points = [point for segment in intersections for point, _ in segment]
        center = Vector(((min(p.x for p in points)+max(p.x for p in points))/2, original.y, (min(p.z for p in points)+max(p.z for p in points))/2))
        direction = (original-center).normalized()
        hits = []
        for (a, aw), (b, bw) in intersections:
            edge = b-a
            determinant = direction.x*edge.z-direction.z*edge.x
            if abs(determinant)<1e-10: continue
            delta = a-center
            distance = (delta.x*edge.z-delta.z*edge.x)/determinant
            t = (delta.x*direction.z-delta.z*direction.x)/determinant
            if distance>0 and -1e-6<=t<=1+1e-6:
                blend = {i:aw.get(i,0)*(1-t)+bw.get(i,0)*t for i in aw.keys()|bw.keys()}
                hits.append((distance,blend))
        if not hits: raise ValueError(f"Missing radial neck surface {source.path.stem}/{index} point={list(original)} center={list(center)} section={len(intersections)}")
        distance, blend = max(hits, key=lambda h:h[0])
        # Four millimetres of cloth/air clearance; no flared top lip. A small
        # folded irregularity reads as fabric while remaining inside that fit.
        row = (index-band["start"])//18
        clearance = [0.0045,0.004,0.0045,0.005][row]
        point = center+direction*(distance+clearance)
        # Keep the sewn front/bib attachment exact; only the rear and side
        # circumference is refitted. Smooth angular blending avoids a new hinge.
        front = min(1,max(0,(direction.z-0.35)/0.4))
        front = front*front*(3-2*front)
        point = point.lerp(original,front)
        influences = {}
        for vertex, amount in blend.items():
            for joint, weight in zip(skin_attrs["JOINTS_0"][vertex], skin_attrs["WEIGHTS_0"][vertex]):
                influences[int(joint)] = influences.get(int(joint),0)+amount*weight*(1-front)
        # The fixed front edge joins the original bib, so its skinning must
        # follow the same angular blend as its positions.
        for joint, weight in zip(attrs["JOINTS_0"][index], attrs["WEIGHTS_0"][index]):
            influences[int(joint)] = influences.get(int(joint),0)+weight*front
        influence = sorted(influences.items(),key=lambda pair:-pair[1])[:4]
        total = sum(w for _,w in influence)
        positions.append(list(point));uvs.append(attrs["TEXCOORD_0"][index])
        joints.append([influence[k][0] if k<len(influence) else 0 for k in range(4)])
        weights.append([influence[k][1]/total if k<len(influence) else 0 for k in range(4)])
    faces = [[i-band["start"] for i in body["indices"][k:k+3]] for k in range(0,len(body["indices"]),3) if all(band["start"]<=i<band["start"]+band["count"] for i in body["indices"][k:k+3])]
    obj = common.author_mesh("Fitted linen neckerchief",positions,faces,uvs,joints,weights)
    source_vertex=obj.data.attributes.new(name="source_vertex",type="INT",domain="POINT")
    for i in range(band["count"]): source_vertex.data[i].value=band["start"]+i
    bpy.context.view_layer.objects.active=obj
    fold=obj.modifiers.new("Folded linen thickness", "SOLIDIFY")
    fold.thickness=0.0015;fold.offset=-1;fold.use_rim=True
    bpy.ops.object.modifier_apply(modifier=fold.name)
    output=common.output_arrays()
    obj.data.calc_loop_triangles()
    source_corners=[obj.data.attributes["source_vertex"].data[obj.data.loops[loop].vertex_index].value for tri in obj.data.loop_triangles for loop in tri.loops]
    for semantic in ("COLOR_0","_DYE","_STYLE_LUMINANCE","_STYLE_MATERIAL"):
        if semantic in attrs: output["_AUTHOR_"+semantic.lstrip("_")]=[attrs[semantic][i][:] for i in source_corners]
    # Leave this piece semantically un-slotted so dyeable equipment keeps the
    # existing Neckerchief material and its equipment visibility controls.
    common.extract(obj,output,{"swatch":"linen","sourceStyleIndex":band["start"]})
    inputs=[skin_source.path,*(skin_source.path.parent/b["uri"] for b in skin_source.doc["buffers"]),source.path,*(source.path.parent/b["uri"] for b in source.doc["buffers"]),Path(__file__),Path(__file__).with_suffix('.ts'),Path(__file__).with_name('coat-sleeves-authoring.py'),Path(__file__).with_name('coat-collars-authoring.py'),Path(__file__).with_name('head-nape.ts'),common.SOURCES/'head-nape/lattice.json']
    return output,{"replaceRanges":[band],"preserveRangeOrder":True,"removeTriangles":[],"sourceInputs":[{"path":str(p.relative_to(common.ROOT)),"sha256":hashlib.sha256(p.read_bytes()).hexdigest()}for p in inputs],"neckerchiefFit":{"sourceBand":band,"clearanceMM":[4.5,4,4.5,5],"thicknessMM":1.5,"method":"Accepted bind skin triangle sections; radial fit, barycentric native skin weights; Blender Solidify closed cloth thickness"}}

if __name__=='__main__':
    donors=json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text())
    for id,donor in donors.items():
        source=common.Source(common.SOURCES/(id+'.gltf'))
        for body in source.bodies():
            skin_source=common.Source(common.SOURCES/(donor["source"]+".gltf"))
            skin_body=next(skin_source.bodies())
            result=fitted_band(source,body,donor["positions"],skin_source,skin_body)
            if result is None:continue
            arrays,metadata=result
            extras={"jointNames":body['jointNames'],"sourceId":id,"sourceSHA256":source.digest(),"sourcePrimitive":body['sourcePrimitive'],**metadata}
            common.write_glb(common.SOURCES/'neckerchiefs'/(id+'.glb'),arrays,extras)
            print('NECKERCHIEF',id,len(arrays['indices'])//3)
