"""HALCYON VII exterior fittings: the parts that say the ship works.

Landing gear, reaction-control quads, dorsal spine and antennas, radiator
louvres, lights, sensor ball, cannons, lettering.  Everything is placed from
the hull's own surface functions so nothing floats or sinks when a section
table changes.
"""
import math
from mathutils import Matrix, Vector

from . import prims
from .design import DIMS, NX, NY, R, NACELLE_KEYS
from .loft import LoftSurface, section_xy, J_C, J_D, JMAX

GROUND_Y = -1.60           # belly (-1.05) minus the game's 0.55 m ground clearance


def _rot_z(deg):
    return Matrix.Rotation(math.radians(deg), 3, 'Z')


def _rot_x(deg):
    return Matrix.Rotation(math.radians(deg), 3, 'X')


def half_width(S, a, sy):
    """half-thickness of a loft section at section-y = sy"""
    s = S.section(a)
    best = 0.0
    prev = section_xy(s, 0.0)
    for k in range(1, JMAX * 4 + 1):
        cur = section_xy(s, k / 4)
        lo, hi = sorted((prev[1], cur[1]))
        if lo <= sy <= hi and hi > lo:
            t = (sy - prev[1]) / (cur[1] - prev[1])
            best = max(best, prev[0] + (cur[0] - prev[0]) * t)
        prev = cur
    return best


# ---------------------------------------------------------------- landing gear
def gear_leg(M, col, tag, x, z, top_y, pad_r=0.40):
    P = []
    o = (x, 0.0, z)
    up = (0, 1, 0)
    # trunnion housing against the belly
    P.append(prims.box('gear-housing', col, (0.60, 0.22, 0.80), M['metalDark'], bevel=0.03,
                       origin=(x, top_y - 0.06, z)))
    # outer cylinder, gland nut, chromed piston
    P.append(prims.revolve('gear-strut', col, [
        (0.0, top_y - 0.10), (0.17, top_y - 0.10), (0.17, -1.02), (0.19, -1.02),
        (0.19, -1.10), (0.14, -1.10), (0.14, -1.13), (0.0, -1.13)][::-1], o, up, 20, M['hullGrey']))
    lower = []
    lower.append(prims.revolve('gear-piston', col, [
        (0.0, -1.10), (0.10, -1.10), (0.10, -1.44), (0.0, -1.44)][::-1], o, up, 18, M['chrome']))
    # footpad: dished plate with a rolled rim and a ball joint
    lower.append(prims.revolve('gear-pad', col, [
        (0.0, GROUND_Y), (pad_r * 0.92, GROUND_Y), (pad_r, GROUND_Y + 0.025),
        (pad_r, GROUND_Y + 0.05), (pad_r * 0.9, GROUND_Y + 0.085), (0.22, GROUND_Y + 0.13),
        (0.15, GROUND_Y + 0.20), (0.0, GROUND_Y + 0.20)], o, up, 28, M['metalDark']))
    # radial ribs on the pad
    for k in range(6):
        t = math.pi * k / 3
        rot = Matrix.Rotation(t, 3, 'Y')
        lower.append(prims.box('gear-rib', col, (pad_r * 0.62, 0.05, 0.03), M['metalDark'], bevel=0.006,
                           origin=Vector(o) + rot @ Vector((pad_r * 0.52, GROUND_Y + 0.085, 0)), rot=rot))
    # torque links (scissor) on the aft side
    for (y0, y1, zz) in ((-0.98, -1.20, 0.30), (-1.20, -1.40, 0.30)):
        a = Vector((x, y0, z + 0.13))
        b = Vector((x, (y0 + y1) / 2, z + zz))
        c = Vector((x, y1, z + 0.09))
        for p0, p1 in ((a, b), (b, c)):
            lower.append(prims.tube('gear-link', col, [p0, p1], 0.022, M['metal'], 8))
    # drag brace up into the bay, and a hydraulic line down the strut
    P.append(prims.tube('gear-brace', col, [(x, top_y + 0.02, z + 0.95), (x, -0.98, z + 0.14)],
                        0.04, M['metal'], 10))
    P.append(prims.tube('gear-line', col, [
        (x + 0.13, top_y - 0.1, z - 0.02), (x + 0.135, -0.95, z - 0.02), (x + 0.11, -1.06, z - 0.05)],
        0.012, M['rubber'], 6))
    # bay doors, hanging open either side: separate nodes hinged at their top edge
    doors = {}
    for sx in (-1, 1):
        rot = _rot_z(sx * 14)
        hinge = Vector((x + sx * 0.48, top_y - 0.02, z + 0.25))
        doors[sx] = ([prims.box('gear-door', col, (0.03, 0.46, 1.6), M['hullDark'], bevel=0.008,
                                origin=hinge + rot @ Vector((0, -0.23, 0)), rot=rot)], tuple(hinge))
    return P, lower, doors


