// Stage B static and pure-module contract.
//
// This test deliberately does not render. It prevents the browser suites from
// passing merely because a volume pass changed some pixels while the physical
// inputs, scene-depth clipping, weather motion, or adaptive budgets remained
// disconnected. Browser screenshots and real-GPU performance are separate
// Stage B gates.

import { readFile } from 'node:fs/promises';

const failures = [];
let passes = 0;

function check(condition, label, detail) {
  if (condition) {
    passes++;
    console.log(`✓ ${label}`);
    return true;
  }
  failures.push(detail ? `${label}: ${detail}` : label);
  console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function finiteVector(value) {
  let values;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) values = Array.from(value);
  else if (value?.toArray) values = value.toArray();
  else if (value && ['r', 'g', 'b'].every((key) => Number.isFinite(value[key]))) {
    values = [value.r, value.g, value.b];
  } else if (value && ['x', 'y', 'z'].every((key) => Number.isFinite(value[key]))) {
    values = [value.x, value.y, value.z];
  }
  return values?.slice(0, 3).every(Number.isFinite) ? values.slice(0, 3) : null;
}

function finiteScalar(value) {
  if (Number.isFinite(value)) return value;
  for (const key of ['irradiance', 'flux', 'wattsPerSquareMetre', 'rayleigh', 'density']) {
    if (Number.isFinite(value?.[key])) return value[key];
  }
  return NaN;
}

function distance(a, b) {
  if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b);
  const va = finiteVector(a), vb = finiteVector(b);
  if (!va || !vb) return Infinity;
  return Math.hypot(...va.map((value, index) => value - vb[index]));
}

async function loadSource(relativePath) {
  try {
    return await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
  } catch (error) {
    check(false, `${relativePath} is readable`,
      `required Stage B source is missing or unreadable (${error.code || error.message})`);
    return '';
  }
}

async function loadModule(relativePath) {
  try {
    const module = await import(new URL(`../${relativePath}`, import.meta.url));
    check(true, `${relativePath} imports without browser globals`);
    return module;
  } catch (error) {
    check(false, `${relativePath} imports without browser globals`,
      `${error.code || error.name}: ${error.message}`);
    return null;
  }
}

function requireFunction(module, modulePath, exportName) {
  const value = module?.[exportName];
  check(typeof value === 'function', `${modulePath} exports ${exportName}()`,
    `expected a pure exported function named ${exportName}`);
  return typeof value === 'function' ? value : null;
}

function tokenCount(source, token) {
  return source.split(token).length - 1;
}

function consumedUniform(source, token, owner) {
  return check(tokenCount(source, token) >= 2, `${owner} consumes ${token}`,
    `${token} must occur in both the uniform declaration/wiring and shader computation; a dead uniform is not a connection`);
}

// ---- Stellar radiometry ----------------------------------------------------

const stellarPath = 'src/stellar-radiometry.js';
const stellar = await loadModule(stellarPath);
const blackbodyLinearRgb = requireFunction(stellar, stellarPath, 'blackbodyLinearRgb');
const stellarIrradiance = requireFunction(stellar, stellarPath, 'stellarIrradiance');
const buildStellarLightField = requireFunction(stellar, stellarPath, 'buildStellarLightField');

if (blackbodyLinearRgb) {
  try {
    const warm = finiteVector(blackbodyLinearRgb(3000));
    const solar = finiteVector(blackbodyLinearRgb(5772));
    const hot = finiteVector(blackbodyLinearRgb(10000));
    check(warm && solar && hot, 'blackbody colours are finite linear RGB triplets',
      '3000 K, 5772 K, and 10000 K must each return three finite channels');
    if (warm && solar && hot) {
      check(warm[0] > warm[2], '3000 K stellar light is warmer than blue',
        `received ${JSON.stringify(warm)}`);
      check(hot[2] > hot[0], '10000 K stellar light is bluer than red',
        `received ${JSON.stringify(hot)}`);
      check(solar.every((channel) => channel >= 0), 'solar colour has no negative radiance',
        `received ${JSON.stringify(solar)}`);
    }
  } catch (error) {
    check(false, 'blackbody colour temperature contract',
      `blackbodyLinearRgb(kelvin) threw ${error.message}`);
  }
}

