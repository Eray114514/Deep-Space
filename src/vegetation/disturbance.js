// Vegetation disturbance: what the ship's downwash does to plants.
//
// Two kinds of record, both discs on the planet surface:
//
//   scar      a landing site. Trees inside it are blown over and stay down,
//             shrubs and grass are flattened. \`fell\` (0..1) is how far the
//             event has progressed, so the trees topple during the descent
//             instead of vanishing. Scars persist per planet for the session.
//   downwash  one transient disc under a hovering, landing or departing ship.
//             Plants lean away from it and recover when it is gone.
//
// Positions are planet-local doubles. Each consumer (the tree field and the
// scatter deck) has its own render origin and asks for relative copies.
// The shaders read DISTURBANCE_CAP vec4 pairs:
//   position  xyz relative centre, w radius
//   data      x fell, y push, z/w unused

import * as THREE from 'three';

export const SCAR_CAP = 6;
export const DISTURBANCE_CAP = SCAR_CAP + 1;
const FAR = 1e9;

export class VegetationDisturbance {
  constructor() {
    this.planetId = null;
    this.scarsByPlanet = new Map();
    this.scars = [];
    this.downwash = { center: new THREE.Vector3(), radius: 1, push: 0, refreshed: false };
    this.revision = 0;
  }

  setPlanet(planetId) {
    if (planetId === this.planetId) return;
    this.planetId = planetId;
    if (planetId != null && !this.scarsByPlanet.has(planetId)) this.scarsByPlanet.set(planetId, []);
    this.scars = planetId == null ? [] : this.scarsByPlanet.get(planetId);
    this.downwash.push = 0;
    this.revision++;
  }

  // A new landing site. Returns the record; the caller drives \`fell\`.
  addScar(center, radius) {
    const scar = { center: center.clone(), radius, fell: 0 };
    this.scars.push(scar);
    if (this.scars.length > SCAR_CAP) this.scars.shift();
    this.revision++;
    return scar;
  }

  setFell(scar, fell) {
    const next = Math.max(scar.fell, Math.min(1, fell));
    if (next === scar.fell) return;
    scar.fell = next;
    this.revision++;
  }

  // Call every frame the downwash should exist; it fades out once the calls stop.
  setDownwash(center, radius, push) {
    this.downwash.center.copy(center);
    this.downwash.radius = radius;
    this.downwash.push = Math.max(0, Math.min(1, push));
    this.downwash.refreshed = true;
    this.revision++;
  }

  update(dt) {
    if (!this.downwash.refreshed && this.downwash.push > 0) {
      this.downwash.push = Math.max(0, this.downwash.push - dt * 0.8);
      this.revision++;
    }
    this.downwash.refreshed = false;
  }

  // Fill shader arrays relative to \`origin\` for the plants of \`planetId\`.
  copyRelative(positions, data, origin, planetId) {
    const active = planetId != null && planetId === this.planetId;
    for (let i = 0; i < DISTURBANCE_CAP; i++) {
      const record = !active ? null
        : i < SCAR_CAP ? this.scars[i]
        : (this.downwash.push > 0 ? this.downwash : null);
      if (!record) {
        positions[i].set(FAR, FAR, FAR, 1);
        data[i].set(0, 0, 0, 0);
        continue;
      }
      positions[i].set(record.center.x - origin.x, record.center.y - origin.y,
        record.center.z - origin.z, record.radius);
      data[i].set(i < SCAR_CAP ? record.fell : 0, i < SCAR_CAP ? 0 : record.push, 0, 0);
    }
  }
}

export const vegetationDisturbance = new VegetationDisturbance();

export function disturbanceUniforms() {
  return {
    uDistPos: { value: Array.from({ length: DISTURBANCE_CAP }, () => new THREE.Vector4(FAR, FAR, FAR, 1)) },
    uDistData: { value: Array.from({ length: DISTURBANCE_CAP }, () => new THREE.Vector4()) },
  };
}

