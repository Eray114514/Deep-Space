"""Small mesh primitives, authored in game coords."""
import math
import bmesh
import bpy
from mathutils import Vector, Matrix

from .common import G, Gv, new_object, add_bevel, add_weighted_normal, apply_modifiers, sharp_by_angle


def _finish(name, bm, col, mat=None, smooth=True, tint=None):
    layer = bm.loops.layers.float_color.new('Color')
    c = (0.5 if tint is None else tint, 0.0, 0.0, 1.0)
    for f in bm.faces:
        f.smooth = smooth
        for loop in f.loops:
            loop[layer] = c
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    obj = new_object(name, me, col)
    if mat is not None:
        me.materials.append(mat)
    return obj


def lathe(name, col, profile, center=(0, 0), segs=48, mat=None, flip=False,
          axis='z', sharp_deg=28, tint=None):
    """Revolve profile [(r, a)] about a game-space axis through `center`.
    axis 'z': center = (x, y) and a = z.   axis 'y': center = (x, z), a = y.
    Default winding faces outward when the profile runs toward +a."""
    bm = bmesh.new()
    rings = []
    for (r, a) in profile:
        ring = []
        for k in range(segs):
            t = 2 * math.pi * k / segs
            if axis == 'z':
                p = G(center[0] + r * math.cos(t), center[1] + r * math.sin(t), a)
            else:
                p = G(center[0] + r * math.cos(t), a, center[1] - r * math.sin(t))
            ring.append(bm.verts.new(p))
        rings.append(ring)
    for i in range(len(rings) - 1):
        for k in range(segs):
            k2 = (k + 1) % segs
            quad = [rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]]
            if flip:
                quad = quad[::-1]
            if profile[i][0] < 1e-6 and profile[i + 1][0] < 1e-6:
                continue
            try:
                bm.faces.new(quad)
            except ValueError:
                pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    obj = _finish(name, bm, col, mat, tint=tint)
    sharp_by_angle(obj, sharp_deg)
    return obj


def box(name, col, size, mat=None, bevel=0.012, segments=2, origin=(0, 0, 0),
        rot=None, taper=None, tint=None):
    """Bevelled box of game-space size (sx, sy, sz) centred on origin.
    taper = (kx, kz): scale of the +y face relative to the -y face."""
    sx, sy, sz = size
    bm = bmesh.new()
    pts = []
    for dy in (-0.5, 0.5):
        k = (1.0, 1.0) if (taper is None or dy < 0) else taper
        for dx, dz in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)):
            pts.append(Vector((dx * sx * k[0], dy * sy, dz * sz * k[1])))
    R = rot if rot is not None else Matrix.Identity(3)
    O = Vector(origin)
    vs = [bm.verts.new(G(*(R @ p + O))) for p in pts]
    for quad in ((0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)):
        bm.faces.new([vs[i] for i in quad])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    obj = _finish(name, bm, col, mat, smooth=True, tint=tint)
    if bevel:
        add_bevel(obj, bevel, segments, 30)
        apply_modifiers(obj)
    sharp_by_angle(obj, 40)
    return obj


def frame_from(normal, tangent):
    """3x3 game-space rotation whose +y is `normal` and +z follows `tangent`."""
    y = Vector(normal).normalized()
    z = Vector(tangent) - y * Vector(tangent).dot(y)
    if z.length < 1e-6:
        z = Vector((0, 0, 1)) - y * y.z
    z.normalize()
    x = y.cross(z)
    return Matrix((x, y, z)).transposed()


