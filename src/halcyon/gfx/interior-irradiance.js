import * as THREE from 'three';

const _position = new THREE.Vector3();
const _world = new THREE.Vector3();
const _local = new THREE.Vector3();
const _lamp = new THREE.Vector3();
const _inverse = new THREE.Matrix4();

export function bakeInteriorIrradiance(root) {
  root.updateWorldMatrix(true, true);
  _inverse.copy(root.matrixWorld).invert();
  const fixtures = [];
  root.traverse((object) => {
    if (!object.isPointLight && !object.isSpotLight) return;
    object.getWorldPosition(_world);
    fixtures.push({
      position: _world.clone().applyMatrix4(_inverse),
      color: object.color.clone(),
      intensity: Math.max(0, object.intensity || 0),
      distance: Math.max(1.5, object.distance || 6),
    });
  });

  let vertices = 0;
  root.traverse((object) => {
    if (!object.isMesh || !object.geometry?.attributes?.position) return;
    const position = object.geometry.attributes.position;
    const cavity = object.geometry.attributes.aCav;
    const values = new Float32Array(position.count * 3);
    object.updateWorldMatrix(true, false);
    for (let i = 0; i < position.count; i++) {
      _position.fromBufferAttribute(position, i);
      _local.copy(_position).applyMatrix4(object.matrixWorld).applyMatrix4(_inverse);
      let r = 0.006, g = 0.008, b = 0.012;
      for (const fixture of fixtures) {
        const distance = _lamp.copy(fixture.position).sub(_local).length();
        const falloff = Math.max(0, 1 - distance / fixture.distance);
        const energy = falloff * falloff * Math.sqrt(fixture.intensity) * 0.018;
        r += fixture.color.r * energy;
        g += fixture.color.g * energy;
        b += fixture.color.b * energy;
      }
      const enclosure = cavity ? cavity.getX(i) : 0;
      const occlusion = 1 - enclosure * 0.48;
      values[i * 3] = Math.min(0.18, r * occlusion);
      values[i * 3 + 1] = Math.min(0.18, g * occlusion);
      values[i * 3 + 2] = Math.min(0.20, b * occlusion);
    }
    object.geometry.setAttribute('aCabinIrradiance', new THREE.BufferAttribute(values, 3));
    vertices += position.count;
  });
  root.userData.interiorIrradiance = { fixtures: fixtures.length, vertices };
  return root.userData.interiorIrradiance;
}

export function applyInteriorIrradiance(material) {
  if (!material?.isMeshStandardMaterial && !material?.isMeshPhysicalMaterial) return material;
  if (material.userData.interiorIrradiance) return material;
  const beforeCompile = material.onBeforeCompile;
  const cacheKey = material.customProgramCacheKey?.bind(material);
  const indirectScale = { value: 1 };
  material.onBeforeCompile = (shader, renderer) => {
    beforeCompile?.(shader, renderer);
    shader.uniforms.uCabinIndirect = indirectScale;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aCabinIrradiance;\nvarying vec3 vCabinIrradiance;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvCabinIrradiance = aCabinIrradiance;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uCabinIndirect;\nvarying vec3 vCabinIrradiance;')
      .replace('#include <lights_fragment_end>',
        '#include <lights_fragment_end>\n\treflectedLight.indirectDiffuse += diffuseColor.rgb * vCabinIrradiance * uCabinIndirect;');
  };
  material.customProgramCacheKey = () => `${cacheKey?.() || material.type}|cabin-irradiance-v1`;
  material.userData.interiorIrradiance = true;
  material.userData.interiorIndirectScale = indirectScale;
  material.needsUpdate = true;
  return material;
}
