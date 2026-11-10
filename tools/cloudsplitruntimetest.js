import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { installFoundationGLProbe } from './foundation-gl-probe.js';

const stagedNearFrame = process.argv.includes('--staged-near-frame');
const verifiers = ['tools/cloudsplitruntimetest.js'];
if (stagedNearFrame) verifiers.push('tools/staged-near-frame.js');
const before = await evidenceFingerprint(...verifiers);
const audit = process.argv.includes('--gl-audit');
const auditRestore = process.argv.includes('--audit-restore');
const forceRecovery = process.argv.includes('--force-recovery');
const farStageTiming = process.argv.includes('--far-stage-timing');
const farLightSupport = process.argv.includes('--far-light-support');
const farLightTile = process.argv.includes('--far-light-tile');
const farLightRepresentation = process.argv.includes('--far-light-representation');
const farLightEncoded = process.argv.includes('--far-light-encoded');
const farLightGate = process.argv.includes('--far-light-gate');
assert.ok(!farLightGate||farLightTile&&!farLightEncoded,'--far-light-gate requires a depth tile');
assert.ok(!farLightEncoded||farLightRepresentation,'--far-light-encoded requires --far-light-representation');
assert.ok(!farLightRepresentation||farLightTile,'--far-light-representation requires --far-light-tile');
const spacingArg = process.argv.find(arg=>arg.startsWith('--far-light-spacing='));
const farLightSpacing = spacingArg ? Number(spacingArg.split('=')[1]) : 200;
assert.ok(!spacingArg || farLightTile && [100,200].includes(farLightSpacing),
  '--far-light-spacing accepts 100 or 200 with --far-light-tile');
const comparePoint = process.argv.includes('--compare-point');
const pointReuse = process.argv.includes('--point-reuse');
const pointReusePaths = process.argv.includes('--point-reuse-paths');
assert.ok(!pointReusePaths || pointReuse,'--point-reuse-paths requires --point-reuse');
const splitMoments = process.argv.includes('--point-moments');
const splitBeams = process.argv.includes('--point-beams');
const emptyBounds = process.argv.includes('--point-empty-bounds');
const nativeCounts = process.argv.includes('--point-native-counts');
const solarTail = process.argv.includes('--point-solar-tail');
const radial = process.argv.includes('--point-radial');
const radialEdge = process.argv.includes('--point-radial-edge');
const advection = process.argv.includes('--point-advection');
const pointModes = [splitMoments,splitBeams,emptyBounds,nativeCounts,solarTail,radial,radialEdge,advection].filter(Boolean).length;
assert.ok(!pointModes || comparePoint && pointModes===1,
  'Select one point diagnostic mode with --compare-point');
const requireMixed = process.argv.includes('--require-mixed');
const fixedWeather = process.argv.includes('--fixed-weather');
assert.ok(!farLightTile || fixedWeather,'--far-light-tile requires --fixed-weather');
const supplyOption = process.argv.find(arg => arg.startsWith('--supply-rows='));
const supplyRows = supplyOption ? Number(supplyOption.split('=')[1]) : null;
assert.ok(supplyRows === null || supplyRows === 0, 'Supply observation uses the runtime batch. Pass --supply-rows=0.');
const runDescent = process.argv.includes('--descent');
const nearBatchesFused=process.argv.includes('--near-batches-fused');
const nearBatches=nearBatchesFused||process.argv.includes('--near-batches');
const fusedBatchTilesArg=process.argv.find(arg=>arg.startsWith('--fused-batch-tiles='));
const fusedBatchTiles=fusedBatchTilesArg?Number(fusedBatchTilesArg.split('=')[1]):192;
assert.ok(!fusedBatchTilesArg||nearBatchesFused&&Number.isSafeInteger(fusedBatchTiles)&&fusedBatchTiles>0,
  'A fused tile cap requires --near-batches-fused and a positive integer');
