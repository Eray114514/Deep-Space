import * as THREE from 'three';

// Renderer-wide material intent. These profiles describe what a surface is,
// rather than baking one lighting setup into every asset. Texture-authored
// materials retain their maps; the profile only keeps physically impossible
// scalar defaults (painted metal, glowing steel, perfectly smooth concrete)
// from flattening otherwise strong geometry.
export const PBR_MATERIAL_PROFILES = Object.freeze({
  paintedDielectric: Object.freeze({ metalness: 0.02, roughness: 0.62, envMapIntensity: 0.42 }),
  bareAlloy: Object.freeze({ metalness: 0.86, roughness: 0.38, envMapIntensity: 0.82 }),
  ceramic: Object.freeze({ metalness: 0.0, roughness: 0.76, envMapIntensity: 0.28 }),
  polymer: Object.freeze({ metalness: 0.0, roughness: 0.58, envMapIntensity: 0.24 }),
  rubber: Object.freeze({ metalness: 0.0, roughness: 0.94, envMapIntensity: 0.08 }),
  glass: Object.freeze({ metalness: 0.0, roughness: 0.09, envMapIntensity: 1.25 }),
  naturalRough: Object.freeze({ metalness: 0.0, roughness: 0.88, envMapIntensity: 0.16 }),
});

const PROFILE_ALIASES = Object.freeze({
  paint: 'paintedDielectric',
  alloy: 'bareAlloy',
  metal: 'bareAlloy',
  natural: 'naturalRough',
});

let sharedPbrEnvironment = null;

export function setSharedPbrEnvironment(environment, root = null) {
  sharedPbrEnvironment = environment || null;
  root?.traverse?.((object) => {
    if (!object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material?.userData?.sharedPbrEnvironment
        || material.envMap === sharedPbrEnvironment) continue;
      material.envMap = sharedPbrEnvironment;
      material.needsUpdate = true;
    }
  });
}

function resolveProfile(profile) {
  const name = PROFILE_ALIASES[profile] || profile;
  const value = PBR_MATERIAL_PROFILES[name];
  if (!value) throw new Error(`Unknown PBR material profile: ${profile}`);
  return { name, value };
}

export function tagMaterialProfile(material, profile) {
  if (!material) return material;
  const { name } = resolveProfile(profile);
  material.userData.pbrProfile = name;
  material.userData.baseEnvMapIntensity = material.envMapIntensity ?? 1;
  return material;
}

export function applyMaterialProfile(material, profile, {
  preserveAuthoredMaps = true,
  force = false,
  envMap = undefined,
} = {}) {
  if (!material) return material;
  const { name, value } = resolveProfile(profile);
  const hasMetalnessMap = Boolean(material.metalnessMap);
  const hasRoughnessMap = Boolean(material.roughnessMap);

  if (force || !preserveAuthoredMaps || !hasMetalnessMap) material.metalness = value.metalness;
  else material.metalness = THREE.MathUtils.clamp(material.metalness, 0, 1);
  if (force || !preserveAuthoredMaps || !hasRoughnessMap) material.roughness = value.roughness;
  else material.roughness = THREE.MathUtils.clamp(material.roughness, 0.18, 1);
  material.envMapIntensity = value.envMapIntensity;
  if (envMap !== undefined) material.envMap = envMap;
  material.userData.pbrProfile = name;
  material.userData.baseEnvMapIntensity = value.envMapIntensity;
  material.needsUpdate = true;
  return material;
}

export function createPbrMaterial(profile, parameters = {}) {
  const { name } = resolveProfile(profile);
  const MaterialType = name === 'glass' ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const material = new MaterialType(parameters);
  applyMaterialProfile(material, name, {
    preserveAuthoredMaps: false,
    force: true,
    envMap: Object.hasOwn(parameters, 'envMap') ? parameters.envMap : sharedPbrEnvironment,
  });
  material.userData.sharedPbrEnvironment = true;
  if (name === 'glass') {
    material.transparent = parameters.transparent ?? true;
    material.opacity = parameters.opacity ?? 0.58;
    material.depthWrite = parameters.depthWrite ?? false;
    material.clearcoat = parameters.clearcoat ?? 1;
    material.clearcoatRoughness = parameters.clearcoatRoughness ?? 0.08;
    material.ior = parameters.ior ?? 1.5;
  }
  return material;
}

function inferredProfile(material) {
  const name = `${material.name || ''} ${material.userData?.materialRole || ''}`.toLowerCase();
  if (/glass|window|canopy|glazing/.test(name) || material.transmission > 0.05) return 'glass';
  if (/rubber|tire|tyre|seal|gasket/.test(name)) return 'rubber';
  if (/ceramic|concrete|stone|tile/.test(name)) return 'ceramic';
  if (/alloy|metal|steel|aluminium|aluminum|chrome|copper/.test(name)) return 'bareAlloy';
  if (/plastic|polymer|panel|trim/.test(name)) return 'polymer';
  return 'paintedDielectric';
}

// Conservative GLB normalization: named/texture-authored metals stay metal;
// anonymous scalar-only materials are treated as coated surfaces. Emission is
// never invented from metalness and is removed only when no map or explicit
// light-role says that the author intended it.
export function normalizeImportedPbrMaterial(material, { envMap = sharedPbrEnvironment } = {}) {
  if (!material?.isMaterial) return material;
  const profile = material.userData?.pbrProfile || inferredProfile(material);
  const explicitMetal = profile === 'bareAlloy' || Boolean(material.metalnessMap);
  applyMaterialProfile(material, profile, {
    preserveAuthoredMaps: true,
    force: !explicitMetal && !material.roughnessMap,
    envMap,
  });
  material.userData.sharedPbrEnvironment = true;

  const name = `${material.name || ''} ${material.userData?.materialRole || ''}`.toLowerCase();
  const explicitEmission = Boolean(material.emissiveMap)
    || /light|lamp|emissive|screen|display|beacon|window/.test(name)
    || material.userData?.emissive === true;
  if (!explicitEmission && material.emissive?.isColor) {
    material.emissive.setRGB(0, 0, 0);
    material.emissiveIntensity = 0;
  }
  return material;
}

export function setMaterialEnvironmentIntensity(material, scale = 1) {
  if (!material || material.envMapIntensity === undefined) return;
  const base = material.userData?.baseEnvMapIntensity ?? material.envMapIntensity;
  material.envMapIntensity = base * Math.max(0, scale);
}
