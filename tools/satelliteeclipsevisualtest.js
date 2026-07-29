// WebGPU hardware acceptance for satellite occlusion and eclipse composition.
//
// The test deliberately separates the opaque surface from participating media:
// a local eclipse must move across both with the same projected centroid, while
// neither the whole frame nor an unrelated body may behave like a screen-space
// overlay. A real generated moon is then placed in front of and behind its
// parent to prove ordinary scene depth, rather than renderOrder, owns visibility.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const outputDir = new URL('../test-results/satellite-eclipse/', import.meta.url);

function decode(buffer) {
  return PNG.sync.read(buffer);
}

function luma(png, pixel) {
  const offset = pixel * 4;
  return png.data[offset] * 0.2126
    + png.data[offset + 1] * 0.7152
    + png.data[offset + 2] * 0.0722;
}

function rgbDifference(a, b, pixel) {
  const offset = pixel * 4;
  return (
    Math.abs(a.data[offset] - b.data[offset])
    + Math.abs(a.data[offset + 1] - b.data[offset + 1])
    + Math.abs(a.data[offset + 2] - b.data[offset + 2])
  ) / 3;
}

function median(values) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return values.length % 2
    ? values[middle]
    : (values[middle - 1] + values[middle]) * 0.5;
}

function shadowStats(referenceBuffer, controlBuffer, shadowBuffer) {
  const reference = decode(referenceBuffer);
  const control = decode(controlBuffer);
  const shadow = decode(shadowBuffer);
  assert.equal(control.width, reference.width);
  assert.equal(shadow.width, reference.width);
  assert.equal(control.height, reference.height);
  assert.equal(shadow.height, reference.height);

  const x0 = Math.floor(reference.width * 0.08);
  const x1 = Math.ceil(reference.width * 0.92);
  const y0 = Math.floor(reference.height * 0.02);
  const y1 = Math.ceil(reference.height * 0.96);
  const stable = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const pixel = y * reference.width + x;
    if (rgbDifference(reference, control, pixel) > 3) continue;
    stable.push({
      x, y,
      delta: luma(shadow, pixel) - luma(reference, pixel),
    });
  }
  const globalDelta = median(stable.map((sample) => sample.delta));
  let darkened = 0;
  let weight = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (const sample of stable) {
    const residual = sample.delta - globalDelta;
    if (residual >= -9) continue;
    const amount = -residual - 9;
    darkened++;
    weight += amount;
    weightedX += sample.x * amount;
    weightedY += sample.y * amount;
  }
  return {
    globalDelta,
    stableFraction: stable.length / ((x1 - x0) * (y1 - y0)),
    darkenedFraction: darkened / Math.max(1, stable.length),
    centroid: weight > 0
      ? [weightedX / weight / reference.width, weightedY / weight / reference.height]
      : null,
  };
}

function centroidDistance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function eclipseMotion(left, right) {
  if (!left || !right) return null;
  return [right[0] - left[0], right[1] - left[1]];
}

function motionAlignment(surfaceLeft, surfaceRight, mediaLeft, mediaRight) {
  const surface = eclipseMotion(surfaceLeft, surfaceRight);
  const media = eclipseMotion(mediaLeft, mediaRight);
  if (!surface || !media) return { cosine: -1, scale: Infinity, midpointDistance: Infinity };
  const surfaceLength = Math.hypot(...surface);
  const mediaLength = Math.hypot(...media);
  const cosine = (surface[0] * media[0] + surface[1] * media[1])
    / Math.max(1e-6, surfaceLength * mediaLength);
  const surfaceMidpoint = [
    (surfaceLeft[0] + surfaceRight[0]) * 0.5,
    (surfaceLeft[1] + surfaceRight[1]) * 0.5,
  ];
  const mediaMidpoint = [
    (mediaLeft[0] + mediaRight[0]) * 0.5,
    (mediaLeft[1] + mediaRight[1]) * 0.5,
  ];
  return {
    cosine,
    scale: mediaLength / Math.max(1e-6, surfaceLength),
    midpointDistance: centroidDistance(surfaceMidpoint, mediaMidpoint),
  };
}

