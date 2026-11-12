"""Canonical 1880s riding boot: deterministic geometry, UV layout and leather maps.

Frame: metres for the 1.713 m reference body, x lateral (outward), y up from the
tread, z toward the toe, origin on the ground directly below the ankle joint.
The upper is ray-cast from a signed-distance last (fitted shaft unioned with a
narrow lasted foot), so rings stay evenly spaced and the welt line is exact.
Leather maps are painted in that same parameterization; nothing here depends on
Blender beyond numpy, so the authoring script and the map writer agree exactly.
"""

import math
import struct
import zlib

import numpy as np

TEXTURE_SIZE = (512, 1024)
# Vertical UV bands (v grows downward in glTF image space).
V_UPPER = (0.0, 0.655)
V_RIM = (0.662, 0.676)
V_SOLE_EDGE = (0.682, 0.702)
V_HEEL = (0.708, 0.748)
V_BLOCK = (0.756, 0.996)
U_SOLE_BOTTOM = (0.01, 0.21)
U_SOLE_TOP = (0.23, 0.43)
U_STRAP = (0.46, 0.52)

RIM_FRONT = 0.395
RIM_DIP = 0.017
BEND_Y = 0.172
HEEL_HEIGHT = 0.042
SOLE = 0.008
Z_BACK = -0.0745
Z_TIP = 0.211
Z_BREAST = -0.004
RING = 32


def pchip(xs, ys, x):
    xs, ys = np.asarray(xs, float), np.asarray(ys, float)
    h = np.diff(xs)
    d = np.diff(ys) / h
    m = np.zeros_like(ys)
    for k in range(1, len(xs) - 1):
        if d[k - 1] * d[k] > 0:
            w1, w2 = 2 * h[k] + h[k - 1], h[k] + 2 * h[k - 1]
            m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k])
    m[0], m[-1] = d[0], d[-1]
    x = np.clip(np.asarray(x, float), xs[0], xs[-1])
    k = np.clip(np.searchsorted(xs, x) - 1, 0, len(xs) - 2)
    t = (x - xs[k]) / h[k]
    h00, h10, h01, h11 = 2 * t**3 - 3 * t**2 + 1, t**3 - 2 * t**2 + t, -2 * t**3 + 3 * t**2, t**3 - t**2
    return h00 * ys[k] + h10 * h[k] * m[k] + h01 * ys[k + 1] + h11 * h[k] * m[k + 1]


def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, float) - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# Shaft: horizontal superellipse sections (centre z, half width, front, back).
SH_Y = [0.035, 0.07, 0.105, 0.14, 0.175, 0.22, 0.28, 0.34, 0.40, 0.46]
SH_CZ = [-0.008, -0.008, -0.009, -0.012, -0.015, -0.016, -0.015, -0.013, -0.011, -0.010]
SH_A = [0.036, 0.0385, 0.040, 0.0405, 0.0405, 0.0425, 0.0465, 0.0505, 0.0535, 0.0555]
SH_DF = [0.020, 0.024, 0.032, 0.041, 0.042, 0.042, 0.044, 0.047, 0.050, 0.052]
SH_DB = [0.0625, 0.0635, 0.063, 0.056, 0.047, 0.046, 0.050, 0.054, 0.057, 0.059]
# Lasted foot: top view half width, centre offset and upper height over the tread.
FT_Z = [-0.0745, -0.069, -0.058, -0.040, -0.015, 0.015, 0.045, 0.080, 0.110, 0.132, 0.152, 0.170, 0.185, 0.197, 0.205, 0.211]
FT_W = [0.0, 0.020, 0.0295, 0.0335, 0.0335, 0.0315, 0.0345, 0.0410, 0.0455, 0.0465, 0.0445, 0.0385, 0.0300, 0.0205, 0.0115, 0.0]
FT_CX = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0015, 0.0025, 0.0020, 0.0005, -0.0015, -0.0035, -0.0050, -0.0062, -0.0070, -0.0074, -0.0076]
FT_YT = [0.105, 0.110, 0.118, 0.128, 0.138, 0.132, 0.112, 0.090, 0.077, 0.069, 0.062, 0.055, 0.048, 0.042, 0.037, 0.032]


def floor_y(z):
    """Top of the welted sole: level heel seat, steep riding shank, toe spring."""
    z = np.asarray(z, float)
    shank = SOLE + HEEL_HEIGHT * (1 - smoothstep(-0.006, 0.088, z))
    spring = 0.0095 * smoothstep(0.150, Z_TIP, z) ** 1.6
    return shank + spring


def tread_y(z):
    return floor_y(z) - SOLE


def shaft_sdf(p):
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    cz, a = pchip(SH_Y, SH_CZ, y), pchip(SH_Y, SH_A, y)
    dz = z - cz
    depth = np.where(dz > 0, pchip(SH_Y, SH_DF, y), pchip(SH_Y, SH_DB, y))
    q = (np.abs(x / a) ** 2.3 + np.abs(dz / depth) ** 2.3) ** (1 / 2.3)
    return (q - 1) * np.minimum(a, depth)


def foot_sdf(p):
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    w = np.maximum(pchip(FT_Z, FT_W, z), 1e-4)
    cx, yt = pchip(FT_Z, FT_CX, z), pchip(FT_Z, FT_YT, z)
    yb = floor_y(z) - 0.02
    yc, hh = (yt + yb) / 2, (yt - yb) / 2
    dy = y - yc
    n = np.where(dy > 0, 2.35, 5.0)
    q = (np.abs((x - cx) / w) ** n + np.abs(dy / hh) ** n) ** (1 / n)
    d = (q - 1) * np.minimum(w, hh)
    return np.maximum(d, np.maximum(Z_BACK - z, z - Z_TIP))


