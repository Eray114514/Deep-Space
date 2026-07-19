import * as THREE from 'three';
import { createWeaponModel } from './weapon-models.js';

// Directly ported ballistic profiles from futuristic-space-station. The two
// excluded entries are the VX-4 sidearm and GV-1 gravity projector.
export const SURFACE_WEAPONS = [
  { id: 'KX9', name: 'KX-9 CERBERUS', short: 'KX-9', magSize: 30, fireInterval: 60 / 720, auto: true, kick: 0.95, hipPos: [0.34, -0.31, -0.68], adsPos: [0, -0.292, -0.556], adsFov: 57, recoilP: 0.018, recoilY: 0.012, color: 0xffbe5c, tracerColor: 0xffd38a, tracerRadius: 0.018, tracerLife: 0.075 },
  { id: 'CX5', name: 'CX-5 MARAUDER', short: 'CX-5', magSize: 35, fireInterval: 60 / 860, auto: true, kick: 0.68, hipPos: [0.31, -0.3, -0.64], adsPos: [0, -0.2745, -0.526], adsFov: 57, recoilP: 0.011, recoilY: 0.011, color: 0xffbe5c, tracerColor: 0xffd38a, tracerRadius: 0.011, tracerLife: 0.05 },
  { id: 'M77', name: 'M77 SENTINEL', short: 'M77', magSize: 12, fireInterval: 60 / 310, auto: false, kick: 1.5, hipPos: [0.34, -0.31, -0.68], adsPos: [0, -0.315, -0.537], adsFov: 42, recoilP: 0.055, recoilY: 0.018, color: 0xffbe5c, tracerColor: 0xffd38a, tracerRadius: 0.026, tracerLife: 0.12 },
  { id: 'HLX3', name: 'HLX-3 PROSPECTOR', short: 'HLX-3', magSize: Infinity, fireInterval: 0, auto: true, kick: 0.08, hipPos: [0.38, -0.44, -0.92], adsPos: [0, -0.4, -0.86], adsFov: 54, color: 0x63efff, kind: 'laser' },
];

const axis = new THREE.Vector3(0, 1, 0);
const forward = new THREE.Vector3(0, 0, -1);
const SWITCH_TIME = 0.36;

