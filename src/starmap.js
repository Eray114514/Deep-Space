import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeRng } from './rng.js';
import { systemName, planetName, moonName } from './names.js';
import { TYPES } from './planet.js';

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
};

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

function previewSystem(seed, star, currentSystem) {
  if (currentSystem && currentSystem.star.id === star.id) {
    return {
      name: currentSystem.name,
      star,
      bodies: currentSystem._specs.map((spec, index) => ({
        ...spec,
        index,
        radius: spec.isMoon
          ? 28_000 + makeRng(spec.seed)() * 72_000
          : 160_000 + makeRng(spec.seed)() * 240_000,
        orbit: spec.pos.distanceTo(star.pos),
      })),
    };
  }

  const rand = makeRng(seed + ':sys:' + star.id);
  const name = systemName(rand);
  const isHome = star.id === '0,0,0';
  const count = (isHome ? 6 : 5) + ((rand() * 4) | 0);
  const weights = {};
  for (const key of Object.keys(TYPES)) weights[key] = TYPES[key].weight;
  const pickType = () => {
    let total = 0;
    for (const key in weights) total += weights[key];
    let value = rand() * total;
    for (const key in weights) {
      value -= weights[key];
      if (value <= 0) {
        weights[key] *= 0.3;
        return key;
      }
    }
    return 'lush';
  };

  const bodies = [];
  for (let i = 0; i < count; i++) {
    const orbit = Math.min(6e7 * Math.pow(1.68, i) * (0.85 + rand() * 0.3), 1.6e9);
    const angle = rand() * Math.PI * 2;
    const incline = (rand() - 0.5) * 0.35;
    const pos = new THREE.Vector3(
      Math.cos(angle) * orbit,
      Math.sin(incline) * orbit * 0.5,
      Math.sin(angle) * orbit,
    ).add(star.pos);
    const type = i === 0 && isHome ? 'lush' : pickType();
    const namePlanet = planetName(rand, name, i);
    const bodySeed = seed + ':p:' + star.id + ':' + i;
    const parentIndex = bodies.length;
    bodies.push({
      seed: bodySeed,
      name: namePlanet,
      pos,
      type,
      isMoon: false,
      orbitIndex: i,
      parentSpec: -1,
      index: parentIndex,
      orbit,
      radius: 160_000 + makeRng(bodySeed)() * 240_000,
    });

    const parentR = 160_000 + makeRng(bodySeed)() * 240_000;
    if (rand() < 0.28 && parentR > 230_000) {
      const moonAngle = rand() * Math.PI * 2;
      const moonY = (rand() - 0.5) * 0.5;
      const moonOrbit = parentR * (4.2 + rand() * 3.2);
      const moonPos = new THREE.Vector3(
        Math.cos(moonAngle),
        moonY,
        Math.sin(moonAngle),
      ).normalize().multiplyScalar(moonOrbit).add(pos);
      const moonType = pickType();
      const moonSeed = seed + ':m:' + star.id + ':' + i;
      bodies.push({
        seed: moonSeed,
        name: moonName(rand, namePlanet),
        pos: moonPos,
        type: moonType,
        isMoon: true,
        orbitIndex: i,
        parentSpec: parentIndex,
        index: bodies.length,
        orbit: moonOrbit,
        radius: 28_000 + makeRng(moonSeed)() * 72_000,
      });
    }
  }
  return { name, star, bodies };
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
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.18, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.48, 'rgba(255,255,255,.42)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class StarMap {
  constructor({ getUniverse, getNav, getSeed, getState, onRequestClose, onWarpTarget }) {
    this.getUniverse = getUniverse;
    this.getNav = getNav;
    this.getSeed = getSeed;
    this.getState = getState;
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
      <div class="sm-scanlines"></div>
      <header class="sm-header">
        <div class="sm-title">
          <span class="sm-kicker">ASTROMETRICS / NAVIGATION ARRAY</span>
          <h1>银河星图</h1>
        </div>
        <nav class="sm-tabs" aria-label="星图视图">
          <button class="active" data-sm-mode="galaxy">恒星网络</button>
          <button data-sm-mode="system">行星体系</button>
        </nav>
        <div class="sm-header-status">
          <span>航路同步</span><strong id="sm-sync">100%</strong>
          <button id="sm-close" aria-label="关闭星图">关闭 <kbd>M</kbd></button>
        </div>
      </header>
      <div class="sm-layout">
        <aside class="sm-sidebar sm-left">
          <div class="sm-section-label">星域筛选</div>
          <div class="sm-filter-grid">
            <button class="active" data-sm-filter="all"><i></i>全部航路</button>
            <button data-sm-filter="habitable"><i></i>宜居候选</button>
            <button data-sm-filter="anomaly"><i></i>资源异常</button>
            <button data-sm-filter="frontier"><i></i>远征边界</button>
          </div>
          <label class="sm-search">
            <span>搜索星系</span>
            <input id="sm-search" type="search" maxlength="32" autocomplete="off" placeholder="输入星系名称…" />
          </label>
          <div class="sm-sector">
            <div><span>当前星区</span><strong id="sm-sector">—</strong></div>
            <div><span>显示节点</span><strong id="sm-count">—</strong></div>
            <div><span>导航层级</span><strong>本地星群</strong></div>
          </div>
          <div class="sm-legend">
            <div class="sm-section-label">恒星分类</div>
            <span><i class="sm-dot sm-a"></i>A / F 蓝白星</span>
            <span><i class="sm-dot sm-g"></i>G 黄矮星</span>
            <span><i class="sm-dot sm-k"></i>K 橙矮星</span>
            <span><i class="sm-dot sm-m"></i>M 红矮星</span>
          </div>
        </aside>
        <main class="sm-viewport">
          <div id="sm-canvas"></div>
          <div class="sm-reticle" aria-hidden="true"></div>
          <div class="sm-axis"><span>Y+</span><span>X / Z 平面</span></div>
          <div id="sm-view-caption">拖动旋转 · 滚轮缩放 · 单击选择</div>
        </main>
        <aside class="sm-sidebar sm-right">
          <div class="sm-section-label">目标分析</div>
          <div class="sm-object-title">
            <span id="sm-target-code">NO TARGET</span>
            <h2 id="sm-target-name">选择一个恒星系</h2>
          </div>
          <div class="sm-star-orb"><div id="sm-star-core"></div></div>
          <dl class="sm-data-grid">
            <div><dt>恒星类型</dt><dd id="sm-star-type">—</dd></div>
            <div><dt>航行距离</dt><dd id="sm-distance">—</dd></div>
            <div><dt>表面温度</dt><dd id="sm-temperature">—</dd></div>
            <div><dt>天体数量</dt><dd id="sm-planets">—</dd></div>
          </dl>
          <div class="sm-section-label sm-body-heading">行星测绘</div>
          <div id="sm-body-list" class="sm-body-list">
            <div class="sm-empty">选择恒星以解算行星轨道</div>
          </div>
          <div class="sm-actions">
            <button id="sm-inspect" disabled>展开行星体系</button>
            <button id="sm-warp" class="sm-primary" disabled>
              <span>设为跃迁目标</span><small id="sm-warp-state">等待目标</small>
            </button>
          </div>
        </aside>
      </div>
      <footer class="sm-footer">
        <div><kbd>拖动</kbd> 旋转视角 <kbd>滚轮</kbd> 缩放 <kbd>单击</kbd> 选择</div>
        <div id="sm-route-status"><i></i>航路网络在线</div>
        <div><kbd>Tab / M</kbd> 返回飞行</div>
      </footer>`;
    document.body.appendChild(root);
    this.root = root;
    const $ = (selector) => root.querySelector(selector);
    this.els = {
      canvas: $('#sm-canvas'),
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
    };
  }

  buildRenderer() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x01060b);
    this.scene.fog = new THREE.FogExp2(0x01060b, 0.0052);
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 500);
    this.camera.position.set(0, 58, 112);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.35;
    this.els.canvas.appendChild(this.renderer.domElement);
    this.starTexture = makePointTexture();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.62;
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
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.root.classList.remove('hidden');
    document.body.classList.add('starmap-open');
    this.previewCache.clear();
    this.mode = 'galaxy';
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
    this.root.querySelectorAll('[data-sm-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.smMode === mode);
    });
    if (mode === 'galaxy') {
      this.els.caption.textContent = '拖动旋转 · 滚轮缩放 · 单击选择';
      this.buildGalaxy();
    } else {
      this.els.caption.textContent = '行星轨道为对数比例 · 单击天体读取资料';
      this.buildSystem();
    }
  }

  resetWorld() {
    disposeObject(this.world);
    this.scene.remove(this.world);
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.pickables = [];
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
    this.mapPositions = stars.map((star) => star.pos.clone().sub(current.pos).multiplyScalar(scale));

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
      size: 10,
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

    this.camera.position.set(0, 58, 112);
    this.controls.minDistance = 28;
    this.controls.maxDistance = 210;
    this.controls.update();
    this.els.count.textContent = `${stars.length} / ${STAR_LIMIT}`;
    this.els.sector.textContent = current.id;
    this.els.routeStatus.innerHTML = `<i></i>${stars.length ? '航路网络在线' : '无匹配航路'}`;
    this.updateSelectionMarker();
  }

  buildSystem() {
    this.resetWorld();
    const preview = this.systemPreview(this.selectedStar);
    const starColor = this.selectedStar.color.clone().multiplyScalar(2.3);
    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 32, 20),
      new THREE.MeshBasicMaterial({ color: starColor }),
    );
    sun.userData = { kind: 'sun', star: this.selectedStar };
    this.world.add(sun);
    this.pickables.push(sun);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(4.25, 24, 16),
      new THREE.MeshBasicMaterial({
        color: this.selectedStar.color,
        transparent: true,
        opacity: 0.15,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.world.add(glow);

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
      const angle = (body.orbitIndex * 2.399963 + body.radius * 0.00001) % (Math.PI * 2);
      mesh.position.set(Math.cos(angle) * orbitRadius, Math.sin(angle * 1.7) * 1.2, Math.sin(angle) * orbitRadius);
      mesh.userData = { kind: 'planet', body, orbitRadius, angle, speed: 0.018 / Math.sqrt(body.orbitIndex + 1) };
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
      pivot.userData = { kind: 'moonPivot', parent, speed: 0.16 + moon.index * 0.006 };
      const ring = lineLoop(moonOrbit, 0x8aaeb8, 0.18, 48);
      ring.scale.y = 0.75;
      pivot.add(ring);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.34 + moon.radius / 180_000, 14, 10),
        new THREE.MeshStandardMaterial({ color: TYPE_COLORS[moon.type] || 0x87939a, roughness: 0.9 }),
      );
      mesh.position.set(moonOrbit, 0.25, 0);
      mesh.userData = { kind: 'moon', body: moon };
      pivot.add(mesh);
      this.world.add(pivot);
      this.pickables.push(mesh);
    }
    this.camera.position.set(0, 48, 66);
    this.controls.minDistance = 18;
    this.controls.maxDistance = 105;
    this.controls.update();
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
    const preview = this.systemPreview(star);
    const cls = starClass(star);
    const distance = star.pos.distanceTo(this.getNav().pos);
    const primaryCount = preview.bodies.filter((body) => !body.isMoon).length;
    const moonCount = preview.bodies.length - primaryCount;
    const isCurrent = star.id === this.getUniverse().system.star.id;
    const canWarp = !isCurrent && this.getState() === 'space';

    this.els.targetCode.textContent = `${cls.code}-CLASS // ${star.id}`;
    this.els.targetName.textContent = preview.name;
    this.els.starType.textContent = cls.label;
    this.els.distance.textContent = isCurrent ? '当前位置' : distanceText(distance);
    this.els.temperature.textContent = cls.temp;
    this.els.planets.textContent = `${primaryCount} 行星 / ${moonCount} 卫星`;
    this.els.starCore.style.setProperty('--star-color', `#${star.color.getHexString()}`);
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
        }
      }
    }
    this.renderer.render(this.scene, this.camera);
  }
}
