"""HALCYON VII exterior: primary surfaces.  Fittings live in exterior_detail."""
import math
import os
from mathutils import Matrix, Vector

from . import preview as pv
from . import prims
from .common import collection
from .design import (DIMS, HULL_KEYS, NACELLE_KEYS, WING_KEYS, CANARD_KEYS, FIN_KEYS,
                     CANT_KEYS, CANT_TILT, ENGINES, NX, NY)
from .loft import LoftSurface, J_B, J_C, J_D, J_E, JMAX

HULL = LoftSurface(HULL_KEYS)
NACELLE = LoftSurface(NACELLE_KEYS)
WING = LoftSurface(WING_KEYS, axes=('y', 'z', 'x'))
FIN = LoftSurface(FIN_KEYS, axes=('x', 'z', 'y'))

# longitudinal panel breaks, in ring cell coordinates
BANDS = [0, 2, J_B, 11, J_C, J_D, 25, J_E, 32, JMAX]
FRAMES = (-12.4, DIMS['canopyFront'], DIMS['bulkheadZ'], -1.0, DIMS['rampHingeZ'], DIMS['rampTopZ'])
RAMP_Z0, RAMP_Z1 = DIMS['rampHingeZ'], DIMS['rampTopZ']

# ---- canopy glazing: (z0, z1, jf0, jf1) panes on the half ring.  The
# windscreen and the overhead run across the centreline with no centre post.
GZ0, GZ1 = -10.20, -6.20
Z_B = (-8.34, -8.22)             # B-post
J_A = (5.15, 5.85)               # A-pillar, in cells
PANES = [
    (GZ0, Z_B[0], 0.0, J_A[0]),          # windscreen
    (Z_B[1], GZ1, 0.0, J_A[0]),          # overhead
    (GZ0 + 0.42, Z_B[0], J_A[1], 12.9),  # forward quarter light
    (Z_B[1], GZ1, J_A[1], 13.3),         # side window
]

# grey access panels and signal paint: (z0, z1, jf0, jf1, material)
PAINT = [
    (-4.0, -2.55, 16.0, 21.0, 'hullGrey'),     # crew door
    (1.9, 3.35, 6.0, 11.0, 'hullGrey'),        # avionics bay
    (-13.85, -12.4, 6.0, 11.0, 'hullGrey'),    # radar / sensor bay
    (6.9, 8.35, 11.0, 16.0, 'hullGrey'),       # APU bay
    (-12.4, -10.4, 16.0, 17.0, 'accent'),      # cheat line on the nose chine
    (9.05, 9.5, 0.0, 16.0, 'accent'),          # tail band
]


def in_pane(z, jf):
    return any(a <= z <= b and c <= jf <= d for a, b, c, d in PANES)


def in_ramp(z, jf):
    return RAMP_Z0 < z < RAMP_Z1 and jf > J_E


def hull_seams():
    seams = []
    z_first, z_last = -13.85, 10.6
    for j in BANDS[1:-1]:
        seams.append(('l', float(j), z_first if j > 2 else -5.4, z_last))
    for z in FRAMES:
        seams.append(('r', z, 0.0, float(JMAX)))
    pitch = 1.45
    for b, (j0, j1) in enumerate(zip(BANDS[:-1], BANDS[1:])):
        z = -11.4 + (0.5 * pitch if b % 2 else 0.0)
        while z < 10.4:
            clear = all(abs(z - f) > 0.35 for f in FRAMES)
            in_canopy = GZ0 - 0.3 < z < GZ1 + 0.3 and j1 <= 14
            if clear and not in_canopy:
                seams.append(('r', round(z, 3), float(j0), float(j1)))
            z += pitch
    for (a, b, c, d, _) in PAINT:
        seams += [('r', a, c, d), ('r', b, c, d)]
        if c > 0:
            seams.append(('l', c, a, b))
        seams.append(('l', d, a, b))
    seams.append(('l', float(J_E), RAMP_Z0, RAMP_Z1))
    return seams


def hull_region(z, jf, side):
    if in_ramp(z, jf):
        return None
    if in_pane(z, jf):
        return 'glass'
    if GZ0 - 0.10 < z < GZ1 + 0.10 and jf < 13.9 and not (z < GZ0 + 0.42 and jf > 13.0):
        return 'trim'                # canopy frame
    for (a, b, c, d, key) in PAINT:
        if a < z < b and c < jf < d:
            return key
    if jf > 23.0:
        return 'hullDark'            # thermal belly
    if z < -14.85:
        return 'hullDark'            # nose cap
    return 'hull'


