// Surface library for the Blender-authored HALCYON VII (assets/halcyon/halcyon.glb).
//
// The model carries its design in geometry, not in a tiled texture: panel
// seams are real grooves, panels are flood-filled regions, and every vertex
// has a paint attribute — R is a per-panel random value, G marks groove faces.
// Base colour, metalness and roughness come from the file (authored in
// tools/blender/halcyon/mats.py); what lives here is how one panel differs
// from the next and how the finish has weathered, evaluated procedurally in
// object space (metres).  Nothing tiles and nothing depends on texel density,
// so it holds from formation distance to arm's length.
import * as THREE from 'three';

/* tint: panel-to-panel albedo spread.  rough: panel-to-panel gloss spread.
   grime: streaking and blotch depth.  noise: sub-panel gloss breakup.
   tile: thermal-tile grid pitch in metres (0 = none).
   relief: the micro-surface a hand would feel (see RELIEF).
   wear: how readily the finish chips on proud edges (paint attribute A is
   baked convexity); bare / bareMetal: what shows through when it does. */
const PRIMER = [0.30, 0.31, 0.32], ALLOY = [0.42, 0.43, 0.45];
const FINISH = {
  hull:        { tint: 0.14, rough: 0.16, grime: 0.22, noise: 0.10, coat: 0.55, relief: 'peel', wear: 0.32, bare: PRIMER, bareMetal: 0 },
  hullGrey:    { tint: 0.14, rough: 0.14, grime: 0.20, noise: 0.10, coat: 0.45, relief: 'peel', wear: 0.7, bare: ALLOY, bareMetal: 0.8 },
  hullDark:    { tint: 0.30, rough: 0.16, grime: 0.14, noise: 0.08, tile: 0.16, wear: 0.5, bare: [0.15, 0.15, 0.16], bareMetal: 0 },
  accent:      { tint: 0.10, rough: 0.12, grime: 0.26, noise: 0.10, coat: 0.55, relief: 'peel', wear: 0.8, bare: PRIMER, bareMetal: 0 },
  trim:        { tint: 0.10, rough: 0.10, grime: 0.10, noise: 0.08, relief: 'peel', wear: 0.7, bare: ALLOY, bareMetal: 0.8 },
  trimTwoSided: { tint: 0.0, rough: 0.0, grime: 0.0, noise: 0.06, side: THREE.DoubleSide },
  decal:       { tint: 0.0, rough: 0.0, grime: 0.20, noise: 0.08, offset: true, side: THREE.DoubleSide },
  decalLight:  { tint: 0.0, rough: 0.0, grime: 0.30, noise: 0.08, offset: true, side: THREE.DoubleSide },
  cap:         { tint: 0.0, rough: 0.0, grime: 0.15, noise: 0.10 },
  metal:       { tint: 0.10, rough: 0.14, grime: 0.14, noise: 0.14, relief: 'brushed', wear: 0.3, bare: [0.6, 0.6, 0.62], bareMetal: 1 },
  metalDark:   { tint: 0.14, rough: 0.14, grime: 0.16, noise: 0.14, relief: 'brushed', wear: 0.9, bare: [0.5, 0.5, 0.52], bareMetal: 1 },
  heat:        { tint: 0.30, rough: 0.16, grime: 0.24, noise: 0.16, relief: 'brushed', wear: 0.4, bare: [0.5, 0.45, 0.4], bareMetal: 1 },
  chrome:      { tint: 0.0, rough: 0.0, grime: 0.04, noise: 0.04 },
  rubber:      { tint: 0.0, rough: 0.0, grime: 0.08, noise: 0.06, relief: 'ribs' },
  // interior
  panelWhite:  { tint: 0.10, rough: 0.10, grime: 0.10, noise: 0.08, relief: 'quilt', wear: 0.35, bare: PRIMER, bareMetal: 0 },
  panelGrey:   { tint: 0.12, rough: 0.10, grime: 0.10, noise: 0.08, relief: 'peel', wear: 0.8, bare: ALLOY, bareMetal: 0.8 },
  panelDark:   { tint: 0.14, rough: 0.10, grime: 0.06, noise: 0.08, relief: 'peel', wear: 0.9, bare: ALLOY, bareMetal: 0.8 },
  deck:        { tint: 0.14, rough: 0.16, grime: 0.26, noise: 0.18, relief: 'studs', wear: 0.9, bare: [0.55, 0.55, 0.57], bareMetal: 1 },
  deckMat:     { tint: 0.06, rough: 0.04, grime: 0.14, noise: 0.08, relief: 'ribs' },
  fabric:      { tint: 0.0, rough: 0.0, grime: 0.0, noise: 0.05, relief: 'weave' },
  fabricOrange: { tint: 0.0, rough: 0.0, grime: 0.08, noise: 0.06, relief: 'weave' },
  cushion:     { tint: 0.0, rough: 0.0, grime: 0.06, noise: 0.08, relief: 'leather' },
  paintYellow: { tint: 0.0, rough: 0.0, grime: 0.28, noise: 0.10, wear: 0.9, bare: ALLOY, bareMetal: 0.8 },
  crateGrey:   { tint: 0.30, rough: 0.14, grime: 0.24, noise: 0.14, relief: 'peel', wear: 1.0, bare: ALLOY, bareMetal: 0.9 },
  crateOrange: { tint: 0.24, rough: 0.14, grime: 0.24, noise: 0.14, relief: 'peel', wear: 1.0, bare: ALLOY, bareMetal: 0.9 },
};

