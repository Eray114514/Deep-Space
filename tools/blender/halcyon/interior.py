"""HALCYON VII interior: mid-deck, cargo hold, bulkheads, ramp tunnel.

Three zones with different jobs and different light:
  flight deck  z -10.3 .. -5.4   (cockpit.py) dark, instrument-lit
  mid-deck     z  -5.4 .. -1.0   habitation: galley to port, bunks to starboard
  cargo hold   z  -0.6 ..  6.2   industrial: ribs, lashing rails, crane, benches
The liners are lofts like the hull, so wall panels are real seams with their
own tint, and every fitting is placed from the same section numbers.
"""
import math
import bmesh
import bpy
from mathutils import Matrix, Vector

from . import prims
from .bake import refine
from .common import G, new_object
from .design import DIMS, K
from .loft import LoftSurface, J_B, J_C, J_D, J_E, JMAX

MID_Z0, MID_Z1 = -5.40, -1.00
HOLD_Z0, HOLD_Z1 = -0.60, 6.20
MID = dict(yTop=2.26, w=1.30, wTop=0.84, wBot=1.20, yC=1.86, yD=0.14)
HOLD = dict(yTop=2.56, w=2.15, wTop=1.45, wBot=2.05, yC=1.95, yD=0.14)


def _keys(z0, z1, d):
    k = lambda z: K(z, 0.0, d['yTop'], d['w'], d['wTop'], d['wBot'], d['yC'], d['yD'], 0.0, 0.0)  # noqa: E731
    return [k(z0), k(z1)]


MID_S = LoftSurface(_keys(MID_Z0, MID_Z1, MID))
HOLD_S = LoftSurface(_keys(HOLD_Z0, HOLD_Z1, HOLD))

MID_BAY = (MID_Z1 - MID_Z0) / 5          # 0.88
HOLD_BAY = (HOLD_Z1 - HOLD_Z0) / 5       # 1.36
NICHE = (MID_Z0 + MID_BAY, MID_Z0 + 3 * MID_BAY)     # galley / bunk alcoves
LOCKER = (MID_Z0 + 0.10, MID_Z0 + MID_BAY - 0.04)  # recessed lockers, forward bay
# half-cell lines on the ceiling, walls and deck so baked light has somewhere to live
FINE_U = [j + 0.5 for j in list(range(0, 6)) + list(range(16, 21)) + list(range(29, 35))]


class Kit:
    def __init__(self, M, col):
        self.M, self.col, self.parts = M, col, []
        self.movers = {}
        self.screens = []

    def begin(self, name, pivot):
        """everything added until end() becomes the moving node `name`"""
        self._saved, self.parts, self._mover = self.parts, [], (name, tuple(pivot))

    def end(self):
        name, pivot = self._mover
        self.movers[name] = (self.parts, pivot)
        self.parts = self._saved

    def box(self, key, size, origin, bevel=0.01, rot=None, name='box', taper=None, tint=None, seg=2):
        o = prims.box(name, self.col, size, self.M[key], bevel=bevel, origin=origin, rot=rot,
                      taper=taper, tint=tint, segments=seg)
        if max(size) > 0.5:
            refine(o)
            prims.sharp_by_angle(o, 40)
        self.parts.append(o)
        return o

    def tube(self, key, pts, r, segs=10, name='tube'):
        o = prims.tube(name, self.col, pts, r, self.M[key], segs)
        self.parts.append(o)
        return o

    def rev(self, key, profile, origin, direction, segs=20, name='rev'):
        o = prims.revolve(name, self.col, profile, origin, direction, segs, self.M[key])
        self.parts.append(o)
        return o

    def quads(self, key, quad_list, toward=None, away=None, name='quads', tint=0.5):
        o = prims.quads(name, self.col, quad_list, self.M[key], away_from=toward if toward else away, tint=tint)
        if toward is not None:
            prims.flip_faces(o)
        refine(o)
        self.parts.append(o)
        return o

    def label(self, body, height, origin, right, up, key='decal', align='CENTER'):
        """stencilled lettering lying on a surface; right x up faces the reader"""
        r, u, o = Vector(right).normalized(), Vector(up).normalized(), Vector(origin)
        n = r.cross(u)
        obj = prims.text('label', self.col, body, height, lambda a, b: o + r * a + u * b + n * 0.003,
                         self.M[key], align=align, outward=n)
        self.parts.append(obj)
        return obj

    def bolt(self, origin, direction, r=0.014, key='metal'):
        self.rev(key, [(r, 0.0), (r, 0.006), (r * 0.55, 0.009), (0.0, 0.009)], origin, direction, 6, 'bolt')

    def add(self, objs):
        self.parts += objs if isinstance(objs, list) else [objs]

    def alcove(self, key, x0, x1, y0, y1, z0, z1, open_x):
        """five-sided recess; open_x is the x of the missing face"""
        xa, xb = (x0, x1)
        back = xb if abs(xa - open_x) < 1e-6 else xa
        fr = open_x
        P = lambda x, y, z: (x, y, z)  # noqa: E731
        q = [
            (P(back, y0, z0), P(back, y1, z0), P(back, y1, z1), P(back, y0, z1)),
            (P(fr, y0, z0), P(back, y0, z0), P(back, y0, z1), P(fr, y0, z1)),
            (P(fr, y1, z0), P(back, y1, z0), P(back, y1, z1), P(fr, y1, z1)),
            (P(fr, y0, z0), P(fr, y1, z0), P(back, y1, z0), P(back, y0, z0)),
            (P(fr, y0, z1), P(fr, y1, z1), P(back, y1, z1), P(back, y0, z1)),
        ]
        c = ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
        return self.quads(key, q, toward=c, name='alcove')


def bulkhead(kit, name, z, thick, outer, portal, key_fwd, key_aft, key_jamb='metalDark'):
    """Wall across the hull at z with a portal cut through it.
    outer / portal: closed lists of (x, y), counter-clockwise seen from +z."""
    M, col = kit.M, kit.col
    bm = bmesh.new()
    layer = bm.loops.layers.float_color.new('Color')
    mats = [M[key_fwd], M[key_aft], M[key_jamb]]
    for zi, (zz, mi) in enumerate(((z - thick / 2, 0), (z + thick / 2, 1))):
        vo = [bm.verts.new(G(x, y, zz)) for x, y in outer]
        vp = [bm.verts.new(G(x, y, zz)) for x, y in portal]
        edges = [bm.edges.new((vo[i], vo[(i + 1) % len(vo)])) for i in range(len(vo))]
        edges += [bm.edges.new((vp[i], vp[(i + 1) % len(vp)])) for i in range(len(vp))]
        res = bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges)
        want = G(0, 0, -1 if zi == 0 else 1)
        for f in res['geom']:
            if isinstance(f, bmesh.types.BMFace):
                f.normal_update()
                if f.normal.dot(want) < 0:
                    f.normal_flip()
                f.material_index = mi
        if zi == 0:
            p_fwd = vp
        else:
            p_aft = vp
    n = len(portal)
    cx = sum(p[0] for p in portal) / n
    cy = sum(p[1] for p in portal) / n
    for i in range(n):
        j = (i + 1) % n
        f = bm.faces.new((p_fwd[i], p_fwd[j], p_aft[j], p_aft[i]))
        f.normal_update()
        mid = f.calc_center_median()
        if f.normal.dot(G(cx, cy, z) - mid) < 0:
            f.normal_flip()
        f.material_index = 2
    for f in bm.faces:
        for loop in f.loops:
            loop[layer] = (0.5, 0.0, 0.0, 1.0)
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    obj = new_object(name, me, col)
    refine(obj)
    kit.parts.append(obj)
    return obj


