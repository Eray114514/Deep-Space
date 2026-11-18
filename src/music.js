// Scene-aware background music director. Streams 42 curated MP3 tracks (27
// Google DeepMind Lyria 3.5 tracks + 15 retained classic tracks) mapped to
// game scenes, multi-track pools, biome time-of-day, civilization landmarks,
// and tactical encounters.
//
// Tracks are loaded lazily: each <audio> element remains `preload="none"` with
// no `src` until the first time it is cued, so the ~238 MB soundtrack costs
// 0 bytes at startup. Audio elements route through per-track GainNodes into a
// shared low-pass BiquadFilterNode (used to gently muffle exterior score inside
// an enclosed landed cabin) and master GainNode on FlightAudio's AudioContext.

export const TRACK_DEFS = [
  // --- Interface & Navigation ---
  { id: 'hero-theme',               file: 'hero-theme.mp3',               pool: 'hero',                       source: 'lyria-3.5', title: '主菜单序曲 · 深空远征' },
  { id: 'starmap',                  file: 'starmap.mp3',                  pool: 'starmap',                    source: 'lyria-3.5', title: '银河星图 · 测绘静域' },
  { id: 'starmap-classic',          file: 'starmap-classic.mp3',          pool: 'starmap',                    source: 'classic',   title: '星图（经典版）' },

  // --- Deep Space Cruise Pool (6 tracks, shuffled non-repeating rotation) ---
  { id: 'deep-space-1',             file: 'deep-space-1.mp3',             pool: 'cruise',                     source: 'lyria-3.5', title: '深空巡航 I · 银盘微光' },
  { id: 'deep-space-1-classic',     file: 'deep-space-1-classic.mp3',     pool: 'cruise',                     source: 'classic',   title: '深空巡航 1（经典版）' },
  { id: 'starfall-atrium',          file: 'starfall-atrium.mp3',          pool: 'cruise',                     source: 'lyria-3.5', title: '深空巡航 II · 星落中庭' },
  { id: 'starfall-atrium-classic',  file: 'starfall-atrium-classic.mp3',  pool: 'cruise',                     source: 'classic',   title: 'Starfall Atrium（经典版）' },
  { id: 'stellar-transition',       file: 'stellar-transition.mp3',       pool: 'cruise',                     source: 'lyria-3.5', title: '深空巡航 III · 双星日冕' },
  { id: 'deep-space-4',             file: 'deep-space-4.mp3',             pool: 'cruise',                     source: 'lyria-3.5', title: '深空巡航 IV · 远星孤航' },

  // --- Interstellar Transit, Rift Portals & Relativistic Hazards ---
  { id: 'interstellar-flight',      file: 'interstellar-flight.mp3',      pool: 'warp',                       source: 'classic',   title: '星际飞行 · 超空间跃迁' },
  { id: 'rift-passage',             file: 'rift-passage.mp3',             pool: 'rift',                       source: 'lyria-3.5', title: '弦界航道 · 裂隙凝视' },
  { id: 'rift-passage-classic',     file: 'rift-passage-classic.mp3',     pool: 'rift',                       source: 'classic',   title: '弦界航道（经典版）' },
  { id: 'black-hole',               file: 'black-hole.mp3',               pool: 'blackhole',                  source: 'lyria-3.5', title: '黑洞观测 · 事件视界' },
  { id: 'black-hole-classic',       file: 'black-hole-classic.mp3',       pool: 'blackhole',                  source: 'classic',   title: '黑洞观测（经典版）' },
  { id: 'gas-giant-dive',           file: 'gas-giant-dive.mp3',           pool: 'gas-giant-dive',             source: 'lyria-3.5', title: '巨星云渊 · 高压风切' },
  { id: 'halo-skydive',             file: 'halo-skydive.mp3',             pool: 'skydive',                    source: 'lyria-3.5', title: '高空跳伞 · 穿云自由落体' },

  // --- Planetary Biomes & Subsurface Ocean ---
  { id: 'lush-planet',              file: 'lush-planet.mp3',              pool: 'planet:lush',                source: 'lyria-3.5', title: '繁茂行星 · 初生原野' },
  { id: 'lush-night',               file: 'lush-night.mp3',               pool: 'planet:lush:night',          source: 'lyria-3.5', title: '繁茂星夜 · 双月微风' },
  { id: 'ocean-planet',             file: 'ocean-planet.mp3',             pool: 'planet:ocean',               source: 'lyria-3.5', title: '海洋行星 · 无垠风暴洋' },
  { id: 'abyssal-dive',             file: 'abyssal-dive.mp3',             pool: 'underwater',                 source: 'lyria-3.5', title: '深海潜行 · 幽光海床' },
  { id: 'alpine-summit',            file: 'alpine-summit.mp3',            pool: 'alpine',                     source: 'lyria-3.5', title: '高山雪顶 · 云端雪线' },
  { id: 'alpine-summit-classic',    file: 'alpine-summit-classic.mp3',    pool: 'alpine',                     source: 'classic',   title: '高山雪顶（经典版）' },
  { id: 'ice-planet',               file: 'ice-planet.mp3',               pool: 'planet:ice',                 source: 'lyria-3.5', title: '冰封行星 · 极寒晶原' },
  { id: 'ice-planet-classic',       file: 'ice-planet-classic.mp3',       pool: 'planet:ice',                 source: 'classic',   title: '冰封行星（经典版）' },
  { id: 'toxic-planet',             file: 'toxic-planet.mp3',             pool: 'planet:toxic',               source: 'lyria-3.5', title: '剧毒行星 · 孢子酸雾' },
  { id: 'toxic-planet-classic',     file: 'toxic-planet-classic.mp3',     pool: 'planet:toxic',               source: 'classic',   title: '剧毒行星（经典版）' },
  { id: 'lava-planet',              file: 'lava-planet.mp3',              pool: 'planet:lava',                source: 'lyria-3.5', title: '火山行星 · 熔岩裂谷' },
  { id: 'desert-planet',            file: 'desert-planet.mp3',            pool: 'planet:desert',              source: 'lyria-3.5', title: '荒漠行星 · 赤沙远风' },
  { id: 'desert-planet-classic',    file: 'desert-planet-classic.mp3',    pool: 'planet:desert',              source: 'classic',   title: '荒漠行星（经典版）' },
  { id: 'barren-planet',            file: 'barren-planet.mp3',            pool: 'planet:barren',              source: 'lyria-3.5', title: '荒芜行星 · 寂静月壤' },
  { id: 'barren-planet-classic',    file: 'barren-planet-classic.mp3',    pool: 'planet:barren',              source: 'classic',   title: '荒芜行星（经典版）' },
  { id: 'exotic-planet',            file: 'exotic-planet.mp3',            pool: 'planet:exotic',              source: 'classic',   title: '异相行星（经典版）' },

  // --- Human Frontier Megastructures, Cities & Outposts ---
  { id: 'floating-city',            file: 'floating-city.mp3',            pool: 'planet:artificialHabitat',   source: 'lyria-3.5', title: '云海浮城 · 天穹气凝胶港' },
  { id: 'frontier-metropolis',      file: 'frontier-metropolis.mp3',      pool: 'metropolis',                 source: 'lyria-3.5', title: '边疆星港 · 核心都市与机库' },
  { id: 'cyber-metropolis-entry',   file: 'cyber-metropolis-entry.mp3',   pool: 'metropolis',                 source: 'classic',   title: '初入赛博夜城 · 都市进近' },

  // --- Tactical Combat & High-Velocity Reserve Pools ---
  { id: 'surface-combat',           file: 'surface-combat.mp3',           pool: 'combat:surface',             source: 'lyria-3.5', title: '地表交战 · 猎犬围猎' },
  { id: 'elegy-conflict',           file: 'elegy-conflict.mp3',           pool: 'reserved:elegy-combat',      source: 'classic',   title: '古典弦钢冲突曲（预留）' },
  { id: 'space-combat',             file: 'space-combat.mp3',             pool: 'reserved:space-combat',      source: 'lyria-3.5', title: '太空交战 · 轨道拦截（预留）' },
  { id: 'space-race',               file: 'space-race.mp3',               pool: 'reserved:race',              source: 'lyria-3.5', title: '极速掠地 · 超低空音障（预留）' },
  { id: 'space-race-classic',       file: 'space-race-classic.mp3',       pool: 'reserved:race',              source: 'classic',   title: '太空竞速（经典版预留）' },
  { id: 'hyperdrive-conduit',       file: 'hyperdrive-conduit.mp3',       pool: 'reserved:race',              source: 'lyria-3.5', title: '超光速走廊（竞速机动预留）' },
  { id: 'anomalous-geometry',       file: 'anomalous-geometry.mp3',       pool: 'reserved:race',              source: 'lyria-3.5', title: '非欧几何（科幻机动预留）' },
];

