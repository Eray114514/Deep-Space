// Frozen inline routing from 2272e923b794463e2a07bbc93a4ac21cf6e78d2f,
// src/volumetric-pass-webgl.js. Kept independently of local Git history so the
// CPU regression can demonstrate the stale CACHE1 route after lost readiness.
export const originalCloudColumnRoutingBody = `      if(planet?.volCloudMesh && planet.volCloudFarMat) {
        const far=planet.volCloudMat.uniforms.uCameraLocal.value.length()
          -planet.volCloudBand.rOut>200000;
        planet.volCloudMesh.material=far?planet.volCloudFarMat:planet.volCloudMat;
      }
      if(planet?.weatherField?.synoptic && planet.weatherStream?.ready
        && planet.volCloudMesh.material===planet.volCloudFarMat) {
        let columns=this.columnMaps.get(planet);
        if(!columns || columns.disposed) {
          columns=new CloudColumnBank(planet);this.columnMaps.set(planet,columns);
          planet.cloudColumnMap=columns;
        }
        columns.update(renderer);
        const minimumCone=minimumCloudRayCone(this.camera.projectionMatrix.elements,this.width,this.height);
        const nearestDistance=Math.max(0,planet.volCloudMat.uniforms.uCameraLocal.value.length()-planet.volCloudBand.rOut);
        const cacheOnly=planet.volCloudMat.uniforms.uColumnsReady.value>.5
          && nearestDistance*minimumCone>2400;
        if(planet.volCloudFarMat.defines.CLOUD_FAR_CACHE!==Number(cacheOnly)) {
          planet.volCloudFarMat.defines.CLOUD_FAR_CACHE=Number(cacheOnly);
          planet.volCloudFarMat.needsUpdate=true;
        }
        if(this.columnMaps.size>2) {
          const oldest=[...this.columnMaps.keys()].find(p=>p!==planet);
          this.columnMaps.get(oldest).dispose();this.columnMaps.delete(oldest);
          oldest.volCloudMat.uniforms.uColumnsReady.value=0;
        }
      } else if(planet && this.columnMaps.has(planet)) {
        // Near sunlight transport and far optical columns have separate owners.
        // Retain neither unused baking snapshots nor far targets in a near view.
        this.columnMaps.get(planet).dispose();this.columnMaps.delete(planet);
      }
`;
