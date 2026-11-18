import * as THREE from 'three';
import { WeaponLighting } from './weapon-lighting.js';
import { WEAPON_FOREGROUND_LAYER, SKY_BACKDROP_LAYER } from './render-layers.js';
import { createPac9Viewmodel, PAC9_ADS_FOV, PAC9_VIEW_FOV, PAC9_SPEC } from './saltline/pac9-viewmodel.js';
import { setLensEnvironment } from './saltline/viewmodel-kit.js';
import { createSaltlineMaterials } from './saltline/materials.js';
import {
  KR7_SPEC,
  KR7_VANTAGE_SPEC,
  VESPER9_SPEC,
  M12_SPEC,
  STRIX9_SPEC,
} from './golden-hour/viewmodels.js';

// Triplanar scale per library material, as Saltline dressed the PAC-9.
const VIEWMODEL_MATERIAL_SCALE = { anodized_black: 2, gunmetal: 2, brass: 4, glove_fabric: 3, rubber: 4 };

export function isSoftwareWebGL(renderer) {
  try {
    const gl = renderer?.getContext?.();
    if (!gl) return false;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = `${ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ''} ${gl.getParameter(gl.RENDERER) || ''}`;
    return /swiftshader|llvmpipe|software|basic render/i.test(name);
  } catch {
    return false;
  }
}

// First-person surface arsenal:
//  - Slot 1: PAC-9 LONGSHORE (Saltline 9mm PDW)
//  - Slot 2: KR-7 CARBINE (Golden Hour 5.56 carbine w/ Halo holo & foregrip, Saltline gloved hands)
//  - Slot 3: KR-7 VANTAGE (Golden Hour DMR w/ live 2.5x PiP prism scope & suppressor, Saltline hands)
//  - Slot 4: VESPER 9 (Golden Hour suppressed high-ROF SMG, Saltline hands)
//  - Slot 5: M12 BREACHER (Golden Hour 9-pellet pump-action 12ga shotgun w/ per-shell reload, Saltline hands)
//  - Slot 6: STRIX 9 (Golden Hour striker pistol w/ microdot & carbon camo, Saltline hands)
export const SURFACE_WEAPONS = [
  {
    id: 'PAC9', name: 'PAC-9 LONGSHORE', short: 'PAC-9', kind: 'viewmodel', create: createPac9Viewmodel,
    spec: PAC9_SPEC, viewFov: PAC9_VIEW_FOV, magSize: 30, adsFov: PAC9_ADS_FOV,
    tracerColor: 0xffd38a, tracerRadius: 0.014, tracerLife: 0.06, hasScope: false,
    damage: 26, impulse: 5,
  },
  { ...KR7_SPEC, damage: 31, impulse: 7 },
  { ...KR7_VANTAGE_SPEC, damage: 54, impulse: 8 },
  { ...VESPER9_SPEC, damage: 24, impulse: 4.5 },
  { ...M12_SPEC, isShotgun: true, damage: 19, impulse: 4.5 },
  { ...STRIX9_SPEC, damage: 38, impulse: 5.5 },
];

const axis = new THREE.Vector3(0, 1, 0);
const SWITCH_TIME = 0.36;
const BASE_FOV = 62;
const _tmpZenith = new THREE.Color();
const _tmpHorizon = new THREE.Color();
const _tmpHorizonAway = new THREE.Color();
const _tmpSunCol = new THREE.Color();