# ---------------------------------------------------------------- reaction control
def rcs_quad(M, col, S, z, jf, side, n=3, tag=''):
    p, nrm, tan = S.frame(z, jf, side)
    rot = prims.frame_from(nrm, tan)
    out = [prims.box('rcs-plate' + tag, col, (0.30, 0.03, 0.62), M['metalDark'], bevel=0.008,
                     origin=p + nrm * 0.004, rot=rot)]
    for k in range(n):
        q = p + tan * ((k - (n - 1) / 2) * 0.17)
        out.append(prims.revolve('rcs-nozzle' + tag, col, [
            (0.062, 0.010), (0.070, 0.058), (0.060, 0.058), (0.034, 0.012), (0.0, 0.014)],
            q, nrm, 14, M['heat']))
    return out


# ---------------------------------------------------------------- dorsal spine
def build_spine(M, col, HULL):
    z0, z1 = -4.9, 5.2
    keys = []
    n = 12
    for i in range(n + 1):
        z = z0 + (z1 - z0) * i / n
        t = i / n
        k = min(1.0, t / 0.12, (1 - t) / 0.06 + 0.35)
        yt = HULL.section(z)['yTop']
        keys.append(R(z, yt + 0.02 * k, 0.03 + 0.11 * k, 0.05 + 0.24 * k))
    S = LoftSurface(keys)
    seams = [('r', z, 0.0, 16.0) for z in (-3.0, -1.0, 1.0, 3.0)]
    obj = S.build('spine', col, seams=seams, mats=M, cap_start=True, cap_end=True, ring_step=0.5,
                  region=lambda z, j, s: None if j > 21 else 'hullGrey')
    out = [obj]
    top = lambda z: S.section(z)['yTop']  # noqa: E731
    # blade antennas
    for z in (-3.7, -0.5):
        out.append(prims.box('antenna-blade', col, (0.022, 0.36, 0.26), M['hullDark'], bevel=0.006,
                             origin=(0, top(z) + 0.17, z + 0.05), rot=_rot_x(-18), taper=(1.0, 0.42)))
    # satcom radome
    zc = 1.9
    out.append(prims.revolve('radome', col, [
        (0.23, 0.0), (0.225, 0.06), (0.19, 0.13), (0.11, 0.18), (0.0, 0.195)],
        (0, top(zc) - 0.02, zc), (0, 1, 0), 24, M['hull']))
    # anti-collision beacon
    zb = -2.1
    out.append(prims.revolve('beacon-base', col, [(0.07, 0.0), (0.07, 0.025), (0.0, 0.025)],
                             (0, top(zb) - 0.005, zb), (0, 1, 0), 14, M['metalDark']))
    out.append(prims.revolve('strobe-dorsal', col, [(0.05, 0.0), (0.048, 0.04), (0.03, 0.065), (0.0, 0.075)],
                             (0, top(zb) + 0.02, zb), (0, 1, 0), 14, M['strobe']))
    return out


