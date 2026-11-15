import { currentGpuDisjointEpoch, readGpuDisjointEpoch } from './gpu-query-state.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Non-blocking frame-level WebGL2 GPU timer for adaptive quality. Cooperates
// with RenderProfiler and GpuWorkBudget via the shared GPU_DISJOINT_EXT epoch
// and never starts a nested TIME_ELAPSED_EXT query when another owner is active.
export class FrameGpuTimer {
  constructor(renderer, { sampleEvery = 3, maxPending = 4, maxSampleAgeFrames = 45 } = {}) {
    this.renderer = renderer;
    this.gl = renderer?.getContext?.() || null;
    this.sampleEvery = Math.max(1, Math.floor(sampleEvery));
    this.maxPending = Math.max(1, Math.floor(maxPending));
    this.maxSampleAgeFrames = Math.max(6, Math.floor(maxSampleAgeFrames));
    this.ext = this.gl && !this.gl.isContextLost?.()
      ? this.gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
    this.disjointEpoch = this.gl ? currentGpuDisjointEpoch(this.gl) : 0;
    this.epoch = 0;
    this.lost = Boolean(this.gl?.isContextLost?.());
    this.disposed = false;
    this.frame = 0;
    this.skippedFrames = 0;
    this.pending = [];
    this.lastGpuMs = null;
    this.lastSampleFrame = -Infinity;

    this.onLost = () => {
      this.lost = true;
      this.epoch++;
      this.skippedFrames = 0;
      this.pending = [];
      this.lastGpuMs = null;
      this.lastSampleFrame = -Infinity;
    };
    this.onRestored = () => {
      this.epoch++;
      this.lost = false;
      if (!this.disposed && this.gl) {
        this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
        this.disjointEpoch = readGpuDisjointEpoch(this.gl, this.ext);
      }
    };
    const canvas = renderer?.domElement;
    if (canvas && typeof canvas.addEventListener === 'function') {
      canvas.addEventListener('webglcontextlost', this.onLost);
      canvas.addEventListener('webglcontextrestored', this.onRestored);
    }
  }

  live(epoch = this.epoch) {
    return Boolean(this.gl && !this.disposed && !this.lost && epoch === this.epoch && !this.gl.isContextLost());
  }

  poll() {
    const gl = this.gl, ext = this.ext, epoch = this.epoch;
    if (!ext || !this.live(epoch) || !this.pending.length) return;
    const disjoint = readGpuDisjointEpoch(gl, ext);
    if (!this.live(epoch)) return;
    if (disjoint !== this.disjointEpoch) {
      this.disjointEpoch = disjoint;
      for (const item of this.pending.splice(0)) {
        if (this.live(item.epoch)) gl.deleteQuery(item.query);
      }
      return;
    }
    const remaining = [];
    for (const item of this.pending) {
      if (!this.live(epoch)) break;
      if (item.epoch !== epoch || item.disjointEpoch !== disjoint) {
        gl.deleteQuery(item.query);
        continue;
      }
      const available = gl.getQueryParameter(item.query, gl.QUERY_RESULT_AVAILABLE);
      if (!available) {
        remaining.push(item);
        continue;
      }
      const ns = gl.getQueryParameter(item.query, gl.QUERY_RESULT);
      const checkedDisjoint = readGpuDisjointEpoch(gl, ext);
      gl.deleteQuery(item.query);
      if (checkedDisjoint !== disjoint) {
        this.disjointEpoch = checkedDisjoint;
        for (const rest of remaining.splice(0)) gl.deleteQuery(rest.query);
        continue;
      }
      const gpuMs = ns / 1e6;
      if (Number.isFinite(gpuMs) && gpuMs > 0 && gpuMs < 500) {
        this.lastGpuMs = gpuMs;
        this.lastSampleFrame = this.frame;
      }
    }
    this.pending = remaining;
  }