// GLSL shared by trees, shrubs and grass. \`plantBend\` returns the bend of one
// plant as a rotation about its base, in the instance's local frame.
//   base       plant base in the consumer's space (instanceMatrix[3].xyz)
//   upW        plant up axis in that space
//   r          stable per-plant random number
//   fallAngle  lean when fully blown over (trees ~1.5 rad, grass ~1.3)
//   scarReach  how far past a scar's radius the flattening reaches (grass > 1)
export const DISTURBANCE_GLSL = /* glsl */`
uniform vec4 uDistPos[${DISTURBANCE_CAP}];
uniform vec4 uDistData[${DISTURBANCE_CAP}];
mat3 gPlantBend;
// lean direction (unit, horizontal) and angle in radians
vec4 plantDisturbance(vec3 base, vec3 upW, float r, float fallAngle, float scarReach) {
  vec3 lean = vec3(0.0);
  float angle = 0.0;
  for (int i = 0; i < ${DISTURBANCE_CAP}; i++) {
    vec3 off = base - uDistPos[i].xyz;
    off -= upW * dot(off, upW);
    float d = length(off);
    float radius = uDistPos[i].w;
    vec3 dir = d > 1e-3 ? off / d : vec3(1.0, 0.0, 0.0);
    // scar: inside the core the plant goes all the way over, staggered so the
    // nearest fall first; the rim only leans
    float core = 1.0 - smoothstep(radius * 0.72, radius * scarReach, d);
    float innerPad = 1.0 - smoothstep(radius * 0.58, radius * 0.78, d);
    float stagger = clamp(uDistData[i].x * 1.7 - (d / max(radius, 1.0)) * 0.55 - r * 0.25, 0.0, 1.0);
    stagger = stagger * stagger * (3.0 - 2.0 * stagger);
    float scarAngle = fallAngle * mix(0.82 + 0.18 * r, 1.0, innerPad) * core * stagger;
    // downwash: everything under the ship leans away, strongest at the centre
    float wash = uDistData[i].y * (1.0 - smoothstep(0.0, radius, d));
    float washAngle = fallAngle * 0.42 * wash;
    float a = max(scarAngle, washAngle);
    if (a > angle) { angle = a; lean = dir; }
  }
  return vec4(lean, angle);
}
// Pad clear (0..1): strictly inside the landed hull and ramp footprint, plants
// lean outward during descent and scale down cleanly to zero on touchdown so
// side branches and grass never poke through the cabin deck or open ramp and
// never flatten into coplanar Z-fighting planes.
float plantPadCrush(vec3 base, vec3 upW, float r, float innerFrac, float outerFrac) {
  float crush = 0.0;
  for (int i = 0; i < ${DISTURBANCE_CAP}; i++) {
    if (uDistData[i].x <= 1e-4) continue;
    vec3 off = base - uDistPos[i].xyz;
    off -= upW * dot(off, upW);
    float d = length(off);
    float radius = uDistPos[i].w;
    float pad = 1.0 - smoothstep(radius * innerFrac, radius * outerFrac, d);
    float stagger = clamp(uDistData[i].x * 1.7 - (d / max(radius, 1.0)) * 0.55 - r * 0.25, 0.0, 1.0);
    crush = max(crush, pad * smoothstep(0.45, 0.95, stagger));
  }
  return crush;
}
// rotation about the plant's base: tip moves toward the local lean direction
mat3 plantBendMatrix(vec4 dist, mat3 instanceRotation) {
  if (dist.w < 1e-4) return mat3(1.0);
  // world lean -> instance-local, horizontal
  vec3 l = transpose(instanceRotation) * dist.xyz;
  l.y = 0.0;
  float ll = length(l);
  if (ll < 1e-4) return mat3(1.0);
  l /= ll;
  vec3 axis = normalize(cross(vec3(0.0, 1.0, 0.0), l));
  float c = cos(dist.w), s = sin(dist.w), t = 1.0 - c;
  return mat3(
    t * axis.x * axis.x + c,          t * axis.x * axis.y + s * axis.z, t * axis.x * axis.z - s * axis.y,
    t * axis.x * axis.y - s * axis.z, t * axis.y * axis.y + c,          t * axis.y * axis.z + s * axis.x,
    t * axis.x * axis.z + s * axis.y, t * axis.y * axis.z - s * axis.x, t * axis.z * axis.z + c);
}
`;