const POOL_MEMBERS = new Map();
for (const def of TRACK_DEFS) {
  if (!POOL_MEMBERS.has(def.pool)) POOL_MEMBERS.set(def.pool, []);
  POOL_MEMBERS.get(def.pool).push(def);
}

const AUDIO_BASE = '/assets/audio/';
const FADE_SECONDS = 1.6;
const POOL_ADVANCE_FADE_SECONDS = 1.2;
const MASTER_VOLUME = 0.34;
const COMBAT_LINGER_SECONDS = 5.0;
const CABIN_MUFFLE_HZ = 1850;
const OPEN_AIR_HZ = 20000;

export function createDirectorMemory() {
  return {
    combatHold: 0,
    inBlackHole: false,
    inGasGiantDive: false,
    inAlpine: false,
    inLushNight: false,
    lastPlanetKey: null,
  };
}

function planetPoolSelector(planetType) {
  if (!planetType) return null;
  if (planetType === 'artificialHabitat') return 'floating-city';
  const poolName = `planet:${planetType}`;
  if (POOL_MEMBERS.has(poolName)) return `pool:${poolName}`;
  return null;
}

// Resolve which track or `pool:<name>` selector should own the score right now.
// Supports optional stateful `memory` for boundary hysteresis (snowline, dusk/
// dawn terminator, black-hole accretion radius, gas-giant storm depth, and post-
// combat cooldown) so hovering on a threshold never flip-flops tracks.
export function pickTrack(snapshot = {}, memory = null) {
  const {
    dt = 0,
    state = 'space',
    heroActive = false,
    starmapOpen = false,
    routeChoiceOpen = false,
    riftActive = false,
    nearBlackHole = false,
    blackHoleRatio = null,
    gasGiantDive = false,
    gasGiantAltRatio = null,
    underwater = false,
    surfaceCombat = false,
    planetType = null,
    planetKey = null,
    shipLanded = false,
    snowWeight = 0,
    dayFactor = null,
    civilizationSiteType = null,
    civilizationDistance = Infinity,
    nearOrbitalStation = false,
  } = snapshot;

  const stepDt = Math.max(0, Math.min(0.5, Number.isFinite(dt) ? dt : 0));

  // Advance or decay combat linger even while checking higher-priority UI overlays.
  let combatActive = Boolean(state === 'walk' && surfaceCombat);
  if (memory) {
    if (state !== 'walk') {
      memory.combatHold = 0;
    } else if (surfaceCombat) {
      memory.combatHold = COMBAT_LINGER_SECONDS;
    } else if (memory.combatHold > 0) {
      memory.combatHold = Math.max(0, memory.combatHold - stepDt);
    }
    combatActive = memory.combatHold > 0;
  }

  // 1. Hero start screen (from splash unlock through the pull-back cinematic)
  if (heroActive) return 'hero-theme';

  // 2. Galaxy star map & immediate warp/rift route-confirmation dialog
  if (starmapOpen || routeChoiceOpen) return 'pool:starmap';

  // 3. Active hostile surface skirmish (+ 5 s cooldown tail)
  if (combatActive) return 'surface-combat';

  // 4. Black hole accretion-zone proximity (hysteresis: enter < 7R, exit > 8.2R)
  let inBlackHole = Boolean(nearBlackHole);
  if (typeof blackHoleRatio === 'number' && Number.isFinite(blackHoleRatio)) {
    if (memory) {
      if (blackHoleRatio < 7.0) memory.inBlackHole = true;
      else if (blackHoleRatio > 8.2) memory.inBlackHole = false;
      inBlackHole = memory.inBlackHole;
    } else {
      inBlackHole = blackHoleRatio < 7.0;
    }
  } else if (memory) {
    memory.inBlackHole = inBlackHole;
  }
  if (inBlackHole) return 'pool:blackhole';

  // 5. Dimensional rift portal route (opening & crossing)
  if (riftActive) return 'pool:rift';

  // 6. Cross-system warp conduit
  if (state === 'warp') return 'interstellar-flight';

  // 7. High-altitude HALO skydive & canopy glide
  if (state === 'skydive') return 'halo-skydive';

  // 8. Gas giant / ice giant deep storm atmosphere dive
  let inGasDive = Boolean(gasGiantDive);
  if (typeof gasGiantAltRatio === 'number' && Number.isFinite(gasGiantAltRatio)) {
    if (memory) {
      if (gasGiantAltRatio < 0.58) memory.inGasGiantDive = true;
      else if (gasGiantAltRatio > 0.74) memory.inGasGiantDive = false;
      inGasDive = memory.inGasGiantDive;
    } else {
      inGasDive = gasGiantAltRatio < 0.58;
    }
  } else if (memory) {
    memory.inGasGiantDive = inGasDive;
  }
  if (inGasDive && (state === 'space' || state === 'flyto')) {
    return 'gas-giant-dive';
  }

  // 9. Subsurface ocean / seabed exploration
  if (underwater) return 'abyssal-dive';

  // 10. Planetary surface context: on foot, descending to land, parked on pad,
  //     or walking inside a grounded ship (high-altitude skydive hover excluded).
  const onPlanetSurface = state === 'walk'
    || state === 'landing'
    || (state === 'landed' && shipLanded)
    || (state === 'shipwalk' && shipLanded);

  if (onPlanetSurface && planetType) {
    if (planetType === 'artificialHabitat') return 'floating-city';

    if (civilizationSiteType === 'hero-city-world' && civilizationDistance < 2800) {
      return 'pool:metropolis';
    }
    if (civilizationSiteType && civilizationSiteType.endsWith('outpost') && civilizationDistance < 360) {
      return 'frontier-metropolis';
    }

    const habitable = planetType === 'lush' || planetType === 'ocean';
    if (habitable) {
      const effectiveKey = planetKey || planetType;
      const switchedBody = memory && memory.lastPlanetKey !== effectiveKey;
      if (memory) memory.lastPlanetKey = effectiveKey;

      // Alpine snow biome overrides day/night habitable surface theme.
      let inAlpine = snowWeight > 0.32;
      if (memory) {
        if (switchedBody) memory.inAlpine = snowWeight > 0.32;
        else if (snowWeight >= 0.35) memory.inAlpine = true;
        else if (snowWeight <= 0.25) memory.inAlpine = false;
        inAlpine = memory.inAlpine;
      }
      if (inAlpine) return 'pool:alpine';

      // Nocturnal theme on lush/ocean worlds (enter <= 0.22, exit >= 0.30).
      if (typeof dayFactor === 'number' && Number.isFinite(dayFactor)) {
        let inNight = dayFactor < 0.25;
        if (memory) {
          if (switchedBody) memory.inLushNight = dayFactor < 0.25;
          else if (dayFactor <= 0.22) memory.inLushNight = true;
          else if (dayFactor >= 0.30) memory.inLushNight = false;
          inNight = memory.inLushNight;
        }
        if (inNight) return 'lush-night';
      }
    } else if (memory) {
      memory.lastPlanetKey = planetKey || planetType;
      memory.inAlpine = false;
      memory.inLushNight = false;
    }

    return planetPoolSelector(planetType) || 'pool:cruise';
  }

  // 11. Low-altitude flight approach to civilization megastructures & orbital hubs
  if (state === 'space' || state === 'flyto') {
    if (planetType === 'artificialHabitat' && civilizationDistance < 8500) {
      return 'floating-city';
    }
    if (civilizationSiteType === 'hero-city-world' && civilizationDistance < 24000) {
      return 'pool:metropolis';
    }
    if (nearOrbitalStation) {
      return 'frontier-metropolis';
    }
  }

  // 12. Open space, interplanetary cruise, takeoff, airborne cabin walk & boarding
  if (state === 'space' || state === 'flyto' || state === 'landing' || state === 'landed'
    || state === 'shipwalk' || state === 'takeoff' || state === 'boarding') {
    return 'pool:cruise';
  }

  return null;
}