# ---------------------------------------------------------------- nacelle radiators
def build_louvres(M, col, mirror):
    S = LoftSurface(NACELLE_KEYS, mirror=mirror)
    out = []
    z = 3.72
    sx = -1 if mirror else 1
    while z < 6.82:
        y = S.section(z)['yTop']
        w = S.section(z)['wTop'] * (4 / 6) * 2 - 0.06
        out.append(prims.box('louvre', col, (w, 0.012, 0.10), M['metal'], bevel=0.003,
                             origin=(sx * NX, y + 0.022, z), rot=_rot_x(24)))
        z += 0.135
    return out


# ---------------------------------------------------------------- weapons
def build_cannon(M, col, sx, WING):
    x = sx * 5.2
    s = WING.section(5.2)
    y_under = s['off'] - half_width(WING, 5.2, 2.9)
    out = [prims.box('cannon-fairing', col, (0.36, 0.26, 2.1), M['hullGrey'], bevel=0.05, segments=3,
                     origin=(x, y_under - 0.06, 3.0), taper=None)]
    yb = y_under - 0.07
    out.append(prims.revolve('cannon-barrel', col, [
        (0.0, 0.0), (0.085, 0.0), (0.085, 0.25), (0.052, 0.27), (0.052, 1.02), (0.07, 1.04),
        (0.07, 1.24), (0.04, 1.24), (0.04, 1.0), (0.0, 1.0)], (x, yb, 2.05), (0, 0, -1), 16, M['metalDark']))
    out.append(prims.box('cannon-feed', col, (0.20, 0.12, 0.5), M['metalDark'], bevel=0.02,
                         origin=(x, y_under - 0.20, 3.3)))
    return out


# ---------------------------------------------------------------- lettering
def lettering(M, col, HULL, FIN):
    from .exterior import WING as WING_REF
    out = []
    lift = 0.006
    # hull sides, on the chine band aft of the crew door
    for sx in (1, -1):
        zc, y0, h = -0.35, 0.10, 0.44

        def place(u, v, sx=sx, zc=zc, y0=y0):
            z = zc - sx * u
            return (sx * (HULL.section(z)['w'] + lift), y0 + v, z)

        out.append(prims.text('name-%s' % ('stbd' if sx > 0 else 'port'), col, 'HALCYON VII', h,
                              place, M['decal'], outward=(sx, 0, 0)))

        def place2(u, v, sx=sx):
            z = -11.35 - sx * u
            return (sx * (HULL.section(z)['w'] + lift), -0.36 + v, z)

        out.append(prims.text('reg-%s' % ('stbd' if sx > 0 else 'port'), col, 'HX-2291', 0.17,
                              place2, M['decal'], outward=(sx, 0, 0)))
    # fin registration
    for sx in (1, -1):
        def place(u, v, sx=sx):
            y = 3.72 + v
            z = 8.55 - sx * u
            return (sx * (half_width(FIN, y, z) + lift), y, z)

        out.append(prims.text('fin-reg-%s' % ('stbd' if sx > 0 else 'port'), col, 'HX-2291', 0.36,
                              place, M['decal'], outward=(sx, 0, 0)))
    # walk limits on the wing roots
    for sx in (1, -1):
        def place(u, v, sx=sx):
            x, z = 5.6 * sx + u, 6.6 - v
            return (x, WING_REF.section(abs(x))['off'] + half_width(WING_REF, abs(x), z) + lift, z)

        out.append(prims.text('no-step-%d' % sx, col, 'NO  STEP', 0.16, place, M['decal'], outward=(0, 1, 0)))
    return out


