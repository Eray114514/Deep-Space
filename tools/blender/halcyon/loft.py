"""Parametric section loft with real panel seams.

A LoftSurface is a function P(z, jf): `z` runs along the hull and `jf` is a
cell coordinate around HALF the ring (0 = top centre, JMAX = bottom centre),
with the section's corners (B, C, D, E) at fixed jf so grid lines follow the
chines.  The mesh is a tensor grid over (z-lines x u-lines); a seam is a
grid line with two lip lines a few mm either side whose centre vertices are
pushed below the skin wherever the seam is active.  Seams are therefore real
geometry that follows the hull's own flow, and panels are the connected
regions between them (each gets a random id baked into vertex colour R;
G marks groove faces).

Plate faces carry the ANALYTIC surface normal as custom split normals, so
shading is that of the true surface no matter how the grid is cut.
"""
import math
import random
import bmesh
import bpy
from mathutils import Vector

from .common import G, Spline, lerp, clamp, new_object

FIELDS = ('yBot', 'yTop', 'w', 'wTop', 'wBot', 'yC', 'yD', 'rTop', 'rBot', 'off')

N_AB, N_BC, N_CD, N_DE, N_EF = 6, 10, 5, 8, 6
J_B = N_AB
J_C = J_B + N_BC
J_D = J_C + N_CD
J_E = J_D + N_DE
JMAX = J_E + N_EF          # 35

SEAM_HALF = 0.005          # lip to centre, metres
SEAM_DEPTH = 0.009
EPS_Z = 2e-3


def _qbez(p0, p1, p2, t):
    m = 1 - t
    return p0 * m * m + 2 * p1 * m * t + p2 * t * t


def section_xy(s, jf):
    """(x, y) on the half section at cell coordinate jf (x >= 0)."""
    jf = clamp(jf, 0.0, float(JMAX))
    yT, yB, w = s['yTop'], s['yBot'], s['w']
    Bx, By = s['wTop'], yT
    Cx, Cy = w, s['yC']
    Dx, Dy = w, s['yD']
    Ex, Ey = s['wBot'], yB
    if jf <= J_B:
        t = jf / N_AB
        return (Bx * t, yT)
    if jf <= J_C:
        t = (jf - J_B) / N_BC
        r = s['rTop']
        cx = lerp((Bx + Cx) / 2, w, r)
        cy = lerp((By + Cy) / 2, yT, r)
        return (_qbez(Bx, cx, Cx, t), _qbez(By, cy, Cy, t))
    if jf <= J_D:
        t = (jf - J_C) / N_CD
        return (w, lerp(Cy, Dy, t))
    if jf <= J_E:
        t = (jf - J_D) / N_DE
        r = s['rBot']
        cx = lerp((Dx + Ex) / 2, w, r)
        cy = lerp((Dy + Ey) / 2, yB, r)
        return (_qbez(Dx, cx, Ex, t), _qbez(Dy, cy, Ey, t))
    t = (jf - J_E) / N_EF
    return (Ex * (1 - t), yB)


def _normal(s_a, s_b, dzlen, s, jf, side):
    jj = clamp(jf, 0.03, JMAX - 0.03)
    a0, a1 = section_xy(s_a, jj), section_xy(s_b, jj)
    dz = Vector((side * (a1[0] - a0[0]) + (s_b['off'] - s_a['off']), a1[1] - a0[1], dzlen))
    b0, b1 = section_xy(s, jj - 0.03), section_xy(s, jj + 0.03)
    du = Vector((side * (b1[0] - b0[0]), b1[1] - b0[1], 0.0))
    n = dz.cross(du) if side > 0 else du.cross(dz)
    if n.length < 1e-12:
        return Vector((0, 1, 0))
    n.normalize()
    return n


AXIS = {'x': 0, 'y': 1, 'z': 2}


