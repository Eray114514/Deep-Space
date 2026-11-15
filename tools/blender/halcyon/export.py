"""Join the build into game nodes and write the GLB.

Node contract (read by src/halcyon/ship/model.js):
  exterior            static hull, wings, engines, fittings (primitive per material)
  ramp                cargo ramp, origin on the hinge line
  gear-nose / gear-main-stbd / gear-main-port   origin at the trunnion
  cockpit / interior  static interior, zone per node
  mfd-N-kind          one quad per live display (unit plane, scaled)
  engine-N            empties at each nozzle exit; scale.x = bell radius
Vertex colour: R = per-panel tint, G = seam groove mask.
"""
import bpy
from mathutils import Matrix

from .common import G
from .design import DIMS, ENGINES


def join_group(name, objs, pivot=None):
    objs = [o for o in objs if o is not None and o.name in bpy.data.objects]
    for o in objs:
        if o.data.users > 1:
            o.data = o.data.copy()
    with bpy.context.temp_override(active_object=objs[0], selected_editable_objects=objs,
                                   selected_objects=objs, object=objs[0]):
        bpy.ops.object.join()
    obj = objs[0]
    obj.name = name
    obj.data.name = name
    obj.data.validate()
    ca = obj.data.color_attributes
    if 'Color' in ca:
        ca.active_color = ca['Color']
        ca.render_color_index = list(ca.keys()).index('Color')
    if pivot is not None:
        p = G(*pivot)
        obj.data.transform(Matrix.Translation(-p))
        obj.matrix_world = Matrix.Translation(p)
    return obj


def finalize(groups, gear_pivots, glows=()):
    nodes = {}
    nodes['exterior'] = join_group('exterior', groups['exterior'])
    nodes['ramp'] = join_group('ramp', groups['ramp'], (0, DIMS['rampHingeY'], DIMS['rampHingeZ']))
    for key, pivot in gear_pivots.items():
        nodes[key] = join_group(key, groups[key], pivot)
    nodes['cockpit'] = join_group('cockpit', groups['cockpit'])
    nodes['interior'] = join_group('interior', groups['interior'])
    for i, e in enumerate(ENGINES):
        em = bpy.data.objects.new('engine-%d' % i, None)
        bpy.context.scene.collection.objects.link(em)
        em.location = G(e['x'], e['y'], e['z'])
        em.scale = (e['r'], e['r'], e['r'])
        nodes[em.name] = em
    for name, pos in glows:
        em = bpy.data.objects.new(name, None)
        bpy.context.scene.collection.objects.link(em)
        em.location = G(*pos)
        nodes[em.name] = em
    return nodes


def write(path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.data.objects:
        if o.type in ('MESH', 'EMPTY'):
            o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True,
        export_apply=True, export_yup=True,
        export_normals=True, export_tangents=False, export_texcoords=True,
        export_materials='EXPORT', export_vertex_color='ACTIVE', export_all_vertex_colors=True,
        export_active_vertex_color_when_no_material=True,
        export_attributes=True, export_cameras=False, export_lights=False,
        export_animations=False, export_skins=False, export_morph=False, export_extras=False,
    )
