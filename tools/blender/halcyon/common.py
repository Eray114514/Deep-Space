"""Shared helpers for the HALCYON VII Blender build.

Everything in the ship scripts is authored in GAME coordinates
(-Z forward, +Y up, x = 0 symmetry plane, y = 0 interior deck) and converted
at the last moment with G().  The glTF exporter maps Blender (x, y, z) to
glTF (x, z, -y), so game (X, Y, Z) lives at Blender (X, -Z, Y).
"""
import math
import bmesh
import bpy
from mathutils import Vector, Matrix


def G(x, y, z):
    """game coords -> Blender coords"""
    return Vector((x, -z, y))


def Gv(v):
    return Vector((v[0], -v[2], v[1]))


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    return scene


def collection(name, parent=None):
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(col)
    return col


def new_object(name, mesh, col):
    obj = bpy.data.objects.new(name, mesh)
    col.objects.link(obj)
    return obj


def mesh_from_bm(name, bm, col, smooth=True):
    """Finish a bmesh (authored in Blender coords) into a linked object."""
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    obj = new_object(name, me, col)
    return obj


def set_active(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_modifiers(obj):
    set_active(obj)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def add_bevel(obj, width=0.01, segments=2, angle_deg=35, harden=True):
    m = obj.modifiers.new('bevel', 'BEVEL')
    m.width = width
    m.segments = segments
    m.limit_method = 'ANGLE'
    m.angle_limit = math.radians(angle_deg)
    m.harden_normals = harden
    m.miter_outer = 'MITER_ARC'
    return m


def add_weighted_normal(obj):
    m = obj.modifiers.new('wn', 'WEIGHTED_NORMAL')
    m.keep_sharp = True
    m.weight = 60
    return m


def sharp_by_angle(obj, angle_deg=40):
    """Mark edges sharper than angle as sharp (smooth shading elsewhere)."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    lim = math.radians(angle_deg)
    for e in bm.edges:
        if len(e.link_faces) == 2:
            e.smooth = e.calc_face_angle(0.0) < lim
        else:
            e.smooth = False
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True


def join(objs, name=None):
    objs = [o for o in objs if o is not None]
    if not objs:
        return None
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    out = bpy.context.view_layer.objects.active
    if name:
        out.name = name
        out.data.name = name
    return out


def mirror_x_copy(obj, name=None):
    """Baked mirrored duplicate across x = 0 (normals fixed)."""
    dup = obj.copy()
    dup.data = obj.data.copy()
    for c in obj.users_collection:
        c.objects.link(dup)
    bm = bmesh.new()
    bm.from_mesh(dup.data)
    for v in bm.verts:
        v.co.x = -v.co.x
    bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bm.to_mesh(dup.data)
    bm.free()
    dup.matrix_world = obj.matrix_world.copy()
    dup.matrix_world.translation.x *= -1
    if name:
        dup.name = name
    return dup


# --------------------------------------------------------------------------
# small numeric helpers
# --------------------------------------------------------------------------
def lerp(a, b, t):
    return a + (b - a) * t


def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def smoothstep(a, b, x):
    t = clamp((x - a) / (b - a)) if b != a else (0.0 if x < a else 1.0)
    return t * t * (3 - 2 * t)


def pchip(xs, ys, x):
    """Monotone cubic (Fritsch-Carlson) interpolation, clamped at the ends."""
    n = len(xs)
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    k = 0
    while x > xs[k + 1]:
        k += 1
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    d = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]

    def slope(i):
        if i == 0:
            return d[0]
        if i == n - 1:
            return d[-1]
        if d[i - 1] * d[i] <= 0:
            return 0.0
        w1 = 2 * h[i] + h[i - 1]
        w2 = h[i] + 2 * h[i - 1]
        return (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])

    m0, m1 = slope(k), slope(k + 1)
    t = (x - xs[k]) / h[k]
    t2, t3 = t * t, t * t * t
    return ((2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h[k] * m0
            + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h[k] * m1)


class Spline:
    """Piecewise-PCHIP over keyed dicts with optional C0 breaks ('sharp')."""

    def __init__(self, keys, fields):
        self.fields = fields
        self.segments = []
        cur = [keys[0]]
        for k in keys[1:]:
            cur.append(k)
            if k.get('sharp'):
                self.segments.append(cur)
                cur = [k]
        if len(cur) > 1:
            self.segments.append(cur)
        self.lo = keys[0]['at']
        self.hi = keys[-1]['at']

    def at(self, x):
        x = clamp(x, self.lo, self.hi)
        seg = self.segments[-1]
        for s in self.segments:
            if x <= s[-1]['at']:
                seg = s
                break
        xs = [k['at'] for k in seg]
        return {f: pchip(xs, [k.get(f, 0.0) for k in seg], x) for f in self.fields}
