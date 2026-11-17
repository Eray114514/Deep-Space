import * as THREE from 'three';
import { WeaponLighting } from './weapon-lighting.js';
import { WEAPON_FOREGROUND_LAYER } from './render-layers.js';
import { createPac9Viewmodel, PAC9_ADS_FOV, PAC9_VIEW_FOV, PAC9_SPEC } from './saltline/pac9-viewmodel.js';
import { createSaltlineMaterials } from './saltline/materials.js';

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

// First-person surface weapons. Every entry is a full viewmodel (geometry,
// gloved hands, keyframed reload, spring recoil) driven by its own controller;
// the PAC-9 Longshore is ported from Saltline (src/saltline/). The old
// primitive-built KX-9 / CX-5 / M77 / HLX-3 were removed on 2026-11-16 — new
// weapons should meet the PAC-9 bar (see docs/saltline-reuse.md).
//
// A definition may set `hasScope` and its model `opticGlass`/`objective` to
// get a magnified scope picture through renderScopeView (no current weapon
// uses it; the auxiliary-render contract is kept and tested for a scoped
// variant).
export const SURFACE_WEAPONS = [
  {
    id: 'PAC9', name: 'PAC-9 LONGSHORE', short: 'PAC-9', kind: 'viewmodel', create: createPac9Viewmodel,
    spec: PAC9_SPEC, viewFov: PAC9_VIEW_FOV, magSize: 30, adsFov: PAC9_ADS_FOV,
    tracerColor: 0xffd38a, tracerRadius: 0.014, tracerLife: 0.06, hasScope: false,
  },
];

const axis = new THREE.Vector3(0, 1, 0);
const SWITCH_TIME = 0.36;
const BASE_FOV = 62;

