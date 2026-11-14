import assert from 'node:assert/strict';
import { AdaptiveQualityGovernor, FrameGpuTimer } from '../src/adaptive-quality.js';

function simulate(gov, state, { durationMs, stepMs, cpuWorkMs, gpuWorkMs, activeMs = stepMs, streaming = false }) {
  const transitions = [];
  const end = state.now + durationMs;
  while (state.now < end) {
    state.now += stepMs;
    const gpuVal = typeof gpuWorkMs === 'function' ? gpuWorkMs(state) : gpuWorkMs;
    const cpuVal = typeof cpuWorkMs === 'function' ? cpuWorkMs(state) : cpuWorkMs;
    const actVal = typeof activeMs === 'function' ? activeMs(state) : activeMs;
    const res = gov.update({
      now: state.now,
      ready: true,
      locked: false,
      streaming,
      activeMs: actVal,
      cpuWorkMs: cpuVal,
      gpuWorkMs: gpuVal,
      stage: state.stage,
      renderDpr: state.dpr,
      ceilingDpr: 1.0,
      dprMin: 0.9,
    });
    if (res.action === 'stage') {
      state.stage = res.stage;
      state.dpr = state.stage >= 5 ? 0.9 : state.stage >= 4 ? 0.92 : 1.0;
      transitions.push({ t: Math.round(state.now), stage: state.stage, dpr: state.dpr });
    } else if (res.action === 'dpr') {
      state.dpr = res.dpr;
      transitions.push({ t: Math.round(state.now), stage: state.stage, dpr: +state.dpr.toFixed(2) });
    }
  }
  return transitions;
}

// 1. Capable GPU pinned on 60 Hz VSync (activeMs = 16.67 ms, CPU 5.5 ms, GPU 9.5 ms)
//    must remain at full Ultra quality (stage 0, dpr 1.0) indefinitely.
{
  const gov = new AdaptiveQualityGovernor({ targetFrameMs: 16.67, initialNow: 0 });
  const state = { now: 0, stage: 0, dpr: 1.0 };
  const changes = simulate(gov, state, { durationMs: 20000, stepMs: 16.67, cpuWorkMs: 5.5, gpuWorkMs: 9.5 });
  assert.equal(state.stage, 0, '60 Hz VSync with <10 ms GPU load must stay at stage 0');
  assert.equal(state.dpr, 1.0);
  assert.equal(changes.length, 0);
}

// 2. High-altitude / descent streaming spikes must NOT trigger downgrade.
{
  const gov = new AdaptiveQualityGovernor({ targetFrameMs: 16.67, initialNow: 0 });
  const state = { now: 0, stage: 0, dpr: 1.0 };
  simulate(gov, state, { durationMs: 3000, stepMs: 16.67, cpuWorkMs: 5.0, gpuWorkMs: 8.0 });
  // 7 seconds of heavy chunk streaming bursts (activeMs 24 ms while streaming=true)
  const changes = simulate(gov, state, {
    durationMs: 7000, stepMs: 24.0, cpuWorkMs: 7.0, gpuWorkMs: 11.0, streaming: true,
  });
  assert.equal(state.stage, 0, 'Transient streaming bursts must not push adaptiveStage above 0');
  assert.equal(changes.length, 0);
}

// 3. Genuine overload downgrades, then 60 Hz VSync recovery (16.67 ms cadence,
//    and even 20 ms 2x100Hz cadence when CPU+GPU work < 8 ms) climbs all the way back to stage 0!
{
  const gov = new AdaptiveQualityGovernor({ targetFrameMs: 16.67, initialNow: 0 });
  const state = { now: 0, stage: 0, dpr: 1.0 };
  simulate(gov, state, { durationMs: 2500, stepMs: 16.67, cpuWorkMs: 5.0, gpuWorkMs: 7.0 });
  // 6 seconds of 28 ms CPU/GPU overload -> must downgrade significantly
  simulate(gov, state, { durationMs: 6000, stepMs: 28.0, cpuWorkMs: 26.0, gpuWorkMs: 9.0 });
  assert.ok(state.stage >= 3, `Expected downgrade to >= stage 3 under 6s 28ms overload, got ${state.stage}`);

  // Remove load, lock onto 60 Hz VSync (16.67 ms wall cadence, 5 ms CPU, 6 ms GPU) for 10s
  simulate(gov, state, { durationMs: 10000, stepMs: 16.67, cpuWorkMs: 5.0, gpuWorkMs: 6.0 });
  assert.equal(state.stage, 0, `Expected full recovery to stage 0 on 60 Hz VSync within 10s, got ${state.stage}`);
  assert.equal(state.dpr, 1.0);
}