def pane_uv(key, z, jf, side, zmid, jmid):
    if key != 'glass':
        return None
    for (a, b, c, d) in PANES:
        if a <= zmid <= b and c <= jmid <= d:
            v = (z - a) / (b - a)
            if c == 0.0:
                return (0.5 + side * 0.5 * jf / d, v)       # spans the centreline
            return ((jf - c) / (d - c), v)
    return None


def build_hull(M, col):
    z_extra = sorted({v for p in PANES for v in p[:2]} | {v for p in PAINT for v in p[:2]}
                     | {GZ0 + 0.42})
    u_extra = sorted({v for p in PANES for v in p[2:]} | {13.0, 13.9})
    return HULL.build('hull', col, seams=hull_seams(), region=hull_region, mats=M,
                      cap_start=True, cap_end=True, z_extra=z_extra, u_extra=u_extra, uv_fn=pane_uv)


def build_ramp(M, col):
    """Cargo ramp: the belly band between the hinge and the sill, as a slab
    with its own thickness.  Authored in place; the exporter re-origins it to
    the hinge so the game can swing it."""
    T = 0.15

    def only(z, jf, side):
        return 'hullDark' if in_ramp(z, jf) else None

    def deck(z, jf, side):
        return 'deck' if in_ramp(z, jf) else None

    seams = [('r', z, float(J_E), float(JMAX)) for z in (7.0, 7.8)]
    outer = HULL.build('ramp-skin', col, seams=seams, region=only, mats=M,
                       z_range=(RAMP_Z0, RAMP_Z1))
    inner = HULL.build('ramp-deck', col, region=deck, mats=M, inset=T, flip=True,
                       z_range=(RAMP_Z0, RAMP_Z1), tile=1.5)
    parts = [outer, inner]
    quads = []
    zs = [RAMP_Z0 + (RAMP_Z1 - RAMP_Z0) * i / 12 for i in range(13)]
    for side in (1, -1):
        a = [HULL.point(z, J_E, side) for z in zs]
        b = [HULL.point(z, J_E, side, T) for z in zs]
        quads += prims.strip_between(a, b)
    for z in (RAMP_Z0, RAMP_Z1):
        js = [(J_E + (JMAX - J_E) * i / 4, 1) for i in range(5)] + \
             [(J_E + (JMAX - J_E) * i / 4, -1) for i in range(3, -1, -1)]
        a = [HULL.point(z, j, s) for j, s in js]
        b = [HULL.point(z, j, s, T) for j, s in js]
        quads += prims.strip_between(a, b)
    mid_z = (RAMP_Z0 + RAMP_Z1) / 2
    centroid = HULL.point(mid_z, JMAX, 1, T / 2)
    parts.append(prims.quads('ramp-edge', col, quads, M['metalDark'], away_from=centroid))
    # anti-slip treads and side rails on the walking face
    s0 = HULL.point(RAMP_Z0, JMAX, 1, T)
    s1 = HULL.point(RAMP_Z1, JMAX, 1, T)
    along = (s1 - s0)
    L = along.length
    along.normalize()
    up = Vector((0, along.z, -along.y))        # walking-face normal (into the hull)
    rot = Matrix((Vector((1, 0, 0)), up, along)).transposed()
    half_w = DIMS['rampHalfW']
    for i in range(1, 12):
        p = s0 + along * (L * i / 12) + up * 0.008
        parts.append(prims.box('ramp-tread', col, (half_w * 1.72, 0.016, 0.07), M['metalDark'],
                               bevel=0.004, origin=p, rot=rot))
    for sx in (-1, 1):
        p = s0 + along * (L / 2) + up * 0.03 + Vector((sx * (half_w - 0.07), 0, 0))
        parts.append(prims.box('ramp-rail', col, (0.09, 0.06, L - 0.1), M['accent'],
                               bevel=0.01, origin=p, rot=rot))
    for sx in (-1.25, 0.0, 1.25):
        parts.append(prims.revolve('ramp-hinge', col,
                                   [(0.0, -0.22), (0.075, -0.22), (0.075, 0.22), (0.0, 0.22)],
                                   (sx, DIMS['rampHingeY'], RAMP_Z0 + 0.02), (1, 0, 0), 14, M['metal']))
    return parts


