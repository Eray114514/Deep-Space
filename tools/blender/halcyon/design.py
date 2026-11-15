"""HALCYON VII design tables (game coords; mirrored about x = 0).

The envelope (27 m long, 21.4 m span, deck at y = 0) is the one the game's
camera framing, walk volumes and ramp logic were tuned against; the dims here
must stay in step with src/halcyon/ship/ships/halcyon.js.
"""

DIMS = dict(
    noseZ=-15.6, tailZ=11.3,
    canopyFront=-10.4, canopyRear=-5.4,
    rampHingeZ=6.2, rampHingeY=-0.16, rampTopZ=8.66, rampTopY=2.3, rampHalfW=1.78,
    deckY=0.0, cockpitFrontZ=-10.3, bulkheadZ=-5.4, holdStartZ=-1.0, holdEndZ=6.2,
    seatZ=-7.35, seatY=0.0, eyeY=1.50, eyeZ=-7.70, nacX=3.6, nacY=0.68,
)


def K(at, yBot, yTop, w, wTop, wBot, yC, yD, rTop, rBot, sharp=False, off=0.0):
    """One section: flat top to wTop, curve to the shoulder (w, yC), side band
    down to (w, yD), curve to the belly flat (wBot, yBot)."""
    return dict(at=at, yBot=yBot, yTop=yTop, w=w, wTop=wTop, wBot=wBot,
                yC=yC, yD=yD, rTop=rTop, rBot=rBot, sharp=sharp, off=off)


def R(at, yc, ry, rx, off=0.0, flat=0.40, r=0.60, sharp=False):
    """Rounded-octagon section (pods, booms)."""
    return K(at, yc - ry, yc + ry, rx, rx * flat, rx * flat,
             yc + ry * flat, yc - ry * flat, r, r, sharp, off)


def A(at, le, te, t, mid, tmax=(0.22, 0.48), nose=0.32, sharp=False):
    """Aerofoil section for wings / fins.  The loft's section-y is the chord:
    yBot = leading edge, yTop = trailing edge, w = half thickness."""
    c = te - le
    return K(at, le, te, t, max(0.008, t * 0.06), t * nose,
             le + c * tmax[1], le + c * tmax[0], 0.04, 0.78, sharp, mid)


# A chined lifting body: a short side band (yD..yC) runs nose to tail at wing
# height, the upper body tumbles home above it and the belly is chamfered.
HULL_KEYS = [
    K(-15.63, -0.105, -0.045, 0.035, 0.012, 0.012, -0.065, -0.085, 0.55, 0.55),
    K(-15.59, -0.135, -0.015, 0.10, 0.03, 0.03, -0.055, -0.095, 0.50, 0.50),
    K(-15.46, -0.20, 0.035, 0.21, 0.05, 0.05, -0.045, -0.115, 0.40, 0.40),
    K(-15.10, -0.30, 0.11, 0.46, 0.07, 0.07, -0.04, -0.12, 0.22, 0.22),
    K(-14.20, -0.52, 0.20, 1.02, 0.13, 0.13, -0.02, -0.20, 0.14, 0.14),
    K(-13.00, -0.70, 0.33, 1.66, 0.30, 0.26, 0.04, -0.32, 0.15, 0.15),
    K(-11.80, -0.81, 0.45, 2.08, 0.58, 0.48, 0.12, -0.42, 0.18, 0.18),
    K(-10.40, -0.88, 0.58, 2.25, 1.05, 1.00, 0.22, -0.48, 0.30, 0.25, True),
    K(-9.40, -0.90, 1.30, 2.45, 1.20, 1.15, 0.36, -0.46, 0.42, 0.28),
    K(-8.60, -0.92, 1.95, 2.55, 1.25, 1.25, 0.48, -0.44, 0.48, 0.30),
    K(-7.80, -0.94, 2.45, 2.62, 1.25, 1.35, 0.58, -0.42, 0.52, 0.30),
    K(-7.00, -0.95, 2.70, 2.66, 1.22, 1.40, 0.66, -0.40, 0.55, 0.30),
    K(-6.20, -0.95, 2.78, 2.70, 1.18, 1.45, 0.72, -0.38, 0.56, 0.30),
    K(-5.40, -0.95, 2.74, 2.74, 1.15, 1.45, 0.76, -0.36, 0.56, 0.30),
    K(-4.40, -0.96, 2.66, 2.82, 1.18, 1.50, 0.80, -0.34, 0.55, 0.30),
    K(-3.00, -1.00, 2.60, 3.00, 1.30, 1.60, 0.84, -0.30, 0.54, 0.30),
    K(-1.00, -1.05, 2.62, 3.30, 1.45, 1.75, 0.88, -0.24, 0.52, 0.30),
    K(1.00, -1.05, 2.72, 3.52, 1.55, 1.78, 0.90, -0.20, 0.52, 0.30),
    K(3.00, -0.98, 2.82, 3.58, 1.60, 1.78, 0.92, -0.16, 0.52, 0.30),
    K(5.00, -0.62, 2.92, 3.48, 1.58, 1.78, 0.96, -0.06, 0.52, 0.28),
    K(6.20, -0.16, 2.96, 3.40, 1.55, 1.78, 1.02, 0.10, 0.50, 0.25, True),
    K(7.40, 1.04, 3.02, 3.32, 1.52, 1.78, 1.60, 1.22, 0.45, 0.25),
    K(8.66, 2.30, 3.12, 3.22, 1.50, 1.78, 2.62, 2.40, 0.35, 0.20, True),
    K(9.40, 2.34, 3.30, 3.10, 1.45, 1.66, 2.78, 2.48, 0.35, 0.30),
    K(10.30, 2.38, 3.34, 2.86, 1.35, 1.48, 2.86, 2.52, 0.35, 0.30),
    K(11.00, 2.44, 3.22, 2.52, 1.20, 1.24, 2.86, 2.56, 0.35, 0.30),
]