// 4. Genuinely GPU-limited machine on 60 Hz VSync (stage 0..2 takes 20-26 ms GPU,
//    stage 3 takes 14.6 ms GPU) must settle at stage 3 and NEVER oscillate!
{
  const gov = new AdaptiveQualityGovernor({ targetFrameMs: 16.67, initialNow: 0 });
  const state = { now: 0, stage: 0, dpr: 1.0 };
  const gpuCostByStage = [26.0, 22.5, 19.8, 14.6, 12.8, 11.2];
  const changes = simulate(gov, state, {
    durationMs: 30000,
    stepMs: 16.67,
    cpuWorkMs: 5.2,
    gpuWorkMs: (s) => gpuCostByStage[s.stage],
    activeMs: (s) => Math.max(16.67, gpuCostByStage[s.stage]),
  });
  assert.equal(state.stage, 3, `Expected steady convergence to stage 3, got ${state.stage}`);
  // After reaching stage 3, zero further oscillation transitions over remaining ~20s!
  const firstAt3 = changes.findIndex((c) => c.stage === 3);
  assert.ok(firstAt3 >= 0);
  assert.equal(changes.slice(firstAt3 + 1).length, 0, 'Must hold stage 3 with zero ping-pong oscillation');
}

// 5. Fallback without EXT_disjoint_timer_query_webgl2 (gpuWorkMs = null):
//    recovers on 60 Hz VSync when light, and bounce-backoff prevents oscillation when GPU-heavy!
{
  const gov = new AdaptiveQualityGovernor({ targetFrameMs: 16.67, initialNow: 0 });
  const state = { now: 0, stage: 0, dpr: 1.0 };
  simulate(gov, state, { durationMs: 2500, stepMs: 16.67, cpuWorkMs: 5.0, gpuWorkMs: null });
  simulate(gov, state, { durationMs: 6000, stepMs: 28.0, cpuWorkMs: 25.0, gpuWorkMs: null });
  assert.ok(state.stage >= 3);
  simulate(gov, state, { durationMs: 10000, stepMs: 16.67, cpuWorkMs: 5.0, gpuWorkMs: null });
  assert.equal(state.stage, 0, 'Fallback mode without GPU timer must also recover to stage 0 on 60 Hz VSync');

  // Now simulate hidden GPU load without GPU timer where stage <= 2 drops to 42 FPS (23.8 ms)
  // while stage 3 holds 60 Hz VSync (16.67 ms): bounce-backoff must bound transitions!
  const changes = simulate(gov, state, {
    durationMs: 35000,
    stepMs: 16.67,
    cpuWorkMs: 5.0,
    gpuWorkMs: null,
    activeMs: (s) => (s.stage <= 2 ? 23.8 : 16.67),
  });
  assert.equal(state.stage, 3);
  assert.ok(changes.length <= 9, `Bounce backoff must prevent endless ping-pong, got ${changes.length} transitions`);
}

// 6. FrameGpuTimer skips nested queries when an external TIME_ELAPSED_EXT query is active.
{
  let created = 0, activeExternal = true;
  const mockExt = { TIME_ELAPSED_EXT: 0x88BF, GPU_DISJOINT_EXT: 0x8FBB };
  const mockGl = {
    CURRENT_QUERY: 0x8865,
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT: 0x8866,
    isContextLost: () => false,
    getExtension: (name) => (name === 'EXT_disjoint_timer_query_webgl2' ? mockExt : null),
    getParameter: () => false,
    getQuery: () => (activeExternal ? {} : null),
    createQuery: () => { created++; return {}; },
    beginQuery() {},
    endQuery() {},
    getQueryParameter: (_q, pname) => (pname === 0x8867 ? true : 8_400_000),
    deleteQuery() {},
  };
  const timer = new FrameGpuTimer({ getContext: () => mockGl, domElement: null }, { sampleEvery: 1 });
  timer.measure(() => true);
  assert.equal(created, 0, 'Must never start nested TIME_ELAPSED_EXT when external query is active');
  activeExternal = false;
  timer.measure(() => true);
  assert.equal(created, 1);
  timer.measure(() => true);
  assert.ok(Math.abs(timer.latestMs() - 8.4) < 1e-6);
  timer.dispose();
}

console.log('PASS: adaptive quality VSync awareness, streaming spike immunity, 60 Hz recovery and anti-oscillation');