def section_poly(S, z, n=2):
    """closed (x, y) outline of a liner section, CCW seen from +z"""
    js = [j / n for j in range(JMAX * n + 1)]
    right = [S.point(z, j, 1) for j in js]          # top centre -> bottom centre, x >= 0
    pts = [(p.x, p.y) for p in right] + [(-p.x, p.y) for p in right[-2:0:-1]]
    out = []
    for p in pts:
        if not out or abs(out[-1][0] - p[0]) + abs(out[-1][1] - p[1]) > 1e-4:
            out.append(p)
    return out[::-1]


def portal_poly(half_w, y0, y1, chamfer=0.22):
    return [(-half_w, y0), (half_w, y0), (half_w, y1 - chamfer), (half_w - chamfer, y1),
            (-half_w + chamfer, y1), (-half_w, y1 - chamfer)]


def portal_frame(kit, z, half_w, y0, y1, depth, key='metalDark', chamfer=0.22, t=0.09, lamp=None):
    """proud door surround built from bevelled bars following the portal"""
    inset = 0.014        # bars stand proud of the jamb, never coplanar with it
    pts = portal_poly(half_w + t / 2 - inset, y0, y1 + t / 2 - inset, chamfer)
    for i in range(1, len(pts)):
        a, b = Vector((*pts[i], 0)), Vector((*pts[(i + 1) % len(pts)], 0))
        if i == len(pts) - 1:
            b = Vector((*pts[0], 0))
        d = b - a
        L = d.length
        ang = math.atan2(d.y, d.x)
        rot = Matrix.Rotation(ang, 3, 'Z')
        mid = (a + b) / 2
        kit.box(key, (L + t * 0.4, t, depth), (mid.x, mid.y, z), bevel=0.015, rot=rot, name='portal-frame')
    if lamp:
        kit.box(lamp, (half_w * 1.1, 0.03, 0.02), (0, y1 + t * 0.5, z + depth / 2 + 0.004), bevel=0.004,
                name='portal-lamp')


