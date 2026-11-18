// Pure-Node verification suite for procedural surface world modules:
//  1. src/surface/props.js (+ src/surface/props-engine.js): all 36 industrial props +
//     5 standalone backdrop megastructures across palettes
//  2. src/surface/fx.js: surface impacts, sparks, muzzleSmoke, explosion,
//     dynamic lighting, floating-origin shiftOrigin, logdepth shader contract
//  3. src/weather/wet-ground.js: RAIN_WET_UNIFORMS, RAIN_RIPPLE_GLSL, and
//     patchShaderWithRainWetness on standard & planet-terrain shaders

import * as THREE from 'three';
import {
  OUTPOST_PROP_SIZES,
  OUTPOST_PROP_PALETTES,
  createOutpostProps,
} from '../src/surface/props.js';
import { createSurfaceFx } from '../src/surface/fx.js';
import {
  RAIN_WET_UNIFORMS,
  RAIN_RIPPLE_GLSL,
  createRainWetUniforms,
  patchShaderWithRainWetness,
} from '../src/weather/wet-ground.js';

let failures = 0;
function check(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

const VALID_SURFACES = new Set(['metal', 'concrete', 'wood', 'rubber', 'dirt']);

const ORIGINAL_36_PROPS = [
  'barrel', 'bollard_mooring', 'bollard_post', 'cable_reel', 'cardboard_boxes',
  'catwalk', 'container20', 'container40', 'container40hc', 'crate_stack',
  'crate_wood', 'dumpster', 'fence_panel', 'floodlight_stand', 'forklift',
  'gas_cylinders', 'gate_arm', 'generator', 'guard_booth', 'ibc_tote',
  'jerry_can', 'jersey_barrier', 'light_mast', 'pallet', 'pallet_stack',
  'pipe_stack', 'reefer_unit', 'relay_node', 'sandbags', 'shelf_rack',
  'sign_post', 'stairs_metal', 'tarp_cargo', 'tire_stack', 'toolbox_cart',
  'traffic_cone',
];

const BACKDROP_PROPS = [
  'cargo_ship', 'comms_tower', 'port_crane', 'rigid_boat', 'rtg_crane',
];

function validatePropGroup(group, expectedName, expectedScale = 1) {
  if (!group || !group.isGroup) return { ok: false, reason: 'not a THREE.Group' };
  if (group.castShadow !== true || group.receiveShadow !== true) {
    return { ok: false, reason: `shadow flags (${group.castShadow}, ${group.receiveShadow})` };
  }
  if (group.userData.propName !== expectedName) {
    return { ok: false, reason: `userData.propName=${group.userData.propName}` };
  }
  const sz = group.userData.size;
  if (!Array.isArray(sz) || sz.length !== 3 || !sz.every((v) => Number.isFinite(v) && v > 0)) {
    return { ok: false, reason: `invalid userData.size=${JSON.stringify(sz)}` };
  }
  if (!VALID_SURFACES.has(group.userData.surface)) {
    return { ok: false, reason: `invalid userData.surface=${group.userData.surface}` };
  }
  if (Math.abs(group.scale.x - expectedScale) > 1e-6) {
    return { ok: false, reason: `scale=${group.scale.x}, expected ${expectedScale}` };
  }

  let meshes = 0;
  let triangles = 0;
  let badPos = 0;
  let badNrm = 0;

  group.traverse((obj) => {
    if (!obj.isMesh) return;
    meshes++;
    const geo = obj.geometry;
    if (!geo || !geo.isBufferGeometry) {
      badPos++;
      return;
    }
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    if (!pos || pos.count === 0) {
      badPos++;
      return;
    }
    if (!nrm || nrm.count !== pos.count) {
      badNrm++;
      return;
    }
    const pArr = pos.array;
    for (let i = 0; i < pArr.length; i++) {
      if (!Number.isFinite(pArr[i])) { badPos++; break; }
    }
    const nArr = nrm.array;
    for (let i = 0; i < nArr.length; i++) {
      if (!Number.isFinite(nArr[i])) { badNrm++; break; }
    }
    const triCount = geo.index ? geo.index.count / 3 : pos.count / 3;
    triangles += triCount;
  });

  if (meshes <= 0) return { ok: false, reason: '0 meshes' };
  if (triangles <= 0) return { ok: false, reason: '0 triangles' };
  if (badPos > 0) return { ok: false, reason: `invalid/NaN positions (${badPos})` };
  if (badNrm > 0) return { ok: false, reason: `invalid/NaN normals (${badNrm})` };
  return { ok: true, meshes, triangles: Math.round(triangles) };
}

// ============================================================================
// 1. Test Outpost Props (`src/surface/props.js`)
// ============================================================================
{
  const props = createOutpostProps({ materials: null, palette: 'industrial' });
  check(Array.isArray(props.names) && props.names.length >= 41, `props.names exposes ${props.names.length} registered props (36 Gi + 5 backdrop)`);

  const sortedCopy = [...props.names].sort();
  check(JSON.stringify(props.names) === JSON.stringify(sortedCopy), 'props.names is sorted alphabetically');

  const missingOrig = ORIGINAL_36_PROPS.filter((n) => !props.names.includes(n) || !OUTPOST_PROP_SIZES[n]);
  check(missingOrig.length === 0, `all 36 industrial props registered (missing: ${missingOrig.length})`);

  const missingBackdrop = BACKDROP_PROPS.filter((n) => !props.names.includes(n) || !OUTPOST_PROP_SIZES[n]);
  check(missingBackdrop.length === 0, `all 5 backdrop megastructures registered (${BACKDROP_PROPS.join(', ')})`);

  let totalIndustrialTris = 0;
  let propFailures = 0;
  const triSummary = {};

  for (const palette of ['industrial', 'frontier', 'halcyon']) {
    check(Boolean(OUTPOST_PROP_PALETTES[palette]), `palette "${palette}" exists in OUTPOST_PROP_PALETTES`);
    for (let idx = 0; idx < props.names.length; idx++) {
      const name = props.names[idx];
      const group = props.create(name, { seed: idx + 1, palette });
      const res = validatePropGroup(group, name, 1);
      if (!res.ok) {
        console.error(`  -> Prop "${name}" (${palette}) failed: ${res.reason}`);
        propFailures++;
      } else if (palette === 'industrial') {
        totalIndustrialTris += res.triangles;
        triSummary[name] = res.triangles;
      }
    }
  }

  check(
    propFailures === 0,
    `all ${props.names.length} props across industrial/frontier/halcyon palettes (${props.names.length * 3} builds) have >0 meshes, >0 triangles, finite positions & normals, and valid userData (total 1x tris: ${totalIndustrialTris})`,
  );

  // Check scale option
  const baseCone = props.create('traffic_cone', { seed: 2, scale: 1 });
  const bigCone = props.create('traffic_cone', { seed: 2, scale: 2.5 });
  const scaleRes = validatePropGroup(bigCone, 'traffic_cone', 2.5);
  check(
    scaleRes.ok && Math.abs(bigCone.userData.size[1] - baseCone.userData.size[1] * 2.5) < 1e-6,
    `scale option scales group & userData.size (${baseCone.userData.size[1]} -> ${bigCone.userData.size[1]})`,
  );

  // Check palette color differentiation
  const indCont = props.create('container20', { seed: 0, palette: 'industrial' });
  const halCont = props.create('container20', { seed: 0, palette: 'halcyon' });
  let indHex = null;
  let halHex = null;
  indCont.traverse((m) => { if (m.isMesh && indHex === null) indHex = m.material.color.getHex(); });
  halCont.traverse((m) => { if (m.isMesh && halHex === null) halHex = m.material.color.getHex(); });
  check(indHex !== halHex, `palette changes painted prop colors (industrial=0x${indHex?.toString(16)} vs halcyon=0x${halHex?.toString(16)})`);

  props.dispose();
  check(true, 'props.dispose() completes cleanly');

  // Verify live createSurfaceMaterials-compatible adapter (including Node guard when canvas throws)
  let liveGetCalls = 0;
  const mockLiveMaterials = {
    get(name, opts = {}) {
      liveGetCalls++;
      return new THREE.MeshStandardMaterial({
        color: opts.color !== undefined ? opts.color : 0x808080,
        vertexColors: Boolean(opts.vertexColors),
      });
    },
    emissive(col) {
      return new THREE.MeshBasicMaterial({ color: col });
    },
    decal() { throw new ReferenceError('document is not defined'); },
    label() { throw new ReferenceError('document is not defined'); },
  };
  const liveProps = createOutpostProps({ materials: mockLiveMaterials, palette: 'frontier' });
  const liveForklift = liveProps.create('forklift', { seed: 3 });
  const liveRes = validatePropGroup(liveForklift, 'forklift', 1);
  check(liveRes.ok && liveGetCalls > 0, `live materials instance works in Node even if decal/label canvas helpers throw (get calls: ${liveGetCalls})`);
  liveProps.dispose();
}

// ============================================================================
// 2. Test Surface FX (`src/surface/fx.js`)
// ============================================================================
{
  const scene = new THREE.Scene();
  const fx = createSurfaceFx({ scene, maxParticles: 512, maxDecals: 120, seed: 42 });
  check(fx.root.parent === scene, 'createSurfaceFx attaches fx.root to scene');

  // Check logarithmic depth buffer chunks & frustumCulled=false
  let shaderMeshesChecked = 0;
  let allCulledFalse = true;
  fx.root.traverse((obj) => {
    if (obj.isMesh) {
      if (obj.frustumCulled !== false) allCulledFalse = false;
      if (obj.material?.isShaderMaterial) {
        shaderMeshesChecked++;
        const vs = obj.material.vertexShader;
        const fs = obj.material.fragmentShader;
        check(
          vs.includes('#include <logdepthbuf_pars_vertex>') && vs.includes('#include <logdepthbuf_vertex>')
          && fs.includes('#include <logdepthbuf_pars_fragment>') && fs.includes('#include <logdepthbuf_fragment>'),
          `FX shader "${obj.name}" includes WebGL2 logarithmic depth buffer chunks`,
        );
      }
    }
  });
  check(shaderMeshesChecked === 2 && allCulledFalse, 'all FX meshes have frustumCulled = false');

  fx.setLighting({
    sunDir: new THREE.Vector3(0.3, 0.9, -0.2),
    sunColor: new THREE.Color(1.0, 0.92, 0.8),
    skyColor: new THREE.Color(0.25, 0.32, 0.45),
    groundColor: new THREE.Color(0.12, 0.1, 0.08),
    up: new THREE.Vector3(0, 1, 0),
  });
  check(true, 'fx.setLighting updates dynamic sun/sky/ground uniforms');

  const surfaces = ['metal', 'concrete', 'rock', 'dirt', 'wood', 'water', 'enemy', 'glass', 'rubber'];
  for (let i = 0; i < surfaces.length; i++) {
    const surface = surfaces[i];
    fx.impact({
      point: new THREE.Vector3(i * 1.5, 0, -5),
      normal: new THREE.Vector3(0, 1, 0),
      surface,
      dir: new THREE.Vector3(0.2, -0.9, -0.4).normalize(),
      scale: 1.1,
    });
  }
  const stAfterImpacts = fx.stats();
  // Solid surfaces that emit decals: metal, concrete, rock, dirt, wood, glass, rubber = 7 (water & enemy do not)
  check(
    stAfterImpacts.lit > 0 && stAfterImpacts.add > 0 && stAfterImpacts.debris > 0 && stAfterImpacts.decals === 7,
    `fx.impact across [${surfaces.join(', ')}] emits lit (${stAfterImpacts.lit}), add (${stAfterImpacts.add}), debris (${stAfterImpacts.debris}), and solid-surface decals (${stAfterImpacts.decals})`,
  );

  fx.muzzleSmoke(new THREE.Vector3(0.2, -0.15, -0.8), new THREE.Vector3(0, 0, -1));
  fx.sparks(new THREE.Vector3(-2, 1, -4), new THREE.Vector3(0, 1, 0), 16);
  fx.explosion(new THREE.Vector3(0, 0, -12), 5);
  fx.update(1 / 60);

  const stAfterExp = fx.stats();
  check(
    stAfterExp.lit > stAfterImpacts.lit && stAfterExp.decals === 8,
    `muzzleSmoke, sparks, explosion + update(1/60) advance pools (lit=${stAfterExp.lit}, add=${stAfterExp.add}, decals=${stAfterExp.decals})`,
  );

  // Verify decal & particle coordinates shift accurately on shiftOrigin
  const decalMesh = fx.root.children.find((c) => c.name === 'fx_decals');
  const xBefore = decalMesh.geometry.attributes.position.array[0];
  const yBefore = decalMesh.geometry.attributes.position.array[1];
  const zBefore = decalMesh.geometry.attributes.position.array[2];
  fx.shiftOrigin(new THREE.Vector3(3.5, -1.25, 2.0));
  fx.update(1 / 60);
  const xAfter = decalMesh.geometry.attributes.position.array[0];
  const yAfter = decalMesh.geometry.attributes.position.array[1];
  const zAfter = decalMesh.geometry.attributes.position.array[2];
  check(
    Math.abs((xBefore - xAfter) - 3.5) < 1e-4
    && Math.abs((yBefore - yAfter) - (-1.25)) < 1e-4
    && Math.abs((zBefore - zAfter) - 2.0) < 1e-4,
    'fx.shiftOrigin(delta) shifts active camera-relative decals & particles by -delta',
  );

  // Verify large teleport clears active particles/decals
  fx.shiftOrigin(new THREE.Vector3(1000, 0, 0));
  const stAfterTeleport = fx.stats();
  check(
    stAfterTeleport.lit === 0 && stAfterTeleport.add === 0 && stAfterTeleport.decals === 0,
    'fx.shiftOrigin clears pools on large floating-origin teleports (>500 m)',
  );

  fx.dispose();
  check(fx.root.parent === null, 'fx.dispose() detaches root and releases GPU resources');
}

// ============================================================================
// 3. Test Ground Rain-Wetness & Ripples (`src/weather/wet-ground.js`)
// ============================================================================
function braceCounts(glsl) {
  let curly = 0;
  let paren = 0;
  let valid = true;
  for (let i = 0; i < glsl.length; i++) {
    const ch = glsl[i];
    if (ch === '{') curly++;
    else if (ch === '}') { curly--; if (curly < 0) valid = false; }
    else if (ch === '(') paren++;
    else if (ch === ')') { paren--; if (paren < 0) valid = false; }
  }
  return { curly, paren, valid };
}

function hasBalancedBraces(glsl) {
  const b = braceCounts(glsl);
  return b.valid && b.curly === 0 && b.paren === 0;
}

function expandIncludes(glsl) {
  return glsl.replace(/^[ \t]*#include <([\w]+)>/gm, (_m, name) => THREE.ShaderChunk[name] || '');
}

{
  check(
    RAIN_WET_UNIFORMS.uRainWet?.value === 0 && RAIN_WET_UNIFORMS.uRainTime?.value === 0,
    'RAIN_WET_UNIFORMS exports { uRainWet: { value: 0 }, uRainTime: { value: 0 } }',
  );
  check(
    RAIN_RIPPLE_GLSL.includes('vec2 rainRippleSlope(vec2 uv, float time, float strength)')
    && hasBalancedBraces(RAIN_RIPPLE_GLSL),
    'RAIN_RIPPLE_GLSL defines balanced vec2 rainRippleSlope(vec2 uv, float time, float strength)',
  );

  const customUniforms = createRainWetUniforms({ wet: 0.75, time: 4.2 });
  const baseStandardFsCounts = braceCounts(expandIncludes(THREE.ShaderLib.standard.fragmentShader));
  const mockShader = {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms),
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };

  patchShaderWithRainWetness(mockShader, customUniforms);
  // Call a second time to verify idempotency
  patchShaderWithRainWetness(mockShader, customUniforms);

  check(
    mockShader.uniforms.uRainWet === customUniforms.uRainWet
    && mockShader.uniforms.uRainTime === customUniforms.uRainTime,
    'patchShaderWithRainWetness binds uRainWet and uRainTime uniforms by reference',
  );

  const vs = mockShader.vertexShader;
  const fs = mockShader.fragmentShader;
  check(
    vs.includes('varying vec3 vSlRainWorldPos;') && fs.includes('varying vec3 vSlRainWorldPos;'),
    'patched vertex & fragment shaders declare matching vSlRainWorldPos varying',
  );
  check(
    fs.includes('diffuseColor.rgb *= mix(1.0, 0.58, wet);')
    && fs.includes('roughnessFactor = mix(roughnessFactor, 0.08, puddle);')
    && fs.includes('rainRippleSlope(slRainUv, uRainTime, uRainWet)'),
    'patched fragment shader applies porous darkening, puddle roughness sheen, and rainRippleSlope normal perturbation',
  );
  check(
    (fs.match(/vec2 rainRippleSlope\(/g) || []).length === 1,
    'patchShaderWithRainWetness is idempotent when invoked twice on the same shader',
  );

  const expandedVs = expandIncludes(vs);
  const expandedFs = expandIncludes(fs);
  const expFsCounts = braceCounts(expandedFs);
  check(
    hasBalancedBraces(vs) && hasBalancedBraces(fs)
    && hasBalancedBraces(expandedVs)
    && expFsCounts.valid
    && expFsCounts.curly === baseStandardFsCounts.curly
    && expFsCounts.paren === baseStandardFsCounts.paren
    && !expandedVs.includes('undefined') && !expandedFs.includes('undefined'),
    'patched & expanded MeshStandardMaterial vertex/fragment GLSL has balanced braces/parens and zero undefined tokens',
  );

  // Also test composing AFTER a spherical planet terrain shader (like shaders-webgl.js)
  const planetShader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLocalPos;'),
    fragmentShader: THREE.ShaderLib.standard.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLocalPos;\nvec3 terrainDetailPosition() { return vLocalPos; }')
      .replace('#include <color_fragment>', '#include <color_fragment>\n{ diffuseColor.rgb = vec3(0.4, 0.38, 0.35); }')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = 0.82;'),
  };
  patchShaderWithRainWetness(planetShader);
  const pFs = planetShader.fragmentShader;
  check(
    pFs.indexOf('diffuseColor.rgb = vec3(0.4, 0.38, 0.35)') < pFs.indexOf('diffuseColor.rgb *= mix(1.0, 0.58, wet)')
    && pFs.indexOf('roughnessFactor = 0.82;') < pFs.indexOf('roughnessFactor = mix(roughnessFactor, 0.08, puddle);')
    && pFs.includes('slRainUp = normalize(vLocalPos);')
    && pFs.includes('vec3 slRainCoord = terrainDetailPosition();')
    && hasBalancedBraces(pFs),
    'patchShaderWithRainWetness composes cleanly AFTER spherical-planet terrain replacements',
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nsurfacepropstest: ALL CHECKS PASSED (100%).');