def last_sdf(p):
    a, b, k = shaft_sdf(p), foot_sdf(p), 0.022
    h = np.maximum(k - np.abs(a - b), 0) / k
    union = np.minimum(a, b) - h * h * k / 4
    return np.maximum(union, floor_y(p[..., 2]) - p[..., 1])


def cast(origins, directions, limit=0.16):
    """First exit of each ray through the last surface, refined by bisection."""
    steps = np.linspace(0, limit, 161)
    points = origins[:, None, :] + directions[:, None, :] * steps[None, :, None]
    inside = last_sdf(points) <= 0
    if not inside[:, 0].all():
        raise ValueError("Boot ring centre lies outside the last")
    first = np.argmax(~inside, axis=1)
    if (first == 0).any():
        raise ValueError("Boot ray did not leave the last")
    lo, hi = steps[first - 1], steps[first]
    for _ in range(24):
        mid = (lo + hi) / 2
        out = last_sdf(origins + directions * mid[:, None]) > 0
        hi, lo = np.where(out, mid, hi), np.where(out, lo, mid)
    return origins + directions * ((lo + hi) / 2)[:, None]


def rim_height(theta):
    return RIM_FRONT - RIM_DIP * np.sin(theta) ** 2 - 0.004 * (np.cos(theta) > 0) * np.cos(theta) ** 2


def stations():
    """Ring planes: horizontal shaft, ankle bend about the instep, vertical foot."""
    rows = []
    for s in np.linspace(0, 1, 10):
        rows.append(("shaft", s))
    radius = BEND_Y - 0.078
    for phi in np.linspace(0, math.pi / 2, 9)[1:]:
        rows.append(("bend", phi, radius))
    cz = float(pchip(SH_Y, SH_CZ, BEND_Y))
    start = cz + radius
    for t in np.linspace(0, 1, 12)[1:]:
        rows.append(("foot", start + (Z_TIP - 0.0035 - start) * t ** 0.9))
    return rows, cz


def ring(row, cz):
    theta = np.linspace(0, 2 * math.pi, 241)[:-1]
    if row[0] == "shaft":
        s = row[1]
        y = rim_height(theta) * (1 - s) + BEND_Y * s
        centre = np.stack([np.zeros_like(y), y, pchip(SH_Y, SH_CZ, y)], 1)
        front, lat = np.array([0, 0, 1.0]), np.array([1.0, 0, 0])
        dirs = -np.cos(theta)[:, None] * front + np.sin(theta)[:, None] * lat
        return centre, dirs, theta
    if row[0] == "bend":
        phi, radius = row[1], row[2]
        c = np.array([0, BEND_Y - radius * math.sin(phi), cz + radius * (1 - math.cos(phi))])
        front = np.array([0, math.sin(phi), math.cos(phi)])
    else:
        z = row[1]
        c = np.array([float(pchip(FT_Z, FT_CX, z)), float((floor_y(z) + pchip(FT_Z, FT_YT, z)) / 2), z])
        front = np.array([0, 1.0, 0])
    lat = np.array([1.0, 0, 0])
    dirs = -np.cos(theta)[:, None] * front + np.sin(theta)[:, None] * lat
    return np.repeat(c[None], len(theta), 0), dirs, theta


def resample(points, weights, count):
    closed = np.vstack([points, points[:1]])
    seg = np.linalg.norm(np.diff(closed, axis=0), axis=1) * weights
    arc = np.concatenate([[0], np.cumsum(seg)])
    targets = np.linspace(0, arc[-1], count + 1)[:-1]
    out = np.stack([np.interp(targets, arc, closed[:, k]) for k in range(3)], 1)
    return out, arc[-1]


def upper():
    rows, cz = stations()
    grid, perimeters, kinds = [], [], []
    for row in rows:
        centre, dirs, theta = ring(row, cz)
        pts = cast(centre, dirs)
        on_floor = pts[:, 1] <= floor_y(pts[:, 2]) + 0.0008
        weights = np.where(on_floor & np.roll(on_floor, -1), 0.3, 1.0)
        if row[0] == "shaft":
            # Arc-length placement on the nominal ring, then each vertex keeps
            # its scalloped rim height so the top edge stays smooth.
            sampled, perimeter = resample(pts, weights, RING)
        else:
            sampled, perimeter = resample(pts, weights, RING)
        grid.append(sampled)
        perimeters.append(perimeter)
        kinds.append(row[0])
    grid = np.array(grid)
    # Radial rings undersample the heel counter; drape those vertices
    # horizontally onto the last so the counter meets the welt square.
    flat = grid.reshape(-1, 3)
    w = smoothstep(-0.012, -0.032, flat[:, 2]) * (1 - smoothstep(0.10, 0.13, flat[:, 1]))
    w[: 10 * RING] = 0
    sel = np.nonzero(w > 0)[0]
    if len(sel):
        p = flat[sel]
        y = np.maximum(p[:, 1], floor_y(p[:, 2]) + 0.0016)
        origin = np.stack([np.zeros_like(y), y, np.full_like(y, -0.005)], 1)
        d = np.stack([p[:, 0], np.zeros_like(y), p[:, 2] + 0.005], 1)
        d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
        hit = cast(origin, d, limit=0.09)
        hit[:, 1] = p[:, 1]
        flat[sel] = p + (hit - p) * w[sel, None]
        grid = flat.reshape(grid.shape)
    # Snap the welt boundary just into the sole so no crack opens at the seam.
    floor = floor_y(grid[..., 2])
    near = grid[..., 1] <= floor + 0.0008
    grid[..., 1] = np.where(near, floor - 0.0012, grid[..., 1])
    tip_centre = grid[-1].mean(0)
    tip = cast(tip_centre[None], np.array([[0, -0.12, 1.0]]) / np.linalg.norm([0, -0.12, 1.0]))[0]
    return grid, tip, np.array(perimeters), kinds


