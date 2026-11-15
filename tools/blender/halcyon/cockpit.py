"""HALCYON VII flight deck.

The liner is the hull's own surface 10 cm in, so the glazing seen from the
seat is the glazing seen from outside.  A single command seat sits on the
centreline inside a U of work surfaces: main panel ahead, a console at each
hand, a ledge out to the side windows.  Screens are separate nodes named
`mfd-N` so the game can put live instruments on them.
"""
import math
import bpy
from mathutils import Matrix, Vector

from . import prims
from .common import G, new_object
from .design import DIMS
from .exterior import HULL, PANES, GZ0, GZ1
from .interior import Kit
from .loft import section_xy, J_C, JMAX

INSET = 0.10
CZ0, CZ1 = -10.30, -5.45
SEAT_Z = DIMS['seatZ']


def _rx(deg):
    return Matrix.Rotation(math.radians(deg), 3, 'X')


def _ry(deg):
    return Matrix.Rotation(math.radians(deg), 3, 'Y')


def in_pane(z, jf):
    return any(a <= z <= b and c <= jf <= d for a, b, c, d in PANES)


def floor_x(z):
    return HULL.section(z)['w'] - INSET


def outline(z):
    """liner section above the deck, closed along the floor"""
    s = HULL.section(z)
    right = []
    for k in range(JMAX * 2 + 1):
        j = k / 2
        if section_xy(s, j)[1] < 0.0:
            break
        p = HULL.point(z, j, 1, INSET)
        right.append((p.x, p.y))
    right.append((floor_x(z), 0.0))
    return right + [(-x, y) for x, y in right[::-1]]


