import * as THREE from 'three';

// Canonical planting inputs are captured before any matrix/Float32 storage.
export function vegetationPrecisionFixture(radius = 6000000, profile = 'flat') {
  const geometry = new THREE.BoxGeometry(0.2, 1, 0.2);
  geometry.translate(0, 0.5, 0);
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(
    new Float32Array(geometry.attributes.position.count * 3).fill(1), 3));
  const expected = [];
  const heightAt = direction => 13.125 + (profile === 'relief'
    ? 17000 * (direction.x * 0.31 + direction.y * 0.47 + direction.z * 0.19) : 0);
  const planet = {
    R: radius, seed: 'VEGETATION-PRECISION', bodyId: 'fixture', intSeed: 76123,
    type: 'terrestrial', fullMaxFreq: 128, hasLiquid: false,
    group: new THREE.Group(), pal: { rock: new THREE.Color(0.4, 0.3, 0.2) },
    flora: { shrub: geometry, pod: geometry,
      trees: { atlas: new THREE.Texture(), shrub: { leafColor: new THREE.Color(0.1, 0.2, 0.05) } },
      grass: geometry, grassMid: geometry, grassFar: geometry, grassTint: new THREE.Color(0.2, 0.4, 0.1) },
    height: heightAt, biomeAt: () => 'grass',
    colorAt(direction, height, _strength, _frequency, color) {
      expected.push(direction.clone().multiplyScalar(radius + height));
      color.setRGB(0.3, 0.4, 0.2);
    },
  };
  return { planet, geometry, expected, heightAt, reset() { expected.length = 0; } };
}