export class SurfaceWeapons {
  // onEvent(type, data, def): 'weapon:fire' | 'weapon:reload' {phase} | 'weapon:pump' {phase} | 'weapon:dry'
  constructor(scene, camera, dom, {
    canUse,
    onChange,
    onShot,
    onEvent,
    onGrenade = null,
    shotResolver = null,
    renderer = null,
  }) {
    this.scene = scene;
    this.camera = camera;
    this.canUse = canUse;
    this.onChange = onChange;
    this.onShot = onShot;
    this.onEvent = onEvent;
    this.onGrenade = onGrenade;
    this.shotResolver = shotResolver;
    this.index = 0;
    this.trigger = false;
    this.justPressed = false;
    this.ads = false;
    this.pendingIndex = -1;
    this.switchT = 0;
    this.recoilP = 0;
    this.recoilY = 0;
    this.beamDistance = 120;
    this.reloadT = 0;
    this.reloadDuration = 0;
    this.wetness = 0;
    this.wasActive = false;
    this.manualHolster = false;
    this.tracers = [];
    this.casings = [];
    this.lookDelta = { dx: 0, dy: 0 };
    this._eye = new THREE.Vector3();
    this.tracerGlowGeometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1);
    this.tracerCoreGeometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
    this.casingGeometry = new THREE.CylinderGeometry(0.0048, 0.0048, 0.045, 10);
    this.casingMaterial = new THREE.MeshStandardMaterial({ color: 0xb68636, metalness: 0.92, roughness: 0.22 });
    this.shotgunShellGeometry = new THREE.CylinderGeometry(0.0098, 0.0098, 0.062, 10);
    this.shotgunShellMaterial = new THREE.MeshStandardMaterial({ color: 0xbf2c22, metalness: 0.18, roughness: 0.52 });

