// Volumetric cloud raymarch (TSL / WebGPU). PHASE 3-4 — SKELETON.
//
// This module owns the view-ray march, the light march and the composite. It
// does NOT own the density definition (`cloud-density.js`), the weather
// (`weather-system.js`), the empty-space structure (`cloud-occupancy.js`) or
// the accumulation (`temporal-resolve.js`).
//
// THE FAILURE THIS MODULE EXISTS TO FIX
// -------------------------------------
// The previous implementation allocated its step budget as a fraction of the
// RENDER SHELL THICKNESS (`stride * (rOut - rIn)`), not as a fraction of the
// object being resolved. Measured at 147 km altitude, R=6000 km, 48-step cap:
//
//   view angle | ray span | steps    | step length | samples in a 1500 m deck
//   0  (nadir) |  13.6 km | 31       |    435 m    | 3.4
//   60         |  27.2 km | 48 (cap) |    567 m    | 2.6
//   70         |  39.8 km | 48 (cap) |    828 m    | 1.8
//   80         |  78.3 km | 48 (cap) |   1632 m    | 0.9
//   88         | 389.7 km | 48 (cap) |   8119 m    | 0.2
//
// From orbit, everything except the small patch directly under the camera sits
// in the 60-88 degree range. So across most of the visible disc each cloud
// received under one sample, which is precisely:
//   - "a bunch of white blocks" — one sample is a flat constant colour, with
//     no internal structure and no size variation, and
//   - "clouds blink in and out" — below one sample per deck, whether a cloud
//     is hit at all depends on the jitter phase, which shifts as the camera
//     moves.
// Raising the cap does not fix it: 64 steps still gives 1.2 km/step at 80.
//
// REQUIRED STRUCTURE (this is the fix, not a tuning pass)
// ------------------------------------------------------
// 1. PER-RAY ALTITUDE-BAND CLIPPING. Do not march the full 400-14000 m shell.
//    Ask `cloud-occupancy.js` for the altitude interval this ray actually
//    passes through that contains cloud, and march only that. A ray crossing
//    a region whose only cloud is marine stratus marches ~600 m of shell, not
//    13.6 km of mostly-empty envelope.
//
// 2. EMPTY-SPACE SKIPPING. Coarse march against the occupancy volume; on a
//    non-empty voxel, refine. This is what pays for (3).
//
// 3. STEP LENGTH FROM THE FEATURE SCALE, NOT THE SHELL. Step length must come
//    from `minVerticalFeatureMeters` of the species present in the current
//    segment (see `cloud-species.js` and `minVerticalFeature()`), divided by
//    the sampling requirement. The hard gate, from doc §4 phase 3, is:
//
//        >= 4 samples through the thinnest present species,
//        at EVERY view angle in {0, 45, 60, 70, 80, 88} degrees.
//
//    `tools/cloud-sampling-test.js` asserts this row by row. It is the
//    repaired version of the table above and is the primary acceptance gate
//    for the whole rewrite. Total step count is allowed to rise; occupied-band
//    clipping and empty-space skipping are the primary affordability mechanisms.
//    Do NOT satisfy the gate by thickening thin species. Occupancy skipping pays
//    for the single-frame quality floor; temporal amortisation is optional
//    phase-7 work, not a prerequisite or an excuse to undersample the current
//    frame.
//
// 4. HORIZONTAL SCALE MATTERS TOO. `horizontalCellMeters` sets the lateral
//    detail frequency. Cirrocumulus cells are ~300 m across; a march that
//    resolves them vertically but samples noise at kilometre frequency will
//    still read as blocks.
//
// LIGHTING (phase 4, must be physical rather than additive fudge)
//   - Cone-shaped light march with geometrically growing segments.
//   - Energy-conserving multiple-scattering approximation. Not a hand-added
//     term: the previous implementation reconstructed "multiple scatter" as
//     `coverage*0.54 + highMask*0.22 + humidity*0.16 + convective*0.2`, which
//     is a weighted guess with no conservation property.
//   - Dual-lobe Henyey-Greenstein phase (forward g~0.7, back g~-0.2) plus a
//     Beer-powder term for the dark-edge effect.
//   - Per-species optical density from `extinctionPerKm`. Stratus and cirrus
//     must stay translucent; cumulonimbus must be opaque. One shared
//     extinction constant is what made every genus render as the same beige
//     film.
//   - Eclipse / planetary-shadow visibility.
//   - Real deep shadow is allowed. `cloudvisualdiag` must reject non-finite
//     radiance, sampling holes and large zero-radiance blocks caused by math or
//     composition errors; it must not reject physically valid dark cloud cores.
//
// COMPOSITE
//   - Accumulate premultiplied, and let the material perform premultiplication
//     exactly once. The previous code multiplied twice on the WebGPU path only.
//   - When un-premultiplying for a straight-alpha output, the reciprocal floor
//     must stay well above zero. At 1e-4, a near-transparent limb pixel scales
//     residual RGB by 1e4 and integration noise becomes visible speckle.
//
// HARD CONSTRAINT: TSL / NodeMaterial only. Never fall back to GLSL
// ShaderMaterial on the WebGPU path (AGENTS.md). WebGL is a separate,
// quality-compromised fallback.