NX, NY = DIMS['nacX'], DIMS['nacY']
NACELLE_KEYS = [
    R(0.40, NY, 0.90, 0.90, NX),
    R(1.00, NY, 1.04, 1.04, NX),
    R(3.00, NY, 1.16, 1.18, NX),
    R(6.00, NY, 1.20, 1.20, NX),
    R(9.00, NY, 1.18, 1.18, NX),
    R(10.40, NY, 1.10, 1.10, NX, sharp=True),
    R(11.20, NY, 0.93, 0.93, NX),
]

# starboard wing, stations along +x  (LE z, TE z, half thickness, mid-plane y)
WING_KEYS = [
    A(3.20, -0.80, 7.40, 0.44, 0.42),
    A(4.90, 1.60, 7.95, 0.30, 0.42, sharp=True),
    A(7.50, 4.60, 8.55, 0.19, 0.40),
    A(10.20, 7.30, 9.20, 0.10, 0.38, sharp=True),
    A(10.70, 7.95, 9.30, 0.055, 0.38),
]

CANARD_KEYS = [
    A(2.20, -8.50, -5.10, 0.17, -0.02),
    A(3.40, -7.55, -5.35, 0.11, -0.02),
    A(4.60, -6.55, -5.60, 0.05, -0.02),
]

# dorsal fin, stations along +y
FIN_KEYS = [
    A(2.70, 4.90, 10.20, 0.30, 0.0),
    A(4.40, 6.90, 10.32, 0.18, 0.0),
    A(6.20, 8.60, 10.48, 0.08, 0.0, sharp=True),
    A(6.50, 9.00, 10.46, 0.045, 0.0),
]

# canted nacelle stabiliser, built vertical about the nacelle axis then tilted
CANT_KEYS = [
    A(0.95, 7.00, 10.60, 0.16, 0.0),
    A(2.50, 8.50, 10.80, 0.10, 0.0),
    A(3.90, 9.75, 11.00, 0.05, 0.0),
]
CANT_TILT = -0.42

ENGINES = [
    dict(x=NX, y=NY, z=11.20, r=0.84, main=True),
    dict(x=-NX, y=NY, z=11.20, r=0.84, main=True),
    dict(x=1.15, y=2.84, z=11.00, r=0.30, main=False),
    dict(x=-1.15, y=2.84, z=11.00, r=0.30, main=False),
]