export class SurfaceWeapons {
  constructor(scene, camera, dom, { canUse, onChange, onShot }) {
    this.scene = scene;
    this.camera = camera;
    this.canUse = canUse;
    this.onChange = onChange;
    this.onShot = onShot;
    this.index = 0;
    this.cooldown = 0;
    this.flashT = 0;
    this.kick = 0;
    this.trigger = false;
    this.justPressed = false;
    this.ads = false;
    this.pendingIndex = -1;
    this.switchT = 0;
    this.recoilP = 0;
    this.recoilY = 0;
    this.shotFovKick = 0;
    this.weaponSwayX = 0;
    this.weaponSwayY = 0;
    this.bobPhase = 0;
    this.bobAmt = 0;
    this.beamDistance = 120;
    this.laserWasFiring = false;
    this.tracers = [];
    this.flashes = [];
    this.sparks = [];
    this.casings = [];
    this.tracerGlowGeometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1);
    this.tracerCoreGeometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
    this.worldFlashGeometry = new THREE.SphereGeometry(1, 8, 6);
    this.casingGeometry = new THREE.CylinderGeometry(0.012, 0.014, 0.055, 10);
    this.longCasingGeometry = new THREE.CylinderGeometry(0.012, 0.014, 0.075, 10);
    this.casingMaterial = new THREE.MeshStandardMaterial({ color: 0xb68636, metalness: 0.92, roughness: 0.22 });
    // Keep the source optic's 4.2-degree magnification, but use this game's
    // astronomical far plane so the 400 km sky dome is not clipped to black.
    this.scopeCamera = new THREE.PerspectiveCamera(4.2, 1, 0.01, camera.far);
    this.scopeTarget = new THREE.WebGLRenderTarget(512, 512, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });

    this.rig = new THREE.Group();
    this.rig.layers.set(3);
    this.rig.renderOrder = 1000;
    this.models = SURFACE_WEAPONS.map((def) => {
      const group = createWeaponModel(def.id);
      group.visible = false;
      group.traverse((child) => {
        child.layers.set(3);
        if (child.isMesh) { child.castShadow = false; child.receiveShadow = false; }
      });
      const flash = this.makeFlash(def.color, group.userData.muzzle);
      group.add(flash);
      const laser = def.kind === 'laser' ? this.makeLaserEffect(group.userData.muzzle) : null;
      if (laser) group.add(laser.root);
      this.rig.add(group);
      return {
        group,
        flash,
        laser,
        ammo: def.magSize,
        muzzle: group.userData.muzzle.clone(),
        eject: group.userData.eject?.clone(),
        bolt: group.userData.bolt,
        opticGlass: group.userData.opticGlass,
      };
    });
    this.models[0].group.visible = true;
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
      if (!document.pointerLockElement) {
        this.trigger = false;
        this.justPressed = false;
        this.ads = false;
      }
    };
    this.onBlur = () => {
      this.trigger = false;
      this.justPressed = false;
      this.ads = false;
    };
    this.onKey = (event) => {
      if (!this.canUse() || event.repeat) return;
      const slot = Number(event.key) - 1;
      if (slot >= 0 && slot < SURFACE_WEAPONS.length) {
        event.preventDefault();
        this.select(slot);
      }
    };
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp, true);
    window.addEventListener('keydown', this.onKey);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('contextmenu', (event) => { if (this.canUse()) event.preventDefault(); });
    this.syncHud();
  }

  makeFlash(color, muzzle) {
    const flash = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    for (let i = 0; i < 2; i++) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.1), material);
      plane.rotation.z = i * Math.PI / 2;
      flash.add(plane);
    }
    flash.position.copy(muzzle);
    flash.visible = false;
    return flash;
  }

  select(index) {
    if (index === this.index || index === this.pendingIndex) return;
    this.pendingIndex = index;
    this.switchT = SWITCH_TIME;
    this.ads = false;
    this.laserWasFiring = false;
  }

  syncHud() {
    const def = SURFACE_WEAPONS[this.index];
    this.onChange?.({ index: this.index, weapon: def, ammo: this.models[this.index].ammo });
  }

  fire() {
    const def = SURFACE_WEAPONS[this.index];
    const current = this.models[this.index];
    if (current.ammo <= 0) { current.ammo = def.magSize; }
    current.ammo--;
    this.cooldown = def.fireInterval;
    this.flashT = def.id === 'M77' ? 0.1 : 0.06;
    this.recoilP = Math.min(0.13, this.recoilP + def.recoilP + Math.random() * 0.006);
    this.recoilY = THREE.MathUtils.clamp(this.recoilY + (Math.random() - 0.5) * def.recoilY, -0.045, 0.045);
    this.kick = def.kick;
    this.shotFovKick = def.id === 'M77' ? 1.35 : 1;
    this.addTracer(def, this.beamDistance);
    this.addMuzzleBlast(def);
    this.ejectCasing();
    this.cycleBolt();
    this.onShot?.(def);
    this.syncHud();
  }

  get lookScale() {
    return this.ads ? 0.68 : 1;
  }

  onLookDelta(movementX, movementY) {
    if (!this.canUse()) return;
    this.weaponSwayX = THREE.MathUtils.clamp(this.weaponSwayX - movementX * 0.00032, -0.035, 0.035);
    this.weaponSwayY = THREE.MathUtils.clamp(this.weaponSwayY - movementY * 0.00028, -0.026, 0.026);
  }

  cycleBolt() {
    const bolt = this.models[this.index].bolt;
    if (!bolt) return;
    const homeZ = bolt.position.z;
    bolt.position.z += 0.08;
    window.setTimeout(() => { bolt.position.z = homeZ; }, 58);
  }

  ejectCasing() {
    const model = this.models[this.index];
    if (!model.eject) return;
    const worldPosition = model.group.localToWorld(model.eject.clone());
    const position = this.camera.worldToLocal(worldPosition.clone());
    const casing = new THREE.Mesh(
      SURFACE_WEAPONS[this.index].id === 'M77' ? this.longCasingGeometry : this.casingGeometry,
      this.casingMaterial,
    );
    casing.layers.set(3);
    casing.position.copy(position);
    casing.rotation.set(Math.random(), Math.random(), Math.random());
    this.camera.add(casing);
    this.casings.push({
      mesh: casing,
      velocity: new THREE.Vector3(1.5 + Math.random() * 0.7, 0.7 + Math.random() * 0.5, (Math.random() - 0.5) * 0.35),
      spin: new THREE.Vector3(8 + Math.random() * 7, 4 + Math.random() * 6, 8),
      life: 2.1,
    });
  }

  addMuzzleBlast(def) {
    const muzzle = this.models[this.index].group.localToWorld(this.models[this.index].muzzle.clone());
    const duration = def.id === 'M77' ? 0.1 : 0.06;
    const intensity = def.id === 'M77' ? 42 : 26;
    const material = new THREE.MeshBasicMaterial({
      color: def.color,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(this.worldFlashGeometry, material);
    const baseScale = THREE.MathUtils.clamp(0.08 + Math.sqrt(intensity) * 0.018 + 12 * 0.004, 0.12, 0.48);
    mesh.position.copy(muzzle);
    mesh.scale.setScalar(baseScale);
    this.scene.add(mesh);
    this.flashes.push({ mesh, life: duration, max: duration, baseScale });

    const positions = new Float32Array(5 * 3);
    const velocities = [];
    for (let i = 0; i < 5; i++) {
      positions[i * 3] = muzzle.x;
      positions[i * 3 + 1] = muzzle.y;
      positions[i * 3 + 2] = muzzle.z;
      velocities.push(new THREE.Vector3().randomDirection().multiplyScalar(6 * (0.3 + Math.random())));
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ color: 0xaaddff, size: 0.06, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.scene.add(points);
    this.sparks.push({ points, velocities, life: 0.45, max: 0.45 });
  }

  makeLaserEffect(muzzle) {
    const length = 120;
    const root = new THREE.Group();
    root.position.copy(muzzle);
    root.visible = false;

    const makeBeam = (radius, color, opacity, radialSegments = 10) => {
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, radialSegments, 1, true), material);
      mesh.position.z = -length * 0.5;
      mesh.quaternion.setFromUnitVectors(axis, forward);
      root.add(mesh);
      return mesh;
    };

    // A physically legible laser read: a nearly white energy core surrounded
    // by two progressively wider atmospheric-scatter envelopes.
    const haze = makeBeam(0.085, 0x23cfe2, 0.075, 12);
    const sheath = makeBeam(0.028, 0x45eaff, 0.34, 10);
    const core = makeBeam(0.006, 0xeaffff, 0.98, 8);

    const muzzleMaterial = new THREE.MeshBasicMaterial({
      color: 0xbffbff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const muzzleGlow = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 10), muzzleMaterial);
    root.add(muzzleGlow);

    const impact = new THREE.Group();
    impact.position.z = -length;
    root.add(impact);
    const impactGlow = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 10), muzzleMaterial.clone());
    impact.add(impactGlow);
    const impactDisc = new THREE.Mesh(
      new THREE.CircleGeometry(0.25, 32),
      new THREE.MeshBasicMaterial({ color: 0x83f7ff, transparent: true, opacity: 0.48, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    );
    impact.add(impactDisc);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.18, 0.012, 8, 40),
      new THREE.MeshBasicMaterial({ color: 0xc8fdff, transparent: true, opacity: 0.72, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    ring.position.z = 0.008;
    impact.add(ring);

    const sparkPositions = new Float32Array(18 * 3);
    for (let i = 0; i < 18; i++) {
      const a = i * 2.399963;
      const radius = 0.08 + (i % 5) * 0.035;
      sparkPositions[i * 3] = Math.cos(a) * radius;
      sparkPositions[i * 3 + 1] = Math.sin(a) * radius;
      sparkPositions[i * 3 + 2] = 0.015 + (i % 3) * 0.018;
    }
    const sparkGeometry = new THREE.BufferGeometry();
    sparkGeometry.setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3));
    const sparks = new THREE.Points(
      sparkGeometry,
      new THREE.PointsMaterial({ color: 0xd6ffff, size: 0.035, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    impact.add(sparks);

    root.traverse((child) => child.layers.set(0));
    return { root, core, sheath, haze, muzzleGlow, impact, impactGlow, impactDisc, ring, sparks, beams: [core, sheath, haze], baseLength: length, time: 0 };
  }

  updateLaser(laser, dt, firing, model, beamDistance) {
    laser.root.visible = firing;
    if (!firing) return;
    const crosshairDistance = THREE.MathUtils.clamp(beamDistance, 1.5, laser.baseLength);
    const targetInRig = new THREE.Vector3(0, 0, -crosshairDistance)
      .sub(this.rig.position)
      .applyQuaternion(this.rig.quaternion.clone().invert());
    const muzzleToTarget = targetInRig.sub(laser.root.position);
    const distance = muzzleToTarget.length();
    laser.root.quaternion.setFromUnitVectors(forward, muzzleToTarget.normalize());
    for (const beam of laser.beams) {
      beam.position.z = -distance * 0.5;
      beam.scale.y = distance / laser.baseLength;
    }
    laser.impact.position.z = -distance;
    laser.impact.visible = crosshairDistance < laser.baseLength - 0.5;
    laser.time += dt;
    const fast = laser.time * 47;
    const slow = laser.time * 8.5;
    const pulse = 0.92 + Math.sin(fast) * 0.055 + Math.sin(slow) * 0.025;
    laser.core.scale.x = laser.core.scale.z = pulse;
    laser.sheath.scale.x = laser.sheath.scale.z = 0.9 + Math.sin(fast * 0.73) * 0.12;
    laser.haze.material.opacity = 0.055 + (Math.sin(slow) + 1) * 0.018;
    laser.muzzleGlow.scale.setScalar(0.82 + Math.sin(fast * 1.17) * 0.13);
    laser.impact.rotation.z += dt * 2.8;
    laser.impactGlow.scale.setScalar(0.78 + Math.sin(fast * 0.61) * 0.18);
    laser.impactDisc.material.opacity = 0.34 + (Math.sin(fast * 0.47) + 1) * 0.1;
    laser.ring.scale.setScalar(0.86 + (Math.sin(slow * 1.4) + 1) * 0.11);
    laser.sparks.rotation.z -= dt * 5.2;
    laser.sparks.material.opacity = 0.55 + (Math.sin(fast * 0.37) + 1) * 0.2;
    for (let i = 0; i < (model.userData.energyMaterials?.length || 0); i++) {
      const material = model.userData.energyMaterials[i];
      if ('emissiveIntensity' in material) material.emissiveIntensity = 3.5 + pulse * 2.4;
    }
  }

  isMiningBeamRequested() {
    return this.trigger && SURFACE_WEAPONS[this.index]?.kind === 'laser';
  }

  addTracer(def, beamDistance) {
    const model = this.models[this.index];
    const from = model.group.localToWorld(model.muzzle.clone());
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    const pathLength = THREE.MathUtils.clamp(beamDistance, 1.5, 120);
    const streakLength = Math.min(pathLength, 1.35);
    const velocity = direction.clone().multiplyScalar(Math.max(0, pathLength - streakLength) / def.tracerLife);
    const streakCenter = from.clone().addScaledVector(direction, streakLength * 0.5);

    const glowMaterial = new THREE.MeshBasicMaterial({
      color: def.tracerColor,
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const glow = new THREE.Mesh(this.tracerGlowGeometry, glowMaterial);
    glow.position.copy(streakCenter);
    glow.scale.set(def.tracerRadius * 1.6, streakLength, def.tracerRadius * 1.6);
    glow.quaternion.setFromUnitVectors(axis, direction);
    this.scene.add(glow);
    this.tracers.push({ mesh: glow, life: def.tracerLife, max: def.tracerLife, velocity, baseOpacity: 0.2 });

    const coreMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.82,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const core = new THREE.Mesh(this.tracerCoreGeometry, coreMaterial);
    core.position.copy(streakCenter);
    core.scale.set(def.tracerRadius * 0.35, streakLength, def.tracerRadius * 0.35);
    core.quaternion.copy(glow.quaternion);
    this.scene.add(core);
    this.tracers.push({ mesh: core, life: def.tracerLife, max: def.tracerLife, velocity: velocity.clone(), baseOpacity: 0.82 });
  }

  update(dt, active, beamDistance = 120, motion = {}) {
    this.rig.visible = active;
    if (!active) {
      this.trigger = false;
      this.justPressed = false;
      this.ads = false;
      this.updateTransientEffects(dt);
      return;
    }
    this.beamDistance = beamDistance;
    this.cooldown -= dt;
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
    const currentDef = SURFACE_WEAPONS[this.index];
    const laserFiring = currentDef.kind === 'laser' && this.trigger;
    if (this.switchT <= 0 && currentDef.kind !== 'laser' && this.cooldown <= 0 && (currentDef.auto ? this.trigger : this.justPressed)) this.fire();
    if (laserFiring && !this.laserWasFiring) this.onShot?.(currentDef);
    this.laserWasFiring = laserFiring;
    this.justPressed = false;
    this.flashT = Math.max(0, this.flashT - dt);
    const flash = this.models[this.index].flash;
    flash.visible = currentDef.kind !== 'laser' && this.flashT > 0;
    if (flash.visible) {
      flash.rotation.z = Math.random() * Math.PI;
      const pulse = 0.75 + Math.random() * 0.5;
      flash.scale.setScalar(pulse);
      flash.traverse((child) => {
        if (child.isMesh) child.material.opacity = this.flashT / (currentDef.id === 'M77' ? 0.1 : 0.06);
      });
    }

    const speed = Number.isFinite(motion.speed) ? motion.speed : 0;
    if (motion.grounded && speed > 0.5) {
      this.bobPhase += dt * (speed * 1.35);
      this.bobAmt = THREE.MathUtils.lerp(this.bobAmt, Math.min(1, speed / 6), Math.min(1, dt * 6));
    } else {
      this.bobAmt = THREE.MathUtils.lerp(this.bobAmt, 0, Math.min(1, dt * 6));
    }

    this.recoilP *= Math.pow(0.001, dt);
    this.recoilY *= Math.pow(0.001, dt);
    this.kick = laserFiring ? 0.06 + Math.sin(performance.now() * 0.035) * 0.018 : Math.max(0, this.kick - dt * 7);
    this.shotFovKick = Math.max(0, this.shotFovKick - dt * 10);
    this.weaponSwayX = THREE.MathUtils.lerp(this.weaponSwayX, 0, Math.min(1, dt * 9));
    this.weaponSwayY = THREE.MathUtils.lerp(this.weaponSwayY, 0, Math.min(1, dt * 9));

    const source = this.ads ? currentDef.adsPos : currentDef.hipPos;
    const targetPosition = new THREE.Vector3(source[0], source[1], source[2]);
    const switchProgress = this.switchT > 0 ? 1 - this.switchT / SWITCH_TIME : 1;
    const dipY = this.switchT > 0 ? -0.22 * (1 - switchProgress) - 0.1 : 0;
    const dipRotation = this.switchT > 0 ? -0.5 * (1 - switchProgress) : 0;
    targetPosition.z += this.kick * 0.06 * currentDef.kick;
    targetPosition.y += dipY + Math.sin(this.bobPhase * 2) * 0.008 * this.bobAmt * (this.ads ? 0.25 : 1);
    targetPosition.x += Math.cos(this.bobPhase) * 0.006 * this.bobAmt * (this.ads ? 0.25 : 1);
    targetPosition.x += this.weaponSwayX * (this.ads ? 0.35 : 1);
    targetPosition.y += this.weaponSwayY * (this.ads ? 0.35 : 1);
    this.rig.position.lerp(targetPosition, Math.min(1, dt * 14));
    this.rig.rotation.x = THREE.MathUtils.lerp(this.rig.rotation.x, this.kick * 0.14 * currentDef.kick + dipRotation, Math.min(1, dt * 12));
    this.rig.rotation.y = THREE.MathUtils.lerp(this.rig.rotation.y, 0, Math.min(1, dt * 12));
    this.rig.rotation.z = THREE.MathUtils.lerp(this.rig.rotation.z, -this.weaponSwayX * 0.7, Math.min(1, dt * 14));

    const cameraRecoil = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.recoilP, this.recoilY, 0, 'XYZ'));
    this.camera.quaternion.multiply(cameraRecoil);
    const targetFov = (this.ads ? currentDef.adsFov : 62) + this.shotFovKick * 0.8;
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, Math.min(1, dt * 9));
    this.camera.updateProjectionMatrix();
    if (this.models[this.index].laser) this.updateLaser(this.models[this.index].laser, dt, laserFiring, this.models[this.index].group, beamDistance);
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
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const flash = this.flashes[i];
      flash.life -= dt;
      const fade = Math.max(0, flash.life / flash.max);
      flash.mesh.material.opacity = fade;
      flash.mesh.scale.setScalar(flash.baseScale * (1 + (1 - fade) * 0.45));
      if (flash.life <= 0) {
        this.scene.remove(flash.mesh);
        flash.mesh.material.dispose();
        this.flashes.splice(i, 1);
      }
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const spark = this.sparks[i];
      spark.life -= dt;
      const positions = spark.points.geometry.attributes.position;
      for (let j = 0; j < spark.velocities.length; j++) {
        spark.velocities[j].y -= 3.2 * dt;
        positions.array[j * 3] += spark.velocities[j].x * dt;
        positions.array[j * 3 + 1] += spark.velocities[j].y * dt;
        positions.array[j * 3 + 2] += spark.velocities[j].z * dt;
      }
      positions.needsUpdate = true;
      spark.points.material.opacity = Math.max(0, spark.life / spark.max);
      if (spark.life <= 0) {
        this.scene.remove(spark.points);
        spark.points.geometry.dispose();
        spark.points.material.dispose();
        this.sparks.splice(i, 1);
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
    const lens = model.opticGlass;
    if (!this.rig.visible || SURFACE_WEAPONS[this.index].id !== 'M77' || !lens?.isMesh || !lens.material?.isShaderMaterial) return;

    const objectivePosition = model.group.localToWorld(new THREE.Vector3(0, 0.315, -0.517));
    this.scopeCamera.position.copy(objectivePosition);
    this.scopeCamera.quaternion.copy(this.camera.getWorldQuaternion(new THREE.Quaternion()));
    this.scopeCamera.fov = 4.2;
    this.scopeCamera.aspect = 1;
    this.scopeCamera.far = this.camera.far;
    this.scopeCamera.updateProjectionMatrix();
    this.scopeCamera.updateMatrixWorld(true);

    const rigWasVisible = this.rig.visible;
    const previousTarget = renderer.getRenderTarget();
    this.scopeTarget.texture.colorSpace = renderer.outputColorSpace;
    lens.visible = false;
    this.rig.visible = false;
    renderer.setRenderTarget(this.scopeTarget);
    renderer.clear();
    renderer.render(this.scene, this.scopeCamera);
    renderer.setRenderTarget(previousTarget);
    this.rig.visible = rigWasVisible;
    lens.visible = true;

    lens.material.uniforms.tDiffuse.value = this.scopeTarget.texture;
    const eyePosition = this.camera.getWorldPosition(new THREE.Vector3());
    lens.material.uniforms.cameraPos.value.copy(eyePosition);
    const lensPosition = lens.getWorldPosition(new THREE.Vector3());
    lens.material.uniforms.lensPos.value.copy(lensPosition);
    const lensForward = new THREE.Vector3(0, 0, 1).applyQuaternion(lens.getWorldQuaternion(new THREE.Quaternion()));
    lens.material.uniforms.lensForward.value.copy(lensForward);
    const lensToEye = eyePosition.clone().sub(lensPosition);
    const axialDistance = Math.abs(lensToEye.dot(lensForward));
    const lateralDistance = Math.sqrt(Math.max(0, lensToEye.lengthSq() - axialDistance * axialDistance));
    const eyeOffset = lateralDistance / Math.max(axialDistance, 0.001);
    const geometricEyeBox = 1 - THREE.MathUtils.smoothstep(eyeOffset, 0.035, 0.36);
    const eyeBoxTarget = this.ads ? Math.max(0.82, geometricEyeBox) : geometricEyeBox;
    lens.material.uniforms.eyeBox.value = THREE.MathUtils.lerp(
      lens.material.uniforms.eyeBox.value,
      eyeBoxTarget,
      0.16,
    );
    lens.material.uniforms.vignetteIntensity.value = THREE.MathUtils.lerp(
      lens.material.uniforms.vignetteIntensity.value || 18,
      this.ads ? 2 : 18,
      0.16,
    );
  }
}
