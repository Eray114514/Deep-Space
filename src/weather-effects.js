import * as THREE from 'three';

const RAIN_DROPS = 1450;
const SNOW_FLAKES = 760;
const _axis = new THREE.Vector3();
const _side = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _point = new THREE.Vector3();
const _tail = new THREE.Vector3();

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
    this.rainPositions = new Float32Array(RAIN_DROPS * 2 * 3);
    const rainGeometry = new THREE.BufferGeometry();
    rainGeometry.setAttribute('position',
      new THREE.BufferAttribute(this.rainPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.rain = new THREE.LineSegments(rainGeometry, new THREE.LineBasicMaterial({
      color: 0xa9c9e2,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      fog: true,
      blending: THREE.NormalBlending,
    }));
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 6;
    scene.add(this.rain);

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

  update(weather, up, windWorld, seconds, atmosphere = 1) {
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
    this.rain.visible = rainVisible;
    // Thin, short streaks read as nearby rain. The old 7–9 m segments filled
    // the whole perspective cone and looked like a warp-speed star field.
    this.rain.material.opacity = rainVisible ? 0.07 + precipitation * 0.25 : 0;
    if (rainVisible) {
      for (let i = 0; i < RAIN_DROPS; i++) {
        const radius = 8 + hash(i, 1) * 72;
        const angle = hash(i, 2) * Math.PI * 2;
        const height = fract(hash(i, 3) - seconds * (0.72 + hash(i, 4) * 0.34))
          * 62 - 18;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        const length = 0.48 + precipitation * 1.24 + hash(i, 5) * 0.72;
        const base = _point.copy(_side).multiplyScalar(x)
          .addScaledVector(_forward, z)
          .addScaledVector(_axis, height)
          .addScaledVector(_wind, (height + 18) * windLean * 0.018);
        const tail = _tail.copy(base).addScaledVector(_axis, -length)
          .addScaledVector(_wind, length * windLean * 0.045);
        const offset = i * 6;
        this.rainPositions[offset] = base.x;
        this.rainPositions[offset + 1] = base.y;
        this.rainPositions[offset + 2] = base.z;
        this.rainPositions[offset + 3] = tail.x;
        this.rainPositions[offset + 4] = tail.y;
        this.rainPositions[offset + 5] = tail.z;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
    }

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
    this.scene.remove(this.rain, this.snow, this.lightning);
    this.rain.geometry.dispose();
    this.rain.material.dispose();
    this.snow.geometry.dispose();
    this.snow.material.dispose();
  }
}