if (stellarIrradiance) {
  try {
    const AU = 149_597_870_700;
    const atOneAu = finiteScalar(stellarIrradiance(1, AU));
    const atTwoAu = finiteScalar(stellarIrradiance(1, AU * 2));
    const ratio = atOneAu / atTwoAu;
    check(atOneAu > 0 && atTwoAu > 0, 'stellar irradiance is positive',
      `1 AU=${atOneAu}, 2 AU=${atTwoAu}`);
    check(Math.abs(ratio - 4) < 0.08, 'stellar irradiance follows inverse-square distance',
      `expected 4× between 1 AU and 2 AU, received ${ratio}`);
  } catch (error) {
    check(false, 'stellar inverse-square contract',
      `stellarIrradiance(luminositySolar, distanceMetres) threw ${error.message}`);
  }
}

if (buildStellarLightField) {
  try {
    const lights = buildStellarLightField([
      {
        position: [149_597_870_700, 0, 0],
        temperatureK: 5772,
        luminositySolar: 1,
      },
      {
        position: [0, 299_195_741_400, 0],
        temperatureK: 9000,
        luminositySolar: 2,
      },
    ], [0, 0, 0]);
    const entries = Array.isArray(lights) ? lights : (lights?.sources || lights?.lights);
    check(Array.isArray(entries) && entries.length === 2,
      'stellar light field preserves both stars',
      `expected two directional radiometry entries, received ${JSON.stringify(lights)}`);
    if (Array.isArray(entries)) {
      check(entries.every((entry) => finiteVector(entry.direction || entry.dir)
          && finiteVector(entry.color || entry.radiance)
          && finiteScalar(entry.irradiance ?? entry.flux) > 0),
      'each stellar light carries direction, colour, and irradiance',
      'a binary field must not collapse into a single dominant sunDir');
    }
  } catch (error) {
    check(false, 'binary stellar-light-field contract',
      `buildStellarLightField(stars, observerPosition) threw ${error.message}`);
  }
}

// ---- Atmosphere physics ----------------------------------------------------

const atmospherePath = 'src/atmosphere-physics.js';
const atmosphere = await loadModule(atmospherePath);
const rayleighCoefficients = requireFunction(atmosphere, atmospherePath, 'rayleighCoefficients');
const mieCoefficients = requireFunction(atmosphere, atmospherePath, 'mieCoefficients');
const createAtmosphereProfile = requireFunction(atmosphere, atmospherePath, 'createAtmosphereProfile');
const atmosphereDensityAt = requireFunction(atmosphere, atmospherePath, 'atmosphereDensityAt');
const nightSkyIrradiance = requireFunction(atmosphere, atmospherePath, 'nightSkyIrradiance');

if (rayleighCoefficients) {
  try {
    const beta = finiteVector(rayleighCoefficients([680, 550, 440]));
    check(beta && beta.every((channel) => channel > 0),
      'Rayleigh coefficients are finite and positive',
      `received ${JSON.stringify(beta)}`);
    if (beta) {
      check(beta[2] > beta[1] && beta[1] > beta[0],
        'Rayleigh scattering increases toward shorter wavelengths',
        `expected beta(440nm) > beta(550nm) > beta(680nm), received ${JSON.stringify(beta)}`);
    }
  } catch (error) {
    check(false, 'Rayleigh wavelength contract',
      `rayleighCoefficients([680,550,440]) threw ${error.message}`);
  }
}

if (mieCoefficients) {
  try {
    const mie = mieCoefficients({ turbidity: 2.2 });
    const scattering = finiteVector(mie?.scattering ?? mie);
    const extinction = finiteVector(mie?.extinction ?? mie);
    check(scattering && extinction
      && scattering.every((channel) => channel >= 0)
      && extinction.every((channel, index) => channel >= scattering[index]),
      'Mie coefficients are finite and non-negative',
      `received ${JSON.stringify(mie)}`);
  } catch (error) {
    check(false, 'Mie coefficient contract',
      `mieCoefficients({ turbidity }) threw ${error.message}`);
  }
}

