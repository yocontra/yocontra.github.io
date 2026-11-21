"""Cast a hollow bronze bell around the shipped clock's yoke and clapper."""

import math
import sys
from pathlib import Path

import bpy


def main():
    output = Path(sys.argv[sys.argv.index("--") + 1])
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    # The yoke, pin and moving clapper stay with the existing clock skin.
    profile = [
        (15.730, 0.592), (15.752, 0.627), (15.795, 0.630), (15.825, 0.596),
        (15.882, 0.548), (15.901, 0.553), (15.927, 0.536), (15.947, 0.508),
        (16.040, 0.472), (16.177, 0.418), (16.323, 0.378), (16.449, 0.337),
        (16.503, 0.320), (16.534, 0.328), (16.557, 0.314), (16.579, 0.298),
        (16.623, 0.262), (16.653, 0.207), (16.689, 0.127), (16.750, 0.112),
        (16.750, 0.063), (16.673, 0.073), (16.623, 0.144), (16.570, 0.218),
        (16.500, 0.269), (16.387, 0.305), (16.257, 0.338), (16.114, 0.387),
        (15.990, 0.433), (15.872, 0.480), (15.787, 0.528), (15.730, 0.551),
    ]
    segments = 48
    vertices = [
        (radius * math.cos(angle), -63.5 + radius * math.sin(angle), height)
        for height, radius in profile
        for angle in (side * math.tau / segments for side in range(segments))
    ]
    faces = [
        (r * segments + side, r * segments + (side + 1) % segments,
         ((r + 1) % len(profile)) * segments + (side + 1) % segments,
         ((r + 1) % len(profile)) * segments + side)
        for r in range(len(profile)) for side in range(segments)
    ]
    mesh = bpy.data.meshes.new("Cast bronze bell")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    mesh.shade_smooth()
    uv = mesh.uv_layers.new(name="Casting finish")
    for index, polygon in enumerate(mesh.polygons):
        row, side = divmod(index, segments)
        for corner, loop in enumerate(polygon.loop_indices):
            u = (side + (corner in (1, 2))) / segments
            v = (row + (corner in (2, 3))) / len(profile)
            uv.data[loop].uv = (u, v)
    obj = bpy.data.objects.new("Cast bronze bell", mesh)
    bpy.context.collection.objects.link(obj)
    bpy.ops.export_scene.gltf(filepath=str(output), export_format="GLB", export_yup=True, export_tangents=True)


if __name__ == "__main__":
    main()
