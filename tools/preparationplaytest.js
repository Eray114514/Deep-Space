// Real route cancel, immediate warp, rift/private warm and adoption. Clouds are
// off to isolate preparation ownership; this is not cloud/FPS acceptance.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const verifier = 'tools/preparationplaytest.js', out = `test-results/preparation-player/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
await writeFile(`${out}/verifier.js`, await readFile(new URL(import.meta.url)));
const report = { before: await evidenceFingerprint(verifier), errors: [], expectedErrors: [], driverWarnings: [],
  scope: 'Actual route UI/cancel/queued Warp/rift/private draw/adoption, Balanced 720p vclouds=0. Controlled first-cancel queue hold, owned source orphan witness and one WORLD preparation rejection for same-batch retry. No FPS/cloud-art claim.' };
const { server, port } = await startServer(0);let browser, page;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  report.browserVersion = browser.version();page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', error => report.errors.push(String(error)));
  page.on('console', message => {
    const text = message.text();if (message.type() === 'error') {
      if (text.startsWith('Deferred WORLD publication failed:') && text.includes('QA_WORLD_PUBLICATION_REJECTION')) report.expectedErrors.push(text);
      else report.errors.push(text);
    }
    if (/GL_INVALID|CONTEXT_LOST|Program object expected|INVALID_(?:ENUM|VALUE|OPERATION)|GL_OUT_OF_MEMORY/i.test(text)) report.driverWarnings.push(text);
  });
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&quality=balanced&vclouds=0&farflora=0&post=1&freeze=1&buildms=25`);
  await page.waitForFunction(() => window.NMS?.booted, null, { timeout: 120000 });
  // Drain idle SurveyUnits prewarm (scheduled at +6s outside GpuPreparationQueue in main.js)
  // before installing submission-ownership observers and frame pacing.
  await page.evaluate(async () => {
    const { surveyUnits, camera, scene } = NMS._internals;
    await surveyUnits?.prewarm?.({ renderer: NMS._renderer, camera, scene });
  });
  await page.evaluate(async () => {
    const T = await import('three');
    const pipeline = NMS._pipeline, renderer = NMS._renderer, queue = pipeline.preparations;
    const data = window.__preparationPlayer = { phase: 'cancel', compiles: 0, uploads: 0, draws: 0, outside: [], labels: {}, destinationCompiles: [], publications: [], privatePortals: [], restored: false };
    const restores = [], wrap = (object, name, factory) => {
      const original = object[name], wrapper = factory(original);object[name] = wrapper;
      restores.push(() => { if (object[name] !== wrapper) throw Error(`Observer changed: ${name}`);object[name] = original; });
    };
    const { WorldPublication } = await import('/src/world-publication.js');
    const { PortalView } = await import('/src/portal/portal-view.js');
    wrap(PortalView.prototype, 'render', original => function(options) {
      const label = queue.active?.label || 'live-portal';
      if (data.phase !== 'rift' && !queue.active?.label) return original.call(this, options);
      const { scene, universe, ship } = NMS._internals;
      const before = { open: NMS.riftState().open, visible: NMS.riftState().visible, composite: pipeline.portalComposite.enabled,
        target: renderer.getRenderTarget(), face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
        calls: renderer.info.render.calls, fog: scene.fog, shipVisible: ship.group.visible,
        starsPos: universe.nearStarsMesh?.position.toArray() };
      const result = original.call(this, options);
      data.privatePortals.push({ label, result, open: before.open, visible: before.visible, composite: before.composite,
        nativeDraws: renderer.info.render.calls - before.calls,
        portalViewFlag: Boolean(this.pipeline?.portalView),
        renderToScreen: Boolean(this.pipeline?.composer.renderToScreen),
        restored: renderer.getRenderTarget() === before.target && renderer.getActiveCubeFace() === before.face
          && renderer.getActiveMipmapLevel() === before.mip && scene.fog === before.fog
          && ship.group.visible === before.shipVisible && pipeline.portalComposite.enabled === before.composite
          && JSON.stringify(universe.nearStarsMesh?.position.toArray()) === JSON.stringify(before.starsPos) });
      return result;
    });
    const identifiers = new WeakMap();let nextPublication = 0, injectedPublicationFailure = false;
    wrap(WorldPublication.prototype, 'publish', original => function(...args) {
      if (!identifiers.has(this)) identifiers.set(this, ++nextPublication);
      const id = identifiers.get(this), roots = [...this.visibility], owner = this.system;
      const record = (committed, failed) => data.publications.push({ id, committed, failed,
        ownerCurrent: owner === NMS._internals.universe.system, state: this.state, attempts: this.attempts,
        roots: roots.length, allHidden: roots.every(([root]) => !root.visible),
        desiredReached: roots.every(([root, visible]) => root.visible === visible) });
      return original.apply(this, args).then(result => { record(result, false);return result; }, error => {
        record(false, true);throw error;
      });
    });
    wrap(pipeline, 'prepare', original => function(work, options) {
      if (options?.label === 'world-publication' && !injectedPublicationFailure) {
        injectedPublicationFailure = true;data.controlledPublicationFailure = true;
        return Promise.reject(Object.assign(new Error('QA_WORLD_PUBLICATION_REJECTION'), { code: 'qa-publication' }));
      }
      return original.call(this, work, options);
    });
    for (const [name, counter] of [['compile', 'compiles'], ['initTexture', 'uploads']]) wrap(renderer, name, original => function(...args) {
      data[counter]++;const label = queue.active?.label;
      if (!pipeline.frameSubmissionActive || !label) data.outside.push({ name, phase: data.phase });
      if (name === 'compile' && label === 'destination-lod') {
        const [source, compileCamera, lighting] = args, objects = [], lights = [], sourceLights = [];
        source.traverse(object => { if (object.material) objects.push(object); });
        source.traverseVisible(object => { if (object.isLight) sourceLights.push(object); });
        lighting.traverseVisible(object => { if (object.isLight && object.layers.test(compileCamera.layers)) lights.push(object); });
        const { scene, universe, ship } = NMS._internals, liveLights = new Set();
        scene.traverse(object => { if (object.isLight) liveLights.add(object); });
        const within = (object, root) => { for (let node = object; node; node = node.parent) if (node === root) return true;return false; };
        const prepared = NMS.warpPreparationState().preparedStarId;
        const forbidden = [universe.system, universe.fadingSystem].filter(system => system && system.star.id !== prepared)
          .flatMap(system => [...system.planets, ...system.compactObjects, ...system.starViews].map(value => value.group));
        data.destinationCompiles.push({ phase: data.phase, renderables: objects.length,
          currentHdr: renderer.getRenderTarget() === pipeline.composer.readBuffer,
          privateSource: source !== scene, privateLights: lights.every(light => !liveLights.has(light)),
          sourceLights: sourceLights.length, directions: lights.filter(light => light.isDirectionalLight).length,
          shadows: lights.filter(light => light.castShadow).length,
          sourceWorldHits: objects.filter(object => forbidden.some(root => within(object, root))).length,
          hullObjects: objects.filter(object => within(object, ship.group)).length,
          separateCabinObjects: ship.separateInterior ? objects.filter(object => within(object, ship.int.group)).length : 0 });
      }
      return original.apply(this, args);
    });
    wrap(renderer, 'render', original => function(...args) {
      data.draws++;if (!pipeline.frameSubmissionActive) data.outside.push({ name: 'render', phase: data.phase });
      return original.apply(this, args);
    });
    wrap(queue, 'runNext', original => function(...args) {
      const ticket = original.apply(this, args);
      if (ticket) data.labels[ticket.label] = (data.labels[ticket.label] || 0) + 1;
      return ticket;
    });
    window.__restorePreparationPlayer = () => { restores.reverse().forEach(restore => restore());data.restored = true; };
    const runNext = queue.runNext, held = () => null;queue.runNext = held;
    window.__releasePreparationHold = () => {
      if (queue.runNext !== held) throw Error('Queue hold ownership changed');queue.runNext = runNext;
    };
    data.hold = { kind: 'Controlled queue hold for actual UI cancellation; not native busy/performance evidence' };
    // Controlled owned-root witness, not authored content or a performance run.
    // A zero-intensity point still belongs to Three's WORLD light family.
    const { universe } = NMS._internals, orphan = new T.Group(), beacon = new T.PointLight(0xffffff, 0, 10);
    orphan.name = 'Preparation player owned source witness';orphan.add(beacon);universe.group.add(orphan);
    universe.system.artificialSites.push({ site: { id: 'qa-source-orphan', type: 'ring-station' },
      group: orphan, parentBody: null, posUniv: universe.system.star.pos.clone().add(new T.Vector3(2000, 0, 0)) });
    window.__preparationSourceOrphan = orphan;
    data.sourceOrphanWitness = { controlled: true, initiallyVisible: orphan.visible };
    pipeline.startFramePacing();data.initialStar = universe.system.star.id;
  });
  const choose = async () => {
    const target = await page.evaluate(() => {
      const { universe, starMap } = NMS._internals;
      for (const star of universe.nearStarsList) {
        if (star.id === universe.system.star.id) continue;
        const preview = starMap.systemPreview(star), body = preview.bodies.find(body => !body.isMoon
          && !['gasGiant', 'iceGiant', 'blackHole'].includes(body.type));
        if (body) return { starId: star.id, index: body.index };
      }
      return null;
    });
    assert.ok(target);
    report.step = `select:${target.starId}`;
    const selection = await page.evaluate(async id => {
      NMS.openStarMap();const selected = NMS.selectStarMapTarget(id);
      await NMS._internals.starMap.enterSystem();
      return { selected, current: NMS._internals.universe.system.star.id, shown: NMS._internals.starMap.selectedStar?.id };
    }, target.starId);
    (report.selections ||= []).push({ target, ...selection });
    assert.equal(selection.selected, target.starId);assert.equal(selection.shown, target.starId);assert.notEqual(selection.current, target.starId);
    await page.locator(`#sm-systemGlyph [data-glyph-index="${target.index}"]`).click();
    await page.waitForFunction(target => NMS._internals.starMap.selectedStar?.id === target.starId
      && NMS._internals.starMap.selectedPlanet?.index === target.index
      && document.querySelector('#sm-planetLeft')?.classList.contains('active'), target);
    report.step = `route:${target.starId}`;
    await page.locator('#sm-routeAction').click();
    await page.waitForFunction(() => !document.getElementById('route-choice').classList.contains('hidden'));
    return target;
  };
  report.cancelTarget = await choose();
  report.cancelQueued = await page.evaluate(() => NMS._pipeline.preparations.snapshot());
  await page.locator('#route-cancel-btn').click();
  await page.evaluate(() => { __releasePreparationHold();__preparationPlayer.phase = 'warp'; });
  await page.waitForFunction(() => !NMS.warpPreparationState().preparedStarId);
  report.cancel = await page.evaluate(() => ({ preparation: NMS._pipeline.preparations.snapshot(), star: NMS._internals.universe.system.star.id,
    original: __preparationPlayer.initialStar, sourceOrphanVisible: __preparationSourceOrphan.visible }));
  assert.ok(report.cancelQueued.queued > 0);assert.ok(report.cancel.preparation.stats.cancelled + report.cancel.preparation.stats.obsolete > 0);
  assert.equal(report.cancel.star, report.cancel.original);
  assert.equal(report.cancel.sourceOrphanVisible, true);
  report.warpTarget = await choose();await page.locator('#route-warp-btn').click();report.step = 'warp-start';
  await page.waitForFunction(() => NMS.state === 'warp', null, { timeout: 120000 });
  await page.screenshot({ path: `${out}/warp.png`, timeout: 90000 });
  await page.waitForFunction(id => NMS.state === 'space' && NMS._internals.universe.system.star.id === id, report.warpTarget.starId, { timeout: 120000 });
  report.sourceOrphanRetirement = await page.evaluate(() => ({ visible: __preparationSourceOrphan.visible,
    attached: Boolean(__preparationSourceOrphan.parent) }));
  assert.ok(!report.sourceOrphanRetirement.visible || !report.sourceOrphanRetirement.attached);
  await page.waitForFunction(() => {
    const rows = __preparationPlayer.publications, failed = rows.find(row => row.failed);
    return failed?.allHidden && rows.some(row => row.id === failed.id && row.committed && row.desiredReached);
  }, null, { timeout: 120000 });
  await page.screenshot({ path: `${out}/warp-arrival.png`, timeout: 90000 });
  await page.evaluate(() => { __preparationPlayer.phase = 'rift'; });
  report.riftTarget = await choose();await page.locator('#route-rift-btn').click();report.step = 'rift-ready';
  await page.waitForFunction(() => NMS.riftState().open > .985 && NMS.riftState().anchorLocked
    && NMS.riftState().previewVolume?.ready, null, { timeout: 120000 });
  report.rift = await page.evaluate(() => ({ state: NMS.riftState(), warm: NMS.warpPreparationState() }));
  await page.screenshot({ path: `${out}/rift-open.png`, timeout: 90000 });
  assert.equal(await page.evaluate(() => NMS.approachRift(-10)), true);
  await page.waitForFunction(() => {
    const rift = NMS.riftState();if (!rift.arrived) return false;
    window.__preparationCrossing = { rift, star: NMS._internals.universe.system.star.id, atMs: performance.now() };
    return true;
  }, null, { timeout: 45000 });
  report.crossing = await page.evaluate(() => __preparationCrossing);
  await page.screenshot({ path: `${out}/rift-arrival.png`, timeout: 90000 });
  await page.waitForFunction(() => NMS._pipeline.preparations.snapshot().pending === 0, null, { timeout: 120000 });
  report.result = await page.evaluate(() => {
    const pipeline = NMS._pipeline, renderer = NMS._renderer, pacer = pipeline.framePacer, gl = renderer.getContext();
    __restorePreparationPlayer();pipeline.stopFramePacing();window.__preparationRetired = pacer;
    return { observer: __preparationPlayer, preparation: pipeline.preparations.snapshot(), stats: NMS.stats(),
      arrived: NMS.riftState().arrived, star: NMS._internals.universe.system.star.id, gl: gl.getError(), lost: gl.isContextLost() };
  });
  await page.waitForFunction(() => __preparationRetired.snapshot().released, null, { timeout: 15000 });
  report.retired = await page.evaluate(() => __preparationRetired.snapshot());
  assert.equal(report.crossing.rift.arrived, true);assert.equal(report.crossing.star, report.riftTarget.starId);
  assert.equal(report.result.star, report.riftTarget.starId);assert.equal(report.result.stats.state, 'space');
  assert.ok(report.result.observer.compiles > 0 && report.result.observer.uploads > 0);
  assert.ok(report.result.observer.labels['destination-private-frame'] > 0);
  assert.ok(report.result.observer.labels['portal-programs'] > 0);
  assert.ok(report.result.observer.privatePortals.length > 0, 'PortalView rendered the live destination view');
  assert.ok(report.result.observer.privatePortals.every(row => row.result === true
    && row.nativeDraws > 0 && row.portalViewFlag && !row.renderToScreen && row.restored), 'Portal far-view requires native draws, isolated PortalView pipeline, and restored state');
  assert.deepEqual(report.result.observer.outside, []);assert.equal(report.result.observer.restored, true);
  assert.equal(report.expectedErrors.length, 1);assert.equal(report.result.observer.controlledPublicationFailure, true);
  const failedPublication = report.result.observer.publications.find(row => row.failed);
  assert.ok(failedPublication?.allHidden);
  assert.ok(report.result.observer.publications.some(row => row.id === failedPublication.id && row.committed && row.desiredReached));
  const destinationCompiles = report.result.observer.destinationCompiles;
  assert.equal(destinationCompiles.length, 4);
  assert.ok(destinationCompiles.every(row => row.renderables > 0 && row.currentHdr && row.privateSource && row.privateLights
    && row.sourceLights === 0 && row.sourceWorldHits === 0 && row.hullObjects > 0 && row.separateCabinObjects === 0));
  for (let index = 0; index < destinationCompiles.length; index += 2) {
    assert.equal(destinationCompiles[index + 1].directions, destinationCompiles[index].directions + 1);
    assert.equal(destinationCompiles[index + 1].shadows, destinationCompiles[index].shadows + 1);
  }
  assert.equal(report.result.preparation.pending, 0);assert.equal(report.result.gl, 0);assert.equal(report.result.lost, false);
  assert.equal(report.retired.released, true);assert.equal(report.retired.pending, 0);assert.equal(report.retired.fault, null);
  assert.deepEqual(report.errors, []);assert.deepEqual(report.driverWarnings, []);report.passed = true;
} catch (error) {
  report.passed = false;report.error = String(error);report.stack = error?.stack;process.exitCode = 1;
  if (page) try { report.failureState = await page.evaluate(() => ({ stats: window.NMS?.stats(), warm: window.NMS?.warpPreparationState(),
    rift: window.NMS?.riftState(), observer: window.__preparationPlayer }));await page.screenshot({ path: `${out}/failure.png`, timeout: 10000 }); } catch {}
} finally {
  report.after = await evidenceFingerprint(verifier);
  if (report.before.sourceDigest !== report.after.sourceDigest || report.before.verifierDigest !== report.after.verifierDigest) { report.passed = false;report.unstable = true;process.exitCode = 1; }
  await writeFile(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ out, passed: report.passed, error: report.error, labels: report.result?.observer.labels, outside: report.result?.observer.outside }));
  await browser?.close();await new Promise(resolve => server.close(resolve));
}
