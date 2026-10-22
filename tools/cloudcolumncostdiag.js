// Formal-size row costs, or independent complete-atlas native verification.
// --full skips the row-window/cold/warm experiment and rebuilds complete maps.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { verifyColumnShaderContract } from './columnshadercontracttest.js';

const full = process.argv.includes('--full'), skipEmpty = process.argv.includes('--skip-empty');
assert.ok(process.argv.slice(2).every(value => ['--full','--skip-empty'].includes(value)), 'Only --full and --skip-empty are supported');
const out = `test-results/cloud-column-cost/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const fixturePath = 'tools/fixtures/cloud-column-cost-original.json';
const fixtureBytes = await readFile(new URL('./fixtures/cloud-column-cost-original.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(fixture.sha256, '20c1943dce46665d0258225a82b9db0a5f40163f0b35c799b684c0076890b759');
assert.equal(sha256(fixture.source), fixture.sha256);assert.equal(Buffer.byteLength(fixture.source), fixture.bytes);
const original = fixture.source;
const call = 'speciesCondensate(frame,axis,altitude,band,parameters.x,parameters.y,parameters.z,int(shape.x),speciesStructureAt(species).x,productionAreaBand(uv,species))';
const point = '              for(int k=0;k<count;k++) {';
assert.equal(original.split(call).length - 1, 1);assert.equal(original.split(point).length - 1, 1);
const a = original.replace(point, '              vec2 columnRegion=productionAreaBand(uv,species);\n              float minimumDepth=speciesStructureAt(species).x;\n' + point)
  .replace(call, 'speciesCondensate(frame,axis,altitude,band,parameters.x,parameters.y,parameters.z,int(shape.x),minimumDepth,columnRegion)');
const baseAmount = original.replace("import * as THREE from 'three';", "import * as THREE from 'three';\nimport { productionColumnCondensateGLSL } from './production-shape.js';")
  .replace('${productionCloudGLSL}', '${productionCloudGLSL}${productionColumnCondensateGLSL}')
  .replace(point, '              vec2 columnRegion=productionAreaBand(uv,species);\n              float minimumDepth=speciesStructureAt(species).x;\n              float columnAmount=columnSpeciesAmount(frame,band,columnRegion);\n' + point)
  .replace(call, 'columnSpeciesCondensate(frame,axis,altitude,band,parameters.x,parameters.y,parameters.z,int(shape.x),minimumDepth,columnAmount)');
assert.notEqual(baseAmount, original);
assert.ok(baseAmount.includes('${productionCloudGLSL}${productionColumnCondensateGLSL}'));
const gatedAmount=baseAmount.replace('float columnAmount=columnSpeciesAmount(frame,band,columnRegion);',
  'float columnAmount=columnSpeciesAmount(frame,band,columnRegion);\n              if(columnAmount<=0.0)continue;');
const installed = await readFile(new URL('../src/cloud/cloud-column-map.js', import.meta.url));
const normalized=source=>source.replaceAll('\r\n','\n');
const shaderContract=verifyColumnShaderContract();
const amount=skipEmpty?gatedAmount:installed.toString('utf8');
const candidateKind='skip-empty-species';
const experimentalOverride=normalized(amount)!==normalized(installed.toString('utf8'));

const variants = { original, parameters: a, amount, shared:baseAmount,
  wrong: gatedAmount.replace('columnSpeciesAmount(frame,band,columnRegion)', 'columnSpeciesAmount(frame,band,vec2(0.0,1.0))') };
for (const [name, body] of Object.entries(variants)) await writeFile(`${out}/${name}-source.js`, body);
await writeFile(`${out}/original-fixture.json`, fixtureBytes);
await writeFile(`${out}/verifier.js`,await readFile(new URL(import.meta.url)));
await writeFile(`${out}/shader-contract.js`,await readFile(new URL('./columnshadercontracttest.js',import.meta.url)));
await writeFile(`${out}/shader-contract-fixture.json`,await readFile(new URL('./fixtures/cloud-column-work-original.json',import.meta.url)));
const reference = { path: fixturePath, fixtureSha256: sha256(fixtureBytes), revision: fixture.revision,
  installedRawSha256: sha256(installed), installedRawBytes: installed.length,
  candidateKind, experimentalOverride, skipEmptyRequested:skipEmpty,shaderContract,
  originalPath: fixture.path, sourceSha256: fixture.sha256, sourceBytes: fixture.bytes,
  variants: Object.fromEntries(Object.entries(variants).map(([name, source]) => [name, { sha256: sha256(source), bytes: Buffer.byteLength(source) }])) };
const before = await evidenceFingerprint('tools/cloudcolumncostdiag.js');
const { server, port } = await startServer(0);let browser;const errors = [];
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/column-cost.html*', route => route.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script><canvas id="fixture"></canvas>' }));
  for (const [name, body] of Object.entries(variants)) await page.route(`**/src/cloud/cost-${name}.js`, route => route.fulfill({ contentType: 'text/javascript', body }));
  await page.goto(`http://127.0.0.1:${port}/column-cost.html?vclouds=1`);
  const result = await page.evaluate(async ({ full }) => {
    const T = await import('three'), { Planet } = await import('/src/planet.js');
    const { GalaxyCatalog, HOME_SYSTEM_ID } = await import('/src/galaxy-layout.js');
    const { generateSystemSpec, applySystemBodyTuning } = await import('/src/astronomy.js').then(async module => ({ ...module,
      applySystemBodyTuning: (await import('/src/world-config.js')).applySystemBodyTuning }));
    const { ACTIVE_GALAXY_ID, getGalaxyConfig, resolveBodyTuning } = await import('/src/world-config.js');
    const { createGameRenderer } = await import('/src/renderer-runtime.js');
    const seed = getGalaxyConfig(ACTIVE_GALAXY_ID).seed, star = new GalaxyCatalog(seed).getSystem(HOME_SYSTEM_ID);
    const spec = applySystemBodyTuning(generateSystemSpec(seed, star), id => resolveBodyTuning(ACTIVE_GALAXY_ID, star.id, id)).bodies[0];
    const p = new Planet({ seed: spec.seed, name: spec.name, catalogName: spec.catalogName, posUniv: new T.Vector3(),
      type: spec.type, isMoon: spec.isMoon, radius: spec.radius, atmosphere: spec.atmosphere, clouds: spec.clouds,
      tuning: resolveBodyTuning(ACTIVE_GALAXY_ID, star.id, spec.bodyId), formation: spec.formation, ringSystem: spec.ringSystem });
    const { renderer: r } = await createGameRenderer({}, { canvas: document.querySelector('#fixture') });
    r.setSize(64, 64);r.info.autoReset = false;
    const gl = r.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) throw Error('Hardware GPU timer required');
    const options = { width: 1024, samples: 128, footprintSamples: 64 };
    const constructors = {}, maps = {}, leases = { original: {}, amount: {} };
    for (const name of (full ? ['original', 'amount'] : ['original', 'parameters', 'amount', 'shared', 'wrong']))
      constructors[name] = (await import(`/src/cloud/cost-${name}.js`)).CloudColumnMap;
    const check = (condition, message) => { if (!condition) throw Error(message); };
    const checkpoint = label => {
      const error = gl.getError(), lost = gl.isContextLost();
      check(error === 0 && !lost, `${label}: GL ${error}, lost ${lost}`);return { error, lost };
    };
    async function completeQuery(query) {
      const started = performance.now(), deadline = started + 120000;
      try {
        while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
          check(!gl.isContextLost() && performance.now() < deadline, 'Column completion unavailable');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        const gpuMs = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
        check(!disjoint && Number.isFinite(gpuMs), 'Invalid/disjoint column sample');
        return { gpuMs, queryWaitMs: performance.now() - started };
      } finally { gl.deleteQuery(query); }
    }
    function readTarget(target, row, height) {
      const optical = new Uint8Array(1024 * height * 4), heights = new Uint16Array(1024 * height * 4);
      const saved = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();
      const started = performance.now();
      try {
        r.setRenderTarget(target);r.readRenderTargetPixels(target, 0, row, 1024, height, optical);
        r.readRenderTargetPixels(target, 0, row, 1024, height, heights, undefined, 1);
      } finally { r.setRenderTarget(saved, face, mip); }
      const readMs = performance.now() - started, state = checkpoint('Native readback');
      let nonfiniteHeights = 0;for (const value of heights) if ((value & 0x7c00) === 0x7c00) nonfiniteHeights++;
      check(nonfiniteHeights === 0, 'Nonfinite native height values');
      return { optical, heights, nonfiniteHeights, readMs, gl: state };
    }
    const delta = (a, b) => Object.fromEntries(['optical', 'heights'].map(key => {
      check(a[key].length === b[key].length, 'Native dimensions differ');
      let count = 0;for (let i = 0; i < a[key].length; i++) if (a[key][i] !== b[key][i]) count++;
      return [key, count];
    }));
    async function nativeMetadata(data) {
      const digest = async view => [...new Uint8Array(await crypto.subtle.digest('SHA-256', view.buffer))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
      let occupied = 0, invalidHeightAlpha = 0;
      for (let i = 3; i < data.heights.length; i += 4) if (data.heights[i] !== 0x3c00) invalidHeightAlpha++;
      for (let i = 0; i < data.optical.length; i += 4) if (data.optical[i] || data.optical[i + 1]) occupied++;
      return { optical: { type: 'Uint8Array/RGBA8', elements: data.optical.length, bytes: data.optical.byteLength, sha256: await digest(data.optical) },
        heights: { type: 'Uint16Array/RGBA16F native bits', elements: data.heights.length, bytes: data.heights.byteLength,
          sha256: await digest(data.heights), nonfinite: data.nonfiniteHeights, invalidAlpha: invalidHeightAlpha },
        occupied, readMs: data.readMs, gl: data.gl };
    }
    const { FullScreenQuad } = await import('/vendor/jsm/postprocessing/Pass.js');
    const display = new T.ShaderMaterial({ uniforms: { map: { value: null } },
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0,1);}',
      fragmentShader: 'uniform sampler2D map;varying vec2 vUv;void main(){gl_FragColor=vec4(texture2D(map,vUv).xy,0,1);}',
      depthTest: false, depthWrite: false });
    const quad = new FullScreenQuad(display);
    const show = target => { display.uniforms.map.value = target.textures[0];r.setRenderTarget(null);quad.render(r); };
    let expandedTarget = null, rowWindow = null, fullAtlas = null;
    const extraTargets = [];
    try {
      if (!full) {
        for (const name of Object.keys(constructors)) maps[name] = new constructors[name](p, options);
        expandedTarget = maps.original.target.clone();
        extraTargets.push(expandedTarget);
        const rows = [0, 96, 192, 256, 384, 509];
        async function draw(name, row, twice = false) {
          const map = maps[name], query = gl.createQuery(), calls = r.info.render.calls;
          check(!map.ready && !map.disposed, 'A ready/disposed row-window map cannot be baked again');map.row = row;
          gl.beginQuery(ext.TIME_ELAPSED_EXT, query);const started = performance.now();
          const originalTarget=map.target,originalSamples=map.material.uniforms.uFootprintSamples.value;
          try {
            if(twice) {map.target=expandedTarget;map.material.uniforms.uFootprintSamples.value=128;}
            map.bakeSlice(r,2);
          } finally {
            map.target=originalTarget;map.material.uniforms.uFootprintSamples.value=originalSamples;
            gl.endQuery(ext.TIME_ELAPSED_EXT);
          }
          const submitMs = performance.now() - started, drawCalls = r.info.render.calls - calls;
          const timing = await completeQuery(query);
          check(drawCalls === 1, `Unexpected row draw count ${drawCalls}`);
          return { name, row, twice, separateTargets: twice, footprintSamples:twice?128:64, drawCalls, submitMs,
            completeMs: performance.now() - started, ...timing };
        }
        const cold = [], parity = [], warm = [], controls = [], controlReadbacks = [];
        const rowReferences = new Map();
        for (const name of Object.keys(maps)) cold.push(await draw(name, 0));
        for (const row of rows) {
          await draw('original', row);const reference = readTarget(maps.original.target, row, 2);rowReferences.set(row, reference);
          await draw('original', row);const repeat = delta(reference, readTarget(maps.original.target, row, 2));
          for (const name of ['parameters', 'amount', 'shared', 'wrong']) {
            await draw(name, row);const first = readTarget(maps[name].target, row, 2);await draw(name, row);
            parity.push({ row, name, delta: delta(reference, first), repeat: delta(first, readTarget(maps[name].target, row, 2)),
              originalRepeat: repeat, occupied: reference.optical.filter((value, i) => i % 4 < 2 && value > 0).length });
          }
        }
        // Allocate/upload the separate target outside the paired warm samples.
        const controlPrimer = await draw('original', 96, true);
        // Pair single/candidate/expanded within each latitude and alternate order.
        // Expanded doubles the serial footprint loop to 128; primary draws remain 64.
        for (const row of [96, 256, 384]) {
          for (let round = 0; round < 10; round++) {
            const order = round % 2 ? ['expanded', 'amount', 'shared', 'original'] : ['original', 'shared', 'amount', 'expanded'];
            for (const name of order) {
              const sample = { round, ...await draw(name === 'expanded' ? 'original' : name, row, name === 'expanded') };
              if (name === 'expanded') controls.push(sample);else warm.push(sample);
            }
          }
          const first=readTarget(expandedTarget,row,2);
          await draw('original',row,true);
          const second=readTarget(expandedTarget,row,2);
          controlReadbacks.push({row,separateTargets:true,repeat:delta(first,second),
            versus64:delta(rowReferences.get(row),first),nonfinite:first.nonfiniteHeights});
        }
        const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
        const costControls = [96, 256, 384].map(row => {
          const old = median(warm.filter(value => value.row === row && value.name === 'original').map(value => value.gpuMs));
          const candidate = median(warm.filter(value => value.row === row && value.name === 'amount').map(value => value.gpuMs));
          const shared = median(warm.filter(value => value.row === row && value.name === 'shared').map(value => value.gpuMs));
          const twice = median(controls.filter(value => value.row === row).map(value => value.gpuMs));
          return { row, originalMedianMs: old, sharedMedianMs:shared, amountMedianMs: candidate, amountVsSharedRatio:candidate/shared, expandedMedianMs: twice,
            expandedRatio: twice / old, amountRatio: candidate / old, positiveControlAccepted: twice / old >= 1.5 };
        });
        const positiveControlAccepted = costControls.every(value => value.positiveControlAccepted);
        rowWindow = { cold, parity, controlPrimer, warm, controls, controlReadbacks, costControls, positiveControlAccepted,
          scope: 'Six native formal-size row windows, plus three latitudes with ten paired alternating single/candidate/64/128-footprint serial loop control rounds. Not a complete atlas.',
          performanceScope: positiveControlAccepted
            ? 'Doubled serial footprint-cost controls detected at all sampled latitudes; local warm row evidence only.'
            : 'Serial footprint-cost positive control insufficient at one or more latitudes; these timer observations do not establish rigorous GPU cost reduction.' };
        show(maps.original.target);
      } else {
        async function inputDigest(hours) {
          const frame = p.weatherStream?.frames.get(hours), fields = frame
            ? Object.fromEntries(['low', 'high', 'bands', 'bounds'].map(name => [name, frame[name]]))
            : Object.fromEntries([['low', p.cloudShadowTex], ['high', p.cloudWeatherHiTex], ['bands', p.cloudSpeciesTex], ['bounds', p.cloudBoundsTex]]
              .map(([name, texture]) => [name, texture.image.data]));
          const hashes = {};
          for (const [name, view] of Object.entries(fields)) {
            const bytes = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
            hashes[name] = { bytes: bytes.byteLength, sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
              .map(value => value.toString(16).padStart(2, '0')).join('') };
          }
          return { kind: frame ? 'immutable actual forecast frame' : 'authored constructor published textures', hours,
            frameRevision: frame ? p.weatherStream.revisionAt(hours) : null, fields: hashes };
        }
        async function bakeComplete(name, hours) {
          const started = performance.now(), map = new constructors[name](p, { ...options, hours, programOwner: leases[name] });
          const constructedMs = performance.now() - started, batches = [];
          try {
            check(map.width === 1024 && map.height === 512 && map.samples === 128 && map.footprintSamples === 64,
              'Full atlas options must remain formal production values');
            while (!map.ready) {
              const row = map.row, ownedQuad = map.quad, draw = ownedQuad.render, calls = r.info.render.calls;
              let query = null, drawSubmitMs = 0;
              // Close the GPU interval before final-row releaseProgram/quad
              // cleanup. Completion is awaited even if bakeSlice clears quad.
              ownedQuad.render = function(...args) {
                check(query === null, 'One draw expected per two-row bake');query = gl.createQuery();
                gl.beginQuery(ext.TIME_ELAPSED_EXT, query);const submittedAt = performance.now();
                try { return draw.apply(this, args); }
                finally { drawSubmitMs = performance.now() - submittedAt;gl.endQuery(ext.TIME_ELAPSED_EXT); }
              };
              const submittedAt = performance.now();
              try { map.bakeSlice(r, 2); }
              finally { ownedQuad.render = draw; }
              const bakeSubmitMs = performance.now() - submittedAt, drawCalls = r.info.render.calls - calls;
              check(query !== null && drawCalls === 1 && map.row === row + 2, 'Full atlas must advance by exactly one two-row draw');
              batches.push({ row, rows: 2, drawCalls, drawSubmitMs, bakeSubmitMs, readyAfter: map.ready, ...await completeQuery(query) });
            }
            check(map.row === 512 && batches.length === 256, 'Incomplete atlas');
            const completeMs = performance.now() - started, native = readTarget(map.target, 0, 512);
            const metadata = await nativeMetadata(native);
            check(metadata.heights.nonfinite === 0 && metadata.heights.invalidAlpha === 0, 'Nonfinite/incomplete native full atlas');
            const summary = { name, hours, sampledFrameRevision: map.weatherSources?.frames[0]?.revision ?? null,
              constructedMs, completeMs, batches,
              gpuSumMs: batches.reduce((sum, value) => sum + value.gpuMs, 0),
              firstBatch: batches[0], gpuAfterFirstBatchMs: batches.slice(1).reduce((sum, value) => sum + value.gpuMs, 0),
              drawSubmitSumMs: batches.reduce((sum, value) => sum + value.drawSubmitMs, 0),
              bakeSubmitSumMs: batches.reduce((sum, value) => sum + value.bakeSubmitMs, 0),
              ready: map.ready, row: map.row, native: metadata,
              finalReleaseOutsideTimer: true, programLeaseRetained: Boolean(leases[name].columns) };
            if (name === 'amount') show(map.target);
            return { summary, native };
          } finally { map.dispose(); }
        }
        const cases = [], originalPartition = p.volCloudMat.uniforms.uSpeciesPartition.value;
        check(p.weatherHours === 0 && !p.weatherStream, 'Constructor case must precede any weather stream');
        async function runCase(name, hours, partition) {
          p.volCloudMat.uniforms.uSpeciesPartition.value = partition;p.volCloudMat.uniforms.uSpeciesMask.value = -1;
          const inputBefore = await inputDigest(hours);
          const old = await bakeComplete('original', hours), candidate = await bakeComplete('amount', hours);
          const oldRepeat = await bakeComplete('original', hours), candidateRepeat = await bakeComplete('amount', hours);
          const inputAfter = await inputDigest(hours);
          cases.push({ name, hours, partition, speciesMask: -1, inputBefore, inputAfter,
            atlas: [old.summary, candidate.summary, oldRepeat.summary, candidateRepeat.summary],
            delta: delta(old.native, candidate.native), originalRepeat: delta(old.native, oldRepeat.native),
            amountRepeat: delta(candidate.native, candidateRepeat.native), repeatDelta: delta(oldRepeat.native, candidateRepeat.native) });
        }
        check(originalPartition >= 0.5, 'Actual home must exercise production area partition');
        await runCase('authored-home-hour0-partition-on', 0, originalPartition);
        await runCase('authored-home-hour0-partition-off', 0, 0);
        p.volCloudMat.uniforms.uSpeciesPartition.value = originalPartition;
        p.setWeatherTime(0);const stream = p.weatherStream;
        check(stream && !stream.disposed, 'Actual forecast stream required');
        const forecastHour = stream.frameHours;p.setWeatherTime(forecastHour);
        const forecastStarted = performance.now(), deadline = forecastStarted + 120000;
        while (!(stream.ready && stream.frames.has(forecastHour) && stream.frames.has(forecastHour + stream.frameHours) && stream.pending.size === 0)) {
          check(p.weatherStream === stream && !stream.error && !stream.disposed && performance.now() < deadline,
            `Forecast unavailable: ${String(stream.error)}, pending ${[...stream.pending]}`);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        // Retain immutable worker frames but stop unrelated worker CPU activity
        // before GPU observations; this is a fixture lifetime, not runtime code.
        stream.worker.terminate();
        const forecastPreparationMs = performance.now() - forecastStarted;
        await runCase('actual-forecast-frame-partition-on', forecastHour, originalPartition);
        fullAtlas = { cases, forecast: { hours: forecastHour, frameHours: stream.frameHours,
          streamReady: stream.ready, framePresent: stream.frames.has(forecastHour),
          nextFramePresent: stream.frames.has(forecastHour + stream.frameHours), pending: stream.pending.size,
          preparationMs: forecastPreparationMs, workerStoppedBeforeMeasurements: true },
          scope: 'Three complete 1024x512 native dual-MRT cases, each rebuilt old/amount/old/amount with 256 sequential two-row production bakes. All species are enabled; this does not cover every weather/species combination.',
          timingScope: 'Per-batch GPU intervals enclose actual draws and end before final release. Sum includes each map first-use draw; completeMs includes JS query polling waits and construction. Neither is a steady full-map throughput acceptance.' };
      }
      const result = { mode: full ? 'full-atlas' : 'row-window',
        identity: { seed, systemId: star.id, bodyId: spec.bodyId, bodySeed: spec.seed, type: p.type, radius: p.R },
        options: { ...options, height: 512, batchRows: 2 }, rowWindow, fullAtlas, ...checkpoint('Final') };
      return result;
    } finally {
      quad.dispose();display.dispose();for(const target of extraTargets)target.dispose();for (const map of Object.values(maps)) map.dispose();
      for (const owner of Object.values(leases)) for (const material of Object.values(owner)) material.dispose();
      p.dispose();r.dispose();
    }
  }, { full });
  await page.screenshot({ path: `${out}/fixture.png` });
  const after = await evidenceFingerprint('tools/cloudcolumncostdiag.js');
  const referenceAfter = await readFile(new URL('./fixtures/cloud-column-cost-original.json', import.meta.url));
  await writeFile(`${out}/report.json`, JSON.stringify({ before, after, reference, referenceAfterSha256: sha256(referenceAfter), result, errors }, null, 2));
  assert.deepEqual(before, after);assert.deepEqual(referenceAfter, fixtureBytes);
  assert.deepEqual(verifyColumnShaderContract(),shaderContract);
  assert.deepEqual(errors, []);assert.equal(result.error, 0);assert.equal(result.lost, false);
  const zero = row => row.optical === 0 && row.heights === 0;
  if (result.rowWindow) {
    const rows = result.rowWindow;
    assert.ok(rows.parity.every(row => zero(row.repeat) && zero(row.originalRepeat)));
    assert.ok(rows.parity.filter(row => row.name !== 'wrong').every(row => zero(row.delta)));
    assert.ok(rows.parity.some(row => row.name === 'wrong' && !zero(row.delta)));
    assert.ok(rows.controlReadbacks.every(row => zero(row.repeat) && row.nonfinite===0));
    assert.ok(rows.controls.every(row => row.drawCalls === 1 && row.footprintSamples === 128 && row.separateTargets));
    assert.ok(rows.warm.every(row => row.drawCalls === 1));
  }
  if (result.fullAtlas) {
    assert.equal(result.fullAtlas.cases.length, 3);
    for (const row of result.fullAtlas.cases) {
      assert.deepEqual(row.inputBefore, row.inputAfter);assert.ok(zero(row.delta) && zero(row.originalRepeat) && zero(row.amountRepeat) && zero(row.repeatDelta));
      assert.ok(row.atlas.every(map => map.ready && map.row === 512 && map.batches.length === 256
        && map.native.heights.nonfinite === 0 && map.native.heights.invalidAlpha === 0
        && map.native.gl.error === 0 && !map.native.gl.lost && map.finalReleaseOutsideTimer && map.programLeaseRetained));
      assert.ok(row.atlas.every(map => map.native.optical.elements === 1024 * 512 * 4 && map.native.heights.elements === 1024 * 512 * 4));
      assert.ok(row.atlas[0].native.occupied > 0, 'Each complete-atlas case must exercise occupied optical output');
    }
    const forecast = result.fullAtlas.cases[2];assert.equal(forecast.inputBefore.kind, 'immutable actual forecast frame');
    assert.ok(forecast.hours > 0 && forecast.inputBefore.frameRevision !== null);
    assert.ok(forecast.atlas.every(map => map.sampledFrameRevision === forecast.inputBefore.frameRevision));
  }
  console.log(JSON.stringify({ out, mode: result.mode,
    rowWindow: result.rowWindow && { costControls: result.rowWindow.costControls, positiveControlAccepted: result.rowWindow.positiveControlAccepted,
      performanceScope: result.rowWindow.performanceScope },
    fullAtlas: result.fullAtlas && result.fullAtlas.cases.map(row => ({ name: row.name, delta: row.delta, originalRepeat: row.originalRepeat,
      amountRepeat: row.amountRepeat, repeatDelta: row.repeatDelta,
      timings: row.atlas.map(map => ({ name: map.name, firstBatch: map.firstBatch, gpuSumMs: map.gpuSumMs,
        gpuAfterFirstBatchMs: map.gpuAfterFirstBatchMs, completeMs: map.completeMs })) })) }));
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, reference, full, errors, error: String(error), stack: error.stack }, null, 2));throw error;
} finally { await browser?.close();await new Promise(resolve => server.close(resolve)); }