const stagedMode=process.argv.find(arg=>arg.startsWith('--staged-near-mode='))?.split('=')[1]??'scissor';
const stagedFreezeDepth=process.argv.includes('--staged-near-freeze-depth');
const stagedPrimeBatch=process.argv.includes('--staged-near-prime-batch');
const stagedMicroBatch=process.argv.includes('--staged-near-micro-batch');
const stagedSplitMicroBatch=process.argv.includes('--staged-near-split-micro-batch');
const stagedFusedDensity=process.argv.includes('--staged-near-fused-density');
const stagedBandedReference=process.argv.includes('--staged-near-banded-reference');
const stagedSplitReference=process.argv.includes('--staged-near-split-reference');
assert.ok(!stagedNearFrame||!runDescent,'Staged near frame uses a single frozen pose');
assert.ok(['scissor','fragment','batch'].includes(stagedMode),'Unknown staged near mode');
assert.ok(!(stagedPrimeBatch||stagedMicroBatch||stagedSplitMicroBatch)||stagedNearFrame&&stagedMode==='batch','First-use proof requires a staged batch');
assert.ok(!(stagedMicroBatch&&stagedSplitMicroBatch),'Choose one micro batch submission mode');
assert.ok(!stagedFusedDensity||stagedNearFrame&&stagedMode==='batch','Fused density requires a staged batch');
assert.ok(!stagedBandedReference||stagedNearFrame&&stagedMode==='batch','Banded reference requires a staged batch');
assert.ok(!stagedSplitReference||stagedFusedDensity&&!stagedBandedReference,'Split reference requires fused density');
const dayDescent = process.argv.includes('--day-descent');
const pacedDescent = process.argv.includes('--paced-descent');
const nearTiles = process.argv.includes('--near-tiles');
const nearScaleCap = process.argv.includes('--near-scale-cap');
const nearBinsArg = process.argv.find(arg=>arg.startsWith('--near-bins='));
const nearBins = nearBinsArg ? Number(nearBinsArg.split('=')[1]) : 16;
const compareNearBins = process.argv.includes('--compare-near-bins');
const compareNearPaths = process.argv.includes('--compare-near-paths');
const compareNearResidual = process.argv.includes('--compare-near-residual');
const compareNearTraversal = process.argv.includes('--compare-near-traversal');
const replayOption = process.argv.find(arg=>arg.startsWith('--compare-near-replay='));
const nearReplay = replayOption ? replayOption.split('=')[1] : null;
assert.ok(!replayOption||['prefix','blocks'].includes(nearReplay),'Choose prefix or blocks for near replay');
const nearEmptyRuns = process.argv.includes('--compare-near-empty-runs=r16')?'r16'
  :process.argv.includes('--compare-near-empty-runs')?'rg16':null;
const nearTraversalCache = process.argv.includes('--near-traversal-cache');
const nearCachePair = process.argv.includes('--near-cache-pair');
const nearCacheSupport = process.argv.includes('--near-cache-support');
const nearCoverageOption=process.argv.find(arg=>arg.startsWith('--near-cache-coverage='));
const nearCoverageAt=nearCoverageOption?Number(nearCoverageOption.split('=')[1]):null;
const nearCachePlacement=process.argv.includes('--near-cache-placement');
const nearNativePlacement=process.argv.includes('--near-cache-native-placement');
const nearPlacementOptics=process.argv.includes('--near-cache-placement-optics');
const nearPlacementR16=process.argv.includes('--near-cache-placement-r16');
assert.ok(!nearCoverageOption||nearCacheSupport&&Number.isFinite(nearCoverageAt)&&nearCoverageAt>=1500&&nearCoverageAt<=200000,
  '--near-cache-coverage requires --near-cache-support and a probe altitude from 1500 to 200000 metres');
assert.ok(!nearCachePlacement||nearCoverageAt!==null&&nearCoverageAt<=20000,
  '--near-cache-placement requires a near cache coverage probe at or below 20000 metres');
assert.ok(!nearNativePlacement||nearCachePlacement,'--near-cache-native-placement requires --near-cache-placement');
assert.ok(!nearPlacementOptics||nearNativePlacement,'--near-cache-placement-optics requires --near-cache-native-placement');
assert.ok(!nearPlacementR16||nearNativePlacement,'--near-cache-placement-r16 requires --near-cache-native-placement');
const nearCacheNative = process.argv.includes('--near-cache-native-repeat');
const nearCacheNativeToggle=process.argv.includes('--near-cache-native-toggle');
const nearCacheNativePrewarm=process.argv.includes('--near-cache-native-prewarm');
assert.ok(!(nearCacheNativeToggle||nearCacheNativePrewarm)||nearCacheNative,'Native cache controls require --near-cache-native-repeat');
const nearCacheHourOption=process.argv.find(arg=>arg.startsWith('--near-cache-hour='));
const nearCacheHour=nearCacheHourOption?Number(nearCacheHourOption.slice('--near-cache-hour='.length)):null;
assert.ok(nearCacheHour===null||nearTraversalCache&&dayDescent&&Number.isFinite(nearCacheHour)&&nearCacheHour>=0,
  '--near-cache-hour requires a finite hour and a daytime near cache probe');
assert.ok(!nearCachePair||nearTraversalCache&&nearEmptyRuns==='r16','--near-cache-pair requires R16 empty runs and --near-traversal-cache');
assert.ok(!(nearCacheSupport||nearCacheNative)||nearTraversalCache,'Near cache probes require --near-traversal-cache');
assert.ok(!nearTraversalCache||compareNearTraversal||nearReplay||nearEmptyRuns||nearCacheSupport||nearCacheNative,'--near-traversal-cache requires a traversal comparison');
assert.ok([compareNearBins,compareNearPaths,compareNearResidual,compareNearTraversal,nearReplay,nearEmptyRuns,nearCacheSupport,nearCacheNative].filter(Boolean).length<=1,
  'Select one near workload probe');
const nearWorkProbe=compareNearBins?'bins':compareNearPaths?'paths':compareNearResidual?'residual'
  :compareNearTraversal?'traversal':nearReplay?'replay':nearEmptyRuns?'empty-runs':nearCacheSupport?'cache-support':nearCacheNative?'cache-native':null;
