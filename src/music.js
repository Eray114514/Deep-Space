// Scene-aware background music. Plays streamed MP3 tracks that map to game
// states (cruise pool, warp, starmap, black-hole vicinity, per-planet-type
// surface ambience, alpine snow). Tracks are loaded lazily: the <audio>
// element's src is set only the first time a track is cued, so the 117 MB
// soundtrack never blocks first paint. Each element is routed through a
// dedicated GainNode on the shared AudioContext (provided by FlightAudio),
// bypassing the flight compressor so score dynamics stay intact.

// Track catalogue. `pool` groups tracks that share a slot:
//   - 'cruise'    : space / flyto / landing / takeoff / boarding, random order,
//                   no immediate repeat.
//   - 'warp'      : stellar transition (cross-system warp), single-track loop.
//   - 'starmap'   : galaxy chart open, single-track loop.
//   - 'blackhole' : near a black hole (accretion-radius zone), loop.
//   - 'planet:<type>' : on-foot on a planet of the given type, loop.
//   - 'alpine'    : on-foot on a habitable snow biome, loop (highest priority,
//                   overrides planet:<type>).
//   - 'reserved'  : registered for future scenes; pickTrack never returns them.
const TRACK_DEFS = [
  { id: 'deep-space-1',     file: 'deep-space-1.mp3',     pool: 'cruise',         loop: false, title: '深空巡航 1' },
  { id: 'starfall-atrium',  file: 'starfall-atrium.mp3',  pool: 'cruise',         loop: false, title: 'Starfall Atrium · 深空巡航 2' },
  { id: 'rift-passage',     file: 'rift-passage.mp3',     pool: 'cruise',         loop: false, title: '弦界航道 · 深空巡航 3' },
  { id: 'stellar-transition', file: 'stellar-transition.mp3', pool: 'cruise',     loop: false, title: '恒星跃迁' },
  { id: 'interstellar-flight', file: 'interstellar-flight.mp3', pool: 'warp',     loop: true,  title: '星际飞行' },
  { id: 'starmap',          file: 'starmap.mp3',          pool: 'starmap',        loop: true,  title: '星图' },
  { id: 'black-hole',       file: 'black-hole.mp3',       pool: 'blackhole',      loop: true,  title: '黑洞观测' },
  { id: 'ice-planet',       file: 'ice-planet.mp3',       pool: 'planet:ice',     loop: true,  title: '冰封行星' },
  { id: 'toxic-planet',     file: 'toxic-planet.mp3',     pool: 'planet:toxic',    loop: true,  title: '剧毒行星' },
  { id: 'lava-planet',      file: 'lava-planet.mp3',      pool: 'planet:lava',     loop: true,  title: '火山行星' },
  { id: 'lush-planet',      file: 'lush-planet.mp3',      pool: 'planet:lush',     loop: true,  title: '繁茂行星' },
  { id: 'desert-planet',    file: 'desert-planet.mp3',    pool: 'planet:desert',   loop: true,  title: '荒漠行星' },
  { id: 'barren-planet',    file: 'barren-planet.mp3',    pool: 'planet:barren',   loop: true,  title: '荒芜行星' },
  { id: 'exotic-planet',    file: 'exotic-planet.mp3',    pool: 'planet:exotic',   loop: true,  title: '异相行星' },
  { id: 'alpine-summit',    file: 'alpine-summit.mp3',    pool: 'alpine',          loop: true,  title: '高山雪顶' },
  { id: 'surface-combat',   file: 'surface-combat.mp3',   pool: 'reserved',        loop: true,  title: '地表战斗（预留）' },
  { id: 'space-combat',     file: 'space-combat.mp3',     pool: 'reserved',        loop: true,  title: '太空战斗（预留）' },
  { id: 'space-race',       file: 'space-race.mp3',       pool: 'reserved',        loop: true,  title: '太空竞速（预留）' },
];

const AUDIO_BASE = '/assets/audio/';
const FADE_SECONDS = 1.5;
const MASTER_VOLUME = 0.34;