import * as THREE from 'three/webgpu';
import {
  asin, atan, Break, cos, dot, exp, float, floor, Fn, If, Loop, mix,
  positionLocal, positionView, sin, sqrt, texture, texture3D, uniform,
  vec2, vec3, vec4,
} from 'three/tsl';
import { CLOUD_SHELL_SPECIES } from './cloud-species.js';
import { cloudDensityTSL } from './cloud-density.js';
import {
  GRAZING_COS_FLOOR, HORIZONTAL_DIVISOR, MAX_STEP_METERS,
  MIN_STEP_METERS, OCCUPANCY_EPSILON,
} from './cloud-occupancy.js';
import { sceneRayLimit } from '../volume-depth-node.js';

// The exact DDA keeps all acceptance fixtures below 128 planned samples
// (111 at the 88-degree CPU gate). 256 leaves >2x headroom for richer cells
// without allowing one horizon pixel to monopolise the GPU until Windows TDR.
const MAX_MARCH_ITERATIONS = 256;
let sharedTopology = null;

function configurePlaceholder(texture, format = THREE.RGBAFormat) {
  texture.format = format;
  texture.type = THREE.FloatType;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

function createTextureNodes() {
  const shape = configurePlaceholder(new THREE.Data3DTexture(
    new Float32Array([0, 0, 0.5, 0.5]), 1, 1, 1));
  const detail = configurePlaceholder(new THREE.Data3DTexture(
    new Float32Array([0]), 1, 1, 1), THREE.RedFormat);
  const jitter = configurePlaceholder(new THREE.DataTexture(
    new Float32Array([0.5, 0.5, 0, 0]), 1, 1));
  const bands = configurePlaceholder(new THREE.DataArrayTexture(
    new Float32Array(CLOUD_SHELL_SPECIES.length * 4),
    1, 1, CLOUD_SHELL_SPECIES.length));
  const occupancy = configurePlaceholder(new THREE.Data3DTexture(
    new Float32Array([0, 0, 0, 0]), 1, 1, 1));
  return {
    shapeTextureNode: texture3D(shape),
    detailTextureNode: texture3D(detail),
    jitterTextureNode: texture(jitter),
    bandsTextureNode: texture(bands),
    occupancyTextureNode: texture3D(occupancy),
  };
}

function createInstanceState(planet, band, profile = {}) {
  const textureNodes = createTextureNodes();
  const nodes = {
    uCameraLocal: uniform(new THREE.Vector3()),
    uGroundR: uniform(planet.R),
    uShellFloor: uniform(Math.max(0, band.rIn - planet.R)),
    uShellTop: uniform(Math.max(1, band.rOut - planet.R)),
    uMaxTerrainMeters: uniform(Math.max(1, planet.hAmp || 8000)),
    uCellAltitudeMeters: uniform(500),
    uOccupancyResolution: uniform(new THREE.Vector3(1, 1, 1)),
    uSamplesPerFeature: uniform(profile.samplesPerFeature || 8),
    uMaxSteps: uniform(MAX_MARCH_ITERATIONS),
    uEngage: uniform(0),
    uResourceReady: uniform(0),
    uFrame: uniform(0),
    uWeatherTime: uniform(0),
    uCamProx: uniform(0),
    uSpin: uniform(new THREE.Matrix3()),
    uAmbC: uniform(new THREE.Color(0.5, 0.56, 0.64)),
    uTint: uniform(new THREE.Color(band.tint || 0xffffff)),
    uLightSteps: uniform(0),
    uDebugShell: uniform(0),
    tSceneDepth: texture(new THREE.Texture()),
    uDepthReady: uniform(0),
    uDepthReversed: uniform(0),
    uCameraNear: uniform(0.1),
    uCameraFar: uniform(1e11),
    uVolumeSize: uniform(new THREE.Vector2(1, 1)),
  };
  const state = {
    rewrite: 'phase4-A',
    planet,
    band,
    nodes,
    textureNodes,
    resource: null,
    bindResource(resource) {
      if (!resource?.textures) return false;
      this.resource = resource;
      this.textureNodes.shapeTextureNode.value = resource.textures.shape;
      this.textureNodes.detailTextureNode.value = resource.textures.detail;
      this.textureNodes.jitterTextureNode.value = resource.textures.jitter;
      this.textureNodes.bandsTextureNode.value = resource.textures.bands;
      this.textureNodes.occupancyTextureNode.value = resource.textures.occupancy;
      this.nodes.uGroundR.value = resource.fields.groundR;
      this.nodes.uShellFloor.value = resource.occupancy.shellFloor;
      this.nodes.uShellTop.value = resource.occupancy.shellTop;
      this.nodes.uMaxTerrainMeters.value = resource.fields.maxTerrainMeters;
      this.nodes.uCellAltitudeMeters.value = resource.occupancy.cellAltitudeMeters;
      this.nodes.uOccupancyResolution.value.set(
        resource.occupancy.lonCount,
        resource.occupancy.latCount,
        resource.occupancy.altCount,
      );
      this.nodes.uResourceReady.value = 1;
      return true;
    },
  };
  return state;
}

function copyInstanceToTopology(state, topology) {
  if (state === topology.state) return;
  for (const [name, source] of Object.entries(state.nodes)) {
    if (topology.state.nodes[name] && source && 'value' in source) {
      topology.state.nodes[name].value = source.value;
    }
  }
  for (const [name, source] of Object.entries(state.textureNodes)) {
    topology.state.textureNodes[name].value = source.value;
  }
}

function buildMaterial(state) {
  const nodes = state.nodes;
  const textureNodes = state.textureNodes;
  const volume = Fn(() => {
    const origin = nodes.uCameraLocal;
    const ray = positionLocal.sub(origin).normalize();
    const outerRadius = nodes.uGroundR.add(nodes.uShellTop);
    const innerRadius = nodes.uGroundR.add(nodes.uShellFloor);

    const bOuter = dot(origin, ray);
    const outerDisc = bOuter.mul(bOuter).sub(dot(origin, origin))
      .add(outerRadius.mul(outerRadius));
    const outerRoot = sqrt(outerDisc.max(0));
    const t0 = bOuter.negate().sub(outerRoot).max(0).toVar();
    const t1 = bOuter.negate().add(outerRoot).toVar();

    const bInner = dot(origin, ray);
    const innerDisc = bInner.mul(bInner).sub(dot(origin, origin))
      .add(innerRadius.mul(innerRadius));
    const innerRoot = sqrt(innerDisc.max(0));
    const innerNear = bInner.negate().sub(innerRoot);
    const innerFar = bInner.negate().add(innerRoot);
    const originRadius = origin.length();
    const clipsInner = innerDisc.greaterThan(0).and(innerNear.greaterThan(t0));
    t1.assign(clipsInner.select(innerNear.min(t1), t1));
    If(originRadius.lessThan(innerRadius).and(innerDisc.greaterThan(0))
      .and(innerFar.greaterThan(0)), () => {
      t0.assign(innerFar.max(0));
      t1.assign(bOuter.negate().add(outerRoot));
    });

    const bGround = dot(origin, ray);
    const groundDisc = bGround.mul(bGround).sub(dot(origin, origin))
      .add(nodes.uGroundR.mul(nodes.uGroundR));
    const groundNear = bGround.negate().sub(sqrt(groundDisc.max(0)));
    const clipsGround = groundDisc.greaterThan(0).and(groundNear.greaterThan(0));
    t1.assign(clipsGround.select(groundNear.min(t1), t1));

    const forwardCos = positionView.normalize().z.negate().max(0.035);
    const sceneDepth = sceneRayLimit(nodes, forwardCos, 0.35);
    t1.assign(sceneDepth.hasOpaqueDepth.select(t1.min(sceneDepth.rayDistance), t1));

    const transmission = float(1).toVar();
    const radiance = vec3(0).toVar();
    const t = t0.add(0.5).toVar();
    Loop(MAX_MARCH_ITERATIONS, ({ i }) => {
      const active = i.lessThan(nodes.uMaxSteps)
        .and(t.lessThan(t1)).and(transmission.greaterThan(0.01));
      If(active.not(), () => {
        // Without an explicit break WGSL still executed 768 empty loop tests
        // for every sky/disc pixel after the ray left the shell. At S3 that
        // was enough to trip Windows GPU timeout detection despite occupancy
        // correctly avoiding density samples.
        Break();
      });
      If(active, () => {
        const probePosition = origin.add(ray.mul(t.add(0.5)));
        const probeRadius = probePosition.length().max(1);
        const probeDirection = probePosition.div(probeRadius);
        const altitude = probeRadius.sub(nodes.uGroundR);
        const occUv = vec3(0).toVar();
        occUv.x.assign(
          // fract(atan2 / tau) provides longitude wrap without a pole seam.
          // atan2 is kept inside the node graph, so no CPU coordinate path can
          // drift from the GPU lookup.
          // eslint-disable-next-line no-use-before-define
          cloudLongitude(probeDirection));
        occUv.y.assign(cloudLatitude(probeDirection));
        occUv.z.assign(altitude.sub(nodes.uShellFloor)
          .div(nodes.uShellTop.sub(nodes.uShellFloor).max(1)).clamp(0, 0.999999));
        const occupancy = textureNodes.occupancyTextureNode.sample(occUv);
        const occupied = occupancy.r.greaterThanEqual(OCCUPANCY_EPSILON)
          .and(altitude.greaterThanEqual(nodes.uShellFloor))
          .and(altitude.lessThan(nodes.uShellTop));
        const cosZenith = dot(ray, probeDirection).abs();
        const safeCos = cosZenith.max(GRAZING_COS_FLOOR);

        // Exact spherical occupancy-cell exit. Longitude cells are planes
        // through +Y, latitude cells are signed cones and altitude cells are
        // concentric spheres — the same topology as the CPU DDA. Empty rays
        // jump directly over the current voxel; occupied rays never integrate
        // beyond its boundary with stale feature metadata.
        const validDistance = (distance, valid = float(1)) => valid
          .greaterThan(0.5).and(distance.greaterThan(0.25))
          .select(distance, float(1e20));
        const sphereDistance = (boundaryRadius) => {
          const b = dot(probePosition, ray);
          const discriminant = b.mul(b).sub(dot(probePosition, probePosition))
            .add(boundaryRadius.mul(boundaryRadius));
          const root = sqrt(discriminant.max(0));
          const near = b.negate().sub(root);
          const far = b.negate().add(root);
          const hit = validDistance(near, discriminant.greaterThanEqual(0))
            .min(validDistance(far, discriminant.greaterThanEqual(0)));
          return hit;
        };
        const altitudeCellSize = nodes.uShellTop.sub(nodes.uShellFloor)
          .div(nodes.uOccupancyResolution.z.max(1));
        const altitudeCell = floor(altitude.sub(nodes.uShellFloor)
          .div(altitudeCellSize)).clamp(0,
          nodes.uOccupancyResolution.z.sub(1));
        const altitudeLowRadius = nodes.uGroundR.add(nodes.uShellFloor)
          .add(altitudeCell.mul(altitudeCellSize));
        const altitudeHighRadius = altitudeLowRadius.add(altitudeCellSize);
        const altitudeExit = sphereDistance(altitudeLowRadius)
          .min(sphereDistance(altitudeHighRadius));

        const planeDistance = (angle) => {
          const normal = vec3(sin(angle), 0, cos(angle).negate());
          const denominator = dot(ray, normal);
          return validDistance(dot(probePosition, normal).negate()
            .div(denominator), denominator.abs().greaterThan(1e-7));
        };
        const longitudeCell = floor(occUv.x
          .mul(nodes.uOccupancyResolution.x)).clamp(0,
          nodes.uOccupancyResolution.x.sub(1));
        const longitudeLow = longitudeCell
          .div(nodes.uOccupancyResolution.x).mul(Math.PI * 2);
        const longitudeHigh = longitudeCell.add(1)
          .div(nodes.uOccupancyResolution.x).mul(Math.PI * 2);
        const longitudeExit = planeDistance(longitudeLow)
          .min(planeDistance(longitudeHigh));

        const coneDistance = (latitudeAngle) => {
          const coneSin = sin(latitudeAngle);
          const sinSquared = coneSin.mul(coneSin);
          const positionSquared = dot(probePosition, probePosition);
          const positionRay = dot(probePosition, ray);
          const a = ray.y.mul(ray.y).sub(sinSquared);
          const b = probePosition.y.mul(ray.y)
            .sub(sinSquared.mul(positionRay)).mul(2);
          const c = probePosition.y.mul(probePosition.y)
            .sub(sinSquared.mul(positionSquared));
          const discriminant = b.mul(b).sub(a.mul(c).mul(4));
          const root = sqrt(discriminant.max(0));
          const denominator = a.mul(2);
          const rootA = b.negate().sub(root).div(denominator);
          const rootB = b.negate().add(root).div(denominator);
          const signMatches = (distance) => latitudeAngle.abs().lessThan(1e-6)
            .or(probePosition.y.add(ray.y.mul(distance))
              .mul(coneSin).greaterThanEqual(0));
          const quadraticValid = discriminant.greaterThanEqual(0)
            .and(a.abs().greaterThan(1e-7));
          const quadratic = validDistance(rootA,
            quadraticValid.and(signMatches(rootA)))
            .min(validDistance(rootB,
              quadraticValid.and(signMatches(rootB))));
          const linear = c.negate().div(b);
          return a.abs().greaterThan(1e-7).select(quadratic,
            validDistance(linear, b.abs().greaterThan(1e-7)
              .and(signMatches(linear))));
        };
        const latitudeCell = floor(occUv.y
          .mul(nodes.uOccupancyResolution.y)).clamp(0,
          nodes.uOccupancyResolution.y.sub(1));
        const latitudeLow = latitudeCell
          .div(nodes.uOccupancyResolution.y).mul(Math.PI).sub(Math.PI / 2);
        const latitudeHigh = latitudeCell.add(1)
          .div(nodes.uOccupancyResolution.y).mul(Math.PI).sub(Math.PI / 2);
        const latitudeExit = coneDistance(latitudeLow)
          .min(coneDistance(latitudeHigh));
        const voxelExit = altitudeExit.min(longitudeExit).min(latitudeExit)
          .clamp(MIN_STEP_METERS, 12000);
        const fineStep = occupancy.g.div(nodes.uSamplesPerFeature.max(1))
          .div(safeCos)
          .min(occupancy.b.div(HORIZONTAL_DIVISOR))
          .clamp(MIN_STEP_METERS, MAX_STEP_METERS);
        const requestedStep = occupied.select(fineStep.min(voxelExit),
          voxelExit.add(1));
        const stepLength = requestedStep.min(t1.sub(t).max(0));
        If(occupied, () => {
          const samplePosition = origin.add(ray.mul(t.add(stepLength.mul(0.5))));
          const medium = cloudDensityTSL(samplePosition, {
            ...textureNodes,
            groundR: nodes.uGroundR,
            shellTopMeters: nodes.uShellTop,
            maxTerrainMeters: nodes.uMaxTerrainMeters,
          });
          const alphaStep = float(1).sub(exp(medium.y
            .mul(stepLength).negate()));
          const familyMix = medium.w.div(medium.z.add(medium.w).max(1e-5));
          const unlitMedium = mix(
            nodes.uAmbC.mul(vec3(0.88, 0.9, 0.94)),
            vec3(0.88, 0.92, 0.99),
            familyMix.mul(0.45),
          ).mul(nodes.uTint);
          radiance.addAssign(unlitMedium.mul(transmission).mul(alphaStep));
          transmission.mulAssign(float(1).sub(alphaStep));
        });
        t.addAssign(stepLength.max(0.5));
      });
    });

    const valid = outerDisc.greaterThan(0).and(t1.greaterThan(t0))
      .and(nodes.uResourceReady.greaterThan(0.5));
    const alpha = valid.select(float(1).sub(transmission)
      .mul(nodes.uEngage).clamp(0, 0.985), float(0));
    return vec4(radiance.mul(nodes.uEngage), alpha);
  })();

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.BackSide,
    fog: false,
  });
  material.name = 'Cloud volume rewrite phase 4 A';
  material.colorNode = volume.rgb.div(volume.a.max(0.001));
  material.opacityNode = volume.a;
  material.uniforms = nodes;
  material.userData.sharedLocalVolume = true;
  material.userData.volumeOutput = 'straight-alpha';
  material.userData.cloudRewrite = 'phase4-A';
  return material;
}