# ---------------------------------------------------------------- nacelles
def build_nacelle(M, col, mirror):
    S = LoftSurface(NACELLE_KEYS, mirror=mirror)
    tag = 'port' if mirror else 'stbd'
    seams = [('l', float(j), 0.7, 11.0) for j in (J_B, J_C, J_D, J_E)]
    seams += [('r', z, 0.0, float(JMAX)) for z in (1.0, 1.28, 3.0, 5.2, 7.4, 9.2, 10.4)]
    seams += [('l', 4.0, 3.6, 6.9), ('r', 3.6, 0.0, 4.0), ('r', 6.9, 0.0, 4.0)]

    def region(z, jf, side):
        if z > 10.4:
            return 'metalDark'
        if z < 1.0:
            return 'hullDark'
        if z < 1.28:
            return 'accent'
        if 3.6 < z < 6.9 and jf < 4.0:
            return 'metalDark'       # radiator bed (louvres sit on it)
        if 7.4 < z < 9.2 and J_C < jf < J_D:
            return 'hullGrey'
        if jf > 27:
            return 'hullDark'
        return 'hull'

    outer = S.build('nacelle-' + tag, col, seams=seams, region=region, mats=M, cap_end=True,
                    z_extra=(3.6, 6.9))
    duct = S.build('nacelle-duct-' + tag, col, region=lambda z, j, s: 'metalDark', mats=M,
                   inset=0.07, flip=True, z_range=(0.4, 2.6), cap_end=True)
    lip = S.lip('nacelle-lip-' + tag, col, 0.4, 0.085, M['hullDark'])
    return [outer, duct, lip]


# ---------------------------------------------------------------- lifting surfaces
def build_wing(M, col, mirror):
    S = LoftSurface(WING_KEYS, axes=('y', 'z', 'x'), mirror=mirror)
    tag = 'port' if mirror else 'stbd'
    seams = [('l', 11.0, 5.3, 9.9), ('l', 16.0, 3.3, 10.6), ('l', 27.0, 3.3, 10.6)]
    seams += [('r', x, 0.0, 27.0) for x in (4.9, 6.2, 7.5, 8.85)]
    seams += [('r', x, 0.0, 11.0) for x in (5.3, 9.9)]
    seams += [('r', x, 0.0, 27.0) for x in (9.25, 9.55)]

    def region(x, jf, side):
        if jf > 27.0 or x > 10.2:
            return 'hullDark'
        if 9.25 < x < 9.55:
            return 'accent'
        return 'hull'

    return [S.build('wing-' + tag, col, seams=seams, region=region, mats=M,
                    cap_end=True, ring_step=0.45)]


def build_canard(M, col, mirror):
    S = LoftSurface(CANARD_KEYS, axes=('y', 'z', 'x'), mirror=mirror)
    tag = 'port' if mirror else 'stbd'
    seams = [('l', 27.0, 2.3, 4.5), ('r', 3.4, 0.0, 27.0)]
    return [S.build('canard-' + tag, col, seams=seams, mats=M, cap_end=True, ring_step=0.4,
                    region=lambda x, j, s: 'hullDark' if j > 27 else 'hull')]


def build_fin(M, col):
    seams = [('l', 11.0, 3.4, 6.1), ('l', 27.0, 2.9, 6.3)]
    seams += [('r', y, 0.0, 27.0) for y in (3.4, 4.4, 5.3, 5.62)]

    def region(y, j, s):
        if j > 27 or y > 6.2:
            return 'hullDark'
        if 5.3 < y < 5.62:
            return 'accent'
        return 'hull'

    return [FIN.build('fin', col, seams=seams, mats=M, cap_end=True, ring_step=0.45, region=region)]


def build_cant(M, col, mirror):
    xf = Matrix.Translation(Vector((NX, NY, 0))) @ Matrix.Rotation(CANT_TILT, 4, 'Z')
    S = LoftSurface(CANT_KEYS, axes=('x', 'z', 'y'), xform=xf, mirror=mirror)
    tag = 'port' if mirror else 'stbd'
    seams = [('l', 27.0, 1.1, 3.8), ('r', 2.5, 0.0, 27.0)]
    return [S.build('cant-' + tag, col, seams=seams, mats=M, cap_end=True, ring_step=0.45,
                    region=lambda y, j, s: 'hullDark' if j > 27 else 'hull')]


