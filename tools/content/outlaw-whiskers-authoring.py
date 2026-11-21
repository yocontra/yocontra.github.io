"""Groom a short swept beard over the new face in its canonical bind pose."""
import math
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector

input_path, output_path, role = sys.argv[sys.argv.index("--")+1:]
source, output = Path(input_path), Path(output_path)
names = {"2":"Calhoun auburn whiskers", "6":"Salvador's dark whiskers", "15":"Curly Bill's thick whiskers"}
stubble_tone = {
    "2": (.29,.142,.063,1),
    "6": (.13,.075,.041,1),
    "15": (.098,.057,.034,1),
}
profile = {
    "2": (0.000,0.000,1.00,0),
    "6": (.009,-.004,.83,.14),
    "15": (-.011,.006,1.21,.65),
}
rise,width_adjust,length_scale,curl=profile[role]
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for old in list(bpy.data.materials):
    if old.users == 0:
        bpy.data.materials.remove(old)
bpy.ops.import_scene.gltf(filepath=str(source))
head=next(o for o in bpy.context.scene.objects if o.type=="MESH")
head.data.calc_loop_triangles()

def moustache_profile(point):
    x,back,y=point
    width=abs(x+(.021 if role=="6" else .027))
    front=-back
    if role=="6":
        turn=min(1,width/.052)
        rise=1.534-.007*math.sin(math.pi*turn)+.013*turn**3
        return min(.054-width,.0075*(1-.50*turn)-abs(y-rise),front-.098)
    return min(.041-width,y-(1.529+width*.08),(1.545-width*.13)-y,front-.104)


def coverage(point):
    x,back,y=point
    width=abs(x+.027)
    front=-back
    chin=1.463+.47*width+rise
    side=max(0,min(1,(.101-front)/.071))
    cheek=1.520+.039*side**1.38+width_adjust
    cheek+=.016*max(0,min(1,(width-.047)/.024))
    front_limit=.025+.018*math.exp(-((y-1.535)/.028)**2)+max(0,.032-width)*.25
    lips=max(width-.020,1.508-y,y-1.530)
    beard=min(y-chin,cheek-y,.082-width,front-front_limit,lips)
    return max(beard,moustache_profile(point))


def thickness(point):
    x,back,y=point
    cheek=math.exp(-((y-1.495)/.035)**2)
    groom=.0017+.0016*cheek
    edge=max(0,min(1,coverage(point)/.009))
    return (.00058+edge*groom)*(.88+.12*math.sin(x*379+y*197))


def clip_border(corners, region=coverage):
    result=[]
    for i,(point,normal) in enumerate(corners):
        end,end_normal=corners[(i+1)%len(corners)]
        start_value,end_value=region(point),region(end)
        if start_value>=0:
            result.append((point,normal))
        if (start_value>=0)!=(end_value>=0):
            weight=start_value/(start_value-end_value)
            result.append((point.lerp(end,weight),normal.lerp(end_normal,weight).normalized()))
    return result


points=[]
polys=[]
faces=[]
shades=[]
rng=random.Random(77419 if role=="2" else 77419+int(role)*199)
tumble=Vector((0,-.015,-.99))

for tri in head.data.loop_triangles:
    corners=[(head.data.vertices[k].co.copy(),head.data.vertices[k].normal.copy()) for k in tri.vertices]
    if role=="6":
        whisker=clip_border(corners,moustache_profile)
        if len(whisker)>=3:
            index=len(points)
            for p,n in whisker:
                points.append(p+n*.0014)
                shade=.44+.1*rng.random()
                shades.append((shade,1))
            polys.append(tuple(range(index,index+len(whisker))))
    rim=clip_border(corners)
    if len(rim)<3:
        continue
    for i in range(1,len(rim)-1):
        a,b,c=rim[0],rim[i],rim[i+1]
        area=(b[0]-a[0]).cross(c[0]-a[0]).length*.5
        faces.append((a,b,c,area))

for a,b,c,area in faces:
    for _ in range(max(1,int(area*220000))):
        u,v=rng.random(),rng.random()
        if u+v>1:
            u,v=1-u,1-v
        w=1-u-v
        p=a[0]*u+b[0]*v+c[0]*w
        n=(a[1]*u+b[1]*v+c[1]*w).normalized()
        zone=coverage(p)
        if zone<0 or rng.random()>.32+min(.68,max(0,zone)*92):
            continue
        start=p+n*(thickness(a[0])*u+thickness(b[0])*v+thickness(c[0])*w-.00032)
        length=length_scale*rng.uniform(.0035,.0105)
        flow=(tumble-n*tumble.dot(n)).normalized()
        flow=(flow+curl*math.sin(p.z*1227+p.x*410.4)*n.cross(flow)).normalized()
        side=n.cross(flow).normalized()*rng.uniform(.00022,.00057)
        first=len(points)
        points.extend([start-side,start+side,
                       start+flow*length*.55-side*.62+n*.0011,
                       start+flow*length*.55+side*.62+n*.0011,
                       start+flow*length+n*.00070])
        shade=rng.uniform(.60,.96)
        shades.extend([(shade*.73,.82),(shade*.77,.85),(shade,1),(shade,1),(shade*.87,.61)])
        polys.extend([(first,first+1,first+3,first+2),(first+2,first+3,first+4)])

mesh=bpy.data.meshes.new("Hand-groomed cheek, chin and moustache")
mesh.from_pydata(points,[],polys)
mesh.update()
hairs=bpy.data.objects.new(names[role],mesh)
bpy.context.collection.objects.link(hairs)
material=bpy.data.materials.new(names[role])
material.use_nodes=True
surface=material.node_tree.nodes["Principled BSDF"]
surface.inputs["Base Color"].default_value=stubble_tone[role]
surface.inputs["Roughness"].default_value=.80
surface.inputs["Metallic"].default_value=0
mesh.materials.append(material)
colors=mesh.color_attributes.new(name="Sun-faded strands",type="FLOAT_COLOR",domain="POINT")
for i,(shade,alpha) in enumerate(shades):
    colors.data[i].color=(shade,shade*.86,shade*.78,1)

uv=mesh.uv_layers.new(name="Beard")
for loop in mesh.loops:
    p=mesh.vertices[loop.vertex_index].co
    uv.data[loop.index].uv=(max(0,min(1,(p.x+.13)*5)), max(0,min(1,(p.z-1.42)*5)))
for poly in mesh.polygons:
    poly.use_smooth=True

stubble=head.data.color_attributes.active_color
if stubble is not None and stubble.domain=='POINT':
    for vertex in head.data.vertices:
        field=coverage(vertex.co)
        if field<=0:
            continue
        strength=min(.34,field*42)
        paint=stubble.data[vertex.index]
        r,g,b,a=paint.color
        paint.color=(r*(1-strength),g*(1-strength*.91),b*(1-strength*.72),a)

print("Beard:",len(faces),"facial panels;",len(polys),"fine strand faces")
output.parent.mkdir(parents=True,exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(output),export_format="GLB",export_yup=True,
                         export_vertex_color="ACTIVE")
