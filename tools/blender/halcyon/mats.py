"""Preview / export carrier materials.

The shipped look lives in the game's own GLSL (src/halcyon); these Principled
materials only have to (a) preview believably in Cycles and (b) carry a name,
base colour, metalness and roughness through the glTF exporter.  Per-panel
tint rides in vertex colour R, groove mask in G.
"""
import bpy

PALETTE = {
    # name: (rgb, metallic, roughness)
    'hull':       ((0.74, 0.75, 0.74), 0.0, 0.42),    # ceramic white composite
    'hullDark':   ((0.045, 0.048, 0.052), 0.0, 0.72),  # black thermal tile
    'hullGrey':   ((0.30, 0.32, 0.34), 0.2, 0.50),    # mid grey access panels
    'accent':     ((0.80, 0.26, 0.05), 0.0, 0.45),    # signal orange
    'metal':      ((0.36, 0.36, 0.37), 1.0, 0.38),    # bare titanium
    'metalDark':  ((0.10, 0.10, 0.11), 1.0, 0.45),    # gunmetal mechanical
    'heat':       ((0.22, 0.17, 0.14), 1.0, 0.30),    # heat-tinted nozzle alloy
    'rubber':     ((0.02, 0.02, 0.02), 0.0, 0.85),
    'cap':        ((0.05, 0.05, 0.05), 0.5, 0.6),
    'trim':       ((0.07, 0.072, 0.078), 0.3, 0.42),   # canopy frame, door surrounds
    'deck':       ((0.16, 0.17, 0.18), 0.6, 0.55),    # walking surfaces
    'chrome':     ((0.82, 0.83, 0.85), 1.0, 0.12),    # oleo pistons
    'decal':      ((0.06, 0.065, 0.07), 0.0, 0.55),   # lettering
    'decalLight': ((0.72, 0.73, 0.72), 0.0, 0.55),    # stencils on dark surfaces
    # ---- interior
    'panelWhite': ((0.60, 0.60, 0.58), 0.0, 0.62),    # padded habitation panels
    'panelGrey':  ((0.25, 0.26, 0.28), 0.1, 0.55),
    'panelDark':  ((0.065, 0.068, 0.075), 0.2, 0.58),  # flight-deck anti-glare
    'fabric':     ((0.035, 0.037, 0.042), 0.0, 0.95),
    'foliage':    ((0.085, 0.23, 0.065), 0.0, 0.64),
    'linen':      ((0.65, 0.59, 0.47), 0.0, 0.96),
    'fabricOrange': ((0.62, 0.21, 0.04), 0.0, 0.85),
    'cushion':    ((0.11, 0.105, 0.10), 0.0, 0.88),
    'paintYellow': ((0.78, 0.56, 0.05), 0.0, 0.6),
    'crateGrey':  ((0.30, 0.32, 0.33), 0.3, 0.55),
    'crateOrange': ((0.62, 0.24, 0.05), 0.1, 0.55),
    'deckMat':    ((0.045, 0.047, 0.05), 0.0, 0.9),    # rubber walkway
}


def make(name, rgb, metallic, roughness, tint=True, debug=False):
    m = bpy.data.materials.new(name)
    m.use_backface_culling = True
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    if tint:
        vc = nt.nodes.new('ShaderNodeVertexColor')
        vc.layer_name = 'Color'
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(vc.outputs['Color'], sep.inputs['Color'])
        # tint = 0.89 + 0.22 * R ; groove darkening = 1 - 0.85 * G
        t = nt.nodes.new('ShaderNodeMath')
        t.operation = 'MULTIPLY_ADD'
        t.inputs[1].default_value = 0.22
        t.inputs[2].default_value = 0.89
        nt.links.new(sep.outputs[0], t.inputs[0])
        g = nt.nodes.new('ShaderNodeMath')
        g.operation = 'MULTIPLY_ADD'
        g.inputs[1].default_value = -0.85
        g.inputs[2].default_value = 1.0
        nt.links.new(sep.outputs[1], g.inputs[0])
        k = nt.nodes.new('ShaderNodeMath')
        k.operation = 'MULTIPLY'
        nt.links.new(t.outputs[0], k.inputs[0])
        nt.links.new(g.outputs[0], k.inputs[1])
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs[0].default_value = 1.0
        mix.inputs[6].default_value = (*rgb, 1)
        nt.links.new(k.outputs[0], mix.inputs[7])
        nt.links.new(mix.outputs[2], bsdf.inputs['Base Color'])
        r = nt.nodes.new('ShaderNodeMath')
        r.operation = 'MULTIPLY_ADD'
        r.inputs[1].default_value = 0.16
        r.inputs[2].default_value = roughness - 0.08
        nt.links.new(sep.outputs[0], r.inputs[0])
        nt.links.new(r.outputs[0], bsdf.inputs['Roughness'])
    if debug:
        backface_flag(m)
    return m


