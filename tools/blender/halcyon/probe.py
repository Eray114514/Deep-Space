"""Reflection probes: one equirectangular HDR panorama per interior zone,
rendered from the modelled lamps, so what a console or a deck plate reflects
is the room it is actually in.

The camera looks along game +X with +Y up, which is the orientation three.js
expects of an equirectangular map (u = 0.5 at +X, increasing toward +Z).
"""
import math
import bpy
from mathutils import Vector

from .common import G

ZONES = {
    'cockpit': (0.0, 1.35, -7.9),
    'cabin': (0.0, 1.35, -0.8),
}


def render(scene, out_dir, width=512, samples=96):
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    if scene.world is None:
        scene.world = bpy.data.worlds.new('probe')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[1].default_value = 0.0
    data = bpy.data.cameras.new('probe')
    data.type = 'PANO'
    data.panorama_type = 'EQUIRECTANGULAR'
    data.clip_start = 0.02
    cam = bpy.data.objects.new('probe', data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.rotation_euler = G(1, 0, 0).to_track_quat('-Z', 'Z').to_euler()
    scene.render.resolution_x, scene.render.resolution_y = width, width // 2
    scene.render.image_settings.file_format = 'HDR'
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    for name, eye in ZONES.items():
        cam.location = G(*eye)
        scene.render.filepath = '%s/probe-%s.hdr' % (out_dir, name)
        bpy.ops.render.render(write_still=True)
        print('  probe', name)
    bpy.data.objects.remove(cam)