def outline(stations_z):
    """Lateral/medial welt line where the upper meets the sole top."""
    rows = []
    for z in stations_z:
        y = float(floor_y(z)) + 0.0016
        cx = float(pchip(FT_Z, FT_CX, z))
        centre = np.array([[cx, y, z], [cx, y, z]])
        try:
            pts = cast(centre, np.array([[1.0, 0, 0], [-1.0, 0, 0]]), limit=0.09)
        except ValueError:
            continue
        rows.append((z, pts[0], pts[1]))
    return rows


def welt_width(z):
    return 0.0016 + 0.0029 * smoothstep(-0.020, 0.060, z)


class Mesh:
    def __init__(self):
        self.p, self.uv, self.leg, self.f, self.part = [], [], [], [], []

    def vert(self, p, uv, leg):
        self.p.append([float(v) for v in p])
        self.uv.append([float(v) for v in uv])
        self.leg.append(float(leg))
        return len(self.p) - 1

    def face(self, idx, part):
        self.f.append(list(idx))
        self.part.append(part)


def lerp(span, t):
    return span[0] + (span[1] - span[0]) * t


def build():
    m = Mesh()
    grid, tip, perimeters, kinds = upper()
    rings = len(grid)
    # V by mean surface distance between rings, U by weighted arc length (seam at the back/underside).
    gaps = np.linalg.norm(np.diff(grid, axis=0), axis=2).mean(1)
    tip_gap = float(np.linalg.norm(grid[-1] - tip, axis=1).mean())
    along = np.concatenate([[0], np.cumsum(gaps)])
    total = along[-1] + tip_gap
    rows = []
    for k in range(rings):
        row = []
        for j in range(RING + 1):
            p = grid[k, j % RING]
            leg = smoothstep(0.108, 0.178, p[1])
            row.append(m.vert(p, (j / RING, lerp(V_UPPER, along[k] / total)), leg))
        rows.append(row)
    tip_ids = [m.vert(tip, ((j + 0.5) / RING, V_UPPER[1]), 0) for j in range(RING)]
    floor = floor_y(grid[..., 2])
    on_floor = grid[..., 1] <= floor
    for k in range(rings - 1):
        for j in range(RING):
            a, b, c, d = rows[k][j], rows[k][j + 1], rows[k + 1][j + 1], rows[k + 1][j]
            if on_floor[k, j] and on_floor[k, (j + 1) % RING] and on_floor[k + 1, (j + 1) % RING] and on_floor[k + 1, j]:
                continue
            m.face((a, d, c, b), "upper")
    for j in range(RING):
        m.face((rows[-1][j], tip_ids[j], rows[-1][j + 1]), "upper")
    rim = rows[0][:RING]

    # Turned rim: 3.5 mm leather edge and a short inner facing.
    top = grid[0]
    centre = top.mean(0)
    inward = centre - top
    inward[:, 1] = 0
    inward /= np.linalg.norm(inward, axis=1, keepdims=True)
    inner_top = top + inward * 0.0035 + np.array([0, -0.0012, 0])
    inner_low = grid[2] + inward * 0.0042
    band = [[m.vert(p, (j / RING, lerp(V_RIM, t)), 1) for j, p in enumerate(list(ring_) + [ring_[0]])]
            for ring_, t in [(top, 0.0), (inner_top, 0.18), (inner_low, 1.0)]]
    for r in range(2):
        for j in range(RING):
            m.face((band[r][j], band[r][j + 1], band[r + 1][j + 1], band[r + 1][j]), "rim")

    # Welted sole, burnished edge and underslung riding heel.
    seat = float(floor_y(-0.04)) + 0.0016
    z_back = float(cast(np.array([[0.0, seat, -0.04]]), np.array([[0.0, 0, -1.0]]), limit=0.09)[0, 2])
    zs = np.concatenate([np.linspace(z_back + 0.003, Z_BREAST, 6), np.linspace(Z_BREAST + 0.01, 0.09, 6),
                         np.linspace(0.10, Z_TIP - 0.004, 9)])
    edge = outline(zs)
    lat = [np.array([p[0] + welt_width(z), 0, z]) for z, p, _ in edge]
    med = [np.array([q[0] - welt_width(z), 0, z]) for z, _, q in edge]
    back = np.array([0.0, 0, z_back - welt_width(z_back)])
    front = np.array([float(pchip(FT_Z, FT_CX, Z_TIP)) - 0.001, 0, Z_TIP + welt_width(Z_TIP) + 0.0005])
    loop = [back] + lat + [front] + med[::-1]
    perim = np.concatenate([[0], np.cumsum([np.linalg.norm(loop[(i + 1) % len(loop)] - loop[i]) for i in range(len(loop))])])

    def at(p, y):
        return np.array([p[0], y, p[2]])

    top_y = [float(floor_y(p[2])) - 0.0004 for p in loop]
    bottom_y = [float(tread_y(p[2])) for p in loop]
    centre_x = lambda z: float(pchip(FT_Z, FT_CX, z))
    edge_rows = []
    for t, ys, inset in [(0.0, top_y, 0.0), (0.55, None, 0.0004), (1.0, bottom_y, 0.0012)]:
        row = []
        for i, p in enumerate(loop + [loop[0]]):
            ii = i % len(loop)
            y = ys[ii] if ys else top_y[ii] * 0.45 + bottom_y[ii] * 0.55
            q = p.copy()
            q[0] = centre_x(p[2]) + (p[0] - centre_x(p[2])) * (1 - inset / max(abs(p[0] - centre_x(p[2])), 1e-3))
            row.append(m.vert(at(q, y), (perim[i] / perim[-1], lerp(V_SOLE_EDGE, t)), 0))
        edge_rows.append(row)
    n = len(loop)
    for r in range(2):
        for i in range(n):
            m.face((edge_rows[r][i], edge_rows[r + 1][i], edge_rows[r + 1][i + 1], edge_rows[r][i + 1]), "sole")

    def planar(p, span):
        u = lerp(span, 0.5 + p[0] / 0.13)
        v = lerp(V_BLOCK, (p[2] - (Z_BACK - 0.006)) / (Z_TIP - Z_BACK + 0.012))
        return (u, v)

    def ladder(ys, span, down, part):
        ids = [m.vert(at(p, ys[i]), planar(p, span), 0) for i, p in enumerate(loop)]
        L, M = len(lat), len(med)
        lat_ids = ids[1:1 + L]
        med_ids = ids[2 + L:][::-1]
        b, f = ids[0], ids[1 + L]
        tri = [(b, lat_ids[0], med_ids[0])]
        for i in range(L - 1):
            tri += [(lat_ids[i], lat_ids[i + 1], med_ids[i + 1]), (lat_ids[i], med_ids[i + 1], med_ids[i])]
        tri.append((lat_ids[-1], f, med_ids[-1]))
        for t in tri:
            m.face(t[::-1] if down else t, part)

    ladder(top_y, U_SOLE_TOP, False, "sole")
    bottom_inset = [p.copy() for p in loop]
    ladder(bottom_y, U_SOLE_BOTTOM, True, "sole")

    heel_lat = [p for p in lat if p[2] <= Z_BREAST + 1e-6]
    heel_med = [p for p in med if p[2] <= Z_BREAST + 1e-6]
    breast = [heel_lat[-1] * (1 - t) + heel_med[-1] * t for t in (0.25, 0.5, 0.75)]
    heel_loop = [back] + heel_lat + breast + heel_med[::-1]
    hp = np.concatenate([[0], np.cumsum([np.linalg.norm(heel_loop[(i + 1) % len(heel_loop)] - heel_loop[i]) for i in range(len(heel_loop))])])
    seat_y = HEEL_HEIGHT
    zb_top, zf_top, zb_bot, zf_bot = back[2], Z_BREAST, -0.0605, -0.0185
    hx = centre_x(-0.04)

    def underslung(p, t):
        """Back and breast both rake forward toward the tread; the stack narrows."""
        k = (zf_bot - zb_bot) / (zf_top - zb_top)
        z = p[2] + (zb_bot + (p[2] - zb_top) * k - p[2]) * t
        scale = 1 - 0.27 * t ** 0.85
        return np.array([hx + (p[0] - hx) * scale, seat_y * (1 - t), z])

    heel_rows = []
    for t in (0.0, 0.18, 0.55, 1.0):
        heel_rows.append([m.vert(underslung(p, t), (hp[i] / hp[-1], lerp(V_HEEL, t)), 0)
                          for i, p in enumerate(heel_loop + [heel_loop[0]])])
    for r in range(3):
        for i in range(len(heel_loop)):
            m.face((heel_rows[r][i], heel_rows[r + 1][i], heel_rows[r + 1][i + 1], heel_rows[r][i + 1]), "heel")
    lift = [underslung(p, 1.0) for p in heel_loop]
    lift_ids = [m.vert(p, planar(p, U_SOLE_BOTTOM), 0) for p in lift]
    hub = np.mean(lift, axis=0)
    hub_id = m.vert(hub, planar(hub, U_SOLE_BOTTOM), 0)
    for i in range(len(lift_ids)):
        m.face((hub_id, lift_ids[(i + 1) % len(lift_ids)], lift_ids[i]), "heel")

    # Leather pull loops sewn inside each side of the scalloped top.
    for theta in (math.pi / 2, 3 * math.pi / 2):
        j = int(round(theta / (2 * math.pi) * RING)) % RING
        base = inner_top[j]
        radial = -inward[j]
        tangent = np.cross([0, 1, 0], radial)
        tangent /= np.linalg.norm(tangent)
        path = [(-0.0018, -0.034), (-0.0018, 0.0)]
        for a in np.linspace(0, math.pi, 7):
            path.append((-0.0018 - 0.0047 * (1 - math.cos(a)), 0.0195 + 0.0047 * math.sin(a)))
        path.insert(2, (-0.0018, 0.0195))
        path += [(-0.0112, 0.0), (-0.0112, -0.030)]
        lengths = np.concatenate([[0], np.cumsum([math.dist(path[i], path[i + 1]) for i in range(len(path) - 1)])])
        rows_ = []
        for side, w in ((0, -0.0095), (1, 0.0095)):
            rows_.append([m.vert(base + radial * r + np.array([0, h, 0]) + tangent * w,
                                 (lerp(U_STRAP, side), lerp(V_BLOCK, 0.02 + 0.5 * lengths[i] / lengths[-1])), 1)
                          for i, (r, h) in enumerate(path)])
        for i in range(len(path) - 1):
            m.face((rows_[0][i], rows_[1][i], rows_[1][i + 1], rows_[0][i + 1]), "strap")
    # Loops above are listed clockwise in this right-handed frame; emit outward-facing CCW faces.
    m.f = [f[::-1] for f in m.f]
    return m, {"rim": rim, "grid": grid, "rings": rings}