# ====================================================================== mid-deck
def build_mid(kit):
    M = kit.M
    z0, z1 = MID_Z0, MID_Z1
    bays = [z0 + MID_BAY * i for i in range(6)]
    seams = [('r', z, 0.0, float(JMAX)) for z in bays[1:-1]]
    seams += [('l', float(j), z0, z1) for j in (J_B, J_C, 18.5, J_D, J_E, 32.0)]
    seams += [('l', 9.0, z0, z1), ('l', 13.0, z0, z1), ('l', 23.5, z0, z1), ('l', 26.5, z0, z1)]

    def bay_of(z):
        return int((z - z0) / MID_BAY)

    def region(z, jf, side):
        b = bay_of(z)
        if NICHE[0] < z < NICHE[1] and J_C < jf < J_D:
            return None                                   # alcove openings
        if LOCKER[0] < z < LOCKER[1] and J_C < jf < J_D:
            return None                                   # locker recesses
        if jf > 32:
            return 'deckMat'
        if jf > J_E:
            return 'deck'
        if jf > J_D:
            if 23.5 < jf < 26.5 and b in (0, 2, 4):
                return 'lampCyan'                         # floor guide lights
            return 'panelDark'
        if jf > 18.5:
            return 'panelGrey'
        if jf > J_C:
            return 'panelWhite'
        if jf > J_B:
            if 9 < jf < 13 and b in (1, 3):
                return 'lampWarm'                         # cove light panels
            return 'panelWhite'
        return 'panelGrey'

    kit.add(MID_S.build('mid-liner', kit.col, seams=seams, region=region, mats=M, flip=True,
                        ring_step=0.22, tile=1.5, seam_half=0.004, seam_depth=0.006, u_extra=FINE_U,
                        z_extra=LOCKER))
    w, yC, yD = MID['w'], MID['yC'], MID['yD']
    na, nb = NICHE
    # alcove surrounds
    for sx in (-1, 1):
        x = sx * (w - 0.012)
        for zz in (na, nb):
            kit.box('metalDark', (0.05, yC - yD + 0.05, 0.05), (x, (yC + yD) / 2, zz), bevel=0.012, name='alcove-frame')
        for yy in (yD, yC):
            kit.box('metalDark', (0.05, 0.05, nb - na + 0.05), (x, yy, (na + nb) / 2), bevel=0.012, name='alcove-frame')
    # ---------------- galley (port)
    xo, xb = -w, -2.06
    kit.alcove('panelWhite', xb, xo, yD, yC, na, nb, xo)
    zc = (na + nb) / 2
    L = nb - na
    kit.box('panelGrey', (0.60, 0.76, L - 0.04), (xb + 0.31, yD + 0.38, zc), bevel=0.012, name='galley-base')
    kit.box('metal', (0.66, 0.035, L - 0.01), (xb + 0.33, yD + 0.78, zc), bevel=0.008, name='galley-counter')
    for i in range(4):
        zz = na + L * (i + 0.5) / 4
        kit.box('panelWhite', (0.018, 0.30, L / 4 - 0.03), (xb + 0.615, yD + 0.56, zz), bevel=0.006, name='drawer')
        kit.box('panelWhite', (0.018, 0.30, L / 4 - 0.03), (xb + 0.615, yD + 0.22, zz), bevel=0.006, name='drawer')
        for yy in (0.66, 0.32):
            kit.box('metal', (0.022, 0.018, 0.16), (xb + 0.632, yD + yy, zz), bevel=0.005, name='pull')
    kit.box('panelGrey', (0.34, 0.46, L - 0.04), (xb + 0.18, yC - 0.25, zc), bevel=0.012, name='galley-upper')
    for i in range(3):
        zz = na + L * (i + 0.5) / 3
        kit.box('panelWhite', (0.016, 0.42, L / 3 - 0.03), (xb + 0.355, yC - 0.25, zz), bevel=0.006, name='door')
        kit.box('metal', (0.02, 0.10, 0.016), (xb + 0.37, yC - 0.40, zz + L / 6 - 0.06), bevel=0.004, name='pull')
    kit.box('lampWarm', (0.035, 0.012, L - 0.3), (xb + 0.28, yC - 0.49, zc), bevel=0.003, name='galley-lamp')
    # appliances on the counter
    yc = yD + 0.80
    kit.box('panelDark', (0.30, 0.34, 0.36), (xb + 0.20, yc + 0.17, na + 0.30), bevel=0.02, name='rehydrator')
    kit.box('screen', (0.006, 0.10, 0.16), (xb + 0.353, yc + 0.24, na + 0.30), bevel=0.0, name='rehydrator-screen')
    kit.rev('metal', [(0.0, 0.0), (0.06, 0.0), (0.06, 0.20), (0.045, 0.24), (0.0, 0.24)], (xb + 0.22, yc, na + 0.72),
            (0, 1, 0), 16, 'flask')
    for k, zz in enumerate((nb - 0.62, nb - 0.42, nb - 0.22)):
        kit.box('crateOrange' if k == 1 else 'panelWhite', (0.16, 0.11 + 0.03 * k, 0.15), (xb + 0.16, yc + 0.06 + 0.015 * k, zz),
                bevel=0.012, name='ration', tint=0.2 + 0.3 * k)
    for zz in (zc - 0.1, zc + 0.08):
        kit.rev('panelWhite', [(0.0, 0.0), (0.036, 0.0), (0.042, 0.085), (0.036, 0.085), (0.031, 0.008), (0.0, 0.008)],
                (xb + 0.44, yc, zz), (0, 1, 0), 14, 'mug')
    # ---------------- bunks (starboard)
    xo, xb = w, 2.10
    kit.alcove('panelWhite', xo, xb, yD, yC, na, nb, xo)
    ymid = (yD + yC) / 2 + 0.02
    kit.box('panelGrey', (xb - xo, 0.05, L), ((xo + xb) / 2, ymid, zc), bevel=0.01, name='bunk-shelf')
    for y in (yD + 0.02, ymid + 0.03):
        kit.box('fabric', (0.70, 0.11, L - 0.10), (xo + 0.40, y + 0.055, zc), bevel=0.03, seg=3, name='mattress')
        kit.box('cushion', (0.44, 0.07, 0.30), (xo + 0.42, y + 0.145, na + 0.24), bevel=0.03, seg=3, name='pillow')
        kit.box('fabricOrange', (0.60, 0.05, 0.62), (xo + 0.40, y + 0.135, nb - 0.42), bevel=0.02, seg=3, name='blanket')
        kit.box('metal', (0.025, 0.07, L - 0.02), (xo + 0.012, y + 0.06, zc), bevel=0.008, name='bunk-lip')
        kit.begin('bunk-lamp-%d' % (0 if y < ymid else 1), (xb - 0.004, y + 0.52, na + 0.30))
        kit.rev('lampWarm', [(0.035, 0.0), (0.0, 0.004)], (xb - 0.004, y + 0.52, na + 0.30), (-1, 0, 0), 14, 'reading-lamp')
        kit.end()
        kit.rev('metalDark', [(0.05, 0.0), (0.05, 0.012), (0.035, 0.012), (0.035, 0.0)], (xb - 0.002, y + 0.52, na + 0.30),
                (-1, 0, 0), 14, 'reading-bezel')
        kit.box('panelGrey', (0.10, 0.02, 0.5), (xb - 0.05, y + 0.36, zc + 0.3), bevel=0.006, name='bunk-ledge')
        kit.box('crateOrange', (0.05, 0.12, 0.16), (xb - 0.055, y + 0.43, zc + 0.38), bevel=0.006, name='book', tint=0.7)
        kit.box('panelDark', (0.045, 0.14, 0.11), (xb - 0.055, y + 0.44, zc + 0.24), bevel=0.006, name='book', tint=0.3)
    # ---------------- lockers, forward bay, both sides: recessed, with what is in them
    build_lockers(kit)
    # ---------------- aft bay: life-support bottles (stbd), service panel (port)
    za = (bays[4] + bays[5]) / 2
    kit.box('panelDark', (0.05, 1.3, 0.7), (w - 0.02, 0.95, za), bevel=0.012, name='o2-backplate')
    for k in (-1, 0, 1):
        zz = za + k * 0.21
        kit.rev('crateOrange' if k == 0 else 'panelWhite',
                [(0.0, 0.0), (0.06, 0.012), (0.085, 0.06), (0.085, 0.86), (0.05, 0.94), (0.03, 0.96), (0.03, 1.02), (0.0, 1.02)],
                (w - 0.14, 0.36, zz), (0, 1, 0), 16, 'o2-bottle')
        kit.rev('metal', [(0.0, 1.02), (0.022, 1.02), (0.022, 1.07), (0.0, 1.07)], (w - 0.14, 0.36, zz), (0, 1, 0), 8, 'o2-valve')
    for yy in (0.62, 1.12):
        kit.box('fabricOrange', (0.02, 0.05, 0.68), (w - 0.235, yy, za), bevel=0.006, name='strap')
    kit.box('panelDark', (0.04, 0.62, 0.52), (-(w - 0.015), 1.28, za), bevel=0.012, name='service-panel')
    kit.box('screen', (0.006, 0.26, 0.38), (-(w - 0.038), 1.36, za), bevel=0.0, name='service-screen')
    for k in range(6):
        kit.box(('btnGreen', 'btnAmber', 'btnWhite')[k % 3], (0.012, 0.022, 0.035), (-(w - 0.04), 1.08, za - 0.19 + 0.076 * k),
                bevel=0.003, name='btn')
    kit.rev('accent', [(0.0, 0.0), (0.05, 0.01), (0.055, 0.30), (0.03, 0.36), (0.0, 0.37)], (-(w - 0.08), 0.42, za + 0.15),
            (0, 1, 0), 14, 'extinguisher')
    kit.box('metalDark', (0.03, 0.05, 0.14), (-(w - 0.02), 0.62, za + 0.15), bevel=0.006, name='ext-clip')
    # ---------------- handrails
    for sx in (-1, 1):
        for (a, b) in ((bays[3] + 0.12, bays[5] - 0.12),):
            if sx > 0:
                b = bays[4] - 0.1
            x = sx * (w - 0.075)
            kit.tube('metal', [(x, 1.04, a), (x, 1.04, b)], 0.018, 10, 'handrail')
            for zz in (a + 0.05, (a + b) / 2, b - 0.05):
                kit.tube('metalDark', [(sx * w, 1.04, zz), (x, 1.04, zz)], 0.011, 8, 'standoff')
    # ---------------- overhead services
    for sx in (-1, 1):
        kit.box('metalDark', (0.14, 0.035, (z1 - z0) - 0.1), (sx * 0.56, MID['yTop'] - 0.02, (z0 + z1) / 2), bevel=0.008,
                name='cable-tray')
        for dx, r in ((0.035, 0.014), (0.0, 0.011), (-0.035, 0.014)):
            kit.tube('rubber' if r > 0.012 else 'accent', [(sx * 0.56 + dx, MID['yTop'] - 0.05, z0 + 0.05),
                                                           (sx * 0.56 + dx, MID['yTop'] - 0.05, z1 - 0.05)], r, 6, 'cable')
    for zz in (bays[1], bays[3]):
        kit.box('metalDark', (0.50, 0.02, 0.28), (0, MID['yTop'] - 0.008, zz + MID_BAY / 2), bevel=0.006, name='vent-frame')
        for k in range(6):
            kit.box('metal', (0.44, 0.008, 0.024), (0, MID['yTop'] - 0.022, zz + MID_BAY / 2 - 0.10 + 0.04 * k), bevel=0.002,
                    rot=Matrix.Rotation(math.radians(25), 3, 'X'), name='vent-slat')