    // Scope picture: 4.2-degree magnification with this game's astronomical
    // far plane so the 400 km sky dome is not clipped to black.
    this.scopeCamera = new THREE.PerspectiveCamera(4.2, 1, 0.01, camera.far);
    this.scopeCamera.layers.enable(SKY_BACKDROP_LAYER);
    this._skyDomeMesh = null;
    this.scopeTarget = new THREE.WebGLRenderTarget(512, 512, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
    this.scopeTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;

    this.rig = new THREE.Group();
    this.rig.layers.set(WEAPON_FOREGROUND_LAYER);
    this.lighting = new WeaponLighting(scene, camera);
    this.rig.renderOrder = 1000;
    this.viewCamera = new THREE.PerspectiveCamera(SURFACE_WEAPONS[0].viewFov, camera.aspect, 0.01, 50);
    this.viewCamera.name = 'weapon-view-camera';
    camera.add(this.viewCamera);

    this.materials = null;
    if (renderer) {
      const texSize = isSoftwareWebGL(renderer) ? 256 : 1024;
      try { this.materials = createSaltlineMaterials({ renderer, params: { tex: texSize, wet: 0 } }); }
      catch (error) { console.warn('[weapons] material library unavailable', error); }
    }

    // Build slot 0 immediately (preserving cold-boot timing) and build slots
    // 1..N lazily on first selection.
    this.models = SURFACE_WEAPONS.map((def, i) => (i === 0 ? this.createViewmodel(def) : null));
    if (this.materials) {
      const st = this.materials.stats();
      console.info(`[weapons] Saltline materials: ${st.sets} texture sets baked in ${st.genMs} ms (${st.textureMB} MB)`);
    }
    this.models[0].group.visible = true;
    this.lighting.register(this.rig);
    camera.add(this.rig);

    this.onMouseDown = (event) => {
      if (!this.canUse()) return;
      if (event.button === 0) {
        this.trigger = true;
        this.justPressed = true;
      }
      if (event.button === 2) this.ads = true;
    };
    this.onMouseUp = (event) => {
      if (event.button === 0) this.trigger = false;
      if (event.button === 2) this.ads = false;
    };
    this.onWheel = (event) => {
      if (!this.canUse() || Math.abs(event.deltaY) < 4) return;
      const step = event.deltaY > 0 ? 1 : -1;
      const base = this.pendingIndex >= 0 ? this.pendingIndex : this.index;
      const next = (base + step + SURFACE_WEAPONS.length) % SURFACE_WEAPONS.length;
      this.select(next);
    };
    this.onPointerLockChange = () => {
      if (!document.pointerLockElement) this.releaseInput();
    };
    this.onBlur = () => this.releaseInput();
    this.onKey = (event) => {
      if (!this.canUse() || event.repeat) return;
      const slot = Number(event.key) - 1;
      if (slot >= 0 && slot < SURFACE_WEAPONS.length) {
        event.preventDefault();
        this.select(slot);
      }
      if (event.code === 'KeyG') {
        event.preventDefault();
        this.toggleHolster();
      }
      if (event.code === 'KeyR') {
        event.preventDefault();
        this.reload();
      }
      if (event.code === 'KeyQ') {
        event.preventDefault();
        this.onGrenade?.();
      }
    };
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp, true);
    window.addEventListener('wheel', this.onWheel, { passive: true });
    window.addEventListener('keydown', this.onKey);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    window.addEventListener('blur', this.onBlur);
    this.onContextMenu = (event) => { if (this.canUse()) event.preventDefault(); };
    window.addEventListener('contextmenu', this.onContextMenu);
    this.syncHud();
  }

  ensureModel(index) {
    if (index < 0 || index >= SURFACE_WEAPONS.length) return this.models[0];
    if (!this.models[index]) {
      const built = this.createViewmodel(SURFACE_WEAPONS[index]);
      built.viewmodel.setWetness(this.wetness);
      this.lighting.register(built.group);
      this.models[index] = built;
    }
    return this.models[index];
  }

  releaseInput() {
    this.trigger = false;
    this.justPressed = false;
    this.ads = false;
  }

  createViewmodel(def) {
    const shotPoint = new THREE.Vector3();
    const viewmodel = def.create({
      camera: this.camera,
      viewCamera: this.viewCamera,
      material: (name) => this.materials?.get(name, { triplanar: true, vertexColors: true, scale: VIEWMODEL_MATERIAL_SCALE[name] || 1 }) || null,
      emit: (type, data) => {
        if (type === 'weapon:fire') this.onShot?.(def);
        this.onEvent?.(type, data, def);
      },
      shot: (eye, dir) => {
        if (this.shotResolver) {
          const hit = this.shotResolver(eye, dir, def);
          if (hit) return hit;
        }
        return shotPoint.copy(eye).addScaledVector(dir, THREE.MathUtils.clamp(this.beamDistance, 1.5, 120));
      },
      tracer: (from, to) => this.addTracerSegment(def, from, to),
      shell: () => this.ejectCasing(def),
      recoil: (pitch, yaw) => {
        this.recoilP = Math.min(0.14, this.recoilP + pitch);
        this.recoilY = THREE.MathUtils.clamp(this.recoilY + yaw, -0.05, 0.05);
      },
    });
    const group = viewmodel.root;
    group.visible = false;
    group.traverse((child) => child.layers.set(WEAPON_FOREGROUND_LAYER));
    this.rig.add(group);

    const opticGlass = viewmodel.opticGlass || null;
    if (def.hasScope && opticGlass?.material) {
      opticGlass.material.map = this.scopeTarget.texture;
      if (opticGlass.material.uniforms?.tScope) {
        opticGlass.material.uniforms.tScope.value = this.scopeTarget.texture;
      }
    }

    return {
      group,
      viewmodel,
      ammo: viewmodel.ammo,
      eject: new THREE.Vector3().fromArray(def.spec?.eject || def.eject || [0.02, 0.01, -0.04]),
      magazine: viewmodel.magazine,
      hasScope: !!def.hasScope,
      opticGlass,
      objective: viewmodel.objective || viewmodel.objectiveOffset || null,
    };
  }

  select(index) {
    if (index < 0 || index >= SURFACE_WEAPONS.length) return;
    if (index === this.index || index === this.pendingIndex) return;
    this.ensureModel(index);
    this.cancelReload();
    this.pendingIndex = index;
    this.switchT = SWITCH_TIME;
    this.ads = false;
  }

  syncHud() {
    const def = SURFACE_WEAPONS[this.index];
    const current = this.ensureModel(this.index);
    const vm = current?.viewmodel;
    const holstered = Boolean(vm && (vm.isHolstered() || vm.isHolstering()));
    this.onChange?.({
      index: this.index,
      weapon: def,
      ammo: current.ammo,
      reloading: this.reloadT > 0,
      holstered,
    });
  }

  reload() {
    const current = this.ensureModel(this.index);
    if (this.switchT > 0 || !current.viewmodel.reloadNow()) return false;
    this.syncViewmodelState(current);
    return true;
  }

  syncViewmodelState(current) {
    const vm = current.viewmodel;
    const reloading = vm.isReloading();
    const holstered = vm.isHolstered() || vm.isHolstering();
    const duration = vm.reloadDuration();
    const remaining = reloading ? duration * (1 - vm.reloadProgress()) : 0;
    const changed = current.ammo !== vm.ammo
      || (this.reloadT > 0) !== reloading
      || current.holstered !== holstered;
    current.ammo = vm.ammo;
    current.holstered = holstered;
    this.reloadDuration = duration;
    this.reloadT = remaining;
    if (changed) this.syncHud();
  }

  cancelReload() {
    const current = this.models[this.index];
    if (!current) return;
    current.viewmodel.cancelReload();
    this.syncViewmodelState(current);
  }

  get lookScale() {
    if (!this.ads) return 1;
    return SURFACE_WEAPONS[this.index]?.hasScope ? 0.36 : 0.68;
  }

  onLookDelta(movementX, movementY) {
    if (!this.canUse()) return;
    const turn = 0.0024 * this.lookScale;
    this.lookDelta.dx += movementX * turn;
    this.lookDelta.dy += movementY * turn;
  }

  ejectCasing(def = SURFACE_WEAPONS[this.index]) {
    const model = this.ensureModel(this.index);
    const position = this.camera.worldToLocal(model.group.localToWorld(model.eject.clone()));
    const isShotgun = Boolean(def?.isShotgun);
    const casing = new THREE.Mesh(
      isShotgun ? this.shotgunShellGeometry : this.casingGeometry,
      isShotgun ? this.shotgunShellMaterial : this.casingMaterial,
    );
    casing.layers.set(WEAPON_FOREGROUND_LAYER);
    this.lighting.register(casing);
    casing.position.copy(position);
    casing.rotation.set(Math.random(), Math.random(), Math.PI / 2);
    this.camera.add(casing);
    this.casings.push({
      mesh: casing,
      velocity: new THREE.Vector3(1.3 + Math.random() * 0.6, 0.9 + Math.random() * 0.5, (Math.random() - 0.5) * 0.3),
      spin: new THREE.Vector3(8 + Math.random() * 7, 4 + Math.random() * 6, 8),
      life: 1.4,
    });
  }

  addTracerSegment(def, from, to) {
    const direction = new THREE.Vector3().subVectors(to, from);
    const pathLength = THREE.MathUtils.clamp(direction.length(), 1.5, 180);
    direction.normalize();
    const streakLength = Math.min(pathLength, 1.35);
    const velocity = direction.clone().multiplyScalar(Math.max(0, pathLength - streakLength) / def.tracerLife);
    const streakCenter = from.clone().addScaledVector(direction, streakLength * 0.5);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(axis, direction);
    for (const [radius, color, opacity, geometry] of [
      [def.tracerRadius * 1.6, def.tracerColor, 0.2, this.tracerGlowGeometry],
      [def.tracerRadius * 0.35, 0xffffff, 0.82, this.tracerCoreGeometry],
    ]) {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }));
      mesh.position.copy(streakCenter);
      mesh.scale.set(radius, streakLength, radius);
      mesh.quaternion.copy(quaternion);
      this.scene.add(mesh);
      this.tracers.push({ mesh, life: def.tracerLife, max: def.tracerLife, velocity: velocity.clone(), baseOpacity: opacity });
    }
  }

  setWetness(level, dt = 1 / 60) {
    const target = THREE.MathUtils.clamp(level || 0, 0, 1);
    this.wetness = THREE.MathUtils.lerp(this.wetness, target, Math.min(1, dt * (target > this.wetness ? 0.8 : 0.15)));
    for (const model of this.models) {
      if (model) model.viewmodel.setWetness(this.wetness);
    }
    if (this.materials) this.materials.uniforms.wet.value = this.wetness;
  }

  updateLighting(radiance, environment = {}, worldUp = null) {
    this.lighting.update(radiance, environment, this.rig.visible, worldUp, { deferEnvironment: true });
    // L-7: keep optic lens reflections synced with real-time planetary sun & sky
    const primary = radiance?.sources?.[0];
    const day = Number.isFinite(environment.day) ? environment.day : 0.85;
    const atmo = Number.isFinite(environment.atmosphere) ? environment.atmosphere : 1;
    const sky = environment.skyColor || environment.zenithColor || null;
    if (sky?.isColor) {
      _tmpZenith.copy(sky).multiplyScalar(0.32 * day * atmo + 0.02);
      _tmpHorizon.copy(sky).lerp(_tmpSunCol.setRGB(1.0, 0.68, 0.42), 0.35 * (1 - day * 0.5)).multiplyScalar(0.62 * day * atmo + 0.04);
      _tmpHorizonAway.copy(sky).multiplyScalar(0.24 * day * atmo + 0.02);
    } else {
      _tmpZenith.setRGB(0.055 * day + 0.01, 0.095 * day + 0.012, 0.16 * day + 0.02).multiplyScalar(atmo + 0.05);
      _tmpHorizon.setRGB(0.45 * day + 0.03, 0.42 * day + 0.03, 0.46 * day + 0.04).multiplyScalar(atmo + 0.05);
      _tmpHorizonAway.setRGB(0.14 * day + 0.01, 0.18 * day + 0.015, 0.25 * day + 0.02).multiplyScalar(atmo + 0.05);
    }
    if (primary?.color?.isColor) _tmpSunCol.copy(primary.color);
    else _tmpSunCol.setRGB(1, 0.88, 0.72);
    setLensEnvironment({
      sunDir: primary?.direction || null,
      sunColor: _tmpSunCol,
      skyZenith: _tmpZenith,
      skyHorizon: _tmpHorizon,
      skyHorizonAway: _tmpHorizonAway,
      worldUp,
    });
  }

  prepareLighting() {
    this.lighting.prepareEnvironment();
  }

  toggleHolster() {
    const current = this.ensureModel(this.index);
    const vm = current.viewmodel;
    let ok = false;
    if (vm.isHolstered() || vm.isHolstering()) {
      this.manualHolster = false;
      ok = vm.draw();
    } else {
      this.manualHolster = true;
      this.releaseInput();
      ok = vm.holster();
    }
    this.syncViewmodelState(current);
    return ok;
  }

  update(dt, active, beamDistance = 120, motion = {}) {
    let current = this.ensureModel(this.index);
    let vm = current.viewmodel;
    if (motion.paused) {
      this.releaseInput();
      this.lookDelta.dx = 0;
      this.lookDelta.dy = 0;
      return;
    }
    if (active !== this.wasActive) {
      this.wasActive = active;
      if (active) { this.manualHolster = false; vm.draw(); } else vm.holster();
    }
    if (active && this.trigger && this.manualHolster && vm.isHolstered()) {
      this.trigger = false;
      this.toggleHolster();
    }
    // Keep rig visible during an active weapon switch even while the outgoing/incoming gun transitions
    const shown = active ? (!vm.isHolstered() || this.switchT > 0) : vm.isHolstering();
    this.rig.visible = shown;
    this.lighting.root.visible = shown;
    if (!active) this.releaseInput();
    if (!shown) {
      this.releaseInput();
      this.lookDelta.dx = 0;
      this.lookDelta.dy = 0;
      this.updateTransientEffects(dt);
      return;
    }
    this.beamDistance = beamDistance;
    if (this.switchT > 0) {
      this.switchT -= dt;
      if (this.pendingIndex >= 0 && this.switchT <= SWITCH_TIME * 0.5) {
        current.group.visible = false;
        current.viewmodel.reset();
        this.index = this.pendingIndex;
        this.pendingIndex = -1;
        current = this.ensureModel(this.index);
        current.group.visible = true;
        current.viewmodel.reset();
        if (active && !this.manualHolster) current.viewmodel.draw();
        this.syncHud();
      }
      if (this.switchT <= 0) this.switchT = 0;
    }
    const def = SURFACE_WEAPONS[this.index];
    current = this.ensureModel(this.index);
    vm = current.viewmodel;
    const speed = Number.isFinite(motion.speed) ? motion.speed : 0;
    const gait = speed <= 7 ? speed * (4 / 7) : 4 + (speed - 7) * (2.5 / 11);
    this.camera.getWorldPosition(this._eye);
    const fireNow = active && (this.trigger || this.justPressed) && this.switchT <= 0;
    if (fireNow || !active || this.switchT > 0) this.justPressed = false;
    vm.update(dt, {
      fire: fireNow,
      ads: active && this.ads && this.switchT <= 0,
      reload: false,
      move: motion.move || null,
      look: this.lookDelta,
      speed: gait,
      onGround: motion.grounded !== false,
      velY: Number.isFinite(motion.velY) ? motion.velY : 0,
      sprinting: !!motion.sprinting,
      crouching: !!motion.crouching,
      eye: this._eye,
    });
    this.lookDelta.dx = 0;
    this.lookDelta.dy = 0;
    this.syncViewmodelState(current);
    if (vm.isHolstered() && this.switchT <= 0) {
      this.rig.visible = false;
      this.lighting.root.visible = false;
    }

    const dip = this.switchT > 0 ? Math.sin(Math.PI * (1 - this.switchT / SWITCH_TIME)) : 0;
    this.rig.position.set(0, this.switchT > 0 ? -0.18 * dip : 0, 0);
    this.rig.rotation.set(this.switchT > 0 ? -0.35 * dip : 0, 0, 0);

    if (this.viewCamera.fov !== def.viewFov || this.viewCamera.aspect !== this.camera.aspect) {
      this.viewCamera.fov = def.viewFov;
      this.viewCamera.aspect = this.camera.aspect;
      this.viewCamera.updateProjectionMatrix();
    }
    this.recoilP *= Math.pow(0.001, dt);
    this.recoilY *= Math.pow(0.001, dt);
    const cameraRecoil = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.recoilP, this.recoilY, 0, 'XYZ'));
    this.camera.quaternion.multiply(cameraRecoil);
    if (active) {
      const targetFov = THREE.MathUtils.lerp(BASE_FOV, def.adsFov, vm.ads);
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, Math.min(1, dt * 20));
      this.camera.updateProjectionMatrix();
    }
    this.updateTransientEffects(dt);
  }

  updateTransientEffects(dt) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tracer = this.tracers[i];
      tracer.life -= dt;
      tracer.mesh.position.addScaledVector(tracer.velocity, dt);
      tracer.mesh.material.opacity = tracer.baseOpacity * Math.max(0, tracer.life / tracer.max);
      if (tracer.life <= 0) {
        this.scene.remove(tracer.mesh);
        tracer.mesh.material.dispose();
        this.tracers.splice(i, 1);
      }
    }
    for (let i = this.casings.length - 1; i >= 0; i--) {
      const casing = this.casings[i];
      casing.life -= dt;
      casing.velocity.y -= 9.81 * dt;
      casing.mesh.position.addScaledVector(casing.velocity, dt);
      casing.mesh.rotation.x += casing.spin.x * dt;
      casing.mesh.rotation.y += casing.spin.y * dt;
      casing.mesh.rotation.z += casing.spin.z * dt;
      if (casing.life <= 0) {
        this.camera.remove(casing.mesh);
        this.casings.splice(i, 1);
      }
    }
  }

  renderScopeView(renderer) {
    const model = this.models[this.index];
    const lens = model?.opticGlass;
    if (!this.rig.visible || !model?.hasScope || !lens?.isMesh
      || lens.material?.map !== this.scopeTarget.texture) return;

    const objectivePosition = model.objective?.isObject3D
      ? model.objective.getWorldPosition(new THREE.Vector3())
      : model.group.localToWorld((model.objective || new THREE.Vector3(0, 0.315, -0.517)).clone());
    this.scopeCamera.position.copy(objectivePosition);
    this.scopeCamera.quaternion.copy(this.camera.getWorldQuaternion(new THREE.Quaternion()));
    this.scopeCamera.fov = SURFACE_WEAPONS[this.index]?.scopeFov || 4.2;
    this.scopeCamera.aspect = 1;
    this.scopeCamera.far = Math.max(this.camera.far, 1e6);
    this.scopeCamera.updateProjectionMatrix();
    this.scopeCamera.updateMatrixWorld(true);

    if (!this._skyDomeMesh) {
      this._skyDomeMesh = this.scene.children.find(
        (o) => o?.isMesh && o.renderOrder === -7 && o.material?.uniforms?.uAlpha,
      ) || null;
    }
    const skyMat = this._skyDomeMesh?.visible ? this._skyDomeMesh.material : null;
    const skyAlphaUni = skyMat?.uniforms?.uAlpha || null;
    const prevSkyAlpha = skyAlphaUni ? skyAlphaUni.value : 0;
    const prevSkyDepthTest = skyMat ? skyMat.depthTest : false;

    const rigWasVisible = this.rig.visible;
    const lensWasVisible = lens.visible;
    const previousAutoClear = renderer.autoClear;
    const previousTarget = renderer.getRenderTarget();
    const previousFace = renderer.getActiveCubeFace(), previousMip = renderer.getActiveMipmapLevel();
    let failed = false;
    try {
      lens.visible = false;
      this.rig.visible = false;
      renderer.setRenderTarget(this.scopeTarget);
      renderer.autoClear = false;
      renderer.clear();
      // Pass 1: render planetary terrain, props, outposts, and robots (writes log depth)
      this.scopeCamera.layers.set(0);
      renderer.render(this.scene, this.scopeCamera);
      // Pass 2: render 400 km SkyDome where no closer terrain/object wrote depth
      if (skyMat && skyAlphaUni) {
        skyMat.depthTest = true;
        skyAlphaUni.value = Math.min(1, prevSkyAlpha * 2.2);
        this.scopeCamera.layers.set(SKY_BACKDROP_LAYER);
        renderer.render(this.scene, this.scopeCamera);
      }
    } catch (error) {
      failed = true; throw error;
    } finally {
      if (skyMat) skyMat.depthTest = prevSkyDepthTest;
      if (skyAlphaUni) skyAlphaUni.value = prevSkyAlpha;
      renderer.autoClear = previousAutoClear;
      this.rig.visible = rigWasVisible;
      lens.visible = lensWasVisible;
      try { renderer.setRenderTarget(previousTarget, previousFace, previousMip); }
      catch (error) { if (!failed) throw error; }
    }
  }

  dispose() {
    this.lighting.dispose();
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp, true);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKey);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('contextmenu', this.onContextMenu);
    this.scopeTarget.dispose();
    this.tracerGlowGeometry.dispose();
    this.tracerCoreGeometry.dispose();
    this.casingGeometry.dispose();
    this.casingMaterial.dispose();
    this.shotgunShellGeometry.dispose();
    this.shotgunShellMaterial.dispose();
    this.materials?.dispose();
  }
}
