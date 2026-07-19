// Star map: two-level navigation chart. The galaxy level plots star systems
// only — picking one descends into the system preview (sysview.js), where
// planets are inspected and the route is committed. Rendering for the system
// level lives in sysview.js; this module owns DOM, state and the galaxy scene.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeRng } from './rng.js';
import { generateSystemSpec } from './astronomy.js';
import { SystemView } from './sysview.js';

const AU = 149_597_870_700;
const STAR_LIMIT = 320;
const TYPE_COLORS = {
  lush: 0x52d7a4, ocean: 0x4ea7ff, desert: 0xe2aa65, ice: 0xb8e7ff,
  lava: 0xff6848, barren: 0x9da7ad, toxic: 0xb5e45d, exotic: 0xe47cff,
  gasGiant: 0xd29b68, iceGiant: 0x68c7df,
};
const TYPE_LABELS = {
  lush: '繁茂世界', ocean: '海洋世界', desert: '荒漠世界', ice: '冰封世界',
  lava: '火山世界', barren: '贫瘠世界', toxic: '剧毒世界', exotic: '异象世界',
  gasGiant: '气态巨星', iceGiant: '冰巨星',
};

function physicalStarClass(star) {
  const code = star.spectralClass?.[0] || 'G';
  const labels = { O: '蓝色主序星', B: '蓝白主序星', A: '白色主序星', F: '黄白主序星', G: '黄矮星', K: '橙矮星', M: '红矮星', D: '白矮星' };
  return { code, label: labels[code] || '恒星', temp: `${Math.round(star.temperatureK).toLocaleString('zh-CN')} K` };
}

function distanceText(metres) {
  if (metres < 1e9) return `${(metres / 1e6).toFixed(0)} 千公里`;
  if (metres < AU * 0.15) return `${(metres / 1e9).toFixed(2)} 百万公里`;
  return `${(metres / AU).toFixed(3)} AU`;
}

const BIO_PROFILE = {
  lush: ['丰富', '繁盛'], ocean: ['丰富 · 海洋', '繁盛'], desert: ['稀少', '稀少'],
  ice: ['稀少', '冻原'], lava: ['无', '无'], barren: ['无', '无'],
  toxic: ['危险', '异常'], exotic: ['未知', '未知'],
  gasGiant: ['无固体表面', '无'], iceGiant: ['无固体表面', '无'],
};
const WATER_PROFILE = {
  lush: '安全', ocean: '海洋', desert: '地下冰', ice: '冻结',
  lava: '无', barren: '无', toxic: '污染', exotic: '未知',
  gasGiant: '无', iceGiant: '无',
};
const RESOURCE_PROFILE = {
  lush: ['H₂O', 'Fe', 'Ar', 'C'], ocean: ['H₂O', 'Cl', 'Ar', 'Cu'],
  desert: ['Si', 'Fe', 'He₃', 'Al'], ice: ['H₂O', 'N', 'Ar', 'Pb'],
  lava: ['Fe', 'Ni', 'S', 'Co'], barren: ['Fe', 'Pb', 'Al', 'He₃'],
  toxic: ['Cl', 'Ar', 'F', 'Si'], exotic: ['Au', 'Xe', 'Ir', '???'],
  gasGiant: ['H₂', 'He', 'NH₃', 'CH₄'], iceGiant: ['CH₄', 'H₂', 'He', 'H₂O'],
};
const RESOURCE_POOL = ['H₂O', 'Fe', 'Cu', 'Ar', 'Ni', 'Co', 'Si', 'He₃', 'Pb', 'Al', 'C', 'NH₃', 'CH₄', 'S', 'Xe', 'Ir', 'Au', 'Cl', 'N', 'Na'];

function bodyProfile(body) {
  const rand = makeRng(body.seed + ':ui-profile');
  const giant = body.type === 'gasGiant' || body.type === 'iceGiant';
  const gravity = giant
    ? (0.9 + (body.radius / 850000) * 1.35).toFixed(2)
    : (0.48 + Math.min(1.12, body.radius / 310_000) + rand() * 0.18).toFixed(2);
  const k = body.equilibriumK ?? 250;
  const tempLabel = k > 620 ? '极端高温' : k > 350 ? '炎热' : k >= 235 && k <= 330 ? '温和' : k > 190 ? '寒冷' : '严寒';
  const atmosphere = body.atmosphere?.composition
    ? `${body.atmosphere.composition.join(' / ')}${body.atmosphere.pressureBar == null ? '' : ` · ${body.atmosphere.pressureBar.toFixed(2)} bar`}`
    : '近真空';
  const magneto = giant ? '强烈'
    : body.type === 'lava' || body.type === 'barren' ? '微弱'
    : body.type === 'lush' || body.type === 'ocean' ? (rand() < 0.5 ? '中等' : '强烈')
    : ['微弱', '中等', '强烈'][Math.floor(rand() * 3)];
  const [faunaBase, floraBase] = BIO_PROFILE[body.type] || BIO_PROFILE.barren;
  const count = (base, max) => /^(无|未知)/.test(base) ? base : `${base} (${Math.floor(rand() * (max * 0.4))}/${max})`;
  const fauna = count(faunaBase, 3 + Math.floor(rand() * 9));
  const flora = count(floraBase, 3 + Math.floor(rand() * 8));
  const resources = [...(RESOURCE_PROFILE[body.type] || RESOURCE_PROFILE.barren)];
  while (resources.length < 5) {
    const pick = RESOURCE_POOL[Math.floor(rand() * RESOURCE_POOL.length)];
    if (!resources.includes(pick)) resources.push(pick);
  }
  const traitCount = 2 + Math.floor(rand() * 3);
  const traits = rand() < 0.3 ? `特征：已发现 (1/${traitCount})` : `特征：不明 (0/${traitCount})`;
  return {
    gravity: `${gravity} g`,
    temperature: `${Math.round(k)} K · ${tempLabel}`,
    atmosphere, magnetosphere: magneto, fauna, flora,
    water: WATER_PROFILE[body.type] || '不明',
    resources: resources.slice(0, 5),
    traits,
    survey: Math.round(15 + rand() * 65),
    type: TYPE_LABELS[body.type] || body.type,
  };
}