# ====================================================================== cargo hold
def crate(kit, x, z, size, key='crateGrey', y=0.0, rot_y=0.0, tint=None):
    sx, sy, sz = size
    R = Matrix.Rotation(rot_y, 3, 'Y')
    o = Vector((x, y + sy / 2, z))
    kit.box(key, (sx - 0.04, sy - 0.04, sz - 0.04), o, bevel=0.012, rot=R, name='crate', tint=tint)
    # corner posts, top / bottom frames, handles
    for ax in (-1, 1):
        for az in (-1, 1):
            kit.box('metalDark', (0.07, sy, 0.07), o + R @ Vector((ax * (sx / 2 - 0.035), 0, az * (sz / 2 - 0.035))),
                    bevel=0.01, rot=R, name='crate-post')
    for ay in (-1, 1):
        for az in (-1, 1):
            kit.box('metalDark', (sx - 0.02, 0.05, 0.05), o + R @ Vector((0, ay * (sy / 2 - 0.025), az * (sz / 2 - 0.025))),
                    bevel=0.008, rot=R, name='crate-rail')
        for ax in (-1, 1):
            kit.box('metalDark', (0.05, 0.05, sz - 0.02), o + R @ Vector((ax * (sx / 2 - 0.025), ay * (sy / 2 - 0.025), 0)),
                    bevel=0.008, rot=R, name='crate-rail')
    for az in (-1, 1):
        kit.box('metal', (0.22, 0.03, 0.03), o + R @ Vector((0, sy * 0.18, az * (sz / 2 - 0.004))), bevel=0.008, rot=R,
                name='crate-handle')
        kit.box('paintYellow', (sx * 0.34, sy * 0.16, 0.006), o + R @ Vector((-sx * 0.2, -sy * 0.2, az * (sz / 2 - 0.018))),
                bevel=0.0, rot=R, name='crate-label')


def build_hold(kit):
    M = kit.M
    z0, z1 = HOLD_Z0, HOLD_Z1
    bays = [z0 + HOLD_BAY * i for i in range(6)]
    seams = [('r', z, 0.0, float(JMAX)) for z in bays[1:-1]]
    seams += [('r', z + HOLD_BAY / 2, float(J_C), float(J_D)) for z in bays[:-1]]
    seams += [('l', float(j), z0, z1) for j in (2.0, 4.5, J_B, J_C, 18.5, J_D, J_E, 31.0)]

    def bay_of(z):
        return int((z - z0) / HOLD_BAY)

    def region(z, jf, side):
        b = bay_of(z)
        if jf > 31:
            return 'deck'
        if jf > J_E:
            return 'deckMat'
        if jf > J_D:
            return 'panelDark'
        if jf > 18.5:
            return 'panelDark'
        if jf > J_C:
            return 'panelGrey'
        if jf > J_B:
            return 'panelGrey'
        if 2 < jf < 4.5 and b % 2 == 0 and (z - bays[b]) > 0.22 and (bays[b] + HOLD_BAY - z) > 0.22:
            return 'lampCool'                              # ceiling light bars between ribs
        return 'panelDark'

    kit.add(HOLD_S.build('hold-liner', kit.col, seams=seams, region=region, mats=M, flip=True,
                         ring_step=0.22, tile=1.5, seam_half=0.004, seam_depth=0.006, u_extra=FINE_U,
                         z_extra=[b + 0.22 for b in bays[:-1]] + [b - 0.22 for b in bays[1:]]))
    w, yT, yC, yD = HOLD['w'], HOLD['yTop'], HOLD['yC'], HOLD['yD']
    # ---------------- ribs: the liner section stood proud, with flanges
    for z in bays:
        zz = min(max(z, z0 + 0.07), z1 - 0.07)
        kit.add(HOLD_S.build('rib', kit.col, mats=M, flip=True, inset=0.09, z_range=(zz - 0.06, zz + 0.06),
                             region=lambda z_, j, s: 'metalDark' if j < J_E + 0.5 else None, ring_step=0.2))
        for dz in (-0.06, 0.06):
            kit.add(HOLD_S.lip('rib-web', kit.col, zz + dz, 0.09, M['metalDark'], facing=-1 if dz < 0 else 1, jmax=J_E + 0.5))
        kit.add(HOLD_S.build('rib-flange', kit.col, mats=M, flip=True, inset=0.105, z_range=(zz - 0.09, zz + 0.09),
                             region=lambda z_, j, s: 'metal' if j < J_E + 0.5 else None, ring_step=0.2))
        for dz in (-0.09, 0.09):
            kit.add(HOLD_S.lip('rib-flange-edge', kit.col, zz + dz, 0.105, M['metal'], facing=-1 if dz < 0 else 1, jmax=J_E + 0.5))
    # ---------------- lashing rails on the walls, tie-down rings on the deck
    for sx in (-1, 1):
        for yy in (0.62, 1.42):
            kit.box('metal', (0.035, 0.07, (z1 - z0) - 0.3), (sx * (w - 0.02), yy, (z0 + z1) / 2), bevel=0.008, name='lash-rail')
            zz = z0 + 0.35
            while zz < z1 - 0.3:
                kit.box('metalDark', (0.012, 0.03, 0.05), (sx * (w - 0.04), yy, zz), bevel=0.004, name='lash-slot')
                zz += 0.17
    for zz in [z0 + 0.68 * k + 0.5 for k in range(9)]:
        for x in (-1.25, 1.25):
            kit.rev('metalDark', [(0.075, 0.0), (0.075, 0.008), (0.05, 0.012), (0.0, 0.012)], (x, 0.0, zz), (0, 1, 0), 14, 'tie-down')
            kit.box('metal', (0.05, 0.02, 0.02), (x, 0.022, zz), bevel=0.006, name='tie-ring')
    # lane markings
    for x in (-1.02, 1.02):
        kit.box('paintYellow', (0.05, 0.004, (z1 - z0) - 0.5), (x, 0.002, (z0 + z1) / 2), bevel=0.0, name='lane-line')
    # ---------------- overhead crane
    yr = yT - 0.07
    kit.box('metalDark', (0.14, 0.14, (z1 - z0) - 0.2), (0, yr, (z0 + z1) / 2), bevel=0.012, name='crane-beam')
    kit.box('paintYellow', (0.20, 0.02, (z1 - z0) - 0.2), (0, yr - 0.075, (z0 + z1) / 2), bevel=0.004, name='crane-flange')
    zt = 3.6
    kit.box('crateOrange', (0.34, 0.22, 0.46), (0, yr - 0.20, zt), bevel=0.03, name='crane-trolley')
    kit.rev('metalDark', [(0.0, 0.0), (0.09, 0.0), (0.09, 0.14), (0.0, 0.14)], (-0.07, yr - 0.38, zt), (1, 0, 0), 16, 'crane-drum')
    kit.begin('crane-hook', (0, yr - 0.38, zt))
    kit.tube('metal', [(0, yr - 0.38, zt), (0, yr - 0.72, zt)], 0.008, 6, 'crane-cable')
    kit.box('paintYellow', (0.12, 0.12, 0.08), (0, yr - 0.76, zt), bevel=0.02, name='crane-block')
    kit.tube('metalDark', [(0, yr - 0.80, zt), (0, yr - 0.90, zt), (0.05, yr - 0.95, zt), (0.07, yr - 0.90, zt)], 0.014, 8, 'hook-tube')
    kit.end()
    # ---------------- cargo
    crate(kit, -1.42, 0.25, (1.10, 1.00, 1.20), 'crateGrey', tint=0.4)
    crate(kit, -1.42, 0.25, (0.80, 0.55, 0.90), 'crateOrange', y=1.0, rot_y=0.12, tint=0.6)
    crate(kit, -1.45, 1.62, (1.00, 0.72, 1.10), 'crateGrey', rot_y=-0.05, tint=0.7)
    crate(kit, 1.40, 0.35, (1.15, 1.25, 1.30), 'crateGrey', tint=0.25)
    crate(kit, 1.50, 1.75, (0.90, 0.60, 0.85), 'crateOrange', rot_y=0.2, tint=0.5)
    # pressure tanks in a cradle (port, aft)
    for k in range(3):
        zc = 3.55 + 0.52 * k
        kit.rev('panelWhite', [(0.0, 0.0), (0.12, 0.02), (0.21, 0.11), (0.21, 1.25), (0.12, 1.36), (0.05, 1.39), (0.05, 1.46), (0.0, 1.46)],
                (-1.80, 0.10, zc), (0, 1, 0), 20, 'tank')
        kit.rev('metal', [(0.0, 1.46), (0.035, 1.46), (0.035, 1.52), (0.0, 1.52)], (-1.80, 0.10, zc), (0, 1, 0), 10, 'tank-valve')
    kit.box('metalDark', (0.50, 0.10, 1.66), (-1.80, 0.05, 4.07), bevel=0.012, name='tank-cradle')
    for yy in (0.55, 1.15):
        kit.box('metalDark', (0.06, 0.05, 1.66), (-1.57, yy, 4.07), bevel=0.01, name='tank-bar')
        kit.box('fabricOrange', (0.02, 0.045, 1.62), (-1.545, yy, 4.07), bevel=0.004, name='tank-strap')
    dress_hold(kit, bays)
    # ---------------- workbench (starboard, aft)
    bx, bz0, bz1 = 1.74, 3.45, 5.15
    kit.box('metal', (0.74, 0.05, bz1 - bz0), (bx, 0.90, (bz0 + bz1) / 2), bevel=0.01, name='bench-top')
    for zz in (bz0 + 0.06, bz1 - 0.06):
        for xx in (bx - 0.31, bx + 0.31):
            kit.box('metalDark', (0.05, 0.875, 0.05), (xx, 0.4375, zz), bevel=0.008, name='bench-leg')
    kit.box('panelGrey', (0.66, 0.56, 0.74), (bx, 0.48, bz0 + 0.46), bevel=0.012, name='bench-drawers')
    for k in range(3):
        kit.box('panelDark', (0.012, 0.15, 0.68), (bx - 0.336, 0.30 + 0.18 * k, bz0 + 0.46), bevel=0.005, name='bench-drawer')
        kit.box('metal', (0.02, 0.016, 0.20), (bx - 0.35, 0.33 + 0.18 * k, bz0 + 0.46), bevel=0.004, name='pull')
    kit.box('metalDark', (0.04, 0.62, bz1 - bz0), (w - 0.03, 1.36, (bz0 + bz1) / 2), bevel=0.01, name='pegboard')
    kit.box('screen', (0.006, 0.30, 0.46), (w - 0.056, 1.42, bz0 + 0.40), bevel=0.0, name='bench-screen')
    kit.box('lampWarm', (0.03, 0.012, 1.3), (w - 0.07, 1.70, (bz0 + bz1) / 2), bevel=0.003, name='bench-lamp')
    for k, (zz, hh) in enumerate(((bz0 + 0.95, 0.30), (bz0 + 1.07, 0.24), (bz0 + 1.19, 0.34), (bz0 + 1.31, 0.20))):
        kit.box('metal' if k % 2 else 'accent', (0.012, hh, 0.035), (w - 0.058, 1.36 + hh / 2 - 0.15, zz), bevel=0.004, name='tool')
    kit.box('crateOrange', (0.26, 0.16, 0.38), (bx + 0.1, 1.005, bz1 - 0.34), bevel=0.02, name='toolbox', tint=0.4)
    kit.box('metal', (0.03, 0.03, 0.22), (bx + 0.1, 1.10, bz1 - 0.34), bevel=0.008, name='toolbox-handle')
    kit.box('metalDark', (0.14, 0.12, 0.16), (bx - 0.22, 0.985, bz0 + 1.0), bevel=0.012, name='vise')
    kit.rev('panelDark', [(0.0, 0.0), (0.17, 0.0), (0.17, 0.03), (0.03, 0.05), (0.03, 0.42), (0.16, 0.44), (0.16, 0.50), (0.0, 0.50)],
            (bx - 0.05, 0.0, bz1 - 1.15), (0, 1, 0), 16, 'stool')
    # ---------------- hazard chevrons round the ramp mouth, status lamps
    for sx in (-1, 1):
        for k in range(9):
            kit.box('paintYellow' if k % 2 == 0 else 'panelDark', (0.012, 0.20, 0.10), (sx * (w - 0.006), 0.36 + 0.2 * k, z1 - 0.07),
                    bevel=0.0, name='hazard')
        kit.box('lampAmber', (0.03, 0.10, 0.05), (sx * 1.92, 2.12, z1 - 0.03), bevel=0.008, name='ramp-beacon')
    return bays


