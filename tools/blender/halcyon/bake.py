"""Cycles bakes, stored per vertex so they cost no texture memory and hold at
any distance:

  exterior  ambient occlusion  -> paint attribute B (as occlusion, 0 = open)
  interior  diffuse irradiance -> colour attribute `Light`, sqrt(E / RANGE)
            (direct + bounced light from every modelled lamp; the packer
            renames it to the custom attribute _IRRADIANCE)
"""
import bmesh
import bpy
import numpy as np

RANGE = 8.0


def refine(obj, max_edge=0.28, passes=5):
    """Split long edges so a flat face has enough vertices to carry lighting."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    for _ in range(passes):
        long_edges = [e for e in bm.edges if e.calc_length() > max_edge]
        if not long_edges:
            break
        bmesh.ops.subdivide_edges(bm, edges=long_edges, cuts=1)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bm.to_mesh(obj.data)
    bm.free()


def bake_wear(obj, gain=2.4):
    """Convexity per vertex into paint alpha: where paint chips first.  A
    bevelled edge, a groove lip and a corner stand proud of their neighbours;
    a flat or concave vertex scores zero."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    wear = np.zeros(len(bm.verts), dtype=np.float32)
    for v in bm.verts:
        if not v.link_edges:
            continue
        n = v.normal
        acc = 0.0
        for e in v.link_edges:
            d = e.other_vert(v).co - v.co
            L = d.length
            if L > 1e-9:
                acc += n.dot(d) / L
        wear[v.index] = max(0.0, min(1.0, -acc / len(v.link_edges) * gain))
    bm.free()
    vert = np.zeros(len(me.loops), dtype=np.int64)
    me.loops.foreach_get('vertex_index', vert)
    paint = _paint(me)
    paint[:, 3] = wear[vert]
    me.color_attributes['Color'].data.foreach_set('color', paint.ravel())
    print('  wear %-21s mean %.3f' % (obj.name, float(paint[:, 3].mean())))


def setup(scene, samples):
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'OPTIX'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == 'OPTIX'
    scene.cycles.device = 'GPU'
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 6
    scene.cycles.diffuse_bounces = 4
    if scene.world is None:
        scene.world = bpy.data.worlds.new('bake')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[1].default_value = 0.0


def _bake(obj, attr, bake_type, pass_filter=None):
    me = obj.data
    ca = me.color_attributes
    if attr in ca:
        ca.remove(ca[attr])
    layer = ca.new(attr, 'FLOAT_COLOR', 'CORNER')
    ca.active_color = layer
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    kw = dict(type=bake_type, target='VERTEX_COLORS')
    if pass_filter:
        kw['pass_filter'] = pass_filter
    bpy.ops.object.bake(**kw)
    data = np.zeros(len(me.loops) * 4, dtype=np.float32)
    ca[attr].data.foreach_get('color', data)
    return data.reshape(-1, 4)


def _share(me, values):
    """Average a per-corner bake over the corners that share a vertex AND a
    shading normal.  Hard edges keep their step in light; smooth surfaces get
    one value per vertex, so the exporter can weld them again."""
    n = len(me.loops)
    vert = np.zeros(n, dtype=np.int64)
    me.loops.foreach_get('vertex_index', vert)
    nrm = np.zeros(n * 3, dtype=np.float32)
    me.corner_normals.foreach_get('vector', nrm)
    q = np.round(nrm.reshape(-1, 3) * 24).astype(np.int64) + 32
    key = ((vert * 64 + q[:, 0]) * 64 + q[:, 1]) * 64 + q[:, 2]
    _, inverse = np.unique(key, return_inverse=True)
    count = np.bincount(inverse).astype(np.float32)
    out = np.empty_like(values)
    for c in range(values.shape[1]):
        out[:, c] = (np.bincount(inverse, weights=values[:, c]) / count)[inverse]
    return out


def _paint(me):
    data = np.zeros(len(me.loops) * 4, dtype=np.float32)
    me.color_attributes['Color'].data.foreach_get('color', data)
    return data.reshape(-1, 4)


def bake_occlusion(scene, objs, samples=96, distance=1.2):
    setup(scene, samples)
    scene.world.light_settings.distance = distance
    for obj in objs:
        me = obj.data
        ao = _bake(obj, 'AO_tmp', 'AO')
        paint = _paint(me)
        paint[:, 2] = np.clip(1.0 - _share(me, ao)[:, 0], 0.0, 1.0)
        me.color_attributes['Color'].data.foreach_set('color', paint.ravel())
        me.color_attributes.remove(me.color_attributes['AO_tmp'])
        me.color_attributes.active_color = me.color_attributes['Color']
        print('  occlusion %-16s mean %.3f  open %.2f  closed %.2f' % (obj.name, float(paint[:, 2].mean()), float((paint[:, 2] < 0.1).mean()), float((paint[:, 2] > 0.9).mean())))


def bake_soot(obj, sources, strength=0.9):
    """Exhaust staining into the occlusion channel: a soft patch round each
    source with a streak dragged aft (+z in game space)."""
    me = obj.data
    co = np.zeros(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    wm = np.array(obj.matrix_world, dtype=np.float32)
    world = co @ wm[:3, :3].T + wm[:3, 3]
    game = np.stack([world[:, 0], world[:, 2], -world[:, 1]], axis=1)      # blender -> game
    soot = np.zeros(len(game), dtype=np.float32)
    for (pos, radius, streak) in sources:
        d = game - np.array(pos, dtype=np.float32)
        t = np.clip(d[:, 2], 0.0, streak)
        q = d.copy()
        q[:, 2] -= t
        dist2 = (q * q).sum(axis=1)
        soot += np.exp(-dist2 / (radius * radius)) * (1.0 - 0.65 * t / max(streak, 1e-3))
    soot = np.clip(soot, 0.0, 1.0) * strength
    vert = np.zeros(len(me.loops), dtype=np.int64)
    me.loops.foreach_get('vertex_index', vert)
    paint = _paint(me)
    paint[:, 2] = np.maximum(paint[:, 2], soot[vert])
    me.color_attributes['Color'].data.foreach_set('color', paint.ravel())
    print('  soot %-21s max %.2f' % (obj.name, float(soot.max())))


def bake_irradiance(scene, objs, samples=192):
    setup(scene, samples)
    # every surface must report the light ARRIVING on it, so metals get a
    # diffuse lobe for the duration of the bake
    saved = []
    for m in bpy.data.materials:
        if not m.use_nodes:
            continue
        b = m.node_tree.nodes.get('Principled BSDF')
        if b is None:
            continue
        saved.append((b, b.inputs['Metallic'].default_value))
        b.inputs['Metallic'].default_value = 0.0
    for obj in objs:
        me = obj.data
        e = _bake(obj, 'Light', 'DIFFUSE', {'DIRECT', 'INDIRECT'})
        e = _share(me, e)
        e[:, :3] = np.sqrt(np.clip(e[:, :3] / RANGE, 0.0, 1.0))
        e[:, 3] = 1.0
        me.color_attributes['Light'].data.foreach_set('color', e.ravel())
        me.color_attributes.active_color = me.color_attributes['Color']
        print('  irradiance %-14s mean %.3f max %.3f' % (obj.name, float(e[:, :3].mean()), float(e[:, :3].max())))
    for b, v in saved:
        b.inputs['Metallic'].default_value = v
