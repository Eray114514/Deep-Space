"""Build the HALCYON VII in Blender.

  blender -b --factory-startup --python tools/blender/build_halcyon.py -- \
      [--preview DIR --views a,b,c] [--export DIR] [--bake]
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402,F401
from halcyon import common, exterior, interior, cockpit, export, bake, probe  # noqa: E402
from halcyon import mats, preview as pv  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


t0 = time.time()
scene = common.reset_scene()
M = mats.library(debug='--export' not in argv and '--nodebug' not in argv)
groups = exterior.build(M)
gear_pivots = groups.pop('gear-pivots')
icol = common.collection('interior')
cockpit_parts, screens, cockpit_outline = cockpit.build(M, icol)
groups['cockpit'] = cockpit_parts
groups['screens'] = screens
groups['interior'] = interior.build(M, icol, cockpit_outline)
for k, objs in groups.items():
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)
    print('  %-16s %4d objects %7d tris' % (k, len(objs), tris))
print('built in %.1fs' % (time.time() - t0))

INTERIOR_VIEWS = {
    'pilot': ((0, 1.50, -7.70), (0, 1.22, -12), 16),
    'pilot-down': ((0, 1.50, -7.70), (0, 0.5, -9.6), 16),
    'pilot-left': ((0, 1.50, -7.70), (-3, 1.0, -8.6), 16),
    'cockpit-aft': ((0.0, 1.66, -5.75), (0, 1.0, -9.5), 16),
    'cockpit-side': ((1.5, 1.5, -6.3), (-0.6, 0.8, -8.6), 18),
    'mid': ((0, 1.62, -1.25), (0, 1.25, -6), 16),
    'mid-fwd': ((0, 1.62, -5.2), (0, 1.25, 0), 16),
    'galley': ((0.95, 1.5, -2.2), (-1.7, 1.0, -3.8), 18),
    'bunks': ((-0.95, 1.5, -2.2), (1.7, 0.95, -3.8), 18),
    'hold': ((0, 1.65, 5.7), (0, 1.15, -1.0), 15),
    'hold-aft': ((0, 1.62, -0.35), (0, 1.0, 6.5), 15),
    'hold-bench': ((-0.9, 1.55, 2.6), (1.9, 1.0, 4.4), 18),
}

if '--preview' in argv:
    out = arg('--preview')
    views = arg('--views', '').split(',')
    inside = [v for v in views if v in INTERIOR_VIEWS]
    outside = [v for v in views if v in exterior.VIEWS]
    if outside:
        exterior.preview(scene, out, outside)
    if inside:
        os.makedirs(out, exist_ok=True)
        pv.setup_cycles(scene, samples=int(arg('--samples', 96)))
        if scene.world is None:
            pv.studio_world(scene, sky=0.0)
        else:
            scene.world.node_tree.nodes['Background'].inputs[1].default_value = 0.0
        for o in bpy.data.objects:
            if o.type == 'LIGHT':
                o.hide_render = '--sun' not in argv
        if '--sun' in argv and not any(o.type == 'LIGHT' for o in bpy.data.objects):
            pv.add_sun((-0.35, 0.55, -0.75), strength=3.0)
        cam = scene.camera or pv.add_camera()
        scene.view_settings.exposure = float(arg('--exposure', 0.0))
        for name in inside:
            eye, target, lens = INTERIOR_VIEWS[name]
            pv.aim(cam, eye, target, lens)
            pv.render(os.path.join(out, name + '.png'))
if '--export' in argv:
    out = arg('--export')
    os.makedirs(out, exist_ok=True)
    if '--nobake' not in argv:
        bake.setup(scene, 96)
        probe.render(scene, out)
    nodes = export.finalize(groups, gear_pivots)
    for node in nodes.values():
        if node.type == 'MESH':
            bake.bake_wear(node)
    if '--nobake' not in argv:
        tb = time.time()
        bake.bake_irradiance(scene, [nodes['cockpit'], nodes['interior']], samples=int(arg('--samples', 192)))
        bake.bake_occlusion(scene, [nodes[k] for k in ('exterior', 'ramp', 'gear-nose', 'gear-main-stbd', 'gear-main-port')])
        print('baked in %.1fs' % (time.time() - tb))
    export.write(os.path.join(out, 'halcyon.raw.glb'))
    print('exported', os.path.join(out, 'halcyon.raw.glb'))
print('done in %.1fs' % (time.time() - t0))
