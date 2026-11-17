// Fixed-camera captures of the pulse and warp transit looks on the real GPU.
//
//   node tools/transit-shots.js [pulse|warp|live-pulse|live-warp ...]
//
// `pulse` / `warp` freeze the transit timeline at authored instants through
// NMS.holdTransit (the ship does not move), so every phase can be judged on
// its own. `live-*` runs the real transit and samples frames over time to
// check hand-overs and the arrival. Output: screenshots/transit/<mode>/.
import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser } from './browser.js';

const args = process.argv.slice(2);
const cockpit = args.includes('--cockpit');
const modes = args.filter((a) => !a.startsWith('--')).length ? args.filter((a) => !a.startsWith('--')) : ['pulse', 'warp'];
const { server, port } = await startServer(0);
const browser = await launchHardwareBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR:', String(e).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE:', m.text().slice(0, 300)); });

const frames = (n = 2) => page.evaluate((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

try {
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&nolock=1&nohero=1&farflora=0`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 180000 });
  const hideUi = () => page.addStyleTag({ content: 'body > *:not(#app) { visibility: hidden !important; }' });
  let uiStyle = await hideUi();
  await page.waitForTimeout(2500);
  if (cockpit) { await page.evaluate(() => NMS.shipViewDebug.setViewMode('cockpit')); await page.waitForTimeout(2000); }

  for (const mode of modes) {
    const out = `screenshots/transit/${mode}${cockpit ? "-cockpit" : ""}`;
    await mkdir(out, { recursive: true });
    if (mode === 'pulse' || mode === 'warp') {
      const info = await page.evaluate((kind) => NMS.holdTransit(kind, 0), mode);
      const plan = info.plan;
      const instants = mode === 'pulse'
        ? [0.0, 0.12, 0.22, 0.27, 0.32, 0.4, 0.55, 0.75, 1.0]
        : [0, .05, .1, .14, .18, .22, .26, .3, .34, .42, .52, .6, .64, .68, .72, .77, .82, .88, .95].map((u) => u * plan.duration);
      for (const t of instants) {
        await page.evaluate(([kind, time]) => NMS.holdTransit(kind, time), [mode, t]);
        await frames(24);
        const name = `${out}/${mode}-${t.toFixed(2).padStart(6, '0')}.png`;
        await page.screenshot({ path: name });
        console.log('✓', name);
      }
      await page.evaluate(() => NMS.releaseTransit());
      await frames(10);
    } else if (mode === 'live-pulse') {
      await page.evaluate(() => NMS.setPulse(true));
      const start = Date.now();
      for (let i = 0; i < 14; i++) {
        const name = `${out}/live-pulse-${String(Date.now() - start).padStart(5, '0')}.png`;
        await page.screenshot({ path: name });
        console.log('✓', name);
      }
      await page.waitForTimeout(1500);
    } else if (mode === 'live-rift') {
      const target = await page.evaluate(() => {
        const { universe, starMap } = NMS._internals;
        for (const star of universe.nearStarsList) {
          const body = starMap.systemPreview(star).bodies.find((c) => !c.isMoon
            && !['gasGiant', 'iceGiant', 'blackHole'].includes(c.type) && (c.clouds?.coverage || 0) > 0.12);
          if (body) return { starId: star.id, bodyIndex: body.index };
        }
        return null;
      });
      await uiStyle.evaluate((node) => node.remove());
      await page.evaluate((id) => { NMS.openStarMap(); NMS.selectStarMapTarget(id); }, target.starId);
      await page.locator(`#sm-systemGlyph [data-glyph-index="${target.bodyIndex}"]`).click({ force: true });
      await page.waitForFunction(() => document.querySelector('#sm-planetLeft')?.classList.contains('active'));
      await page.locator('#sm-routeAction').click({ force: true });
      await page.waitForFunction(() => !document.getElementById('route-choice').classList.contains('hidden'));
      await page.waitForFunction(() => NMS.warpPreparationState?.().riftWarmState === 'complete'
        || NMS.warpPreparationState?.().riftWarm === 'complete', null, { timeout: 120000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.locator('#route-rift-btn').click();
      uiStyle = await hideUi();
      const shot = async (label) => {
        const state = await page.evaluate(() => NMS.riftState());
        const name = `${out}/rift-${label}-open${state.open.toFixed(2)}.png`;
        await page.screenshot({ path: name });
        console.log('✓', name, JSON.stringify({ phase: state.phase, seam: state.seam, far: state.farRendered,
          d: state.distanceToThreshold, throat: state.throat, arrived: state.arrived }));
      };
      const clickedAt = Date.now();
      for (let i = 0; i < 7; i++) { await shot(`a${i}`); await page.waitForTimeout(250); }
      await page.waitForFunction(() => NMS.riftState().previewVolume?.ready && NMS.riftState().open > 0.98, null, { timeout: 60000 })
        .catch(() => console.log('far view not ready in time'));
      console.log('far view ready after', Date.now() - clickedAt, 'ms');
      const radius = await page.evaluate(() => NMS.riftState().radius);
      for (const k of [6, 3, 1.5, 0.6, 0.15, 0.03]) {
        await page.evaluate((dist) => NMS.approachRift(dist), radius * k);
        await frames(20);
        await shot(`b${k.toFixed(2)}R`);
      }
      await page.evaluate(() => NMS.approachRift(-6));
      await frames(2);
      // sample the throat ride by its own clock: screenshots are slow here
      for (const t of [0.1, 0.3, 0.5, 0.7, 0.9, 1.1, 1.3, 1.5, 1.8, 2.1, 2.4, 2.8]) {
        await page.waitForFunction((at) => {
          const s = NMS.riftState();
          return !s.throat || s.throat.t >= at;
        }, t, { timeout: 20000 }).catch(() => {});
        await shot(`c${t.toFixed(1)}`);
      }
      await page.waitForTimeout(1200);
      await shot('d-after');
      console.log('after', JSON.stringify(await page.evaluate(() => {
        const s = NMS.stats();
        const i = NMS._internals;
        return {
          state: s.state, alt: NMS.alt(), system: i.universe.system?.name,
          channels: s.transitChannels, warp: NMS.warp(),
          visibleBodies: i.universe.system?.planets.filter((p) => p.group.visible).map((p) => p.name),
          stars: [i.universe.nearStarsMesh?.visible, i.universe.backdropMesh?.visible,
            i.universe.nearStarsMesh?.position.toArray(), i.universe.backdropMesh?.position.toArray()],
          starViews: i.universe.system?.starViews.map((v) => [v.group.visible, v.light.visible, v.light.intensity]),
          exposure: i.renderer.toneMappingExposure,
          composite: i.nodePipeline.portalComposite.enabled,
          cloudBody: i.nodePipeline.cloudPass?.activePlanet?.name || null,
          atmoBody: i.nodePipeline.atmospherePass?.activePlanet?.name || null,
          bodies: i.universe.system?.planets.map((b) => ({ name: b.name, visible: b.group.visible, R: Math.round(b.R || 0),
            alt: Math.round(b.posUniv.distanceTo(i.nav.pos) - (b.R || 0)), parent: b.parentBody?.name || null,
            cloud: !!b.cloudMesh, cloudVisible: b.cloudMesh?.visible ?? null })),
          pos: NMS.pos(), quat: NMS.quat(),
          nearest: (() => {
            const p = i.universe.system?.planets.map((b) => [b.name, b.posUniv.distanceTo(i.nav.pos) - (b.R || 0)])
              .sort((a, b) => a[1] - b[1])[0];
            return p;
          })(),
        };
      })));
    } else if (mode === 'live-warp') {
      const target = await page.evaluate(() => NMS.warpToStar());
      console.log('warp target', target);
      const start = Date.now();
      while (await page.evaluate(() => NMS.stats().state === 'warp')) {
        const stats = await page.evaluate(() => NMS.stats().transit);
        const name = `${out}/live-warp-${String(Date.now() - start).padStart(6, '0')}-t${(stats?.t ?? 0).toFixed(2)}.png`;
        await page.screenshot({ path: name });
        console.log('✓', name);
        await page.waitForTimeout(350);
      }
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${out}/live-warp-arrived.png` });
    }
  }
} finally {
  await browser.close();
  server.close();
}