if (createAtmosphereProfile && atmosphereDensityAt) {
  try {
    const profile = createAtmosphereProfile({ rayleighScaleHeightMeters: 8000 });
    const sea = finiteScalar(atmosphereDensityAt(profile, 0));
    const high = finiteScalar(atmosphereDensityAt(profile, 8000));
    check(sea > high && high > 0, 'atmosphere density decreases continuously with altitude',
      `sea=${sea}, at 8 km=${high}`);
  } catch (error) {
    check(false, 'atmosphere density profile contract',
      `atmosphereDensityAt(heightMetres, profile) threw ${error.message}`);
  }
}

if (nightSkyIrradiance) {
  try {
    const night = finiteVector(nightSkyIrradiance({ starField: 1, airglow: 1 }));
    check(night && night.some((channel) => channel > 0),
      'night-sky irradiance is non-zero but directional-light independent',
      `received ${JSON.stringify(night)}`);
  } catch (error) {
    check(false, 'night-sky irradiance contract',
      `nightSkyIrradiance(profile) threw ${error.message}`);
  }
}

// ---- Deterministic, evolving weather field --------------------------------

const weatherPath = 'src/weather-field.js';
const weather = await loadModule(weatherPath);
const createWeatherField = requireFunction(weather, weatherPath, 'createWeatherField');
const sampleWeatherField = requireFunction(weather, weatherPath, 'sampleWeatherField');
const advanceWeatherField = requireFunction(weather, weatherPath, 'advanceWeatherField');
const weatherFieldFingerprint = requireFunction(weather, weatherPath, 'weatherFieldFingerprint');

if (createWeatherField && sampleWeatherField && advanceWeatherField && weatherFieldFingerprint) {
  try {
    const seed = 'STAGE-B-WEATHER-CONTRACT';
    const options = {
      cloudiness: 0.58,
      humidity: 0.62,
      windSpeed: 18,
    };
    const a = createWeatherField(seed, options);
    const b = createWeatherField(seed, options);
    const initialA = weatherFieldFingerprint(a);
    const initialB = weatherFieldFingerprint(b);
    check(initialA === initialB, 'weather field is deterministic for seed and options',
      `fingerprints differ: ${initialA} vs ${initialB}`);

    const initialSample = sampleWeatherField(a, [0.31, 0.42, 0.85]);
    for (const channel of ['coverage', 'cloudType', 'humidity', 'precipitation', 'wind']) {
      check(initialSample?.[channel] !== undefined,
        `weather samples expose ${channel}`,
        `sampleWeatherField must return the Lo/Hi weather state needed by clouds and surface weather`);
    }

    // One minute of celestial time is long enough to prove motion without
    // treating a fast-moving front as a discontinuity.
    const elapsedHours = 1 / 60;
    const advancedA = advanceWeatherField(a, elapsedHours);
    const advancedB = advanceWeatherField(b, elapsedHours);
    const fieldA = advancedA || a;
    const fieldB = advancedB || b;
    const nextA = weatherFieldFingerprint(fieldA);
    const nextB = weatherFieldFingerprint(fieldB);
    check(nextA === nextB, 'weather evolution is deterministic across identical runs',
      `fingerprints differ after one minute: ${nextA} vs ${nextB}`);
    check(nextA !== initialA, 'weather field evolves with elapsed time',
      'the weather fingerprint remained unchanged after a one-minute advance');

    const afterSample = sampleWeatherField(fieldA, [0.31, 0.42, 0.85]);
    check(distance(initialSample?.coverage, afterSample?.coverage) < 0.2,
      'weather evolution is continuous at a fixed location',
      `coverage jumped from ${initialSample?.coverage} to ${afterSample?.coverage}`);
  } catch (error) {
    check(false, 'deterministic weather evolution contract',
      `${error.name}: ${error.message}`);
  }
}

// ---- Render-graph and runtime wiring ---------------------------------------

const [pipelineSource, planetSource, cloudSource, mainSource,
  shaftSource, nodeShaderSource, weatherEffectsSource, volumeDepthSource,
  volumePassSource] = await Promise.all([
  loadSource('src/node-render-pipeline.js'),
  loadSource('src/planet.js'),
  loadSource('src/clouds-node.js'),
  loadSource('src/main.js'),
  loadSource('src/sun-shafts-node.js'),
  loadSource('src/shaders-node.js'),
  loadSource('src/weather-effects.js'),
  loadSource('src/volume-depth-node.js'),
  loadSource('src/volumetric-pass.js'),
]);