// Kept outside the marcher closure so the same helpers are also visible to
// the TSL builder when it resolves the Fn graph.
function cloudLongitude(direction) {
  return atan(direction.z, direction.x).div(Math.PI * 2).fract();
}

function cloudLatitude(direction) {
  return asin(direction.y.clamp(-1, 1)).div(Math.PI).add(0.5).clamp(0, 1);
}

export function createCloudVolumeNode(state) {
  if (!state?.nodes || !state?.textureNodes) {
    throw new TypeError('createCloudVolumeNode() needs a cloud volume instance state');
  }
  return buildMaterial(state);
}

export function makeCloudVolumeMaterial(planet, band, profile = {}) {
  const state = createInstanceState(planet, band, profile);
  planet.volCloudState = state;
  planet.volCloudUniforms = state.nodes;
  planet.volCloudBand = band;
  if (!sharedTopology) {
    sharedTopology = { state, material: createCloudVolumeNode(state) };
  }
  planet.syncVolCloudMaterial = () => copyInstanceToTopology(state, sharedTopology);
  state.bindResourceToSharedTopology = () => {
    state.bindResource(state.resource);
    copyInstanceToTopology(state, sharedTopology);
  };
  return sharedTopology.material;
}

export function resetCloudVolumeTopologyForTests() {
  sharedTopology?.material?.dispose?.();
  sharedTopology = null;
}
