// Star map: two-level navigation chart. The galaxy level plots star systems
// only — picking one descends into the system preview (sysview.js), where
// planets are inspected and the route is committed. Rendering for the system
// level lives in sysview.js; this module owns DOM, state and the galaxy scene.

import * as THREE from '../vendor/three.webgpu.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeRng } from './rng.js';
import { generateSystemSpec } from './astronomy.js';
import { SystemView } from './sysview.js';
import { buildGalaxyBackdrop, CELL, GALAXY_LAYOUT_VERSION, GALAXY_RADIUS_CELLS } from './galaxy-layout.js';

const AU = 149_597_870_700;
const STAR_LIMIT = 320;
const GALAXY_DEFAULT_DISTANCE = 22;
const GALAXY_MIN_DISTANCE = 5;
const OVERVIEW_FADE_START = 52;
const OVERVIEW_FADE_END = 112;
const GALAXY_BACKDROP_COUNT = 20000;
const TYPE_COLORS = {
  lush: 0x52d7a4, ocean: 0x4ea7ff, desert: 0xe2aa65, ice: 0xb8e7ff,
  lava: 0xff6848, barren: 0x9da7ad, toxic: 0xb5e45d, exotic: 0xe47cff,
  gasGiant: 0xd29b68, iceGiant: 0x68c7df,
  blackHole: 0xffb36a,
};
const TYPE_LABELS = {
  lush: '繁茂世界', ocean: '海洋世界', desert: '荒漠世界', ice: '冰封世界',
  lava: '火山世界', barren: '贫瘠世界', toxic: '剧毒世界', exotic: '异象世界',
  gasGiant: '气态巨星', iceGiant: '冰巨星',
  blackHole: '恒星级黑洞',
};

function overviewMix(distance) {
  const t = THREE.MathUtils.clamp(
    (distance - OVERVIEW_FADE_START) / (OVERVIEW_FADE_END - OVERVIEW_FADE_START), 0, 1);
  return t * t * (3 - 2 * t);
}

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

function navigationStatus(preview) {
  if (preview.isBlackHoleSystem) return { name: '联合引力观测禁区', coverage: 68, advisory: '极端曲率进近' };
  const primaries = preview.bodies.filter((body) => !body.isMoon);
  const habitable = primaries.filter((body) => body.type === 'lush' || body.type === 'ocean').length;
  const anomalies = primaries.filter((body) => ['exotic', 'toxic', 'lava', 'blackHole'].includes(body.type)).length;
  const giants = primaries.filter((body) => body.type === 'gasGiant' || body.type === 'iceGiant').length;
  if (preview.isHome) return { name: '联合殖民地核心区', coverage: 100, advisory: '完整航路数据' };
  if (anomalies >= 2) return { name: '异常隔离区', coverage: 22, advisory: '高风险进近' };
  if (habitable > 0) return { name: '边境测绘署观测区', coverage: 52, advisory: '生态保护进近' };
  if (giants >= 2) return { name: '自由勘探协定区', coverage: 40, advisory: '强引力井' };
  return { name: '无登记管辖星域', coverage: 30, advisory: '标准星系入口' };
}