export class SurfaceWeapons {
  // onEvent(type, data): 'weapon:fire' | 'weapon:reload' {phase} | 'weapon:dry'
  constructor(scene, camera, dom, { canUse, onChange, onShot, onEvent, renderer = null }) {
    this.scene = scene;
    this.camera = camera;
    this.canUse = canUse;
    this.onChange = onChange;
    this.onShot = onShot;
    this.onEvent = onEvent;
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
    // Scope picture: 4.2-degree magnification with this game's astronomical
    // far plane so the 400 km sky dome is not clipped to black.
    this.scopeCamera = new THREE.PerspectiveCamera(4.2, 1, 0.01, camera.far);
    this.scopeTarget = new THREE.WebGLRenderTarget(512, 512, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
    // Intermediate scene buffer, not a display image: kept linear so the one
    // final tone-map/colour-space conversion happens when it is composited.
    this.scopeTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;

    this.rig = new THREE.Group();
    this.rig.layers.set(WEAPON_FOREGROUND_LAYER);
    this.lighting = new WeaponLighting(scene, camera);
    this.rig.renderOrder = 1000;
    // The weapon layer is drawn through its own camera: same transform as the
    // world camera, a near plane that does not clip hands and optics, and the
    // fov each viewmodel's poses were authored for.
    this.viewCamera = new THREE.PerspectiveCamera(SURFACE_WEAPONS[0].viewFov, camera.aspect, 0.01, 50);
    this.viewCamera.name = 'weapon-view-camera';
    camera.add(this.viewCamera);
    // Saltline's GPU-baked material library (glove fabric, brass…). Without a
    // renderer (Node tests) the viewmodel falls back to plain base colours.
    this.materials = null;
    if (renderer) {
      const texSize = isSoftwareWebGL(renderer) ? 256 : 1024;
      try { this.materials = createSaltlineMaterials({ renderer, params: { tex: texSize, wet: 0 } }); }
      catch (error) { console.warn('[weapons] material library unavailable', error); }
    }
    this.models = SURFACE_WEAPONS.map((def) => this.createViewmodel(def));
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
    };
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp, true);
    window.addEventListener('keydown', this.onKey);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    window.addEventListener('blur', this.onBlur);
    this.onContextMenu = (event) => { if (this.canUse()) event.preventDefault(); };
    window.addEventListener('contextmenu', this.onContextMenu);
    this.syncHud();
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
      // Surface shots have no hit model yet; aim at whatever is under the
      // crosshair.
      shot: (eye, dir) => shotPoint.copy(eye).addScaledVector(dir, THREE.MathUtils.clamp(this.beamDistance, 1.5, 120)),
      tracer: (from, to) => this.addTracerSegment(def, from, to),
      shell: () => this.ejectCasing(),
      recoil: (pitch, yaw) => {
        this.recoilP = Math.min(0.13, this.recoilP + pitch);
        this.recoilY = THREE.MathUtils.clamp(this.recoilY + yaw, -0.045, 0.045);
      },
    });
    const group = viewmodel.root;
    group.visible = false;
    group.traverse((child) => child.layers.set(WEAPON_FOREGROUND_LAYER));
    this.rig.add(group);
    return {
      group,
      viewmodel,
      ammo: viewmodel.ammo,
      eject: new THREE.Vector3().fromArray(def.spec.eject),
      magazine: viewmodel.magazine,
      hasScope: !!def.hasScope,
      opticGlass: null,
    };
  }

  select(index) {
    if (index === this.index || index === this.pendingIndex) return;
    this.cancelReload();
    this.pendingIndex = index;
    this.switchT = SWITCH_TIME;
    this.ads = false;
  }

  syncHud() {
    const def = SURFACE_WEAPONS[this.index];
    const vm = this.models[this.index]?.viewmodel;
    const holstered = Boolean(vm && (vm.isHolstered() || vm.isHolstering()));
    this.onChange?.({
      index: this.index,
      weapon: def,
      ammo: this.models[this.index].ammo,
      reloading: this.reloadT > 0,
      holstered,
    });
  }

  reload() {
    const current = this.models[this.index];
    if (this.switchT > 0 || !current.viewmodel.reloadNow()) return false;
    this.syncViewmodelState(current);
    return true;
  }

  // Mirror the viewmodel controller's ammo/reload/holster state into the fields
  // the HUD and the test API read.
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
    return this.ads ? 0.68 : 1;
  }

  onLookDelta(movementX, movementY) {
    if (!this.canUse()) return;
    // Camera rotation this frame in radians (WalkControls turns 0.0024 rad/px).
    const turn = 0.0024 * this.lookScale;
    this.lookDelta.dx += movementX * turn;
    this.lookDelta.dy += movementY * turn;
  }

  ejectCasing() {
    const model = this.models[this.index];
    // Casings fly in camera space on the weapon layer, drawn by the view camera
    // like the viewmodel itself, so they leave the real ejection port.
    const position = this.camera.worldToLocal(model.group.localToWorld(model.eject.clone()));
    const casing = new THREE.Mesh(this.casingGeometry, this.casingMaterial);
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
    const pathLength = THREE.MathUtils.clamp(direction.length(), 1.5, 120);
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

  // Rain wets the viewmodel (beads, darker and glossier finish), easing off
  // over a few seconds once it stops.
  setWetness(level, dt = 1 / 60) {
    const target = THREE.MathUtils.clamp(level || 0, 0, 1);
    this.wetness = THREE.MathUtils.lerp(this.wetness, target, Math.min(1, dt * (target > this.wetness ? 0.8 : 0.15)));
    for (const model of this.models) model.viewmodel.setWetness(this.wetness);
    if (this.materials) this.materials.uniforms.wet.value = this.wetness;
  }

  updateLighting(radiance, environment = {}, worldUp = null) {
    this.lighting.update(radiance, environment, this.rig.visible, worldUp, { deferEnvironment: true });
  }

  prepareLighting() {
    this.lighting.prepareEnvironment();
  }

    // Toggle the weapon away / back (G). Manual choice holds until the next landing.
  toggleHolster() {
    const current = this.models[this.index];
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

  // active: on foot on a surface. Entering draws the rifle (racking a round),
  // leaving plays the holster before the rig hides. motion.paused freezes
  // everything without counting as leaving.
  update(dt, active, beamDistance = 120, motion = {}) {
    let vm = this.models[this.index].viewmodel;
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
    // left click on a holstered rifle draws it instead of firing
    if (active && this.trigger && this.manualHolster && vm.isHolstered()) {
      this.trigger = false;
      this.toggleHolster();
    }
    const shown = active ? !vm.isHolstered() : vm.isHolstering();
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
        this.models[this.index].group.visible = false;
        this.index = this.pendingIndex;
        this.pendingIndex = -1;
        this.models[this.index].group.visible = true;
        this.syncHud();
      }
      if (this.switchT <= 0) this.switchT = 0;
    }
    const def = SURFACE_WEAPONS[this.index];
    const current = this.models[this.index];
    vm = current.viewmodel; // the index may have changed with a weapon switch
    // Gaits were tuned for ~4 m/s walking and ~6.5 m/s sprinting; the
    // explorer walks at 7 and runs at 18. Remap so bob cadence stays human.
    const speed = Number.isFinite(motion.speed) ? motion.speed : 0;
    const gait = speed <= 7 ? speed * (4 / 7) : 4 + (speed - 7) * (2.5 / 11);
    this.camera.getWorldPosition(this._eye);
    vm.update(dt, {
      fire: active && this.trigger && this.switchT <= 0,
      ads: active && this.ads && this.switchT <= 0,
      reload: false,
      move: motion.move || null,
      look: this.lookDelta,
      speed: gait,
      onGround: motion.grounded !== false,
      velY: Number.isFinite(motion.velY) ? motion.velY : 0,
      sprinting: !!motion.sprinting,
      crouching: false,
      eye: this._eye,
    });
    this.lookDelta.dx = 0;
    this.lookDelta.dy = 0;
    this.syncViewmodelState(current);
    // a holster that finished inside this update hides the rig this frame
    if (vm.isHolstered()) {
      this.rig.visible = false;
      this.lighting.root.visible = false;
    }

    // weapon switch: dip the whole rig
    const dip = this.switchT > 0 ? this.switchT / SWITCH_TIME : 0;
    this.rig.position.set(0, this.switchT > 0 ? -0.22 * dip - 0.1 : 0, 0);
    this.rig.rotation.set(this.switchT > 0 ? -0.5 * dip : 0, 0, 0);

    if (this.viewCamera.fov !== def.viewFov || this.viewCamera.aspect !== this.camera.aspect) {
      this.viewCamera.fov = def.viewFov;
      this.viewCamera.aspect = this.camera.aspect;
      this.viewCamera.updateProjectionMatrix();
    }
    this.recoilP *= Math.pow(0.001, dt);
    this.recoilY *= Math.pow(0.001, dt);
    const cameraRecoil = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.recoilP, this.recoilY, 0, 'XYZ'));
    this.camera.quaternion.multiply(cameraRecoil);
    // World zoom follows the viewmodel's own eased ADS blend while on foot;
    // when holstering into the ship, main.js owns the cabin FOV transition.
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

    const objectivePosition = model.group.localToWorld((model.objective || new THREE.Vector3(0, 0.315, -0.517)).clone());
    this.scopeCamera.position.copy(objectivePosition);
    this.scopeCamera.quaternion.copy(this.camera.getWorldQuaternion(new THREE.Quaternion()));
    this.scopeCamera.fov = 4.2;
    this.scopeCamera.aspect = 1;
    this.scopeCamera.far = this.camera.far;
    this.scopeCamera.updateProjectionMatrix();
    this.scopeCamera.updateMatrixWorld(true);

    const rigWasVisible = this.rig.visible;
    const lensWasVisible = lens.visible;
    const previousTarget = renderer.getRenderTarget();
    const previousFace = renderer.getActiveCubeFace(), previousMip = renderer.getActiveMipmapLevel();
    let failed = false;
    try {
      lens.visible = false;
      this.rig.visible = false;
      renderer.setRenderTarget(this.scopeTarget);
      renderer.clear();
      renderer.render(this.scene, this.scopeCamera);
    } catch (error) {
      failed = true;throw error;
    } finally {
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
    window.removeEventListener('keydown', this.onKey);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('contextmenu', this.onContextMenu);
    this.tracerGlowGeometry.dispose();
    this.tracerCoreGeometry.dispose();
    this.casingGeometry.dispose();
    this.casingMaterial.dispose();
    this.scopeTarget.dispose();
    for (const tracer of this.tracers) { this.scene.remove(tracer.mesh); tracer.mesh.material.dispose(); }
    for (const casing of this.casings) this.camera.remove(casing.mesh);
    this.tracers.length = 0;
    this.casings.length = 0;
  }
}