function changedFraction(referenceBuffer, controlBuffer, candidateBuffer,
  threshold = 8) {
  const reference = decode(referenceBuffer);
  const control = decode(controlBuffer);
  const candidate = decode(candidateBuffer);
  let changed = 0;
  let stable = 0;
  let total = 0;
  const x0 = Math.floor(reference.width * 0.18);
  const x1 = Math.ceil(reference.width * 0.82);
  const y0 = Math.floor(reference.height * 0.08);
  const y1 = Math.ceil(reference.height * 0.92);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const pixel = y * reference.width + x;
    total++;
    if (rgbDifference(reference, control, pixel) > 3) continue;
    if (rgbDifference(reference, candidate, pixel) > threshold) changed++;
    stable++;
  }
  return {
    changed: changed / Math.max(1, stable),
    stable: stable / Math.max(1, total),
  };
}

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) {
  console.log('Satellite eclipse visual test skipped: no hardware WebGPU browser.');
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

await mkdir(outputDir, { recursive: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

async function capture(name) {
  const buffer = await page.screenshot();
  await writeFile(new URL(`${name}.png`, outputDir), buffer);
  return buffer;
}

async function setMode(mode) {
  await page.evaluate((nextMode) => {
    const planet = NMS._planet(0);
    const setColorWrite = (material, enabled) => {
      if (!material || material.colorWrite === enabled) return;
      material.colorWrite = enabled;
      material.needsUpdate = true;
    };
    const mediaMaterials = [
      planet.atmoMesh?.material,
      planet.volCloudMat,
      planet.cloudMesh?.material,
      planet.cloudMesh2?.material,
      planet.cloudMeshNoctilucent?.material,
    ];
    setColorWrite(planet.terrainMaterial, nextMode !== 'media');
    setColorWrite(planet.liquidMat, nextMode !== 'media');
    for (const material of mediaMaterials) {
      setColorWrite(material, nextMode !== 'surface');
    }
  }, mode);
  await page.waitForTimeout(900);
}

async function setFixture(offsetRatio) {
  await page.evaluate((ratio) => {
    const planet = NMS._planet(0);
    NMS.setEclipseFixture(0, ratio == null ? null : {
      distance: planet.R * 3.5,
      radius: planet.R * 0.24,
      offset: planet.R * ratio,
      starAngularRadius: 0.012,
    });
  }, offsetRatio);
  await page.waitForTimeout(500);
}

try {
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgpu&quality=high`
    + '&nohero=1&farflora=0&vclouds=1&scene=orbit&planet=0&factor=0.72'
    + '&time=9.5&freeze=1');
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 60000 });
  await page.evaluate(() => {
    NMS.setAdaptiveQualityLocked(true);
    NMS.setWeatherFixture(0, 'cumulus');
  });
  // Global NMS.idle() includes every generated body and far-flora queue. It
  // may legitimately remain false for over a minute even though the focused
  // planet has stopped changing. Require the focused terrain count itself to
  // remain stable, then leave a short GPU pipeline-settle margin.
  await page.waitForFunction(() => {
    const count = NMS._planet(0)?.lod?.countChunks?.() || 0;
    const now = performance.now();
    if (!window.__eclipseChunkStability
      || window.__eclipseChunkStability.count !== count) {
      window.__eclipseChunkStability = { count, since: now };
      return false;
    }
    return count > 24 && now - window.__eclipseChunkStability.since > 1600;
  }, null, { timeout: 90000 });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    // Freeze the already-built focused quadtree. Pixel differencing should
    // measure eclipse/satellite visibility, not an unrelated LOD morph that
    // happens to complete between captures.
    const planet = NMS._planet(0);
    window.__eclipseLodFreeze = {
      terrain: planet.lod?.update,
      water: planet.waterLod?.update,
    };
    if (planet.lod) planet.lod.update = () => {};
    if (planet.waterLod) planet.waterLod.update = () => {};
  });

  // Surface-only shadow field.
  await setMode('surface');
  await setFixture(null);
  const surfaceReference = await capture('surface-reference');
  await page.waitForTimeout(350);
  const surfaceControl = await capture('surface-control');
  await setFixture(-0.28);
  const surfaceLeft = await capture('surface-shadow-left');
  await setFixture(0.28);
  const surfaceRight = await capture('surface-shadow-right');
  const surfaceLeftStats = shadowStats(surfaceReference, surfaceControl, surfaceLeft);
  const surfaceRightStats = shadowStats(surfaceReference, surfaceControl, surfaceRight);

  assert.ok(surfaceLeftStats.darkenedFraction > 0.004
      && surfaceLeftStats.darkenedFraction < 0.45,
  `left eclipse must form a bounded surface shadow: ${JSON.stringify(surfaceLeftStats)}`);
  assert.ok(surfaceRightStats.darkenedFraction > 0.004
      && surfaceRightStats.darkenedFraction < 0.45,
  `right eclipse must form a bounded surface shadow: ${JSON.stringify(surfaceRightStats)}`);
  assert.ok(centroidDistance(surfaceLeftStats.centroid, surfaceRightStats.centroid) > 0.035,
    `moving the satellite must move the surface-shadow centroid: `
    + `${JSON.stringify([surfaceLeftStats.centroid, surfaceRightStats.centroid])}`);
  assert.ok(Math.abs(surfaceLeftStats.globalDelta) < 3
      && Math.abs(surfaceRightStats.globalDelta) < 3,
  `local eclipse must not darken the full frame: `
    + `${surfaceLeftStats.globalDelta}, ${surfaceRightStats.globalDelta}`);

  // Media-only shadow field. Opaque terrain still writes depth, but colorWrite
  // is disabled so atmosphere/cloud changes can be measured independently.
  await setMode('media');
  await setFixture(null);
  const mediaReference = await capture('media-reference');
  await page.waitForTimeout(350);
  const mediaControl = await capture('media-control');
  await setFixture(-0.28);
  const mediaLeft = await capture('media-shadow-left');
  await setFixture(0.28);
  const mediaRight = await capture('media-shadow-right');
  const mediaLeftStats = shadowStats(mediaReference, mediaControl, mediaLeft);
  const mediaRightStats = shadowStats(mediaReference, mediaControl, mediaRight);

  // Defer the media assertions until after the z-occlusion fixture so one
  // failed lighting contract does not hide an independent depth-order result.
  const mediaShadowPresent = mediaLeftStats.darkenedFraction > 0.0015
    && mediaRightStats.darkenedFraction > 0.0015;
  const mediaShadowLocal = Math.abs(mediaLeftStats.globalDelta) < 3
    && Math.abs(mediaRightStats.globalDelta) < 3;
  const mediaAlignment = motionAlignment(
    surfaceLeftStats.centroid, surfaceRightStats.centroid,
    mediaLeftStats.centroid, mediaRightStats.centroid);
  const mediaShadowConcentric = mediaAlignment.cosine > 0.9
    && mediaAlignment.scale > 0.65
    && mediaAlignment.scale < 1.5
    && mediaAlignment.midpointDistance < 0.06;

  // Restore the complete frame, remove the eclipse fixture, then use an actual
  // generated moon group for front/behind depth ownership. updateVisual runs
  // after Universe.relativizeSystem() assigns the orbital position, so this
  // dev-only page override is stable without altering production code.
  await setMode('combined');
  await setFixture(null);
  await page.waitForTimeout(3200);
  const satelliteFixture = await page.evaluate(() => {
    const parent = NMS._planet(0);
    let moon = null;
    for (let index = 1; ; index++) {
      const candidate = NMS._planet(index);
      if (!candidate) break;
      if (candidate.spec?.parentId === parent.bodyId) {
        moon = candidate;
        break;
      }
    }
    if (!moon) return null;
    window.__satelliteOcclusionFixture = {
      parent,
      moon,
      phase: 'hidden',
      oldUpdateVisual: moon.updateVisual,
      oldVisible: moon.group.visible,
    };
    moon.group.visible = false;
    moon.updateVisual = function updateSatelliteOcclusionFixture() {
      const fixture = window.__satelliteOcclusionFixture;
      const forward = fixture.parent.group.position.clone().normalize();
      const referenceUp = Math.abs(forward.y) < 0.9
        ? new NMS._THREE.Vector3(0, 1, 0)
        : new NMS._THREE.Vector3(1, 0, 0);
      const right = new NMS._THREE.Vector3().crossVectors(forward, referenceUp).normalize();
      const depth = fixture.phase === 'front' ? -1.25 : 1.18;
      this.group.position.copy(fixture.parent.group.position)
        .addScaledVector(forward, fixture.parent.R * depth)
        .addScaledVector(right, fixture.parent.R * 0.1);
    };
    return {
      bodyId: moon.bodyId,
      radiusRatio: moon.R / parent.R,
    };
  });
  assert.ok(satelliteFixture, 'the canonical home world must provide a generated moon');
  await page.waitForTimeout(900);
  const satelliteHidden = await capture('satellite-hidden-reference');
  await page.waitForTimeout(650);
  const satelliteHiddenControl = await capture('satellite-hidden-control');

  await page.evaluate(() => {
    const fixture = window.__satelliteOcclusionFixture;
    fixture.phase = 'behind';
    fixture.moon.group.visible = true;
  });
  await page.waitForTimeout(650);
  const satelliteBehind = await capture('satellite-behind-planet');

  await page.evaluate(() => {
    window.__satelliteOcclusionFixture.phase = 'front';
  });
  await page.waitForTimeout(650);
  const satelliteFront = await capture('satellite-in-front');

  const behindChange = changedFraction(
    satelliteHidden, satelliteHiddenControl, satelliteBehind);
  const frontChange = changedFraction(
    satelliteHidden, satelliteHiddenControl, satelliteFront);
  const satelliteHiddenByDepth = behindChange.stable > 0.75
    && behindChange.changed < 0.0015;
  const satelliteVisibleInFront =
    frontChange.stable > 0.75
    && frontChange.changed > Math.max(0.0015, behindChange.changed * 4);

  await page.evaluate(() => {
    const fixture = window.__satelliteOcclusionFixture;
    fixture.moon.updateVisual = fixture.oldUpdateVisual;
    fixture.moon.group.visible = fixture.oldVisible;
    delete window.__satelliteOcclusionFixture;
  });

  console.log(JSON.stringify({
    surfaceLeftStats,
    surfaceRightStats,
    mediaLeftStats,
    mediaRightStats,
    mediaShadowPresent,
    mediaShadowLocal,
    mediaShadowConcentric,
    mediaAlignment,
    satelliteFixture,
    behindChange,
    frontChange,
    satelliteHiddenByDepth,
    satelliteVisibleInFront,
  }, null, 2));
  assert.ok(satelliteHiddenByDepth,
    `a moon behind the planet must be depth-occluded, not drawn on top: `
    + `${JSON.stringify(behindChange)}`);
  assert.ok(satelliteVisibleInFront,
    `the same moon must become visible when moved in front: `
    + `${JSON.stringify({ behindChange, frontChange, satelliteFixture })}`);
  assert.ok(mediaShadowPresent,
    `cloud/atmosphere must receive the local satellite shadow: `
    + `${JSON.stringify([mediaLeftStats, mediaRightStats])}`);
  assert.ok(mediaShadowLocal,
    `media eclipse must remain local rather than dim the whole frame: `
    + `${mediaLeftStats.globalDelta}, ${mediaRightStats.globalDelta}`);
  assert.ok(mediaShadowConcentric,
    `surface, cloud and atmosphere shadows must remain concentric: `
    + `${JSON.stringify({
      surface: [surfaceLeftStats.centroid, surfaceRightStats.centroid],
      media: [mediaLeftStats.centroid, mediaRightStats.centroid],
      alignment: mediaAlignment,
    })}`);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS: satellite eclipse centroids, media alignment and z occlusion');
} finally {
  await page.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
