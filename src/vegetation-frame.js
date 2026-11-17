import * as THREE from 'three';
import { SURFACE_INTERACTION_CAP, surfaceInteraction } from './surface-interaction.js';
import { disturbanceUniforms, vegetationDisturbance } from './vegetation/disturbance.js';

// The render origin changes with the ring; planting and interaction positions
// remain canonical doubles. Reduce each wind frequency separately on the CPU
// so rebasing does not reset gusts or lose phase precision on large planets.
export class VegetationFrame {
  constructor(field = surfaceInteraction) {
    this.origin = new THREE.Vector3();
    this.field = field;
    this.interactionRevision = -1;
    this.planetId = undefined;
    this.uniforms = {
      uWindPhase: { value: new THREE.Vector4() },
      uWindFlutterPhase: { value: 0 },
      uBendPos: { value: Array.from({ length: SURFACE_INTERACTION_CAP }, () => new THREE.Vector4()) },
      uBendData: { value: field.data },
      ...disturbanceUniforms(),
    };
    this.disturbanceRevision = -1;
  }

  setOrigin(origin) {
    this.origin.copy(origin);
    this.interactionRevision = -1;
    this.disturbanceRevision = -1;
    const phase = origin.x * 0.61 + origin.y * 0.53 + origin.z * 0.47;
    const period = Math.PI * 2;
    this.uniforms.uWindPhase.value.set(phase % period, (phase * 1.67) % period,
      (phase * 0.73) % period, (phase * 0.11) % period);
    this.uniforms.uWindFlutterPhase.value = (phase * 2.31) % period;
  }

  syncInteractions(planetId) {
    if (this.disturbanceRevision !== vegetationDisturbance.revision || this.planetId !== planetId) {
      vegetationDisturbance.copyRelative(this.uniforms.uDistPos.value, this.uniforms.uDistData.value,
        this.origin, planetId);
      this.disturbanceRevision = vegetationDisturbance.revision;
    }
    if (this.interactionRevision === this.field.revision && this.planetId === planetId) return;
    this.field.copyRelativePositions(this.uniforms.uBendPos.value, this.origin, planetId);
    this.interactionRevision = this.field.revision;
    this.planetId = planetId;
  }
}