def build_bulkheads(kit, cockpit_outline):
    w = DIMS['rampHalfW']
    # B1: flight deck door
    bulkhead(kit, 'bulkhead-1', MID_Z0 - 0.05, 0.10, cockpit_outline, portal_poly(0.74, 0.0, 2.02), 'panelDark', 'panelGrey')
    portal_frame(kit, MID_Z0 - 0.05, 0.74, 0.0, 2.02, 0.22, lamp='lampStrip')
    # B2: mid-deck / hold pressure frame
    bulkhead(kit, 'bulkhead-2', (MID_Z1 + HOLD_Z0) / 2, HOLD_Z0 - MID_Z1, section_poly(HOLD_S, HOLD_Z0),
             portal_poly(0.98, 0.0, 2.10), 'panelGrey', 'panelDark')
    portal_frame(kit, MID_Z1 - 0.01, 0.98, 0.0, 2.10, 0.10)
    portal_frame(kit, HOLD_Z0 + 0.01, 0.98, 0.0, 2.10, 0.10, lamp='lampAmber')
    # B3: ramp mouth
    bulkhead(kit, 'bulkhead-3', HOLD_Z1 + 0.03, 0.06, section_poly(HOLD_S, HOLD_Z1),
             portal_poly(w - 0.02, 0.0, DIMS['rampTopY'] - 0.02, chamfer=0.16), 'panelDark', 'metalDark')
    portal_frame(kit, HOLD_Z1 - 0.02, w - 0.02, 0.0, DIMS['rampTopY'] - 0.02, 0.10, chamfer=0.16, t=0.11)
    # ramp tunnel: side walls, soffit, sill
    zh, yh, zt, yt = DIMS['rampHingeZ'] + 0.06, DIMS['rampHingeY'], DIMS['rampTopZ'], DIMS['rampTopY']
    q = []
    for sx in (-1, 1):
        q.append(((sx * w, yh, zh), (sx * w, yt, zt), (sx * w, yt, zh)))
        q.append(((sx * w, yh, zh), (sx * w, yt, zh), (sx * w, 0.0, zh - 0.06)))
    q.append(((-w, yt, zh), (w, yt, zh), (w, yt, zt), (-w, yt, zt)))
    q.append(((-w, 0.0, zh - 0.06), (w, 0.0, zh - 0.06), (w, yh, zh + 0.02), (-w, yh, zh + 0.02)))
    kit.quads('panelDark', q, toward=(0, 1.2, zh + 0.8), name='ramp-tunnel')