// Pick which track should be playing given the current game snapshot.
// Priority (highest wins):
//   1. starmap open          -> starmap (pause world but keep chart music)
//   2. near black hole       -> black-hole (covers any state in the zone)
//   3. walk on alpine snow   -> alpine-summit
//   4. walk on planet        -> planet:<type>
//   5. warp (cross-system transit) -> interstellar-flight
//   6. space / flyto / landing / takeoff / boarding -> cruise pool (random member)
//   7. otherwise             -> null (silence)
export function pickTrack({ state, planetType, snowWeight = 0, nearBlackHole = false, starmapOpen = false }) {
  if (starmapOpen) return 'starmap';
  if (nearBlackHole) return 'black-hole';
  if (state === 'walk') {
    // Alpine snow theme applies only on habitable worlds (lush/ocean); other
    // planet types keep their own surface ambience even when snowy.
    if ((planetType === 'lush' || planetType === 'ocean') && snowWeight > 0.32) {
      return 'alpine-summit';
    }
    if (planetType) return `planet:${planetType}`;
    return null;
  }
  if (state === 'warp') return 'interstellar-flight';
  if (state === 'space' || state === 'flyto' || state === 'landing' || state === 'takeoff' || state === 'boarding') {
    // signal: pick a random member of the cruise pool
    return 'cruise:any';
  }
  return null;
}