  measure(work, { skip = false } = {}) {
    this.frame++;
    this.poll();
    if (skip) {
      this.skippedFrames++;
      this.lastGpuMs = null;
      this.lastSampleFrame = -Infinity;
    } else {
      this.skippedFrames = 0;
    }
    const gl = this.gl, ext = this.ext, epoch = this.epoch;
    const canSample = !skip && ext && this.live(epoch)
      && this.pending.length < this.maxPending
      && (this.frame % this.sampleEvery === 0)
      && !gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY);
    let query = null;
    let began = false;
    const disjointEpoch = canSample ? currentGpuDisjointEpoch(gl) : 0;
    if (canSample) {
      query = gl.createQuery();
      if (query) {
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        began = true;
      }
    }
    let result;
    try {
      result = work();
      return result;
    } finally {
      if (began && this.live(epoch)) {
        const current = gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY);
        if (current === query) gl.endQuery(ext.TIME_ELAPSED_EXT);
        if (result) {
          this.pending.push({ query, epoch, disjointEpoch });
        } else {
          gl.deleteQuery(query);
        }
      }
    }
  }

  latestMs() {
    if (this.lastGpuMs === null || this.frame - this.lastSampleFrame > this.maxSampleAgeFrames) {
      return null;
    }
    return this.lastGpuMs;
  }

  reset() {
    this.skippedFrames = 0;
    this.lastGpuMs = null;
    this.lastSampleFrame = -Infinity;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.gl && !this.lost && !this.gl.isContextLost?.()) {
      for (const item of this.pending.splice(0)) {
        if (item.epoch === this.epoch) this.gl.deleteQuery(item.query);
      }
    }
    this.pending = [];
    const canvas = this.renderer?.domElement;
    if (canvas && typeof canvas.removeEventListener === 'function') {
      canvas.removeEventListener('webglcontextlost', this.onLost);
      canvas.removeEventListener('webglcontextrestored', this.onRestored);
    }
  }
}

// VSync-aware adaptive quality controller.
// Distinguishes idle VSync wait (e.g. 16.67 ms on 60 Hz when CPU+GPU finish in
// 8 ms) from genuine CPU/GPU overload, ignores transient high-altitude LOD
// streaming bursts, recovers smoothly back to stage 0 on 60 Hz displays once
// headroom returns, and uses asymmetric deadbands + bounce backoff to prevent
// stage oscillation.
export class AdaptiveQualityGovernor {
  constructor({
    targetFrameMs = 16.67,
    maxStage = 5,
    warmupGraceMs = 2000,
    downgradeHoldMs = 1400,
    downgradeSettleMs = 850,
    upgradeHoldMs = 1100,
    maxStreamImmunityMs = 10000,
    maxGpuStaleMs = 600,
    initialNow = 0,
  } = {}) {
    this.targetFrameMs = targetFrameMs;
    this.maxStage = maxStage;
    this.warmupGraceMs = warmupGraceMs;
    this.downgradeHoldMs = downgradeHoldMs;
    this.downgradeSettleMs = downgradeSettleMs;
    this.upgradeHoldMs = upgradeHoldMs;
    this.maxStreamImmunityMs = maxStreamImmunityMs;
    this.maxGpuStaleMs = Math.max(150, maxGpuStaleMs);
    this.reset(initialNow);
  }

  setTargetFrameMs(targetFrameMs) {
    if (Number.isFinite(targetFrameMs) && targetFrameMs > 4) {
      this.targetFrameMs = targetFrameMs;
    }
  }

  reset(now = 0) {
    this.readySince = Number.isFinite(now) ? now : 0;
    this.lastSampleAt = this.readySince;
    this.activeEmaMs = this.targetFrameMs;
    this.cpuEmaMs = this.targetFrameMs * 0.45;
    this.gpuEmaMs = null;
    this.lastGpuSampleAt = -Infinity;
    this.gpuMissingFrames = 0;
    this.activeWindow = [];
    this.workEmaMs = this.targetFrameMs * 0.55;
    this.overloadAccumMs = 0;
    this.recoveryAccumMs = 0;
    this.streamAccumMs = 0;
    this.cooldownUntil = this.readySince;
    this.upgradeBlockedUntil = this.readySince;
    this.lastUpgradeAt = -Infinity;
    this.bounceCount = 0;
  }

