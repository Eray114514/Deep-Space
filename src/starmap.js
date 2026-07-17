import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeRng } from './rng.js';
import { generateSystemSpec, orbitalPosition } from './astronomy.js';

const AU = 149_597_870_700;
const STAR_LIMIT = 320;
const NETWORK_LIMIT = 130;
const TYPE_COLORS = {
  lush: 0x52d7a4,
  ocean: 0x4ea7ff,
  desert: 0xe2aa65,
  ice: 0xb8e7ff,
  lava: 0xff6848,
  barren: 0x9da7ad,
  toxic: 0xb5e45d,
  exotic: 0xe47cff,
  gasGiant: 0xd29b68,
  iceGiant: 0x68c7df,
};
const TYPE_LABELS = {
  lush: '繁茂世界',
  ocean: '海洋世界',
  desert: '荒漠世界',
  ice: '冰封世界',
  lava: '火山世界',
  barren: '贫瘠世界',
  toxic: '剧毒世界',
  exotic: '异象世界',
  gasGiant: '气态巨星',
  iceGiant: '冰巨星',
};

function starSurfaceMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: color.clone() },
    },
    vertexShader: `
      varying vec3 vLocal;
      varying vec3 vNormalW;
      varying vec3 vView;
      void main() {
        vLocal = normalize(position);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uColor;
      varying vec3 vLocal;
      varying vec3 vNormalW;
      varying vec3 vView;
      float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float noise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
      }
      float fbm(vec3 p) {
        float s = 0.0, a = 0.55;
        for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.03 + 7.1; a *= 0.48; }
        return s;
      }
      void main() {
        vec3 flow = vLocal * 4.2 + vec3(uTime * 0.035, -uTime * 0.022, uTime * 0.018);
        float cells = fbm(flow) * 0.72 + fbm(flow * 2.35 - uTime * 0.015) * 0.28;
        float hot = smoothstep(0.42, 0.9, cells);
        float limb = pow(clamp(dot(normalize(vNormalW), normalize(vView)), 0.0, 1.0), 0.32);
        vec3 amber = mix(uColor * 0.65, vec3(1.0, 0.43, 0.08), 0.38);
        vec3 core = mix(amber, vec3(1.55, 1.16, 0.54), hot);
        gl_FragColor = vec4(core * (0.85 + cells * 1.45) * (0.72 + limb * 0.45), 1.0);
      }
    `,
    toneMapped: false,
  });
}

function starCoronaMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() } },
    vertexShader: `
      varying vec3 vNormalW;
      varying vec3 vView;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying vec3 vNormalW;
      varying vec3 vView;
      void main() {
        float rim = pow(1.0 - clamp(dot(normalize(vNormalW), normalize(vView)), 0.0, 1.0), 2.25);
        gl_FragColor = vec4(uColor * (1.5 + rim), rim * 0.42);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

function starClass(star) {
  const c = star.color;
  if (c.b > c.r * 1.08) return { code: 'A', label: '蓝白主序星', temp: '7,500–10,000 K' };
  if (c.r > c.b * 1.28 && c.g < c.r * 0.78) return { code: 'M', label: '红矮星', temp: '2,400–3,700 K' };
  if (c.r > c.b * 1.22) return { code: 'K', label: '橙矮星', temp: '3,700–5,200 K' };
  if (c.r > c.b * 1.08) return { code: 'G', label: '黄矮星', temp: '5,200–6,000 K' };
  return { code: 'F', label: '黄白主序星', temp: '6,000–7,500 K' };
}

function distanceText(metres) {
  if (metres < 1e9) return `${(metres / 1e6).toFixed(0)} 千公里`;
  if (metres < AU * 0.15) return `${(metres / 1e9).toFixed(2)} 百万公里`;
  return `${(metres / AU).toFixed(3)} AU`;
}

function physicalStarClass(star) {
  const code = star.spectralClass?.[0] || 'G';
  const labels = { O: '蓝色主序星', B: '蓝白主序星', A: '白色主序星', F: '黄白主序星', G: '黄矮星', K: '橙矮星', M: '红矮星', D: '白矮星' };
  return { code, label: labels[code] || '恒星', temp: `${Math.round(star.temperatureK).toLocaleString('zh-CN')} K` };
}

function planetProfile(body) {
  const rand = makeRng(body.seed + ':ui-profile');
  const gravity = (0.48 + Math.min(1.12, body.radius / 310_000) + rand() * 0.18).toFixed(2);
  const profiles = {
    lush: ['温和', '标准 氧气', '丰富', '丰富', ['H₂O', 'Fe', 'Ar', 'C']],
    ocean: ['湿润', '富氧', '海洋', '稀疏', ['H₂O', 'Cl', 'Ar', 'Cu']],
    desert: ['炎热', '稀薄 CO₂', '稀少', '稀少', ['Si', 'Fe', 'He₃', 'Al']],
    ice: ['严寒', '冰晶氮气', '稀少', '冻原', ['H₂O', 'N', 'Ar', 'Pb']],
    lava: ['极端高温', '硫化物', '无', '无', ['Fe', 'Ni', 'S', 'Co']],
    barren: ['寒冷', '近真空', '无', '无', ['Fe', 'Pb', 'Al', 'He₃']],
    toxic: ['腐蚀性', '剧毒', '危险', '异常', ['Cl', 'Ar', 'F', 'Si']],
    exotic: ['异常', '未知', '未知', '未知', ['Au', 'Xe', 'Ir', '???']],
    gasGiant: ['风暴云层', '氢氦大气', '无固体表面', '无', ['H₂', 'He', 'NH₃', 'CH₄']],
    iceGiant: ['极寒', '甲烷氢氦', '无固体表面', '无', ['CH₄', 'H₂', 'He', 'H₂O']],
  };
  const [temp, defaultAtmo, fauna, flora, resources] = profiles[body.type] || profiles.barren;
  const atmo = body.atmosphere?.composition
    ? `${body.atmosphere.composition.join(' / ')}${body.atmosphere.pressureBar == null ? '' : ` · ${body.atmosphere.pressureBar.toFixed(2)} bar`}`
    : defaultAtmo;
  return { gravity, temp, atmo, fauna, flora, resources };
}

function previewSystem(seed, star, currentSystem) {
  const spec = currentSystem?.star.id === star.id ? currentSystem.spec : generateSystemSpec(seed, star);
  const indexById = new Map(spec.bodies.map((body, index) => [body.bodyId, index]));
  return {
    name: spec.name, catalogId: spec.catalogId, star, stars: spec.stars, binaryOrbit: spec.binaryOrbit,
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
    this.bindUI();
  }

  buildDOM() {
    const root = document.createElement('section');
    root.id = 'starmap-overlay';
    root.className = 'hidden';
    root.setAttribute('aria-label', '3D 星图');
    root.innerHTML = `
      <main class="sm-viewport">
        <div id="sm-canvas"></div>
        <div class="sm-coordinate-grid" aria-hidden="true"></div>
        <div id="sm-label-layer" aria-label="星图标记"></div>
        <div class="sm-map-frame" aria-hidden="true"></div>
      </main>

      <nav class="sm-nav-rail" aria-label="星图导航">
        <button id="sm-close" class="sm-back" aria-label="返回飞行">返回</button>
        <button class="active" data-sm-mode="galaxy">星图</button>
        <button data-sm-mode="system">星系</button>
      </nav>

      <section class="sm-galaxy-tools">
        <label class="sm-search"><span>搜索星系</span><input id="sm-search" type="search" maxlength="32" autocomplete="off" placeholder="星系名称 / 坐标" /></label>
        <div class="sm-filter-grid">
          <button class="active" data-sm-filter="all">全部</button>
          <button data-sm-filter="habitable">宜居</button>
          <button data-sm-filter="anomaly">异常</button>
          <button data-sm-filter="frontier">边界</button>
        </div>
        <div class="sm-map-meta"><span id="sm-sector">—</span><b id="sm-count">—</b></div>
      </section>

      <section class="sm-system-panel sm-panel">
        <header><span>系统</span><b id="sm-target-code">NO TARGET</b></header>
        <div class="sm-system-title"><small>代号</small><h1 id="sm-target-name">选择一个恒星系</h1></div>
        <div class="sm-system-grade"><span>等级</span><strong>1</strong></div>
        <div class="sm-star-orb"><div id="sm-star-core"></div></div>
        <dl class="sm-data-grid">
          <div><dt>恒星类型</dt><dd id="sm-star-type">—</dd></div>
          <div><dt>航行距离</dt><dd id="sm-distance">—</dd></div>
          <div><dt>表面温度</dt><dd id="sm-temperature">—</dd></div>
          <div><dt>天体数量</dt><dd id="sm-planets">—</dd></div>
        </dl>
        <div class="sm-explore"><span>勘查</span><i><b></b></i><strong>34%</strong></div>
        <div id="sm-body-list" class="sm-body-list"><div class="sm-empty">选择恒星以解算行星轨道</div></div>
        <div class="sm-actions">
          <button id="sm-inspect" disabled>查看星系</button>
          <button id="sm-warp" disabled><span>设定航线</span><small id="sm-warp-state">等待目标</small></button>
        </div>
      </section>

      <section id="sm-planet-panel" class="sm-planet-panel sm-panel" aria-live="polite">
        <header><span>天体资料</span><b id="sm-body-kind">未测绘</b></header>
        <h2 id="sm-body-name">—</h2>
        <p id="sm-body-system">—</p>
        <dl>
          <div><dt>类型</dt><dd id="sm-body-type">—</dd></div>
          <div><dt>重力</dt><dd id="sm-body-gravity">—</dd></div>
          <div><dt>温度</dt><dd id="sm-body-temp">—</dd></div>
          <div><dt>大气层</dt><dd id="sm-body-atmo">—</dd></div>
          <div><dt>动物</dt><dd id="sm-body-fauna">—</dd></div>
          <div><dt>植物</dt><dd id="sm-body-flora">—</dd></div>
        </dl>
      </section>

      <section class="sm-faction-panel sm-panel"><span>阵营</span><strong>联合殖民地</strong></section>

      <section id="sm-resource-panel" class="sm-resource-panel sm-panel">
        <header><span>资源</span><b>(0/5)</b></header>
        <div id="sm-resource-list"></div>
        <p>特征：<span id="sm-body-features">不明 (0/3)</span></p>
        <button type="button">扫描 <kbd>R</kbd></button>
      </section>

      <div id="sm-view-caption">拖动平移 · 滚轮缩放 · 单击选择</div>
      <div id="sm-route-status"><i></i>航路网络在线</div>
      <footer class="sm-footer"><span>任务 <kbd>L</kbd></span><span>显示位置 <kbd>V</kbd></span><span>设定航线 <kbd>X</kbd></span><span>返回 <kbd>Tab</kbd></span></footer>
      <span id="sm-sync" class="sm-sync">航路同步 100%</span>`;
    document.body.appendChild(root);
    this.root = root;
    const $ = (selector) => root.querySelector(selector);
    this.els = {
      canvas: $('#sm-canvas'),
      labelLayer: $('#sm-label-layer'),
      close: $('#sm-close'),
      sync: $('#sm-sync'),
      sector: $('#sm-sector'),
      count: $('#sm-count'),
      search: $('#sm-search'),
      caption: $('#sm-view-caption'),
      targetCode: $('#sm-target-code'),
      targetName: $('#sm-target-name'),
      starCore: $('#sm-star-core'),
      starType: $('#sm-star-type'),
      distance: $('#sm-distance'),
      temperature: $('#sm-temperature'),
      planets: $('#sm-planets'),
      bodyList: $('#sm-body-list'),
      inspect: $('#sm-inspect'),
      warp: $('#sm-warp'),
      warpState: $('#sm-warp-state'),
      routeStatus: $('#sm-route-status'),
      systemPanel: $('.sm-system-panel'),
      planetPanel: $('#sm-planet-panel'),
      resourcePanel: $('#sm-resource-panel'),
      bodyKind: $('#sm-body-kind'), bodyName: $('#sm-body-name'), bodySystem: $('#sm-body-system'),
      bodyType: $('#sm-body-type'), bodyGravity: $('#sm-body-gravity'), bodyTemp: $('#sm-body-temp'),
      bodyAtmo: $('#sm-body-atmo'), bodyFauna: $('#sm-body-fauna'), bodyFlora: $('#sm-body-flora'),
      resourceList: $('#sm-resource-list'), bodyFeatures: $('#sm-body-features'),
    };
  }

  buildRenderer() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x10171b);
    this.scene.fog = new THREE.FogExp2(0x10171b, 0.0038);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    this.camera.position.set(0, 110, 0.01);
    this.camera.up.set(0, 0, -1);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.16;
    this.els.canvas.appendChild(this.renderer.domElement);
    this.starTexture = makePointTexture();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enableRotate = false;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.panSpeed = 1.05;
    this.controls.zoomSpeed = 0.8;
    this.controls.minDistance = 24;
    this.controls.maxDistance = 210;
    this.controls.target.set(0, 0, 0);

    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.scene.add(new THREE.AmbientLight(0x82b8ce, 0.75));
    const key = new THREE.DirectionalLight(0xbfeeff, 2.2);
    key.position.set(20, 36, 18);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x4879ff, 1.4);
    rim.position.set(-30, -8, -24);
    this.scene.add(rim);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Points.threshold = 2.2;
    this.pointer = new THREE.Vector2();
    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
  }

  bindUI() {
    this.els.close.addEventListener('click', () => this.onRequestClose?.());
    for (const button of this.root.querySelectorAll('[data-sm-mode]')) {
      button.addEventListener('click', () => this.setMode(button.dataset.smMode));
    }
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
    this.els.inspect.addEventListener('click', () => this.setMode('system'));
    this.els.warp.addEventListener('click', () => {
      if (!this.selectedStar || this.selectedStar.id === this.getUniverse().system.star.id) return;
      if (this.getState() !== 'space') return;
      this.onWarpTarget?.(this.selectedStar);
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
    canvas.addEventListener('pointermove', (event) => this.hoverPick(event));
    canvas.addEventListener('pointerleave', () => {
      if (!this.selectedPlanet) this.root.classList.remove('planet-focus');
    });
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.root.classList.remove('hidden');
    document.body.classList.add('starmap-open');
    this.previewCache.clear();
    this.mode = 'galaxy';
    this.root.classList.add('mode-galaxy');
    this.root.classList.remove('mode-system', 'planet-focus');
    this.selectedStar = this.getUniverse().system.star;
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
    if (mode === 'system' && !this.selectedStar) return;
    this.mode = mode;
    this.root.classList.toggle('mode-galaxy', mode === 'galaxy');
    this.root.classList.toggle('mode-system', mode === 'system');
    if (mode === 'galaxy') this.root.classList.remove('planet-focus');
    this.root.querySelectorAll('[data-sm-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.smMode === mode);
    });
    if (mode === 'galaxy') {
      this.els.caption.textContent = '拖动平移 · 滚轮缩放 · 单击选择';
      this.buildGalaxy();
    } else {
      this.els.caption.textContent = '固定星系视角 · 悬浮天体读取资料 · 单击锁定';
      this.buildSystem();
    }
  }

  resetWorld() {
    disposeObject(this.world);
    this.scene.remove(this.world);
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.pickables = [];
    this.labelData = [];
    this.systemLabelData = [];
    this.els.labelLayer.replaceChildren();
    this.controls.target.set(0, 0, 0);
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

    const nodeGeometry = new THREE.IcosahedronGeometry(0.72, 1);
    const nodeMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.001,
      depthWrite: false,
      fog: false,
      toneMapped: false,
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
      size: 5.5,
      sizeAttenuation: false,
      map: this.starTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.96,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    }));
    starLight.userData = { kind: 'starPoints', stars };
    this.world.add(starLight);
    this.pickables.push(starLight);

    const routePositions = [];
    const routeCount = Math.min(stars.length, NETWORK_LIMIT);
    const used = new Set();
    for (let i = 0; i < routeCount; i++) {
      const nearest = [];
      for (let j = 0; j < routeCount; j++) {
        if (i === j) continue;
        nearest.push({ j, d: this.mapPositions[i].distanceToSquared(this.mapPositions[j]) });
      }
      nearest.sort((a, b) => a.d - b.d);
      for (const target of nearest.slice(0, i === 0 ? 4 : 2)) {
        const key = i < target.j ? `${i}:${target.j}` : `${target.j}:${i}`;
        if (used.has(key)) continue;
        used.add(key);
        routePositions.push(...this.mapPositions[i].toArray(), ...this.mapPositions[target.j].toArray());
      }
    }
    const routeGeometry = new THREE.BufferGeometry();
    routeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(routePositions, 3));
    const routes = new THREE.LineSegments(routeGeometry, new THREE.LineBasicMaterial({
      color: 0x4bd6e4,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.world.add(routes);

    for (const radius of [18, 36, 58, 78]) {
      const ring = lineLoop(radius, radius === 78 ? 0xd4a85f : 0x50c8d8, radius === 78 ? 0.25 : 0.12);
      ring.rotation.x = (radius / 78) * 0.08;
      this.world.add(ring);
    }
    const axisGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-86, 0, 0), new THREE.Vector3(86, 0, 0),
      new THREE.Vector3(0, -38, 0), new THREE.Vector3(0, 38, 0),
      new THREE.Vector3(0, 0, -86), new THREE.Vector3(0, 0, 86),
    ]);
    this.world.add(new THREE.LineSegments(axisGeometry, new THREE.LineBasicMaterial({
      color: 0x5b8b99, transparent: true, opacity: 0.12,
    })));

    this.camera.position.set(0, 118, 0.01);
    this.camera.up.set(0, 0, -1);
    this.controls.minDistance = 28;
    this.controls.maxDistance = 190;
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.els.count.textContent = `${stars.length} / ${STAR_LIMIT}`;
    this.els.sector.textContent = current.id;
    this.els.routeStatus.innerHTML = `<i></i>${stars.length ? '航路网络在线' : '无匹配航路'}`;
    this.buildGalaxyLabels(stars, current);
    this.updateSelectionMarker();
  }

  buildSystem() {
    this.resetWorld();
    const preview = this.systemPreview(this.selectedStar);
    const backdropRng = makeRng(this.getSeed() + ':system-backdrop:' + this.selectedStar.id);
    const backdropPositions = [];
    for (let i = 0; i < 520; i++) {
      backdropPositions.push((backdropRng() - .5) * 190, -2.5, (backdropRng() - .5) * 150);
    }
    const backdropGeometry = new THREE.BufferGeometry();
    backdropGeometry.setAttribute('position', new THREE.Float32BufferAttribute(backdropPositions, 3));
    this.world.add(new THREE.Points(backdropGeometry, new THREE.PointsMaterial({
      size: 1.8,
      sizeAttenuation: false,
      map: this.starTexture,
      color: 0xdce3df,
      transparent: true,
      opacity: .55,
      depthWrite: false,
      toneMapped: false,
    })));
    for (let i = 0; i < 20; i++) {
      const contour = lineLoop(12 + i * 3.25, 0xa5aaa3, 0.045 + (i % 4) * .012, 128);
      contour.scale.z = .72 + Math.sin(i * 1.73) * .08;
      contour.position.x = Math.sin(i * 2.13) * 1.8;
      contour.position.z = Math.cos(i * 1.61) * 1.4;
      this.world.add(contour);
    }
    const timeHours = this.getTime();
    const binaryDirection = preview.stars.length > 1
      ? orbitalPosition(preview.binaryOrbit, timeHours, new THREE.Vector3()).normalize()
      : new THREE.Vector3(1, 0, 0);
    const totalMass = preview.stars.reduce((sum, star) => sum + star.massSolar, 0);
    preview.stars.forEach((star, index) => {
      const color = new THREE.Color(star.color);
      const companionMass = preview.stars.length > 1 ? preview.stars[1 - index].massSolar : 0;
      const offset = preview.stars.length > 1 ? (5.8 * companionMass / totalMass) * (index === 0 ? -1 : 1) : 0;
      const size = 4.8 + Math.min(3.4, star.radiusRender / 3.5e6);
      const sun = new THREE.Mesh(new THREE.SphereGeometry(size, 40, 28), starSurfaceMaterial(color.clone().multiplyScalar(2.3)));
      sun.position.copy(binaryDirection).multiplyScalar(offset);
      sun.userData = { kind: 'sun', star: this.selectedStar, starSurface: true };
      this.world.add(sun); this.pickables.push(sun);
      const glow = new THREE.Mesh(new THREE.SphereGeometry(size * 1.37, 32, 22), starCoronaMaterial(color));
      glow.position.copy(sun.position); this.world.add(glow);
    });

    const primaryMeshes = new Map();
    const primaries = preview.bodies.filter((body) => !body.isMoon);
    const maxOrbit = Math.max(...primaries.map((body) => body.orbit), 1);
    for (const body of primaries) {
      const orbitRadius = 9 + Math.log1p(body.orbit / 4e7) / Math.log1p(maxOrbit / 4e7) * 36;
      const ring = lineLoop(orbitRadius, TYPE_COLORS[body.type] || 0x82dbe6, 0.2, 96);
      this.world.add(ring);
      const size = 0.68 + Math.min(1.15, body.radius / 310_000);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(size, 20, 14),
        new THREE.MeshStandardMaterial({
          color: TYPE_COLORS[body.type] || 0x9fb4bc,
          roughness: 0.78,
          metalness: body.type === 'exotic' ? 0.45 : 0.08,
          emissive: new THREE.Color(TYPE_COLORS[body.type] || 0x223344).multiplyScalar(0.08),
        }),
      );
      const orbitPos = orbitalPosition(body.orbitSpec, timeHours, new THREE.Vector3())
        .multiplyScalar(orbitRadius / body.orbitSpec.renderRadius);
      mesh.position.copy(orbitPos);
      mesh.userData = { kind: 'planet', body, orbitRadius, angle: Math.atan2(orbitPos.z, orbitPos.x), speed: 0 };
      this.world.add(mesh);
      this.pickables.push(mesh);
      primaryMeshes.set(body.index, mesh);
    }
    for (const moon of preview.bodies.filter((body) => body.isMoon)) {
      const parent = primaryMeshes.get(moon.parentSpec);
      if (!parent) continue;
      const moonOrbit = 2.2 + Math.min(2.2, moon.orbit / 1.4e6);
      const pivot = new THREE.Group();
      pivot.position.copy(parent.position);
      pivot.userData = { kind: 'moonPivot', parent, speed: 0 };
      const ring = lineLoop(moonOrbit, 0x8aaeb8, 0.18, 48);
      ring.scale.y = 0.75;
      pivot.add(ring);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.34 + moon.radius / 180_000, 14, 10),
        new THREE.MeshStandardMaterial({ color: TYPE_COLORS[moon.type] || 0x87939a, roughness: 0.9 }),
      );
      const moonPos = orbitalPosition(moon.orbitSpec, timeHours, new THREE.Vector3())
        .multiplyScalar(moonOrbit / moon.orbitSpec.renderRadius);
      mesh.position.copy(moonPos); mesh.position.y += 0.25;
      mesh.userData = { kind: 'moon', body: moon };
      pivot.add(mesh);
      this.world.add(pivot);
      this.pickables.push(mesh);
    }
    this.camera.position.set(0, 82, 0.01);
    this.camera.up.set(0, 0, -1);
    this.controls.minDistance = 18;
    this.controls.maxDistance = 105;
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.systemLabelData = [...primaryMeshes.values()].map((mesh) => ({ object: mesh, body: mesh.userData.body }));
    this.buildSystemLabels();
    if (this.selectedPlanet) this.showPlanet(this.selectedPlanet, true);
  }

  buildGalaxyLabels(stars, current) {
    const candidates = stars
      .map((star, index) => ({ star, index, distance: this.mapPositions[index].lengthSq() }))
      .filter((item) => item.star.id === current.id || item.distance < 38 * 38)
      .sort((a, b) => (a.star.id === current.id ? -1 : b.star.id === current.id ? 1 : b.distance - a.distance));
    // Names are landmarks, not a dump of the nearest records. Choose a
    // spatially distributed subset like Starfield's fixed-view map.
    const ranked = [];
    for (const item of candidates) {
      if (item.star.id !== current.id && ranked.some((picked) =>
        this.mapPositions[picked.index].distanceTo(this.mapPositions[item.index]) < 9)) continue;
      ranked.push(item);
      if (ranked.length >= 10) break;
    }
    this.labelData = ranked.map(({ star, index }) => {
      const button = document.createElement('button');
      button.className = 'sm-map-label sm-star-label';
      button.innerHTML = '<i></i><strong></strong><small></small>';
      button.children[0].style.setProperty('--label-color', `#${star.color.getHexString()}`);
      button.children[1].textContent = this.systemPreview(star).name;
      button.children[2].textContent = star.id === current.id ? '当前位置' : starClass(star).code;
      button.classList.toggle('current', star.id === current.id);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.selectStar(star);
      });
      this.els.labelLayer.appendChild(button);
      return {
        button, position: this.mapPositions[index], star,
        width: Math.min(230, 34 + this.systemPreview(star).name.length * 10),
        height: star.id === current.id ? 43 : 34,
        priority: star.id === current.id ? 100 : 10,
      };
    });
  }

  buildSystemLabels() {
    this.labelData = this.systemLabelData.map(({ object, body }) => {
      const button = document.createElement('button');
      button.className = 'sm-map-label sm-body-label';
      button.innerHTML = '<i></i><strong></strong><small></small>';
      button.children[0].style.setProperty('--label-color', `#${new THREE.Color(TYPE_COLORS[body.type] || 0xb8c0c0).getHexString()}`);
      button.children[1].textContent = body.name;
      button.children[2].textContent = TYPE_LABELS[body.type] || body.type;
      button.addEventListener('pointerenter', () => this.showPlanet(body, false));
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.selectedPlanet = body;
        this.showPlanet(body, true);
      });
      this.els.labelLayer.appendChild(button);
      return {
        button, object, body,
        width: Math.min(210, 34 + body.name.length * 10), height: 32,
        priority: body === this.selectedPlanet ? 90 : body.isMoon ? 5 : 20,
      };
    });
  }

  updateMapLabels() {
    if (!this.labelData?.length) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const point = new THREE.Vector3();
    const projected = [];
    for (const item of this.labelData) {
      if (item.object) item.object.getWorldPosition(point);
      else point.copy(item.position);
      point.project(this.camera);
      const x = (point.x * .5 + .5) * rect.width;
      const y = (-point.y * .5 + .5) * rect.height;
      const visible = point.z > -1 && point.z < 1
        && x > rect.width * 0.13 && y > rect.height * 0.12
        && x + item.width < rect.width * 0.94 && y + item.height < rect.height * 0.88;
      item.button.hidden = !visible;
      if (!visible) continue;
      projected.push({ item, x, y });
    }
    projected.sort((a, b) => (b.item.priority || 0) - (a.item.priority || 0));
    const occupied = [];
    if (this.mode === 'system') {
      const blockers = [this.els.systemPanel];
      if (this.root.classList.contains('planet-focus')) blockers.push(this.els.planetPanel, this.els.resourcePanel);
      for (const blocker of blockers) {
        const bounds = blocker?.getBoundingClientRect();
        if (!bounds || bounds.width < 2 || bounds.height < 2) continue;
        occupied.push({
          left: bounds.left - rect.left - 10,
          top: bounds.top - rect.top - 10,
          right: bounds.right - rect.left + 10,
          bottom: bounds.bottom - rect.top + 10,
        });
      }
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

  showPlanet(body, pinned = false) {
    if (!body) return;
    const profile = planetProfile(body);
    this.root.classList.add('planet-focus');
    this.els.bodyKind.textContent = body.isMoon ? '卫星' : body.type === 'gasGiant' || body.type === 'iceGiant' ? '巨行星' : '行星';
    this.els.bodyName.textContent = body.name;
    if (this.selectedStar) {
      const system = this.systemPreview(this.selectedStar);
      this.els.bodySystem.textContent = `${system.name} / ${body.catalogName}`;
    } else this.els.bodySystem.textContent = '未知星系';
    this.els.bodyType.textContent = TYPE_LABELS[body.type] || body.type;
    this.els.bodyGravity.textContent = `${profile.gravity} G`;
    this.els.bodyTemp.textContent = profile.temp;
    this.els.bodyAtmo.textContent = profile.atmo;
    this.els.bodyFauna.textContent = profile.fauna;
    this.els.bodyFlora.textContent = profile.flora;
    this.els.bodyFeatures.textContent = pinned ? '部分已识别 (1/3)' : '不明 (0/3)';
    this.els.resourceList.replaceChildren();
    for (const resource of profile.resources) {
      const cell = document.createElement('span');
      cell.textContent = resource;
      this.els.resourceList.appendChild(cell);
    }
  }

  hoverPick(event) {
    if (this.mode !== 'system') return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickables, true).find((entry) => entry.object.userData.body);
    if (hit?.object.userData.body) {
      this.hoveredPlanet = hit.object.userData.body;
      this.showPlanet(this.hoveredPlanet, false);
      this.renderer.domElement.style.cursor = 'pointer';
    } else {
      this.hoveredPlanet = null;
      this.renderer.domElement.style.cursor = 'grab';
      if (!this.selectedPlanet) this.root.classList.remove('planet-focus');
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
        color: 0xf0b650,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    marker.name = 'selection-marker';
    marker.position.copy(this.mapPositions[index]);
    marker.rotation.x = Math.PI / 2;
    marker.userData.pulse = true;
    this.world.add(marker);
  }

  selectStar(star, focus = true) {
    this.selectedStar = star;
    this.selectedPlanet = null;
    this.root.classList.remove('planet-focus');
    const preview = this.systemPreview(star);
    const cls = physicalStarClass(preview.stars[0]);
    const distance = star.pos.distanceTo(this.getNav().pos);
    const primaryCount = preview.bodies.filter((body) => !body.isMoon).length;
    const moonCount = preview.bodies.length - primaryCount;
    const isCurrent = star.id === this.getUniverse().system.star.id;
    const canWarp = !isCurrent && this.getState() === 'space';

    this.els.targetCode.textContent = `${preview.catalogId} // ${cls.code}-CLASS`;
    this.els.targetName.textContent = preview.name;
    this.els.starType.textContent = cls.label;
    this.els.distance.textContent = isCurrent ? '当前位置' : distanceText(distance);
    this.els.temperature.textContent = cls.temp;
    this.els.planets.textContent = `${primaryCount} 行星 / ${moonCount} 卫星`;
    this.els.starCore.style.setProperty('--star-color', `#${new THREE.Color(preview.stars[0].color).getHexString()}`);
    this.els.bodyList.replaceChildren();
    for (const body of preview.bodies) {
      const row = document.createElement('button');
      row.className = 'sm-body-row';
      row.innerHTML = `<i></i><span></span><small></small>`;
      row.children[0].style.background = `#${new THREE.Color(TYPE_COLORS[body.type] || 0x9baeb5).getHexString()}`;
      row.children[1].textContent = body.name;
      row.children[2].textContent = `${body.isMoon ? '卫星' : TYPE_LABELS[body.type] || body.type} · ${Math.round(body.radius / 1000)} km`;
      row.addEventListener('click', () => {
        this.selectedPlanet = body;
        this.showPlanet(body, true);
        this.els.bodyList.querySelectorAll('.sm-body-row').forEach((item) => item.classList.toggle('selected', item === row));
        if (this.mode !== 'system') this.setMode('system');
      });
      this.els.bodyList.appendChild(row);
    }
    this.els.inspect.disabled = false;
    this.els.warp.disabled = !canWarp;
    this.els.warpState.textContent = isCurrent ? '当前星系' : this.getState() !== 'space' ? '需返回飞船' : '航路已解算';
    this.updateSelectionMarker();
    if (focus && this.mode === 'galaxy' && this.visibleStars) {
      const index = this.visibleStars.findIndex((item) => item.id === star.id);
      if (index >= 0) this.controls.target.lerp(this.mapPositions[index], 0.75);
    }
  }

  pick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, true);
    if (!hits.length) return;
    const hit = hits[0];
    if (hit.object.userData.kind === 'stars' && hit.instanceId != null) {
      const star = hit.object.userData.stars[hit.instanceId];
      if (star) this.selectStar(star);
      return;
    }
    if (hit.object.userData.kind === 'starPoints' && hit.index != null) {
      const star = hit.object.userData.stars[hit.index];
      if (star) this.selectStar(star);
      return;
    }
    const body = hit.object.userData.body;
    if (body) {
      this.selectedPlanet = body;
      this.showPlanet(body, true);
      const rows = [...this.els.bodyList.querySelectorAll('.sm-body-row')];
      const preview = this.systemPreview(this.selectedStar);
      const index = preview.bodies.indexOf(body);
      rows.forEach((row, rowIndex) => row.classList.toggle('selected', rowIndex === index));
    }
  }

  resize() {
    const width = Math.max(1, this.els.canvas.clientWidth);
    const height = Math.max(1, this.els.canvas.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  animate() {
    if (!this.isOpen) return;
    this.raf = requestAnimationFrame(() => this.animate());
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.controls.update();
    this.updateMapLabels();
    const marker = this.world.getObjectByName('selection-marker');
    if (marker) {
      marker.rotation.z += dt * 0.34;
      marker.scale.setScalar(1 + Math.sin(performance.now() * 0.0025) * 0.08);
    }
    if (this.mode === 'system') {
      for (const object of this.world.children) {
        if (object.userData.kind === 'planet') {
          object.userData.angle += dt * object.userData.speed;
          const angle = object.userData.angle;
          object.position.x = Math.cos(angle) * object.userData.orbitRadius;
          object.position.z = Math.sin(angle) * object.userData.orbitRadius;
          object.rotation.y += dt * 0.35;
        } else if (object.userData.kind === 'moonPivot') {
          object.position.copy(object.userData.parent.position);
          object.rotation.y += dt * object.userData.speed;
        } else if (object.userData.starSurface) {
          object.material.uniforms.uTime.value += dt;
          object.rotation.y += dt * 0.04;
        }
      }
    }
    this.renderer.render(this.scene, this.camera);
  }
}
