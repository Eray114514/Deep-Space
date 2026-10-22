// Complete formal cloud-column atlases with uninterrupted draw submission.
// Default: separate whole-range and per-batch query experiments. --mode=unqueried
// uses only a final fence; --mode=all adds that measurement-perturbation control.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const options = { mode: 'both', rounds: 2, forecast: false, batchRows: [2, 8, 16, 32, 64, 128, 512], pollMs: 20, timeoutMs: 300000 };
for (const argument of process.argv.slice(2)) {
  if (argument === '--forecast') options.forecast = true;
  else if (argument.startsWith('--mode=')) options.mode = argument.slice(7);
  else if (argument.startsWith('--rounds=')) options.rounds = Number(argument.slice(9));
  else throw Error(`Unknown argument ${argument}`);
}
assert.ok(['whole', 'per-batch', 'both', 'unqueried', 'all'].includes(options.mode));
assert.ok(Number.isInteger(options.rounds) && options.rounds >= 2 && options.rounds <= 10, 'At least two rebuilt native repeats are required');
options.modes = options.mode === 'both' ? ['whole', 'per-batch'] : options.mode === 'all' ? ['whole', 'per-batch', 'unqueried'] : [options.mode];
const out = `test-results/cloud-column-batch/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const verifier = await readFile(new URL('./cloudcolumnbatchdiag.js', import.meta.url));
const fixtureBytes = await readFile(new URL('./fixtures/cloud-column-cost-original.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
assert.equal(fixture.sha256, '20c1943dce46665d0258225a82b9db0a5f40163f0b35c799b684c0076890b759');
assert.equal(sha256(fixture.source), fixture.sha256);assert.equal(Buffer.byteLength(fixture.source), fixture.bytes);
const installed = await readFile(new URL('../src/cloud/cloud-column-map.js', import.meta.url));
const call = 'speciesCondensate(frame,axis,altitude,band,parameters.x,parameters.y,parameters.z,int(shape.x),speciesStructureAt(species).x,productionAreaBand(uv,species))';
const point = '              for(int k=0;k<count;k++) {';
assert.equal(fixture.source.split(call).length - 1, 1);assert.equal(fixture.source.split(point).length - 1, 1);
const expected = fixture.source.replace("import * as THREE from 'three';", "import * as THREE from 'three';\nimport { productionColumnCondensateGLSL } from './production-shape.js';")
  .replace('${productionCloudGLSL}', '${productionCloudGLSL}${productionColumnCondensateGLSL}')
  .replace(point, '              vec2 columnRegion=productionAreaBand(uv,species);\n              float minimumDepth=speciesStructureAt(species).x;\n              float columnAmount=columnSpeciesAmount(frame,band,columnRegion);\n' + point)
  .replace(call, 'columnSpeciesCondensate(frame,axis,altitude,band,parameters.x,parameters.y,parameters.z,int(shape.x),minimumDepth,columnAmount)');
const gated=expected.replace('float columnAmount=columnSpeciesAmount(frame,band,columnRegion);',
  'float columnAmount=columnSpeciesAmount(frame,band,columnRegion);\n              if(columnAmount<=0.0)continue;');
const normalize=source=>source.replaceAll('\r\n','\n');
assert.ok([expected,gated].some(source=>normalize(source)===normalize(installed.toString('utf8'))),
  'Installed producer must equal the independently derived amount or empty-species variant');
const candidateKind=normalize(installed.toString('utf8'))===normalize(gated)?'skip-empty-species':'shared-column-amount';

const sources = { original: { fixture: 'tools/fixtures/cloud-column-cost-original.json', revision: fixture.revision,
  path: fixture.path, rawSha256: fixture.sha256, rawBytes: fixture.bytes, fixtureRawSha256: sha256(fixtureBytes) },
  installed: { path: 'src/cloud/cloud-column-map.js', rawSha256: sha256(installed), rawBytes: installed.length, candidateKind, matchesDerivedCandidate: true } };
await writeFile(`${out}/verifier.js`, verifier);await writeFile(`${out}/original-fixture.json`, fixtureBytes);
await writeFile(`${out}/original-source.js`, fixture.source);await writeFile(`${out}/installed-source.js`, installed);
const before = await evidenceFingerprint('tools/cloudcolumnbatchdiag.js');
const { server, port } = await startServer(0);let browser, browserInfo;
const errors = [], driverWarnings = [];let droppedWarnings = 0;
try {
  const executablePath = resolveSystemChromePath() || undefined;
  browser = await launchHardwareBrowser({ executablePath });
  const browserSession = await browser.newBrowserCDPSession();
  browserInfo = { executablePath, playwrightVersion: browser.version(),
    version: await browserSession.send('Browser.getVersion'),
    system: await browserSession.send('SystemInfo.getInfo').catch(error => ({ error: String(error) })) };
  const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    const text = message.text();if (message.type() === 'error') errors.push(text);
    if (/GL_INVALID|GL_OUT_OF_MEMORY|Program object expected|CONTEXT_LOST_WEBGL/i.test(text)) {
      if (driverWarnings.length < 200) driverWarnings.push(text.slice(0, 2000));else droppedWarnings++;
    }
  });
  await page.route('**/column-batch.html*', route => route.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script><canvas id="fixture"></canvas>' }));
  await page.route('**/src/cloud/batch-original.js', route => route.fulfill({ contentType: 'text/javascript', body: fixture.source }));
  await page.goto(`http://127.0.0.1:${port}/column-batch.html?vclouds=1`);
  const result = await page.evaluate(async options => {
    const T = await import('three'), { Planet } = await import('/src/planet.js');
    const { GalaxyCatalog, HOME_SYSTEM_ID } = await import('/src/galaxy-layout.js');
    const { generateSystemSpec } = await import('/src/astronomy.js');
    const { ACTIVE_GALAXY_ID, getGalaxyConfig, resolveBodyTuning, applySystemBodyTuning } = await import('/src/world-config.js');
    const { createGameRenderer } = await import('/src/renderer-runtime.js');
    const constructors = { original: (await import('/src/cloud/batch-original.js')).CloudColumnMap,
      installed: (await import('/src/cloud/cloud-column-map.js')).CloudColumnMap };
    const check = (condition, message) => { if (!condition) throw Error(message); };
    const sleep = () => new Promise(resolve => setTimeout(resolve, options.pollMs));
    const seed = getGalaxyConfig(ACTIVE_GALAXY_ID).seed, star = new GalaxyCatalog(seed).getSystem(HOME_SYSTEM_ID);
    const spec = applySystemBodyTuning(generateSystemSpec(seed, star), id => resolveBodyTuning(ACTIVE_GALAXY_ID, star.id, id)).bodies[0];
    const p = new Planet({ seed: spec.seed, name: spec.name, catalogName: spec.catalogName, posUniv: new T.Vector3(),
      type: spec.type, isMoon: spec.isMoon, radius: spec.radius, atmosphere: spec.atmosphere, clouds: spec.clouds,
      tuning: resolveBodyTuning(ACTIVE_GALAXY_ID, star.id, spec.bodyId), formation: spec.formation, ringSystem: spec.ringSystem });
    const { renderer: r } = await createGameRenderer({}, { canvas: document.querySelector('#fixture') });
    r.setSize(900, 450);r.info.autoReset = false;
    const gl = r.getContext(), canvas = r.domElement, contextEvents = [];
    canvas.addEventListener('webglcontextlost', () => contextEvents.push({ type: 'lost', at: performance.now() }));
    canvas.addEventListener('webglcontextrestored', () => contextEvents.push({ type: 'restored', at: performance.now() }));
    const ext = options.modes.some(mode => mode !== 'unqueried') ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
    check(ext || options.modes.every(mode => mode === 'unqueried'), 'Hardware timer extension required for queried modes');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION),
      shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION), unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null, timerExtensionUsed: Boolean(ext),
      dpr: r.getPixelRatio(), performanceTimeOrigin: performance.timeOrigin };
    check(!/swiftshader|llvmpipe|software rasterizer/i.test(gpu.unmaskedRenderer || gpu.renderer), 'Hardware adapter required');
    const checkpoint = label => {
      const error = gl.getError(), lost = gl.isContextLost();
      check(error === 0 && !lost && contextEvents.length === 0, `${label}: GL ${error}, lost ${lost}, events ${contextEvents.length}`);
      return { error, lost };
    };
    checkpoint('Initial');
    const format = { width: 1024, height: 512, samples: 128, footprintSamples: 64 };
    const leases = { original: {}, installed: {} }, programIds = {}, cases = [];
    const distribution = values => {
      const sorted = [...values].sort((a, b) => a - b);
      const quantile = fraction => {
        const x = (sorted.length - 1) * fraction, low = Math.floor(x), high = Math.ceil(x);
        return sorted[low] + (sorted[high] - sorted[low]) * (x - low);
      };
      return sorted.length ? { count: sorted.length, min: sorted[0], median: quantile(0.5), p95: quantile(0.95), max: sorted.at(-1) } : null;
    };
    const digest = async view => [...new Uint8Array(await crypto.subtle.digest('SHA-256', view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    async function inputState(hours) {
      const stream = p.weatherStream, frame = stream?.frames.get(hours);
      const data = frame ? Object.fromEntries(['low', 'high', 'bands', 'bounds'].map(name => [name, frame[name]]))
        : Object.fromEntries([['low', p.cloudShadowTex], ['high', p.cloudWeatherHiTex], ['bands', p.cloudSpeciesTex], ['bounds', p.cloudBoundsTex]]
          .map(([name, texture]) => [name, texture.image.data]));
      const fields = {};
      for (const [name, view] of Object.entries(data)) fields[name] = { bytes: view.byteLength, sha256: await digest(view) };
      return { hours, kind: frame ? 'immutable actual forecast frame' : 'authored constructor published textures',
        frameRevision: frame ? stream.revisionAt(hours) : null, partition: p.volCloudMat.uniforms.uSpeciesPartition.value,
        speciesMask: p.volCloudMat.uniforms.uSpeciesMask.value, fields };
    }
    function readNative(target) {
      const optical = new Uint8Array(1024 * 512 * 4), heights = new Uint16Array(1024 * 512 * 4);
      const old = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel(), started = performance.now();
      try {
        r.setRenderTarget(target);r.readRenderTargetPixels(target, 0, 0, 1024, 512, optical);
        r.readRenderTargetPixels(target, 0, 0, 1024, 512, heights, undefined, 1);
      } finally { r.setRenderTarget(old, face, mip); }
      const readMs = performance.now() - started, state = checkpoint('Native readback');
      let nonfinite = 0, invalidAlpha = 0, occupied = 0;
      for (let i = 0; i < heights.length; i++) if ((heights[i] & 0x7c00) === 0x7c00) nonfinite++;
      for (let i = 3; i < heights.length; i += 4) if (heights[i] !== 0x3c00) invalidAlpha++;
      for (let i = 0; i < optical.length; i += 4) if (optical[i] || optical[i + 1]) occupied++;
      check(nonfinite === 0 && invalidAlpha === 0 && occupied > 0, `Invalid/empty atlas: nonfinite ${nonfinite}, alpha ${invalidAlpha}, occupied ${occupied}`);
      return { optical, heights, readMs, nonfinite, invalidAlpha, occupied, gl: state };
    }
    const compare = (left, right) => Object.fromEntries(['optical', 'heights'].map(name => {
      check(left[name].length === right[name].length, 'Native dimensions differ');
      let mismatch = 0;for (let i = 0; i < left[name].length; i++) if (left[name][i] !== right[name][i]) mismatch++;
      return [name, mismatch];
    }));
    const isZero = delta => delta.optical === 0 && delta.heights === 0;
    async function nativeSummary(data) {
      return { optical: { encoding: 'RGBA8 native Uint8', elements: data.optical.length, bytes: data.optical.byteLength, sha256: await digest(data.optical) },
        heights: { encoding: 'RGBA16F native Uint16 bits', elements: data.heights.length, bytes: data.heights.byteLength,
          sha256: await digest(data.heights), nonfinite: data.nonfinite, invalidAlpha: data.invalidAlpha },
        occupied: data.occupied, readMs: data.readMs, gl: data.gl };
    }
    async function collectAfterEnqueue(sync, queries, origin, enqueueEnd) {
      const deadline = enqueueEnd + options.timeoutMs;
      let fenceObservedAt = null, fencePolls = 0, availabilityRounds = 0;
      while (fenceObservedAt === null) {
        check(!gl.isContextLost() && contextEvents.length === 0 && performance.now() < deadline, 'Atlas fence unavailable/context lost');
        const status = gl.clientWaitSync(sync, 0, 0);fencePolls++;
        check(status !== gl.WAIT_FAILED, 'Atlas fence wait failed');
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) fenceObservedAt = performance.now();
        else await sleep();
      }
      // Observe all pending results in each round, only AFTER the fence. This
      // avoids polling 256 timer queries while the atlas is still executing.
      let available = 0;
      while (available < queries.length) {
        check(!gl.isContextLost() && contextEvents.length === 0 && performance.now() < deadline, 'Atlas query availability deadline');
        availabilityRounds++;
        for (const entry of queries) if (entry.observedAt === null && gl.getQueryParameter(entry.query, gl.QUERY_RESULT_AVAILABLE)) {
          entry.observedAt = performance.now();entry.elapsedMs = gl.getQueryParameter(entry.query, gl.QUERY_RESULT) / 1e6;
          check(Number.isFinite(entry.elapsedMs) && entry.elapsedMs >= 0, 'Invalid timer range');available++;
        }
        if (available < queries.length) await sleep();
      }
      const allAvailableAt = queries.length ? performance.now() : null;
      const disjoint = ext ? gl.getParameter(ext.GPU_DISJOINT_EXT) : null;
      check(!disjoint, 'Disjoint invalidates the entire atlas measurement');
      return { fencePolls, availabilityRounds, fenceAfterEnqueueMs: fenceObservedAt - enqueueEnd,
        fenceFromFirstDrawMs: fenceObservedAt - origin,
        availabilityAfterEnqueueMs: allAvailableAt === null ? null : allAvailableAt - enqueueEnd,
        availabilityFromFirstDrawMs: allAvailableAt === null ? null : allAvailableAt - origin,
        queryAvailabilityPolledAfterFenceOnly: true, disjoint };
    }
    async function measureMap(kernel, batchRows, queryMode, phase, round, hours, displayResult = false) {
      const started = performance.now(), owner = leases[kernel];
      const programWarm = Boolean(owner.columns && programIds[kernel] !== undefined);
      const map = new constructors[kernel](p, { width: 1024, samples: 128, footprintSamples: 64, hours, programOwner: owner });
      const constructedMs = performance.now() - started, material = map.material, ownedQuad = map.quad, draw = ownedQuad.render;
      const queries = [], batches = [], calls = r.info.render.calls;
      let activeQuery = false, sync = null, firstDrawAt = null, lastDrawEndedAt = null, selectedProgramId = null;
      const begin = row => {
        const entry = { query: gl.createQuery(), row, rows: queryMode === 'whole' ? 512 : batchRows, observedAt: null, elapsedMs: null };
        check(entry.query, 'Unable to allocate timer query');queries.push(entry);
        gl.beginQuery(ext.TIME_ELAPSED_EXT, entry.query);activeQuery = true;
      };
      const end = () => { gl.endQuery(ext.TIME_ELAPSED_EXT);activeQuery = false; };
      try {
        check(map.width === 1024 && map.height === 512 && map.samples === 128 && map.footprintSamples === 64, 'Formal production options changed');
        if (ext) check(!gl.getParameter(ext.GPU_DISJOINT_EXT), 'Disjoint before atlas submission');
        ownedQuad.render = function(...args) {
          const row = map.row, final = row + batchRows >= 512;
          if (firstDrawAt === null) firstDrawAt = performance.now();
          if (queryMode === 'per-batch' || (queryMode === 'whole' && row === 0)) begin(row);
          try { return draw.apply(this, args); }
          finally {
            if (queryMode === 'per-batch' || (queryMode === 'whole' && final)) end();
            if (final) {
              lastDrawEndedAt = performance.now();
              // Cached JS renderer state only; no new GL program query.
              selectedProgramId = r.properties.get(material).currentProgram?.id ?? null;
            }
          }
        };
        const enqueueStarted = performance.now();
        // Deliberately synchronous: no query/fence/readback awaits between draws.
        while (!map.ready) {
          const row = map.row, submittedAt = performance.now();map.bakeSlice(r, batchRows);
          batches.push({ row, rows: batchRows, submitMs: performance.now() - submittedAt });
          check(map.row === row + batchRows && map.row <= 512, 'Unexpected atlas progression');
        }
        const enqueueEnd = performance.now(), enqueueMs = enqueueEnd - enqueueStarted;
        check(!activeQuery && map.row === 512 && batches.length === 512 / batchRows, 'Unclosed range or incomplete atlas');
        check(r.info.render.calls - calls === batches.length, 'Each batch must issue exactly one draw');
        check(queries.length === (queryMode === 'whole' ? 1 : queryMode === 'per-batch' ? batches.length : 0), 'Query modes must remain separate');
        // The final bake has released its temporary material/geometry. The GPU
        // range has already ended; the fence also covers that cleanup tail.
        sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);check(sync, 'Fence allocation failed');
        const flushStarted = performance.now();gl.flush();const flushMs = performance.now() - flushStarted;
        const completion = await collectAfterEnqueue(sync, queries, firstDrawAt, enqueueEnd);
        completion.fenceFromEnqueueStartMs = enqueueMs + completion.fenceAfterEnqueueMs;
        completion.availabilityFromEnqueueStartMs = completion.availabilityAfterEnqueueMs === null
          ? null : enqueueMs + completion.availabilityAfterEnqueueMs;
        check(map.ready && owner.columns && selectedProgramId !== null, 'Completed producer must retain its program lease');
        if (programIds[kernel] !== undefined) check(selectedProgramId === programIds[kernel], 'Batching unexpectedly selected a different program');
        programIds[kernel] = selectedProgramId;
        const native = readNative(map.target), metadata = await nativeSummary(native);
        const ranges = queries.map(entry => ({ row: entry.row, rows: entry.rows, elapsedMs: entry.elapsedMs,
          availabilityObservedAfterFirstDrawMs: entry.observedAt - firstDrawAt }));
        const record = { kernel, batchRows, queryMode, phase, round, hours, programWarm, programId: selectedProgramId,
          constructedMs, enqueueMs, flushMs, firstDrawOffsetMs: firstDrawAt - enqueueStarted,
          cpuRangeSubmissionMs: lastDrawEndedAt - firstDrawAt, postRangeEnqueueTailMs: enqueueEnd - lastDrawEndedAt,
          continuousEnqueue: true, drawCalls: batches.length, ready: map.ready, row: map.row,
          finalReleaseOutsideGpuRange: true, programLeaseRetained: true, queryCount: queries.length,
          gpuRangeMs: queryMode === 'whole' ? ranges[0].elapsedMs : null,
          perBatchElapsedDistribution: queryMode === 'per-batch' ? distribution(ranges.map(entry => entry.elapsedMs)) : null,
          batchCpuSubmissionDistribution: distribution(batches.map(entry => entry.submitMs)),
          ranges, batches, completion, native: metadata, sampledFrameRevision: map.weatherSources?.frames[0]?.revision ?? null };
        if (displayResult) await showAtlas(map.target);
        return { record, native };
      } finally {
        ownedQuad.render = draw;if (activeQuery) end();
        if (sync) gl.deleteSync(sync);for (const entry of queries) gl.deleteQuery(entry.query);map.dispose();
      }
    }
    const { OwnedScreenTriangle } = await import('/src/owned-screen-triangle.js');
    const displayMaterial = new T.ShaderMaterial({ uniforms: { tMap: { value: null } },
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0,1);}',
      fragmentShader: 'uniform sampler2D tMap;varying vec2 vUv;void main(){gl_FragColor=vec4(texture2D(tMap,vUv).xy,0,1);}',
      depthTest: false, depthWrite: false });
    const displayQuad = new OwnedScreenTriangle(displayMaterial);
    async function showAtlas(target) {
      displayMaterial.uniforms.tMap.value = target.textures[0];r.setRenderTarget(null);displayQuad.render(r);
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);check(sync, 'Display fence allocation failed');gl.flush();
      try { await collectAfterEnqueue(sync, [], performance.now(), performance.now()); }
      finally { gl.deleteSync(sync); }
    }
    async function runCase(name, hours) {
      const inputBefore = await inputState(hours), baseline = [], samples = [], previous = new Map();
      const old = await measureMap('original', 2, options.modes[0], 'first-measured-reference', -1, hours);
      old.record.deltaReference = compare(old.native, old.native);baseline.push(old.record);
      const initial = await measureMap('installed', 2, options.modes[0], 'first-measured-candidate', -1, hours);
      initial.record.deltaReference = compare(old.native, initial.native);baseline.push(initial.record);
      check(isZero(initial.record.deltaReference), 'Initial candidate differs from complete rows2 reference');
      for (let round = 0; round < options.rounds; round++) {
        const rows = round % 2 ? [...options.batchRows].reverse() : options.batchRows;
        const modes = round % 2 ? [...options.modes].reverse() : options.modes;
        for (const mode of modes) for (const batchRows of rows) {
          const kernels = round % 2 ? ['installed', 'original'] : ['original', 'installed'];
          for (const kernel of kernels) {
            const last = round === options.rounds - 1 && mode === modes.at(-1) && batchRows === rows.at(-1) && kernel === kernels.at(-1);
            const measured = await measureMap(kernel, batchRows, mode, 'warm-program-fresh-atlas', round, hours, last);
            const key = `${mode}:${kernel}:${batchRows}`, prior = previous.get(key);
            measured.record.deltaReference = compare(old.native, measured.native);
            measured.record.nativeRepeat = prior ? compare(prior, measured.native) : null;
            check(isZero(measured.record.deltaReference) && (!prior || isZero(measured.record.nativeRepeat)), 'Full native atlas or rebuilt repeat differs');
            if (round === options.rounds - 1) previous.delete(key);else previous.set(key, measured.native);
            samples.push(measured.record);
          }
        }
      }
      const inputAfter = await inputState(hours);
      check(JSON.stringify(inputBefore) === JSON.stringify(inputAfter), 'Weather inputs changed during batching measurements');
      if (inputBefore.frameRevision !== null)
        check([...baseline, ...samples].every(sample => sample.sampledFrameRevision === inputBefore.frameRevision), 'Forecast producer sampled a different frame');
      const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;
      const pairs = samples.filter(sample => sample.kernel === 'installed').map(candidate => {
        const original = samples.find(sample => sample.kernel === 'original' && sample.round === candidate.round
          && sample.queryMode === candidate.queryMode && sample.batchRows === candidate.batchRows);
        const rows2 = samples.find(sample => sample.kernel === 'installed' && sample.round === candidate.round
          && sample.queryMode === candidate.queryMode && sample.batchRows === 2);
        return { round: candidate.round, queryMode: candidate.queryMode, batchRows: candidate.batchRows,
          installedToOriginalGpuRangeRatio: candidate.queryMode === 'whole' ? ratio(candidate.gpuRangeMs, original.gpuRangeMs) : null,
          installedToRows2GpuRangeRatio: candidate.queryMode === 'whole' ? ratio(candidate.gpuRangeMs, rows2.gpuRangeMs) : null,
          installedToOriginalFenceWallRatio: ratio(candidate.completion.fenceFromEnqueueStartMs, original.completion.fenceFromEnqueueStartMs),
          installedToRows2FenceWallRatio: ratio(candidate.completion.fenceFromEnqueueStartMs, rows2.completion.fenceFromEnqueueStartMs) };
      });
      cases.push({ name, hours, inputBefore, inputAfter, baseline, samples, pairs,
        reference: { kernel: 'original', batchRows: 2, native: old.record.native },
        retainedComparisonBytesAtMost: (options.modes.length * 2 * options.batchRows.length + 3) * (1024 * 512 * 12),
        coldScope: 'First measured map of each kernel in this page; programWarm distinguishes retained programs. This is not a guarantee of an empty driver disk cache.',
        warmScope: 'Each sample rebuilds the actual map and input snapshots; only the shader program is retained. Orders reverse across rounds. Two rounds are descriptive paired observations, not a stable percentile or significance claim.' });
    }
    try {
      check(p.weatherHours === 0 && !p.weatherStream, 'Authored constructor case must precede forecast creation');
      check(p.volCloudMat.uniforms.uSpeciesPartition.value >= 0.5, 'Actual home production partition required');
      p.volCloudMat.uniforms.uSpeciesMask.value = -1;
      await runCase('actual-home-constructor-hour0', 0);
      let forecast = null;
      if (options.forecast) {
        const started = performance.now();p.setWeatherTime(0);const stream = p.weatherStream;
        check(stream && !stream.disposed, 'Actual forecast stream required');const hours = stream.frameHours;p.setWeatherTime(hours);
        const deadline = performance.now() + options.timeoutMs;
        while (!(stream.ready && stream.frames.has(hours) && stream.frames.has(hours + stream.frameHours) && stream.pending.size === 0)) {
          check(p.weatherStream === stream && !stream.error && !stream.disposed && performance.now() < deadline, `Forecast unavailable: ${String(stream.error)}`);await sleep();
        }
        stream.worker.terminate();forecast = { hours, frameHours: stream.frameHours, preparationMs: performance.now() - started,
          pending: stream.pending.size, ready: stream.ready, workerStoppedBeforeMeasurements: true };
        await runCase('actual-immutable-forecast-frame', hours);
      }
      return { gpu, identity: { seed, systemId: star.id, bodyId: spec.bodyId, bodySeed: spec.seed, type: p.type, radius: p.R },
        format, options, cases, forecast, contextEvents, final: checkpoint('Final'), programIds,
        scope: 'Complete formal cloud-column atlas batching and submission fixture; the screenshot displays an atlas, not the player or whole-page performance.',
        timingScope: { whole: 'One non-nested elapsed range from immediately before the first quad draw to immediately after the last. Includes submission gaps and intervening producer state changes, excludes first RT initialization and final cleanup.',
          perBatch: 'Non-overlapping per-draw elapsed ranges, submitted without awaits and collected only after the entire atlas fence. Distribution is not summed busy time or throughput; query overhead varies with batch count.',
          unqueried: 'No diagnostic timer query. Continuous enqueue and final fence observation wall only; never labelled GPU time.',
          fence: 'fenceSync after final bake/cleanup, then flush; clientWaitSync(sync,0,0) polled asynchronously. Wall includes queueing, polling granularity and cleanup tail.',
          availability: 'All timer query availability is observed in common rounds only after the fence. These observation times are not per-batch completion timestamps.',
          polling: { intervalMs: options.pollMs, timeoutMs: options.timeoutMs },
          ranking: 'Use whole-range and unqueried wall observations for batching throughput. Per-batch counters provide a separate, potentially intrusive distribution only.' } };
    } finally {
      displayQuad.dispose();displayMaterial.dispose();
      for (const owner of Object.values(leases)) for (const material of Object.values(owner)) material.dispose();p.dispose();r.dispose();
    }
  }, options);
  await page.screenshot({ path: `${out}/atlas.png` });
  const after = await evidenceFingerprint('tools/cloudcolumnbatchdiag.js');
  const installedAfter = await readFile(new URL('../src/cloud/cloud-column-map.js', import.meta.url));
  const fixtureAfter = await readFile(new URL('./fixtures/cloud-column-cost-original.json', import.meta.url));
  const summary = result.cases.map(row => ({ name: row.name, baselineMaps: row.baseline.length, warmMaps: row.samples.length,
    modes: options.modes.map(mode => ({ mode, samples: row.samples.filter(sample => sample.queryMode === mode).length,
      installed: options.batchRows.map(batchRows => ({ batchRows,
        observations: row.samples.filter(sample => sample.kernel === 'installed' && sample.queryMode === mode && sample.batchRows === batchRows)
          .map(sample => ({ round: sample.round, enqueueMs: sample.enqueueMs, gpuRangeMs: sample.gpuRangeMs,
            fenceFromFirstDrawMs: sample.completion.fenceFromFirstDrawMs })) })) })) }));
  await writeFile(`${out}/report.json`, JSON.stringify({ before, after, options, sources,
    installedAfterRawSha256: sha256(installedAfter), fixtureAfterRawSha256: sha256(fixtureAfter), browserInfo,
    result, summary, errors, driverWarnings, droppedWarnings }, null, 2));
  assert.deepEqual(before, after);assert.deepEqual(installedAfter, installed);assert.deepEqual(fixtureAfter, fixtureBytes);
  assert.deepEqual(errors, []);assert.deepEqual(driverWarnings, []);assert.equal(droppedWarnings, 0);
  assert.deepEqual(result.contextEvents, []);assert.equal(result.final.error, 0);assert.equal(result.final.lost, false);
  const zero = value => value.optical === 0 && value.heights === 0;
  for (const row of result.cases) {
    assert.deepEqual(row.inputBefore, row.inputAfter);assert.ok(row.baseline.every(sample => zero(sample.deltaReference)));
    assert.equal(row.samples.length, options.modes.length * options.batchRows.length * 2 * options.rounds);
    assert.ok(row.samples.every(sample => sample.programWarm && sample.continuousEnqueue && sample.ready && sample.row === 512
      && sample.drawCalls === 512 / sample.batchRows && zero(sample.deltaReference) && (!sample.nativeRepeat || zero(sample.nativeRepeat))));
    assert.equal(row.samples.filter(sample => sample.nativeRepeat).length, options.modes.length * options.batchRows.length * 2 * (options.rounds - 1));
    for (const sample of [...row.baseline, ...row.samples]) {
      assert.equal(sample.native.optical.elements, 1024 * 512 * 4);assert.equal(sample.native.heights.elements, 1024 * 512 * 4);
      assert.equal(sample.native.heights.nonfinite, 0);assert.equal(sample.native.heights.invalidAlpha, 0);assert.ok(sample.native.occupied > 0);
      assert.equal(sample.native.gl.error, 0);assert.equal(sample.native.gl.lost, false);assert.equal(sample.completion.disjoint, options.mode === 'unqueried' ? null : false);
      assert.equal(sample.queryCount, sample.queryMode === 'whole' ? 1 : sample.queryMode === 'per-batch' ? sample.drawCalls : 0);
      if (sample.queryMode !== 'whole') assert.equal(sample.gpuRangeMs, null);
    }
  }
  console.log(JSON.stringify({ out, modes: options.modes, cases: result.cases.map(row => ({ name: row.name, warmMaps: row.samples.length })),
    nativeAccepted: true, sourceDigest: before.sourceDigest, scope: 'Full native/repeat accepted; timings are observations, not a production batching change or player performance acceptance.' }));
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, sources, options, browserInfo, errors, driverWarnings, droppedWarnings,
    error: String(error), stack: error.stack }, null, 2));throw error;
} finally { await browser?.close();await new Promise(resolve => server.close(resolve)); }