def pipe_run(kit, S, jf, side, z0, z1, radius, inset, key, clamp_every=0.62):
    """a pipe following the liner at cell jf, with clamp brackets"""
    pts = [S.point(z0 + (z1 - z0) * k / 8, jf, side, inset) for k in range(9)]
    kit.tube(key, pts, radius, 10, 'pipe')
    z = z0 + 0.2
    while z < z1 - 0.1:
        p, n = S.point(z, jf, side, inset), S.normal(z, jf, side)
        q = S.point(z, jf, side, 0.004)
        kit.tube('metalDark', [q, p - n * radius * 1.1], radius * 0.5 + 0.004, 6, 'pipe-bracket')
        kit.rev('metalDark', [(radius * 1.35, -0.012), (radius * 1.35, 0.012)], p, (0, 0, 1), 12, 'pipe-clamp')
        z += clamp_every


def build_lockers(kit):
    """Two recessed lockers in the forward bay: an EVA suit to starboard,
    stowage shelves to port.  Each has a pair of doors, one node per leaf,
    hinged on its outer edge (the game swings them about y)."""
    w, yD, yC = MID['w'], MID['yD'], MID['yC']
    z0, z1 = LOCKER
    zm = (z0 + z1) / 2
    depth = 0.46
    for sx in (-1, 1):
        xo, xb = sx * w, sx * (w + depth)
        kit.alcove('panelGrey', min(xo, xb), max(xo, xb), yD, yC, z0, z1, xo)
        for zz in (z0, z1):
            kit.box('metalDark', (0.05, yC - yD + 0.05, 0.05), (sx * (w - 0.012), (yC + yD) / 2, zz), bevel=0.012, name='locker-frame')
        for yy in (yD, yC):
            kit.box('metalDark', (0.05, 0.05, z1 - z0 + 0.05), (sx * (w - 0.012), yy, zm), bevel=0.012, name='locker-frame')
        kit.box('lampWarm', (0.02, 0.012, z1 - z0 - 0.14), (sx * (w + 0.10), yC - 0.02, zm), bevel=0.0, name='locker-lamp')
        if sx > 0:
            # EVA suit on its rack: torso, helmet, arms, legs, life-support pack
            cx = sx * (w + 0.24)
            kit.box('metalDark', (0.06, 0.06, z1 - z0 - 0.06), (sx * (w + depth - 0.05), 1.56, zm), bevel=0.01, name='suit-rail')
            kit.box('panelWhite', (0.26, 0.50, 0.42), (cx, 1.20, zm), bevel=0.06, seg=3, name='suit-torso')
            kit.box('fabricOrange', (0.27, 0.06, 0.43), (cx, 1.02, zm), bevel=0.02, name='suit-belt')
            kit.box('panelGrey', (0.16, 0.42, 0.34), (sx * (w + 0.40), 1.24, zm), bevel=0.04, seg=3, name='suit-pack')
            kit.rev('panelWhite', [(0.0, -0.13), (0.10, -0.12), (0.135, -0.04), (0.135, 0.05), (0.10, 0.12), (0.0, 0.14)],
                    (cx - sx * 0.02, 1.62, zm), (0, 1, 0), 24, 'suit-helmet')
            # domed gold visor on the helmet's face
            kit.rev('heat', [(0.105, 0.0), (0.098, 0.03), (0.075, 0.058), (0.04, 0.072), (0.0, 0.076)],
                    (cx - sx * 0.09, 1.63, zm), (-sx, 0, 0), 24, 'suit-visor')
            for dz in (-0.25, 0.25):
                kit.tube('panelWhite', [(cx, 1.40, zm + dz * 0.95), (cx - sx * 0.02, 1.10, zm + dz * 1.05), (cx - sx * 0.05, 0.86, zm + dz)],
                         0.055, 10, 'suit-arm')
                kit.box('fabric', (0.08, 0.10, 0.08), (cx - sx * 0.05, 0.80, zm + dz), bevel=0.03, name='suit-glove')
            for dz in (-0.10, 0.10):
                kit.tube('panelWhite', [(cx, 0.96, zm + dz), (cx, 0.55, zm + dz * 1.1), (cx, 0.30, zm + dz * 1.1)], 0.07, 10, 'suit-leg')
                kit.box('rubber', (0.14, 0.12, 0.26), (cx - sx * 0.03, yD + 0.08, zm + dz * 1.1), bevel=0.04, seg=3, name='suit-boot')
            kit.label('EVA  SUIT  1', 0.035, (sx * (w + depth - 0.003), 1.86 - 0.12, zm), (0, 0, 1) if sx > 0 else (0, 0, -1), (0, 1, 0), 'decal')
        else:
            # stowage: three shelves of cases, bags and canisters
            for k, yy in enumerate((0.55, 1.05, 1.50)):
                kit.box('metalDark', (depth - 0.04, 0.025, z1 - z0 - 0.04), (sx * (w + depth / 2), yy, zm), bevel=0.006, name='shelf')
                kit.box('crateOrange' if k == 1 else 'crateGrey', (0.30, 0.22, 0.26), (sx * (w + 0.22), yy + 0.125, z0 + 0.20),
                        bevel=0.02, name='case', tint=0.2 + 0.25 * k)
                kit.box('fabric', (0.28, 0.20, 0.30), (sx * (w + 0.24), yy + 0.11, zm + 0.08), bevel=0.06, seg=3, name='bag')
                for j in range(2):
                    kit.rev('panelWhite' if (j + k) % 2 else 'accent', [(0.0, 0.0), (0.05, 0.0), (0.05, 0.20), (0.03, 0.23), (0.0, 0.23)],
                            (sx * (w + 0.20 + 0.11 * j), yy + 0.013, z1 - 0.16), (0, 1, 0), 12, 'canister')
        # the doors: two leaves hinged at the outer edges, opening into the corridor
        for k, (za, zb) in enumerate(((z0, zm), (zm, z1))):
            hinge_z = za if k == 0 else zb
            tag = 'locker-%s-%d' % ('stbd' if sx > 0 else 'port', k)
            kit.begin(tag, (sx * (w - 0.02), 1.0, hinge_z))
            zc = (za + zb) / 2
            kit.box('panelGrey', (0.028, yC - yD - 0.04, zb - za - 0.012), (sx * (w - 0.02), (yC + yD) / 2, zc), bevel=0.008,
                    name='locker-door', tint=0.3 + 0.3 * k)
            free_z = zb - 0.06 if k == 0 else za + 0.06
            kit.box('metal', (0.03, 0.20, 0.024), (sx * (w - 0.045), 1.05, free_z), bevel=0.008, name='locker-pull')
            for j in range(6):
                kit.box('metalDark', (0.006, 0.012, (zb - za) * 0.6), (sx * (w - 0.036), 1.62 - 0.03 * j, zc), bevel=0.002, name='locker-vent')
            if k == 0:
                kit.label('EVA  LOCKER  S-1' if sx > 0 else 'STOWAGE  P-1', 0.034,
                          (sx * (w - 0.036), 1.38, zc), (0, 0, 1) if sx > 0 else (0, 0, -1), (0, 1, 0), 'decal')
            kit.end()


