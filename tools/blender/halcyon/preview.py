"""Cycles preview renders, so every modelling step can be looked at."""
import math
import bpy
from .common import G


def setup_cycles(scene, samples=48, res=(1280, 720)):
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'OPTIX'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type in ('OPTIX',)
    scene.cycles.device = 'GPU'
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = 'OPTIX'
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.image_settings.file_format = 'PNG'
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Medium High Contrast'


def studio_world(scene, sky=0.035, color=(0.55, 0.65, 0.85)):
    world = bpy.data.worlds.new('preview')
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs[0].default_value = (*color, 1)
    bg.inputs[1].default_value = sky
    scene.world = world


def add_sun(direction, strength=4.0, color=(1, 0.96, 0.9), angle=0.6, name='sun'):
    """direction: game-space vector pointing FROM the surface TO the sun"""
    data = bpy.data.lights.new(name, 'SUN')
    data.energy = strength
    data.color = color
    data.angle = math.radians(angle)
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    d = G(*direction).normalized()
    obj.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    return obj


def ground_plane(y, size=400, rgb=(0.32, 0.27, 0.2)):
    """a matte pad under the parked ship, for bounce light in underside views"""
    import bmesh
    bm = bmesh.new()
    vs = [bm.verts.new(G(sx * size, y, sz * size)) for sx, sz in ((-1, -1), (-1, 1), (1, 1), (1, -1))]
    bm.faces.new(vs)
    me = bpy.data.meshes.new('ground')
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new('ground', me)
    bpy.context.scene.collection.objects.link(obj)
    m = bpy.data.materials.new('ground')
    m.use_nodes = True
    m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*rgb, 1)
    m.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.9
    me.materials.append(m)
    world = bpy.context.scene.world
    world.node_tree.nodes['Background'].inputs[1].default_value = 0.9
    return obj


def add_camera(name='cam'):
    data = bpy.data.cameras.new(name)
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.scene.camera = obj
    return obj


def aim(cam, eye, target, lens=50):
    """eye / target in game coords"""
    e, t = G(*eye), G(*target)
    cam.location = e
    cam.rotation_euler = (t - e).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = lens
    cam.data.clip_start = 0.05
    cam.data.clip_end = 500


def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