/* Micro-relief as a height field in metres over p (the surface's own plane,
   metres) or P (object space).  `span` is the feature size: the bump fades
   out before it drops under a pixel. */
const RELIEF = {
  peel:    { span: 0.004, glsl: 'shipNoise(P * 420.0) * 0.00005' },
  weave:   { span: 0.003, glsl: 'sin(p.x * 2094.0) * sin(p.y * 2094.0) * 0.00022' },
  leather: { span: 0.008, glsl: '(shipNoise(P * 240.0) + 0.5 * shipNoise(P * 610.0)) * 0.00045' },
  brushed: { span: 0.004, glsl: 'shipNoise(vec3(p.x * 30.0, p.y * 620.0, 1.7)) * 0.00010' },
  ribs:    { span: 0.012, glsl: '(0.5 + 0.5 * sin(p.x * 523.6)) * 0.0007' },
  studs:   { span: 0.05, glsl: 'shipStuds(p)' },
  quilt:   { span: 0.26, glsl: 'shipQuilt(p)' },
};
const DEFAULT_FINISH = { tint: 0.1, rough: 0.1, grime: 0.1, noise: 0.08 };

/* display intensities: the file's values are tuned as Cycles light sources */
const EMISSIVE = {
  lampWarm: 2.4, lampCool: 2.3, lampAmber: 2.6, lampCyan: 1.5, lampStrip: 2.2,
  lampWhite: 4.0, lampRed: 5.0, lampGreen: 5.0, strobe: 0.05,
  btnGreen: 1.8, btnAmber: 1.8, btnWhite: 1.8, engineCore: 3.2, screen: 1.0,
};

/* Sky / ground light shared by every ship surface.  The game's planet-scale
   lights cannot reach the underside of a parked hull, and deep space has no
   fill at all; this is the hemisphere the hull actually sits in — sky above,
   ground bounce or planetshine below — set once per frame by Ship. */
export const shipAmbient = {
  uShipHemiUp: { value: new THREE.Vector3(0, 1, 0) },
  uShipHemiSky: { value: new THREE.Color(0.02, 0.025, 0.035) },
  uShipHemiGround: { value: new THREE.Color(0.01, 0.01, 0.012) },
};