def dress_hold(kit, bays):
    """what makes the hold a working space: services overhead, kit on the walls"""
    z0, z1 = HOLD_Z0 + 0.12, HOLD_Z1 - 0.25
    for side in (1, -1):
        pipe_run(kit, HOLD_S, 7.5, side, z0, z1, 0.045, 0.16, 'paintYellow')
        pipe_run(kit, HOLD_S, 9.2, side, z0, z1, 0.030, 0.13, 'metal')
        pipe_run(kit, HOLD_S, 10.6, side, z0, z1, 0.022, 0.11, 'accent')
        pipe_run(kit, HOLD_S, 23.5, side, z0, z1, 0.028, 0.11, 'metalDark')
    w = HOLD['w']
    for i in range(5):
        zz = HOLD_Z0 + HOLD_BAY * (i + 0.5)
        for sx in (-1, 1):
            x = sx * (w - 0.02)
            # emergency lamp over every bay
            kit.box('metalDark', (0.05, 0.10, 0.22), (x, 2.02, zz), bevel=0.012, name='bay-lamp-housing')
            kit.box('lampAmber' if i % 2 else 'lampWarm', (0.012, 0.05, 0.16), (x - sx * 0.026, 2.02, zz), bevel=0.004,
                    name='bay-lamp')
            if (i + (sx > 0)) % 2 == 0:
                # junction box with conduit up to the pipe run
                kit.box('panelGrey', (0.10, 0.34, 0.26), (x - sx * 0.04, 1.18, zz + 0.32), bevel=0.012, name='junction-box')
                kit.box('btnGreen', (0.008, 0.02, 0.02), (x - sx * 0.092, 1.30, zz + 0.40), bevel=0.003, name='junction-lamp')
                kit.tube('rubber', [(x - sx * 0.04, 1.35, zz + 0.32), (x - sx * 0.04, 1.62, zz + 0.32),
                                    (x - sx * 0.06, 1.80, zz + 0.32)], 0.014, 6, 'conduit')
            else:
                # cargo net across the upper bay
                for k in range(6):
                    yy = 1.66 + k * 0.06
                    kit.tube('fabric', [(x - sx * 0.035, yy, zz - 0.5), (x - sx * 0.05, yy, zz + 0.5)], 0.006, 4, 'net')
                for k in range(9):
                    zk = zz - 0.5 + k * 0.125
                    kit.tube('fabric', [(x - sx * 0.035, 1.64, zk), (x - sx * 0.05, 2.0, zk)], 0.006, 4, 'net')
                kit.box('crateOrange', (0.06, 0.22, 0.40), (x - sx * 0.07, 1.80, zz), bevel=0.02, name='netted-bag', tint=0.3)
    # intercom by the mid-deck door and a fire-suppression station by the ramp
    for (x, zz, key) in ((-w + 0.03, HOLD_Z0 + 0.55, 'screen'), (w - 0.03, HOLD_Z1 - 0.65, 'lampRed')):
        kit.box('panelDark', (0.05, 0.36, 0.26), (x, 1.40, zz), bevel=0.012, name='wall-station')
        kit.box(key, (0.006, 0.14, 0.18), (x - (0.026 if x > 0 else -0.026), 1.45, zz), bevel=0.0, name='wall-station-face')
    # floor hatches with recessed handles
    for zz in (1.2, 3.1):
        kit.box('deck', (0.92, 0.012, 0.92), (0, 0.006, zz), bevel=0.004, name='floor-hatch', tint=0.8)
        for dx in (-0.3, 0.3):
            kit.box('metal', (0.12, 0.014, 0.03), (dx, 0.012, zz + 0.38), bevel=0.004, name='hatch-handle')
        kit.label('ACCESS', 0.06, (0, 0.014, zz), (1, 0, 0), (0, 0, -1), 'decalLight')


def dress_mid(kit):
    """the lived-in layer of the mid-deck"""
    w = MID['w']
    for side in (1, -1):
        pipe_run(kit, MID_S, 7.0, side, MID_Z0 + 0.15, MID_Z1 - 0.12, 0.022, 0.07, 'metal', 0.55)
    na, nb = NICHE
    # personal items in the bunks: photos, a jacket, boots
    xb = 2.10
    ymid = (MID['yD'] + MID['yC']) / 2 + 0.02
    for k, (yy, zz) in enumerate(((MID['yD'] + 0.36, nb - 0.25), (ymid + 0.38, nb - 0.30))):
        kit.box('panelWhite', (0.006, 0.10, 0.075), (xb - 0.005, yy, zz), bevel=0.0, name='photo', tint=0.2 + 0.5 * k)
        kit.box('screen', (0.003, 0.08, 0.055), (xb - 0.009, yy, zz), bevel=0.0, name='photo-face')
    # a jacket on a hook beside the bunks (aft of the alcove, clear of the lockers)
    kit.box('fabricOrange', (0.06, 0.56, 0.36), (w - 0.06, 1.40, nb + 0.28), bevel=0.04, seg=3, name='jacket')
    kit.rev('metal', [(0.012, 0.0), (0.012, 0.05), (0.0, 0.06)], (w - 0.005, 1.70, nb + 0.28), (-1, 0, 0), 8, 'hook')
    # galley: a screen with the menu, a towel, a plant
    xg = -2.06
    kit.box('panelDark', (0.02, 0.22, 0.32), (xg + 0.01, 1.62, (na + nb) / 2), bevel=0.008, name='galley-screen')
    kit.box('screen', (0.004, 0.18, 0.28), (xg + 0.022, 1.62, (na + nb) / 2), bevel=0.0, name='galley-screen-face')
    kit.box('fabric', (0.03, 0.30, 0.16), (xg + 0.64, 0.66, nb - 0.18), bevel=0.012, seg=3, name='towel')
    kit.rev('panelGrey', [(0.0, 0.0), (0.05, 0.0), (0.06, 0.10), (0.0, 0.10)], (xg + 0.18, 0.80, nb - 0.12), (0, 1, 0), 12, 'pot')
    for k in range(5):
        a = k * 1.256
        kit.box('btnGreen', (0.012, 0.11, 0.04), (xg + 0.18 + math.cos(a) * 0.03, 0.94, nb - 0.12 + math.sin(a) * 0.03), bevel=0.004,
                rot=Matrix.Rotation(0.3, 3, 'X') @ Matrix.Rotation(a, 3, 'Y'), name='leaf')
    # hazard-striped door surround into the flight deck
    for k in range(8):
        for sx in (-1, 1):
            kit.box('paintYellow' if k % 2 == 0 else 'panelDark', (0.06, 0.12, 0.012),
                    (sx * 0.84, 0.10 + 0.24 * k, MID_Z0 + 0.012), bevel=0.0, name='hazard')