def tube(name, col, pts, r, mat=None, segs=10, tint=None):
    """Round tube through game-space points (polyline, mitred)."""
    bm = bmesh.new()
    rings = []
    P = [Vector(p) for p in pts]
    up = Vector((0, 1, 0))
    for i, p in enumerate(P):
        d = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
        a = d.cross(up)
        if a.length < 1e-4:
            a = d.cross(Vector((1, 0, 0)))
        a.normalize()
        b = d.cross(a)
        rings.append([bm.verts.new(G(*(p + (a * math.cos(t) + b * math.sin(t)) * r)))
                      for t in (2 * math.pi * k / segs for k in range(segs))])
    for i in range(len(rings) - 1):
        for k in range(segs):
            k2 = (k + 1) % segs
            bm.faces.new((rings[i][k], rings[i + 1][k], rings[i + 1][k2], rings[i][k2]))
    for ring, rev in ((rings[0], False), (rings[-1], True)):
        try:
            bm.faces.new(ring[::-1] if rev else ring)
        except ValueError:
            pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    obj = _finish(name, bm, col, mat, tint=tint)
    sharp_by_angle(obj, 50)
    return obj


def revolve(name, col, profile, origin, direction, segs=24, mat=None, tint=None, sharp_deg=28):
    """Revolve profile [(r, a)] about an arbitrary game-space axis.
    Faces point outward where the profile runs toward +a."""
    d = Vector(direction).normalized()
    ref = Vector((0, 1, 0)) if abs(d.y) < 0.9 else Vector((1, 0, 0))
    u = ref.cross(d).normalized()
    v = d.cross(u)
    o = Vector(origin)
    bm = bmesh.new()
    rings = []
    for (r, a) in profile:
        rings.append([bm.verts.new(G(*(o + d * a + (u * math.cos(t) + v * math.sin(t)) * r)))
                      for t in (2 * math.pi * k / segs for k in range(segs))])
    for i in range(len(rings) - 1):
        if profile[i][0] < 1e-6 and profile[i + 1][0] < 1e-6:
            continue
        for k in range(segs):
            k2 = (k + 1) % segs
            try:
                bm.faces.new((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]))
            except ValueError:
                pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    obj = _finish(name, bm, col, mat, tint=tint)
    sharp_by_angle(obj, sharp_deg)
    return obj


def text(name, col, body, height, place, mat=None, tint=0.5, align='CENTER', outward=None):
    """Flat lettering as real geometry.  place(u, v) -> game-space point, with
    u along the baseline and v up the cap height, both in metres."""
    cu = bpy.data.curves.new(name + '-font', 'FONT')
    cu.body = body
    cu.size = height / 0.72          # cap height of the built-in face
    cu.align_x = align
    cu.resolution_u = 6
    cu.fill_mode = 'FRONT'
    tmp = bpy.data.objects.new(name + '-tmp', cu)
    col.objects.link(tmp)
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    src = tmp.evaluated_get(deps).to_mesh()
    bm = bmesh.new()
    bm.from_mesh(src)
    tmp.to_mesh_clear()
    bpy.data.objects.remove(tmp)
    # the mapping may be left-handed; decide winding from the mapped normal
    for vtx in bm.verts:
        p = place(vtx.co.x, vtx.co.y)
        vtx.co = G(*p)
    if outward is not None:
        bm.normal_update()
        want = Gv(outward)
        if sum(f.normal.dot(want) * f.calc_area() for f in bm.faces) < 0:
            bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    obj = _finish(name, bm, col, mat, smooth=False, tint=tint)
    return obj


def flip_faces(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def quads(name, col, quad_list, mat=None, away_from=None, tint=0.5, smooth=False):
    """Loose quads/tris from game-space points.  With away_from set, each face
    is wound to face away from that point (closures around a solid)."""
    bm = bmesh.new()
    c = Vector(away_from) if away_from is not None else None
    for q in quad_list:
        pts = [Vector(p) for p in q]
        if c is not None:
            n = (pts[1] - pts[0]).cross(pts[2] - pts[0])
            mid = sum(pts, Vector()) / len(pts)
            if n.dot(mid - c) < 0:
                pts = pts[::-1]
        try:
            bm.faces.new([bm.verts.new(G(*p)) for p in pts])
        except ValueError:
            pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    obj = _finish(name, bm, col, mat, smooth=smooth, tint=tint)
    return obj



def strip_between(a_pts, b_pts):
    """quad list bridging two equal-length polylines"""
    return [(a_pts[i], a_pts[i + 1], b_pts[i + 1], b_pts[i]) for i in range(len(a_pts) - 1)]