function normalizeSelector(selector) {
  if (!selector) return null;
  if (selector === 'cruise:any') return 'pool:cruise';
  if (selector.startsWith('pool:')) return selector;
  if (POOL_MEMBERS.has(selector) && !TRACK_DEFS.some((t) => t.id === selector)) {
    return `pool:${selector}`;
  }
  return selector;
}

export class BackgroundMusic {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.ctx = null;
    this.filter = null;
    this.master = null;
    this.tracks = new Map();       // id -> { el, source, gain, def, loaded, endedHandler, stopTimer }
    this.current = null;           // active track id
    this.currentPool = null;       // def.pool of active track
    this.activeTarget = null;      // canonical target ('pool:<name>' or track id)
    this.poolHistory = new Map();  // pool -> [trackId, ...] recent picks
    this.memory = createDirectorMemory();
    this.ready = false;
    this.paused = false;
    this.muffled = false;
    this.targetVolume = MASTER_VOLUME;
    this.disposed = false;
  }

  // Bind to an already-running AudioContext (typically FlightAudio's) so the
  // browser's per-tab AudioContext quota is shared with procedural SFX.
  attach(ctx) {
    if (this.disposed || this.ctx || !ctx) return;
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(ctx.destination);

    if (typeof ctx.createBiquadFilter === 'function') {
      this.filter = ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = OPEN_AIR_HZ;
      this.filter.Q.value = 0.65;
      this.filter.connect(this.master);
    }

    const sink = this.filter || this.master;
    for (const def of TRACK_DEFS) {
      const el = new Audio();
      el.preload = 'none';
      el.loop = false;
      const source = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(sink);
      const rec = { el, source, gain, def, loaded: false, endedHandler: null, stopTimer: null };
      const onEnded = () => this._onTrackEnded(def.id);
      el.addEventListener('ended', onEnded);
      rec.endedHandler = onEnded;
      this.tracks.set(def.id, rec);
    }
    this.ready = true;
  }

  _ensureLoaded(id) {
    const rec = this.tracks.get(id);
    if (!rec || rec.loaded) return;
    rec.el.src = AUDIO_BASE + rec.def.file;
    rec.el.load();
    rec.loaded = true;
  }

  _isMultiTrackTarget(target) {
    if (!target || !target.startsWith('pool:')) return false;
    const pool = target.slice(5);
    const members = POOL_MEMBERS.get(pool);
    return Boolean(members && members.length > 1);
  }

  _recordPoolPick(pool, pickId) {
    const members = POOL_MEMBERS.get(pool);
    if (!members || members.length <= 1) return;
    const history = (this.poolHistory.get(pool) || []).filter((id) => id !== pickId);
    history.push(pickId);
    // Suppress repeating the entire recent cycle minus one so boundaries stay fresh.
    const keepCount = Math.max(1, Math.min(members.length - 1, Math.ceil(members.length * 0.6)));
    this.poolHistory.set(pool, history.slice(-keepCount));
  }

  _nextInPool(pool, excludeId = null) {
    const members = POOL_MEMBERS.get(pool);
    if (!members || members.length === 0) return null;
    if (members.length === 1) return members[0].id;
    const history = this.poolHistory.get(pool) || [];
    const fresh = members
      .map((m) => m.id)
      .filter((mid) => mid !== excludeId && !history.includes(mid));
    const fallback = members
      .map((m) => m.id)
      .filter((mid) => mid !== excludeId);
    const pickFrom = fresh.length ? fresh : (fallback.length ? fallback : members.map((m) => m.id));
    const idx = Math.min(pickFrom.length - 1, Math.floor(this.random() * pickFrom.length));
    const pick = pickFrom[idx];
    this._recordPoolPick(pool, pick);
    return pick;
  }

  _onTrackEnded(id) {
    if (this.disposed || this.current !== id) return;
    const rec = this.tracks.get(id);
    if (!rec) return;

    if (this._isMultiTrackTarget(this.activeTarget)) {
      const pool = this.activeTarget.slice(5);
      const next = this._nextInPool(pool, id);
      if (next && next !== id) {
        this.cue(next, { fade: POOL_ADVANCE_FADE_SECONDS, preserveTarget: this.activeTarget });
        return;
      }
    }

    // Single-track target or 1-member pool safety net: replay seamlessly.
    rec.el.currentTime = 0;
    rec.el.play().catch(() => {});
  }

  // Cue a specific track id or a `pool:<name>` selector (crossfading over `fade` s).
  cue(selector, { fade = FADE_SECONDS, preserveTarget = null } = {}) {
    if (this.disposed || !this.ready) return;
    const normalized = normalizeSelector(selector);
    if (!normalized) return;

    let trackId = normalized;
    let targetDescriptor = preserveTarget || normalized;

    if (normalized.startsWith('pool:')) {
      const pool = normalized.slice(5);
      const members = POOL_MEMBERS.get(pool);
      if (!members || members.length === 0) return;
      // If we're already playing a member of this exact pool, adopt the pool
      // target without restarting the song mid-phrase.
      if (this.current && members.some((m) => m.id === this.current)) {
        this.activeTarget = targetDescriptor;
        this.currentPool = pool;
        const activeRec = this.tracks.get(this.current);
        if (activeRec) activeRec.el.loop = !this._isMultiTrackTarget(targetDescriptor);
        return;
      }
      trackId = this._nextInPool(pool, this.current);
      if (!trackId) return;
    }

    const rec = this.tracks.get(trackId);
    if (!rec) return;

    if (trackId === this.current) {
      this.activeTarget = targetDescriptor;
      rec.el.loop = !this._isMultiTrackTarget(targetDescriptor);
      return;
    }

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const outgoingId = this.current;
    const outgoing = outgoingId ? this.tracks.get(outgoingId) : null;
    if (outgoing) {
      if (outgoing.stopTimer) {
        clearTimeout(outgoing.stopTimer);
        outgoing.stopTimer = null;
      }
      outgoing.gain.gain.cancelScheduledValues(now);
      outgoing.gain.gain.setValueAtTime(Math.max(0.0001, outgoing.gain.gain.value), now);
      outgoing.gain.gain.linearRampToValueAtTime(0.0001, now + fade);
      const stoppingEl = outgoing.el;
      outgoing.stopTimer = setTimeout(() => {
        outgoing.stopTimer = null;
        if (this.disposed || this.current === outgoingId) return;
        try { stoppingEl.pause(); } catch { /* already paused */ }
        stoppingEl.currentTime = 0;
      }, fade * 1000 + 60);
    }

    if (rec.stopTimer) {
      clearTimeout(rec.stopTimer);
      rec.stopTimer = null;
    }

    this.current = trackId;
    this.currentPool = rec.def.pool;
    this.activeTarget = targetDescriptor;
    if (!normalized.startsWith('pool:')) {
      this._recordPoolPick(rec.def.pool, trackId);
    }

    this._ensureLoaded(trackId);
    rec.el.loop = !this._isMultiTrackTarget(targetDescriptor);

    const startGain = rec.el.paused ? 0.0001 : Math.max(0.0001, rec.gain.gain.value || 0.0001);
    const targetGain = this.paused ? 0.0001 : Math.max(0.0001, this.targetVolume);
    rec.gain.gain.cancelScheduledValues(now);
    rec.gain.gain.setValueAtTime(startGain, now);
    rec.gain.gain.linearRampToValueAtTime(targetGain, now + fade);

    if (!this.paused) {
      const p = rec.el.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {});
      }
    }
  }

  silence({ fade = FADE_SECONDS } = {}) {
    if (this.disposed || !this.ready) return;
    this.activeTarget = null;
    const outgoingId = this.current;
    const outgoing = outgoingId ? this.tracks.get(outgoingId) : null;
    if (!outgoing) return;
    if (outgoing.stopTimer) {
      clearTimeout(outgoing.stopTimer);
      outgoing.stopTimer = null;
    }
    const now = this.ctx.currentTime;
    outgoing.gain.gain.cancelScheduledValues(now);
    outgoing.gain.gain.setValueAtTime(Math.max(0.0001, outgoing.gain.gain.value), now);
    outgoing.gain.gain.linearRampToValueAtTime(0.0001, now + fade);
    const stoppingEl = outgoing.el;
    outgoing.stopTimer = setTimeout(() => {
      outgoing.stopTimer = null;
      if (this.disposed || this.current !== outgoingId) return;
      try { stoppingEl.pause(); } catch { /* already paused */ }
      this.current = null;
      this.currentPool = null;
    }, fade * 1000 + 60);
  }

  _updateCabinFilter(muffled) {
    const next = Boolean(muffled);
    if (next === this.muffled || !this.ready) return;
    this.muffled = next;
    const now = this.ctx.currentTime;
    if (this.filter) {
      this.filter.frequency.cancelScheduledValues(now);
      this.filter.frequency.setValueAtTime(Math.max(200, this.filter.frequency.value), now);
      this.filter.frequency.exponentialRampToValueAtTime(next ? CABIN_MUFFLE_HZ : OPEN_AIR_HZ, now + 0.55);
    }
    if (this.master) {
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(next ? 0.84 : 1.0, now + 0.55);
    }
  }

  // Reconcile desired score state every frame from main.js.
  update(snapshot = {}) {
    if (this.disposed) return;
    const want = normalizeSelector(pickTrack(snapshot, this.memory));
    this._updateCabinFilter(snapshot.muffledCabin);

    if (!this.ready) return;
    if (!want) {
      if (this.current) this.silence();
      return;
    }
    if (want === this.activeTarget && this.current) return;
    this.cue(want);
  }

  setPaused(paused) {
    if (this.disposed) return;
    this.paused = paused;
    if (!this.ready || !this.current) return;
    const now = this.ctx.currentTime;
    const rec = this.tracks.get(this.current);
    if (!rec) return;
    rec.gain.gain.cancelScheduledValues(now);
    rec.gain.gain.setValueAtTime(Math.max(0.0001, rec.gain.gain.value), now);
    rec.gain.gain.linearRampToValueAtTime(paused ? 0.0001 : this.targetVolume, now + 0.3);
    if (paused) {
      try { rec.el.pause(); } catch { /* already paused */ }
    } else {
      rec.el.play().catch(() => {});
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    for (const rec of this.tracks.values()) {
      if (rec.stopTimer) clearTimeout(rec.stopTimer);
      if (rec.endedHandler) rec.el.removeEventListener('ended', rec.endedHandler);
      try { rec.el.pause(); } catch { /* noop */ }
      try { rec.el.src = ''; } catch { /* noop */ }
      try { rec.source.disconnect(); } catch { /* noop */ }
      try { rec.gain.disconnect(); } catch { /* noop */ }
    }
    this.tracks.clear();
    if (this.filter) {
      try { this.filter.disconnect(); } catch { /* noop */ }
      this.filter = null;
    }
    if (this.master) {
      try { this.master.disconnect(); } catch { /* noop */ }
      this.master = null;
    }
    this.ctx = null;
    this.current = null;
    this.currentPool = null;
    this.activeTarget = null;
  }
}
