// Baked tile sets — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/baked.ts
// (types stripped only; logic, constants and comments unchanged).
// Adaptation: BASE path points at this project's /assets/halcyon/ directory.
import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 *  BAKED TILE SETS  (lifted from TheLongSilence's models/)
 *
 *  WHY THESE REPLACE THE CANVAS TEXTURES
 *
 *  Every map in this project used to be drawn on a <canvas> at boot:
 *  plates, seams, rivets, vents, wear, and a Sobel-derived normal.  That
 *  is a procedural field evaluated once per pixel, and TLS's own notes
 *  spell out why it can never look right — "MSAA antialiases triangle
 *  coverage, not shading".  A hard-edged rivet or seam drawn at one
 *  sample per pixel has no mip chain to prefilter it, so it shimmers and
 *  crawls at distance, and that crawl is a large part of the "toy" read.
 *
 *  These are baked in Blender, prefiltered by the GPU, and sampled
 *  anisotropically, which is the whole difference:
 *
 *    panel_*   2.0 m tile — hull plating: irregular plates, welds,
 *              rivets, a recessed hatch, a louvre vent, stencils
 *    deck_*    1.5 m tile — deck plate: raised anti-slip, countersunk
 *              fasteners, plate seams
 *    soft_*    upholstery / acoustic liner / rubber, so the plate model
 *              does not run seams and placards across a seat cushion
 *
 *  ORM packing: R = ambient occlusion, G = roughness, B = metalness.
 *  three reads exactly those channels for aoMap/roughnessMap/metalnessMap,
 *  so one texture feeds three slots with no shader work.  The baked
 *  occlusion in R is the part the canvas pipeline had no answer for:
 *  contact shadow in every seam and corner.
 *
 *  Albedo is authored near white and carries only modulation — the palette
 *  stays in `material.color`, one place instead of nine files.
 *
 *  LOADING.  buildMaterials() is synchronous and runs before the first
 *  frame, so a null sampler would leave the whole pass undefined.  Each
 *  map starts as a 1x1 canvas of the right neutral value and swaps in when
 *  the webp lands.  Per-material tiling needs separate texture objects, so
 *  `view()` hands out clones and registers them for the same swap —
 *  cloning before the image arrives would otherwise freeze the clone on the
 *  placeholder forever.
 * ------------------------------------------------------------------ */

const BASE = '/assets/halcyon/';

function placeholder(rgb) {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const g = c.getContext('2d');
  g.fillStyle = rgb;
  g.fillRect(0, 0, 1, 1);
  const t = new THREE.Texture(c);
  t.needsUpdate = true;
  return t;
}

class Tile {
  constructor(file, srgb, neutral, aniso, loader) {
    const t = (this.base = placeholder(neutral));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = aniso;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    this.views = [];
    this.image = null;
    this.disposed = false;
    loader.load(
      BASE + file,
      (img) => {
        if(this.disposed)return;
        // WebGL2 allocates immutable storage for the 1x1 placeholder. Release
        // every owner before changing its shared Source; an image update alone
        // would upload 1024/2048 texels into that original one-pixel allocation.
        const owned=[t,...this.views];
        for(const texture of owned)texture.dispose();
        this.image = img.image;
        const source=new THREE.Source(this.image);
        for(const texture of owned){texture.source=source;this.adopt(texture);}
      },
      undefined,
      () => { /* keep the placeholder — an untextured ship beats a black one */ },
    );
  }

  adopt(t) {
    if (!this.image || this.disposed) return;
    t.image = this.image;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
  }

  /** a clone with its own repeat, kept in sync with the real image */
  view(rx, ry = rx) {
    if(this.disposed)throw new Error('Cannot create a view of a disposed tile');
    const v = this.base.clone();
    v.wrapS = v.wrapT = THREE.RepeatWrapping;
    v.repeat.set(rx, ry);
    v.anisotropy = this.base.anisotropy;
    v.colorSpace = this.base.colorSpace;
    v.needsUpdate = true;
    this.views.push(v);
    this.adopt(v);
    return v;
  }

  dispose() {
    if(this.disposed)return;this.disposed=true;
    this.base.dispose();
    for (const v of this.views) v.dispose();
    this.views.length = 0;
  }
}

export class TileSet {
  constructor(name, aniso, loader, albNeutral, ormNeutral) {
    this.alb = new Tile(`${name}_albedo.webp`, true, albNeutral, aniso, loader);
    this.nrm = new Tile(`${name}_normal.webp`, false, '#8080ff', aniso, loader);
    this.orm = new Tile(`${name}_orm.webp`, false, ormNeutral, aniso, loader);
  }
  dispose() { this.alb.dispose(); this.nrm.dispose(); this.orm.dispose(); }
}

export function loadBaked(maxAniso = 8) {
  const aniso = Math.min(8, maxAniso);
  const loader = new THREE.TextureLoader();
  /* neutrals match the baked averages so the frame or two before the webp
     lands reads as an untextured ship rather than a colour pop */
  const panel = new TileSet('panel', aniso, loader, '#d8d5cf', '#ffd400');
  const deck = new TileSet('deck', aniso, loader, '#cfccc6', '#ffd400');
  const soft = new TileSet('soft', aniso, loader, '#d0cdc8', '#e8e000');
  return { panel, deck, soft, dispose() { panel.dispose(); deck.dispose(); soft.dispose(); } };
}

/**
 * Bind a baked set to a standard material.
 *
 * aoMap/roughnessMap/metalnessMap are the SAME ORM texture — three samples
 * .r/.g/.b respectively, which is exactly the packing Blender wrote.  They
 * must be separate texture objects only when the repeat differs, so the
 * three slots share one `view`.
 *
 * @param {THREE.MeshStandardMaterial} m
 * @param {TileSet} set
 * @param {object} o dress options (rep/repY/normalScale/ao/micro/albRep/
 *   roughLo/roughHi/bare/cav/edge/edgeTint/macro/macroScale/microRep/microN/microR)
 */
export function dress(
  m,
  set,
  o,
) {
  const {
    rep, repY = rep, normalScale = 1, ao = 1, micro = false,
    albRep, albRepY,
    roughLo, roughHi, bare = 0,
    cav = 0, edge = 0, edgeTint = [0.74, 0.75, 0.78],
    macro = 0, macroScale = 3.0,
    microRep = 0, microN = 0.55, microR = 0.22,
  } = o;
  if (!micro) m.map = set.alb.view(rep, repY);
  else if (albRep) m.map = set.alb.view(albRep, albRepY ?? albRep);
  m.normalMap = set.nrm.view(rep, repY);
  m.normalScale = new THREE.Vector2(normalScale, normalScale);

  const orm = set.orm.view(rep, repY);
  if (ao > 0) {
    m.aoMap = orm;
    m.aoMapIntensity = ao;
  }
  m.roughnessMap = orm;
  if (bare > 0) m.metalnessMap = orm;

  const remap = roughLo !== undefined && roughHi !== undefined;
  const useCav = cav > 0 || edge > 0;
  const useMacro = macro > 0;
  const useMicro = microRep > 0;
  if (remap || bare > 0 || useCav || useMacro || useMicro) {
    const lo = roughLo ?? 0, hi = roughHi ?? 1;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uRoughLo = { value: lo };
      shader.uniforms.uRoughHi = { value: hi };
      shader.uniforms.uBare = { value: bare };
      shader.uniforms.uCav = { value: cav };
      shader.uniforms.uEdge = { value: edge };
      shader.uniforms.uEdgeTint = { value: new THREE.Color(edgeTint[0], edgeTint[1], edgeTint[2]) };
      shader.uniforms.uMacro = { value: macro };
      shader.uniforms.uMacroScale = { value: 1 / macroScale };
      if (useMicro) {
        /* The same two textures, no extra memory: only the UV multiplier
           differs, and it is relative to the main repeat because three has
           already folded that into vNormalMapUv. */
        shader.uniforms.uMicroNrm = { value: m.normalMap };
        shader.uniforms.uMicroOrm = { value: orm };
        shader.uniforms.uMicroRep = { value: microRep / rep };
        shader.uniforms.uMicroN = { value: microN };
        shader.uniforms.uMicroR = { value: microR };
      }

      if (useCav) {
        /* Missing attribute defaults to zero in WebGL, so a mesh that was
           never baked simply gets no cavity term rather than breaking. */
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute vec2 aCav;\nvarying vec2 vCav;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvCav = aCav;');
      }
      if (useMacro) {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvObjPos = position;');
      }

      let f = shader.fragmentShader.replace(
        'uniform float roughness;',
        'uniform float roughness;\nuniform float uRoughLo;\nuniform float uRoughHi;\nuniform float uBare;\n'
        + 'uniform float uCav;\nuniform float uEdge;\nuniform vec3 uEdgeTint;\n'
        + 'uniform float uMacro;\nuniform float uMacroScale;'
        + (useMicro ? '\nuniform sampler2D uMicroNrm;\nuniform sampler2D uMicroOrm;\n'
          + 'uniform float uMicroRep;\nuniform float uMicroN;\nuniform float uMicroR;' : '')
        + (useCav ? '\nvarying vec2 vCav;' : '')
        + (useMacro ? '\nvarying vec3 vObjPos;\n'
          /* quintic and non-symmetric, for the reason written up at length in
             environment.ts: a smoothstep fade is C1 but not C2, and a
             curvature step on a large low-contrast surface is exactly what
             the eye reads as a crease.  This field's whole job is large flat
             hull panels, so it is the worst possible place to leave one. */
          + 'float mh3(vec3 p){ p = fract(p * vec3(0.1031, 0.1030, 0.0973));\n'
          + '  p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }\n'
          + 'float mn3(vec3 x){ vec3 i = floor(x), f = fract(x);\n'
          + '  f = f*f*f*(f*(f*6.0-15.0)+10.0);\n'
          + '  return mix(mix(mix(mh3(i), mh3(i+vec3(1,0,0)), f.x), mix(mh3(i+vec3(0,1,0)), mh3(i+vec3(1,1,0)), f.x), f.y),\n'
          + '             mix(mix(mh3(i+vec3(0,0,1)), mh3(i+vec3(1,0,1)), f.x), mix(mh3(i+vec3(0,1,1)), mh3(i+vec3(1,1,1)), f.x), f.y), f.z); }'
          : ''),
      );
      if (useMicro) {
        /* Tangent-space detail blend, injected where three builds mapN so it
           happens BEFORE the TBN transform — perturbing after that would be
           perturbing a view-space vector with a tangent-space offset. */
        f = f.replace(
          'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
          'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;\n'
          + '\tvec3 microN = texture2D( uMicroNrm, vNormalMapUv * uMicroRep ).xyz * 2.0 - 1.0;\n'
          + '\tmapN = normalize( vec3( mapN.xy + microN.xy * uMicroN, mapN.z ) );',
        );
        f = f.replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n'
          + '\troughnessFactor = clamp( roughnessFactor\n'
          + '\t\t+ ( texture2D( uMicroOrm, vNormalMapUv * uMicroRep ).g - 0.5 ) * uMicroR, 0.03, 1.0 );',
        );
      }
      if (remap) {
        f = f.replace(
          'roughnessFactor *= texelRoughness.g;',
          'roughnessFactor = mix( uRoughLo, uRoughHi, texelRoughness.g );',
        );
      }
      if (bare > 0) {
        f = f.replace(
          'metalnessFactor *= texelMetalness.b;',
          'metalnessFactor = clamp( metalnessFactor + texelMetalness.b * uBare, 0.0, 1.0 );',
        );
      }
      if (useMacro) {
        /* Two octaves at metre scale: the coarse one groups panels, the finer
           one varies within a group.  Declared alongside the cavity terms at
           the top of main() for the same reason — <color_fragment> runs early. */
        f = f.replace(
          '#include <clipping_planes_fragment>',
          '#include <clipping_planes_fragment>\n'
          + '\tfloat macroV = mn3( vObjPos * uMacroScale ) * 0.68\n'
          + '\t             + mn3( vObjPos * uMacroScale * 2.7 + 13.1 ) * 0.32;\n'
          + '\tmacroV = ( macroV - 0.5 ) * uMacro;',
        );
        f = f.replace(
          '#include <color_fragment>',
          '#include <color_fragment>\n'
          + '\tdiffuseColor.rgb *= 1.0 + macroV * 0.34;',
        );
        f = f.replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n'
          + '\troughnessFactor = clamp( roughnessFactor - macroV * 0.30, 0.03, 1.0 );',
        );
      }
      if (useCav) {
        /* Declared at the very top of main(), NOT where it is first used:
           three emits <color_fragment> well before <roughnessmap_fragment>,
           so deriving these next to the roughness edit put a use before its
           declaration and the whole program failed to compile. */
        f = f.replace(
          '#include <clipping_planes_fragment>',
          '#include <clipping_planes_fragment>\n'
          + '\tfloat cavE = vCav.x * uCav;\n'
          + '\tfloat cavL = vCav.y * uEdge;',
        );
        /* Enclosure darkens and roughens — dirt collects and light does not
           reach.  An exposed edge lightens toward the tint, smooths, and
           picks up a little metal, which is what a rubbed-through chamfer
           actually is. */
        f = f.replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n'
          + '\troughnessFactor = clamp( roughnessFactor + cavE * 0.16 - cavL * 0.14, 0.03, 1.0 );',
        );
        f = f.replace(
          '#include <metalnessmap_fragment>',
          '#include <metalnessmap_fragment>\n'
          + '\tmetalnessFactor = clamp( metalnessFactor + cavL * 0.22 * uBare, 0.0, 1.0 );',
        );
        f = f.replace(
          '#include <color_fragment>',
          '#include <color_fragment>\n'
          + '\tdiffuseColor.rgb *= 1.0 - cavE * 0.62;\n'
          + '\tdiffuseColor.rgb = mix( diffuseColor.rgb, uEdgeTint, cavL * 0.28 );',
        );
      }
      shader.fragmentShader = f;
    };
    /* without this every dressed material shares one compiled program and
       the first one's constants win for all of them */
    m.customProgramCacheKey = () => `dress|${lo}|${hi}|${bare}|${cav}|${edge}|${macro}|${macroScale}|${microRep}|${microN}|${microR}`;
  }
  return m;
}