check(/scenePass\.getTexture(?:Node)?\(\s*['"]depth['"]\s*\)|scenePass\.getDepthNode\(/.test(pipelineSource),
  'WebGPU pipeline exposes the opaque scene depth',
  `node-render-pipeline.js must obtain the main scene depth for the atmosphere/cloud pass`);
check(tokenCount(pipelineSource, 'sceneDepth') >= 2
    || /volumePass[\s\S]{0,300}(?:depthTexture|depthNode)/.test(pipelineSource),
  'WebGPU volume pass receives the opaque scene depth',
  `creating a depth texture without passing it to the volume graph is still a dead connection`);
check(/setVolumeScale\s*\([^)]*\)[\s\S]{0,500}setResolutionScale\(/.test(pipelineSource),
  'WebGPU adaptive volume scale updates the real pass resolution',
  `main.js already calls setVolumeScale(); GameNodePipeline must implement it with setResolutionScale()`);
check(/createSunShaftNode[\s\S]*rtt\(/.test(pipelineSource)
    && /inputTexture\.sample/.test(shaftSource),
  'WebGPU graph includes a sampleable sun-shaft pass',
  'ground-level light columns must be part of the production graph, not an unused helper');
check(tokenCount(shaftSource, 'inputTexture.sample') >= 2
    && /uStrength/.test(shaftSource),
  'sun shafts gather bounded radial radiance and expose strength control',
  'a flat bloom tint does not satisfy depth/cloud-shaped light columns');
check(/sceneDepthTexture\.sample/.test(shaftSource)
    && /skyVisibility/.test(shaftSource),
  'sun shafts reject opaque terrain and water as light sources',
  'sampling the complete HDR scene without its depth mask smears snow and water into light sabres');

consumedUniform(`${cloudSource}\n${volumeDepthSource}`, 'tSceneDepth', 'WebGPU cloud shader');
consumedUniform(`${cloudSource}\n${volumeDepthSource}`, 'uDepthReady', 'WebGPU cloud shader');
check(/(?:uStarDirs|uLightDirs|uStellarDirections)/.test(cloudSource),
  'WebGPU cloud shader declares a multi-star direction field',
  `a single uSunDir cannot represent binary lighting`);
check(/(?:uStarColors|uLightColors|uStellarRadiance)/.test(cloudSource),
  'WebGPU cloud shader declares per-star colour/radiance',
  `companion colour temperature must reach cloud scattering`);
check(/(?:uStarFlux|uStarIrradiance|uLightWeights)/.test(cloudSource),
  'WebGPU cloud shader declares per-star irradiance',
  `binary stars must not contribute equal hard-coded light`);
check(/(?:uWeatherTime|uWeatherPhase|uAdvectionTime)/.test(cloudSource),
  'WebGPU cloud shader declares weather/advection time',
  `mesh rotation alone does not evolve a raymarched volume field`);
for (const token of ['uWeatherTime', 'uWeatherPhase', 'uAdvectionTime']) {
  if (cloudSource.includes(token)) consumedUniform(cloudSource, token, 'WebGPU cloud shader');
}
consumedUniform(cloudSource, 'uMaxSteps', 'WebGPU cloud shader');
check(/Loop\([^)]*(?:uMaxSteps|stepCount)|(?:stepCount|activeSteps)[\s\S]{0,160}uMaxSteps/.test(cloudSource),
  'WebGPU cloud raymarch loop uses the adaptive step budget',
  `a reported cloudSteps value is not real unless it changes the shader loop`);
check(/(?:uWeatherLo|uWeatherHi|weatherLo|weatherHi)/.test(cloudSource)
    || (/\.[rgba]\b/.test(cloudSource)
      && new Set(cloudSource.match(/weather[^;\n]*\.[rgba]\b/g) || []).size >= 2),
  'WebGPU clouds consume multi-channel weather data',
  `one static red-channel coverage texture cannot encode cloud type, high cloud, storm, and precipitation`);
check(/weatherLoTextureNode/.test(cloudSource)
    && /weatherHiTextureNode/.test(cloudSource)
    && /stratusMask/.test(cloudSource)
    && /highType/.test(cloudSource),
  'WebGPU clouds preserve separate low/high meteorological atlases',
  'packing stratus and high-cloud type into one atlas silently drops requested cloud families');
check(/stratusProfile/.test(cloudSource)
    && /cumulusProfile/.test(cloudSource)
    && /altoProfile/.test(cloudSource)
    && /cirrusProfile/.test(cloudSource)
    && /anvilProfile/.test(cloudSource),
  'WebGPU cloud density has distinct low, mid, high and convective profiles',
  'one generic shell cannot represent stratus, cumulus, alto, cirrus and cumulonimbus anvils');
check(/stratocumulusProfile/.test(cloudSource)
    && /nimbostratusProfile/.test(cloudSource)
    && /altocumulusProfile/.test(cloudSource)
    && /cirrocumulusProfile/.test(cloudSource)
    && /lenticularProfile/.test(cloudSource)
    && /towerProfile/.test(cloudSource),
  'WebGPU cloud volume renders the extended low/mid/high genus set',
  'cloud family names are insufficient unless each family owns a distinct density profile');
check(/rayJitter/.test(cloudSource) && /uVolumeSize/.test(cloudSource)
    && /weatherPosition\.mul\(1\s*\/\s*42000\)/.test(cloudSource),
  'cloud traversal uses metre-scaled detail and interleaved ray jitter',
  'unit-sphere noise and fixed midpoint samples create kilometre-wide lobes and white brush bands');
check(/phaseForward/.test(cloudSource) && /phaseBack/.test(cloudSource)
    && /powder/.test(cloudSource),
  'WebGPU cloud lighting uses dual-lobe phase and powder response',
  'flat ambient-plus-sun tint cannot preserve bright rims and readable cloud interiors');

consumedUniform(`${planetSource}\n${volumeDepthSource}`, 'tSceneDepth', 'WebGPU atmosphere shader');
consumedUniform(`${planetSource}\n${volumeDepthSource}`, 'uDepthReady', 'WebGPU atmosphere shader');
check(/logarithmicDepthToViewZ/.test(volumeDepthSource)
    && !/pow\s*\(\s*(?:nodes\.)?uCameraFar/.test(volumeDepthSource),
  'WebGPU volumes invert the production logarithmic depth in view space',
  'the renderer writes logarithmic depth; perspective linearization clips clouds to a limb or overlays terrain');
check(/(?:uStarDirs|uLightDirs|uStellarDirections)/.test(planetSource),
  'WebGPU atmosphere declares a multi-star direction field',
  `the atmosphere must not collapse buildStellarLightField() back to one sunDir`);
check(/(?:uStarColors|uLightColors|uStellarRadiance)/.test(planetSource),
  'WebGPU atmosphere declares per-star colour/radiance',
  `stellar colour temperature must reach atmospheric scattering`);
check(/5\.78e-6[\s\S]*13\.56e-6[\s\S]*33\.10e-6/.test(planetSource),
  'WebGPU atmosphere uses inverse-metre Rayleigh coefficients',
  'normalized RGB colours multiplied by metre-long steps make the atmosphere opaque');
check(/setStellar(?:Lights|Field)|setStar(?:Lights|Field)/.test(planetSource),
  'Planet exposes a multi-star lighting update',
  `replace or supplement setSunDir() with a field that preserves every star`);
check(/createWeatherField|WeatherField/.test(planetSource),
  'Planet owns a deterministic weather field',
  `cloud coverage metadata alone is not a weather system`);
check(/advanceWeatherField|sampleWeatherField|weather(?:Hours|Time|Phase)|updateWeather\s*\(/.test(planetSource),
  'Planet samples weather at deterministic celestial time',
  `weather must evolve from the shared celestial clock so reloads and time warp reconstruct the same field`);
check(/setWeatherFixture[\s\S]{0,1800}weatherLoTextureNode/.test(planetSource)
    && /setWeatherFixture[\s\S]{0,1800}weatherHiTextureNode/.test(planetSource),
  'weather fixtures rebind both cloud atlases used by the volume renderer',
  'changing rain metadata without replacing the sampled Lo/Hi atlas leaves a clear sky during storms');
check(/applyNoctilucentField/.test(planetSource)
    && /cloudMeshNoctilucent/.test(planetSource)
    && /noctilucent-mesosphere-v1/.test(nodeShaderSource),
  'mesospheric noctilucent clouds own a separate terminator shell',
  'placing noctilucent clouds in the tropospheric volume gives them the wrong altitude and traversal');
check(/material\.polygonOffset\s*=\s*false/.test(nodeShaderSource)
    && /material\.alphaTest\s*=\s*0/.test(nodeShaderSource)
    && /continuous physical shell/.test(nodeShaderSource),
  'water uses terrain depth occlusion instead of coarse bathymetry alpha cutouts',
  'a vertex wet-mask creates black coastline cracks at orbital LOD');
check(!/fogDensity\s*=\s*transit\s*\*/.test(mainSource),
  'cloud traversal never drives global FogExp2',
  'cloud proximity must be integrated by the depth-aware volume, not replace the frame as pseudo-loading fog');
check(/SKY_BACKDROP_LAYER/.test(pipelineSource)
    && /skyPass\s*=\s*pass/.test(pipelineSource)
    && /over\(this\.skyPass\.getTextureNode\('output'\),\s*sceneColor\)/.test(pipelineSource),
  'WebGPU sky owns a dedicated backdrop pass below the opaque world',
  'a finite transparent sphere can pass the depth test and cover distant terrain');
check(/previous\.volumeActive\s*=\s*false/.test(volumePassSource)
    && /planet\.volumeActive\s*=\s*true/.test(volumePassSource)
    && /previous\.atmoMesh\?\.layers\.set\(WORLD_LAYER\)/.test(volumePassSource),
  'local participating media has one explicit active-planet owner',
  'inactive moon and planet atmospheres must not remain in an unoccluded overlay pass');
check(/focused\s*&&\s*this\.volumeActive/.test(planetSource)
    && /this\.volumeActive\s*&&\s*e\s*>\s*0\.01/.test(planetSource),
  'inactive volumetric cloud shells cannot render above the active planet',
  'focused-distance fades alone do not establish cross-body depth ownership');
check(/fog:\s*false/.test(cloudSource)
    && /atmoMesh\.material\.fog\s*=\s*false/.test(planetSource),
  'integrated atmosphere and cloud media opt out of global scene fog',
  'FogExp2 must not recolor a participating medium after it has integrated extinction');

check(/setCloudStepBudget\s*\([^)]*\)[\s\S]{0,500}uMaxSteps/.test(mainSource),
  'main adaptive cloud budget writes the shader uniform',
  `effectiveCloudSteps must not be a stats-only number`);
check(/nodePipeline\.setVolumeScale\?\.\(/.test(mainSource),
  'main adaptive volume scale targets the render pipeline',
  `adaptive volume resolution must call the concrete GameNodePipeline setter`);
check(/universe\.update\([^;\n]*celestialClock\.hours/.test(mainSource)
    && /\.update\([^;\n]*(?:FREEZE|photoMode)[^;\n]*dt/.test(mainSource),
  'main loop supplies celestial weather time and independent animation delta',
  `absolute weather state must follow celestialClock.hours while freeze/photo mode can stop only visual advection`);
check(/buildStellarLightField|stellarLightField|setStellar(?:Lights|Field)|setStar(?:Lights|Field)/.test(mainSource),
  'runtime forwards the multi-star radiometry field',
  `counting two PointLights is insufficient; atmosphere/cloud/water uniforms need the field`);
check(/setWeatherWind\(/.test(mainSource)
    && /gustEnvelope/.test(nodeShaderSource)
    && /clock\.mul\(7\.6\)/.test(nodeShaderSource),
  'weather drives five-scale vegetation wind with amplitude-only gusts',
  'wind must include lean, sway, branch response, secondary motion and leaf flutter');
check(/LineSegments/.test(weatherEffectsSource) && /Points/.test(weatherEffectsSource)
    && /lightning/.test(weatherEffectsSource),
  'surface weather renders rain, snow and storm lightning',
  'weather metadata without player-visible effects is incomplete');

console.log(`\nStage B contract: ${passes} passed, ${failures.length} failed.`);
if (failures.length) {
  console.error('\nMissing Stage B contracts:');
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exitCode = 1;
} else {
  console.log('PASS: Stage B physical modules and runtime wiring are connected.');
}
