import * as THREE from 'three';
import { WEAPON_FOREGROUND_LAYER } from './render-layers.js';
import { WeaponSkyProbe } from './weapon-sky-probe.js';

// Outdoor equipment shares stellar radiance, not the ship's light rig. The
// separate render layer prevents these unshadowed lights reaching the cabin.
export class WeaponLighting {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.materials = new Set();
    this.origin = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.skyProbe = new WeaponSkyProbe();
    this.root = new THREE.Group();
    this.root.name = 'weapon-lighting';
    this.root.visible = false;
    this.ambient = new THREE.AmbientLight(0xc4d9ef, 0);
    this.suns = [new THREE.DirectionalLight(0xffffff, 0), new THREE.DirectionalLight(0xffffff, 0)];
    for (const light of [this.ambient, ...this.suns]) {
      light.layers.set(WEAPON_FOREGROUND_LAYER);
      this.root.add(light);
    }
    for (const light of this.suns) this.root.add(light.target);
    scene.add(this.root);
  }

  register(root) {
    root.traverse((object) => {
      object.layers.set(WEAPON_FOREGROUND_LAYER);
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material?.isMeshStandardMaterial || this.materials.has(material)) continue;
        // Preserve authored metal/roughness and imported maps. Opt in to the
        // explicit environment lifecycle instead of relying on scene.environment.
        material.userData.sharedPbrEnvironment = true;
        material.userData.weaponEnvironmentIntensity = material.envMapIntensity ?? 1;
        this.materials.add(material);
      }
    });
  }

  update(radiance, environment = {}, active = false, worldUp = null) {
    this.root.visible = active;
    const day = THREE.MathUtils.clamp(environment.day ?? 1, 0, 1);
    // environment.day already includes eclipse; source.irradiance already
    // includes source visibility. Never apply either attenuation twice.
    const daylight = day;
    const horizon = Number.isFinite(environment.solarElevation)
      ? THREE.MathUtils.smoothstep(environment.solarElevation, -0.2, 0.24) : daylight;
    this.camera.getWorldPosition(this.origin);
    const indirect = radiance?.components?.indirect !== false;
    this.ambient.intensity = indirect ? 0.012 + daylight * 0.18 : 0;
    for (let i = 0; i < this.suns.length; i++) {
      const light = this.suns[i];
      const source = radiance?.sources?.[i];
      light.intensity = source && radiance?.components?.direct !== false
        ? Math.max(0, source.irradiance ?? 0)
          * (radiance.directScale ?? 1) * horizon * 1.6 : 0;
      if (source?.color) light.color.copy(source.color);
      light.position.copy(this.origin);
      if (source?.direction) light.position.addScaledVector(source.direction, 80);
      light.target.position.copy(this.origin);
    }
    this.up.copy(worldUp || this.camera.up).normalize();
    const outdoor = active && (environment.atmosphere ?? 0) > 0.02 && daylight > 0.02;
    const outdoorTexture = outdoor
      ? this.skyProbe.update(radiance?.renderer, environment, this.up) : null;
    const texture = outdoorTexture || radiance?.spaceEnvironment || null;
    const reflectionScale = radiance?.components?.reflections === false ? 0
      : (radiance?.environmentIntensity ?? 0) * (0.08 + daylight * 0.92);
    for (const material of this.materials) {
      if (material.envMap !== texture) {
        material.envMap = texture;
        material.needsUpdate = true;
      }
      material.envMapIntensity = material.userData.weaponEnvironmentIntensity * reflectionScale;
    }
  }

  dispose() {
    this.skyProbe.dispose();
    this.scene.remove(this.root);
    this.materials.clear();
  }
}