const traceDescent = process.argv.includes('--near-trace');
const nearTrace = traceDescent || auditRestore || forceRecovery || pacedDescent;
const skipResize = process.argv.includes('--skip-resize');
const nearPairRequested = process.argv.includes('--near-pair');
const verifyWeatherHistory=process.argv.includes('--verify-weather-history');
const viewport = process.argv.includes('--2k') ? {width:2560,height:1440} : {width:960,height:540};
assert.ok(!nearPairRequested || runDescent, '--near-pair requires --descent');
assert.ok(!verifyWeatherHistory||runDescent,'--verify-weather-history requires --descent');
assert.ok(!pacedDescent || runDescent, '--paced-descent requires --descent');
assert.ok(!dayDescent || runDescent && !fixedWeather,'--day-descent requires natural weather and --descent');
assert.ok(!nearTiles || pacedDescent, '--near-tiles requires --paced-descent');
assert.ok(!nearScaleCap || pacedDescent && viewport.width===2560 && !nearTiles,
  '--near-scale-cap requires paced 2K descent without banding');
assert.ok(!nearBatches||runDescent&&dayDescent&&pacedDescent&&!nearTiles&&!nearScaleCap&&!nearWorkProbe,
  '--near-batches requires an unscaled paced daytime descent without another probe');
assert.ok(!nearBinsArg || dayDescent && nearScaleCap && [4,8].includes(nearBins),
  '--near-bins accepts 4 or 8 for the daytime 2K scale experiment');
assert.ok(!nearWorkProbe || dayDescent && pacedDescent && viewport.width===960 && !nearTiles,
  'Near workload probe requires paced 960×540 daytime descent');
