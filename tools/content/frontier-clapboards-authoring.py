"""Draw period timber siding profiles with an overlapping weather lip."""
import sys
from pathlib import Path

root, output = map(Path, sys.argv[sys.argv.index("--")+1:])
shared = root / "tools/content/frontier-furniture-authoring.py"
sys.argv=[str(shared),"--",str(output)]
lib={"__name__":"frontier_furniture"}
exec(compile(shared.read_text().split('begin("saloon-card-table")')[0],str(shared),"exec"),lib)
bpy=lib["bpy"]
finish=lib["finish"]
geometry=lib["mesh"]
mat=finish("Planed siding",(.83,.76,.65),.75)

sections = [
    ("planed-lap-board", (.000, .001, -.001, .000)),
    ("cup-sawn-lap-board", (.001, -.002, .003, .001)),
    ("weathered-lap-board", (-.001, .003, .002, -.001)),
]
for name, warp in sections:
    section=[(-.003,0),(.014,0),(.024,.027),(.021,.075),(.009,.94),(.007,1),(-.003,1)]
    offsets=(-.5,-.34,.18,.5)
    positions= [(x,-(depth+deform if depth>0 else depth),y) for x,deform in zip(offsets,warp) for depth,y in section]
    n=len(section)
    faces=[tuple(range(n)),tuple(reversed(range(n*3,n*4)))]
    for i in range(3):
        for j in range(n):
            a=i*n+j
            b=i*n+(j+1)%n
            faces.append((a,a+n,b+n,b))
    geometry(name,positions,faces,mat,grain_axis=0)

output.parent.mkdir(parents=True,exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(output),export_format="GLB",export_yup=True)