def triangles(m):
    out = []
    for f, part in zip(m.f, m.part):
        for k in range(1, len(f) - 1):
            out.append(((f[0], f[k], f[k + 1]), part))
    return out


# ---------------------------------------------------------------- leather maps
VARIANTS = {
    "chocolate": {"leather": (42, 26, 17), "thread": (128, 108, 78), "edge": (22, 15, 11)},
    "black": {"leather": (21, 19, 18), "thread": (92, 84, 70), "edge": (12, 11, 10)},
    "russet": {"leather": (60, 38, 25), "thread": (138, 118, 84), "edge": (32, 19, 12)},
}
DUST = np.array([118, 102, 80], float) / 255


def _hash(ix, iy, iz, seed):
    h = (ix * 374761393 + iy * 668265263 + iz * 1274126177 + seed * 2246822519) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0


def noise3(p, scale, seed=0):
    """Smooth value noise on 3D positions (any shape [..., 3])."""
    q = p / scale
    i = np.floor(q).astype(np.int64)
    f = q - i
    f = f * f * (3 - 2 * f)
    out = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[..., 0] if dx else 1 - f[..., 0]) * (f[..., 1] if dy else 1 - f[..., 1]) * (f[..., 2] if dz else 1 - f[..., 2])
                out = out + w * _hash(i[..., 0] + dx, i[..., 1] + dy, i[..., 2] + dz, seed)
    return out