# ---------------------------------------------------------------- engines
def build_engine(M, col, e, idx):
    x, y, z, r = e['x'], e['y'], e['z'], e['r']
    out = []
    L = r * 1.25
    out.append(prims.lathe('eng%d-shroud' % idx, col, [
        (r * 1.11, z - 0.02), (r * 1.09, z + L * 0.30), (r * 1.03, z + L * 0.34),
        (r * 1.00, z + L * 0.34), (r * 0.985, z + L * 0.02), (r * 0.985, z - 0.3),
    ], (x, y), mat=M['metalDark'], segs=56))
    # variable-area petals around the shroud
    n = 18 if e['main'] else 10
    for k in range(n):
        t = 2 * math.pi * (k + 0.5) / n
        c, s = math.cos(t), math.sin(t)
        rot = Matrix((Vector((-s, c, 0)), Vector((c, s, 0)), Vector((0, 0, 1)))).transposed()
        w = 2 * math.pi * r * 1.10 / n * 0.86
        out.append(prims.box('eng%d-petal' % idx, col, (w, r * 0.035, L * 0.30), M['heat'],
                             bevel=r * 0.008,
                             origin=(x + c * r * 1.115, y + s * r * 1.115, z + L * 0.15),
                             rot=rot, tint=(k * 0.37) % 1.0))
    out.append(prims.lathe('eng%d-bell' % idx, col, [
        (r * 0.50, z - L * 0.55), (r * 0.72, z - L * 0.10), (r * 0.90, z + L * 0.38),
        (r * 0.93, z + L * 0.50), (r * 0.895, z + L * 0.50), (r * 0.86, z + L * 0.36),
        (r * 0.66, z - L * 0.12), (r * 0.40, z - L * 0.50), (r * 0.30, z - L * 0.62),
    ], (x, y), mat=M['heat'], segs=56))
    out.append(prims.lathe('eng%d-core' % idx, col, [
        (r * 0.30, z - L * 0.62), (r * 0.22, z - L * 0.60), (r * 0.20, z - L * 0.56),
        (r * 0.08, z - L * 0.56), (0.0, z - L * 0.50),
    ], (x, y), mat=M['engineCore'], segs=40))
    return out


def build(M):
    from . import exterior_detail as detail
    col = collection('exterior')
    groups = {'exterior': [build_hull(M, col)], 'ramp': build_ramp(M, col)}
    static = groups['exterior']
    for mirror in (False, True):
        static += build_nacelle(M, col, mirror)
        static += build_wing(M, col, mirror)
        static += build_canard(M, col, mirror)
        static += build_cant(M, col, mirror)
    static += build_fin(M, col)
    for i, e in enumerate(ENGINES):
        static += build_engine(M, col, e, i)
    detail.build(M, col, groups)
    return groups


VIEWS = {
    # name: (eye, target, lens)
    'front34': ((-15, 7.5, -30), (0, 1.0, -1), 50),
    'rear34': ((14, 8, 30), (0, 1.2, 1), 50),
    'chase': ((0, 9.5, 36), (0, 1.5, 0), 40),
    'side': ((-40, 2.0, -2), (0, 1.0, -2), 60),
    'top': ((0.01, 46, -2), (0, 0, -2), 50),
    'belly': ((-11, -13, -22), (0, 0.5, -2), 45),
    'nose': ((-4.5, 2.6, -17.5), (0, 1.2, -9), 40),
    'tip': ((-1.6, 0.5, -17.6), (0, -0.1, -15.2), 60),
    'close': ((-5.2, 2.2, -9.5), (-2.3, 1.2, -6.5), 50),
    'engines': ((6.5, 3.2, 17.5), (2.2, 1.0, 10.5), 50),
    'ground': ((-9, -0.9, -20), (0, 0.6, -4), 28),
    'gear': ((-7.5, -1.0, 9.5), (-1.5, -0.6, 3.0), 35),
    'door': ((-9.5, 1.6, -6.5), (-2.6, 0.9, -2.5), 50),
    'intake': ((6.2, 1.6, -3.2), (3.6, 0.7, 0.6), 60),
    'under': ((-7.5, -1.3, -13), (0, -0.6, -2), 24),
    'dorsal': ((-4.5, 6.5, -9.5), (0, 2.6, -1.0), 40),
}


def preview(scene, out, views=None):
    os.makedirs(out, exist_ok=True)
    pv.setup_cycles(scene)
    pv.studio_world(scene)
    pv.add_sun((-0.55, 0.62, -0.56), strength=3.6)
    pv.add_sun((0.7, -0.25, 0.6), strength=0.35, color=(0.6, 0.75, 1.0), angle=20, name='fill')
    cam = pv.add_camera()
    if any(v in ('ground', 'gear', 'under') for v in (views or ())):
        pv.ground_plane(-1.60)
    for name in (views or VIEWS.keys()):
        eye, target, lens = VIEWS[name]
        pv.aim(cam, eye, target, lens)
        pv.render(os.path.join(out, name + '.png'))
