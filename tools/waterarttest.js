import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const OUT = `test-results/water-art/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(OUT, { recursive: true });
const fingerprint = await evidenceFingerprint('tools/waterarttest.js');

function roiDelta(aBuffer, bBuffer, bounds = [0.08, 0.12, 0.72, 0.82]) {
  const a = PNG.sync.read(aBuffer);
  const b = PNG.sync.read(bBuffer);
  let sum = 0;
  let samples = 0;
  const [x0, y0, x1, y1] = bounds;
  for (let y = Math.floor(a.height * y0); y < a.height * y1; y += 2) {
    for (let x = Math.floor(a.width * x0); x < a.width * x1; x += 2) {
      const i = (y * a.width + x) * 4;
      sum += Math.abs(a.data[i] - b.data[i]);
      sum += Math.abs(a.data[i + 1] - b.data[i + 1]);
      sum += Math.abs(a.data[i + 2] - b.data[i + 2]);
      samples += 3;
    }
  }
  return sum / Math.max(1, samples) / 255;
}

function roiMoments(buffer, bounds = [0.08, 0.12, 0.72, 0.82]) {
  const png = PNG.sync.read(buffer);
  let samples = 0;
  let mean = 0;
  let m2 = 0;
  const [x0, y0, x1, y1] = bounds;
  for (let y = Math.floor(png.height * y0); y < png.height * y1; y += 2) {
    for (let x = Math.floor(png.width * x0); x < png.width * x1; x += 2) {
      const i = (y * png.width + x) * 4;
      const value = (png.data[i] * 0.2126 + png.data[i + 1] * 0.7152
        + png.data[i + 2] * 0.0722) / 255;
      samples++;
      const delta = value - mean;
      mean += delta / samples;
      m2 += delta * (value - mean);
    }
  }
  return { mean, sd: Math.sqrt(m2 / Math.max(1, samples)), samples };
}

function roiMeanRgb(buffer, bounds) {
  const png = PNG.sync.read(buffer);
  const sum = [0, 0, 0];
  let samples = 0;
  for (let y = Math.floor(png.height * bounds[1]); y < png.height * bounds[3]; y += 2) {
    for (let x = Math.floor(png.width * bounds[0]); x < png.width * bounds[2]; x += 2) {
      const i = (y * png.width + x) * 4;
      sum[0] += png.data[i] / 255;
      sum[1] += png.data[i + 1] / 255;
      sum[2] += png.data[i + 2] / 255;
      samples++;
    }
  }
  return sum.map((value) => value / Math.max(1, samples));
}

function roiQuality(buffer, bounds) {
  const png = PNG.sync.read(buffer);
  const [x0, y0, x1, y1] = bounds;
  const rows = [];
  const cols = [];
  const pixels = [];
  let clipped = 0;
  let warm = 0;
  let warmHighlight = 0;
  let highlights = 0;
  let red = 0, green = 0, blue = 0;
  for (let y = Math.floor(png.height * y0); y < png.height * y1; y += 2) {
    let rowSum = 0, rowCount = 0;
    let colIndex = 0;
    for (let x = Math.floor(png.width * x0); x < png.width * x1; x += 2) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i] / 255;
      const g = png.data[i + 1] / 255;
      const b = png.data[i + 2] / 255;
      const value = r * 0.2126 + g * 0.7152 + b * 0.0722;
      pixels.push(value);
      rowSum += value;
      cols[colIndex] = (cols[colIndex] || 0) + value;
      red += r;
      green += g;
      blue += b;
      if (r > 0.965 && g > 0.965 && b > 0.965) clipped++;
      const isWarm = r > b * 1.08 && r > g * 1.025;
      if (isWarm) warm++;
      if (value > 0.72) {
        highlights++;
        if (isWarm) warmHighlight++;
      }
      rowCount++;
      colIndex++;
    }
    rows.push(rowSum / Math.max(1, rowCount));
  }
  const rowCount = rows.length;
  for (let i = 0; i < cols.length; i++) cols[i] /= Math.max(1, rowCount);
  const mean = pixels.reduce((sum, value) => sum + value, 0) / Math.max(1, pixels.length);
  const variance = pixels.reduce((sum, value) => sum + (value - mean) ** 2, 0)
    / Math.max(1, pixels.length);
  const directionalCoherence = (series) => {
    const residual = series.map((value, index) => {
      const lo = Math.max(0, index - 12);
      const hi = Math.min(series.length, index + 13);
      let local = 0;
      for (let i = lo; i < hi; i++) local += series[i];
      return value - local / (hi - lo);
    });
    const residualVariance = residual.reduce((sum, value) => sum + value * value, 0)
      / Math.max(1, residual.length);
    const gradient = residual.slice(1).map((value, index) => value - residual[index]);
    const correlation = (lag) => {
      let numerator = 0, a2 = 0, b2 = 0;
      for (let i = lag; i < gradient.length; i++) {
        numerator += gradient[i] * gradient[i - lag];
        a2 += gradient[i] ** 2;
        b2 += gradient[i - lag] ** 2;
      }
      return numerator / Math.sqrt(Math.max(1e-12, a2 * b2));
    };
    let periodicity = 0;
    for (let lag = 6; lag <= Math.min(72, gradient.length / 3); lag++) {
      periodicity = Math.max(periodicity, correlation(lag));
    }
    const absoluteGradient = gradient.map(Math.abs).sort((a, b) => a - b);
    const medianGradient = absoluteGradient[Math.floor(absoluteGradient.length / 2)] || 0;
    const maxGradient = Math.max(0, ...absoluteGradient);
    return {
      coherence: residualVariance / Math.max(1e-8, variance),
      periodicity,
      seamRatio: maxGradient / Math.max(0.0015, medianGradient),
    };
  };
  return {
    mean,
    sd: Math.sqrt(variance),
    rgb: [red, green, blue].map((value) => value / Math.max(1, pixels.length)),
    clippedFraction: clipped / Math.max(1, pixels.length),
    warmFraction: warm / Math.max(1, pixels.length),
    warmHighlightFraction: warmHighlight / Math.max(1, highlights),
    horizontal: directionalCoherence(rows),
    vertical: directionalCoherence(cols),
  };
}

function sunPathAlignment(buffer) {
  const png = PNG.sync.read(buffer);
  const weightedCenter = (bounds, predicate) => {
    let weight = 0, weightedX = 0, samples = 0;
    for (let y = Math.floor(png.height * bounds[1]); y < png.height * bounds[3]; y += 2) {
      for (let x = Math.floor(png.width * bounds[0]); x < png.width * bounds[2]; x += 2) {
        const i = (y * png.width + x) * 4;
        const r = png.data[i] / 255;
        const g = png.data[i + 1] / 255;
        const b = png.data[i + 2] / 255;
        const value = r * 0.2126 + g * 0.7152 + b * 0.0722;
        const pixelWeight = predicate(r, g, b, value);
        if (pixelWeight <= 0) continue;
        weight += pixelWeight;
        weightedX += (x / png.width) * pixelWeight;
        samples++;
      }
    }
    return { x: weightedX / Math.max(1e-8, weight), weight, samples };
  };
  const sun = weightedCenter([0.04, 0.04, 0.96, 0.49], (r, g, b, value) =>
    value > 0.58 && r > b * 1.02 && r > g * 0.985
      ? (value - 0.58) * Math.max(0.01, r - b) : 0);
  const reflection = weightedCenter([0.04, 0.49, 0.96, 0.94], (r, g, b, value) =>
    value > 0.36 && r > b * 1.055 && r > g * 1.005
      ? (value - 0.36) * Math.max(0.01, r - b) : 0);
  return {
    sun,
    reflection,
    horizontalDelta: Math.abs(sun.x - reflection.x),
  };
}

function wakeMorphology(onBuffer, offBuffer, bounds = [0.08, 0.22, 0.92, 0.94]) {
  const on = PNG.sync.read(onBuffer);
  const off = PNG.sync.read(offBuffer);
  const [x0, y0, x1, y1] = bounds;
  let samples = 0, changed = 0, high = 0, left = 0, right = 0;
  const energyByDepth = [0, 0, 0, 0];
  const samplesByDepth = [0, 0, 0, 0];
  for (let y = Math.floor(on.height * y0); y < on.height * y1; y += 2) {
    const depthBin = Math.min(3, Math.floor(((y / on.height) - y0) / (y1 - y0) * 4));
    for (let x = Math.floor(on.width * x0); x < on.width * x1; x += 2) {
      const i = (y * on.width + x) * 4;
      const delta = (Math.abs(on.data[i] - off.data[i])
        + Math.abs(on.data[i + 1] - off.data[i + 1])
        + Math.abs(on.data[i + 2] - off.data[i + 2])) / (255 * 3);
      samples++;
      energyByDepth[depthBin] += delta;
      samplesByDepth[depthBin]++;
      if (delta < 0.045) continue;
      changed++;
      if (delta > 0.22) high++;
      if (x < on.width * 0.5) left++;
      else right++;
    }
  }
  return {
    changedFraction: changed / Math.max(1, samples),
    highFraction: high / Math.max(1, changed),
    bilateralRatio: Math.min(left, right) / Math.max(1, Math.max(left, right)),
    energyByDepth: energyByDepth.map((value, index) =>
      value / Math.max(1, samplesByDepth[index])),
  };
}

function wakeLateralSpread(onBuffer, offBuffer, bounds, centerX = 0.5) {
  const on = PNG.sync.read(onBuffer);
  const off = PNG.sync.read(offBuffer);
  const [x0, y0, x1, y1] = bounds;
  let weight = 0;
  let weightedDistance = 0;
  let active = 0;
  for (let y = Math.floor(on.height * y0); y < on.height * y1; y += 2) {
    for (let x = Math.floor(on.width * x0); x < on.width * x1; x += 2) {
      const i = (y * on.width + x) * 4;
      const delta = (Math.abs(on.data[i] - off.data[i])
        + Math.abs(on.data[i + 1] - off.data[i + 1])
        + Math.abs(on.data[i + 2] - off.data[i + 2])) / (255 * 3);
      const signal = Math.max(0, delta - 0.025);
      if (signal <= 0) continue;
      weight += signal;
      weightedDistance += Math.abs(x / on.width - centerX) * signal;
      active++;
    }
  }
  return {
    normalized: weightedDistance / Math.max(weight, 1e-8) / Math.max(1e-6, x1 - x0),
    weight,
    active,
  };
}

function wakeShoulderEnergy(onBuffer, offBuffer, bounds, centerX = 0.5) {
  const on = PNG.sync.read(onBuffer);
  const off = PNG.sync.read(offBuffer);
  const [x0, y0, x1, y1] = bounds;
  const left = Math.floor(on.width * x0);
  const top = Math.floor(on.height * y0);
  const width = Math.floor(on.width * (x1 - x0));
  const height = Math.floor(on.height * (y1 - y0));
  const energy = [0, 0, 0, 0];
  const samples = [0, 0, 0, 0];
  const sideEnergy = [0, 0];
  const sideSamples = [0, 0];
  for (let localY = 0; localY < height; localY += 2) {
    const t = localY / Math.max(1, height);
    // The authored pressure system ends within the first 72% of this ROI. The
    // lower foreground contains a large moving solar glint, not wake; stop at
    // the physical tail and divide that complete shoulder span into four bins.
    if (t > 0.72) continue;
    const depthBin = Math.min(3, Math.floor(t / 0.72 * 4));
    const halfWidth = width * (0.02 + Math.max(0, t - 0.08) * 0.34);
    const bandWidth = 18 + t * 20;
    for (let localX = 0; localX < width; localX += 2) {
      const fromCenter = (left + localX) - on.width * centerX;
      if (Math.abs(Math.abs(fromCenter) - halfWidth) > bandWidth) continue;
      const x = left + localX;
      const y = top + localY;
      const i = (y * on.width + x) * 4;
      const delta = (Math.abs(on.data[i] - off.data[i])
        + Math.abs(on.data[i + 1] - off.data[i + 1])
        + Math.abs(on.data[i + 2] - off.data[i + 2])) / (255 * 3);
      energy[depthBin] += delta;
      samples[depthBin]++;
      const side = fromCenter < 0 ? 0 : 1;
      sideEnergy[side] += delta;
      sideSamples[side]++;
    }
  }
  return {
    byDepth: energy.map((value, index) => value / Math.max(1, samples[index])),
    bySide: sideEnergy.map((value, index) => value / Math.max(1, sideSamples[index])),
  };
}

// Geometry-owned projected samples: neither mask placement nor membership reads
// image brightness. Each source supplies a finite shoulder strip; duplicate
// pixels are counted once. This is separate from the legacy screen-V report.
async function projectedWakeMask({ supplement = false } = {}) {
  return page.evaluate(async ({ supplement }) => {
    const { sampleOceanWakePacket } = await import('/src/ocean-wake-packet.js');
    const T = NMS._THREE, p = NMS._planet(0);
    const snapshot = NMS.waterWakeDebug();
    const entries = snapshot.field.filter((entry) => entry.data[2] > 0.001 && entry.direction[3] > 0.5);
    const sources = entries.map((entry) => {
      const position = new T.Vector3().fromArray(entry.position);
      const up = position.clone().normalize();
      const axis = new T.Vector3().fromArray(entry.direction).addScaledVector(up,
        -new T.Vector3().fromArray(entry.direction).dot(up)).normalize();
      return { entry, position, up, axis, side: up.clone().cross(axis).normalize() };
    });
    if (!sources.length) throw new Error('No live packet sources for projected mask');
    const origin = sources[0].position.clone();
    const forward = sources[0].axis.clone();
    const packet = (source, along, lateral) => sampleOceanWakePacket({ along, lateral,
      age: source.entry.data[0], speed: source.entry.data[1], strength: source.entry.data[2] });
    let front = -Infinity, tail = Infinity;
    for (const source of sources) {
      const q = packet(source, 0, 0);
      const center = source.position.clone().sub(origin).dot(forward) + q.centerAlong;
      front = Math.max(front, center + 3 * q.length);
      tail = Math.min(tail, center - 3 * q.length);
    }
    const span = front - tail;
    const mid = origin.clone().addScaledVector(forward, (front + tail) * 0.5);
    const up = mid.clone().normalize();
    p.group.updateMatrixWorld(true);
    let camera = NMS._internals.camera;
    let supplementPose = null;
    if (supplement) {
      camera = camera.clone();
      // A fixed oblique overview of the complete world support, not a new
      // packet and not a substitute for the normal HUD/chase view above.
      const height = Math.max(100, span * 1.6);
      camera.position.copy(p.group.localToWorld(mid.clone().addScaledVector(up, height)
        .addScaledVector(forward, -span * 0.55)));
      camera.up.copy(p.localOffsetToWorld(up, new T.Vector3())).normalize();
      camera.lookAt(p.group.localToWorld(mid.clone()));
      camera.updateMatrixWorld(true);
      supplementPose = { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(),
        description: 'fixed complete-packet oblique attribution camera; normal post/HUD retained' };
    }
    camera.updateMatrixWorld(true);
    const points = [], support = [];
    const project = (local) => {
      const direction = local.clone().normalize();
      const surface = p.sampleWaterSurface(local, snapshot.hours, { normal: false });
      const world = p.group.localToWorld(direction.multiplyScalar(surface.surfaceRadius));
      const view = camera.worldToLocal(world.clone());
      const ndc = world.project(camera);
      return { x: ndc.x * 0.5 + 0.5, y: 0.5 - ndc.y * 0.5,
        visible: view.z < -camera.near && Math.abs(ndc.x) < 0.98 && Math.abs(ndc.y) < 0.98 };
    };
    const allSupport = (local) => sources.some((source) => {
      const delta = local.clone().sub(source.position);
      const q = packet(source, delta.dot(source.axis), delta.dot(source.side));
      return q.armEnvelope + q.coreEnvelope + q.centerEnvelope > 0;
    });
    for (const source of sources) {
      const initial = packet(source, 0, 0);
      for (let row = 0; row <= 48; row++) {
        const along = initial.centerAlong + initial.length * (3 - row / 48 * 6);
        const q = packet(source, along, 0);
        for (const sign of [-1, 1]) {
          // Check the full finite support, not only the bright central band.
          const boundary = source.position.clone().addScaledVector(source.axis, along)
            .addScaledVector(source.side, sign * (q.armCenter + 3 * q.width));
          support.push(project(boundary));
          for (const offset of [-1, -0.5, 0, 0.5, 1]) {
            const local = source.position.clone().addScaledVector(source.axis, along)
              .addScaledVector(source.side, sign * (q.armCenter + offset * q.width));
            const distance = local.clone().sub(origin).dot(forward);
            const bin = Math.min(3, Math.max(0, Math.floor((front - distance) / span * 4)));
            points.push({ ...project(local), side: sign < 0 ? 0 : 1, bin, boundary: false });
          }
        }
      }
      // Outer tails of intermediate sources may overlap younger packets.
      // Exclude them using ALL packet supports, never call that overlap decay.
      for (const edge of [-1, 1]) for (const sign of [-1, 1]) {
        const along = initial.centerAlong + edge * initial.length * 3.12;
        const q = packet(source, along, 0);
        for (const offset of [-1, 0, 1]) {
          const local = source.position.clone().addScaledVector(source.axis, along)
            .addScaledVector(source.side, sign * (q.armCenter + offset * q.width));
          if (!allSupport(local)) points.push({ ...project(local), side: sign < 0 ? 0 : 1,
            bin: 3, boundary: true });
        }
      }
    }
    return { points, support, front, tail, span, sourceCount: sources.length,
      complete: support.every((point) => point.visible),
      visibleSupportFraction: support.filter((point) => point.visible).length / support.length,
      supplementPose };
  }, { supplement });
}

function projectedWakeEnergy(onBuffer, offBuffer, mask) {
  const on = PNG.sync.read(onBuffer), off = PNG.sync.read(offBuffer);
  // World-projected probes generally land between pixels. Nearest-pixel
  // rounding aliases narrow, high-contrast shoulders even with a stable
  // OFF/OFF control. Sample the actual projected
  // coordinate bilinearly; keep the physical mask and all thresholds unchanged.
  const channelAt = (png, x, y, channel) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const at = (dx, dy) => png.data[(Math.min(png.height - 1, iy + dy)
      * png.width + Math.min(png.width - 1, ix + dx)) * 4 + channel];
    return at(0, 0) * (1 - fx) * (1 - fy) + at(1, 0) * fx * (1 - fy)
      + at(0, 1) * (1 - fx) * fy + at(1, 1) * fx * fy;
  };
  const energy = [0, 0, 0, 0], count = [0, 0, 0, 0];
  const sides = [0, 0], sideCount = [0, 0];
  let boundary = 0, boundaryCount = 0;
  const seen = new Set();
  for (const point of mask.points) {
    if (!point.visible) continue;
    const x = point.x * (on.width - 1), y = point.y * (on.height - 1);
    const key = `${Math.round(x)}:${Math.round(y)}:${point.boundary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const delta = [0, 1, 2].reduce((sum, channel) => sum
      + Math.abs(channelAt(on, x, y, channel) - channelAt(off, x, y, channel)), 0) / 765;
    if (point.boundary) { boundary += delta; boundaryCount++; }
    else {
      energy[point.bin] += delta; count[point.bin]++;
      sides[point.side] += delta; sideCount[point.side]++;
    }
  }
  return { byDepth: energy.map((v, i) => v / Math.max(1, count[i])),
    bySide: sides.map((v, i) => v / Math.max(1, sideCount[i])),
    boundary: boundary / Math.max(1, boundaryCount), count, sideCount, boundaryCount };
}