def fbm(p, scale, octaves, seed):
    total, amp, norm = 0, 1.0, 0
    for o in range(octaves):
        total = total + amp * noise3(p, scale / 2**o, seed + o)
        norm += amp
        amp *= 0.5
    return total / norm


def rasterize(m, size):
    """Per-texel surface position, normal-free part id and upper parameters."""
    W, H = size
    pos = np.zeros((H, W, 3))
    part = np.full((H, W), -1, np.int8)
    bary_uv = np.zeros((H, W, 2))
    names = ["upper", "rim", "sole", "heel", "strap"]
    P = np.array(m.p)
    UV = np.array(m.uv) * [W, H]
    for (a, b, c), name in triangles(m):
        ta, tb, tc = UV[a], UV[b], UV[c]
        lo = np.floor(np.minimum(np.minimum(ta, tb), tc) - 1).astype(int)
        hi = np.ceil(np.maximum(np.maximum(ta, tb), tc) + 1).astype(int)
        lo = np.maximum(lo, 0)
        hi = np.minimum(hi, [W - 1, H - 1])
        if (hi < lo).any():
            continue
        xs, ys = np.meshgrid(np.arange(lo[0], hi[0] + 1) + 0.5, np.arange(lo[1], hi[1] + 1) + 0.5)
        det = (tb[1] - tc[1]) * (ta[0] - tc[0]) + (tc[0] - tb[0]) * (ta[1] - tc[1])
        if abs(det) < 1e-9:
            continue
        l1 = ((tb[1] - tc[1]) * (xs - tc[0]) + (tc[0] - tb[0]) * (ys - tc[1])) / det
        l2 = ((tc[1] - ta[1]) * (xs - tc[0]) + (ta[0] - tc[0]) * (ys - tc[1])) / det
        l3 = 1 - l1 - l2
        mask = (l1 >= -0.02) & (l2 >= -0.02) & (l3 >= -0.02)
        if not mask.any():
            continue
        yy, xx = (ys[mask] - 0.5).astype(int), (xs[mask] - 0.5).astype(int)
        inside = (l1[mask] >= 0) & (l2[mask] >= 0) & (l3[mask] >= 0)
        fresh = (part[yy, xx] < 0) | inside
        yy, xx = yy[fresh], xx[fresh]
        w1, w2, w3 = l1[mask][fresh], l2[mask][fresh], l3[mask][fresh]
        pos[yy, xx] = w1[:, None] * P[a] + w2[:, None] * P[b] + w3[:, None] * P[c]
        part[yy, xx] = names.index(name)
    # Dilate so mip and bilinear taps beyond island edges stay on leather.
    for _ in range(4):
        empty = part < 0
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            src_part = np.roll(part, (dy, dx), (0, 1))
            src_pos = np.roll(pos, (dy, dx), (0, 1))
            take = empty & (src_part >= 0)
            part[take], pos[take] = src_part[take], src_pos[take]
            empty = part < 0
    return pos, part, names


def stitch_line(dist, along, width=0.00055, dash=0.0028, gap=0.0012):
    """Height of a stitched seam: dist to the line centre, along = arc coordinate."""
    period = dash + gap
    phase = np.mod(along, period)
    on = smoothstep(0, 0.0004, phase) * (1 - smoothstep(dash - 0.0004, dash, phase))
    across = 1 - smoothstep(width * 0.4, width, np.abs(dist))
    return on * across


