"""Model the profiles of split-oak fencing and forged iron grilles."""
import sys
from pathlib import Path

root, output = map(Path, sys.argv[sys.argv.index("--") + 1 :])
shared = root / "tools/content/frontier-furniture-authoring.py"
sys.argv = [str(shared), "--", str(output)]
library = {"__name__": "frontier_furniture"}
exec(compile(shared.read_text().split('begin("saloon-card-table")')[0], str(shared), "exec"), library)
bpy = library["bpy"]
activate = library["begin"]
pack = library["pack"]
finish = library["finish"]
box = library["box"]
mesh = library["mesh"]

oak = finish("Frontier fences split oak", (.56, .40, .255), .77)
worn = finish("Frontier fences freshly split oak", (.62, .46, .29), .82)
iron = finish("Frontier fences cold-forged iron", (.22, .21, .19), .64, .62)
rivet = finish("Frontier fences black iron pegs", (.09, .076, .062), .55, .52)


def sections(name, rows, mat, orient, axis):
    vertices = []
    for along, w, h, shift in rows:
        clip = min(w, h)*.14
        corners = [(-w+clip,-h),(w-clip,-h),(w,-h+clip),(w,h-clip),
                   (w-clip,h),(-w+clip,h),(-w,h-clip),(-w,-h+clip)]
        vertices.extend(orient(along, u, v+shift) for u, v in corners)
    faces = [tuple(reversed(range(8)))]
    for start in range(0, len(vertices)-8, 8):
        faces.extend((start+i,start+(i+1)%8,start+(i+1)%8+8,start+i+8) for i in range(8))
    faces.append(tuple(range(len(vertices)-8,len(vertices))))
    return mesh(name,vertices,faces,mat,grain_axis=axis)


def up(y,x,z):
    return x,z,y


def along(x,y,z):
    return x,y,z


def post():
    activate("split-oak-post")
    sections("Drawknifed upright with sloped crown",
             [(0,.041,.039,0),(.19,.044,.038,-.003),(.39,.045,.042,0),
              (.66,.044,.041,.002),(.91,.043,.043,0),(.972,.043,.042,-.001),
              (1,.027,.031,0)], oak, up, 2)
    for y in (.402,.862):
        for facing in (-1,1):
            box("Square cut nail at mortise",.002,.042*facing,y,(.020,.006,.019),rivet,.001,grain_axis=2)
    sections("End grain on the crown", [(.991,.026,.030,0),(1,.019,.024,0)],worn,up,2)


def rail():
    activate("split-oak-rail")
    # The two flat sides hold sign boards and their fasteners at both fixing rows.
    rows = [(-.5,.045,.040,0),(-.412,.045,.044,.001),(-.22,.045,.043,.002),
            (.05,.045,.043,-.001),(.23,.045,.043,0),(.41,.045,.040,.003),
            (.5,.045,.041,.003)]
    sections("Split face with worn edges", rows, oak, along, 0)



def grille_upright():
    activate("riveted-grille-upright")
    sections("Square forged vertical with tapered head",
             [(0,.042,.042,0),(.05,.036,.036,0),(.14,.035,.035,0),
              (.87,.036,.036,0),(.94,.044,.044,0),(.975,.036,.036,0),
              (1,.007,.007,0)], iron, up, 2)
    for z in (.4,.84):
        for facing in (-1,1):
            box("Hammered collar plate",0,.037*facing,z,(.072,.017,.028),iron,.001,grain_axis=2)
            box("Upset rivet",0,.043*facing,z+.008,(.022,.004,.013),rivet,.002,grain_axis=2)


def grille_rail():
    activate("riveted-grille-rail")
    sections("Cold rolled grille crossbar",
             [(-.5,.041,.040,0),(-.47,.045,.045,0),(.47,.045,.045,0),(.5,.041,.04,0)],
             iron, along, 0)


for form in (post,rail,grille_upright,grille_rail):
    form()
    pack()
output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(output),export_format="GLB",export_yup=True)