class LoftSurface:
    """axes = (mirrored axis, section-y axis, loft axis) in game space.
    Hull / nacelle: ('x','y','z').  Wing: ('y','z','x').  Fin: ('x','z','y')."""

    def __init__(self, keys, axes=('x', 'y', 'z'), xform=None, mirror=False):
        self.keys = keys
        self.perm = tuple(AXIS[a] for a in axes)
        self.odd = self.perm in ((0, 2, 1), (2, 1, 0), (1, 0, 2))
        self.xform = xform
        self.mirror = mirror
        # winding / normal sign: odd permutations and mirroring each flip once
        self.sign = (-1 if self.odd else 1) * (-1 if mirror else 1)
        self.spline = Spline(keys, FIELDS)
        self.z0 = keys[0]['at']
        self.z1 = keys[-1]['at']

    def section(self, z):
        return self.spline.at(z)

    def to_game(self, v, direction=False):
        """section-local (mirrored, section-y, axis) -> game space"""
        out = [0.0, 0.0, 0.0]
        for k in range(3):
            out[self.perm[k]] = v[k]
        g = Vector(out)
        if self.xform is not None:
            g = (self.xform.to_3x3() @ g) if direction else (self.xform @ g)
        if self.mirror:
            g.x = -g.x
        return g

    def _nrm(self, s_a, s_b, dzlen, s, jf, side):
        """game-space outward normal"""
        # an outward direction is a true vector: permute it, never negate it
        return self.to_game(_normal(s_a, s_b, dzlen, s, jf, side), True)

    def normal(self, z, jf, side=1):
        zz = clamp(z, self.z0 + EPS_Z, self.z1 - EPS_Z)
        return self._nrm(self.section(zz - EPS_Z), self.section(zz + EPS_Z), 2 * EPS_Z,
                         self.section(zz), jf, side)

    def point(self, z, jf, side=1, inset=0.0):
        """Game-space point.  side=-1 mirrors about the section's own axis."""
        s = self.section(z)
        x, y = section_xy(s, jf)
        p = self.to_game(Vector((s['off'] + side * x, y, z)))
        if inset:
            p -= self.normal(z, jf, side) * inset
        return p

    def metric_u(self, z, jf, s=None):
        """metres per unit jf"""
        s = s or self.section(z)
        j0, j1 = max(0.0, jf - 0.05), min(float(JMAX), jf + 0.05)
        a, b = section_xy(s, j0), section_xy(s, j1)
        return math.hypot(b[0] - a[0], b[1] - a[1]) / (j1 - j0)

    def frame(self, z, jf, side=1, lift=0.0):
        """(origin, normal, tangent-along-z) for placing fittings on the skin"""
        n = self.normal(z, jf, side)
        p = self.point(z, jf, side) + n * lift
        e = 1e-2
        t = self.point(min(self.z1, z + e), jf, side) - self.point(max(self.z0, z - e), jf, side)
        t.normalize()
        return p, n, t

    def lip(self, name, col, z, inset, mat, facing=-1, tint=0.5, jmax=None):
        """Annular face strip closing the gap between the skin and an inset
        liner at station z.  facing = -1 looks toward -axis."""
        bm = bmesh.new()
        layer = bm.loops.layers.float_color.new('Color')
        outer, inner = [], []
        js = [j * 0.5 for j in range(JMAX * 2 + 1)]
        closed = jmax is None
        if closed:
            ring = [(j, 1) for j in js] + [(j, -1) for j in js[-2:0:-1]]
        else:
            js = [j for j in js if j <= jmax]
            ring = [(j, -1) for j in js[::-1]] + [(j, 1) for j in js[1:]]
        for j, side in ring:
            outer.append(bm.verts.new(G(*self.point(z, j, side))))
            inner.append(bm.verts.new(G(*self.point(z, j, side, inset))))
        n = len(ring)
        want_flip = (facing > 0) != (self.sign < 0)
        for k in range(n if closed else n - 1):
            k2 = (k + 1) % n
            quad = [outer[k], outer[k2], inner[k2], inner[k]]
            f = bm.faces.new(quad[::-1] if want_flip else quad)
            for loop in f.loops:
                loop[layer] = (tint, 0.0, 0.0, 0.0)
        me = bpy.data.meshes.new(name)
        bm.normal_update()
        bm.to_mesh(me)
        bm.free()
        obj = new_object(name, me, col)
        me.materials.append(mat)
        return obj

    def plate(self, name, col, mat, z0, z1, j0, j1, side=1, lift=0.022, chamfer=0.03, nz=None, nj=None, tint=None):
        """A raised plate lying on the skin: a top face `lift` proud of the
        surface with a chamfered rim down to it.  It is what makes a hull read
        as built-up armour at a distance where a 1 cm seam is sub-pixel."""
        import random as _r
        tint = _r.random() if tint is None else tint
        zm = (z0 + z1) / 2
        jc = chamfer / max(self.metric_u(zm, (j0 + j1) / 2), 1e-4)
        nz = nz or max(2, int((z1 - z0) / 0.3))
        nj = nj or max(2, int(j1 - j0))
        zs = [z0, z0 + chamfer] + [z0 + chamfer + (z1 - z0 - 2 * chamfer) * k / nz for k in range(1, nz)] + [z1 - chamfer, z1]
        js = [j0, j0 + jc] + [j0 + jc + (j1 - j0 - 2 * jc) * k / nj for k in range(1, nj)] + [j1 - jc, j1]
        bm = bmesh.new()
        layer = bm.loops.layers.float_color.new('Color')
        V = []
        for i, z in enumerate(zs):
            row = []
            for k, j in enumerate(js):
                rim = i in (0, len(zs) - 1) or k in (0, len(js) - 1)
                p = self.point(z, j, side) + self.normal(z, j, side) * (-0.004 if rim else lift)
                row.append(bm.verts.new(G(*p)))
            V.append(row)
        for i in range(len(zs) - 1):
            for k in range(len(js) - 1):
                quad = [V[i][k], V[i][k + 1], V[i + 1][k + 1], V[i + 1][k]]
                f = bm.faces.new(quad if (side < 0) != (self.sign < 0) else quad[::-1])
                f.smooth = True
                for loop in f.loops:
                    loop[layer] = (tint, 0.0, 0.0, 0.0)
        bm.normal_update()
        # face the plate away from the hull
        n_out = G(*self.normal(zm, (j0 + j1) / 2, side))
        if sum(f.normal.dot(n_out) for f in bm.faces) < 0:
            bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
        for e in bm.edges:
            if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(25):
                e.smooth = False
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        obj = new_object(name, me, col)
        me.materials.append(mat)
        return obj

    def y_to_jf(self, z, y, lower=False):
        """cell coordinate where the side of the section crosses height y"""
        s = self.section(z)
        lo, hi = (J_C, JMAX) if lower else (0.0, J_D)
        best, bj = 1e9, lo
        n = 400
        for i in range(n + 1):
            j = lo + (hi - lo) * i / n
            d = abs(section_xy(s, j)[1] - y)
            if d < best:
                best, bj = d, j
        return bj

    # ------------------------------------------------------------------
    def build(self, name, col, *, seams=(), z_extra=(), u_extra=(), ring_step=0.16,
              region=None, mats=None, cap_start=False, cap_end=False,
              inset=0.0, flip=False, seed=7, tile=2.0, z_range=None, uv_fn=None,
              seam_half=SEAM_HALF, seam_depth=SEAM_DEPTH):
        """Mesh the surface.

        seams: ('r', z, jf0, jf1)  ring seam over a half-ring range (mirrored)
               ('l', jf, z0, z1)   longitudinal seam (mirrored)
        region(z_mid, jf_mid, side) -> material key, or None to omit the cell
        inset: build the surface this far below the skin (liners)
        flip: face inward (interior shells)
        """
        za, zb = z_range or (self.z0, self.z1)
        ring_seams = sorted({round(s[1], 4) for s in seams if s[0] == 'r' and za < s[1] < zb})
        long_seams = sorted({round(s[1], 4) for s in seams if s[0] == 'l'})

        # ---- z lines: (z, kind, seam_z) ; kind: 0 base, -1/+1 lip, 2 centre
        req = {round(za, 4), round(zb, 4)}
        for k in self.keys:
            if za <= k['at'] <= zb:
                req.add(round(k['at'], 4))
        for z in z_extra:
            if za <= z <= zb:
                req.add(round(z, 4))
        req.update(ring_seams)
        req = sorted(req)
        zl = []
        for a, b in zip(req[:-1], req[1:]):
            n = max(1, int(math.ceil((b - a) / ring_step)))
            zl += [a + (b - a) * i / n for i in range(n)]
        zl.append(req[-1])
        rs = set(ring_seams)
        zlines = []
        for z in zl:
            zr = round(z, 4)
            if zr in rs:
                zlines += [(z - seam_half, -1, zr), (z, 2, zr), (z + seam_half, 1, zr)]
            elif not any(abs(z - s) < seam_half * 3 for s in ring_seams):
                zlines.append((z, 0, None))

        # ---- u lines for the half ring: (jf, kind, seam_jf)
        ucoords = {float(j) for j in range(JMAX + 1)} | {round(float(u), 4) for u in u_extra}
        ulines = []
        ls = set(long_seams)
        for u in sorted(ucoords | ls):
            if u in ls:
                ulines += [(u, -1, u), (u, 2, u), (u, 1, u)]
            else:
                ulines.append((u, 0, None))

        # a lip may never cross its neighbouring grid line (they crowd near a
        # nose, where a cell is narrower than the groove)
        ucoord = sorted({u[0] for u in ulines})
        lip_max = {}
        for i, u in enumerate(ucoord):
            gaps = []
            if i > 0:
                gaps.append(u - ucoord[i - 1])
            if i < len(ucoord) - 1:
                gaps.append(ucoord[i + 1] - u)
            lip_max[u] = 0.42 * min(gaps) if gaps else 0.42

        ring_spans = {}
        for s in seams:
            if s[0] == 'r':
                ring_spans.setdefault(round(s[1], 4), []).append((s[2], s[3]))
        long_spans = {}
        for s in seams:
            if s[0] == 'l':
                long_spans.setdefault(round(s[1], 4), []).append((s[2], s[3]))

        def ring_active(zr, jf):
            return any(a - 1e-6 <= jf <= b + 1e-6 for a, b in ring_spans.get(zr, ()))

        def long_active(c, z):
            return any(a - 1e-6 <= z <= b + 1e-6 for a, b in long_spans.get(c, ()))

        nu = len(ulines)
        cols = [(u, 1) for u in ulines] + [(ulines[k], -1) for k in range(nu - 2, 0, -1)]
        ncol = len(cols)
        nz = len(zlines)

        # ---- evaluate
        secs = []
        for (z, zk, zs) in zlines:
            zc = clamp(z, self.z0, self.z1)
            secs.append((self.section(max(self.z0, zc - EPS_Z)), self.section(zc),
                         self.section(min(self.z1, zc + EPS_Z))))
        P = [[None] * ncol for _ in range(nz)]      # game-space points
        JE = [[0.0] * ncol for _ in range(nz)]      # effective jf
        PUSH = [[False] * ncol for _ in range(nz)]
        ARC = [[0.0] * ncol for _ in range(nz)]
        for zi, (z, zk, zs) in enumerate(zlines):
            s_m, s, s_p = secs[zi]
            acc, prev = [0.0], section_xy(s, 0.0)
            for j in range(1, JMAX * 4 + 1):
                cur = section_xy(s, j / 4)
                acc.append(acc[-1] + math.hypot(cur[0] - prev[0], cur[1] - prev[1]))
                prev = cur
            for ci, ((jf, uk, us), side) in enumerate(cols):
                m = max(self.metric_u(z, jf, s), 1e-5)
                j_eff = jf
                if uk in (-1, 1):
                    j_eff = clamp(jf + uk * min(seam_half / m, lip_max[jf]), 0.0, float(JMAX))
                x, y = section_xy(s, j_eff)
                p = self.to_game(Vector((s['off'] + side * x, y, z)))
                push = (zk == 2 and ring_active(zs, jf)) or \
                       (uk == 2 and long_active(us, zs if zk != 0 else z))
                if push and m < seam_half * 3:
                    push = False
                depth = inset + (seam_depth if push else 0.0)
                if depth:
                    p -= self._nrm(s_m, s_p, 2 * EPS_Z, s, j_eff, side) * depth
                P[zi][ci] = p
                JE[zi][ci] = j_eff
                PUSH[zi][ci] = push
                a = acc[int(clamp(round(j_eff * 4), 0, JMAX * 4))]
                ARC[zi][ci] = side * a

        bm = bmesh.new()
        uv_layer = bm.loops.layers.uv.new('UVMap')
        col_layer = bm.loops.layers.float_color.new('Color')
        nrm_layer = bm.loops.layers.float_vector.new('nrm_tmp')
        V = [[bm.verts.new(G(*P[zi][ci])) for ci in range(ncol)] for zi in range(nz)]

        slot_of = {}
        for zi in range(nz - 1):
            zmid = (zlines[zi][0] + zlines[zi + 1][0]) / 2
            for ci in range(ncol):
                cj = (ci + 1) % ncol
                side = 1 if ci < nu - 1 else -1
                jmid = (cols[ci][0][0] + cols[cj][0][0]) / 2
                key = region(zmid, jmid, side) if region else 'hull'
                if key is None:
                    continue
                quad = [(zi + 1, ci), (zi + 1, cj), (zi, cj), (zi, ci)]
                if flip != (self.sign < 0):
                    quad = quad[::-1]
                try:
                    f = bm.faces.new([V[a][b] for a, b in quad])
                except ValueError:
                    continue
                f.material_index = slot_of.setdefault(key, len(slot_of))
                f.smooth = True
                f.tag = sum(1 for (a, b) in quad if PUSH[a][b]) >= 2
                for loop, (qz, qc) in zip(f.loops, quad):
                    u = ARC[qz][qc]
                    if side < 0 and u > 0:
                        u = -u
                    loop[uv_layer].uv = (u / tile, (zlines[qz][0] - self.z0) / tile)
                    if uv_fn is not None:
                        ov = uv_fn(key, zlines[qz][0], JE[qz][qc], side, zmid, jmid)
                        if ov is not None:
                            loop[uv_layer].uv = ov
                    if not f.tag:
                        s_m, s, s_p = secs[qz]
                        jn = JE[qz][qc] + (0.04 if jmid > JE[qz][qc] else -0.04)
                        if qz == zi:
                            n = self._nrm(s, s_p, EPS_Z, s, jn, side)
                        else:
                            n = self._nrm(s_m, s, EPS_Z, s, jn, side)
                        if flip:
                            n = -n
                        loop[nrm_layer] = G(*n)

        # caps
        for want, row, rev in ((cap_start, V[0], False), (cap_end, V[-1], True)):
            if not want:
                continue
            ring = row[::-1] if (rev != flip) != (self.sign < 0) else row
            try:
                f = bm.faces.new(ring)
                f.material_index = slot_of.setdefault('cap', len(slot_of))
                f.tag = True
                f.smooth = False
            except ValueError:
                pass

        # ---- panel ids by flood fill between grooves / material borders
        rnd = random.Random(seed)
        bm.faces.ensure_lookup_table()
        bm.faces.index_update()
        seen = set()
        for f in bm.faces:
            if f.index in seen or f.tag:
                continue
            tint = rnd.random()
            stack = [f]
            seen.add(f.index)
            while stack:
                cur = stack.pop()
                for loop in cur.loops:
                    loop[col_layer] = (tint, 0.0, 0.0, 0.0)
                for e in cur.edges:
                    for o in e.link_faces:
                        if o.index in seen or o.tag or o.material_index != cur.material_index:
                            continue
                        seen.add(o.index)
                        stack.append(o)
        bm.normal_update()
        for f in bm.faces:
            if f.tag:
                for loop in f.loops:
                    loop[col_layer] = (0.5, 1.0, 0.0, 0.0)
                    loop[nrm_layer] = f.normal
        for e in bm.edges:
            if len(e.link_faces) == 2 and e.link_faces[0].tag != e.link_faces[1].tag:
                e.smooth = False

        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        attr = me.attributes['nrm_tmp']
        normals = [tuple(d.vector) for d in attr.data]
        me.attributes.remove(attr)
        me.normals_split_custom_set(normals)
        obj = new_object(name, me, col)
        if mats:
            for key, idx in sorted(slot_of.items(), key=lambda kv: kv[1]):
                me.materials.append(mats.get(key) or mats.get('hull'))
        return obj