function previewSystem(seed, star, currentSystem) {
  const spec = currentSystem?.star.id === star.id ? currentSystem.spec : generateSystemSpec(seed, star);
  const indexById = new Map(spec.bodies.map((body, index) => [body.bodyId, index]));
  return {
    name: spec.name, properName: spec.properName, catalogId: spec.catalogId,
    star, stars: spec.stars, binaryOrbit: spec.binaryOrbit,
    bodies: spec.bodies.map((body, index) => ({
      ...body, index,
      parentSpec: body.parentId ? indexById.get(body.parentId) : -1,
      orbitSpec: body.orbit,
      orbit: body.orbit.renderRadius,
    })),
  };
}

function disposeObject(root) {
  root.traverse((object) => {
    if (object.geometry) object.geometry.dispose();
    if (object.material) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    }
  });
}

function lineLoop(radius, color, opacity = 0.22, segments = 128) {
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const angle = i / segments * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
  }
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
  );
}

function makePointTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.34, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.48, 'rgba(255,255,255,.82)');
  gradient.addColorStop(0.68, 'rgba(255,255,255,.12)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 32, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function makeSoftDisc(size = 256, rgb = '215,200,170') {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, `rgba(${rgb},.5)`);
  g.addColorStop(0.35, `rgba(${rgb},.16)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class StarMap {
  constructor({ getUniverse, getNav, getSeed, getState, getTime, onRequestClose, onWarpTarget }) {
    this.getUniverse = getUniverse;
    this.getNav = getNav;
    this.getSeed = getSeed;
    this.getState = getState;
    this.getTime = getTime || (() => 0);
    this.onRequestClose = onRequestClose;
    this.onWarpTarget = onWarpTarget;
    this.isOpen = false;
    this.mode = 'galaxy';
    this.filter = 'all';
    this.selectedStar = null;
    this.selectedPlanet = null;
    this.previewCache = new Map();
    this.pickables = [];
    this.pointerStart = null;
    this.clock = new THREE.Clock();

    this.buildDOM();
    this.buildRenderer();
    this.sysview = new SystemView({
      host: this.els.sysviewHost,
      labelHost: this.els.labelLayer,
      navArrow: this.els.navArrow,
      nameTag: this.els.nameTag,
      onSelect: (body) => this.onBodySelect(body),
    });
    this.bindUI();
  }

  // ---- DOM ------------------------------------------------------------------
  buildDOM() {
    const root = document.createElement('section');
    root.id = 'starmap-overlay';
    root.className = 'hidden mode-galaxy';
    root.setAttribute('aria-label', '银河星图');
    root.innerHTML = `
      <main class="sm-viewport">
        <div id="sm-stage"></div>
        <div id="sm-canvas"></div>
        <div id="sm-sysview"></div>
        <div id="sm-label-layer"></div>
      </main>
      <div id="sm-ui">
        <div id="sm-leftHud" class="hudAnchor">
          <div id="sm-leftRail"><button id="sm-back" class="back" aria-label="返回">◀</button><div class="vertical" id="sm-railLabel">银河图</div></div>
          <section id="sm-sysPanel" class="panel">
            <div class="head"><span>系统</span><span id="sm-targetCode">—</span></div>
            <div class="identity">
              <div><div class="eyebrow" id="sm-catalog">—</div><div class="sysName" id="sm-targetName">选择恒星系</div></div>
              <div class="level"><strong>谱型</strong><span id="sm-class">·</span></div>
            </div>
            <div id="sm-systemGlyph"></div>
            <div id="sm-survey"><div class="label">勘查</div><div class="bar" id="sm-surveyBar"></div><div class="barValue" id="sm-surveyValue">—</div></div>
            <div id="sm-galaxyMeta">
              <div class="metaRows">
                <div class="metaRow"><span>航行距离</span><b id="sm-distance">—</b></div>
                <div class="metaRow"><span>天体数量</span><b id="sm-planets">—</b></div>
                <div class="metaRow"><span>表面温度</span><b id="sm-temperature">—</b></div>
              </div>
              <div class="galaxyActions">
                <button id="sm-inspect" type="button" disabled>查看星系 <kbd>⏎</kbd></button>
                <button id="sm-warpGalaxy" type="button" disabled>设定航线 <kbd>X</kbd></button>
              </div>
            </div>
          </section>
          <section id="sm-galaxyTools" class="panel">
            <label class="toolRow"><span>检索</span><input id="sm-search" type="search" maxlength="32" autocomplete="off" placeholder="星系名称 / 坐标" /></label>
            <div class="toolFilters">
              <button class="active" data-sm-filter="all">全部</button>
              <button data-sm-filter="habitable">宜居</button>
              <button data-sm-filter="anomaly">异常</button>
              <button data-sm-filter="frontier">边界</button>
            </div>
            <div class="toolMeta"><span id="sm-sector">—</span><b id="sm-count">—</b></div>
          </section>
          <section id="sm-planetLeft" class="panel planetInfo" aria-hidden="true">
            <div class="detailTitle"><div class="name" id="sm-detailName">—</div><div class="system" id="sm-detailSystem">—</div></div>
            <div class="detailSurvey">
              <div class="detailSurveyTop"><span>勘查</span><span id="sm-detailSurveyValue">0%</span></div>
              <div class="bar" id="sm-detailSurveyBar"></div>
            </div>
            <div class="detailRows">
              <div class="detailRow"><span>类型</span><span id="sm-detailType">—</span></div>
              <div class="detailRow"><span>重力</span><span id="sm-detailGravity">—</span></div>
              <div class="detailRow"><span>温度</span><span id="sm-detailTemperature">—</span></div>
              <div class="detailRow"><span>大气层</span><span id="sm-detailAtmosphere">—</span></div>
              <div class="detailRow"><span>磁层</span><span id="sm-detailMagnetosphere">—</span></div>
              <div class="detailRow"><span>动物</span><span id="sm-detailFauna">—</span></div>
              <div class="detailRow"><span>植物</span><span id="sm-detailFlora">—</span></div>
              <div class="detailRow"><span>水</span><span id="sm-detailWater">—</span></div>
            </div>
            <div class="routeActionWrap">
              <button id="sm-routeAction" type="button" aria-label="为当前星球设定航线">
                <span class="routeIcon" aria-hidden="true">
                  <svg viewBox="0 0 32 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="5" cy="18" r="2.5" stroke="currentColor" stroke-width="1.6"/>
                    <circle cx="27" cy="5" r="2.5" stroke="currentColor" stroke-width="1.6"/>
                    <path d="M7.5 17.1L13.2 11.4H20.1L24.5 7.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M20.7 6.9H24.8V11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </span>
                <span class="routeActionLabel">设定航线</span>
                <span class="routeKey">X</span>
              </button>
            </div>
          </section>
        </div>
        <div id="sm-rightHud" class="hudAnchor">
          <section id="sm-faction" class="panel"><div class="small">阵营</div><div class="panelRule"></div><div class="big">联合殖民地</div></section>
          <section id="sm-planetRight" class="panel planetInfo" aria-hidden="true">
            <div class="resourceHead"><span>资源</span><span id="sm-resourceCount">(0/5)</span></div>
            <div class="resourceTiles" id="sm-resourceTiles"></div>
            <div class="traitText" id="sm-traitText">特征：不明 (0/3)</div>
          </section>
        </div>
        <div id="sm-bottomHud" class="hudAnchor">
          <div id="sm-controls"></div>
        </div>
        <div id="sm-crosshair"></div>
        <div id="sm-navArrow"></div>
        <div id="sm-nameTag"></div>
      </div>
      <div id="sm-loading"><div class="loadBox"><div class="loadTitle">系统星图</div><div class="loadBar"><i></i></div></div></div>`;
    document.body.appendChild(root);
    this.root = root;
    const $ = (selector) => root.querySelector(selector);
    this.els = {
      canvas: $('#sm-canvas'), sysviewHost: $('#sm-sysview'), labelLayer: $('#sm-label-layer'),
      back: $('#sm-back'), railLabel: $('#sm-railLabel'),
      targetCode: $('#sm-targetCode'), catalog: $('#sm-catalog'), targetName: $('#sm-targetName'),
      classBox: $('#sm-class'), glyph: $('#sm-systemGlyph'),
      surveyBar: $('#sm-surveyBar'), surveyValue: $('#sm-surveyValue'),
      galaxyMeta: $('#sm-galaxyMeta'), distance: $('#sm-distance'), planets: $('#sm-planets'),
      temperature: $('#sm-temperature'), inspect: $('#sm-inspect'), warpGalaxy: $('#sm-warpGalaxy'),
      galaxyTools: $('#sm-galaxyTools'), search: $('#sm-search'), sector: $('#sm-sector'), count: $('#sm-count'),
      planetLeft: $('#sm-planetLeft'), planetRight: $('#sm-planetRight'),
      detailName: $('#sm-detailName'), detailSystem: $('#sm-detailSystem'),
      detailSurveyValue: $('#sm-detailSurveyValue'), detailSurveyBar: $('#sm-detailSurveyBar'),
      detailType: $('#sm-detailType'), detailGravity: $('#sm-detailGravity'),
      detailTemperature: $('#sm-detailTemperature'), detailAtmosphere: $('#sm-detailAtmosphere'),
      detailMagnetosphere: $('#sm-detailMagnetosphere'), detailFauna: $('#sm-detailFauna'),
      detailFlora: $('#sm-detailFlora'), detailWater: $('#sm-detailWater'),
      routeAction: $('#sm-routeAction'),
      resourceCount: $('#sm-resourceCount'), resourceTiles: $('#sm-resourceTiles'),
      traitText: $('#sm-traitText'),
      controls: $('#sm-controls'),
      leftHud: $('#sm-leftHud'), rightHud: $('#sm-rightHud'), bottomHud: $('#sm-bottomHud'),
      navArrow: $('#sm-navArrow'), nameTag: $('#sm-nameTag'),
      loading: $('#sm-loading'),
    };
  }

  // ---- galaxy renderer --------------------------------------------------------
  buildRenderer() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x0c1112, 0.0026);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    this.camera.position.set(0, 118, 0.01);
    this.camera.up.set(0, 0, -1);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.els.canvas.appendChild(this.renderer.domElement);
    this.starTexture = makePointTexture();
    this.softTexture = makeSoftDisc();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enableRotate = false;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.panSpeed = 1.05;
    this.controls.zoomSpeed = 0.8;
    this.controls.minDistance = 28;
    this.controls.maxDistance = 190;
    this.controls.target.set(0, 0, 0);

    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.scene.add(new THREE.AmbientLight(0x82b8ce, 0.75));
    const key = new THREE.DirectionalLight(0xbfeeff, 2.2);
    key.position.set(20, 36, 18);
    this.scene.add(key);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Points.threshold = 2.2;
    this.pointer = new THREE.Vector2();
    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
  }

  bindUI() {
    this.els.back.addEventListener('click', () => this.goBack());
    for (const button of this.root.querySelectorAll('[data-sm-filter]')) {
      button.addEventListener('click', () => {
        this.filter = button.dataset.smFilter;
        this.root.querySelectorAll('[data-sm-filter]').forEach((item) => item.classList.toggle('active', item === button));
        if (this.mode === 'galaxy') this.buildGalaxy();
      });
    }
    this.els.search.addEventListener('input', () => {
      if (this.mode === 'galaxy') this.buildGalaxy();
    });
    this.els.inspect.addEventListener('click', () => this.enterSystem());
    this.els.warpGalaxy.addEventListener('click', () => this.warpToSelection());
    this.els.routeAction.addEventListener('click', (event) => {
      event.stopPropagation();
      this.warpToSelection();
    });
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => {
      this.pointerStart = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointerup', (event) => {
      if (!this.pointerStart) return;
      const moved = Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y);
      this.pointerStart = null;
      if (moved < 7) this.pick(event);
    });
    canvas.addEventListener('dblclick', (event) => {
      const star = this.pickStarAt(event);
      if (star) {
        this.selectStar(star, false);
        this.enterSystem();
      }
    });
  }

  handleKey(event) {
    if (event.code === 'Escape') { this.goBack(); return; }
    if (event.code === 'KeyX') { this.warpToSelection(); return; }
    if (this.mode === 'system') {
      if (event.code === 'KeyV') this.sysview.setLabelsVisible(!this.sysview.labelsVisible);
      if (event.code === 'KeyQ') this.sysview.resetView();
    } else if (event.code === 'Enter' || event.code === 'NumpadEnter') {
      if (this.selectedStar) this.enterSystem();
    }
  }

  goBack() {
    if (this.mode === 'system') this.setMode('galaxy');
    else this.onRequestClose?.();
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.root.classList.remove('hidden');
    document.body.classList.add('starmap-open');
    this.previewCache.clear();
    this.mode = 'galaxy';
    this.root.classList.add('mode-galaxy');
    this.root.classList.remove('mode-system');
    this.selectedStar = this.getUniverse().system.star;
    this.selectedPlanet = null;
    this.sysview.setLabelsVisible(true);
    this.updateRail();
    this.updateHints();
    this.els.loading.classList.add('done');
    this.resize();
    this.buildGalaxy();
    this.selectStar(this.selectedStar, false);
    this.clock.start();
    this.animate();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.add('hidden');
    document.body.classList.remove('starmap-open');
    cancelAnimationFrame(this.raf);
  }

  setMode(mode) {
    if (mode === 'system') { this.enterSystem(); return; }
    if (this.mode === 'galaxy') return;
    this.mode = 'galaxy';
    this.root.classList.add('mode-galaxy');
    this.root.classList.remove('mode-system');
    this.sysview.selectBody(null);
    this.selectedPlanet = null;
    this.updateRail();
    this.updateHints();
    this.resize();
    this.buildGalaxy();
  }

  async enterSystem() {
    if (this.mode === 'system' || !this.selectedStar) return;
    this.mode = 'system';
    this.root.classList.remove('mode-galaxy');
    this.root.classList.add('mode-system');
    this.updateRail();
    this.updateHints();
    this.els.loading.classList.remove('done');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const preview = this.systemPreview(this.selectedStar);
    this.sysview.buildSystem(preview, this.getTime());
    this.updateSystemPanel(preview);
    this.onBodySelect(null);
    this.resize();
    this.els.loading.classList.add('done');
  }

  updateRail() {
    this.els.railLabel.textContent = this.mode === 'system' ? '银河图' : '驾驶舱';
    this.els.back.setAttribute('aria-label', this.mode === 'system' ? '返回银河图' : '返回飞行');
  }

  updateHints() {
    const hints = this.mode === 'system'
      ? [['设定航线', 'X'], ['显示位置', 'V'], ['重置视角', 'Q'], ['返回银河', 'Esc']]
      : [['查看星系', '⏎'], ['设定航线', 'X'], ['返回', 'Esc']];
    this.els.controls.innerHTML = hints
      .map(([label, key]) => `<span class="hint">${label} <b class="key">${key}</b></span>`)
      .join('');
  }

  // ---- data -------------------------------------------------------------------
  systemPreview(star) {
    if (!this.previewCache.has(star.id)) {
      this.previewCache.set(star.id, previewSystem(this.getSeed(), star, this.getUniverse().system));
    }
    return this.previewCache.get(star.id);
  }

  candidates() {
    const universe = this.getUniverse();
    const nav = this.getNav();
    const current = universe.system.star;
    const source = [current, ...universe.nearStarsList]
      .sort((a, b) => a.pos.distanceToSquared(nav.pos) - b.pos.distanceToSquared(nav.pos))
      .slice(0, STAR_LIMIT);
    const query = this.els.search.value.trim().toLocaleLowerCase();
    const maxDistance = source.length ? source[source.length - 1].pos.distanceTo(nav.pos) : 1;
    return source.filter((star) => {
      const preview = this.systemPreview(star);
      const types = preview.bodies.filter((body) => !body.isMoon).map((body) => body.type);
      const dist = star.pos.distanceTo(nav.pos);
      if (query && !preview.name.toLocaleLowerCase().includes(query) && !star.id.includes(query)) return false;
      if (this.filter === 'habitable' && !types.some((type) => type === 'lush' || type === 'ocean')) return false;
      if (this.filter === 'anomaly' && !types.some((type) => type === 'exotic' || type === 'lava' || type === 'toxic')) return false;
      if (this.filter === 'frontier' && dist < maxDistance * 0.58) return false;
      return true;
    });
  }

  // ---- galaxy level -------------------------------------------------------------
  resetWorld() {
    disposeObject(this.world);
    this.scene.remove(this.world);
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.pickables = [];
    this.labelData = [];
    this.els.labelLayer.replaceChildren();
    this.controls.target.set(0, 0, 0);
  }

  buildGalaxy() {
    this.resetWorld();
    const nav = this.getNav();
    const current = this.getUniverse().system.star;
    const stars = this.candidates();
    const maxDistance = Math.max(...stars.map((star) => star.pos.distanceTo(nav.pos)), 1);
    const scale = 78 / maxDistance;
    this.visibleStars = stars;
    this.mapPositions = stars.map((star) => {
      const delta = star.pos.clone().sub(current.pos).multiplyScalar(scale);
      return new THREE.Vector3(delta.x, 0, delta.z);
    });

    // invisible-but-raycastable nodes
    const nodeGeometry = new THREE.IcosahedronGeometry(0.72, 1);
    const nodeMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.001, depthWrite: false, fog: false, toneMapped: false,
    });
    const nodes = new THREE.InstancedMesh(nodeGeometry, nodeMaterial, Math.max(stars.length, 1));
    nodes.userData.kind = 'stars';
    const matrix = new THREE.Matrix4();
    stars.forEach((star, index) => {
      const position = this.mapPositions[index];
      const size = star.id === current.id ? 2.5 : 0.72 + Math.min(0.55, star.radius / 1.8e7);
      matrix.compose(position, new THREE.Quaternion(), new THREE.Vector3(size, size, size));
      nodes.setMatrixAt(index, matrix);
      nodes.setColorAt(index, star.color.clone().multiplyScalar(star.id === current.id ? 1.8 : 1.15));
    });
    nodes.instanceMatrix.needsUpdate = true;
    if (nodes.instanceColor) nodes.instanceColor.needsUpdate = true;
    nodes.userData.stars = stars;
    this.world.add(nodes);
    this.pickables.push(nodes);

    // visible starlight
    const pointGeometry = new THREE.BufferGeometry();
    pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(
      this.mapPositions.flatMap((position) => position.toArray()), 3,
    ));
    pointGeometry.setAttribute('color', new THREE.Float32BufferAttribute(
      stars.flatMap((star) => {
        const color = star.color.clone().lerp(new THREE.Color(0xffffff), 0.28);
        return color.toArray();
      }), 3,
    ));
    const starLight = new THREE.Points(pointGeometry, new THREE.PointsMaterial({
      size: 5.5, sizeAttenuation: false, map: this.starTexture, vertexColors: true,
      transparent: true, opacity: 0.96, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false, toneMapped: false,
    }));
    starLight.userData = { kind: 'starPoints', stars };
    this.world.add(starLight);
    this.pickables.push(starLight);

    // faint survey range rings + a soft gravity-well glow — no route spaghetti
    for (const radius of [18, 36, 58, 78]) {
      const ring = lineLoop(radius, 0xcbd4d2, radius === 78 ? 0.10 : 0.055, 160);
      this.world.add(ring);
    }
    const well = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.softTexture, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    well.scale.set(150, 44, 1);
    well.position.y = -3;
    this.world.add(well);

    this.camera.position.set(0, 118, 0.01);
    this.camera.up.set(0, 0, -1);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.els.count.textContent = `${stars.length} / ${STAR_LIMIT}`;
    this.els.sector.textContent = current.id;
    this.buildGalaxyLabels(stars, current);
    this.updateSelectionMarker();
  }

  buildGalaxyLabels(stars, current) {
    const candidates = stars
      .map((star, index) => ({ star, index, distance: this.mapPositions[index].lengthSq() }))
      .filter((item) => item.star.id === current.id || item.distance < 38 * 38)
      .sort((a, b) => (a.star.id === current.id ? -1 : b.star.id === current.id ? 1 : b.distance - a.distance));
    const ranked = [];
    for (const item of candidates) {
      if (item.star.id !== current.id && ranked.some((picked) =>
        this.mapPositions[picked.index].distanceTo(this.mapPositions[item.index]) < 9)) continue;
      ranked.push(item);
      if (ranked.length >= 10) break;
    }
    this.labelData = ranked.map(({ star, index }) => {
      const button = document.createElement('button');
      button.className = 'sm-map-label';
      button.innerHTML = '<i></i><strong></strong><small></small>';
      button.children[0].style.setProperty('--label-color', `#${star.color.getHexString()}`);
      button.children[1].textContent = this.systemPreview(star).properName;
      button.children[2].textContent = star.id === current.id
        ? '当前位置'
        : `${physicalStarClass(this.systemPreview(star).stars[0]).code} · ${this.systemPreview(star).bodies.filter((b) => !b.isMoon).length} 行星`;
      button.classList.toggle('current', star.id === current.id);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.selectStar(star);
      });
      button.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        this.selectStar(star, false);
        this.enterSystem();
      });
      this.els.labelLayer.appendChild(button);
      return {
        button, position: this.mapPositions[index], star,
        width: Math.min(230, 34 + this.systemPreview(star).properName.length * 16),
        height: star.id === current.id ? 43 : 34,
        priority: star.id === current.id ? 100 : 10,
      };
    });
  }

  updateMapLabels() {
    if (!this.labelData?.length) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const point = new THREE.Vector3();
    const projected = [];
    for (const item of this.labelData) {
      point.copy(item.position).project(this.camera);
      const x = (point.x * 0.5 + 0.5) * rect.width;
      const y = (-point.y * 0.5 + 0.5) * rect.height;
      const visible = point.z > -1 && point.z < 1
        && x > rect.width * 0.06 && y > rect.height * 0.08
        && x + item.width < rect.width * 0.96 && y + item.height < rect.height * 0.9;
      item.button.hidden = !visible;
      if (!visible) continue;
      projected.push({ item, x, y });
    }
    projected.sort((a, b) => (b.item.priority || 0) - (a.item.priority || 0));
    const occupied = [];
    for (const blocker of [this.els.leftHud]) {
      const bounds = blocker?.getBoundingClientRect();
      if (!bounds || bounds.width < 2 || bounds.height < 2) continue;
      occupied.push({
        left: bounds.left - rect.left - 10,
        top: bounds.top - rect.top - 10,
        right: bounds.right - rect.left + 10,
        bottom: bounds.bottom - rect.top + 10,
      });
    }
    const blockerCount = occupied.length;
    for (const entry of projected) {
      const { item, x, y } = entry;
      const box = { left: x - 6, top: y - 7, right: x + item.width, bottom: y + item.height };
      const overlaps = (other) => !(box.right < other.left || box.left > other.right
        || box.bottom < other.top || box.top > other.bottom);
      const blockedByPanel = occupied.slice(0, blockerCount).some(overlaps);
      const labelCollision = occupied.slice(blockerCount).some(overlaps);
      if (blockedByPanel || (labelCollision && (item.priority || 0) < 80)) {
        item.button.hidden = true;
        continue;
      }
      item.button.hidden = false;
      occupied.push(box);
      item.button.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
    }
  }

  updateSelectionMarker() {
    const old = this.world.getObjectByName('selection-marker');
    if (old) {
      this.world.remove(old);
      old.geometry.dispose();
      old.material.dispose();
    }
    if (this.mode !== 'galaxy' || !this.selectedStar || !this.visibleStars) return;
    const index = this.visibleStars.findIndex((star) => star.id === this.selectedStar.id);
    if (index < 0) return;
    const marker = new THREE.Mesh(
      new THREE.TorusGeometry(2.1, 0.055, 8, 64),
      new THREE.MeshBasicMaterial({
        color: 0x6fd3e0, transparent: true, opacity: 0.92,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    marker.name = 'selection-marker';
    marker.position.copy(this.mapPositions[index]);
    marker.rotation.x = Math.PI / 2;
    this.world.add(marker);
  }

  selectStar(star, focus = true) {
    this.selectedStar = star;
    this.selectedPlanet = null;
    const preview = this.systemPreview(star);
    const cls = physicalStarClass(preview.stars[0]);
    const distance = star.pos.distanceTo(this.getNav().pos);
    const primaryCount = preview.bodies.filter((body) => !body.isMoon).length;
    const moonCount = preview.bodies.length - primaryCount;
    const isCurrent = star.id === this.getUniverse().system.star.id;
    const canWarp = !isCurrent && this.getState() === 'space';
    const surveyRand = makeRng(this.getSeed() + ':survey:' + star.id);

    this.els.targetCode.textContent = `${preview.catalogId} // ${cls.code}-CLASS`;
    this.els.catalog.textContent = `代号 · ${preview.catalogId}`;
    this.els.targetName.textContent = preview.properName;
    this.els.classBox.textContent = cls.code;
    this.els.classBox.style.background = `#${preview.stars[0] ? new THREE.Color(preview.stars[0].color).getHexString() : '#17e31a'}`;
    this.els.surveyValue.textContent = `${Math.round(20 + surveyRand() * 45)}%`;
    this.els.surveyBar.style.setProperty('--survey-progress', this.els.surveyValue.textContent);
    this.buildGlyph(preview);
    this.els.distance.textContent = isCurrent ? '当前位置' : distanceText(distance);
    this.els.planets.textContent = `${primaryCount} 行星 / ${moonCount} 卫星`;
    this.els.temperature.textContent = cls.temp;
    this.els.inspect.disabled = false;
    this.els.warpGalaxy.disabled = !canWarp;
    this.els.warpGalaxy.innerHTML = `${isCurrent ? '当前星系' : this.getState() !== 'space' ? '需返回飞船' : '设定航线'} <kbd>X</kbd>`;
    this.updateSelectionMarker();
    if (focus && this.mode === 'galaxy' && this.visibleStars) {
      const index = this.visibleStars.findIndex((item) => item.id === star.id);
      if (index >= 0) this.controls.target.lerp(this.mapPositions[index], 0.75);
    }
    if (this.mode === 'system') this.updateSystemPanel(preview);
  }

  buildGlyph(preview) {
    const primaries = preview.bodies.filter((body) => !body.isMoon).slice(0, 7);
    const starColor = new THREE.Color(preview.stars[0]?.color ?? 0xffffff);
    const binary = preview.stars.length > 1;
    const starBackground = binary
      ? `linear-gradient(100deg, #${starColor.getHexString()} 0 48%, #${new THREE.Color(preview.stars[1].color).getHexString()} 52% 100%)`
      : `#${starColor.getHexString()}`;
    const parts = [`<i class="gMain" style="background:${starBackground};box-shadow:0 0 18px #${starColor.getHexString()}55"></i>`];
    // distribute planet slots outward from the star, alternating sides
    const slots = [57, 31.5, 68, 22, 78, 12, 86];
    primaries.forEach((body, i) => {
      const size = 10 + Math.min(16, (body.radius / 310_000) * 16) * (body.type === 'gasGiant' || body.type === 'iceGiant' ? 1.35 : 1);
      const color = TYPE_COLORS[body.type] || 0x9ea7aa;
      parts.push(`<i class="gNode" role="button" data-glyph-index="${body.index}" title="${body.name}" style="left:${slots[i] ?? 90}%;width:${size.toFixed(0)}px;height:${size.toFixed(0)}px;background:rgba(13,19,27,.82);border-color:#${new THREE.Color(color).getHexString()}"></i>`);
    });
    this.els.glyph.innerHTML = parts.join('');
    for (const node of this.els.glyph.querySelectorAll('.gNode')) {
      node.addEventListener('click', () => {
        const body = preview.bodies[Number(node.dataset.glyphIndex)];
        if (!body) return;
        if (this.mode !== 'system') this.enterSystem().then(() => this.onBodySelect(body));
        else this.onBodySelect(body);
      });
    }
  }

  updateSystemPanel(preview) {
    // identity fields were already filled by selectStar; nothing else per-frame
    this.els.detailSystem.textContent = preview.name;
  }

  onBodySelect(body) {
    this.selectedPlanet = body;
    this.sysview.selectBody(body);
    const has = !!body;
    for (const panel of [this.els.planetLeft, this.els.planetRight]) {
      panel.classList.toggle('active', has);
      panel.setAttribute('aria-hidden', has ? 'false' : 'true');
    }
    if (!has) return;
    const profile = bodyProfile(body);
    this.els.detailName.textContent = body.name;
    this.els.detailSurveyValue.textContent = `${profile.survey}%`;
    this.els.detailSurveyBar.style.setProperty('--survey-progress', `${profile.survey}%`);
    this.els.detailType.textContent = profile.type;
    this.els.detailGravity.textContent = profile.gravity;
    this.els.detailTemperature.textContent = profile.temperature;
    this.els.detailAtmosphere.textContent = profile.atmosphere;
    this.els.detailMagnetosphere.textContent = profile.magnetosphere;
    this.els.detailFauna.textContent = profile.fauna;
    this.els.detailFlora.textContent = profile.flora;
    this.els.detailWater.textContent = profile.water;
    this.els.resourceCount.textContent = `(0/${profile.resources.length})`;
    this.els.resourceTiles.innerHTML = profile.resources
      .map((value) => `<div class="resourceTile">${value}</div>`).join('');
    this.els.traitText.textContent = profile.traits;
    this.updateRouteAction();
  }

  updateRouteAction() {
    const isCurrent = this.selectedStar && this.selectedStar.id === this.getUniverse().system.star.id;
    const canWarp = !isCurrent && this.getState() === 'space';
    const label = this.els.routeAction.querySelector('.routeActionLabel');
    this.els.routeAction.disabled = !canWarp;
    label.textContent = isCurrent ? '当前星系' : this.getState() !== 'space' ? '需返回飞船' : '设定航线';
  }

  warpToSelection() {
    if (!this.selectedStar) return;
    if (this.selectedStar.id === this.getUniverse().system.star.id) return;
    if (this.getState() !== 'space') return;
    this.onWarpTarget?.(this.selectedStar, this.selectedPlanet?.bodyId || null);
  }

  pickStarAt(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, true);
    if (!hits.length) return null;
    const hit = hits[0];
    if (hit.object.userData.kind === 'stars' && hit.instanceId != null) {
      return hit.object.userData.stars[hit.instanceId] || null;
    }
    if (hit.object.userData.kind === 'starPoints' && hit.index != null) {
      return hit.object.userData.stars[hit.index] || null;
    }
    return null;
  }

  pick(event) {
    const star = this.pickStarAt(event);
    if (star) this.selectStar(star);
  }

  // ---- frame / layout -----------------------------------------------------------
  resize() {
    const w = Math.max(1, this.els.canvas.clientWidth || innerWidth);
    const h = Math.max(1, this.els.canvas.clientHeight || innerHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.mode === 'system') this.sysview.resize();
    this.updateResponsiveLayout(w, h);
  }

  updateResponsiveLayout(w = innerWidth, h = innerHeight) {
    // 1536×960 design baseline: scale the HUD uniformly, never per-panel
    const rawScale = Math.min(w / 1536, h / 960);
    const hudScale = THREE.MathUtils.clamp(rawScale, 0.62, 1);
    const markerScale = THREE.MathUtils.clamp(0.82 + hudScale * 0.18, 0.90, 1);
    this.root.style.setProperty('--hud-scale', hudScale.toFixed(4));
    this.root.style.setProperty('--marker-scale', markerScale.toFixed(4));

    const side = Math.max(14, 34 * hudScale);
    const top = Math.max(14, 52 * hudScale);
    const bottom = Math.max(10, 26 * hudScale);
    this.els.leftHud.style.left = `${side}px`;
    this.els.leftHud.style.top = `${top}px`;
    this.els.rightHud.style.right = `${side}px`;
    this.els.rightHud.style.top = `${top}px`;
    this.els.bottomHud.style.right = `${side}px`;
    this.els.bottomHud.style.bottom = `${bottom}px`;

    this.root.classList.toggle('hudCompact', h < 820);
    this.root.classList.toggle('hudNarrow', w < 1080);

    // detail panels pin their bottom edge to the safety line above the hints
    const detailsBottom = Math.max(top + 540 * hudScale, h - Math.max(66, 74 * hudScale));
    const localBottom = (detailsBottom - top) / hudScale;
    const leftDetailTop = 278;
    const leftDetailHeight = THREE.MathUtils.clamp(localBottom - leftDetailTop, 338, 560);
    const rightDetailHeight = h < 760 ? 204 : 225;
    const rightDetailTop = Math.max(112, localBottom - rightDetailHeight);
    this.els.planetLeft.style.top = `${leftDetailTop}px`;
    this.els.planetLeft.style.height = `${leftDetailHeight}px`;
    this.els.planetRight.style.top = `${rightDetailTop}px`;
    this.els.planetRight.style.height = `${rightDetailHeight}px`;
    this.els.traitText.style.marginTop = rightDetailHeight < 220 ? '62px' : '82px';
    // galaxy tools sit below the (taller) galaxy-mode system panel
    this.els.galaxyTools.style.top = '442px';
  }

  animate() {
    if (!this.isOpen) return;
    this.raf = requestAnimationFrame(() => this.animate());
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.mode === 'galaxy') {
      this.controls.update();
      this.updateMapLabels();
      const marker = this.world.getObjectByName('selection-marker');
      if (marker) {
        marker.rotation.z += dt * 0.34;
        marker.scale.setScalar(1 + Math.sin(performance.now() * 0.0025) * 0.08);
      }
      this.renderer.render(this.scene, this.camera);
    } else {
      this.sysview.frame(dt);
    }
  }
}
