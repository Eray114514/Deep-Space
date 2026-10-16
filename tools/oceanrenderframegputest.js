import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchBrowser, launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const out='test-results/ocean-render-frame';await mkdir(out,{recursive:true});
const before=await evidenceFingerprint('tools/oceanrenderframegputest.js');
const {server,port}=await startServer(0);let browser;const errors=[];
try {
  browser=process.argv.includes('--hardware')?await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined}):await launchBrowser();
  const page=await browser.newPage();
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/ocean-frame-fixture.html',route=>route.fulfill({contentType:'text/html',body:
    '<script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/ocean-frame-fixture.html`);
  const report=await page.evaluate(async()=>{
    const T=await import('three');
    const {applyWaterWaves}=await import('/src/shaders-webgl.js');
    const {NearWaterPatch}=await import('/src/near-water-patch.js');
    const {ChunkedLOD}=await import('/src/quadtree.js');
    const {oceanRenderFrameGLSL}=await import('/src/ocean-render-frame.js');
    const {createOceanWaveField,oceanWaveGLSL,sampleOceanWaveField}=await import('/src/ocean-wave-field.js');
    const {createOceanTidalEvent,oceanTidalEventGLSL,sampleOceanTidalEvent}=await import('/src/ocean-tidal-event.js');
    const {createOceanDetailFrame,oceanDetailOffsets,oceanDetailCoordinates,oceanDetailGLSL}=await import('/src/ocean-detail-frame.js');
    const {waterInteraction}=await import('/src/water-interaction.js');
    const renderer=new T.WebGLRenderer({logarithmicDepthBuffer:true}),gl=renderer.getContext();renderer.setClearColor(0,0);
    const info=gl.getExtension('WEBGL_debug_renderer_info');
    const camera=new T.PerspectiveCamera(62,1,.1,1e10),scene=new T.Scene(),group=new T.Group();scene.add(group);
    const color=new T.Color(.1,.2,.3),field=createOceanWaveField('ocean-frame-gpu');
    const detail=createOceanDetailFrame(T.MathUtils.clamp(1/14*.92,.028,.066)*8);
    const corner=[-.5,-1,.5,-1,.5,1,-.5,-1,.5,1,-.5,1];
    let samples=0,compiled=0,maxPosition=0,maxCoverage=0,maxWave=0,maxGradient=0,maxTidal=0,maxUv=0,maxRipple=0,negative=0,maskChecks=0;
    let failure=null;const rows=[];
    const circular=(a,b)=>Math.abs(a-b-Math.round(a-b));
    try {
      for(const radius of [6e6,2e7]) {
        const direction=new T.Vector3(1,-.17,-.13).normalize();
        const tide=createOceanTidalEvent({normal:direction.toArray(),height:280,period:400},{radius});
        const planet={R:radius,seaRadius:radius,seaLevel:0,hAmp:1,fullMaxFreq:14,seed:`ocean-frame-gpu-${radius}`,
          group,_invFrame:new T.Quaternion(),skyColor:color,liquidColor:color,sunDirLocal:new T.Vector3(0,1,0),
          height:()=>-2000,oceanSurface:{waveField:field,tidalField:tide},weatherHours:200/60};
        const material=applyWaterWaves(new T.MeshPhysicalMaterial(),planet);
        const compile=material.onBeforeCompile,mode={value:0},width={value:1};
        material.onBeforeCompile=(shader,renderer)=>{
          compile(shader,renderer);compiled++;
          if(shader.uniforms.uOceanCameraToAnchor!==material.userData.waterUniforms.uOceanCameraToAnchor)throw Error('Variant lost frame owner.');
          Object.assign(shader.uniforms,{uProbeMode:mode,uProbeWidth:width});
          shader.vertexShader=shader.vertexShader.replace('#include <common>',`#include <common>
            attribute vec2 aProbeCorner;attribute float aProbeSlot;uniform float uProbeWidth;
            varying vec3 vProbeOld;uniform vec3 uProbeOldCenter;`)
            .replace('vWaveHeight = displacedWave;','vWaveHeight = displacedWave; vProbeOld=aLocal+aPositionDelta*aLodMorph-uProbeOldCenter;')
            .replace('#include <project_vertex>',`#include <project_vertex>
              gl_Position=vec4(2.0*(aProbeSlot+.5+aProbeCorner.x)/uProbeWidth-1.0,aProbeCorner.y,0,1);`);
          shader.uniforms.uProbeOldCenter=material.userData.waterUniforms.uNearPatchCenter;
          const start=shader.fragmentShader.indexOf('float patchDistance = oceanPatchDistance(vOceanRelative);');
          if(start<0)throw Error('Missing production coverage gate.');
          const coverage=shader.fragmentShader.slice(start,shader.fragmentShader.indexOf('vec3 localUp = normalize(vLocalPos);',start));
          shader.fragmentShader=`varying vec3 vOceanRelative,vProbeOld;varying float vNearPatchPass;uniform int uProbeMode;uniform float uNearPatchRadius;
            uniform sampler2D uRippleTex,uDetailTex;${oceanRenderFrameGLSL}${oceanWaveGLSL}${oceanTidalEventGLSL}${oceanDetailGLSL(detail)}
            void main(){
              if(uProbeMode==0)gl_FragColor=vec4(vOceanRelative,oceanPatchDistance(vOceanRelative));
              else if(uProbeMode==1)gl_FragColor=oceanWaveField(vOceanRelative,4.0);
              else if(uProbeMode==2)gl_FragColor=vec4(fract(oceanCapillary(vOceanRelative,vec2(0))),0,1);
              else if(uProbeMode==3)gl_FragColor=vec4(vOceanRelative-texelFetch(uRippleTex,ivec2(0,0),0).xyz,1);
              else if(uProbeMode==4)gl_FragColor=vec4(vProbeOld,1);
              else if(uProbeMode==5)gl_FragColor=oceanTidalEvent(vOceanRelative,2000.0);
              else {${coverage}gl_FragColor=vec4(1);}
            }`;
        };
        material.customProgramCacheKey=()=>`ocean-frame-probe-${radius}`;
        material.depthTest=false;material.depthWrite=false;material.blending=T.NoBlending;
        const patch=new NearWaterPatch(planet,material,{cells:64,rowsPerFrame:65,buildBudgetMs:10000});
        patch.update(direction.clone().multiplyScalar(radius+10),true,1/60,10000);
        while(patch.build)patch._buildRows(10000);
        const center=patch.mesh.position.clone(),sources=[];
        for(const index of [32*65+32,32*65+33,32,64*65+32])sources.push({mesh:patch.mesh,index});
        const lod=Object.create(ChunkedLOD.prototype);
        lod.planet={...planet,height:()=>0,gridCells:4,skirtDrop:.081,freqAtLevel:l=>l,bakeDepth:()=>2000,terrainMaterial:material};
        const span=2/8192,u0=.13-span/2,v0=-.17-span/2;
        const parent={face:0,u0,v0,u1:u0+span,v1:v0+span,level:13,parent:null,childX:0,childY:0,ix:0,iy:0,morph:0,centerPos:center.clone()};
        lod.buildNodeMesh(parent);sources.push({mesh:parent.mesh,index:4},{mesh:parent.mesh,index:29});
        const child={...parent,level:14,u1:u0+span/2,v1:v0+span/2,parent,centerPos:new T.Vector3(1,v0+span/4,-(u0+span/4)).normalize().multiplyScalar(radius)};
        lod.buildNodeMesh(child);sources.push({mesh:child.mesh,index:4},{mesh:child.mesh,index:29});
        const probes=[];
        const add=(source,index)=>{
          const geo=new T.BufferGeometry();
          for(const name of Object.keys(source.geometry.attributes)) {
            const a=source.geometry.getAttribute(name),values=[];
            for(let n=0;n<6;n++)for(let axis=0;axis<a.itemSize;axis++)values.push(a.getComponent(index,axis));
            geo.setAttribute(name,new T.Float32BufferAttribute(values,a.itemSize));
          }
          geo.setAttribute('aProbeCorner',new T.Float32BufferAttribute(corner,2));
          geo.setAttribute('aProbeSlot',new T.Float32BufferAttribute(Array(6).fill(probes.length),1));
          const mesh=new T.Mesh(geo,material);mesh.position.copy(source.position);mesh.frustumCulled=false;mesh.renderOrder=probes.length;
          probes.push(mesh);group.add(mesh);
        };
        for(const {mesh,index} of sources)add(mesh,index);
        const tangent=new T.Vector3().crossVectors(direction,new T.Vector3(0,1,0)).normalize();
        for(const delta of [-.01,.01])for(const near of [false,true]) {
          const distance=patch.radius-640+delta,theta=2*Math.asin(distance/(2*radius));
          const point=center.clone().multiplyScalar(Math.cos(theta)).addScaledVector(tangent,radius*Math.sin(theta));
          const source=near?patch.mesh:parent.mesh;
          add(source,near?32*65+32:4);
          const mesh=probes.at(-1),relative=point.clone().sub(mesh.position);
          for(let i=0;i<6;i++) {
            mesh.geometry.getAttribute('position').setXYZ(i,...relative.toArray());
            mesh.geometry.getAttribute('aLocal').setXYZ(i,...point.toArray());
            mesh.geometry.getAttribute('aPositionDelta').setXYZ(i,0,0,0);
          }
        }
        group.remove(patch.mesh,parent.mesh,child.mesh);
        width.value=probes.length;
        const target=new T.WebGLRenderTarget(probes.length,1,{type:T.FloatType,depthBuffer:false}),pixels=new Float32Array(probes.length*4);
        const impulse=center.clone().add(new T.Vector3(17.13,-23.19,11.31));
        waterInteraction.setPlanet(planet.seed);waterInteraction.inject(impulse,{strength:1});
        for(const rotation of [0,1])for(const rebase of [0,1e8,-1e8,0])for(const offset of [-256.001,-255.999,0,256.001])for(const morph of [0,.37,1]) {
          const seconds=morph===0?0:morph===1?400:200;planet.weatherHours=seconds/60;
          group.quaternion.setFromEuler(new T.Euler(.32+rotation*.4,-.44,.15));planet._invFrame.copy(group.quaternion).invert();
          const eye=center.clone().add(new T.Vector3(offset,3.7,11.9));
          group.position.copy(eye).applyQuaternion(group.quaternion).negate().add(new T.Vector3(rebase,234,-117));
          camera.position.set(rebase+2.3,235.7,-122.1);camera.quaternion.setFromEuler(new T.Euler(-.21,.61,-.34));camera.updateMatrixWorld(true);
          for(const mesh of probes){mesh.geometry.getAttribute('aLodMorph').array.fill(morph);mesh.geometry.getAttribute('aLodMorph').needsUpdate=true;}
          // Publication is independent from view/sample-anchor changes.
          const coverageCenter=center.clone().add(new T.Vector3(rotation*1024,0,0));
          material.userData.waterUniforms.uNearPatchCenter.value.copy(coverageCenter);
          material.userData.waterUniforms.uNearPatchRadius.value=rotation===0?patch.radius:0;
          for(let probeMode=0;probeMode<7;probeMode++) {
            mode.value=probeMode;renderer.setRenderTarget(target);renderer.render(scene,camera);
            renderer.readRenderTargetPixels(target,0,0,probes.length,1,pixels);
            if(gl.getError()||gl.isContextLost())throw Error('GL/context gate failed.');
            const anchor=material.userData.oceanSamplingAnchor;
            probes.forEach((mesh,slot)=>{
              const position=mesh.geometry.getAttribute('position'),delta=mesh.geometry.getAttribute('aPositionDelta');
              const p=mesh.position.clone();['x','y','z'].forEach((axis,i)=>p[axis]+=Math.fround(position.getComponent(0,i)+Math.fround(delta.getComponent(0,i)*morph)));
              const actual=Array.from(pixels.slice(slot*4,slot*4+4)),relative=p.clone().sub(anchor);
              if(probeMode==0){maxPosition=Math.max(maxPosition,new T.Vector3(...actual).distanceTo(relative));maxCoverage=Math.max(maxCoverage,Math.abs(actual[3]-(rotation===0?p.distanceTo(coverageCenter):relative.length())));}
              if(probeMode==1||probeMode==5){const s=probeMode==1?sampleOceanWaveField(field,p,seconds,{significantHeight:2,footprint:4}):sampleOceanTidalEvent(tide,p,seconds,{depth:2000});
                const expected=[s.height,s.gradient.x,s.gradient.y,s.gradient.z];
                if(probeMode==1)maxWave=Math.max(maxWave,Math.abs(actual[0]-expected[0]));else maxTidal=Math.max(maxTidal,Math.abs(actual[0]-expected[0]));
                maxGradient=Math.max(maxGradient,...actual.slice(1).map((v,i)=>Math.abs(v-expected[i+1])));}
              if(probeMode==2){const uv=oceanDetailCoordinates(detail,6,p,oceanDetailOffsets(detail,new T.Vector3()));maxUv=Math.max(maxUv,circular(actual[0],uv[0]),circular(actual[1],uv[1]));}
              if(probeMode==3)maxRipple=Math.max(maxRipple,new T.Vector3(...actual).distanceTo(p.clone().sub(impulse)));
              if(probeMode==4&&rotation===0)negative=Math.max(negative,new T.Vector3(...actual).distanceTo(p.clone().sub(coverageCenter)));
              if(probeMode==6) {
                const isNear=mesh.geometry.getAttribute('aNearPatchPass').getX(0)>.5;
                const inside=p.distanceTo(coverageCenter)<patch.radius-640;
                if(actual[0]!==Number(rotation!==0||isNear===inside))throw Error(`Coverage owner mismatch at slot ${slot}`);
                maskChecks++;
              }
              samples++;
            });
          }
        }
        rows.push({radius,probes:probes.length});
        group.clear();probes.forEach(mesh=>mesh.geometry.dispose());patch.dispose();parent.mesh.geometry.dispose();child.mesh.geometry.dispose();
        material.userData.waterInteractionTexture.dispose();material.dispose();target.dispose();
      }
    } catch(error){failure=String(error);}
    finally {renderer.setRenderTarget(null);renderer.dispose();}
    return {samples,compiled,maxPosition,maxCoverage,maxWave,maxGradient,maxTidal,maxUv,maxRipple,negative,maskChecks,rows,failure,
      gpu:info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};
  });
  const after=await evidenceFingerprint('tools/oceanrenderframegputest.js');
  const stable=before.sourceDigest===after.sourceDigest&&before.verifierDigest===after.verifierDigest;
  const path=`${out}/${process.argv.includes('--hardware')?'hardware':'swiftshader'}.json`;
  await writeFile(path,JSON.stringify({before,after,stable,report,errors},null,2));console.log(JSON.stringify(report));
  assert.equal(stable,true);assert.deepEqual(errors,[]);assert.equal(report.failure,null);
  assert.equal(report.samples,16128);assert.equal(report.maskChecks,2304);assert.ok(report.maxPosition<.003);assert.ok(report.maxCoverage<.003);
  assert.ok(report.maxRipple<.003);assert.ok(report.maxWave<.005);assert.ok(report.maxTidal<.01);
  assert.ok(report.maxGradient<.0003);assert.ok(report.maxUv<.001);assert.ok(report.negative>.2);
  console.log(`PASS: ${path}`);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