assert.ok(!forceRecovery || runDescent, '--force-recovery requires --descent');
assert.ok(!audit || !auditRestore, 'Select one mode of native GL error attribution');
const requireSupply = process.argv.includes('--require-supply');
assert.ok(!requireSupply || supplyRows !== null && !fixedWeather);
const out = `test-results/cloud-split-runtime/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const { server, port } = await startServer(0);
let browser, page, failure, supply, descent, staged, livePair, nearPair, transition, restorationAudit, farStages, farPoint, reuse, lightSupport, lightTile;
const errors = [], checkpoints = [], stagedTrace = [];
async function capture(label) {
  const state = await page.evaluate(label => {
    const game = window.NMS, pipeline = game?._pipeline, pass = pipeline?.volumePass;
    const split = pass?.farSplit, gl = game?._renderer.getContext();
    let hdr;
    if (pass?.previousSplitDraw && label !== 'failure') {
      const pixels = new Uint16Array(pass.width * pass.height * 4);
      game._renderer.readRenderTargetPixels(pass.current, 0, 0, pass.width, pass.height, pixels);
      let cloudPixels = 0, maxAlpha = 0;
      for (let i = 3; i < pixels.length; i += 4) {
        const alpha = game._THREE.DataUtils.fromHalfFloat(pixels[i]);
        if (alpha > 0) cloudPixels++;
        maxAlpha = Math.max(maxAlpha, alpha);
      }
      const stages = split.lastRoute === 'combine' ? ['point', 'cached', 'combine'] : [split.lastRoute];
      hdr = { cloudPixels, maxAlpha, stableUniforms: stages.every(stage => {
        const material = split.materials[stage];
        return game._renderer.properties.get(material).uniforms === material.uniforms;
      }) };
    }
    const bank = pass?.columnMaps.get(pass.activePlanet);
    return { atMs: performance.now(), booted: game?.booted, gl: gl?.getError(), lost: gl?.isContextLost(), hdr,
      columns: bank && { rows: bank.rows, anchor: pass.activePlanet.weatherStream.anchor,
        ready: pass.activePlanet.volCloudMat.uniforms.uColumnsReady.value,
        maps: [...bank.maps.values()].map(map => ({ generation: map.generation, row: map.row, ready: map.ready })) },
      ready: pipeline?.cloudPrograms.snapshot(), frames: split?.frames, route: split?.lastRoute,
      sequence: pipeline?.frameState.sequence, historySequence: pass?.historySequence,
      historyValid: pass?.historyValid, historyUsed: pass?.resolveMaterial.uniforms.uHistoryValid.value,
      splitPublished: pass?.previousSplitDraw, size: pass && [pass.width, pass.height],
      scratch: split?.scratch?.map(target => [target.width, target.height]) ?? null,
      firstError: window.__foundationGLProbe?.snapshot().firstError,
      lightPreparation:pipeline?.cloudLightPreparation?.state,
      active: pass?.activePlanet?.name, eye: pass?.activePlanet?.volCloudMat?.uniforms.uCameraLocal.value.length() };
  }, label);
  checkpoints.push({ label, ...state });console.log(JSON.stringify({ label, ...state }));return state;
}
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  page = await browser.newPage({ viewport });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    const value=message.text();
    if(message.type()==='error')errors.push(value);
    else if(value.startsWith('Staged cloud: ')) {
      stagedTrace.push(value.slice('Staged cloud: '.length));
      console.log(value);
    }
  });
  console.log(JSON.stringify({ out, started: true }));
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&quality=balanced&vclouds=1&farflora=0&post=1&cloudsplit=1`);
  await page.waitForFunction(() => window.NMS?._planet(0)?.volCloudBand && NMS._pipeline.volumePass.farSplit,
    null, { timeout: 120000 });
  const initial = await capture('before-orbit-placement');
  if (nearTrace) await page.evaluate(async auditRestore => {
    const { installNearTransitionTrace } = await import('/tools/near-transition-trace.js');
    const { installFoundationGLProbe } = await import('/tools/foundation-gl-probe.js');
    const onRestore = auditRestore ? () => {
      // Install in the capture listener, before Three and the game restore.
      installFoundationGLProbe();
      window.__foundationGLProbe.mark('context-restore');
      window.__foundationGLProbe.armErrors();
    } : undefined;
    window.__nearTransitionTrace = installNearTransitionTrace(NMS,{onRestore});
  }, auditRestore);
  if (audit) {
    await page.evaluate(installFoundationGLProbe);
    await page.evaluate(() => { window.__foundationGLProbe.mark('split-orbit');window.__foundationGLProbe.armErrors(); });
  }
  await page.evaluate(({fixedWeather,supplyRows,farLightTile}) => {
    const planet = NMS._planet(0);
    NMS.setAdaptiveQualityLocked();
    if (fixedWeather) NMS.setTimeFrozen();
    if (farLightTile) NMS.setTime(0);
    const star = planet.stellarDirectionsAt(farLightTile?0:planet.weatherHours)
      .sort((a,b) => b.irradianceFraction-a.irradianceFraction)[0];
    if (supplyRows !== null) {
      const pass = NMS._pipeline.volumePass, update = pass.updateCloudColumns;
      const records = [];
      window.__columnSupply = records;
      pass.updateCloudColumns = function(renderer) {
        update.call(this,renderer);
        const bank = this.columnMaps.get(this.activePlanet);
        if (!bank) return;
        if (records.length < 20000) {
          const planet = this.activePlanet, stream = planet.weatherStream;
          records.push({ atMs:performance.now(), frame:this.frame, hours:planet.weatherHours, batch:bank.rows,
            anchor:stream.anchor, step:stream.frameHours, ready:planet.volCloudMat.uniforms.uColumnsReady.value,
            worker:bank.endpointHours().map(hour => [hour,stream.revisionAt(hour)]),
            maps:[...bank.maps].map(([hour,map]) => [hour,map.row,map.ready]) });
        }
      };
    }
    NMS.teleport(0, (planet.volCloudBand.rOut-planet.R+600000)/planet.R, { dir: star.direction, horizon: false });
  }, {fixedWeather,supplyRows,farLightTile});
  await page.waitForFunction(previous => {
    const pipeline = NMS._pipeline, pass = pipeline.volumePass;
    return pass.farSplit.frames > previous + 1 && pass.previousSplitDraw && pass.historyValid
      && pass.historySequence + 1 === pipeline.frameState.sequence && pass.resolveMaterial.uniforms.uHistoryValid.value === 1;
  }, initial.frames, { timeout: 120000 });
  let orbit = await capture('split-history');
  await page.screenshot({ path: `${out}/orbit.png`, timeout: 90000 });
  if (supplyRows !== null) {
    await page.evaluate(() => NMS._pipeline.startProfiling({every:8,history:2000}));
    await page.waitForTimeout(68000);
    supply = await page.evaluate(start => ({ records:window.__columnSupply.filter(row => row.atMs >= start),
      profile:NMS._pipeline.performanceSnapshot() }), orbit.atMs);
    await capture('natural-weather-supply');
    await page.screenshot({ path: `${out}/supply.png`, timeout: 90000 });
    if (requireSupply) {
      const first = supply.records.findIndex(row => row.ready === 1);
      assert.ok(first >= 0, 'Natural weather never published a complete column pair');
      const steady = supply.records.slice(first);
      assert.ok(new Set(steady.map(row => row.anchor)).size >= 3, 'Observe two natural anchor transitions after first publication');
      assert.ok(steady.every(row => row.ready === 1), 'Lost published columns during steady forecast turnover');
    }
  }
  if (requireMixed) {
    // The normal rows producer needs up to 512 world submissions for two
    // 512-row endpoints at two rows per submission. This is a warm observation
    // window, independent of the 120-second first-draw check above.
    await page.waitForFunction(() => NMS._pipeline.volumePass.farSplit.lastRoute === 'combine', null, { timeout: 240000 });
    orbit = await capture('split-mixed');
    await page.screenshot({ path: `${out}/orbit-mixed.png`, timeout: 90000 });
  }
  if (farStageTiming || comparePoint || pointReuse || farLightSupport || farLightTile) {
    await page.waitForFunction(() => {
      const pass = NMS._pipeline.volumePass;
      return pass.farSplit.lastRoute === 'combine' && pass.activePlanet?.volCloudMat.uniforms.uColumnsReady.value === 1;
    },null,{timeout:120000});
  }
  if (farLightSupport) {
    lightSupport = await page.evaluate(async () => {
      const {measureFarLightSupport} = await import('/tools/cloud-far-light-support.js');
      return measureFarLightSupport(NMS);
    });
    console.log(JSON.stringify({lightSupport}));
    assert.equal(lightSupport.gl,0);assert.equal(lightSupport.lost,false);
  }
  if (farLightTile) {
    lightTile = await page.evaluate(async ({spacing,representation,encoded,gate}) => {
      const {measureFarLightTile} = await import('/tools/cloud-far-light-tile.js');
      return measureFarLightTile(NMS,spacing,representation,encoded,gate);
    },{spacing:farLightSpacing,representation:farLightRepresentation,encoded:farLightEncoded,gate:farLightGate});
    console.log(JSON.stringify({lightTile}));
    assert.equal(lightTile.gl,0);assert.equal(lightTile.lost,false);
  }
  if (farStageTiming) {
    farStages = await page.evaluate(async () => {
      const {measureLiveFarStages} = await import('/tools/cloud-far-stage-timing.js');
      return measureLiveFarStages(NMS);
    });
    console.log(JSON.stringify({farStages}));
    assert.equal(farStages.gl,0);assert.equal(farStages.lost,false);
    assert.ok(farStages.rows.every(row => Object.values(row.gpuMs).every(value => value>0)));
  }
  if (comparePoint) {
    farPoint = await page.evaluate(async mode => {
      const {compareFarPoint} = await import('/tools/cloud-far-point-compare.js');
      return compareFarPoint(NMS,mode);
    },splitMoments ? 'moments' : splitBeams ? 'beams' : emptyBounds ? 'bounds'
      : nativeCounts ? 'native-counts' : solarTail ? 'solar-tail' : radialEdge ? 'radial-edge'
      : radial ? 'radial' : advection ? 'advection' : 'shared');
    console.log(JSON.stringify({farPoint}));
    assert.equal(farPoint.gl,0);assert.equal(farPoint.lost,false);
    assert.ok(farPoint.rows.every(row => Object.values(row.gpuMs).every(value => value>0)));
  }
  if (pointReuse) {
    reuse = await page.evaluate(async perPath => {
      const {measureFarPointReuse} = await import('/tools/cloud-far-point-reuse.js');
      return measureFarPointReuse(NMS,perPath);
    },pointReusePaths);
    console.log(JSON.stringify({reuse}));
    assert.equal(reuse.gl,0);assert.equal(reuse.lost,false);
    assert.ok(reuse.timing.every(row=>Object.values(row.gpuMs).every(value=>value>0)));
  }
  if (!skipResize) {
    await page.setViewportSize({ width: 1008, height: 576 });
    await page.waitForFunction(({ frames, size }) => {
      const pass = NMS._pipeline.volumePass;
      return pass.farSplit.frames > frames && pass.previousSplitDraw && pass.historyValid
        && (pass.width !== size[0] || pass.height !== size[1]);
    }, orbit, { timeout: 120000 });
    await capture('split-resized');
  }
  if (requireMixed) {
    await page.evaluate(() => {
      const planet = NMS._planet(0);
      const star = planet.stellarDirectionsAt(planet.weatherHours).sort((a,b) => b.irradianceFraction-a.irradianceFraction)[0];
      NMS.teleport(0, (planet.volCloudBand.rOut-planet.R+3000000)/planet.R, { dir: star.direction, horizon: false });
    });
    await page.waitForFunction(() => NMS._pipeline.volumePass.farSplit.lastRoute === 'cachedDirect', null, { timeout: 120000 });
    await capture('split-cached');
  }
  if(stagedNearFrame) {
    const result=await page.evaluate(async options=>{
      const {verifyStagedNearFrame}=await import('/tools/staged-near-frame.js');
      return verifyStagedNearFrame(NMS,options);
    },{compareWhole:viewport.width<1000&&!stagedBandedReference,mode:stagedMode,freezeDepth:stagedFreezeDepth,
      primeBatch:stagedPrimeBatch,microBatch:stagedMicroBatch,splitMicroBatch:stagedSplitMicroBatch,
      fusedDensity:stagedFusedDensity,splitReference:stagedSplitReference});
    staged=result;
    console.log(JSON.stringify({staged}));
    assert.ok(result.passed,'Staged near frame changed native HDR');
  }
  if (runDescent) {
    if (traceDescent) {
      await page.waitForFunction(() => NMS._pipeline.volumePass.farSplit.lastRoute === 'combine', null,
        { timeout:pacedDescent?120000:30000 });
    }
    if (requireSupply) {
      livePair = await page.evaluate(async () => {
        const { compareLiveCloudPayloads } = await import('/tools/cloud-split-live-compare.js');
        return compareLiveCloudPayloads(NMS);
      });
      console.log(JSON.stringify({ livePair }));
      assert.equal(livePair.gl,0);
      assert.ok(livePair.pairs[0].maximumError <= .002, 'Actual volume HDR parity with the unmasked split');
    }
    await page.evaluate(async ({forceRecovery,pacedDescent,nearTiles,verifyTiles,nearScaleCap,dayDescent,nearBins,nearBatches,nearBatchesFused,fusedBatchTiles,nearWorkProbe,nearTraversalCache,nearReplay,nearEmptyRuns,nearCachePair,nearCacheHour,nearCoverageAt,nearCachePlacement,nearNativePlacement,nearPlacementOptics,nearPlacementR16,nearCacheNativeToggle,nearCacheNativePrewarm}) => {
      NMS._pipeline.startProfiling({every:1,history:240});
      if (pacedDescent) NMS._pipeline.startFramePacing();
      const planet = NMS._planet(0), THREE = NMS._THREE;
      const coast = NMS.setWade(0, { depth: .9, overview: true });
      if (!coast?.direction || !coast?.landward) throw Error('Continuous descent coast unavailable');
      const land = new THREE.Vector3(...coast.landward);
      const landmark = new THREE.Vector3(...coast.direction).addScaledVector(land, 2000/planet.R).normalize();
      const pipeline = NMS._pipeline, volume = pipeline.volumePass;
      if(nearBatches)volume.setLightBatchesEnabled(true,{budgetBytes:32*1024*1024,
        ...(nearBatchesFused?{fusedDensity:true,maxBatchTiles:fusedBatchTiles}:{})});
      const from = 600000, to = 1200, count = 60;
      NMS.teleport(0, from/planet.R, { dir:coast.direction });
      const state = window.__splitDescent = { startedAt:performance.now(), rows:[], done:false, coast };
      const probeAltitude=nearCoverageAt??(nearTraversalCache?200000:230000);
      if(dayDescent) {
        const start=NMS.time().hours, period=planet.rotationPeriodHours;
        let best=null;
        for(let sample=0;sample<=360;sample++) {
          const hours=start+period*sample/360;
          const star=planet.stellarDirectionsAt(hours).sort((a,b)=>b.irradianceFraction-a.irradianceFraction)[0];
          const cosine=landmark.dot(new THREE.Vector3(...star.direction));
          if(!best||cosine>best.cosine)best={hours,cosine};
        }
        if(!(best?.cosine>.5))throw Error('No daylight window for descent');
        NMS.setTime(nearCacheHour??best.hours);
        if(nearCacheHour!==null)NMS.setTimeFrozen();
        state.daylight=best;
      }
      if (nearTiles) {
        const {installNearVolumeTiles} = await import('/tools/near-volume-tiles.js');
        state.tiles = installNearVolumeTiles(NMS,{verify:verifyTiles});
      }
      if(['residual','traversal','replay','empty-runs','cache-support','cache-native'].includes(nearWorkProbe)) {
        const {observeNearResidual} = await import('/tools/near-cloud-residual.js');
        window.__nearQuadrature = await observeNearResidual(NMS,{traversal:nearWorkProbe==='traversal',
          replay:nearReplay,emptyRuns:nearCacheNativePrewarm?'r16':nearEmptyRuns,
          maximumAltitude:probeAltitude,cloudyCache:nearTraversalCache,cachePair:nearCachePair,
          cacheSupport:nearWorkProbe==='cache-support',cacheCoverage:nearCoverageAt!==null,
          cachePlacement:nearCachePlacement,nativePlacement:nearNativePlacement,
          placementOptics:nearPlacementOptics,placementR16:nearPlacementR16,
          cacheNative:nearWorkProbe==='cache-native',cacheNativeToggle:nearCacheNativeToggle});
      } else if(nearWorkProbe) {
        const {observeNearQuadrature} = await import('/tools/near-cloud-quadrature.js');
        window.__nearQuadrature = observeNearQuadrature(NMS,{paths:nearWorkProbe==='paths'});
      }
      const renderer = NMS._renderer;
      let index = 0, sequence = pipeline.frameState.sequence;
      function place(altitude) {
        if(nearTraversalCache && altitude<=probeAltitude && !state.cacheProbePose) {
          state.cacheProbePose={hours:NMS.time().hours,altitude};
          NMS.setTimeFrozen();
        }
        if (nearScaleCap && !state.scaleCap && altitude<=230000) {
          const {width,height}=pipeline.composer.readBuffer;
          const previous=[volume.width,volume.height];
          pipeline.setVolumeScale(.30);volume.setSize(width,height);
          state.scaleCap={altitude,previous,volume:[volume.width,volume.height],scene:[width,height]};
          planet.volCloudMat.uniforms.uLightQuadratureSteps.value=nearBins;
        }
        const ratio = THREE.MathUtils.smoothstep(altitude,150000,220000)*1.13+.32;
        const direction = landmark.clone().addScaledVector(land,-Math.max(3200,altitude*ratio)/planet.R).normalize();
        NMS.setContinuousAtmosphereAltitude(0,altitude,{dir:direction.toArray(),forward:coast.landward,
          surfaceTargetDirection:landmark.toArray()});
      }
      let altitude = from;
      place(altitude);
      function observe(atMs) {
        if (pipeline.frameState.sequence !== sequence) {
          if(nearWorkProbe && altitude<=probeAltitude && !window.__nearQuadrature.done) {
            requestAnimationFrame(observe);return;
          }
          const far = planet.volCloudMesh.material === planet.volCloudFarMat;
          const cachePose=state.cacheProbePose;
          state.rows.push({ altitude, atMs, sequence:pipeline.frameState.sequence,
            route:volume.previousSplitDraw?volume.farSplit.lastRoute:far?'far-legacy':'near',
            history:volume.resolveMaterial.uniforms.uHistoryValid.value,
            lightCache:planet.volCloudMat.uniforms.uSunCacheReady.value,
            lightBins:planet.volCloudMat.uniforms.uLightQuadratureSteps.value,
            batch:nearBatches?{prefetch:volume.lightBatchPrefetch?.state,
              submitted:!far&&volume.lightBatchStatus.submitted,
              reason:far?null:volume.lightBatchStatus.reason,
              residentBytes:volume.lightBatch?.plan.residentBytes,
              fusedDensity:volume.lightBatch?.fusedDensity,
              stripeRows:volume.lightBatch?.plan.stripe?.rows,
              submissions:volume.lightBatch?.submissions??0}:undefined,
            sunCosine:dayDescent?landmark.dot(planet.sunDirLocal):undefined });
          if(cachePose&&!cachePose.finished) {
            cachePose.finished=true;
            NMS.setTimeFrozen(false);
          }
          sequence = pipeline.frameState.sequence;
          if (++index > count) { state.done = true;return; }
          if (forceRecovery && !state.forcedLoss && altitude <= 156100) {
            state.forcedLoss = {altitude, atMs, sequence};
            renderer.domElement.addEventListener('webglcontextlost',
              () => setTimeout(() => renderer.forceContextRestore(),100),{once:true});
            renderer.forceContextLoss();
          }
          altitude = index === count ? to : from*(to/from)**(index/count);
          place(altitude);
        }
        requestAnimationFrame(observe);
      }
      requestAnimationFrame(observe);
    },{forceRecovery,pacedDescent,nearTiles,verifyTiles:viewport.width<1000,nearScaleCap,dayDescent,nearBins,nearBatches,nearBatchesFused,fusedBatchTiles,nearWorkProbe,nearTraversalCache,nearReplay,nearEmptyRuns,nearCachePair,nearCacheHour,nearCoverageAt,nearCachePlacement,nearNativePlacement,nearPlacementOptics,nearPlacementR16,nearCacheNativeToggle,nearCacheNativePrewarm});
    for (const altitude of [400000,180000,30000,1200]) {
      const stopOnLoss = !forceRecovery && !auditRestore;
      await page.waitForFunction(({target,stopOnLoss}) => window.__splitDescent?.rows.at(-1)?.altitude <= target
        || (stopOnLoss && NMS._renderer.getContext().isContextLost()), {target:altitude,stopOnLoss},
        { timeout:180000, polling:100 });
      if (stopOnLoss) assert.equal(await page.evaluate(()=>NMS._renderer.getContext().isContextLost()),false,
        'WebGL context lost during continuous descent');
      await page.screenshot({ path:`${out}/descent-${altitude}.png`, timeout:90000 });
    }
    descent = await page.evaluate(async nearWorkProbe => ({...window.__splitDescent,
      quadrature:nearWorkProbe?await window.__nearQuadrature.finish():undefined,
      profile:NMS._pipeline.performanceSnapshot(),pacing:NMS._pipeline.framePacer?.snapshot()}),nearWorkProbe);
    assert.ok(descent.done && descent.rows.some(row => row.route === 'near'));
    if(nearBatches) {
      assert.ok(descent.rows.some(row=>row.route!=='near'&&row.batch.prefetch==='ready'),'Batch programs were not ready before the near transition');
      assert.ok(descent.rows.filter(row=>row.route==='near').every(row=>row.batch.submitted&&row.lightBins===16),
        'The actual near view used a fallback or changed the production quadrature');
      if(nearBatchesFused)assert.ok(descent.rows.filter(row=>row.route==='near').every(row=>row.batch.fusedDensity),
        'The actual near view did not use fused density');
    }
    if(nearWorkProbe==='traversal'||nearReplay==='prefix') {
      assert.ok(descent.quadrature.rows.every(row=>row.error.changed===0),'Near traversal changed the native HDR');
      if(nearReplay==='prefix') assert.ok(descent.quadrature.rows.every(row=>row.error.nonempty>0),
        'Near prefix probe needs occupied cloud');
      if(nearTraversalCache) assert.ok(descent.quadrature.rows.every(row=>row.cacheReady===1&&row.error.nonempty>0),
        'Near traversal cache probe needs occupied cloud with bound lighting');
    }
    if(dayDescent) assert.ok(descent.rows.every(row=>row.sunCosine>.5),'Descent left the daylight window');
    if (pacedDescent) assert.ok(descent.pacing.stats.completed>=60 && !descent.pacing.fault, JSON.stringify(descent.pacing));
    if (nearTiles) assert.ok(descent.tiles.frames>0 && descent.tiles.maxBands>1);
    if (nearScaleCap) assert.deepEqual(descent.scaleCap.volume,[768,432]);
    const end = await capture('descent-low-flight');
    assert.equal(end.gl,0);assert.equal(end.lost,false);assert.equal(end.ready.failed,false);
    if(verifyWeatherHistory) {
      await page.waitForFunction(()=>{
        const pass=NMS._pipeline.volumePass, body=pass.activePlanet;
        return body?.weatherStream?.committedSecond&&body.cloudWeatherPublication
          &&pass.resolveMaterial.uniforms.uHistoryValid.value===1;
      },null,{timeout:60000});
      descent.weatherHistory=await page.evaluate(async()=>{
        const {verifyVolumeWeatherPublication}=await import('/tools/volume-weather-publication-browser.js');
        return verifyVolumeWeatherPublication(NMS);
      });
      assert.equal((await capture('weather-history-replacement')).gl,0);
    }
  }
  if (nearPairRequested) {
    nearPair = await page.evaluate(async () => {
      NMS._pipeline.stopProfiling();
      const { compareLiveNearCloud } = await import('/tools/cloud-near-live-compare.js');
      return compareLiveNearCloud(NMS);
    });
    console.log(JSON.stringify({ nearPair }));
    assert.equal(nearPair.gl,0);assert.equal(nearPair.lost,false);assert.equal(nearPair.disjoint,false);
    for (const {altitude,rows} of nearPair.poses) {
      const parity = rows[0];
      assert.ok(parity.cloudPixels > 0 && parity.maximumError <= .002 && parity.alphaChanged === 0,
        JSON.stringify({altitude,parity}));
      assert.ok(rows.every(row => row.depthReady === 1 && row.sunCacheReady === 1));
      assert.ok(rows.slice(1).every(row => row.gpuMs.original > 0 && row.gpuMs.split > 0));
    }
  }
  for (const state of checkpoints.slice(1)) {
    assert.equal(state.gl,0);assert.equal(state.lost,false);assert.equal(state.ready.failed,false);
    assert.ok(!state.firstError, JSON.stringify(state.firstError));
    if (state.label !== 'descent-low-flight'&&state.label!=='weather-history-replacement')
      assert.ok(state.hdr?.cloudPixels > 0 && state.hdr?.maxAlpha > 0 && state.hdr?.stableUniforms, JSON.stringify(state.hdr));
    if (state.splitPublished && state.route === 'combine') assert.deepEqual(state.scratch, [state.size, state.size]);
  }
  assert.deepEqual(errors, []);
} catch (error) {
  failure = String(error);
    if (page && runDescent && !descent) try {
      descent = await page.evaluate(() => ({...window.__splitDescent,
        quadrature:window.__nearQuadrature?.report,pacing:NMS._pipeline.framePacer?.snapshot()}));
    } catch {}
  if (page && nearPairRequested && !nearPair) try { nearPair = await page.evaluate(() => window.__nearLivePair); } catch {}
  if (page && comparePoint && !farPoint) try { farPoint = await page.evaluate(() => window.__farPointCompare); } catch {}
  if (page && pointReuse && !reuse) try { reuse = await page.evaluate(() => window.__farPointReuse); } catch {}
  if (page && farLightTile && !lightTile) try { lightTile = await page.evaluate(() => window.__farLightTile); } catch {}
  if (page) try { await capture('failure'); } catch {}
  throw error;
} finally {
  try {
    if (nearTrace && page) try { transition = await page.evaluate(() => window.__nearTransitionTrace?.finish()); } catch {}
    if (auditRestore && page) try {
      restorationAudit = await page.evaluate(() => window.__foundationGLProbe?.snapshot());
    } catch {}
    const after = await evidenceFingerprint(...verifiers);
    const contextEvents = transition?.contextEvents ?? [];
    if(!failure&&nearTrace&&runDescent&&(!transition?.phases?.draws||transition.phases.mismatches))
      failure='Actual near draws did not follow the committed cloud sample sequence';
    if (!failure && auditRestore && restorationAudit?.errorArms.some(arm => arm.preexisting))
      failure = 'Preexisting GL error at context restoration';
    if (!failure && forceRecovery) {
      const events = contextEvents.map(event => event.type);
      const nextFrames = descent?.rows.filter(row => row.sequence > descent.forcedLoss?.sequence);
      if (!descent?.forcedLoss || events.join(',') !== 'webglcontextlost,webglcontextrestored'
        || nextFrames[0]?.history !== 0 || nextFrames[1]?.history !== 1) failure = 'Forced restoration did not rebuild world history';
    }
    if (!failure && !forceRecovery && contextEvents.length) failure = 'Continuous context gate failed';
    await writeFile(`${out}/report.json`, JSON.stringify({ before, after, viewport, audit, auditRestore, forceRecovery, pacedDescent, nearTiles, nearScaleCap,
      requireMixed, fixedWeather, supplyRows, supply, livePair, nearPair, farStages, farPoint, reuse, lightSupport, lightTile, descent, staged, transition, restorationAudit,
      checkpoints, stagedTrace:stagedTrace.length?stagedTrace:undefined, errors, failure, passed: !failure }, null, 2));
    assert.deepEqual(after, before);
    if (failure) process.exitCode = 1;
  } finally { await browser?.close();server.close(); }
}