def build_labels(kit):
    PX, SX, UP = (0, 0, -1), (0, 0, 1), (0, 1, 0)     # reading direction on the port / starboard wall
    wm, wh = MID['w'] - 0.002, HOLD['w'] - 0.002
    b0 = MID_Z0 + MID_BAY * 0.5
    za = MID_Z0 + MID_BAY * 4.5
    kit.label('O2  RESERVE  35 MPa', 0.04, (wm - 0.05, 1.66, za), SX, UP, 'decalLight')
    kit.label('ENV  CTRL', 0.04, (-wm + 0.045, 1.63, za), PX, UP, 'decalLight')
    kit.label('FLIGHT  DECK', 0.07, (0, 2.115, MID_Z0 + 0.001), (1, 0, 0), UP)
    kit.label('CARGO  HOLD', 0.07, (0, 2.15, MID_Z1 - 0.001), (-1, 0, 0), UP)
    kit.label('MID  DECK', 0.08, (0, 2.24, HOLD_Z0 + 0.001), (1, 0, 0), UP, 'decalLight')
    for i in range(5):
        zz = HOLD_Z0 + HOLD_BAY * (i + 0.5)
        kit.label('BAY  %d' % (i + 1), 0.11, (-wh, 1.72, zz), PX, UP, 'decalLight')
        kit.label('BAY  %d' % (i + 1), 0.11, (wh, 1.72, zz), SX, UP, 'decalLight')
        kit.label('MAX  1200 KG', 0.035, (-wh, 1.58, zz), PX, UP, 'decalLight')
        kit.label('MAX  1200 KG', 0.035, (wh, 1.58, zz), SX, UP, 'decalLight')
    kit.label('RAMP  -  CONFIRM  FIELD  BEFORE  OPENING', 0.05, (0, 2.42, HOLD_Z1 - 0.001), (-1, 0, 0), UP, 'decalLight')
    kit.label('KEEP  CLEAR', 0.16, (0, 0.004, HOLD_Z1 - 0.75), (-1, 0, 0), (0, 0, 1), 'paintYellow')
    kit.label('HX-2291', 0.10, (0, 0.004, HOLD_Z0 + 0.55), (1, 0, 0), (0, 0, -1), 'decalLight')
    # fasteners along every rib flange and round the pressure frame
    for i in range(6):
        zz = min(max(HOLD_Z0 + HOLD_BAY * i, HOLD_Z0 + 0.07), HOLD_Z1 - 0.07)
        for side in (1, -1):
            for jf in [j * 0.5 for j in range(1, int(J_E * 2))]:
                if int(jf * 2) % 3:
                    continue
                for dz in (-0.075, 0.075):
                    p = HOLD_S.point(zz + dz, jf, side, 0.105)
                    kit.bolt(p, -HOLD_S.normal(zz + dz, jf, side), 0.011)


def door_leaves(kit, n, z, half_w, y1, chamfer, thick):
    """two sliding leaves filling a portal; each slides sideways into the
    bulkhead slab (the game moves them along x)"""
    for sx in (-1, 1):
        tag = 'door-%d-%s' % (n, 'stbd' if sx > 0 else 'port')
        x0, x1 = 0.0, sx * (half_w + 0.03)
        pts = [(x0, 0.0), (x1, 0.0), (x1, y1 - chamfer), (x1 - sx * chamfer, y1), (x0, y1)]
        q = []
        for zz in (z - thick / 2, z + thick / 2):
            q.append(tuple((x, y, zz) for x, y in pts))
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            q.append(((a[0], a[1], z - thick / 2), (b[0], b[1], z - thick / 2), (b[0], b[1], z + thick / 2), (a[0], a[1], z + thick / 2)))
        kit.begin(tag, (sx * half_w / 2, 0.0, z))
        kit.quads('panelGrey', q, away=(sx * half_w / 2, y1 / 2, z), name='door-leaf')
        for zz in (z - thick / 2 - 0.004, z + thick / 2 + 0.004):
            kit.box('lampCyan', (0.012, y1 * 0.72, 0.006), (sx * 0.03, y1 * 0.45, zz), bevel=0.0, name='door-edge-lamp')
            kit.box('panelDark', (half_w * 0.62, 0.36, 0.008), (sx * half_w * 0.55, 1.30, zz), bevel=0.003, name='door-window')
            for k in range(3):
                kit.box('paintYellow' if k % 2 == 0 else 'panelDark', (half_w * 0.9, 0.05, 0.006),
                        (sx * half_w * 0.5, 0.10 + 0.05 * k, zz), bevel=0.0, name='door-kick')
        kit.end()


def dress_dynamic(kit):
    """interior parts the game animates"""
    # sliding doors at the flight-deck and hold bulkheads
    door_leaves(kit, 1, MID_Z0 - 0.05, 0.74, 2.02, 0.22, 0.035)
    door_leaves(kit, 2, (MID_Z1 + HOLD_Z0) / 2, 0.98, 2.10, 0.22, 0.045)
    # extractor fans: two in the hold ceiling, one over the mid-deck
    yT = HOLD['yTop']
    fans = [((-0.85, yT, HOLD_Z0 + HOLD_BAY * 1.5), 0.22), ((0.85, yT, HOLD_Z0 + HOLD_BAY * 3.5), 0.22),
            ((0.0, MID['yTop'], MID_Z0 + MID_BAY * 2.5), 0.16)]
    for i, (c, r) in enumerate(fans):
        c = Vector(c)
        kit.rev('metalDark', [(r + 0.05, 0.0), (r + 0.05, -0.03), (r + 0.01, -0.04), (r + 0.01, -0.10), (r, -0.10), (r, 0.0)],
                c, (0, 1, 0), 28, 'fan-housing')
        kit.begin('fan-%d' % i, c - Vector((0, 0.07, 0)))
        kit.rev('metal', [(0.0, -0.05), (0.045, -0.05), (0.05, -0.085), (0.0, -0.09)], c, (0, 1, 0), 16, 'fan-hub')
        for k in range(7):
            a = 2 * math.pi * k / 7
            rot = Matrix.Rotation(a, 3, 'Y') @ Matrix.Rotation(math.radians(28), 3, 'X')
            kit.box('metalDark', (r * 0.82, 0.006, 0.07), c + Matrix.Rotation(a, 3, 'Y') @ Vector((r * 0.5, -0.07, 0)),
                    bevel=0.0, rot=rot, name='fan-blade')
        kit.end()
        for k in range(5):
            kit.box('metal', (2 * r + 0.02, 0.008, 0.012), c + Vector((0, -0.105, -r + r * k / 2)), bevel=0.0, name='fan-grille')
    # cabin light switch on the environment panel
    w = MID['w']
    za = MID_Z0 + MID_BAY * 4.5
    base = Vector((-(w - 0.04), 1.05, za + 0.12))
    kit.box('panelGrey', (0.02, 0.11, 0.07), base, bevel=0.006, name='switch-plate')
    kit.label('CABIN', 0.022, base + Vector((0.012, 0.075, 0)), (0, 0, -1), (0, 1, 0), 'decalLight')
    kit.begin('light-switch', base + Vector((0.012, 0, 0)))
    kit.box('metal', (0.03, 0.06, 0.02), base + Vector((0.02, 0.0, 0)), bevel=0.006, name='switch-rocker')
    kit.box('btnAmber', (0.004, 0.01, 0.01), base + Vector((0.036, 0.018, 0)), bevel=0.0, name='switch-tell')
    kit.end()


def build(M, col, cockpit_outline):
    kit = Kit(M, col)
    dress_dynamic(kit)
    build_mid(kit)
    build_hold(kit)
    build_bulkheads(kit, cockpit_outline)
    dress_mid(kit)
    build_labels(kit)
    return kit.parts, kit.movers