function wakeConnectivity(onBuffer, offBuffer, bounds = [0.15, 0.22, 0.85, 0.94]) {
  const on = PNG.sync.read(onBuffer);
  const off = PNG.sync.read(offBuffer);
  const step = 4;
  const left = Math.floor(on.width * bounds[0]);
  const top = Math.floor(on.height * bounds[1]);
  const width = Math.floor(on.width * (bounds[2] - bounds[0]));
  const height = Math.floor(on.height * (bounds[3] - bounds[1]));
  const cols = Math.ceil(width / step);
  const rows = Math.ceil(height / step);
  const mask = new Uint8Array(cols * rows);
  let active = 0;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x = Math.min(on.width - 1, left + gx * step);
      const y = Math.min(on.height - 1, top + gy * step);
      const i = (y * on.width + x) * 4;
      const delta = (Math.abs(on.data[i] - off.data[i])
        + Math.abs(on.data[i + 1] - off.data[i + 1])
        + Math.abs(on.data[i + 2] - off.data[i + 2])) / (255 * 3);
      if (delta >= 0.05) {
        mask[gy * cols + gx] = 1;
        active++;
      }
    }
  }
  const visited = new Uint8Array(mask.length);
  const components = [];
  const queue = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    queue.length = 0;
    queue.push(start);
    visited[start] = 1;
    let size = 0, minY = rows, maxY = 0, sumX = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const index = queue[cursor];
      const y = Math.floor(index / cols);
      const x = index - y * cols;
      size++;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      sumX += x;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oy) continue;
          const nx = x + ox, ny = y + oy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          const next = ny * cols + nx;
          if (!mask[next] || visited[next]) continue;
          visited[next] = 1;
          queue.push(next);
        }
      }
    }
    components.push({
      size,
      fraction: size / Math.max(1, active),
      centerX: sumX / Math.max(1, size) / cols,
      minY: minY / rows,
      maxY: maxY / rows,
    });
  }
  components.sort((a, b) => b.size - a.size);
  return {
    activeFraction: active / Math.max(1, rows * cols),
    dominantFraction: components.slice(0, 2)
      .reduce((sum, component) => sum + component.fraction, 0),
    components: components.slice(0, 6),
  };
}

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) throw new Error('System Chrome/Edge is required for the water art gate.');
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
});
const page = await context.newPage();
const video = page.video();
const errors = [];
page.on('pageerror', (error) => errors.push(error.stack || String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

async function settle(index = 0) {
  try {
    await page.waitForFunction((planetIndex) => {
      const planet = NMS._planet(planetIndex);
      return planet?.lod?.debugStats?.().pending === 0
        && planet?.waterLod?.debugStats?.().pending === 0
        && planet?.nearWaterPatch?.debugStats?.().pending === false;
    }, index, { timeout: 150000, polling: 250 });
  } catch (error) {
    const state = await page.evaluate((i) => ({ stats: NMS.stats(),
      water: NMS.waterState(i), terrain: NMS._planet(i)?.lod?.debugStats?.() }), index);
    await writeFile(`${OUT}/settle-failure.json`, JSON.stringify(state, null, 2));
    await shot('settle-failure');
    throw error;
  }
  await page.waitForTimeout(1200);
}

async function shot(name) {
  const buffer = await page.screenshot();
  await writeFile(`${OUT}/${name}.png`, buffer);
  return buffer;
}

try {
  const url = `http://127.0.0.1:${port}/?renderer=auto&quality=ultra&nohero=1`
    + '&vclouds=1&farflora=1&post=1&freeze=1&buildms=80';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 90000 });
  const wadeFixture = await page.evaluate(() => {
    const result = NMS.setWade(0, { depth: 0.9, overview: false, look: 'sea' });
    const planet = NMS._planet(0);
    const THREE = NMS._THREE;
    const direction = new THREE.Vector3(...result.direction);
    const landward = new THREE.Vector3(...result.landward);
    const samples = [-1000, -500, -100, 0, 100, 500, 1000].map((distance) => {
      const sample = direction.clone().addScaledVector(landward, distance / planet.R).normalize();
      return [distance, planet.seaLevel - planet.height(sample, planet.fullMaxFreq)];
    });
    const visual = NMS.setWade(0, {
      depth: 0.9, overview: true, overviewHeight: 92, look: 'sea',
    });
    NMS.setLocalSunAltitude(0, 34);
    return { ...result, samples, visual };
  });
  await settle(0);
  const shallowOn = await shot('01-shallow-water-player');
  await page.keyboard.press('KeyH');
  const shallowClean = await shot('01-shallow-water-clean');
  const onState = await page.evaluate(() => {
    const planet = NMS._planet(0);
    const material = planet.liquidMat;
    const nearMesh = planet.nearWaterPatch.mesh;
    const nearDepth = nearMesh.geometry.getAttribute('aDepth');
    let nearWet = 0;
    let nearMinDepth = Infinity;
    let nearMaxDepth = -Infinity;
    for (let i = 0; i < nearDepth.count; i++) {
      const depth = nearDepth.getX(i);
      if (depth > 0.025) nearWet++;
      nearMinDepth = Math.min(nearMinDepth, depth);
      nearMaxDepth = Math.max(nearMaxDepth, depth);
    }
    const fragment = material.userData.shader?.fragmentShader || '';
    return {
      stats: NMS.stats(),
      water: NMS.waterState(0),
      nearAttributes: ['aLodMorph', 'aNearPatchPass', 'aDepth']
        .every((name) => material.userData.shader
          && NMS._planet(0).nearWaterPatch.mesh.geometry.hasAttribute(name)),
      nearMesh: {
        visible: nearMesh.visible,
        materialVisible: material.visible,
        frustumCulled: nearMesh.frustumCulled,
        position: nearMesh.position.toArray(),
        boundCenter: nearMesh.geometry.boundingSphere?.center?.toArray?.(),
        boundRadius: nearMesh.geometry.boundingSphere?.radius,
        wetFraction: nearWet / nearDepth.count,
        minDepth: nearMinDepth,
        maxDepth: nearMaxDepth,
        uniformCenter: material.userData.waterUniforms.uNearPatchCenter.value.toArray(),
        uniformRadius: material.userData.waterUniforms.uNearPatchRadius.value,
      },
      shaderDiagnostics: {
        controlledShallowAlpha: fragment.includes('1.0 - transmittedEnergy * (1.0 - interfaceFresnel)')
          && fragment.includes('exp(-uAbsorption * waterPath)'),
        unresolvedTransmissionInclude: fragment.includes('#include <transmission_fragment>'),
        materialTransmission: material.transmission,
        materialTransparent: material.transparent,
        materialDepthWrite: material.depthWrite,
        liquidColor: material.color.toArray(),
        shallowColor: material.userData.shader?.uniforms?.uShallowC?.value?.toArray?.(),
        deepColor: material.userData.shader?.uniforms?.uDeepC?.value?.toArray?.(),
      },
    };
  });
  assert.deepEqual(errors, [], errors.join('\n'));
  const shallowBounds = [0.03, 0.53, 0.38, 0.94];
  const shallowMoments = roiMoments(shallowClean, shallowBounds);
  const shallowQuality = roiQuality(shallowClean, shallowBounds);
  await page.evaluate(() => { NMS._planet(0).liquidMat.visible = false; });
  await page.waitForTimeout(300);
  const materialOff = await shot('02-shallow-water-off-reference');
  const materialDelta = roiDelta(shallowClean, materialOff, shallowBounds);
  await page.evaluate(() => { NMS._planet(0).liquidMat.visible = true; });
  await page.keyboard.press('KeyH');
  console.log(JSON.stringify({
    materialDelta,
    shallowMoments,
    shallowQuality,
    wadeFixture,
    nearWater: onState.water.near,
    nearMesh: onState.nearMesh,
    shaderDiagnostics: onState.shaderDiagnostics,
  }, null, 2));
  assert.ok(materialDelta >= 0.02,
    `the near water surface must materially own the player frame, ROI delta ${materialDelta.toFixed(4)}`);
  assert.ok(shallowMoments.sd >= 0.045,
    `shallow water must retain readable structure, ROI sd ${shallowMoments.sd.toFixed(4)}`);
  assert.ok(shallowQuality.horizontal.coherence < 0.24,
    `water-only ROI contains coherent horizontal striping (${shallowQuality.horizontal.coherence.toFixed(3)})`);
  assert.ok(shallowQuality.vertical.coherence < 0.24,
    `water-only ROI contains coherent vertical/rectangular partitioning (${shallowQuality.vertical.coherence.toFixed(3)})`);
  assert.ok(shallowQuality.horizontal.periodicity < 0.72
    && shallowQuality.vertical.periodicity < 0.72,
  `water-only ROI contains repeated periodic structure: ${JSON.stringify(shallowQuality)}`);
  assert.equal(onState.water.near.cellSize, 4);
  assert.equal(onState.water.near.pending, false);
  assert.equal(onState.nearAttributes, true);
  assert.equal(onState.shaderDiagnostics.materialTransmission, 0);
  assert.equal(onState.shaderDiagnostics.materialTransparent, true);
  assert.equal(onState.shaderDiagnostics.materialDepthWrite, true);
  assert.equal(onState.shaderDiagnostics.controlledShallowAlpha, true);

  const shoreFixture = await page.evaluate(() =>
    NMS.setWade(0, {
      depth: 0.9, overview: true, overviewHeight: 92, look: 'land',
    }));
  await settle(0);
  await shot('02-coast-overview-player');
  await page.keyboard.press('KeyH');
  const coastClean = await shot('02-coast-overview-clean');
  await page.keyboard.press('KeyH');
  const coastWaterQuality = roiQuality(coastClean, [0.03, 0.5, 0.46, 0.94]);
  const offshoreColor = roiMeanRgb(coastClean, [0.03, 0.62, 0.16, 0.9]);
  const shelfColor = roiMeanRgb(coastClean, [0.28, 0.62, 0.41, 0.9]);
  const shelfColorDistance = Math.hypot(...shelfColor.map((value, index) =>
    value - offshoreColor[index]));
  assert.ok(shoreFixture.actualDepth > 0.45 && shoreFixture.actualDepth < 1.35,
    `shore player fixture must remain in wading depth, got ${shoreFixture.actualDepth.toFixed(2)} m`);
  assert.ok(shoreFixture.shoreCurvature > 8,
    `shore overview must show a genuinely curved coastline, got ${shoreFixture.shoreCurvature.toFixed(2)} m`);
  assert.ok(coastWaterQuality.horizontal.coherence < 0.3,
    `coast water contains coherent striping (${coastWaterQuality.horizontal.coherence.toFixed(3)})`);
  assert.ok(shelfColorDistance > 0.025,
    `the same coast view must separate offshore and shelf water: ${JSON.stringify({ offshoreColor, shelfColor, shelfColorDistance })}`);

  await page.evaluate(() => {
    NMS.setSunAltitude(0, 12);
    NMS.setLocalSunAltitude(0, 12);
    NMS.setWaterWake(0, { height: 8, speed: 150 });
    NMS.shipViewDebug.setViewMode('chase');
  });
  await settle(0);
  assert.equal(await page.evaluate(() => NMS.startWaterWake()), true);
  await page.waitForTimeout(750);
  assert.equal(await page.evaluate(() => NMS.holdWaterWake()), true);
  await page.waitForTimeout(600);
  await shot('03a-directional-wake-early-player');
  await page.keyboard.press('KeyH');
  const packetAges = [0, 0.7, 1.5, 2.6];
  const packetFrames = [];
  const assertSameSnapshot = (a, b) => {
    assert.deepEqual(a.field, b.field, 'optical A/B must retain identical packet contents and ages');
    assert.equal(a.cursor, b.cursor);
    assert.equal(a.hours, b.hours, 'A/B world clock must not advance');
    assert.equal(a.oceanSeconds, b.oceanSeconds, 'A/B wave clock must not advance');
    assert.equal(a.gradeTime, b.gradeTime, 'A/B film grain sample must not advance');
    for (const key of ['position', 'quaternion', 'cameraPosition', 'cameraQuaternion']) {
      assert.ok(a[key].every((value, i) => Math.abs(value - b[key][i]) < 1e-6), `A/B ${key} changed`);
    }
    assert.ok(Math.abs(a.exposure - b.exposure) < 1e-6,
      `A/B exposure changed: before=${a.exposure}, after=${b.exposure}, delta=${b.exposure - a.exposure}`);
  };
  for (let i = 0; i < packetAges.length; i++) {
    if (i) assert.equal(await page.evaluate((dt) => NMS.advanceWaterWake(dt), packetAges[i] - packetAges[i - 1]), true);
    assert.equal(await page.evaluate(() => NMS.muteWaterWake(false)), true);
    await page.waitForTimeout(100);
    const before = await page.evaluate(() => NMS.waterWakeDebug());
    const on = await shot(`03-packet-age-${i}-on-clean`);
    assert.equal(await page.evaluate(() => NMS.muteWaterWake(true)), true);
    await page.waitForTimeout(100);
    const off = await shot(`03-packet-age-${i}-off-clean`);
    const after = await page.evaluate(() => NMS.waterWakeDebug());
    assertSameSnapshot(before, after);
    if (i) {
      const initial = packetFrames[0].snapshot;
      assert.equal(before.cursor, initial.cursor, 'age series must never inject/restart');
      before.field.forEach((entry, index) => {
        assert.deepEqual(entry.position, initial.field[index].position);
        assert.deepEqual(entry.direction, initial.field[index].direction);
        assert.deepEqual(entry.data.slice(1), initial.field[index].data.slice(1));
        assert.ok(Math.abs(entry.data[0] - initial.field[index].data[0] - packetAges[i]) < 1e-9);
      });
      assert.equal(before.hours, initial.hours);
      for (const key of ['position', 'quaternion', 'cameraPosition', 'cameraQuaternion']) {
        assert.ok(before[key].every((value, index) => Math.abs(value - initial[key][index]) < 1e-6), `age-series ${key} changed`);
      }
    }
    packetFrames.push({ on, off, snapshot: before, age: packetAges[i] });
  }
  const wakeEarly = packetFrames[0].on;
  const wakeEarlyOff = packetFrames[0].off;
  await writeFile(`${OUT}/packet-snapshots.json`, JSON.stringify(packetFrames.map(({ age, snapshot }) => ({ age, snapshot })), null, 2));
  await page.keyboard.press('KeyH');
  // Separate continuous moving-trail evidence. This is deliberately NOT the
  // older state of the fixed packet above and cannot prove age diffusion.
  assert.equal(await page.evaluate(() => NMS.startWaterWake()), true);
  await page.waitForTimeout(2600);
  assert.equal(await page.evaluate(() => NMS.holdWaterWake()), true);
  await page.waitForTimeout(600);
  const wakeOn = await shot('03-directional-wake-player');
  await page.keyboard.press('KeyH');
  const wakeClean = await shot('03-directional-wake-clean');
  const wakeState = await page.evaluate(() => ({
    stats: NMS.stats(),
    field: NMS.waterField(),
    renderedPressureSystems: NMS._planet(0).liquidMat.userData.waterUniforms.uRippleCount.value,
  }));
  const movingSnapshot = await page.evaluate(() => NMS.waterWakeDebug());
  assert.ok(wakeState.stats.waterInteractions >= 2,
    'the moving hull must leave multiple directional wake segments');
  const visibleWakeImpulses = wakeState.field.filter((entry) => entry.screen[2] >= 0
    && entry.screen[2] <= 1 && Math.abs(entry.screen[0]) <= 1 && Math.abs(entry.screen[1]) <= 1).length;
  const visibleWakeField = wakeState.field.filter((entry) => entry.screen[2] >= 0
    && entry.screen[2] <= 1 && Math.abs(entry.screen[0]) <= 1 && Math.abs(entry.screen[1]) <= 1);
  const wakeCenterX = visibleWakeField.reduce((sum, entry) => sum + entry.screen[0] * 0.5 + 0.5, 0)
    / Math.max(1, visibleWakeField.length);
  // Source points need not be on-screen for their finite pressure footprint
  // to be visible. Keep the origin count as telemetry; the world-projected
  // shoulder coverage and optical signal below own player-facing acceptance.
  assert.ok(wakeState.renderedPressureSystems >= 3
      && wakeState.renderedPressureSystems <= 12,
  `the renderer must retain a bounded multi-age Kelvin packet, got ${wakeState.renderedPressureSystems}`);
  assert.equal(await page.evaluate(() => NMS.muteWaterWake(true)), true);
  await page.waitForTimeout(50);
  const wakeOff = await shot('04-directional-wake-off-reference');
  await page.waitForTimeout(50);
  const wakeOffBaseline = await shot('04b-directional-wake-off-baseline');
  assertSameSnapshot(movingSnapshot, await page.evaluate(() => NMS.waterWakeDebug()));
  // Keep the ROI on the Kelvin wedge. The wide solar glints at the far left
  // and right animate with the base water between A/B frames and otherwise
  // contaminate bilateral wake measurements with unrelated reflection energy.
  const wakeBounds = [0.15, 0.22, 0.85, 0.94];
  const wakeDelta = roiDelta(wakeClean, wakeOff, wakeBounds);
  const wakeShape = wakeMorphology(wakeClean, wakeOff, wakeBounds);
  const wakeBackground = wakeMorphology(wakeOff, wakeOffBaseline, wakeBounds);
  const wakeControlDelta = roiDelta(wakeOff, wakeOffBaseline, wakeBounds);
  await writeFile(`${OUT}/wake-isolation.json`, JSON.stringify({ wakeControlDelta,
    wakeDelta, wakeShape, movingSnapshot }, null, 2));
  assert.ok(wakeControlDelta < 0.001,
    `held off/off control must be optically stable before wake attribution: ${wakeControlDelta}`);
  wakeShape.netEnergyByDepth = wakeShape.energyByDepth.map((value, index) =>
    Math.max(0, value - wakeBackground.energyByDepth[index]));
  const legacyWakeShoulderRaw = wakeShoulderEnergy(wakeClean, wakeOff, wakeBounds, wakeCenterX);
  const legacyWakeShoulderBackground = wakeShoulderEnergy(
    wakeOff, wakeOffBaseline, wakeBounds, wakeCenterX,
  );
  const playerWakeMask = await projectedWakeMask();
  const playerWakeShoulder = projectedWakeEnergy(wakeClean, wakeOff, playerWakeMask);
  let decayMask = playerWakeMask;
  let decayOn = wakeClean, decayOff = wakeOff, decayBaseline = wakeOffBaseline;
  if (!playerWakeMask.complete) {
    decayMask = await projectedWakeMask({ supplement: true });
    assert.ok(decayMask.complete,
      `supplement cannot contain complete packet support: ${decayMask.visibleSupportFraction}`);
    await page.evaluate((pose) => {
      const pipeline = NMS._pipeline, camera = NMS._internals.camera;
      const original = pipeline.render;
      pipeline.render = function (...args) {
        const position = camera.position.clone(), quaternion = camera.quaternion.clone();
        try {
          camera.position.fromArray(pose.position);
          camera.quaternion.fromArray(pose.quaternion);
          camera.updateMatrixWorld(true);
          return original.apply(this, args);
        } finally {
          camera.position.copy(position); camera.quaternion.copy(quaternion);
          camera.updateMatrixWorld(true);
        }
      };
      window.__restoreWakeSupplement = () => { pipeline.render = original; };
    }, decayMask.supplementPose);
    try {
      assert.equal(await page.evaluate(() => NMS.muteWaterWake(false)), true);
      await page.waitForTimeout(1600);
      await page.keyboard.press('KeyH');
      await shot('04c-complete-packet-supplement-player');
      await page.keyboard.press('KeyH');
      decayOn = await shot('04d-complete-packet-supplement-on-clean');
      assert.equal(await page.evaluate(() => NMS.muteWaterWake(true)), true);
      await page.waitForTimeout(150);
      decayOff = await shot('04e-complete-packet-supplement-off-clean');
      await page.waitForTimeout(150);
      decayBaseline = await shot('04f-complete-packet-supplement-off-control');
      assertSameSnapshot(movingSnapshot, await page.evaluate(() => NMS.waterWakeDebug()));
      assert.ok(roiDelta(decayOff, decayBaseline, [0.02, 0.02, 0.98, 0.98]) < 0.001,
        'supplement must retain optical isolation through the normal post chain');
    } finally {
      await page.evaluate(() => {
        window.__restoreWakeSupplement?.(); delete window.__restoreWakeSupplement;
      });
    }
  }
  const wakeShoulderRaw = projectedWakeEnergy(decayOn, decayOff, decayMask);
  const wakeShoulderBackground = projectedWakeEnergy(decayOff, decayBaseline, decayMask);
  const wakeShoulder = {
    byDepth: wakeShoulderRaw.byDepth.map((value, index) =>
      Math.max(0, value - wakeShoulderBackground.byDepth[index])),
    bySide: wakeShoulderRaw.bySide.map((value, index) =>
      Math.max(0, value - wakeShoulderBackground.bySide[index])),
    boundary: Math.max(0, wakeShoulderRaw.boundary - wakeShoulderBackground.boundary),
  };
  await writeFile(`${OUT}/wake-projected-mask.json`, JSON.stringify({
    playerWakeMask, playerWakeShoulder, decayMask, wakeShoulder, wakeShoulderBackground,
    legacyWakeShoulderRaw, legacyWakeShoulderBackground,
  }, null, 2));
  const wakeConnection = wakeConnectivity(wakeClean, wakeOff, wakeBounds);
  const wakeEarlySpread = wakeLateralSpread(wakeEarly, wakeEarlyOff, wakeBounds, 0.5);
  const packetMetrics = packetFrames.map((frame) => ({
    age: frame.age, snapshot: frame.snapshot,
    spread: wakeLateralSpread(frame.on, frame.off, wakeBounds, 0.5),
    delta: roiDelta(frame.on, frame.off, wakeBounds),
  }));
  const wakeMatureSpread = packetMetrics.at(-1).spread;
  await page.keyboard.press('KeyH');
  assert.ok(wakeDelta >= 0.01,
    `directional wake must change the water behind the hull, ROI delta ${wakeDelta.toFixed(4)}`);
  assert.ok(wakeShape.changedFraction >= 0.002 && wakeShape.changedFraction <= 0.45
      && wakeShape.highFraction < 0.12,
    `wake must be readable but cannot fill the water as stamped slabs: ${JSON.stringify(wakeShape)}`);
  const connectedShoulders = wakeConnection.components.filter((component) =>
    component.minY < 0.46 && component.maxY > 0.52);
  assert.ok(wakeConnection.dominantFraction > 0.18 && connectedShoulders.length >= 1,
    `wake must remain connected from the stern region into a visible tail: ${JSON.stringify(wakeConnection)}`);
  assert.ok(wakeMatureSpread.active > 120 && wakeEarlySpread.active > 60,
    `wake age frames need measurable surface structure: ${JSON.stringify({ wakeEarlySpread, wakeMatureSpread })}`);
  assert.ok(wakeMatureSpread.normalized > wakeEarlySpread.normalized * 1.04,
    `the visible Kelvin packet must widen with age: ${JSON.stringify({ wakeEarlySpread, wakeMatureSpread })}`);
  assert.ok(packetMetrics.at(-1).delta < packetMetrics[0].delta * 0.95,
    `the same unrefreshed packet must decay with age: ${JSON.stringify(packetMetrics.map(({ age, delta }) => ({ age, delta })))}`);
  assert.ok(wakeShape.highFraction < 0.5,
    `wake may not be dominated by clipped triangular stamps: ${JSON.stringify(wakeShape)}`);
  const playerWakeBackground = projectedWakeEnergy(wakeOff, wakeOffBaseline, playerWakeMask);
  const playerSides = playerWakeShoulder.bySide.map((value, i) => Math.max(0, value - playerWakeBackground.bySide[i]));
  const wakeSideRatio = Math.min(...playerSides) / Math.max(1e-6, Math.max(...playerSides));
  assert.ok(playerWakeShoulder.sideCount.every((count) => count > 0)
    && Math.min(...playerSides) > 0.003 && wakeSideRatio > 0.1,
  `normal player view must show both world-projected shoulders: ${JSON.stringify({ playerSides, wakeSideRatio })}`);
  // Bins now span the complete WORLD support union, front to terminal tail.
  // Intermediate source tails are not terminal if another source covers them.
  // A clipped player frame cannot establish this claim: use the explicitly
  // labelled complete-packet supplement, never cropped-away zeros.
  const wakePeakEnergy = Math.max(...wakeShoulder.byDepth.slice(0, 3));
  assert.ok(wakeShoulderRaw.count.every((count) => count > 0) && wakeShoulderRaw.boundaryCount > 0,
    'complete finite tail and outside-support control must all be sampled');
  assert.ok(wakePeakEnergy > 0.003,
    `wake shoulders must exceed the animated-water A/B floor: ${JSON.stringify({ wakeShoulder, wakeShoulderBackground })}`);
  assert.ok(wakeShoulder.byDepth[3] < wakePeakEnergy * 0.55,
    `wake shoulders must decay before the frame edge: ${JSON.stringify({ wakeShoulder, wakeShoulderBackground })}`);
  assert.ok(wakeShoulder.boundary < wakePeakEnergy * 0.55,
    `outside all finite packet supports must lose wake energy: ${JSON.stringify(wakeShoulder)}`);

  const sunset = await page.evaluate(() => {
    const coast = NMS.setWade(0, { depth: 0.9, overview: true, look: 'sea' });
    // The shoreline solver guarantees local shallows, not an unobstructed
    // solar horizon. Use the same real deep-ocean site as the player/world
    // traversal, so a distant hill cannot silently occlude this light test.
    const planet = NMS._planet(0);
    NMS.teleport(0, (planet.seaLevel + 64) / planet.R, {
      dir: [0.34669147556655305, 0.07291666666666663, -0.9351407276403421],
      horizon: true, pitch: -0.12,
    });
    NMS.shipViewDebug.setViewMode('chase');
    const lighting = NMS.setLocalSunAltitude(0, 1.5, {
      faceSun: true,
      azimuthHint: coast.landward.map((value) => -value),
      framingOffsetDegrees: -8,
    });
    NMS.setTimeFrozen(true);
    return lighting;
  });
  await settle(0);
  await shot('05-ocean-sunset-player');
  await page.keyboard.press('KeyH');
  const sunsetClean = await shot('05-ocean-sunset-clean');
  await page.keyboard.press('KeyH');
  const sunsetQuality = roiQuality(sunsetClean, [0.04, 0.45, 0.54, 0.92]);
  const sunsetAlignment = sunPathAlignment(sunsetClean);
  const sunsetState = await page.evaluate(() => NMS.stats());
  await writeFile(`${OUT}/sunset.json`, JSON.stringify({ sunset, sunsetQuality,
    sunsetAlignment, sunsetState }, null, 2));
  assert.ok(Math.abs(sunset.actualDegrees - 1.5) < 0.2,
    `sunset fixture must reach 1.5 degrees, got ${sunset.actualDegrees}`);
  assert.equal(sunset.azimuthAligned, true,
    'sunset fixture must place the sun over open water rather than behind inland relief');
  assert.ok(sunsetState.environment.sunset >= 0.55,
    'the normal player water frame must consume sunset lighting');
  assert.ok(sunsetQuality.clippedFraction < 0.08,
    `sunset water reflection may not become a clipped white pillar: ${JSON.stringify(sunsetQuality)}`);
  assert.ok(sunsetQuality.warmFraction > 0.015,
    `sunset water-only ROI must contain a visible warm reflection: ${JSON.stringify(sunsetQuality)}`);
  assert.ok(sunsetQuality.warmHighlightFraction > 0.08,
    `sunset highlights must preserve warm chroma: ${JSON.stringify(sunsetQuality)}`);
  assert.ok(sunsetAlignment.sun.samples >= 20 && sunsetAlignment.reflection.samples >= 20,
    `sunset frame must contain both the solar source and a warm water path: ${JSON.stringify(sunsetAlignment)}`);
  assert.ok(sunsetAlignment.horizontalDelta < 0.2,
    `warm reflection must point back toward the visible sun: ${JSON.stringify(sunsetAlignment)}`);

  assert.deepEqual(errors, [], errors.join('\n'));
  const report = {
    generatedAt: new Date().toISOString(),
    ...fingerprint,
    artifacts: [
      '01-shallow-water-player.png',
      '02-coast-overview-player.png',
      '03a-directional-wake-early-player.png',
      '03-directional-wake-player.png',
      '05-ocean-sunset-player.png',
      '06-water-art-sequence.webm',
      ...packetFrames.flatMap((_, i) => [`03-packet-age-${i}-on-clean.png`, `03-packet-age-${i}-off-clean.png`]),
      'wake-projected-mask.json',
      ...(decayMask.supplementPose ? ['04c-complete-packet-supplement-player.png',
        '04d-complete-packet-supplement-on-clean.png', '04e-complete-packet-supplement-off-clean.png',
        '04f-complete-packet-supplement-off-control.png'] : []),
    ],
    materialDelta,
    shallowMoments,
    shallowQuality,
    coastWaterQuality,
    offshoreColor,
    shelfColor,
    shelfColorDistance,
    wakeDelta,
    wakeShape,
    wakeBackground,
    wakeShoulder,
    wakeShoulderBackground,
    playerWakeShoulder,
    legacyWakeShoulderRaw,
    legacyWakeShoulderBackground,
    completePacketView: decayMask.supplementPose || 'normal-player',
    wakeConnection,
    wakeEarlySpread,
    wakeMatureSpread,
    packetMetrics,
    wakeCenterX,
    visibleWakeImpulses,
    sunsetDegrees: sunset.actualDegrees,
    sunsetQuality,
    sunsetAlignment,
    renderer: onState.stats.rendererBackend,
    gpu: onState.stats.gpu,
    nearWater: onState.water.near,
    calls: onState.stats.calls,
    tris: onState.stats.tris,
  };
  await writeFile(`${OUT}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log('PASS: shallow water ownership, near-wave sampling and directional wake visual gate');
} finally {
  await page.close();
  await video?.saveAs(`${OUT}/06-water-art-sequence.webm`);
  await context.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