def mfd(kit, idx, kind, c, R, w, h, bezel=0.022):
    """screen node + bezel.  R columns: right, up, normal (game space)."""
    r, u, n = (R @ Vector(a) for a in ((1, 0, 0), (0, 1, 0), (0, 0, 1)))
    c = Vector(c)
    kit.box('panelDark', (w + 2 * bezel, h + 2 * bezel, 0.03), c - n * 0.016, bevel=0.006, rot=R, name='mfd-bezel')
    me = bpy.data.meshes.new('mfd')
    me.from_pydata([(-0.5, -0.5, 0), (0.5, -0.5, 0), (0.5, 0.5, 0), (-0.5, 0.5, 0)], [], [(0, 1, 2, 3)])
    me.uv_layers.new(name='UVMap')
    for loop, uv in zip(me.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        me.uv_layers[0].data[loop.index].uv = uv
    me.materials.append(kit.M['screen'])
    obj = new_object('mfd-%d-%s' % (idx, kind), me, kit.col)
    gr, gu, gn, gc = G(*r) * w, G(*u) * h, G(*n), G(*(c + n * 0.002))
    obj.matrix_world = Matrix(((gr.x, gu.x, gn.x, gc.x), (gr.y, gu.y, gn.y, gc.y), (gr.z, gu.z, gn.z, gc.z), (0, 0, 0, 1)))
    kit.screens.append(obj)
    return obj


def switch_row(kit, c, R, n, pitch=0.034, lit=0.3, seed=1):
    """toggle switches with guards; a few indicator lamps among them"""
    r, u, nn = (R @ Vector(a) for a in ((1, 0, 0), (0, 1, 0), (0, 0, 1)))
    c = Vector(c)
    for k in range(n):
        p = c + r * ((k - (n - 1) / 2) * pitch)
        h = (k * 7 + seed * 13) % 10
        if h < lit * 10:
            key = ('btnGreen', 'btnAmber', 'btnWhite')[(k + seed) % 3]
            kit.box(key, (0.016, 0.016, 0.008), p + nn * 0.004, bevel=0.003, rot=R, name='lamp')
        else:
            kit.box('metalDark', (0.014, 0.014, 0.006), p + nn * 0.003, bevel=0.002, rot=R, name='switch-base')
            tilt = R @ _rx(22 if h % 2 else -22)
            kit.box('metal', (0.006, 0.006, 0.022), p + nn * 0.012 + u * (0.004 if h % 2 else -0.004), bevel=0.002,
                    rot=tilt, name='toggle')


def build_shell(kit):
    M = kit.M

    def region(z, jf, side):
        if in_pane(z, jf):
            return None
        y = section_xy(HULL.section(z), jf)[1]
        if y < -0.01:
            return None
        if GZ0 - 0.1 < z < GZ1 + 0.1 and jf < 13.9:
            return 'trim'
        if z > GZ1 and jf < J_C:
            return 'panelGrey'
        return 'panelDark'

    seams = [('r', z, 0.0, float(JMAX)) for z in (-9.4, -8.28, -7.2, -6.2)]
    seams += [('l', 14.5, CZ0, CZ1), ('l', 18.5, CZ0, CZ1)]
    z_extra = sorted({v for p in PANES for v in p[:2]})
    u_extra = sorted({v for p in PANES for v in p[2:]} | {13.9})
    kit.add(HULL.build('cockpit-liner', kit.col, seams=seams, region=region, mats=M, flip=True, inset=INSET,
                       z_range=(CZ0, CZ1), z_extra=z_extra, u_extra=u_extra, tile=1.5,
                       seam_half=0.004, seam_depth=0.005))
    # window reveals: close the gap between skin and liner round every pane
    q = []
    N = 10
    for (a, b, c, d) in PANES:
        for side in (1, -1):
            edges = [[(a + (b - a) * i / N, d) for i in range(N + 1)]]            # outboard edge
            if c > 0:
                edges.append([(a + (b - a) * i / N, c) for i in range(N + 1)])    # inboard edge
            j0 = c
            edges.append([(a, j0 + (d - j0) * i / N) for i in range(N + 1)])
            edges.append([(b, j0 + (d - j0) * i / N) for i in range(N + 1)])
            for e in edges:
                o = [HULL.point(z, j, side, 0.0) for z, j in e]
                i_ = [HULL.point(z, j, side, INSET) for z, j in e]
                q += prims.strip_between(o, i_)
    obj = prims.quads('cockpit-reveal', kit.col, q, M['trim'])
    obj.data.materials[0] = M['trimTwoSided']
    kit.add(obj)
    # deck, nose bulkhead
    zs = [CZ0 + (CZ1 - CZ0) * i / 14 for i in range(15)]
    fq = [((-floor_x(z0), 0, z0), (floor_x(z0), 0, z0), (floor_x(z1), 0, z1), (-floor_x(z1), 0, z1))
          for z0, z1 in zip(zs[:-1], zs[1:])]
    kit.quads('deck', fq, away=(0, -5, -8), name='cockpit-deck')
    kit.box('deckMat', (1.0, 0.006, 2.3), (0, 0.003, -6.45), bevel=0.0, name='cockpit-mat')
    o = outline(CZ0)
    fan = [((0.0, 0.3, CZ0), (o[i][0], o[i][1], CZ0), (o[i + 1][0], o[i + 1][1], CZ0)) for i in range(len(o) - 1)]
    kit.quads('panelDark', fan, away=(0, 0.3, -20), name='nose-bulkhead')


def build_seat(kit):
    z = -7.78
    for sx in (-1, 1):
        kit.box('metal', (0.045, 0.03, 1.05), (sx * 0.20, 0.015, z + 0.05), bevel=0.006, name='seat-rail')
    kit.box('metalDark', (0.36, 0.26, 0.42), (0, 0.16, z), bevel=0.03, name='seat-pedestal')
    kit.rev('metal', [(0.0, 0.0), (0.07, 0.0), (0.07, 0.10), (0.0, 0.10)], (0, 0.28, z), (0, 1, 0), 16, 'seat-swivel')
    kit.box('panelDark', (0.56, 0.06, 0.56), (0, 0.41, z), bevel=0.025, rot=_rx(5), name='seat-pan-shell')
    kit.box('cushion', (0.48, 0.08, 0.48), (0, 0.47, z - 0.01), bevel=0.03, seg=3, rot=_rx(5), name='seat-cushion')
    for sx in (-1, 1):
        kit.box('cushion', (0.07, 0.10, 0.44), (sx * 0.265, 0.49, z), bevel=0.03, seg=3, rot=_rx(5), name='seat-bolster')
    back = _rx(12)
    bc = Vector((0, 0.95, z + 0.33))
    kit.box('panelDark', (0.56, 0.92, 0.06), bc + back @ Vector((0, 0, 0.05)), bevel=0.025, rot=back, name='seat-back-shell')
    kit.box('cushion', (0.44, 0.34, 0.07), bc + back @ Vector((0, -0.24, -0.01)), bevel=0.03, seg=3, rot=back, name='seat-lumbar')
    kit.box('cushion', (0.44, 0.40, 0.07), bc + back @ Vector((0, 0.15, -0.01)), bevel=0.03, seg=3, rot=back, name='seat-back')
    for sx in (-1, 1):
        kit.box('cushion', (0.07, 0.72, 0.11), bc + back @ Vector((sx * 0.255, -0.05, -0.03)), bevel=0.03, seg=3, rot=back,
                name='seat-wing')
        kit.box('fabricOrange', (0.045, 0.66, 0.010), bc + back @ Vector((sx * 0.12, 0.02, -0.052)), bevel=0.002, rot=back,
                name='harness')
        kit.box('panelDark', (0.085, 0.045, 0.42), (sx * 0.335, 0.70, z - 0.02), bevel=0.018, name='armrest')
        kit.box('metalDark', (0.04, 0.24, 0.05), (sx * 0.335, 0.56, z + 0.14), bevel=0.01, name='armrest-post')
    kit.box('cushion', (0.30, 0.20, 0.09), bc + back @ Vector((0, 0.50, -0.03)), bevel=0.035, seg=3, rot=back, name='headrest')
    kit.box('metal', (0.10, 0.03, 0.05), bc + back @ Vector((0, -0.05, -0.058)), bevel=0.008, rot=back, name='harness-buckle')
    # sidestick on the right armrest, throttle on the left console (see consoles)
    kit.rev('rubber', [(0.0, 0.0), (0.035, 0.0), (0.03, 0.03), (0.0, 0.03)], (0.335, 0.722, z - 0.20), (0, 1, 0), 12, 'stick-boot')
    kit.box('panelDark', (0.034, 0.13, 0.04), (0.335, 0.80, z - 0.21), bevel=0.012, rot=_rx(-12), name='stick-grip')
    kit.box('btnAmber', (0.012, 0.012, 0.012), (0.335, 0.862, z - 0.235), bevel=0.003, name='stick-hat')


def build_panels(kit):
    eye_y, eye_z = DIMS['eyeY'], DIMS['eyeZ']
    # ---------------- main instrument panel
    tilt = _rx(-18)
    pc = Vector((0, 0.80, -9.18))
    kit.box('panelDark', (1.96, 0.50, 0.26), pc - tilt @ Vector((0, 0, 0.13)), bevel=0.02, rot=tilt, name='main-panel')
    kit.box('panelDark', (1.50, 0.56, 0.5), (0, 0.28, -9.42), bevel=0.02, name='panel-plinth')
    face = lambda x, y: pc + tilt @ Vector((x, y, 0.0))  # noqa: E731
    mfd(kit, 0, 'attitude', face(0, 0.03), tilt, 0.50, 0.34)
    for sx, kind, idx in ((-1, 'radar', 1), (1, 'nav', 2)):
        R = tilt @ _ry(-sx * 12)
        mfd(kit, idx, kind, face(sx * 0.60, 0.03) + Vector((0, 0, 0.055)), R, 0.42, 0.30)
    switch_row(kit, face(0, -0.20), tilt, 14, seed=2)
    for sx in (-1, 1):
        switch_row(kit, face(sx * 0.60, -0.185) + Vector((0, 0, 0.05)), tilt @ _ry(-sx * 12), 10, seed=3 + sx)
        kit.rev('metalDark', [(0.0, 0.0), (0.024, 0.0), (0.02, 0.022), (0.0, 0.022)], face(sx * 0.90, 0.16) + Vector((0, 0, 0.09)),
                tilt @ Vector((0, 0, 1)), 14, 'knob')
        kit.rev('metalDark', [(0.0, 0.0), (0.024, 0.0), (0.02, 0.022), (0.0, 0.022)], face(sx * 0.90, 0.06) + Vector((0, 0, 0.09)),
                tilt @ Vector((0, 0, 1)), 14, 'knob')
    # glareshield from the panel top to the windscreen base, lit from beneath
    top = face(0, 0.26)
    base_y = HULL.section(GZ0)['yTop'] - INSET - 0.02
    dz, dy = GZ0 - 0.02 - top.z, base_y - top.y
    Lg = math.hypot(dz, dy)
    gs = _rx(math.degrees(math.atan2(dy, -dz)))
    mid = Vector((0, (top.y + base_y) / 2 + 0.012, (top.z + GZ0 - 0.02) / 2))
    kit.box('fabric', (2.30, 0.03, Lg + 0.10), mid, bevel=0.012, rot=gs, name='glareshield')
    kit.box('fabric', (2.04, 0.055, 0.06), top + Vector((0, 0.012, 0.02)), bevel=0.02, name='glareshield-lip')
    kit.box('lampWarm', (1.5, 0.008, 0.012), top + Vector((0, -0.022, -0.012)), bevel=0.0, name='panel-flood')
    # ---------------- side consoles and window ledges
    for sx in (-1, 1):
        cx = sx * 0.80
        kit.box('panelDark', (0.50, 0.62, 2.25), (cx, 0.31, -8.22), bevel=0.03, name='side-console')
        top_r = Matrix.Rotation(math.radians(-sx * 8), 3, 'Z')
        kit.box('panelGrey', (0.46, 0.02, 2.16), (cx, 0.632, -8.22), bevel=0.006, rot=top_r, name='console-top')
        R = top_r @ _rx(-62)
        mfd(kit, 3 if sx < 0 else 4, 'systems' if sx < 0 else 'comms', (cx, 0.74, -8.86), R, 0.30, 0.20)
        flat = top_r @ _rx(-90)
        for k, zz in enumerate((-8.52, -8.44, -8.36)):
            switch_row(kit, (cx, 0.646, zz), flat, 9, seed=5 + k + (sx > 0))
        # keypad
        for a in range(4):
            for b in range(3):
                kit.box('panelGrey' if (a + b) % 4 else 'btnWhite', (0.026, 0.008, 0.026),
                        (cx + (b - 1) * 0.036 + sx * 0.10, 0.648, -8.16 + a * 0.036), bevel=0.004, rot=top_r, name='key')
        # ledge out to the side wall, with equipment modules
        x_in, x_out = 1.05, floor_x(-8.0) - 0.02
        kit.box('panelDark', (x_out - x_in, 0.60, 2.9), (sx * (x_in + x_out) / 2, 0.30, -8.05), bevel=0.02, name='ledge')
        for k, zz in enumerate((-8.9, -8.3, -7.7, -7.1)):
            kit.box('panelGrey', (0.62, 0.10, 0.44), (sx * 1.60, 0.65, zz), bevel=0.015, name='module', tint=0.2 + 0.2 * k)
            switch_row(kit, (sx * 1.60, 0.702, zz + 0.10), _rx(-90), 12, lit=0.45, seed=9 + k)
            kit.box('metal', (0.20, 0.02, 0.03), (sx * 1.60, 0.71, zz - 0.14), bevel=0.006, name='module-handle')
        # floor wash under the console edge
        kit.box('lampCyan', (0.010, 0.012, 2.0), (sx * 0.548, 0.035, -8.22), bevel=0.0, name='console-wash')
    # throttle quadrant on the port console
    tq = Vector((-0.80, 0.642, -7.72))
    kit.box('metalDark', (0.22, 0.05, 0.30), tq + Vector((0, 0.02, 0)), bevel=0.012, name='throttle-base')
    for k, dx in enumerate((-0.045, 0.045)):
        lev = _rx(-28 + 8 * k)
        kit.box('metal', (0.014, 0.16, 0.022), tq + Vector((dx, 0.045, 0)) + lev @ Vector((0, 0.08, 0)), bevel=0.004, rot=lev,
                name='throttle-lever')
        kit.box('panelDark', (0.06, 0.035, 0.045), tq + Vector((dx, 0.045, 0)) + lev @ Vector((0, 0.17, 0)), bevel=0.012, rot=lev,
                name='throttle-grip')
    # trackball on the starboard console
    kit.rev('panelGrey', [(0.0, 0.0), (0.03, 0.006), (0.036, 0.02), (0.03, 0.034), (0.0, 0.04)], (0.80, 0.642, -7.74), (0, 1, 0), 16,
            'trackball')
    # ---------------- overhead panel at the B-post
    zo = -8.28
    yo = HULL.section(zo)['yTop'] - INSET - 0.05
    ov = _rx(8)
    kit.box('panelDark', (0.86, 0.07, 0.44), (0, yo, zo), bevel=0.02, rot=ov, name='overhead')
    down = ov @ _rx(90)
    for k, dz in enumerate((-0.13, -0.05, 0.03)):
        switch_row(kit, Vector((0, yo - 0.037, zo + dz)), down, 18, lit=0.35, seed=20 + k)
    for sx in (-1, 1):
        kit.rev('metalDark', [(0.045, 0.0), (0.045, 0.03), (0.03, 0.03), (0.03, 0.0)], (sx * 0.30, yo - 0.035, zo + 0.14), (0, -1, 0), 14,
                'spot-bezel')
        kit.rev('lampWarm', [(0.03, 0.012), (0.0, 0.014)], (sx * 0.30, yo - 0.035, zo + 0.14), (0, -1, 0), 14, 'spot')
        kit.box('metal', (0.02, 0.02, 0.26), (sx * 0.62, yo - 0.02, zo + 0.5), bevel=0.008, name='grab-handle')
    # ---------------- aft stations: jump seats and breaker panels
    for sx in (-1, 1):
        x = sx * 1.55
        kit.box('panelDark', (0.46, 0.05, 0.42), (x, 0.46, -5.86), bevel=0.02, name='jump-pan')
        kit.box('cushion', (0.40, 0.05, 0.36), (x, 0.50, -5.86), bevel=0.02, seg=3, name='jump-cushion')
        kit.box('cushion', (0.40, 0.56, 0.06), (x, 0.86, -5.60), bevel=0.02, seg=3, name='jump-back')
        kit.box('metalDark', (0.05, 0.44, 0.05), (x, 0.22, -5.72), bevel=0.01, name='jump-leg')
        for dx in (-0.11, 0.11):
            kit.box('fabricOrange', (0.04, 0.52, 0.008), (x + dx, 0.86, -5.635), bevel=0.002, name='harness')
        xw = sx * (floor_x(-6.0) - 0.36)
        kit.box('panelDark', (0.06, 0.62, 0.60), (sx * (floor_x(-5.9) - 0.34), 1.02, -5.92), bevel=0.012,
                rot=_ry(sx * 4), name='breaker-panel')
        for k in range(4):
            switch_row(kit, (xw + sx * 0.012 - sx * 0.03, 1.22 - 0.11 * k, -5.92), _ry(-sx * 90), 12, pitch=0.04, lit=0.5,
                       seed=30 + k)


def build_dressing(kit):
    """The second and third read of the flight deck: everything a pilot's
    hands, feet and eyes go to that is not one of the big displays."""
    tilt = _rx(-18)
    pc = Vector((0, 0.80, -9.18))
    face = lambda x, y, lift=0.0: pc + tilt @ Vector((x, y, lift))  # noqa: E731
    # ---------------- annunciator strip across the top of the panel
    tiles = ('btnAmber', 'panelGrey', 'panelGrey', 'btnGreen', 'panelGrey', 'btnWhite', 'panelGrey', 'panelGrey',
             'btnGreen', 'panelGrey', 'btnAmber', 'panelGrey', 'panelGrey', 'btnGreen', 'panelGrey', 'panelGrey')
    kit.box('panelDark', (0.98, 0.036, 0.012), face(0, 0.224, 0.004), bevel=0.004, rot=tilt, name='annunciator-bed')
    for k, key in enumerate(tiles):
        kit.box(key, (0.052, 0.024, 0.008), face((k - 7.5) * 0.059, 0.224, 0.011), bevel=0.003, rot=tilt, name='annunciator')
    # ---------------- standby instruments and the gear lever, outboard of the displays
    for sx in (-1, 1):
        R = tilt @ _ry(-sx * 12)
        n = R @ Vector((0, 0, 1))
        for k, yy in enumerate((-0.085, -0.19)):
            c = face(sx * 0.905, yy) + Vector((0, 0, 0.092))
            kit.rev('metalDark', [(0.050, 0.0), (0.050, 0.014), (0.040, 0.014), (0.040, 0.004)], c, n, 20, 'gauge-bezel')
            kit.rev('screen', [(0.040, 0.004), (0.0, 0.004)], c, n, 20, 'gauge-face')
            kit.box('btnWhite' if k else 'btnAmber', (0.003, 0.030, 0.002), c + n * 0.007 + R @ Vector((0.008, 0.008, 0)),
                    bevel=0.0, rot=R @ Matrix.Rotation(0.6 - k, 3, 'Z'), name='gauge-needle')
    lever = tilt @ _rx(38)
    lp = face(0.335, -0.215, 0.01)
    kit.box('metalDark', (0.05, 0.10, 0.012), lp, bevel=0.004, rot=tilt, name='gear-lever-gate')
    kit.box('metal', (0.012, 0.012, 0.085), lp + lever @ Vector((0, 0, 0.045)), bevel=0.003, rot=lever, name='gear-lever')
    kit.rev('accent', [(0.0, 0.0), (0.022, 0.0), (0.022, 0.016), (0.0, 0.016)], lp + lever @ Vector((-0.008, 0, 0.088)),
            lever @ Vector((1, 0, 0)), 14, 'gear-lever-wheel')
    # guarded switches (red covers) under the centre display
    for k in (-1, 0, 1):
        gp = face(-0.36 + k * 0.05, -0.215, 0.012)
        kit.box('accent', (0.026, 0.040, 0.016), gp, bevel=0.005, rot=tilt @ _rx(-14), name='switch-guard')
    # ---------------- head-up display on the glareshield lip
    top = face(0, 0.26)
    hud = _rx(-24)
    hc = top + Vector((0, 0.165, 0.015))
    kit.box('hudGlass', (0.34, 0.20, 0.006), hc, bevel=0.0, rot=hud, name='hud-combiner')
    for sx in (-1, 1):
        kit.box('metalDark', (0.012, 0.23, 0.014), hc + hud @ Vector((sx * 0.176, -0.012, 0)), bevel=0.004, rot=hud, name='hud-arm')
    kit.box('metalDark', (0.38, 0.03, 0.06), top + Vector((0, 0.05, 0.02)), bevel=0.01, name='hud-base')
    kit.box('metalDark', (0.20, 0.06, 0.12), top + Vector((0, 0.045, -0.10)), bevel=0.015, name='hud-projector')
    kit.rev('screen', [(0.03, 0.002), (0.0, 0.004)], top + Vector((0, 0.076, -0.10)), (0, 0.93, 0.37), 14, 'hud-lens')
    # ---------------- rudder pedals and heel plates
    for sx in (-1, 1):
        px = sx * 0.17
        ped = _rx(-34)
        kit.box('metalDark', (0.115, 0.17, 0.016), (px, 0.19, -8.98), bevel=0.006, rot=ped, name='pedal')
        for k in range(4):
            kit.box('rubber', (0.10, 0.012, 0.008), Vector((px, 0.19, -8.98)) + ped @ Vector((0, -0.06 + k * 0.04, 0.012)),
                    bevel=0.002, rot=ped, name='pedal-tread')
        kit.tube('metal', [(px, 0.13, -9.02), (px, 0.10, -9.20), (px, 0.22, -9.30)], 0.014, 8, 'pedal-arm')
        kit.box('metal', (0.14, 0.006, 0.30), (px, 0.004, -8.72), bevel=0.002, name='heel-plate')
    # ---------------- display pods on the window ledges, turned to the pilot
    for sx, idx, page in ((-1, 5, 'comms'), (1, 6, 'nav')):
        R = _ry(-sx * 38) @ _rx(-24)
        c = Vector((sx * 1.36, 0.83, -8.98))
        kit.box('panelDark', (0.42, 0.30, 0.10), c - (R @ Vector((0, 0, 0.055))), bevel=0.02, rot=R, name='pod')
        kit.box('metalDark', (0.10, 0.16, 0.10), (sx * 1.40, 0.66, -9.04), bevel=0.02, name='pod-stalk')
        mfd(kit, idx, page, c, R, 0.34, 0.22)
        switch_row(kit, c + R @ Vector((0, -0.135, 0.0)), R, 8, pitch=0.04, lit=0.4, seed=50 + idx)
    # ---------------- console furniture: selectors, a tablet, a headset, a mug
    for sx in (-1, 1):
        top_r = Matrix.Rotation(math.radians(-sx * 8), 3, 'Z')
        up = top_r @ Vector((0, 1, 0))
        for k in range(4):
            c = Vector((sx * 0.80 - sx * 0.12, 0.645, -7.98 + k * 0.075))
            kit.rev('metalDark', [(0.022, 0.0), (0.019, 0.02), (0.012, 0.024), (0.0, 0.024)], c, up, 16, 'selector')
            kit.box('btnWhite', (0.003, 0.004, 0.014), c + up * 0.025, bevel=0.0, rot=top_r @ _ry(40 * k), name='selector-mark')
    kit.box('panelDark', (0.24, 0.012, 0.17), (-1.52, 0.712, -7.42), bevel=0.006, rot=_ry(18), name='tablet')
    kit.box('screen', (0.21, 0.004, 0.14), (-1.52, 0.72, -7.42), bevel=0.0, rot=_ry(18), name='tablet-screen')
    kit.rev('panelWhite', [(0.0, 0.0), (0.036, 0.0), (0.042, 0.085), (0.036, 0.085), (0.031, 0.008), (0.0, 0.008)],
            (1.30, 0.705, -7.36), (0, 1, 0), 14, 'mug')
    arc = [(1.62 + 0.085 * math.cos(a), 0.74 + 0.085 * math.sin(a), -7.62) for a in [math.pi * k / 8 for k in range(9)]]
    kit.tube('panelDark', arc, 0.012, 8, 'headset-band')
    for dx in (-0.085, 0.085):
        kit.box('cushion', (0.035, 0.085, 0.07), (1.62 + dx, 0.735, -7.62), bevel=0.014, seg=3, name='headset-cup')
    # ---------------- overhead: aft switch panels, gaspers, conduits to the bulkhead
    for sx in (-1, 1):
        zo = -7.25
        yo = HULL.section(zo)['yTop'] - INSET - 0.04
        ov = _rx(-4)
        kit.box('panelDark', (0.50, 0.06, 0.62), (sx * 0.52, yo, zo), bevel=0.02, rot=ov, name='overhead-aft')
        down = ov @ _rx(90)
        for k, dz in enumerate((-0.20, -0.10, 0.0, 0.10)):
            switch_row(kit, Vector((sx * 0.52, yo - 0.032, zo + dz)), down, 11, lit=0.4, seed=60 + k + sx)
        kit.rev('metal', [(0.04, 0.0), (0.04, 0.02), (0.022, 0.035), (0.016, 0.035), (0.016, 0.0)],
                (sx * 0.52, yo - 0.03, zo + 0.24), (0, -1, 0), 14, 'gasper')
        kit.tube('rubber', [(sx * 0.34, yo + 0.01, zo + 0.31), (sx * 0.34, yo - 0.02, -6.4), (sx * 0.38, yo - 0.05, CZ1 + 0.02)],
                 0.016, 8, 'conduit')
        kit.tube('accent', [(sx * 0.30, yo + 0.01, zo + 0.31), (sx * 0.30, yo - 0.02, -6.4), (sx * 0.33, yo - 0.05, CZ1 + 0.02)],
                 0.009, 6, 'conduit')
    # standby compass hung from the forward overhead
    zo = -8.28
    yo = HULL.section(zo)['yTop'] - INSET - 0.05
    kit.box('metalDark', (0.07, 0.07, 0.06), (0, yo - 0.085, zo - 0.19), bevel=0.014, name='compass')
    kit.rev('screen', [(0.026, 0.0), (0.0, 0.003)], (0, yo - 0.085, zo - 0.158), (0, 0, 1), 14, 'compass-card')
    kit.tube('metalDark', [(0, yo - 0.03, zo - 0.19), (0, yo - 0.055, zo - 0.19)], 0.008, 6, 'compass-stem')
    # ---------------- aft bulkhead: extinguisher, stowage bag, legend
    kit.rev('accent', [(0.0, 0.0), (0.055, 0.012), (0.06, 0.34), (0.03, 0.40), (0.0, 0.41)], (0.95, 0.30, CZ1 - 0.10), (0, 1, 0), 14,
            'extinguisher')
    kit.box('metalDark', (0.15, 0.05, 0.03), (0.95, 0.52, CZ1 - 0.035), bevel=0.008, name='ext-clip')
    kit.box('fabric', (0.40, 0.42, 0.05), (-1.20, 1.25, CZ1 - 0.045), bevel=0.02, seg=3, name='stowage-bag')
    for yy in (1.12, 1.38):
        kit.box('fabricOrange', (0.42, 0.035, 0.008), (-1.20, yy, CZ1 - 0.073), bevel=0.002, name='stowage-strap')
    kit.label('COMMAND  SEAT  -  HARNESS  BEFORE  BURN', 0.03, (0, 2.10, CZ1 - 0.012), (-1, 0, 0), (0, 1, 0), 'decalLight')


def build(M, col):
    kit = Kit(M, col)
    kit.screens = []
    build_shell(kit)
    build_seat(kit)
    build_panels(kit)
    build_dressing(kit)
    return kit.parts, kit.screens, outline(CZ1)
