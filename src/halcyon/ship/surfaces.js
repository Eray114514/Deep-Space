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
   tile: thermal-tile grid pitch in metres (0 = none). */
const FINISH = {
  hull:        { tint: 0.14, rough: 0.16, grime: 0.22, noise: 0.10, coat: 0.55 },
  hullGrey:    { tint: 0.14, rough: 0.14, grime: 0.20, noise: 0.10, coat: 0.45 },
  hullDark:    { tint: 0.30, rough: 0.16, grime: 0.14, noise: 0.08, tile: 0.16 },
  accent:      { tint: 0.10, rough: 0.12, grime: 0.26, noise: 0.10, coat: 0.55 },
  trim:        { tint: 0.10, rough: 0.10, grime: 0.10, noise: 0.08 },
  trimTwoSided: { tint: 0.0, rough: 0.0, grime: 0.0, noise: 0.06, side: THREE.DoubleSide },
  decal:       { tint: 0.0, rough: 0.0, grime: 0.20, noise: 0.08, offset: true, side: THREE.DoubleSide },
  cap:         { tint: 0.0, rough: 0.0, grime: 0.15, noise: 0.10 },
  metal:       { tint: 0.10, rough: 0.14, grime: 0.14, noise: 0.14 },
  metalDark:   { tint: 0.14, rough: 0.14, grime: 0.16, noise: 0.14 },
  heat:        { tint: 0.30, rough: 0.16, grime: 0.24, noise: 0.16 },
  chrome:      { tint: 0.0, rough: 0.0, grime: 0.04, noise: 0.04 },
  rubber:      { tint: 0.0, rough: 0.0, grime: 0.08, noise: 0.06 },
  // interior
  panelWhite:  { tint: 0.10, rough: 0.10, grime: 0.10, noise: 0.08 },
  panelGrey:   { tint: 0.12, rough: 0.10, grime: 0.10, noise: 0.08 },
  panelDark:   { tint: 0.14, rough: 0.10, grime: 0.06, noise: 0.08 },
  deck:        { tint: 0.14, rough: 0.16, grime: 0.26, noise: 0.18 },
  deckMat:     { tint: 0.06, rough: 0.04, grime: 0.14, noise: 0.08 },
  fabric:      { tint: 0.0, rough: 0.0, grime: 0.0, noise: 0.05 },
  fabricOrange: { tint: 0.0, rough: 0.0, grime: 0.08, noise: 0.06 },
  cushion:     { tint: 0.0, rough: 0.0, grime: 0.06, noise: 0.08 },
  paintYellow: { tint: 0.0, rough: 0.0, grime: 0.28, noise: 0.10 },
  crateGrey:   { tint: 0.30, rough: 0.14, grime: 0.24, noise: 0.14 },
  crateOrange: { tint: 0.24, rough: 0.14, grime: 0.24, noise: 0.14 },
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

function install(material, spec, name) {
  const tile = spec.tile ? 2 / spec.tile : 0;   // uv is metres / 2
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shipAmbient);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aPaint;
varying vec3 vShipPaint;
varying vec3 vShipPos;
varying vec2 vShipUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  vShipPaint = aPaint.rgb;
  vShipPos = position;
  vShipUv = uv;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vShipPaint;
varying vec3 vShipPos;
varying vec2 vShipUv;
uniform vec3 uShipHemiUp;
uniform vec3 uShipHemiSky;
uniform vec3 uShipHemiGround;
float shipBreakup;
${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    float tint = vShipPaint.r, groove = vShipPaint.g;
    /* detail fades out as it drops below a pixel, or it turns to sparkle */
    float footprint = length(fwidth(vShipPos));
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
    c *= 1.0 - groove * 0.82;
    /* baked contact occlusion (paint B): wing roots, nacelle joints, gear bays */
    c *= 1.0 - vShipPaint.b * 0.5;
    diffuseColor.rgb = c;
  }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = clamp(roughnessFactor + (vShipPaint.r - 0.5) * ${glsl(spec.rough)}
    + (shipBreakup - 0.5) * ${glsl(spec.noise * 2)} + vShipPaint.g * 0.3, 0.045, 1.0);`)
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
  material.customProgramCacheKey = () => `halcyon-surface-4|${name}|${JSON.stringify(spec)}`;
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
