"""Build housed cooperage racks with curved oak staves and rolled iron hoops."""
import math
import sys
from pathlib import Path

root, output = map(Path, sys.argv[sys.argv.index("--")+1:])
shared = root / "tools/content/frontier-furniture-authoring.py"
sys.argv = [str(shared), "--", str(output)]
lib = {"__name__": "frontier_furniture"}
exec(compile(shared.read_text().split('begin("saloon-card-table")')[0], str(shared), "exec"), lib)
bpy = lib["bpy"]
begin, pack, box, mesh, finish = (lib[symbol] for symbol in ("begin","pack","box","mesh","finish"))

staves = [
    finish("Cooperage pale oak", (.82,.66,.43), .72),
    finish("Cooperage brown oak", (.67,.45,.26), .78),
    finish("Cooperage red oak", (.69,.52,.41), .74),
]
endgrain = finish("Cooperage oak end grain", (.82,.62,.44), .68)
frame = finish("Cooperage scrubbed oak rack", (.76,.58,.38), .84)
hoops = finish("Cooperage oxidized iron", (.47,.40,.33), .63, .62)
nails = finish("Cooperage iron rivets", (.14,.13,.12), .49, .65)


def curve(rows, angles, x, bottom, mat, label, sealed=False):
    vertices = [(x+r*math.cos(a), y, bottom+r*math.sin(a))
                for y,r in rows for a in angles]
    width = len(angles)
    right = range(width) if sealed else range(width-1)
    faces = []
    for row in range(len(rows)-1):
        for i in right:
            start = row*width
            n = (i+1)%width
            faces.append((start+i,start+width+i,start+width+n,start+n))
    obj = mesh(label,vertices,faces,mat,smooth=True,grain_axis=1)
    return obj


def barrel(x, centre, radius, length):
    radius_factor = [(.0,.78),(.10,.86),(.28,.965),(.48,1.0),(.63,.991),(.81,.924),(.94,.851),(1.0,.78)]
    rows = [((t-.5)*length,radius*r) for t,r in radius_factor]
    angles = [math.tau*i/64 for i in range(64)]
    for stave in range(24):
        t = math.tau*stave/24
        a = [t+.003,t+math.tau/48,t+math.tau/24-.003]
        curve(rows,a,x,centre,staves[(stave*19+int(x*104))%len(staves)],"Drawn, tapered oak stave")
    for t,r in [(.055,.853),(.242,.962),(.758,.957),(.946,.855)]:
        y = (t-.5)*length
        depth = .037*length
        curve([(y-depth,radius*(r-.024)),(y-depth*.78,radius*r),
               (y+depth*.78,radius*r),(y+depth,radius*(r-.021))],
              angles,x,centre,hoops,"Rolled wrought iron hoop",True)
        for a in (math.pi/6, 5*math.pi/6):
            rivet_x=x+(radius*r)*math.cos(a)
            z=centre+(radius*r)*math.sin(a)
            box("Upset square rivet",rivet_x,y,z,(.018,.018,.014),nails,.002)
    # Closed heads made from fitted planks, with the grain continuing across each board.
    for f in (-1,1):
        y=f*length*.487
        r=.764*radius
        for i in range(7):
            z0=-r+2*r*i/7
            z1=-r+2*r*(i+1)/7
            cuts=[z0+.00045,(z0+z1)/2,z1-.00045]
            silhouette = [(x+direction*math.sqrt(max(0,r*r-z*z)),y,centre+z)
                          for direction,c in [(1,cuts),(-1,cuts[::-1])] for z in c]
            if f>0:
                silhouette.reverse()
            obj=mesh("Adzed end-head plank",silhouette,[tuple(range(6))],endgrain,grain_axis=0)
            obj.data.materials[0].use_backface_culling=False
        box("Fitted timber bung",x+.075,y,centre+.024,(.048,.030,.052),staves[1],.005)


def stand(width, depth, z, layers):
    foot=.12
    for x in (-width*.465,width*.465):
        for y in (-depth*.442,depth*.442):
            box("Chocked upright",x,y,0,(foot,foot,z),frame,.008,grain_axis=2)
    for h in layers:
        for y in (depth*-.4,depth*.4):
            box("Housed cradle beam",0,y,h-.067,(width,.135,.151),frame,.014)
            for x in (-width*.46,width*.46):
                box("Flat peg through mortise",x,y*.99,h,(.020,.186,.030),hoops,.002,grain_axis=1)
        for x in (-width*.31,width*.31):
            box("Cross timber between cradles",x,0,h-.041,(.145,depth,.10),frame,.011,grain_axis=1)


begin("coopered-barrel-rack")
stand(2,1,.61,(.497,))
for x in (-.46,.46):
    barrel(x,.905,.395,.925)
pack()

begin("two-tier-cooperage-rack")
stand(2.5,2,1.69,(.418,1.509))
for y in (-.476,.476):
    for row in (.816,1.907):
        for x in (-.608,.608):
            previous = lib["active"]
            existing = set(previous.children)
            barrel(x,row,.393,.945)
            for obj in set(previous.children) - existing:
                obj.location.y += y
pack()

output.parent.mkdir(parents=True,exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(output),export_format="GLB",export_yup=True)