function civilizationLabel(type) {
  return ({
    'hero-city-world': '核心城市世界', 'hero-floating-city': '浮空城市',
    'ring-station': '环形空间站', 'spine-dock': '脊柱船坞', 'cluster-hub': '集群枢纽',
    'research-outpost': '科研前哨', 'mining-outpost': '矿业前哨', 'relay-outpost': '中继前哨',
  })[type] || null;
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

function bodyProfile(body, survey) {
  if (body.type === 'blackHole') {
    const hidden = (threshold, value, fallback = '数据不足') => survey >= threshold ? value : fallback;
    const mass = body.blackHole?.massSolar;
    return {
      gravity: hidden(45, '无静止表面 · 潮汐梯度极强'),
      temperature: hidden(28, `${Math.round(body.blackHole?.discTemperatureK || 0).toLocaleString('zh-CN')} K · 吸积盘峰值`),
      atmosphere: hidden(55, '无 · 事件视界外为稀薄等离子体'),
      magnetosphere: hidden(65, `时空曲率主导 · 自旋 ${body.blackHole?.spin.toFixed(2) ?? '—'}`),
      fauna: '无', flora: '无', water: '无',
      resources: ['引力透镜', 'X 射线', '相对论喷流', '时延信号', '吸积盘'],
      knownResources: Math.min(5, Math.max(1, Math.floor(survey / 18))),
      traits: survey >= 86
        ? `质量 ${mass?.toFixed(2) ?? '—'} M☉ · 事件视界半径 ${body.blackHole?.eventHorizonKm.toFixed(1) ?? '—'} km`
        : '特征：需要近距相对论测绘',
      type: '恒星级黑洞',
    };
  }
  const rand = makeRng(body.seed + ':ui-profile');
  const giant = body.type === 'gasGiant' || body.type === 'iceGiant';
  const gravity = giant
    ? (0.9 + (body.radius / 850000) * 1.35).toFixed(2)
    : (0.48 + Math.min(1.12, body.radius / 310_000) + rand() * 0.18).toFixed(2);
  const k = body.equilibriumK ?? 250;
  const tempLabel = k > 620 ? '极端高温' : k > 350 ? '炎热' : k >= 235 && k <= 330 ? '温和' : k > 190 ? '寒冷' : '严寒';
  const atmosphere = body.atmosphere?.composition
    ? `${body.atmosphere.composition.join(' / ')}${body.atmosphere.pressureBar == null ? '' : ` · ${body.atmosphere.pressureBar.toFixed(3)} bar`}${body.atmosphere.state ? ` · ${body.atmosphere.state}` : ''}${body.clouds ? ` · ${body.clouds.regime}${body.clouds.coverage > 0.05 ? ` (${body.clouds.condensates.join(' / ')})` : ''}` : ''}`
    : '近真空';
  const magneto = body.magnetosphere
    ? `${body.magnetosphere.label} · ${body.magnetosphere.origin} · ${body.magnetosphere.strengthEarth.toFixed(2)}×地球`
    : giant ? '强烈' : '数据不足';
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
  const knownResources = Math.min(5, survey >= 100 ? 5 : Math.max(1, Math.floor(survey / 18)));
  const hidden = (threshold, value, fallback = '数据不足') => survey >= threshold ? value : fallback;
  return {
    gravity: hidden(45, `${gravity} g`),
    temperature: hidden(28, `${Math.round(k)} K · ${tempLabel}`),
    atmosphere: hidden(55, atmosphere),
    magnetosphere: hidden(65, magneto),
    fauna: hidden(78, fauna, '需要近地生物扫描'),
    flora: hidden(78, flora, '需要近地生物扫描'),
    water: hidden(50, WATER_PROFILE[body.type] || '不明'),
    resources: resources.slice(0, 5), knownResources,
    traits: survey >= 86 ? traits : `特征：待识别 (0/${traitCount})`,
    type: TYPE_LABELS[body.type] || body.type,
  };
}

function previewSystem(seed, star, currentSystem) {
  const spec = currentSystem?.star.id === star.id ? currentSystem.spec : generateSystemSpec(seed, star);
  const allBodies = [...spec.bodies, ...(spec.compactObjects || [])];
  const indexById = new Map(allBodies.map((body, index) => [body.bodyId, index]));
  return {
    name: spec.name, properName: spec.properName, catalogId: spec.catalogId,
    systemId: spec.systemId, isHome: spec.isHome, isBlackHoleSystem: !!spec.isBlackHoleSystem,
    star, stars: spec.stars, binaryOrbit: spec.binaryOrbit,
    bodies: allBodies.map((body, index) => ({
      ...body, index,
      parentSpec: body.parentId ? indexById.get(body.parentId) : -1,
      orbitSpec: body.orbit,
      orbit: body.orbit.renderRadius,
    })),
  };
}

function disposeObject(root) {
  root.traverse((object) => {
    // THREE.Sprite uses one module-level shared geometry. Disposing it from a
    // scene teardown destroys the vertex buffer for every sprite created
    // afterwards, including SystemView's stellar halos.
    if (object.geometry && !object.isSprite) object.geometry.dispose();
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

function makeSelectionTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  context.strokeStyle = 'rgba(126,211,222,.9)';
  context.lineWidth = 4;
  context.beginPath();
  context.arc(32, 32, 20, 0, Math.PI * 2);
  context.stroke();
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
    this.discoverySeed = null;
    this.visitedSystems = new Set();
    this.pointerStart = null;
    this.clock = new THREE.Clock();
    this.overviewActive = false;
    this.overviewAmount = 0;

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
            <div id="sm-survey"><div class="label">数据完整度</div><div class="bar" id="sm-surveyBar"></div><div class="barValue" id="sm-surveyValue">—</div></div>
            <div id="sm-galaxyMeta">
              <div class="metaRows">
                <div class="metaRow"><span>航行距离</span><b id="sm-distance">—</b></div>
                <div class="metaRow"><span>天体数量</span><b id="sm-planets">—</b></div>
                <div class="metaRow"><span>表面温度</span><b id="sm-temperature">—</b></div>
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
              <button data-sm-filter="blackHole">黑洞</button>
            </div>
            <div class="toolMeta"><span id="sm-sector">—</span><b id="sm-count">—</b></div>
          </section>
          <section id="sm-planetLeft" class="panel planetInfo" aria-hidden="true">
            <div class="detailTitle"><div class="name" id="sm-detailName">—</div><div class="system" id="sm-detailSystem">—</div></div>
            <div class="detailSurvey">
              <div class="detailSurveyTop"><span>数据完整度</span><span id="sm-detailSurveyValue">0%</span></div>
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
          <section id="sm-faction" class="panel"><div class="small">管辖 / 航行状态</div><div class="panelRule"></div><div class="big" id="sm-factionName">—</div></section>
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
        <div id="sm-hoverMark" hidden></div>
      </div>
      <div id="sm-loading"><div class="loadBox"><div class="loadTitle">系统星图</div><div class="loadBar"><i></i></div></div></div>`;
    document.body.appendChild(root);
    this.root = root;
    // Browser QA hook. Kept on the owned overlay rather than window so a
    // disposed/rebuilt universe cannot leave a stale global controller.
    Object.defineProperty(root, '__starMapController', { value: this, configurable: true });
    const $ = (selector) => root.querySelector(selector);
    this.els = {
      canvas: $('#sm-canvas'), sysviewHost: $('#sm-sysview'), labelLayer: $('#sm-label-layer'),
      back: $('#sm-back'), railLabel: $('#sm-railLabel'),
      targetCode: $('#sm-targetCode'), catalog: $('#sm-catalog'), targetName: $('#sm-targetName'),
      classBox: $('#sm-class'), glyph: $('#sm-systemGlyph'),
      surveyBar: $('#sm-surveyBar'), surveyValue: $('#sm-surveyValue'),
      galaxyMeta: $('#sm-galaxyMeta'), distance: $('#sm-distance'), planets: $('#sm-planets'),
      temperature: $('#sm-temperature'),
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
      factionName: $('#sm-factionName'), faction: $('#sm-faction'),
      controls: $('#sm-controls'),
      leftHud: $('#sm-leftHud'), rightHud: $('#sm-rightHud'), bottomHud: $('#sm-bottomHud'),
      navArrow: $('#sm-navArrow'), nameTag: $('#sm-nameTag'),
      hoverMark: $('#sm-hoverMark'),
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
    const forceWebGL = new URLSearchParams(location.search).get('renderer') === 'webgl';
    this.renderer = new THREE.WebGPURenderer({
      antialias: true, alpha: true, powerPreference: 'high-performance', forceWebGL,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.els.canvas.appendChild(this.renderer.domElement);
    this.rendererReady = false;
    this.rendererInitError = null;
    this.rendererInit = this.renderer.init().then(() => {
      this.rendererReady = true;
    }).catch((error) => {
      this.rendererInitError = error;
      console.error('Star-map WebGPURenderer initialization failed.', error);
    });
    this.starTexture = makePointTexture();
    this.selectionTexture = makeSelectionTexture();
    this.softTexture = makeSoftDisc();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enableRotate = false;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.panSpeed = 1.05;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    this.controls.touches.ONE = THREE.TOUCH.PAN;
    this.controls.zoomSpeed = 1.35;
    this.controls.minDistance = GALAXY_MIN_DISTANCE;
    this.controls.maxDistance = 170;
    // Keep the chart projection anchored while zooming. Cursor-anchored dolly
    // mutates OrbitControls.target, making a selected system appear to slide
    // across the galaxy even when its world coordinate is unchanged.
    this.controls.zoomToCursor = false;
    this.controls.target.set(0, 0, 0);

    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.scene.add(new THREE.AmbientLight(0x82b8ce, 0.75));
    const key = new THREE.DirectionalLight(0xbfeeff, 2.2);
    key.position.set(20, 36, 18);
    this.scene.add(key);

    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
  }

  bindUI() {
    this.els.back.addEventListener('click', () => this.goBack());
    for (const button of this.root.querySelectorAll('[data-sm-filter]')) {
      button.addEventListener('click', () => {
        this.filter = button.dataset.smFilter;
        this.root.querySelectorAll('[data-sm-filter]').forEach((item) => item.classList.toggle('active', item === button));
        if (this.mode === 'galaxy') this.buildGalaxy(true);
      });
    }
    this.els.search.addEventListener('input', () => {
      if (this.mode === 'galaxy') this.buildGalaxy(true);
    });
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
    canvas.addEventListener('pointermove', (event) => {
      if (this.mode !== 'galaxy' || this.pointerStart) {
        this.els.hoverMark.hidden = true;
        return;
      }
      const hit = this.pickStarAt(event);
      if (!hit) {
        this.els.hoverMark.hidden = true;
        return;
      }
      // 预热 preview 缓存，减少点击时的生成延迟
      this.systemPreview(hit.star);
      this.els.hoverMark.hidden = false;
      this.els.hoverMark.style.transform = `translate3d(${hit.sx.toFixed(1)}px,${hit.sy.toFixed(1)}px,0)`;
    });
    canvas.addEventListener('pointerleave', () => { this.els.hoverMark.hidden = true; });
  }

  handleKey(event) {
    if (event.code === 'Escape') { this.goBack(); return; }
    if (this.mode === 'system') {
      if (event.code === 'KeyX') { this.warpToSelection(); return; }
      if (event.code === 'KeyV') this.sysview.setLabelsVisible(!this.sysview.labelsVisible);
      if (event.code === 'KeyQ') this.sysview.resetView();
    } else {
      if (event.code === 'KeyQ') this.resetGalaxyView();
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
    this.refreshDiscoveryState();
    this.markSystemVisited(this.getUniverse().system.star.id);
    this.mode = 'galaxy';
    this.root.classList.add('mode-galaxy');
    this.root.classList.remove('mode-system');
    this.selectedStar = this.getUniverse().system.star;
    this.selectedPlanet = null;
    this.sysview.suspend();
    this.sysview.setLabelsVisible(true);
    this.updateRail();
    this.updateHints();
    this.els.loading.classList.add('done');
    this.resize();
    this.buildGalaxy(true);
    this.selectStar(this.selectedStar, false);
    this.clock.start();
    this.animate();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.add('hidden');
    document.body.classList.remove('starmap-open');
    this.els.hoverMark.hidden = true;
    cancelAnimationFrame(this.raf);
    if (this.mode === 'system') this.sysview.suspend();
  }

  // Full teardown for hot-reload / context-loss recovery. close() is the
  // in-game "hide and pause" path; dispose() actually releases GPU memory
  // so a stale map renderer does not linger across a session rebuild.
  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this._resize);
    // Tear down the embedded system viewer first — it owns its own WebGL
    // renderer, composer, and a large texture cache.
    this.sysview?.dispose();
    // Free the galaxy-level renderer + its textures + controls. OrbitControls
    // attaches listeners to renderer.domElement, so dispose order matters:
    // controls.dispose() must run before renderer.dispose() releases the
    // canvas those listeners target.
    this.controls?.dispose();
    this.starTexture?.dispose();
    this.selectionTexture?.dispose();
    this.softTexture?.dispose();
    disposeObject(this.world);
    this.renderer?.dispose();
    this.renderer?.forceContextLoss?.();
    this.previewCache.clear();
    this.visitedSystems.clear();
  }

  setMode(mode) {
    if (mode === 'system') { this.enterSystem(); return; }
    if (this.mode === 'galaxy') return;
    this.mode = 'galaxy';
    this.root.classList.add('mode-galaxy');
    this.root.classList.remove('mode-system');
    this.selectedStar = this.getUniverse().system.star;
    this.sysview.selectBody(null);
    this.sysview.suspend();
    this.selectedPlanet = null;
    this.updateRail();
    this.updateHints();
    this.resize();
    this.buildGalaxy();
    this.selectStar(this.selectedStar, false);
  }

  async enterSystem() {
    if (this.mode === 'system' || !this.selectedStar) return;
    this.mode = 'system';
    this.els.hoverMark.hidden = true;
    this.root.classList.remove('mode-galaxy');
    this.root.classList.add('mode-system');
    this.updateRail();
    this.updateHints();
    this.resize();
    // 让浏览器先渲染一帧"已切换到星系模式"的 UI，再同步构建 3D 场景，
    // 避免 buildSystem 阻塞导致点击后整体卡顿无响应。
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    if (this.mode !== 'system') return; // 期间用户可能已返回银河图
    const selectedStar = this.selectedStar;
    await this.sysview.suspend();
    if (this.mode !== 'system' || this.selectedStar !== selectedStar) return;
    const preview = this.systemPreview(selectedStar);
    this.sysview.buildSystem(preview, this.getTime());
    this.updateSystemPanel(preview);
    this.onBodySelect(null);
    this.resize();
  }

  updateRail() {
    this.els.railLabel.textContent = this.mode === 'system' ? '银河图' : '驾驶舱';
    this.els.back.setAttribute('aria-label', this.mode === 'system' ? '返回银河图' : '返回飞行');
  }

  updateHints() {
    const hints = this.mode === 'system'
      ? [['设定航线', 'X'], ['显示位置', 'V'], ['重置视角', 'Q'], ['返回银河', 'Esc']]
      : [['点击恒星', 'LMB'], ['拖动星图', 'LMB'], ['滚轮缩放', '↕'], ['重置视野', 'Q'], ['返回', 'Esc']];
    this.els.controls.innerHTML = hints
      .map(([label, key]) => `<span class="hint">${label} <b class="key">${key}</b></span>`)
      .join('');
  }

  // ---- data -------------------------------------------------------------------
  refreshDiscoveryState() {
    const seed = this.getSeed();
    const universe = this.getUniverse();
    const discoveryKey = `deep-space:${universe.galaxyId}:catalog-v${GALAXY_LAYOUT_VERSION}:${seed}:visited-systems`;
    if (this.discoverySeed === discoveryKey) return;
    this.discoverySeed = discoveryKey;
    try {
      const saved = JSON.parse(localStorage.getItem(discoveryKey) || '[]');
      this.visitedSystems = new Set(Array.isArray(saved) ? saved : []);
    } catch {
      this.visitedSystems = new Set();
    }
  }

  markSystemVisited(id) {
    this.refreshDiscoveryState();
    if (this.visitedSystems.has(id)) return;
    this.visitedSystems.add(id);
    try {
      localStorage.setItem(this.discoverySeed, JSON.stringify([...this.visitedSystems]));
    } catch { /* private browsing can deny persistence */ }
  }

  surveyPercent(preview, status = navigationStatus(preview)) {
    this.refreshDiscoveryState();
    if (this.visitedSystems.has(preview.systemId)) return 100;
    const rand = makeRng(`${this.getSeed()}:remote-survey:${preview.systemId}`);
    return Math.round(THREE.MathUtils.clamp(status.coverage + (rand() - 0.5) * 14, 18, 72));
  }

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
    const nearest = [current, ...universe.nearStarsList]
      .sort((a, b) => a.pos.distanceToSquared(nav.pos) - b.pos.distanceToSquared(nav.pos))
      .slice(0, Math.max(1, STAR_LIMIT - universe.specialDestinations.length));
    const source = [...nearest];
    for (const destination of universe.specialDestinations) {
      if (!source.some((star) => star.id === destination.id)) source.push(destination);
    }
    const query = this.els.search.value.trim().toLocaleLowerCase();
    const maxDistance = source.length ? source[source.length - 1].pos.distanceTo(nav.pos) : 1;
    return source.filter((star) => {
      const preview = this.systemPreview(star);
      const types = preview.bodies.filter((body) => !body.isMoon).map((body) => body.type);
      const dist = star.pos.distanceTo(nav.pos);
      if (query && !preview.name.toLocaleLowerCase().includes(query) && !star.id.includes(query)) return false;
      if (this.filter === 'habitable' && !types.some((type) => type === 'lush' || type === 'ocean')) return false;
      if (this.filter === 'anomaly' && !types.some((type) => type === 'exotic' || type === 'lava' || type === 'toxic' || type === 'blackHole')) return false;
      if (this.filter === 'frontier' && dist < maxDistance * 0.58) return false;
      if (this.filter === 'blackHole' && !preview.isBlackHoleSystem) return false;
      return true;
    });
  }

  globalCandidates() {
    const universe = this.getUniverse();
    const source = [...(universe.allStars?.() || universe.nearStarsList)];
    for (const destination of universe.specialDestinations) {
      if (!source.some((star) => star.id === destination.id)) source.push(destination);
    }
    return source;
  }

  // ---- galaxy level -------------------------------------------------------------
  resetWorld() {
    disposeObject(this.world);
    this.scene.remove(this.world);
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.labelData = [];
    this.els.labelLayer.replaceChildren();
  }

  resetGalaxyView(focus = null) {
    const target = focus || new THREE.Vector3();
    this.camera.position.set(target.x, target.y + GALAXY_DEFAULT_DISTANCE, target.z + 0.01);
    this.camera.up.set(0, 0, -1);
    this.controls.target.copy(target);
    this.controls.update();
  }

  buildGalaxy(resetView = false) {
    this.resetWorld();
    const current = this.getUniverse().system.star;
    const stars = this.candidates();
    const globalStars = this.globalCandidates();
    const globalScale = 78 / (GALAXY_RADIUS_CELLS * CELL);
    this.localStars = stars;
    this.globalStars = globalStars;
    this.globalMapPositions = globalStars.map((star) => {
      const delta = star.pos.clone().sub(current.pos).multiplyScalar(globalScale);
      // The navigation chart is a top-down projection. Catalogue height is
      // formation data, not a second screen-space offset.
      return new THREE.Vector3(delta.x, 0, delta.z);
    });
    this.globalPositionById = new Map(
      globalStars.map((star, index) => [star.id, this.globalMapPositions[index]]));
    this.localMapPositions = stars.map((star) => this.globalPositionById.get(star.id).clone());
    // Every real system remains visible and pickable at every zoom level. The
    // local catalogue is only a visual emphasis layer; it must never take over
    // interaction ownership from the complete galaxy catalogue.
    this.visibleStars = globalStars;
    this.mapPositions = this.globalMapPositions;

    const makeStarLayer = (layerStars, positions, pixelSize, opacity) => {
      // Textured PointsMaterial relies on gl_PointCoord. Three r185 cannot
      // provide that path reliably to WGSL, so WebGPU could keep the CPU-side
      // hit target while drawing no star at all. Instanced UV-bearing quads
      // preserve a single draw call and render identically on both backends.
      const geometry = new THREE.PlaneGeometry(1, 1);
      geometry.rotateX(-Math.PI / 2);
      const material = new THREE.MeshBasicMaterial({
        map: this.starTexture, vertexColors: true,
        transparent: true, opacity, blending: THREE.AdditiveBlending,
        depthWrite: false, fog: false, toneMapped: false,
      });
      const discs = new THREE.InstancedMesh(geometry, material, layerStars.length);
      const matrix = new THREE.Matrix4();
      const scale = new THREE.Vector3(1, 1, 1);
      const rotation = new THREE.Quaternion();
      for (let i = 0; i < layerStars.length; i++) {
        matrix.compose(positions[i], rotation, scale);
        discs.setMatrixAt(i, matrix);
        discs.setColorAt(i, layerStars[i].color.clone().lerp(new THREE.Color(0xffffff), 0.32));
      }
      discs.instanceMatrix.needsUpdate = true;
      if (discs.instanceColor) discs.instanceColor.needsUpdate = true;
      discs.frustumCulled = false;
      discs.userData.starPositions = positions;
      discs.userData.pixelSize = pixelSize;
      discs.userData.worldSize = 0;
      this.world.add(discs);
      return discs;
    };
    this.globalStarLight = makeStarLayer(globalStars, this.globalMapPositions, 5.6, 0.92);
    this.localStarLight = makeStarLayer(stars, this.localMapPositions, 7.4, 0.28);

    const backdropCells = buildGalaxyBackdrop(
      this.getSeed(), GALAXY_BACKDROP_COUNT, this.getUniverse().catalog.allSystems());
    const backdropPositions = new Float32Array(backdropCells.length);
    const currentCells = current.pos.clone().multiplyScalar(1 / CELL);
    for (let i = 0; i < backdropCells.length; i += 3) {
      backdropPositions[i] = (backdropCells[i] - currentCells.x) * CELL * globalScale;
      backdropPositions[i + 1] = 0;
      backdropPositions[i + 2] = (backdropCells[i + 2] - currentCells.z) * CELL * globalScale;
    }
    const backdropGeometry = new THREE.BufferGeometry();
    backdropGeometry.setAttribute('position', new THREE.BufferAttribute(backdropPositions, 3));
    const backdropColors = new Float32Array(backdropCells.length);
    const coolArm = new THREE.Color(0x9fc9da);
    const warmCore = new THREE.Color(0xf1cf9d);
    const backdropColor = new THREE.Color();
    for (let i = 0; i < backdropCells.length; i += 3) {
      const radius = Math.hypot(backdropCells[i], backdropCells[i + 2]) / GALAXY_RADIUS_CELLS;
      const coreMix = 1 - THREE.MathUtils.smoothstep(radius, 0.08, 0.46);
      backdropColor.copy(coolArm).lerp(warmCore, coreMix * 0.78);
      backdropColors[i] = backdropColor.r;
      backdropColors[i + 1] = backdropColor.g;
      backdropColors[i + 2] = backdropColor.b;
    }
    backdropGeometry.setAttribute('color', new THREE.BufferAttribute(backdropColors, 3));
    this.galaxyBackdrop = new THREE.Points(backdropGeometry, new THREE.PointsMaterial({
      size: 1.16, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
    }));
    this.world.add(this.galaxyBackdrop);

    // Authored destinations must be discoverable without hunting through
    // hundreds of identical point sprites.  Keep the black hole marked at
    // every zoom level with a compact lensing target, not a second star dot.
    for (const destination of this.getUniverse().specialDestinations) {
      const localIndex = stars.findIndex((star) => star.id === destination.id);
      const globalIndex = globalStars.findIndex((star) => star.id === destination.id);
      if (localIndex < 0 || globalIndex < 0) continue;
      const marker = new THREE.Group();
      marker.position.copy(this.localMapPositions[localIndex]);
      marker.userData.localPosition = this.localMapPositions[localIndex];
      marker.userData.globalPosition = this.globalMapPositions[globalIndex];
      marker.name = `special-destination:${destination.id}`;
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.softTexture, color: 0xff7f32, transparent: true, opacity: 0.38,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      glow.scale.set(9, 9, 1);
      marker.add(glow);
      for (const [radius, opacity] of [[1.55, 0.92], [2.35, 0.34]]) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(radius, radius === 1.55 ? 0.12 : 0.055, 8, 72),
          new THREE.MeshBasicMaterial({
            color: 0xffb36a, transparent: true, opacity,
            blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
          }),
        );
        ring.rotation.x = Math.PI / 2;
        marker.add(ring);
      }
      this.world.add(marker);
      this.centralMarker = marker;
    }

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

    if (resetView) {
      const focusedResult = stars.length <= 3 && this.localMapPositions.length
        ? this.localMapPositions.reduce((sum, point) => sum.add(point), new THREE.Vector3())
          .multiplyScalar(1 / this.localMapPositions.length)
        : null;
      this.resetGalaxyView(focusedResult);
    }
    this.els.count.textContent = `${globalStars.filter((star) => star.kind !== 'blackHole').length} / 1024`;
    this.els.sector.textContent = current.id;
    this.buildGalaxyLabels(stars, current);
    this.updateSelectionMarker();
    this.updateGalaxyOverview(true);
  }

  updateGalaxyOverview(force = false) {
    if (!this.localStarLight || !this.globalStarLight || !this.galaxyBackdrop) return;
    const distance = this.camera.position.distanceTo(this.controls.target);
    const amount = overviewMix(distance);
    this.overviewAmount = amount;
    this.globalStarLight.material.opacity = THREE.MathUtils.lerp(0.92, 0.98, amount);
    this.localStarLight.material.opacity = 0.28 * (1 - amount);
    this.galaxyBackdrop.material.opacity = 0.46 * amount;
    this.updateStarLayerScale(this.globalStarLight, distance);
    this.updateStarLayerScale(this.localStarLight, distance);
    this.updateSelectionMarkerScale(distance);
    if (this.centralMarker) {
      this.centralMarker.position.copy(this.centralMarker.userData.globalPosition);
      this.centralMarker.scale.setScalar(THREE.MathUtils.lerp(1, 0.72, amount));
    }
    const active = amount >= 0.55;
    const activeChanged = active !== this.overviewActive;
    this.overviewActive = active;
    this.visibleStars = this.globalStars;
    this.mapPositions = this.globalMapPositions;
    if (force || activeChanged) {
      this.els.count.textContent = `${this.globalStars.filter((star) => star.kind !== 'blackHole').length} / 1024`;
    }
  }

  updateStarLayerScale(layer, distance) {
    if (!layer?.userData.starPositions?.length) return;
    const worldPerPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5))
      / Math.max(1, this.renderer.domElement.clientHeight);
    const worldSize = worldPerPixel * layer.userData.pixelSize;
    const oldSize = layer.userData.worldSize;
    if (oldSize && Math.abs(worldSize - oldSize) / oldSize < 0.006) return;
    layer.userData.worldSize = worldSize;
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3(worldSize, worldSize, worldSize);
    for (let i = 0; i < layer.userData.starPositions.length; i++) {
      matrix.compose(layer.userData.starPositions[i], rotation, scale);
      layer.setMatrixAt(i, matrix);
    }
    layer.instanceMatrix.needsUpdate = true;
  }

  updateSelectionMarkerScale(distance) {
    const marker = this.world?.getObjectByName('selection-marker');
    if (!marker) return;
    const worldPerPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5))
      / Math.max(1, this.renderer.domElement.clientHeight);
    marker.scale.setScalar(worldPerPixel * 16);
  }

  buildGalaxyLabels(stars, current) {
    const candidates = stars
      .map((star, index) => {
        const preview = this.systemPreview(star);
        const special = preview.isBlackHoleSystem;
        const priority = special ? 1000
          : star.id === this.selectedStar?.id ? 900
          : star.id === current.id ? 800
          : star.civilizationTag ? 140
          : this.visitedSystems.has(star.id) ? 80
          : 10;
        const position = this.globalPositionById.get(star.id);
        return { star, index, preview, priority, position, distance: position.lengthSq() };
      })
      .sort((a, b) => b.priority - a.priority || a.distance - b.distance);
    this.labelData = candidates.map(({ star, preview, priority, position }) => {
      const button = document.createElement('div');
      button.className = 'sm-map-label';
      button.innerHTML = '<i></i><strong></strong><small></small>';
      button.children[0].style.setProperty('--label-color', `#${star.color.getHexString()}`);
      button.children[1].textContent = preview.properName;
      button.children[2].textContent = star.id === current.id
        ? '当前位置'
        : preview.isBlackHoleSystem
          ? 'BH · 唯一引力观测禁区'
          : star.civilizationTag
            ? `文明 · ${civilizationLabel(star.civilizationTag)}`
          : `${physicalStarClass(preview.stars[0]).code} · ${preview.bodies.filter((b) => !b.isMoon).length} 行星`;
      button.classList.toggle('current', star.id === current.id);
      button.classList.toggle('selected', star.id === this.selectedStar?.id);
      button.classList.toggle('black-hole', preview.isBlackHoleSystem);
      button.title = preview.isBlackHoleSystem ? '唯一黑洞系统 · 单击查看' : `${preview.properName} · 单击查看`;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.selectStar(star, false);
        this.enterSystem();
      });
      this.els.labelLayer.appendChild(button);
      return {
        button, position, star,
        width: preview.isBlackHoleSystem ? 154 : Math.min(132, 20 + preview.properName.length * 10),
        height: star.id === current.id ? 31 : 25,
        priority,
      };
    });
  }

  updateMapLabels() {
    if (!this.labelData?.length) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const point = new THREE.Vector3();
    const projected = [];
    const cameraDistance = this.camera.position.distanceTo(this.controls.target);
    const labelScale = THREE.MathUtils.clamp(38 / Math.max(1, cameraDistance), 0.46, 0.88);
    const labelBudget = Math.round(THREE.MathUtils.clamp(10 + 620 / Math.max(1, cameraDistance), 14, 56));
    this.root.style.setProperty('--galaxy-label-scale', labelScale.toFixed(3));
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
    let placedLabels = 0;
    for (const entry of projected) {
      const { item, x, y } = entry;
      const halfHeight = item.height * 0.5;
      const box = { left: x - 6, top: y - halfHeight - 3, right: x + item.width, bottom: y + halfHeight + 3 };
      const overlaps = (other) => !(box.right < other.left || box.left > other.right
        || box.bottom < other.top || box.top > other.bottom);
      const blockedByPanel = occupied.slice(0, blockerCount).some(overlaps);
      const labelCollision = occupied.slice(blockerCount).some(overlaps);
      const overBudget = placedLabels >= labelBudget && (item.priority || 0) < 80;
      if (blockedByPanel || overBudget || (labelCollision && (item.priority || 0) < 80)) {
        item.button.hidden = true;
        continue;
      }
      item.button.hidden = false;
      placedLabels++;
      occupied.push(box);
      item.button.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translateY(-50%) scale(var(--galaxy-label-scale))`;
    }
  }

  updateSelectionMarker() {
    const old = this.world.getObjectByName('selection-marker');
    if (old) {
      this.world.remove(old);
      if (old.geometry && !old.isSprite) old.geometry.dispose();
      old.material.dispose();
    }
    if (this.mode !== 'galaxy' || !this.selectedStar || !this.visibleStars) return;
    const index = this.visibleStars.findIndex((star) => star.id === this.selectedStar.id);
    if (index < 0) return;
    const marker = new THREE.Sprite(new THREE.SpriteMaterial({
      color: 0xffffff, map: this.selectionTexture,
      transparent: true, opacity: 0.84, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false, toneMapped: false,
    }));
    marker.name = 'selection-marker';
    marker.position.copy(this.mapPositions[index]);
    const distance = this.camera.position.distanceTo(this.controls.target);
    const worldPerPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5))
      / Math.max(1, this.renderer.domElement.clientHeight);
    marker.scale.setScalar(worldPerPixel * 16);
    this.world.add(marker);
  }

  selectStar(star, focus = true) {
    this.selectedStar = star;
    this.selectedPlanet = null;
    if (this.mode === 'galaxy' && this.labelData?.length) {
      const currentId = this.getUniverse().system.star.id;
      for (const item of this.labelData) {
        const special = this.systemPreview(item.star).isBlackHoleSystem;
        item.priority = special ? 1000
          : item.star.id === star.id ? 900
          : item.star.id === currentId ? 800
          : this.visitedSystems.has(item.star.id) ? 80
          : 10;
        item.button.classList.toggle('selected', item.star.id === star.id);
      }
      this.updateMapLabels();
    }
    const preview = this.systemPreview(star);
    const cls = preview.isBlackHoleSystem
      ? { code: 'BH', label: '黑洞系统', temp: '事件视界 · 相对论观测目标' }
      : physicalStarClass(preview.stars[0]);
    const distance = star.pos.distanceTo(this.getNav().pos);
    const primaryCount = preview.bodies.filter((body) => !body.isMoon && body.type !== 'blackHole').length;
    const moonCount = preview.bodies.length - primaryCount;
    const compactCount = preview.bodies.filter((body) => body.type === 'blackHole').length;
    const isCurrent = star.id === this.getUniverse().system.star.id;
    const status = navigationStatus(preview);
    const survey = this.surveyPercent(preview, status);

    this.els.targetCode.textContent = `${preview.catalogId} // ${cls.code}-CLASS`;
    this.els.catalog.textContent = `代号 · ${preview.catalogId}`;
    const siteLabel = civilizationLabel(star.civilizationTag);
    this.els.targetName.textContent = siteLabel ? `${preview.properName} · ${siteLabel}` : preview.properName;
    this.els.classBox.textContent = cls.code;
    this.els.classBox.style.background = preview.isBlackHoleSystem
      ? 'radial-gradient(circle, #000 34%, #ffae67 38%, #4a1608 62%, #050709 68%)'
      : `#${preview.stars[0] ? new THREE.Color(preview.stars[0].color).getHexString() : '#17e31a'}`;
    this.els.surveyValue.textContent = `${survey}%`;
    this.els.surveyBar.style.setProperty('--survey-progress', this.els.surveyValue.textContent);
    this.els.surveyBar.title = survey === 100 ? '已到访：完整星系数据' : `远程传感器覆盖 · ${status.advisory}`;
    this.els.factionName.textContent = siteLabel ? '人类边疆共同体' : status.name;
    this.els.faction.title = siteLabel ? `${siteLabel} · 已登记文明航标` : status.advisory;
    this.buildGlyph(preview);
    this.els.distance.textContent = isCurrent ? '当前位置' : distanceText(distance);
    this.els.planets.textContent = `${primaryCount} 行星 / ${moonCount - compactCount} 卫星${compactCount ? ` / ${compactCount} 致密天体` : ''}`;
    this.els.temperature.textContent = cls.temp;
    this.updateSelectionMarker();
    if (focus && this.mode === 'galaxy' && this.visibleStars) {
      const index = this.visibleStars.findIndex((item) => item.id === star.id);
      if (index >= 0) this.controls.target.lerp(this.mapPositions[index], 0.75);
    }
    if (this.mode === 'system') this.updateSystemPanel(preview);
  }

  buildGlyph(preview) {
    const allPrimaries = preview.bodies.filter((body) => !body.isMoon);
    const compact = allPrimaries.find((body) => body.type === 'blackHole');
    const primaries = allPrimaries.filter((body) => body.type !== 'blackHole').slice(0, compact ? 6 : 7);
    if (compact) primaries.push(compact);
    const starColor = new THREE.Color(preview.stars[0]?.color ?? 0xffffff);
    const binary = preview.stars.length > 1;
    const starBackground = binary
      ? `linear-gradient(100deg, #${starColor.getHexString()} 0 48%, #${new THREE.Color(preview.stars[1].color).getHexString()} 52% 100%)`
      : `#${starColor.getHexString()}`;
    const mainBackground = preview.isBlackHoleSystem
      ? 'radial-gradient(circle, #000 0 38%, #ffd3a0 41%, #ff7a32 46%, #170803 58%, #050709 70%)'
      : starBackground;
    const parts = [`<i class="gMain" style="background:${mainBackground};box-shadow:0 0 18px #${preview.isBlackHoleSystem ? 'ff934f' : starColor.getHexString()}88"></i>`];
    // distribute planet slots outward from the star, alternating sides
    const slots = [57, 31.5, 68, 22, 78, 12, 86];
    primaries.forEach((body, i) => {
      const size = body.type === 'blackHole' ? 18 : 10 + Math.min(16, (body.radius / 310_000) * 16) * (body.type === 'gasGiant' || body.type === 'iceGiant' ? 1.35 : 1);
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
    const systemSurvey = this.surveyPercent(this.systemPreview(this.selectedStar));
    const signalBonus = body.isMoon ? -10 : (body.type === 'gasGiant' || body.type === 'iceGiant') ? 14 : 4;
    const survey = systemSurvey === 100 ? 100 : Math.round(THREE.MathUtils.clamp(systemSurvey + signalBonus, 12, 82));
    const profile = bodyProfile(body, survey);
    this.els.detailName.textContent = body.name;
    this.els.detailSurveyValue.textContent = `${survey}%`;
    this.els.detailSurveyBar.style.setProperty('--survey-progress', `${survey}%`);
    this.els.detailType.textContent = profile.type;
    this.els.detailGravity.textContent = profile.gravity;
    this.els.detailTemperature.textContent = profile.temperature;
    this.els.detailAtmosphere.textContent = profile.atmosphere;
    this.els.detailAtmosphere.title = profile.atmosphere;
    this.els.detailMagnetosphere.textContent = profile.magnetosphere;
    this.els.detailMagnetosphere.title = profile.magnetosphere;
    this.els.detailFauna.textContent = profile.fauna;
    this.els.detailFlora.textContent = profile.flora;
    this.els.detailWater.textContent = profile.water;
    this.els.resourceCount.textContent = `(${profile.knownResources}/${profile.resources.length})`;
    this.els.resourceTiles.innerHTML = profile.resources
      .map((value, index) => `<div class="resourceTile${index >= profile.knownResources ? ' unknown' : ''}">${index < profile.knownResources ? value : '未识别'}</div>`).join('');
    this.els.traitText.textContent = profile.traits;
    this.updateRouteAction();
  }

  updateRouteAction() {
    const isCurrent = this.selectedStar && this.selectedStar.id === this.getUniverse().system.star.id;
    const hasTarget = !!this.selectedPlanet;
    const canWarp = hasTarget && this.getState() === 'space';
    const label = this.els.routeAction.querySelector('.routeActionLabel');
    this.els.routeAction.disabled = !canWarp;
    label.textContent = !hasTarget ? '选择目标星球'
      : this.getState() !== 'space' ? '需返回飞船'
        : this.selectedPlanet.type === 'blackHole'
          ? isCurrent ? '前往安全观测距离' : '设定黑洞跃迁航线'
          : isCurrent ? '自动导航至目标轨道' : '设定航线至目标轨道';
  }

  warpToSelection() {
    if (!this.selectedStar) return;
    if (this.selectedStar.id === this.getUniverse().system.star.id && !this.selectedPlanet) return;
    if (this.getState() !== 'space') return;
    this.onWarpTarget?.(this.selectedStar, this.selectedPlanet?.bodyId || null);
  }

  pickStarAt(event) {
    if (!this.visibleStars?.length || !this.mapPositions?.length) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const projected = new THREE.Vector3();
    let best = null;
    let bestDist = Infinity;
    const maxPixelDist = 28;
    for (let i = 0; i < this.visibleStars.length; i++) {
      projected.copy(this.mapPositions[i]).project(this.camera);
      if (projected.z < -1 || projected.z > 1) continue;
      const sx = (projected.x * 0.5 + 0.5) * rect.width;
      const sy = (-projected.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(sx - px, sy - py);
      if (d < bestDist && d <= maxPixelDist) {
        bestDist = d;
        best = { star: this.visibleStars[i], sx, sy };
      }
    }
    return best;
  }

  pick(event) {
    const hit = this.pickStarAt(event);
    if (!hit) return;
    this.selectStar(hit.star, false);
    this.enterSystem();
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
    this.els.galaxyTools.style.top = '392px';
  }

  animate() {
    if (!this.isOpen) return;
    this.raf = requestAnimationFrame(() => this.animate());
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.mode === 'galaxy') {
      this.controls.update();
      this.updateGalaxyOverview();
      this.updateMapLabels();
      if (this.rendererReady) this.renderer.render(this.scene, this.camera);
    } else {
      this.sysview.frame(dt);
    }
  }
}