  markNotReady(now) {
    if (!Number.isFinite(now)) return;
    this.readySince = now;
    this.lastSampleAt = now;
    this.activeWindow.length = 0;
    this.overloadAccumMs = 0;
    this.recoveryAccumMs = 0;
  }

  update({
    now,
    ready = true,
    locked = false,
    streaming = false,
    activeMs,
    cpuWorkMs,
    gpuWorkMs = null,
    stage = 0,
    renderDpr = 1,
    ceilingDpr = 1,
    dprMin = 0.85,
  }) {
    if (!Number.isFinite(now)) return { action: 'none' };
    if (!ready) {
      this.markNotReady(now);
      return { action: 'none' };
    }
    const dtMs = clamp(now - this.lastSampleAt, 0, 120);
    this.lastSampleAt = now;
    if (!Number.isFinite(activeMs) || activeMs <= 0) return { action: 'none' };

    // Clamp isolated single-frame OS/tab/GC stalls so one 100 ms hitch cannot
    // poison the exponential averages for several seconds.
    const clampedActive = clamp(activeMs, 1, 50);
    const clampedCpu = clamp(Number.isFinite(cpuWorkMs) ? cpuWorkMs : clampedActive * 0.5, 0.2, 48);
    const hasGpu = Number.isFinite(gpuWorkMs) && gpuWorkMs > 0;
    const clampedGpu = hasGpu ? clamp(gpuWorkMs, 0.2, 48) : null;

    // Faster EMA alpha (~0.12 -> ~8-frame time constant) tracks load transitions
    // promptly while smoothing frame-to-frame VSync jitter.
    const alpha = 0.12;
    this.activeEmaMs += (clampedActive - this.activeEmaMs) * alpha;
    this.cpuEmaMs += (clampedCpu - this.cpuEmaMs) * alpha;
    if (clampedGpu !== null) {
      this.gpuMissingFrames = 0;
      this.lastGpuSampleAt = now;
      this.gpuEmaMs = this.gpuEmaMs === null
        ? clampedGpu
        : this.gpuEmaMs + (clampedGpu - this.gpuEmaMs) * 0.18;
    } else if (this.gpuEmaMs !== null) {
      this.gpuMissingFrames++;
      const missingMs = now - this.lastGpuSampleAt;
      if (missingMs >= this.maxGpuStaleMs || (this.gpuMissingFrames > 12 && missingMs >= 180)) {
        this.gpuEmaMs = null;
        this.lastGpuSampleAt = -Infinity;
      }
    }

    this.activeWindow.push(clampedActive);
    if (this.activeWindow.length > 21) this.activeWindow.shift();
    const sortedActive = [...this.activeWindow].sort((a, b) => a - b);
    const winLen = sortedActive.length;
    const p25ActiveMs = sortedActive[Math.floor((winLen - 1) * 0.25)];
    const p50ActiveMs = sortedActive[Math.floor((winLen - 1) * 0.50)];
    const p70ActiveMs = sortedActive[Math.floor((winLen - 1) * 0.70)];

    const target = this.targetFrameMs;
    const downgradeWorkThreshold = target * 1.11; // ~18.5 ms on Ultra (< 54 FPS true work)
    const severeWorkThreshold = target * 1.40;    // ~23.3 ms on Ultra
    const upgradeWorkThreshold = target * 0.76;   // ~12.7 ms pipelined max(CPU, GPU) on Ultra
    const ipcCeilingMs = Math.max(25.5, target * 1.52);

    // Reference display VSync cadence for timerless fallback:
    // - On 60 Hz with occasional D3D11/DWM beat-skip micro-jitter (~20-25% 33 ms
    //   frames), median p50 stays pinned at ~16.7 ms even when arithmetic
    //   activeEmaMs drifts to ~19.5-20.5 ms.
    // - On steady 50 Hz / 48 Hz / half-100Hz pacing, intervals cluster tightly
    //   (p70 - p25 <= 2 ms) around ~19.5–21.0 ms with low render CPU cost.
    const steadyAltVsync = winLen >= 8
      && p25ActiveMs >= target * 1.05
      && p70ActiveMs <= Math.max(21.2, target * 1.27)
      && (p70ActiveMs - p25ActiveMs) <= 2.0
      && this.cpuEmaMs <= upgradeWorkThreshold * 0.95;
    const cadenceMs = steadyAltVsync
      ? p50ActiveMs
      : Math.max(target, Math.min(p25ActiveMs, target * 1.05));

    const streamProtected = Boolean(streaming) && this.streamAccumMs < this.maxStreamImmunityMs;
    if (streaming) this.streamAccumMs = Math.min(this.maxStreamImmunityMs + 1000, this.streamAccumMs + dtMs);
    else this.streamAccumMs = Math.max(0, this.streamAccumMs - dtMs * 2);

    // Compute true frame hardware load vs VSync-paced wall interval:
    // - When GPU timer is available, max(CPU, GPU) measures real render load
    //   independent of 60 Hz / 50 Hz VSync sleep; sustained wall intervals
    //   beyond ipcCeilingMs (> ~23.8 ms = < 42 FPS) also count as IPC/compositor
    //   overload when not actively streaming chunks.
    // - When GPU timer is unavailable, compare quantile-filtered presentation
    //   intervals against measured VSync cadence plus render CPU work so 60 Hz
    //   presentation jitter does not masquerade as sustained GPU overload.
    let instantWorkMs;
    if (this.gpuEmaMs !== null) {
      const hwMs = Math.max(clampedCpu, clampedGpu ?? this.gpuEmaMs);
      const wallBottleneck = !streamProtected && clampedActive > ipcCeilingMs ? clampedActive : 0;
      instantWorkMs = Math.max(hwMs, wallBottleneck);
    } else {
      const sustainedWallOverload = !streamProtected && (
        (p50ActiveMs > Math.max(21.2, cadenceMs * 1.20) && clampedActive > cadenceMs * 1.15)
        || (p70ActiveMs > cadenceMs * 1.45 && this.activeEmaMs > Math.max(22.6, cadenceMs * 1.35))
      );
      const fallbackWall = sustainedWallOverload ? clampedActive : clampedCpu;
      instantWorkMs = Math.max(clampedCpu, fallbackWall);
    }
    this.workEmaMs += (instantWorkMs - this.workEmaMs) * alpha;

    if (locked || now - this.readySince < this.warmupGraceMs) {
      this.overloadAccumMs = 0;
      this.recoveryAccumMs = 0;
      return { action: 'none' };
    }

    // Decay bounce penalty after prolonged stability at an upgraded stage.
    if (this.bounceCount > 0 && now - this.lastUpgradeAt >= 15000 && this.overloadAccumMs === 0) {
      this.bounceCount = Math.max(0, this.bounceCount - 1);
      this.lastUpgradeAt = now;
    }

    if (streamProtected) {
      // Transient high-altitude / teleport terrain streaming is CPU noise
      // generation, not steady rendering overload; never downgrade on it, and
      // pause recovery without wiping accumulated headroom on brief worker builds.
      this.overloadAccumMs = Math.max(0, this.overloadAccumMs - dtMs * 0.5);
      this.recoveryAccumMs = Math.max(0, this.recoveryAccumMs - dtMs * 0.25);
      return { action: 'none' };
    }

    const fallbackWallOverloaded = (
      p50ActiveMs > Math.max(21.2, cadenceMs * 1.20)
      && this.activeEmaMs > Math.max(21.5, cadenceMs * 1.22)
    ) || (
      p70ActiveMs > cadenceMs * 1.45
      && this.activeEmaMs > Math.max(22.8, cadenceMs * 1.36)
    );
    const overloaded = this.gpuEmaMs !== null
      ? this.workEmaMs > downgradeWorkThreshold
      : (this.cpuEmaMs > downgradeWorkThreshold || fallbackWallOverloaded);

    const hasHeadroom = this.gpuEmaMs !== null
      ? (this.workEmaMs <= upgradeWorkThreshold
        && (this.cpuEmaMs + this.gpuEmaMs) <= target * 1.48
        && this.activeEmaMs <= ipcCeilingMs)
      : (this.cpuEmaMs <= upgradeWorkThreshold * 0.95
        && p50ActiveMs <= cadenceMs * 1.10
        && this.activeEmaMs <= Math.max(22.4, cadenceMs * 1.34));

    if (overloaded) {
      const weight = this.workEmaMs > severeWorkThreshold ? 1.55 : 1.0;
      this.overloadAccumMs += dtMs * weight;
      this.recoveryAccumMs = 0;

      if (now >= this.cooldownUntil && this.overloadAccumMs >= this.downgradeHoldMs) {
        this.overloadAccumMs = 0;
        this.cooldownUntil = now + this.downgradeSettleMs;
        // If we just upgraded recently and immediately overloaded again, record
        // a bounce and back off further upgrade attempts to prevent oscillation.
        if (now - this.lastUpgradeAt < 9000) {
          this.bounceCount = Math.min(4, this.bounceCount + 1);
          this.upgradeBlockedUntil = now + Math.min(60000, 12000 * (2 ** (this.bounceCount - 1)));
        }
        if (stage < this.maxStage) {
          return { action: 'stage', stage: stage + 1 };
        }
        const minAllowedDpr = Math.max(0.75, dprMin - 0.05);
        if (renderDpr > minAllowedDpr + 0.01) {
          const step = this.workEmaMs > severeWorkThreshold ? 0.08 : 0.05;
          return { action: 'dpr', dpr: Math.max(minAllowedDpr, renderDpr - step) };
        }
      }
      return { action: 'none' };
    }

    this.overloadAccumMs = Math.max(0, this.overloadAccumMs - dtMs * 1.5);

    const canStepUp = stage > 0 || renderDpr < ceilingDpr - 0.04;
    if (canStepUp && hasHeadroom && now >= this.cooldownUntil && now >= this.upgradeBlockedUntil) {
      this.recoveryAccumMs += dtMs;
      if (this.recoveryAccumMs >= this.upgradeHoldMs) {
        this.recoveryAccumMs = 0;
        this.cooldownUntil = now + 250;
        this.lastUpgradeAt = now;
        if (stage >= this.maxStage && renderDpr < Math.max(0.85, dprMin) - 0.02) {
          return { action: 'dpr', dpr: Math.min(ceilingDpr, renderDpr + 0.05) };
        }
        if (stage > 0) {
          return { action: 'stage', stage: stage - 1 };
        }
        if (renderDpr < ceilingDpr - 0.04) {
          return { action: 'dpr', dpr: Math.min(ceilingDpr, renderDpr + 0.05) };
        }
      }
    } else if (!hasHeadroom) {
      this.recoveryAccumMs = Math.max(0, this.recoveryAccumMs - dtMs * 0.4);
    }

    return { action: 'none' };
  }

  snapshot() {
    return {
      activeEmaMs: +this.activeEmaMs.toFixed(2),
      cpuEmaMs: +this.cpuEmaMs.toFixed(2),
      gpuEmaMs: this.gpuEmaMs !== null ? +this.gpuEmaMs.toFixed(2) : null,
      workEmaMs: +this.workEmaMs.toFixed(2),
      overloadAccumMs: Math.round(this.overloadAccumMs),
      recoveryAccumMs: Math.round(this.recoveryAccumMs),
      bounceCount: this.bounceCount,
    };
  }
}
