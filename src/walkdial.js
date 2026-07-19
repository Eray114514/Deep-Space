// Walk-mode instrument dial (仪表盘): replaces the old bottom-left surface
// HUD with a survey watch — local solar time, mission sol, the body underfoot
// with a live day/night terminator, suit integrity, ship-cell charge, heading
// and a bearing back to the parked ship. Pure shadow-DOM SVG + canvas; the
// game drives it through setState(), and setActive() pauses the planet pass
// whenever the player is back in the cockpit.

const NS = 'http://www.w3.org/2000/svg';
const VIEW = 932;
const CX = 466;
const CY = 448;
const INK = 'rgba(5, 13, 18, .78)';      // translucent watch face over terrain
const BEZEL = 'rgba(3, 9, 13, .92)';
const WHITE = '#eef3f3';
const GREY = '#8b9294';
const RED = '#ff2230';

const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, Number(n)));
const deepMerge = (target, patch) => {
  for (const key of Object.keys(patch || {})) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = deepMerge({ ...target[key] }, value);
    } else target[key] = value;
  }
  return target;
};
const polar = (r, deg) => {
  const a = deg * Math.PI / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
};
const annularSector = (r0, r1, a0, a1) => {
  const p0 = polar(r1, a0), p1 = polar(r1, a1), q1 = polar(r0, a1), q0 = polar(r0, a0);
  const delta = Math.abs(a1 - a0);
  const large = delta > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M ${p0[0]} ${p0[1]} A ${r1} ${r1} 0 ${large} ${sweep} ${p1[0]} ${p1[1]} L ${q1[0]} ${q1[1]} A ${r0} ${r0} 0 ${large} ${1 - sweep} ${q0[0]} ${q0[1]} Z`;
};
const svgEl = (name, attrs = {}) => {
  const el = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

function weatherGlyph(kind) {
  const g = svgEl('g', { transform: 'translate(153 276)', fill: WHITE, stroke: WHITE, 'stroke-width': 2 });
  if (kind === 'clear') {
    g.append(svgEl('circle', { cx: 33, cy: 25, r: 13, fill: 'none', 'stroke-width': 3.4 }));
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      g.append(svgEl('line', {
        x1: 33 + Math.cos(a) * 18, y1: 25 + Math.sin(a) * 18,
        x2: 33 + Math.cos(a) * 24, y2: 25 + Math.sin(a) * 24, 'stroke-width': 3.4,
      }));
    }
    return g;
  }
  // shared cloud silhouette for precipitation states
  g.append(svgEl('path', {
    d: 'M 5 28 C 4 17 12 11 21 12 C 25 2 42 2 47 13 C 57 13 63 19 61 28 C 59 35 52 38 43 38 L 19 38 C 10 38 6 34 5 28 Z',
  }));
  if (kind === 'rain') {
    for (const x of [17, 27, 37, 47]) g.append(svgEl('line', { x1: x, y1: 41, x2: x, y2: 48, 'stroke-width': 3 }));
  } else if (kind === 'snow') {
    for (const x of [17, 29, 41]) {
      g.append(svgEl('line', { x1: x - 3, y1: 43, x2: x + 3, y2: 49, 'stroke-width': 2.4 }));
      g.append(svgEl('line', { x1: x + 3, y1: 43, x2: x - 3, y2: 49, 'stroke-width': 2.4 }));
    }
  } else if (kind === 'storm') {
    g.append(svgEl('path', { d: 'M 31 40 L 24 52 L 30 52 L 26 62 L 38 48 L 31 48 L 36 40 Z', stroke: 'none' }));
  }
  return g;
}

class SpaceExplorationDial extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.state = {
      time: { seconds: 0, running: false },
      date: { day: 'SOL', month: 'UT', date: 0 },
      planet: { name: '—', phase: 0, rotation: 0, lightTilt: -0.12, selected: true },
      ap: 1,
      battery: 1,
      heading: 0,
      destinationBearing: null,
      weather: 'clear',
    };
    this._active = false;
    this._start = performance.now();
    this._lastPlanet = 0;
    this._raf = 0;
    this._build();
  }

  connectedCallback() {
    this._resizePlanet();
    this._ro = new ResizeObserver(() => this._resizePlanet());
    this._ro.observe(this);
    this._raf = requestAnimationFrame((t) => this._tick(t));
    this.shadowRoot.querySelector('.planetHit').addEventListener('click', () => {
      this.state.planet.selected = !this.state.planet.selected;
      this._renderState();
    });
  }

  disconnectedCallback() {
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
  }

  setState(patch) {
    this.state = deepMerge({ ...this.state }, patch || {});
    this.state.ap = clamp(this.state.ap);
    this.state.battery = clamp(this.state.battery);
    this.state.planet.phase = clamp(this.state.planet.phase, -0.98, 0.98);
    this._renderState();
    return this;
  }

  getState() { return structuredClone(this.state); }

  setActive(active = true) {
    active = !!active;
    if (active === this._active) return this;
    this._active = active;
    if (active) {
      this._lastPlanet = 0;
      this._resizePlanet();
    }
    return this;
  }

  _build() {
    this.shadowRoot.innerHTML = `
      <style>
        :host{contain:layout paint style;user-select:none;-webkit-user-select:none;touch-action:manipulation}
        .wrap{position:relative;width:100%;height:100%;overflow:hidden}
        svg{position:absolute;inset:0;width:100%;height:100%;display:block}
        .planetCanvas{position:absolute;left:31.116%;top:28.755%;width:38.412%;height:38.412%;border-radius:50%;z-index:2;image-rendering:auto}
        .dialSvg{z-index:1}
        .frontSvg{z-index:3;pointer-events:none}
        .planetHit{pointer-events:auto;cursor:pointer;fill:transparent}
        .txt{
          fill:${WHITE};
          font-family:Consolas,"Cascadia Mono","Courier New","Microsoft YaHei UI",monospace;
          font-weight:700;
          letter-spacing:1.2px;
          paint-order:stroke;
          stroke:${WHITE};
          stroke-width:.35px;
          text-rendering:geometricPrecision;
        }
        .time{font-size:65px;letter-spacing:7px}
        .dateLabel{font-size:53px;letter-spacing:2px}
        .sideLabel{font-size:53px;letter-spacing:1px}
        .planetLabel{font-size:55px;letter-spacing:0}
        .dateNumber{font-size:53px}
        .scan{position:absolute;inset:0;z-index:4;pointer-events:none;opacity:.09;mix-blend-mode:soft-light;background:repeating-linear-gradient(to bottom,rgba(255,255,255,.22) 0,rgba(255,255,255,.22) 1px,rgba(0,0,0,.18) 2px,transparent 4px)}
        @media (prefers-reduced-motion:reduce){.scan{display:none}}
      </style>
      <div class="wrap">
        <svg class="dialSvg" viewBox="0 0 932 932" aria-hidden="true"></svg>
        <canvas class="planetCanvas" width="420" height="420"></canvas>
        <svg class="frontSvg" viewBox="0 0 932 932" role="img" aria-label="地表探索表盘"></svg>
        <div class="scan"></div>
      </div>`;

    const back = this.shadowRoot.querySelector('.dialSvg');
    const front = this.shadowRoot.querySelector('.frontSvg');

    const defs = svgEl('defs');
    const glow = svgEl('filter', { id: 'edgeGlow', x: '-30%', y: '-30%', width: '160%', height: '160%' });
    glow.append(svgEl('feGaussianBlur', { stdDeviation: '1.35', result: 'b' }));
    const merge = svgEl('feMerge');
    merge.append(svgEl('feMergeNode', { in: 'b' }));
    merge.append(svgEl('feMergeNode', { in: 'SourceGraphic' }));
    glow.append(merge);
    defs.append(glow);
    back.append(defs);

    // outer bezel: dark ring with thin ivory outlines
    back.append(svgEl('circle', { cx: CX, cy: CY, r: 431, fill: BEZEL, stroke: WHITE, 'stroke-width': 4.2, filter: 'url(#edgeGlow)' }));
    back.append(svgEl('circle', { cx: CX, cy: CY, r: 408, fill: 'none', stroke: 'rgba(2,8,11,.9)', 'stroke-width': 20 }));
    back.append(svgEl('circle', { cx: CX, cy: CY, r: 397, fill: 'none', stroke: WHITE, 'stroke-width': 4.2, filter: 'url(#edgeGlow)' }));
    back.append(svgEl('circle', { cx: CX, cy: CY, r: 383, fill: INK, stroke: WHITE, 'stroke-width': 4.2, filter: 'url(#edgeGlow)' }));

    // lower AP / BAT arc beds
    back.append(svgEl('path', { d: annularSector(277, 356, 180, 90), fill: 'rgba(36,40,42,.72)' }));
    back.append(svgEl('path', { d: annularSector(277, 356, 90, 0), fill: 'rgba(36,40,42,.72)' }));
    this.apArc = svgEl('path', { fill: GREY });
    this.batArc = svgEl('path', { fill: GREY });
    back.append(this.apArc, this.batArc);
    back.append(svgEl('path', { d: annularSector(277, 356, 90, 72), fill: WHITE }));

    // inner field and calibrated tick ring
    back.append(svgEl('circle', { cx: CX, cy: CY, r: 276, fill: INK }));
    const ticks = svgEl('g', { opacity: .73 });
    for (let i = 0; i < 64; i++) {
      const a = i * 360 / 64;
      const long = i % 8 === 0;
      const medium = i % 4 === 0;
      const r1 = long ? 247 : medium ? 252 : 258;
      const r2 = 267;
      const p1 = polar(r1, a), p2 = polar(r2, a);
      ticks.append(svgEl('line', {
        x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
        stroke: WHITE, 'stroke-width': long ? 6 : medium ? 4 : 3, 'stroke-linecap': 'butt',
      }));
    }
    back.append(ticks);

    // gauge registration dashes
    back.append(svgEl('line', { x1: 207, y1: 452, x2: 231, y2: 452, stroke: WHITE, 'stroke-width': 6 }));
    back.append(svgEl('line', { x1: 212, y1: 477, x2: 230, y2: 477, stroke: WHITE, 'stroke-width': 5 }));
    back.append(svgEl('line', { x1: 702, y1: 449, x2: 726, y2: 449, stroke: WHITE, 'stroke-width': 6 }));
    back.append(svgEl('line', { x1: 703, y1: 475, x2: 722, y2: 475, stroke: WHITE, 'stroke-width': 5 }));

    // destination marker (ivory) and current-heading marker (red)
    this.destinationMarker = svgEl('path', {
      d: 'M 457 18 L 478 18 L 488 55 L 449 55 Z', fill: WHITE, transform: `rotate(0 ${CX} ${CY})`,
    });
    this.headingMarker = svgEl('path', {
      d: 'M 454 38 L 478 38 L 490 57 L 478 75 L 454 75 L 442 57 Z', fill: RED, transform: `rotate(0 ${CX} ${CY})`,
    });
    back.append(this.destinationMarker, this.headingMarker);

    // planet outline above the animated canvas
    front.append(svgEl('circle', { cx: CX, cy: CY, r: 179, fill: 'none', stroke: WHITE, 'stroke-width': 5.2, filter: 'url(#edgeGlow)' }));

    // text labels
    this.timeText = svgEl('text', { x: 466, y: 162, 'text-anchor': 'middle', class: 'txt time' });
    this.dayText = svgEl('text', { x: 213, y: 218, 'text-anchor': 'start', class: 'txt dateLabel' });
    this.monthText = svgEl('text', { x: 605, y: 207, 'text-anchor': 'start', class: 'txt dateLabel' });
    this.dateText = svgEl('text', { x: 738, y: 323, 'text-anchor': 'middle', class: 'txt dateNumber' });
    this.apText = svgEl('text', { x: 126, y: 434, 'text-anchor': 'start', class: 'txt sideLabel' });
    this.batText = svgEl('text', { x: 728, y: 423, 'text-anchor': 'start', class: 'txt sideLabel' });
    this.planetText = svgEl('text', { x: 466, y: 679, 'text-anchor': 'middle', class: 'txt planetLabel' });
    this.apText.textContent = 'AP';
    this.batText.textContent = 'BAT';
    front.append(this.timeText, this.dayText, this.monthText, this.dateText, this.apText, this.batText, this.planetText);

    // weather glyph variants, toggled per state
    this.weatherGlyphs = {};
    for (const kind of ['clear', 'rain', 'snow', 'storm']) {
      const glyph = weatherGlyph(kind);
      glyph.style.display = 'none';
      this.weatherGlyphs[kind] = glyph;
      front.append(glyph);
    }

    // red target-lock indicator beside the planet name
    this.lockMarker = svgEl('path', {
      d: 'M 573 647 L 586 647 L 596 657 L 596 671 L 586 681 L 573 681 L 563 671 L 563 657 Z', fill: RED,
    });
    front.append(this.lockMarker);

    const hit = svgEl('circle', { cx: CX, cy: CY, r: 188, class: 'planetHit' });
    front.append(hit);

    this._renderState();
  }

  _resizePlanet() {
    if (!this._active) return;
    const canvas = this.shadowRoot.querySelector('.planetCanvas');
    const cssPx = Math.max(200, Math.round(this.clientWidth * 0.38412));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(cssPx * dpr);
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = canvas.height = px;
      this._drawPlanet(performance.now(), true);
    }
  }

  _renderState() {
    const seconds = Math.max(0, Math.floor(Number(this.state.time.seconds) || 0));
    const hh = String(Math.floor(seconds / 3600) % 100).padStart(2, '0');
    const mm = String(Math.floor(seconds / 60) % 60).padStart(2, '0');
    this.timeText.textContent = `${hh}:${mm}`;
    this.dayText.textContent = String(this.state.date.day || '').toUpperCase();
    this.monthText.textContent = String(this.state.date.month || '').toUpperCase();
    this.dateText.textContent = String(this.state.date.date ?? '');
    const name = String(this.state.planet.name || '—').toUpperCase();
    this.planetText.textContent = name;
    // keep long survey names inside the dial instead of spilling over the bezel
    if (name.length > 6) this.planetText.setAttribute('textLength', String(Math.min(330, 40 + name.length * 47)));
    else this.planetText.removeAttribute('textLength');
    this.planetText.setAttribute('lengthAdjust', 'spacingAndGlyphs');

    const apEnd = 180 - 90 * clamp(this.state.ap);
    const batStart = 90 - 90 * (1 - clamp(this.state.battery));
    this.apArc.setAttribute('d', annularSector(277, 356, 180, apEnd));
    this.batArc.setAttribute('d', annularSector(277, 356, batStart, 0));
    this.headingMarker.setAttribute('transform', `rotate(${Number(this.state.heading) || 0} ${CX} ${CY})`);
    const bearing = this.state.destinationBearing;
    this.destinationMarker.style.display = bearing == null ? 'none' : '';
    if (bearing != null) {
      this.destinationMarker.setAttribute('transform', `rotate(${Number(bearing) || 0} ${CX} ${CY})`);
    }
    this.lockMarker.style.opacity = this.state.planet.selected ? '1' : '.28';
    for (const [kind, glyph] of Object.entries(this.weatherGlyphs)) {
      glyph.style.display = kind === this.state.weather ? '' : 'none';
    }
  }

  _tick(now) {
    if (this._active && now - this._lastPlanet > 44) {
      this._lastPlanet = now;
      this._drawPlanet(now, false);
    }
    this._raf = requestAnimationFrame((t) => this._tick(t));
  }

  _drawPlanet(now, force) {
    const canvas = this.shadowRoot.querySelector('.planetCanvas');
    if (!canvas || !canvas.width || (!force && !this._active)) return;
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    const W = canvas.width, H = canvas.height;
    const phase = clamp(this.state.planet.phase, -0.98, 0.98);
    const rotation = Number(this.state.planet.rotation || 0);
    const tilt = Number(this.state.planet.lightTilt || 0);

    const image = ctx.createImageData(W, H);
    const data = image.data;
    const r = W * 0.495;
    const c = W * 0.5;
    const transverse = Math.sqrt(Math.max(0, 1 - phase * phase));
    const lx = -transverse * Math.cos(tilt), ly = transverse * Math.sin(tilt), lz = phase;
    for (let y = 0; y < H; y++) {
      const ny = (y - c) / r;
      for (let x = 0; x < W; x++) {
        const nx = (x - c) / r;
        const rr = nx * nx + ny * ny;
        const i = (y * W + x) * 4;
        if (rr > 1) { data[i + 3] = 0; continue; }
        const nz = Math.sqrt(Math.max(0, 1 - rr));
        const lit = nx * lx + ny * ly + nz * lz > 0;
        const scan = ((y & 3) === 0 ? -5 : 0) + (((x * 13 + y * 7) & 31) === 0 ? 3 : 0);
        const base = lit ? 237 : 8;
        data[i] = Math.max(0, Math.min(255, base + scan));
        data[i + 1] = Math.max(0, Math.min(255, lit ? base - 2 + scan : base + 6 + scan));
        data[i + 2] = Math.max(0, Math.min(255, lit ? base - 7 + scan : base + 10 + scan));
        data[i + 3] = 255;
      }
    }
    ctx.clearRect(0, 0, W, H);
    ctx.putImageData(image, 0, 0);

    // procedural topographic flow lines via marching squares
    const N = 72;
    const field = new Float32Array((N + 1) * (N + 1));
    const cs = Math.cos(rotation), sn = Math.sin(rotation);
    for (let gy = 0; gy <= N; gy++) {
      const yy = (gy / N) * 2 - 1;
      for (let gx = 0; gx <= N; gx++) {
        const xx = (gx / N) * 2 - 1;
        const X = xx * cs - yy * sn, Y = xx * sn + yy * cs;
        const vortex1 = Math.exp(-((X + 0.55) * (X + 0.55) + (Y - 0.38) * (Y - 0.38)) / 0.11);
        const vortex2 = Math.exp(-((X - 0.05) * (X - 0.05) + (Y + 0.72) * (Y + 0.72)) / 0.075);
        field[gy * (N + 1) + gx] =
          1.20 * Y + 0.22 * Math.sin(3.15 * X + 0.75 * Math.sin(2.2 * Y + rotation * 0.5))
          + 0.16 * Math.cos(2.8 * Y - 1.15 * X - rotation * 0.25)
          + 0.58 * vortex1 - 0.36 * vortex2;
      }
    }
    const interp = (v1, v2, level) => Math.abs(v2 - v1) < 1e-6 ? 0.5 : clamp((level - v1) / (v2 - v1));
    const drawSeg = (ax, ay, bx, by) => {
      const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
      const nx = (mx - c) / r, ny = (my - c) / r;
      const rr = nx * nx + ny * ny;
      if (rr >= 0.985) return;
      const nz = Math.sqrt(Math.max(0, 1 - rr));
      const lit = nx * lx + ny * ly + nz * lz > 0;
      ctx.strokeStyle = lit ? 'rgba(94,95,94,.74)' : 'rgba(238,243,243,.92)';
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    };
    ctx.save();
    ctx.lineWidth = Math.max(1.35, W / 210);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const step = W / N;
    const edgePoint = (edge, gx, gy, v00, v10, v11, v01, level) => {
      if (edge === 0) { const q = interp(v00, v10, level); return [(gx + q) * step, gy * step]; }
      if (edge === 1) { const q = interp(v10, v11, level); return [(gx + 1) * step, (gy + q) * step]; }
      if (edge === 2) { const q = interp(v01, v11, level); return [(gx + q) * step, (gy + 1) * step]; }
      const q = interp(v00, v01, level); return [gx * step, (gy + q) * step];
    };
    const table = {
      1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 2], [0, 1]], 6: [[0, 2]], 7: [[3, 2]],
      8: [[2, 3]], 9: [[0, 2]], 10: [[0, 3], [1, 2]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[3, 0]],
    };
    for (let level = -1.30; level <= 1.35; level += 0.17) {
      for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
        const v00 = field[gy * (N + 1) + gx], v10 = field[gy * (N + 1) + gx + 1];
        const v11 = field[(gy + 1) * (N + 1) + gx + 1], v01 = field[(gy + 1) * (N + 1) + gx];
        const code = (v00 > level ? 1 : 0) | (v10 > level ? 2 : 0) | (v11 > level ? 4 : 0) | (v01 > level ? 8 : 0);
        const pairs = table[code];
        if (!pairs) continue;
        for (const [e1, e2] of pairs) {
          const A = edgePoint(e1, gx, gy, v00, v10, v11, v01, level);
          const B = edgePoint(e2, gx, gy, v00, v10, v11, v01, level);
          drawSeg(A[0], A[1], B[0], B[1]);
        }
      }
    }
    ctx.restore();

    // hairline inner rim for the optically printed look
    ctx.save();
    ctx.strokeStyle = 'rgba(238,243,243,.92)';
    ctx.lineWidth = Math.max(2, W / 120);
    ctx.beginPath();
    ctx.arc(c, c, r * 0.988, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

if (!customElements.get('space-exploration-dial')) {
  customElements.define('space-exploration-dial', SpaceExplorationDial);
}
