import * as THREE from 'three';
import { getSharedPmremGenerator } from './shared-pmrem.js';
import { setSharedPbrEnvironment } from './pbr-materials.js';

function probePixels(zone, size) {
  const width = size * 2, height = size;
  const data = new Uint16Array(width * height * 4);
  const lamps = zone === 'cockpit'
    ? [
      [-0.52, 0.52, 0xffcf9f, 1.0], [0.52, 0.52, 0xffcf9f, 1.0],
      [-0.12, 0.72, 0xc8dcff, 0.65], [0.08, 0.34, 0x78b8ff, 0.42],
    ]
    : [
      [-0.72, 0.64, 0xd8e7ff, 0.78], [-0.24, 0.68, 0xffdfbc, 0.72],
      [0.24, 0.68, 0xd7e6ff, 0.76], [0.72, 0.62, 0x86b8ff, 0.58],
    ];
  const colors = lamps.map((lamp) => new THREE.Color(lamp[2]));
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const vertical = Math.sin((v - 0.5) * Math.PI);
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      let r = 0.010 + Math.max(0, vertical) * 0.006;
      let g = 0.012 + Math.max(0, vertical) * 0.008;
      let b = 0.016 + Math.max(0, vertical) * 0.012;
      if (vertical < 0) { r *= 0.46; g *= 0.43; b *= 0.42; }
      for (let i = 0; i < lamps.length; i++) {
        const [lu, lv,, energy] = lamps[i];
        const wrapped = Math.min(Math.abs(u - (lu * 0.5 + 0.5)),
          1 - Math.abs(u - (lu * 0.5 + 0.5)));
        const dv = v - (lv * 0.5 + 0.5);
        const glow = Math.exp(-(wrapped * wrapped * 85 + dv * dv * 110)) * energy * 1.35;
        r += colors[i].r * glow;
        g += colors[i].g * glow;
        b += colors[i].b * glow;
      }
      const index = (y * width + x) * 4;
      data[index] = THREE.DataUtils.toHalfFloat(r);
      data[index + 1] = THREE.DataUtils.toHalfFloat(g);
      data[index + 2] = THREE.DataUtils.toHalfFloat(b);
      data[index + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.name = `${zone}-radiance-equirect`;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function buildProbe(renderer, zone, size) {
  const texture = probePixels(zone, size);
  const pmrem = getSharedPmremGenerator(renderer);
  const target = pmrem.fromEquirectangular(texture);
  target.texture.name = `${zone}-radiance-pmrem`;
  texture.dispose();
  return { texture: target.texture, dispose: () => target.dispose() };
}

function sourceDirection(source, target) {
  const value = source?.worldDirection || source?.direction;
  if (value?.isVector3) return target.copy(value).normalize();
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return target.fromArray(value).normalize();
  return target.set(0.2, 0.7, -0.6).normalize();
}

function sourceColor(source, target) {
  const value = source?.colorValue || source?.color || source?.radiance;
  if (value?.isColor) return target.copy(value);
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return target.fromArray(value);
  return target.setRGB(1, 0.93, 0.84);
}

export class SceneRadianceState {
  constructor(renderer, scene, universe, {
    enabled = true,
    probeResolution = 128,
  } = {}) {
    this.enabled = enabled;
    this.renderer = renderer;
    this.scene = scene;
    this.mode = 'space';
    this.exposure = 1.1;
    this.environmentIntensity = 0;
    this.isolation = 'all';
    this.components = {
      direct: true,
      indirect: true,
      reflections: true,
      localLights: true,
      background: true,
    };
    this.directScale = 1;
    this.exteriorAmbient = 0.07;
    this.exteriorFill = 0.17;
    this.sources = [0, 1].map(() => ({
      direction: new THREE.Vector3(0.2, 0.7, -0.6).normalize(),
      color: new THREE.Color(1, 0.93, 0.84),
      irradiance: 0,
      visibility: 1,
    }));
    this.sourceCount = 0;
    this.cockpitProbe = enabled ? buildProbe(renderer, 'cockpit', probeResolution) : null;
    this.cabinProbe = enabled ? buildProbe(renderer, 'cabin', probeResolution) : null;
    this.setUniverse(universe);
  }

  setIsolation(mode = 'all') {
    const aliases = { reflection: 'reflections', local: 'localLights' };
    const component = aliases[mode] || mode;
    const valid = ['all', ...Object.keys(this.components)];
    if (!valid.includes(component)) throw new Error(`Unknown render-look component: ${mode}`);
    this.isolation = component;
    for (const key of Object.keys(this.components)) {
      this.components[key] = component === 'all' || component === key;
    }
    this.universe?.spaceRadiance?.setVisible(this.enabled && this.components.background);
    return this.isolation;
  }

  setUniverse(universe) {
    this.universe = universe;
    this.spaceEnvironment = universe?.spaceRadiance?.environmentMap || null;
    // Environment ownership is explicit. A scene-wide IBL silently adds a
    // cube lookup to every terrain, water and vegetation fragment; at 2K that
    // costs several milliseconds and also washes custom GLSL surfaces that
    // already implement their own sky response. Authored PBR assets opt in via
    // profiles, while the ship receives its three dedicated probes directly.
    this.scene.environment = null;
    this.scene.environmentIntensity = 1;
    setSharedPbrEnvironment(this.enabled ? this.spaceEnvironment : null, this.scene);
    this.universe?.spaceRadiance?.setVisible(this.enabled && this.components.background);
  }

  update(dt, { environment, stellarField, mode = 'space' } = {}) {
    this.mode = mode;
    const rawSources = [...(stellarField?.sources || [])]
      .sort((a, b) => (b.irradianceFraction ?? b.flux ?? 0)
        - (a.irradianceFraction ?? a.flux ?? 0))
      .slice(0, 2);
    this.sourceCount = rawSources.length;
    for (let i = 0; i < this.sources.length; i++) {
      const target = this.sources[i], source = rawSources[i];
      target.irradiance = source?.irradianceFraction ?? (i === 0 ? 1 : 0);
      target.visibility = source?.visibility ?? 1;
      sourceDirection(source, target.direction);
      sourceColor(source, target.color);
    }

    const atmosphere = Math.max(0, environment?.atmosphere || 0);
    const day = THREE.MathUtils.clamp(environment?.day ?? 1, 0, 1);
    this.directScale = this.components.direct
      ? 0.07 + day * (environment?.directTransmittance ?? 1) * 0.93 : 0;
    this.environmentIntensity = this.components.reflections
      ? THREE.MathUtils.clamp(
        0.18 + atmosphere * 0.06 + (environment?.skyIrradiance || 0) * 0.18, 0.16, 0.38,
      ) : 0;

    const modeGain = mode === 'interior' ? 1.12
      : mode === 'cockpit' ? 1.08
        : mode === 'planet' ? 1.06 : 1.05;
    const targetExposure = (environment?.exposure ?? 1.05) * modeGain;
    const rate = targetExposure > this.exposure ? 0.92 : 1.45;
    this.exposure += (targetExposure - this.exposure)
      * (1 - Math.exp(-Math.max(0, dt) * rate));
    this.exteriorAmbient = this.components.indirect ? 0.055 + (1 - day) * 0.035 : 0;
    this.exteriorFill = this.components.indirect
      ? 0.12 + (1 - day) * 0.08 + atmosphere * 0.035 : 0;
    return this;
  }

  debugState() {
    return {
      enabled: this.enabled,
      isolation: this.isolation,
      components: { ...this.components },
      mode: this.mode,
      exposure: this.exposure,
      environmentIntensity: this.environmentIntensity,
      sourceCount: this.sourceCount,
      sources: this.sources.slice(0, this.sourceCount).map((source) => ({
        direction: source.direction.toArray(),
        color: source.color.toArray(),
        irradiance: source.irradiance,
        visibility: source.visibility,
      })),
      space: this.universe?.spaceRadiance?.stats || null,
    };
  }

  dispose() {
    this.cockpitProbe?.dispose();
    this.cabinProbe?.dispose();
  }
}
