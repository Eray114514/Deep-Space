import * as THREE from 'three';
import { RainSystem, GROUND_GRID, GROUND_SPAN } from './weather/rain.js';

const SNOW_FLAKES = 760;
const _axis = new THREE.Vector3();
const _side = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _point = new THREE.Vector3();

function fract(value) {
  return value - Math.floor(value);
}

function hash(index, salt) {
  return fract(Math.sin(index * 127.1 + salt * 311.7) * 43758.5453123);
}

function basisFromUp(up) {
  _axis.copy(up).normalize();
  _side.crossVectors(Math.abs(_axis.y) < 0.88
    ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0), _axis).normalize();
  _forward.crossVectors(_axis, _side).normalize();
}

export class WeatherEffects {
  constructor(scene) {
    this.scene = scene;
    // GPU rain: lit, pixel-aware streaks in a world-fixed field plus ground splashes.
    this.rainFx = new RainSystem(scene);
    this.groundHeights = new Float32Array(GROUND_GRID * GROUND_GRID);

    this.snowPositions = new Float32Array(SNOW_FLAKES * 3);
    const snowGeometry = new THREE.BufferGeometry();
    snowGeometry.setAttribute('position',
      new THREE.BufferAttribute(this.snowPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.snow = new THREE.Points(snowGeometry, new THREE.PointsMaterial({
      color: 0xeaf4ff,
      size: 0.15,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      fog: true,
    }));
    this.snow.frustumCulled = false;
    this.snow.renderOrder = 6;
    scene.add(this.snow);

    this.lightning = new THREE.PointLight(0xb8d4ff, 0, 180, 2);
    this.lightning.position.set(0, 28, -22);
    scene.add(this.lightning);
    this.state = {
      kind: 'clear',
      precipitation: 0,
      rainVisible: false,
      snowVisible: false,
      lightning: 0,
    };
  }

  // frame (optional): { dt, camera, renderer, origin, displacement, sunDir,
  //   sunColor, ambient, groundSampler(side, up, forward, out, span, grid) -> bool }
  update(weather, up, windWorld, seconds, atmosphere = 1, frame = {}) {
    const precipitation = THREE.MathUtils.clamp(
      (weather?.precipitation || 0) * atmosphere, 0, 1);
    const kind = weather?.precipitationKind || 'none';
    basisFromUp(up || _axis.set(0, 1, 0));
    _wind.copy(windWorld || _side).projectOnPlane(_axis);
    if (_wind.lengthSq() < 1e-6) _wind.copy(_side);
    _wind.normalize();
    const gust = weather?.gust || 0;
    const windLean = 3 + gust * 12;

    const rainVisible = kind === 'rain' && precipitation > 0.045;
    const groundOk = rainVisible && frame.groundSampler
      ? frame.groundSampler(_side, _axis, _forward, this.groundHeights, GROUND_SPAN, GROUND_GRID) : false;
    this.rainFx.update({
      dt: frame.dt ?? 1 / 60,
      time: seconds,
      level: rainVisible ? THREE.MathUtils.clamp((precipitation - 0.045) * 1.12, 0.04, 1) : 0,
      origin: frame.origin,
      side: _side, up: _axis, forward: _forward,
      displacement: frame.displacement,
      wind: windWorld ? _point.copy(windWorld).multiplyScalar(0.35 + gust * 0.4) : null,
      sunDir: frame.sunDir, sunColor: frame.sunColor, ambient: frame.ambient,
      camera: frame.camera, renderer: frame.renderer,
      groundHeights: groundOk ? this.groundHeights : null,
    });

    const snowVisible = kind === 'snow' && precipitation > 0.035;
    this.snow.visible = snowVisible;
    this.snow.material.opacity = snowVisible ? 0.2 + precipitation * 0.7 : 0;
    this.snow.material.size = 0.11 + precipitation * 0.13;
    if (snowVisible) {
      for (let i = 0; i < SNOW_FLAKES; i++) {
        const radius = 4 + hash(i, 11) * 44;
        const angle = hash(i, 12) * Math.PI * 2 + seconds * (hash(i, 13) - 0.5) * 0.16;
        const height = fract(hash(i, 14) - seconds * (0.045 + hash(i, 15) * 0.055))
          * 36 - 9;
        const flutter = Math.sin(seconds * (1.1 + hash(i, 16) * 2.4)
          + hash(i, 17) * Math.PI * 2) * (0.3 + gust * 0.8);
        const point = _point.copy(_side).multiplyScalar(Math.cos(angle) * radius + flutter)
          .addScaledVector(_forward, Math.sin(angle) * radius)
          .addScaledVector(_axis, height)
          .addScaledVector(_wind, height * windLean * 0.026);
        const offset = i * 3;
        this.snowPositions[offset] = point.x;
        this.snowPositions[offset + 1] = point.y;
        this.snowPositions[offset + 2] = point.z;
      }
      this.snow.geometry.attributes.position.needsUpdate = true;
    }

    const storm = weather?.convective || 0;
    const flashWave = fract(seconds * 0.071 + (weather?.coverage || 0) * 0.37);
    const flash = storm > 0.72
      ? Math.pow(Math.max(0, 1 - Math.abs(flashWave - 0.035) / 0.035), 9)
        * storm * atmosphere
      : 0;
    this.lightning.intensity = flash * 85;
    this.lightning.position.copy(_axis).multiplyScalar(30)
      .addScaledVector(_side, Math.sin(seconds * 0.19) * 42)
      .addScaledVector(_forward, -28);

    this.state = {
      kind: weather?.kind || 'clear',
      precipitation,
      rainVisible,
      snowVisible,
      lightning: flash,
    };
    return this.state;
  }

  dispose() {
    this.rainFx.dispose();
    this.scene.remove(this.snow, this.lightning);
    this.snow.geometry.dispose();
    this.snow.material.dispose();
  }
}