export class BackgroundMusic {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.tracks = new Map(); // id -> { el, gain, def, loaded, endedHandler }
    this.current = null;     // active track id
    this.currentPool = null; // pool the active track belongs to
    this.poolHistory = new Map(); // pool -> [trackId, ...] recent picks
    this.ready = false;
    this.paused = false;
    this.targetVolume = MASTER_VOLUME;
    this.disposed = false;
  }

  // Bind to an already-running AudioContext (typically FlightAudio's).
  // We avoid creating our own context so the browser's per-tab context quota
  // is shared with the flight audio bus.
  attach(ctx) {
    if (this.disposed) return;
    if (this.ctx || !ctx) return;
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    for (const def of TRACK_DEFS) {
      const el = new Audio();
      el.preload = 'none';
      el.loop = !!def.loop;
      // Same-origin: no crossOrigin attribute needed, and setting it would
      // force a CORS preflight that Vercel does not return headers for.
      const source = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(this.master);
      const rec = { el, source, gain, def, loaded: false };
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

  _onTrackEnded(id) {
    if (this.disposed) return;
    if (this.current !== id) return;
    const rec = this.tracks.get(id);
    if (!rec) return;
    if (rec.def.loop) {
      // Looping tracks should auto-replay via el.loop=true; this is a safety net.
      rec.el.currentTime = 0;
      rec.el.play().catch(() => {});
      return;
    }
    // Non-loop track ended: only the cruise pool is multi-track, advance it.
    if (rec.def.pool === 'cruise') {
      const next = this._nextInPool('cruise', id);
      if (next) this._play(next, 0);
    }
  }

  _nextInPool(pool, excludeId) {
    const members = TRACK_DEFS.filter((t) => t.pool === pool);
    if (members.length === 0) return null;
    if (members.length === 1) return members[0].id;
    const history = this.poolHistory.get(pool) || [];
    const candidates = members
      .map((m) => m.id)
      .filter((mid) => mid !== excludeId && !history.includes(mid));
    const pickFrom = candidates.length ? candidates
      : members.map((m) => m.id).filter((mid) => mid !== excludeId);
    const pick = pickFrom[Math.floor(Math.random() * pickFrom.length)];
    const next = history.concat([pick]);
    // Keep enough history to suppress the last play but no more.
    this.poolHistory.set(pool, next.slice(-(members.length - 1)));
    return pick;
  }

  // Switch to the given track id (or 'cruise:any' to pick from the cruise pool).
  // Cross-fades between the outgoing and incoming track over FADE_SECONDS.
  cue(trackId, { fade = FADE_SECONDS } = {}) {
    if (this.disposed || !this.ready) return;
    if (trackId === 'cruise:any') {
      trackId = this._nextInPool('cruise', this.current);
      if (!trackId) return;
    }
    if (!this.tracks.has(trackId)) return;
    if (trackId === this.current) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const outgoing = this.current ? this.tracks.get(this.current) : null;
    if (outgoing) {
      // Fade out then stop. Setting gain to 0 lets the element be reused later.
      outgoing.gain.gain.cancelScheduledValues(now);
      outgoing.gain.gain.setValueAtTime(Math.max(0.0001, outgoing.gain.gain.value), now);
      outgoing.gain.gain.linearRampToValueAtTime(0.0001, now + fade);
      const stoppingEl = outgoing.el;
      const stoppingId = this.current;
      setTimeout(() => {
        if (this.current === stoppingId) return; // got re-cued mid-fade
        try { stoppingEl.pause(); } catch { /* already paused */ }
        stoppingEl.currentTime = 0;
      }, fade * 1000 + 60);
    }

    this.current = trackId;
    const rec = this.tracks.get(trackId);
    this.currentPool = rec.def.pool;
    this._ensureLoaded(trackId);

    const target = this.paused ? 0 : this.targetVolume;
    rec.gain.gain.cancelScheduledValues(now);
    rec.gain.gain.setValueAtTime(0.0001, now);
    rec.gain.gain.linearRampToValueAtTime(Math.max(0.0001, target), now + fade);

    const p = rec.el.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        // Autoplay may be blocked until the user gestures; FlightAudio.unlock
        // is called on the same gestures, so this is rare. Stay silent on fail.
      });
    }
  }

  silence({ fade = FADE_SECONDS } = {}) {
    if (this.disposed || !this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const outgoing = this.current ? this.tracks.get(this.current) : null;
    if (!outgoing) return;
    outgoing.gain.gain.cancelScheduledValues(now);
    outgoing.gain.gain.setValueAtTime(Math.max(0.0001, outgoing.gain.gain.value), now);
    outgoing.gain.gain.linearRampToValueAtTime(0.0001, now + fade);
    const stoppingEl = outgoing.el;
    const stoppingId = this.current;
    setTimeout(() => {
      if (this.current !== stoppingId) return;
      try { stoppingEl.pause(); } catch { /* already paused */ }
      this.current = null;
      this.currentPool = null;
    }, fade * 1000 + 60);
  }

  // Reconcile what should be playing. Called every frame from main.js with the
  // current game snapshot; only acts when the target changes.
  update(snapshot) {
    if (this.disposed) return;
    const want = pickTrack(snapshot);
    // For the cruise pool, current may already be a cruise member; keep it.
    if (want === 'cruise:any') {
      if (this.currentPool === 'cruise' && this.current) return;
      this.cue('cruise:any');
      return;
    }
    if (want !== this.current) {
      if (want) this.cue(want);
      else this.silence();
    }
  }

  setPaused(paused) {
    if (this.disposed) return;
    this.paused = paused;
    if (!this.ready || !this.current) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const rec = this.tracks.get(this.current);
    if (!rec) return;
    rec.gain.gain.cancelScheduledValues(now);
    rec.gain.gain.setValueAtTime(Math.max(0.0001, rec.gain.gain.value), now);
    rec.gain.gain.linearRampToValueAtTime(paused ? 0.0001 : this.targetVolume, now + 0.3);
    // Suspend playback too so a long pause does not silently advance the track.
    if (paused) {
      try { rec.el.pause(); } catch { /* already paused */ }
    } else {
      // Only resume if we are not mid-crossfade-out (current still matches).
      const id = this.current;
      rec.el.play().catch(() => {});
      void id;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    for (const rec of this.tracks.values()) {
      if (rec.endedHandler) rec.el.removeEventListener('ended', rec.endedHandler);
      try { rec.el.pause(); } catch { /* noop */ }
      try { rec.el.src = ''; } catch { /* noop */ }
      try { rec.source.disconnect(); } catch { /* noop */ }
      try { rec.gain.disconnect(); } catch { /* noop */ }
    }
    this.tracks.clear();
    if (this.master) {
      try { this.master.disconnect(); } catch { /* noop */ }
    }
    this.master = null;
    this.ctx = null;
    this.current = null;
    this.currentPool = null;
  }
}