def backface_flag(m):
    """Preview only: paint back faces magenta, because Cycles shades both
    sides and a wrong winding would otherwise only show up in the game."""
    nt = m.node_tree
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    src = out.inputs['Surface'].links[0].from_socket
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs[0].default_value = (1, 0, 1, 1)
    em.inputs[1].default_value = 4.0
    ms = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(geo.outputs['Backfacing'], ms.inputs[0])
    nt.links.new(src, ms.inputs[1])
    nt.links.new(em.outputs[0], ms.inputs[2])
    nt.links.new(ms.outputs[0], out.inputs['Surface'])


def glass(name='glass', debug=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.62, 0.70, 0.74, 1)
    b.inputs['Transmission Weight'].default_value = 1.0
    b.inputs['IOR'].default_value = 1.15
    b.inputs['Roughness'].default_value = 0.02
    m.use_backface_culling = False
    if debug:
        backface_flag(m)
    return m


def emissive(name, rgb, strength, debug=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.02, 0.02, 0.02, 1)
    b.inputs['Emission Color'].default_value = (*rgb, 1)
    b.inputs['Emission Strength'].default_value = strength
    if debug:
        backface_flag(m)
    return m


def library(debug=False):
    lib = {k: make(k, *v, debug=debug) for k, v in PALETTE.items()}
    lib['glass'] = glass(debug=False)
    lib['hudGlass'] = glass('hudGlass', debug=False)
    lib['bellInner'] = make('bellInner', (0.16, 0.14, 0.13), 1.0, 0.35, debug=debug)
    lib['hudGlass'].node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.45, 0.85, 0.95, 1)
    lib['engineCore'] = emissive('engineCore', (1.0, 0.83, 0.49), 6.0, debug)
    lib['lampWhite'] = emissive('lampWhite', (1.0, 0.97, 0.9), 8.0, debug)
    lib['trimTwoSided'] = make('trimTwoSided', (0.07, 0.072, 0.078), 0.3, 0.42, debug=False)
    lib['trimTwoSided'].use_backface_culling = False
    lib['screen'] = emissive('screen', (0.25, 0.75, 0.9), 1.2, debug)
    lib['lampWarm'] = emissive('lampWarm', (1.0, 0.78, 0.52), 5.0, debug)
    lib['lampCool'] = emissive('lampCool', (0.82, 0.91, 1.0), 4.5, debug)
    lib['lampAmber'] = emissive('lampAmber', (1.0, 0.55, 0.12), 10.0, debug)
    lib['lampCyan'] = emissive('lampCyan', (0.35, 0.85, 1.0), 3.0, debug)
    lib['btnGreen'] = emissive('btnGreen', (0.2, 1.0, 0.45), 3.0, debug)
    lib['btnAmber'] = emissive('btnAmber', (1.0, 0.6, 0.15), 3.0, debug)
    lib['btnWhite'] = emissive('btnWhite', (0.9, 0.95, 1.0), 3.0, debug)
    lib['strobe'] = emissive('strobe', (1.0, 1.0, 1.0), 10.0, debug)
    lib['lampStrip'] = emissive('lampStrip', (0.75, 0.9, 1.0), 4.0, debug)
    lib['lampRed'] = emissive('lampRed', (1.0, 0.08, 0.04), 8.0, debug)
    lib['lampGreen'] = emissive('lampGreen', (0.1, 1.0, 0.3), 8.0, debug)
    return lib