const NOISE = /* glsl */ `
float shipHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float shipNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(shipHash(i), shipHash(i + vec3(1, 0, 0)), f.x),
                 mix(shipHash(i + vec3(0, 1, 0)), shipHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(shipHash(i + vec3(0, 0, 1)), shipHash(i + vec3(1, 0, 1)), f.x),
                 mix(shipHash(i + vec3(0, 1, 1)), shipHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;

const glsl = (value) => Number(value).toFixed(4);

const RELIEF_LIB = /* glsl */ `
float shipStuds(vec2 p) {
  vec2 q = p / 0.05;
  q.x += step(1.0, mod(q.y, 2.0)) * 0.5;
  vec2 g = fract(q) - 0.5;
  float d = abs(g.x) * 1.1 + abs(g.y) * 2.4;
  return (1.0 - smoothstep(0.28, 0.42, d)) * 0.0011;
}
float shipQuilt(vec2 p) {
  vec2 g = fract(p / 0.26) - 0.5;
  float pillow = (1.0 - 4.0 * g.x * g.x) * (1.0 - 4.0 * g.y * g.y);
  float stitch = smoothstep(0.0, 0.03, 0.5 - max(abs(g.x), abs(g.y)));
  return pillow * 0.0026 * stitch - (1.0 - stitch) * 0.0007;
}
/* bump from a height field, by screen-space derivatives (no tangents needed) */
vec3 shipBump(vec3 pos, vec3 n, float h) {
  vec3 sx = dFdx(pos), sy = dFdy(pos);
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1);
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * n - grad);
}
`;

function install(material, spec, name) {
  const tile = spec.tile ? 2 / spec.tile : 0;   // uv is metres / 2
  const relief = RELIEF[spec.relief];
  const wear = spec.wear || 0;
  const bare = spec.bare || [0.4, 0.4, 0.42];
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shipAmbient);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aPaint;
varying vec3 vShipPaint;
varying vec3 vShipPos;
varying vec3 vShipNrm;
varying float vShipWear;
varying vec2 vShipUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  vShipPaint = aPaint.rgb;
  vShipWear = aPaint.a;
  vShipNrm = normal;
  vShipPos = position;
  vShipUv = uv;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vShipPaint;
varying vec3 vShipPos;
varying vec3 vShipNrm;
varying float vShipWear;
varying vec2 vShipUv;
uniform vec3 uShipHemiUp;
uniform vec3 uShipHemiSky;
uniform vec3 uShipHemiGround;
float shipBreakup;
float shipChip;
float shipFootprint;
${NOISE}
${RELIEF_LIB}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    float tint = vShipPaint.r, groove = vShipPaint.g;
    /* detail fades out as it drops below a pixel, or it turns to sparkle */
    float footprint = length(fwidth(vShipPos));
    shipFootprint = footprint;
    float fineFade = 1.0 - smoothstep(0.012, 0.045, footprint);
    float broad = shipNoise(vShipPos * 1.7);
    float fine = mix(0.5, shipNoise(vShipPos * 31.0), fineFade);
    /* streaks run along the hull's length: grime is dragged aft by airflow
       and down by condensation, never across */
    float streak = mix(0.5, shipNoise(vec3(vShipPos.x * 7.0, vShipPos.y * 7.0, vShipPos.z * 0.55)),
      1.0 - smoothstep(0.05, 0.16, footprint));
    shipBreakup = broad * 0.6 + fine * 0.4;
    vec3 c = diffuseColor.rgb;
    c *= 1.0 + (tint - 0.5) * ${glsl(spec.tint)};
    c *= 1.0 - ${glsl(spec.grime)} * (0.55 * smoothstep(0.52, 0.95, streak) + 0.30 * (1.0 - broad));
    ${tile ? `{
      vec2 cell = vShipUv * ${glsl(tile)};
      vec2 g = fract(cell);
      float edge = min(min(g.x, 1.0 - g.x), min(g.y, 1.0 - g.y));
      float tileFade = 1.0 - smoothstep(0.03, 0.10, footprint);
      float seam = mix(1.0, smoothstep(0.0, 0.035, edge), tileFade);
      float tone = mix(0.5, shipHash(vec3(floor(cell), 3.0)), tileFade);
      c *= mix(0.45, 1.0, seam) * (0.78 + 0.44 * tone);
      shipBreakup = mix(shipBreakup, tone, 0.6);
    }` : ''}
    /* chipped paint: proud edges first, broken up so it never reads as an outline */
    shipChip = ${glsl(wear)} * smoothstep(0.22, 0.50, vShipWear
      * (0.50 + 0.95 * mix(0.5, shipNoise(vShipPos * 85.0), fineFade) + 0.45 * broad));
    c = mix(c, vec3(${bare.map(glsl).join(', ')}), shipChip);
    c *= 1.0 - groove * 0.82;
    /* baked contact occlusion (paint B): wing roots, nacelle joints, gear bays */
    c *= 1.0 - vShipPaint.b * 0.5;
    diffuseColor.rgb = c;
  }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = clamp(roughnessFactor + (vShipPaint.r - 0.5) * ${glsl(spec.rough)}
    + (shipBreakup - 0.5) * ${glsl(spec.noise * 2)} + vShipPaint.g * 0.3, 0.045, 1.0);
  roughnessFactor = mix(roughnessFactor, 0.36, shipChip * ${glsl(spec.bareMetal || 0)});`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
  metalnessFactor = mix(metalnessFactor, 1.0, shipChip * ${glsl(spec.bareMetal || 0)});`)
      .replace('#include <normal_fragment_maps>', relief ? `#include <normal_fragment_maps>
  {
    vec3 an = abs(vShipNrm);
    vec2 p = an.x > an.y && an.x > an.z ? vShipPos.zy : (an.y > an.z ? vShipPos.xz : vShipPos.xy);
    vec3 P = vShipPos;
    float reliefFade = 1.0 - smoothstep(${glsl(relief.span * 0.22)}, ${glsl(relief.span * 0.6)}, shipFootprint);
    if (reliefFade > 0.0) normal = shipBump(-vViewPosition, normal, (${relief.glsl}) * reliefFade);
  }` : '#include <normal_fragment_maps>')
      .replace('#include <lights_fragment_end>', spec.interior ? '#include <lights_fragment_end>' : `#include <lights_fragment_end>
  {
    vec3 hemiUp = normalize((viewMatrix * vec4(uShipHemiUp, 0.0)).xyz);
    float hemi = dot(normal, hemiUp) * 0.5 + 0.5;
    vec3 hemiIrradiance = mix(uShipHemiGround, uShipHemiSky, hemi) * (1.0 - vShipPaint.g * 0.7)
      * (1.0 - vShipPaint.b * 0.75);
    reflectedLight.indirectDiffuse += hemiIrradiance * BRDF_Lambert(material.diffuseColor);
    /* metals have no diffuse term: give them the same hemisphere as a broad sheen */
    reflectedLight.indirectSpecular += hemiIrradiance * material.specularColor * 0.22;
  }`);
  };
  material.customProgramCacheKey = () => `halcyon-surface-7|${name}|${JSON.stringify(spec)}`;
  /* three's Material.clone() does not carry onBeforeCompile, and the ship's
     radiance zones clone every interior material — keep the finish on the copy */
  const baseClone = Object.getPrototypeOf(material).clone;
  material.clone = function cloneSurface() {
    const copy = baseClone.call(this);
    /* the only clones are the cabin and flight-deck zones, and a sealed
       cabin has no sky: its light is the baked irradiance instead */
    install(copy, { ...spec, interior: true }, name);
    return copy;
  };
  return material;
}

/**
 * Turn the file's carrier materials into game surfaces, one per name.
 * @returns {(source: THREE.Material) => THREE.Material}
 */
export function createSurfaceLibrary() {
  const byName = new Map();
  const resolve = (source) => {
    const name = source.name;
    if (byName.has(name)) return byName.get(name);
    let material;
    if (name in EMISSIVE) {
      material = new THREE.MeshStandardMaterial({
        name, color: 0x050505, emissive: source.emissive.clone(),
        emissiveIntensity: EMISSIVE[name], metalness: 0, roughness: 0.6,
      });
    } else {
      const spec = FINISH[name] || DEFAULT_FINISH;
      /* gloss paint is a clear lacquer over pigment: the coat is what gives
         a white hull a hard star highlight instead of a chalky one */
      material = spec.coat
        ? new THREE.MeshPhysicalMaterial({ clearcoat: spec.coat, clearcoatRoughness: 0.2 })
        : new THREE.MeshStandardMaterial();
      material.name = name;
      material.color.copy(source.color);
      material.roughness = source.roughness;
      material.metalness = source.metalness;
      material.side = spec.side ?? THREE.FrontSide;
      material.envMapIntensity = 1.0;
      if (spec.offset) {
        material.polygonOffset = true;
        material.polygonOffsetFactor = -2;
        material.polygonOffsetUnits = -2;
      }
      install(material, spec, name);
    }
    byName.set(name, material);
    return material;
  };
  resolve.materials = byName;
  return resolve;
}