def paint(m, variant="chocolate"):
    W, H = TEXTURE_SIZE
    pos, part, names = rasterize(m, TEXTURE_SIZE)
    v = (np.arange(H) + 0.5)[:, None] / H * np.ones((1, W))
    u = (np.arange(W) + 0.5)[None, :] / W * np.ones((H, 1))
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    is_upper = part == names.index("upper")
    is_rim = part == names.index("rim")
    is_sole = part == names.index("sole")
    is_heel = part == names.index("heel")
    is_strap = part == names.index("strap")
    leather_like = is_upper | is_rim | is_strap

    height = np.zeros((H, W))
    thread = np.zeros((H, W))
    groove = np.zeros((H, W))
    grain = fbm(pos * [1, 1, 1], 0.0016, 3, 11) - 0.5
    pebble = noise3(pos, 0.00075, 5) - 0.5
    height += leather_like * (grain * 0.35 + pebble * 0.18)

    # Upper coordinates: around (u) and along the upper (t from rim to toe).
    t_up = (v - V_UPPER[0]) / (V_UPPER[1] - V_UPPER[0])
    around = u
    circumference = 0.33
    arc = around * circumference
    on_shaft = is_upper & (y > 0.13)
    lateral = np.minimum(np.abs(around - 0.25), np.abs(around - 0.75))
    # Side seams from the rim to the heel counter.
    seam_d = lateral * circumference
    seam_zone = is_upper & (y > 0.055)
    ridge = (1 - smoothstep(0.0, 0.0022, seam_d)) * seam_zone
    height += ridge * 0.9
    groove += (1 - smoothstep(0.0, 0.0008, np.abs(seam_d - 0.0024))) * seam_zone
    height -= groove * 0.6
    along_y = y
    for offset in (0.0052, -0.0052):
        sd = np.where(np.abs(around - 0.25) < np.abs(around - 0.75), (around - 0.25), (around - 0.75)) * circumference
        s = stitch_line(sd - offset, along_y) * seam_zone
        thread = np.maximum(thread, s)
    # Rows of shaft stitching: arches across the front and back panels.
    panel_front = np.abs(around - 0.5) < 0.215
    panel_back = (np.abs(around) < 0.215) | (np.abs(around - 1) < 0.215)
    fx = (around - 0.5) / 0.215
    bx = np.where(around < 0.5, around, around - 1) / 0.215
    for row in range(4):
        base_front = 0.300 - row * 0.022
        curve = base_front + 0.035 * np.clip(1 - fx ** 2, 0, None) ** 1.5
        d = y - curve
        s = stitch_line(d, arc) * on_shaft * panel_front
        thread = np.maximum(thread, s)
        curve_b = 0.290 - row * 0.022 + 0.028 * np.clip(1 - bx ** 2, 0, None) ** 1.5
        s = stitch_line(y - curve_b, arc) * on_shaft * panel_back
        thread = np.maximum(thread, s)
    # Top-line stitch following the scalloped rim.
    rim_y = rim_height(around * 2 * math.pi)
    thread = np.maximum(thread, stitch_line(y - (rim_y - 0.0075), arc) * is_upper)
    height += (1 - smoothstep(0, 0.004, rim_y - y)) * is_upper * 0.25
    # Vamp seam: high on the instep, sweeping down the quarters to the counter.
    vamp_curve = 0.074 + 0.054 * smoothstep(-0.040, 0.030, z) - 0.004 * (x / 0.045) ** 2
    vamp_d = y - vamp_curve
    vamp_zone = is_upper & (z > -0.042) & (y > floor_y(z) + 0.006)
    height += (1 - smoothstep(0, 0.0016, np.abs(vamp_d + 0.0012))) * vamp_zone * 0.35
    height -= (1 - smoothstep(0, 0.0007, np.abs(vamp_d - 0.0008))) * vamp_zone * 0.45
    thread = np.maximum(thread, stitch_line(vamp_d + 0.0042, arc + z) * vamp_zone)
    # Heel counter: a stitched panel cupping the heel, meeting the vamp seam.
    counter_top = 0.066 + 0.042 * smoothstep(-0.028, -0.072, z)
    cd = y - counter_top
    counter_zone = is_upper & (z < -0.024) & (y > floor_y(z) + 0.006)
    height += (1 - smoothstep(0, 0.0016, np.abs(cd + 0.0012))) * counter_zone * 0.35
    height -= (1 - smoothstep(0, 0.0007, np.abs(cd - 0.0008))) * counter_zone * 0.45
    thread = np.maximum(thread, stitch_line(cd + 0.0042, arc + z) * counter_zone)
    # Flex creases: across the vamp at the ball and in rings above the ankle.
    wobble = (fbm(pos, 0.018, 2, 21) - 0.5) * 0.006
    vamp_top = is_upper & (z > 0.07) & (z < 0.165) & (y > floor_y(z) + 0.012)
    crease = np.zeros((H, W))
    breakup = smoothstep(0.32, 0.62, fbm(pos, 0.007, 2, 23))
    for k, (zc, depth, bow) in enumerate(((0.097, 0.55, 0.010), (0.109, 0.9, 0.014), (0.118, 0.45, 0.008),
                                          (0.128, 0.75, 0.016), (0.141, 0.35, 0.011))):
        d = z - zc - wobble * (1.6 + 0.4 * k) - bow * (x / 0.05) ** 2 - 0.003 * np.sin(x * 95 + k * 1.7)
        reach = 1 - smoothstep(0.018 + 0.004 * k, 0.034 + 0.003 * k, np.abs(x - float(pchip(FT_Z, FT_CX, zc))))
        crease = np.maximum(crease, (1 - smoothstep(0, 0.0012 + 0.0007 * depth, np.abs(d))) * depth * reach)
    crease *= vamp_top * smoothstep(0.012, 0.026, y - floor_y(z)) * (0.45 + 0.55 * breakup)
    ankle = is_upper & (y > 0.125) & (y < 0.215) & (z > pchip(SH_Y, SH_CZ, y) - 0.01)
    for k, yc in enumerate((0.138, 0.151, 0.163, 0.178, 0.196)):
        d = y - yc - wobble * 1.2 - 0.008 * (x / 0.045) ** 2
        crease = np.maximum(crease, (1 - smoothstep(0, 0.0019, np.abs(d))) * ankle * (0.85 - 0.12 * k))
    slouch = is_upper & (y > 0.2) & (y < 0.25) & (np.abs(around - 0.5) < 0.2)
    for yc in (0.214, 0.231):
        d = y - yc - wobble * 1.5
        crease = np.maximum(crease, (1 - smoothstep(0, 0.004, np.abs(d))) * slouch * 0.25)
    height -= crease * 1.15
    # Scuffed toe cap and worn heel counter.
    toe = is_upper & (z > 0.16)
    scuff_noise = fbm(pos, 0.004, 3, 31)
    scuff = toe * smoothstep(0.52, 0.72, scuff_noise) * smoothstep(0.16, 0.2, z)
    scratches = np.zeros((H, W))
    rng = np.random.default_rng(7)
    for _ in range(26):
        c = np.array([rng.uniform(-0.03, 0.03), rng.uniform(0.02, 0.07), rng.uniform(0.15, 0.21)])
        dvec = rng.normal(size=3)
        dvec /= np.linalg.norm(dvec)
        rel = pos - c
        along_s = rel @ dvec
        perp = np.linalg.norm(rel - along_s[..., None] * dvec, axis=-1)
        scratches = np.maximum(scratches, (1 - smoothstep(0.0002, 0.0006, perp)) * (np.abs(along_s) < rng.uniform(0.004, 0.012)))
    scratches *= is_upper * (z > 0.12)
    height -= scratches * 0.35
    heel_wear = is_upper * (z < -0.05) * (y < 0.09) * smoothstep(0.5, 0.75, fbm(pos, 0.006, 2, 41))

    # Welt stitching on the sole top margin and the welt groove at the upper.
    sole_top = is_sole & (u > U_SOLE_TOP[0] - 0.01) & (u < U_SOLE_TOP[1] + 0.01) & (v > V_BLOCK[0])
    welt_rows = outline(np.linspace(-0.06, Z_TIP - 0.006, 80))
    if welt_rows:
        wz = np.array([r[0] for r in welt_rows])
        wl = np.array([r[1][0] for r in welt_rows])
        wm = np.array([r[2][0] for r in welt_rows])
        lat_x, med_x = np.interp(z, wz, wl), np.interp(z, wz, wm)
        dl = x - (lat_x + 0.0022)
        dm = x - (med_x - 0.0022)
        welt = np.maximum(stitch_line(dl, z, 0.0006, 0.0022, 0.0009), stitch_line(dm, z, 0.0006, 0.0022, 0.0009))
        thread = np.maximum(thread, welt * sole_top * (z > -0.045))
        height -= (1 - smoothstep(0, 0.001, np.minimum(np.abs(x - lat_x), np.abs(x - med_x)))) * sole_top * 0.4
    # Sole edge: burnished with a fine groove; heel stack lamination.
    edge_t = (v - V_SOLE_EDGE[0]) / (V_SOLE_EDGE[1] - V_SOLE_EDGE[0])
    height += is_sole * (v < V_SOLE_EDGE[1] + 0.002) * (v > V_SOLE_EDGE[0] - 0.002) * (-0.25 * (1 - smoothstep(0, 0.12, np.abs(edge_t - 0.45))))
    heel_t = (v - V_HEEL[0]) / (V_HEEL[1] - V_HEEL[0])
    lifts = np.abs(np.mod(heel_t * 5.0, 1.0) - 0.5)
    lamination = (1 - smoothstep(0.38, 0.5, lifts))
    height += is_heel * (v < V_HEEL[1]) * (-(1 - lamination) * 0.3 + (fbm(pos, 0.0012, 2, 51) - 0.5) * 0.25)
    height += is_strap * 0.0

    thread_h = thread * 0.55
    height += thread_h
    # Albedo.
    pal = VARIANTS[variant]
    base = np.array(pal["leather"], float) / 255
    edge_col = np.array(pal["edge"], float) / 255
    thread_col = np.array(pal["thread"], float) / 255
    lin = lambda c: np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    base, edge_col, thread_col, dust_col = lin(base), lin(edge_col), lin(thread_col), lin(DUST)
    mottle = fbm(pos, 0.03, 3, 61)
    col = base[None, None] * (0.80 + 0.40 * mottle)[..., None]
    col *= (1 + grain * 0.18)[..., None]
    # Rubbed highlights on raised leather, darker in creases and seams.
    col *= (1 - 0.45 * crease - 0.35 * groove)[..., None]
    rub = np.clip(ridge * 0.5 + scuff * 0.9 + heel_wear * 0.6, 0, 1)
    worn = base * 1.85 + np.array([0.012, 0.008, 0.004])
    col = col * (1 - rub[..., None]) + worn[None, None] * rub[..., None]
    col = col * (1 - scratches[..., None] * 0.6) + (base * 2.4)[None, None] * scratches[..., None] * 0.6
    # Turned rim: flesh side on the inner facing.
    rim_t = (v - V_RIM[0]) / (V_RIM[1] - V_RIM[0])
    flesh = lin(np.array([62, 43, 30], float) / 255) * (0.6 if variant == "black" else 1.0)
    col = np.where((is_rim & (rim_t > 0.12))[..., None], flesh[None, None] * (0.75 + 0.3 * mottle[..., None]) * 0.55, col)
    # Sole edge, bottom and heel.
    raw = lin(np.array([86, 66, 47], float) / 255)
    col = np.where(is_sole[..., None], edge_col[None, None] * (0.85 + 0.3 * mottle[..., None]), col)
    bottom = is_sole & (u < U_SOLE_BOTTOM[1] + 0.01) & (v > V_BLOCK[0])
    col = np.where(bottom[..., None], raw[None, None] * (0.6 + 0.5 * fbm(pos, 0.01, 3, 71)[..., None]), col)
    heel_side = is_heel & (v < V_HEEL[1] + 0.003)
    heel_col = edge_col * 1.25 * (0.85 + 0.25 * lamination)[..., None] * (0.9 + 0.2 * mottle[..., None])
    col = np.where(heel_side[..., None], heel_col, col)
    lift = is_heel & (v > V_BLOCK[0])
    col = np.where(lift[..., None], (edge_col * 0.9)[None, None] * (0.8 + 0.4 * fbm(pos, 0.004, 2, 81)[..., None]), col)
    col = np.where((is_sole & sole_top)[..., None], edge_col[None, None] * (0.95 + 0.3 * mottle[..., None]), col)
    # Threads.
    col = col * (1 - thread[..., None]) + thread_col[None, None] * (0.75 + 0.25 * mottle[..., None]) * thread[..., None]
    # Dust: settles on the lower vamp, the welt, crease bottoms and the sole edge.
    height_above = y - floor_y(z)
    patches = smoothstep(0.30, 0.72, fbm(pos, 0.016, 3, 91))
    fine = fbm(pos, 0.0018, 2, 97)
    film = (1 - smoothstep(0.0, 0.032, height_above)) * 0.62 + (1 - smoothstep(0.02, 0.11, y)) * 0.22
    film += smoothstep(0.06, 0.14, z) * smoothstep(0.006, 0.016, y - floor_y(z)) * 0.12
    dust = film * (0.35 + 0.65 * patches) * (0.6 + 0.4 * fine) + crease * (y < 0.21) * 0.22
    dust = np.clip(dust, 0, 0.6) * is_upper
    near_tread = 1 - smoothstep(0.0, 0.006, y - tread_y(z))
    edge_dust = (0.05 + 0.28 * near_tread) * (0.5 + 0.5 * patches) * (0.6 + 0.4 * fine)
    dust = np.where(is_sole & ~bottom & ~sole_top, edge_dust, dust)
    dust = np.where(heel_side, (0.08 + 0.45 * (1 - smoothstep(0.0, 0.012, y))) * (0.5 + 0.5 * patches), dust)
    dust = np.where(sole_top & is_sole, 0.25 + 0.3 * patches, dust)
    col = col * (1 - dust[..., None] * 0.8) + dust_col[None, None] * (0.85 + 0.3 * fine[..., None]) * dust[..., None] * 0.8
    srgb = lambda c: np.where(c <= 0.0031308, c * 12.92, 1.055 * np.clip(c, 0, None) ** (1 / 2.4) - 0.055)
    albedo = np.clip(srgb(col) * 255 + 0.5, 0, 255).astype(np.uint8)

    # Roughness/occlusion (ARM: r = occlusion, g = roughness, b = metalness 0).
    rough = np.full((H, W), 0.62)
    rough = rough + (mottle - 0.5) * 0.12 + grain * 0.05
    rough = np.where(toe, rough - 0.10, rough)
    rough = rough + scuff * 0.24 + scratches * 0.2 + crease * 0.10 + thread * 0.2 + dust * 0.32
    rough = np.where(is_sole, 0.50 + 0.1 * mottle, rough)
    rough = np.where(bottom, 0.86, rough)
    rough = np.where(heel_side, 0.58 + 0.12 * (1 - lamination), rough)
    rough = np.where(lift, 0.82, rough)
    rough = np.where(is_rim & (rim_t > 0.12), 0.85, rough)
    rough = np.clip(rough + dust * (is_sole | is_heel) * 0.25, 0.25, 0.97)
    occlusion = np.ones((H, W))
    occlusion -= crease * 0.32 + groove * 0.3
    occlusion -= is_upper * (1 - smoothstep(0.0, 0.012, height_above)) * 0.35
    occlusion -= is_upper * (1 - smoothstep(0.0, 0.004, rim_y - y)) * 0.0
    occlusion = np.where(is_rim & (rim_t > 0.12), 0.45 + 0.3 * (1 - rim_t), occlusion)
    occlusion = np.where(is_strap, 0.9, occlusion)
    occlusion = np.clip(occlusion, 0.2, 1)
    arm = np.stack([occlusion, rough, np.zeros_like(rough)], -1)
    arm = np.clip(arm * 255 + 0.5, 0, 255).astype(np.uint8)

    # Tangent normal from height (metres of relief per unit height ~ 0.45 mm).
    relief = 0.00045
    texel_u, texel_v = circumference / W, 0.55 * (V_UPPER[1] - V_UPPER[0]) ** -1 / H * (V_UPPER[1] - V_UPPER[0])
    gx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / 2
    gy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) / 2
    nx = -gx * relief / texel_u
    ny = gy * relief / texel_v
    nz = np.ones_like(nx)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack([nx / norm, ny / norm, nz / norm], -1)
    normal = np.clip((normal * 0.5 + 0.5) * 255 + 0.5, 0, 255).astype(np.uint8)
    return {"albedo": albedo, "normal": normal, "arm": arm}


def write_png(path, pixels):
    """Deterministic RGB PNG (no timestamps or encoder metadata)."""
    h, w, _ = pixels.shape
    raw = b"".join(b"\x00" + pixels[row].tobytes() for row in range(h))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as handle:
        handle.write(png)