def build(M, col, groups):
    from .exterior import HULL, WING, FIN
    static = groups['exterior']

    # ---- gear
    belly = lambda z: HULL.section(z)['yBot']  # noqa: E731
    pivots = groups['pivots']

    def leg(name, x, z, top_y, pad_r):
        parts, lower, doors = gear_leg(M, col, name, x, z, top_y, pad_r=pad_r)
        groups[name] = parts
        pivots[name] = (x, top_y, z)
        groups[name + '-lower'] = lower          # folds at the knee (the gland nut)
        pivots[name + '-lower'] = (x, -1.10, z)
        for sx, (objs, hinge) in doors.items():
            key = '%s-door-%s' % (name, 'stbd' if sx > 0 else 'port')
            groups[key] = objs
            pivots[key] = hinge

    leg('gear-nose', 0.0, -9.3, belly(-9.3), 0.52)
    for sx, tag in ((1, 'stbd'), (-1, 'port')):
        z = 3.6
        jf = HULL.y_to_jf(z, -0.74, lower=True)
        p = HULL.point(z, jf, sx)
        leg('gear-main-' + tag, sx * 2.45, z, p.y + 0.02, 0.62)

    # ---- reaction control
    for side in (1, -1):
        static += rcs_quad(M, col, HULL, -13.1, 8.5, side)
        static += rcs_quad(M, col, HULL, -13.1, 26.5, side)
        static += rcs_quad(M, col, HULL, 10.0, 9.5, side, n=2)
        static += rcs_quad(M, col, HULL, 10.0, 26.0, side, n=2)

    static += build_spine(M, col, HULL)
    for mirror in (False, True):
        static += build_louvres(M, col, mirror)
    for sx in (1, -1):
        static += build_cannon(M, col, sx, WING)

    # ---- crew door furniture (both sides): porthole and recessed handle
    for sx in (1, -1):
        z = -3.275
        pp, n, tan = HULL.frame(z, HULL.y_to_jf(z, 0.50), sx)
        static.append(prims.revolve('door-port-frame', col, [
            (0.215, -0.01), (0.215, 0.018), (0.165, 0.018), (0.165, -0.01)], pp, n, 28, M['trim']))
        static.append(prims.revolve('door-port-glass', col, [(0.165, 0.008), (0.0, 0.008)],
                                    pp, n, 28, M['glass']))
        ph, nh, th = HULL.frame(z + 0.48, HULL.y_to_jf(z, 0.05), sx)
        static.append(prims.box('door-handle', col, (0.07, 0.03, 0.26), M['metal'], bevel=0.01,
                                origin=ph + nh * 0.012, rot=prims.frame_from(nh, th)))
        # formation strips on the nose chine
        for zz in (-12.0, -11.0):
            p, nrm, tan = HULL.frame(zz, 18.5, sx)
            static.append(prims.box('formation-strip', col, (0.045, 0.012, 0.62), M['lampStrip'], bevel=0.003,
                                    origin=p + nrm * 0.004, rot=prims.frame_from(nrm, tan)))

    # ---- lights
    tip = WING.section(10.7)
    for sx, key in ((1, 'lampGreen'), (-1, 'lampRed')):
        static.append(prims.box('nav-' + key, col, (0.05, 0.05, 0.22), M[key], bevel=0.012,
                                origin=(sx * 10.73, tip['off'], tip['yBot'] + 0.25)))
        # wingtip rail
        static.append(prims.revolve('tip-rail', col, [
            (0.0, -0.2), (0.03, -0.12), (0.055, 0.15), (0.055, 1.55), (0.035, 1.75), (0.0, 1.75)],
            (sx * 10.76, tip['off'], tip['yBot']), (0, 0, 1), 12, M['metalDark']))
    static.append(prims.box('nav-tail', col, (0.04, 0.07, 0.05), M['lampWhite'], bevel=0.01,
                            origin=(0, 6.36, 10.49)))
    static.append(prims.revolve('strobe-fin', col, [(0.035, 0.0), (0.03, 0.04), (0.0, 0.055)],
                                (0, 6.50, 9.72), (0, 1, 0), 12, M['strobe']))
    static.append(prims.revolve('strobe-belly', col, [(0.05, 0.0), (0.045, 0.035), (0.0, 0.05)],
                                (0, belly(-2.0), -2.0), (0, -1, 0), 12, M['strobe']))
    for sx in (-1, 1):
        static.append(prims.revolve('landing-lamp-bezel', col, [(0.10, 0.0), (0.10, 0.022), (0.075, 0.022), (0.075, 0.0)],
                                    (sx * 0.55, belly(-10.6) + 0.0, -10.6), (0, -1, 0), 18, M['metalDark']))
        static.append(prims.revolve('landing-lamp', col, [(0.075, 0.01), (0.0, 0.016)],
                                    (sx * 0.55, belly(-10.6), -10.6), (0, -1, 0), 18, M['lampWhite']))

    # ---- sensor ball under the nose, pitot boom at the tip
    zs = -12.6
    sensor = groups['sensor'] = []
    pivots['sensor'] = (0, belly(zs), zs)
    static.append(prims.revolve('sensor-collar', col, [(0.27, 0.0), (0.27, 0.035), (0.21, 0.05), (0.21, 0.0)],
                                (0, belly(zs), zs), (0, -1, 0), 24, M['metalDark']))
    sensor.append(prims.revolve('sensor-ball', col, [
        (0.2 * math.sin(a), 0.03 + 0.2 - 0.2 * math.cos(a)) for a in
        [math.pi * k / 16 for k in range(0, 17)]], (0, belly(zs) - 0.34, zs), (0, 1, 0), 24, M['metalDark']))
    sensor.append(prims.revolve('sensor-lens', col, [(0.085, 0.0), (0.07, 0.02), (0.0, 0.026)],
                                (0, belly(zs) - 0.15, zs - 0.185), (0, -0.15, -1), 18, M['glass']))
    static.append(prims.revolve('pitot', col, [
        (0.0, 0.0), (0.03, 0.02), (0.022, 0.25), (0.012, 0.3), (0.012, 0.95), (0.0, 0.97)],
        (0, -0.07, DIMS['noseZ'] + 0.05), (0, 0, -1), 10, M['metal']))

    # ---- flap track fairings under the wing
    for sx in (1, -1):
        for xs in (6.2, 8.0):
            s = WING.section(xs)
            zf = s['yTop'] - 0.75
            yu = s['off'] - half_width(WING, xs, zf)
            static.append(prims.box('flap-fairing', col, (0.15, 0.13, 1.5), M['hullDark'], bevel=0.04, segments=3,
                                    origin=(sx * xs, yu - 0.03, zf)))

    static += lettering(M, col, HULL, FIN)
    # ---- where the lamps glow and where exhaust stains the skin (read by the
    # exporter and the soot bake; positions in game space)
    spine_top = HULL.section(-2.1)['yTop'] + 0.10
    glows = [('glow-green', (10.78, tip['off'], tip['yBot'] + 0.25)), ('glow-red', (-10.78, tip['off'], tip['yBot'] + 0.25)),
             ('glow-white', (0, 6.36, 10.53)), ('glow-strobe-fin', (0, 6.57, 9.72)),
             ('glow-strobe-belly', (0, belly(-2.0) - 0.06, -2.0)), ('glow-strobe-dorsal', (0, spine_top + 0.09, -2.1)),
             ('glow-landing-port', (-0.55, belly(-10.6) - 0.03, -10.6)), ('glow-landing-stbd', (0.55, belly(-10.6) - 0.03, -10.6))]
    soot = []          # (position, radius, aft streak length)
    for side in (1, -1):
        for (z, jf) in ((-13.1, 8.5), (-13.1, 26.5), (10.0, 9.5), (10.0, 26.0)):
            soot.append((tuple(HULL.point(z, jf, side)), 0.34, 0.9))
        soot.append(((side * 5.2, 0.08, 0.85), 0.26, 1.6))             # cannon muzzle
        soot.append(((side * NX, NY + 1.2, 6.95), 0.34, 1.5))          # radiator outflow
        for a in range(8):                                             # nozzle ring
            t = math.pi * 2 * a / 8
            soot.append(((side * NX + math.cos(t) * 1.02, NY + math.sin(t) * 1.02, 10.15), 0.42, 0.5))
    groups['marks'] = {'glows': glows, 'soot': soot}
