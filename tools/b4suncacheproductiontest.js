// Local transport cache against independently integrated readback of the real
// density field. A constant slab test cannot establish production accuracy.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
const {server,port}=await startServer(0);let browser;
const encoded=process.env.B4_CACHE_ENCODED==='1';
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&freeze=1&time=9.5&quality=ultra&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted',null,{timeout:180000});
  await page.waitForFunction(()=>[0,2,4].every(i=>NMS._planet(i).weatherStream?.ready),null,{timeout:60000});
  const records=await page.evaluate(async encoded=>{
    const THREE=NMS._THREE,renderer=NMS._renderer;
    const {CloudSunCache,cloudSunCacheSamplingGLSL}=await import('/src/cloud/cloud-sun-cache.js');
    const scene=new THREE.Scene(),camera=new THREE.Camera(),geometry=new THREE.PlaneGeometry(2,2);
    const vertex='varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}';
    const referenceTarget=new THREE.WebGLRenderTarget(4096,1,{type:THREE.FloatType,depthBuffer:false});
    const pointTarget=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,depthBuffer:false});
    const saved=renderer.getRenderTarget(),records=[];
    const range=(o,d,r,groundR)=>{
      const b=o.dot(d),radius=o.length(),discriminant=b*b-(radius-r)*(radius+r);
      let end=discriminant<0?0:Math.max(0,-b+Math.sqrt(discriminant));
      const ground=b*b-(radius-groundR)*(radius+groundR);
      if(ground>=0){const hit=-b-Math.sqrt(ground);if(hit>0)end=Math.min(end,hit);}return end;
    };
    for(const index of [0,2,4]) {
      const p=NMS._planet(index),source=p.volCloudMat;
      const prefix=source.fragmentShader.slice(0,source.fragmentShader.lastIndexOf('void main()'));
      const u={...source.uniforms,uOrigin:{value:new THREE.Vector3()},uRay:{value:new THREE.Vector3()},
        uLength:{value:0},uCount:{value:4096}};
      const reference=new THREE.ShaderMaterial({defines:{...source.defines},uniforms:u,vertexShader:vertex,
        fragmentShader:prefix+`uniform vec3 uOrigin,uRay;uniform float uLength,uCount;
          void main(){float t=gl_FragCoord.x/uCount*uLength;
            gl_FragColor=vec4(cloudExtinctionAt(uOrigin+uRay*t,0.0),0,0,1);}`,
        depthTest:false,depthWrite:false,blending:THREE.NoBlending});
      const mesh=new THREE.Mesh(geometry,reference);scene.add(mesh);
      for(const column of [0,7,11]) {
        const y=1-2*(column+.5)/16,a=column*2.399963229728653;
        const radial=new THREE.Vector3(Math.cos(a)*Math.sqrt(1-y*y),y,Math.sin(a)*Math.sqrt(1-y*y));
        const tangent=new THREE.Vector3().crossVectors(radial,new THREE.Vector3(0,1,0)).normalize();
        const sun=radial.clone().multiplyScalar(.4).addScaledVector(tangent,Math.sqrt(1-.4*.4));
        const originalSun=source.uniforms.uSunDir.value.clone(),originalSecond=source.uniforms.uSecondarySunDir.value.clone();
        source.uniforms.uSunDir.value.copy(sun);source.uniforms.uSecondarySunDir.value.copy(radial);
        const center=radial.clone().multiplyScalar(p.R+Math.max(0,p.weatherField.surfaceAt(radial))+3000);
        const cache=new CloudSunCache(p,center,{size:128,spacing:100,depth:96,verticalSpacing:50,
          encodeOpticalDepth:encoded});
        while(!cache.ready)cache.bakeSlice(renderer,{boundaryRows:8,slices:8});
        source.uniforms.uSunDir.value.copy(originalSun);source.uniforms.uSecondarySunDir.value.copy(originalSecond);
        const sampleUniforms={uCache:{value:cache.target.texture},uCoordinate:{value:new THREE.Vector3()}};
        const sample=new THREE.ShaderMaterial({uniforms:sampleUniforms,vertexShader:vertex,
          fragmentShader:'uniform sampler2D uCache;uniform vec3 uCoordinate;'+cloudSunCacheSamplingGLSL+
            `void main(){float v=sampleCloudSunCache(uCache,uCoordinate,96.0);gl_FragColor=vec4(${encoded?'exp(-(exp(v*log(129.0))-1.0))':'exp(-v)'},0,0,1);}`,
          depthTest:false,depthWrite:false,blending:THREE.NoBlending});
        for(let field=0;field<4;field++)for(let i=0;i<16;i++) {
          const coordinate=new THREE.Vector3(.15+(i%4)*.23,.18+Math.floor(i/4)*.21,.12+((i*7)%16)*.05);
          // Hold the original body-radial physical points fixed when testing
          // an affine solar grid; changing the grid must not change the cases.
          const point=coordinate.clone().addScalar(-.5).multiply(new THREE.Vector3(4800,4800,4800))
            .applyMatrix3(cache.frames[2]).add(center);
          if(point.length()<source.uniforms.uGroundR.value)continue;
          const direction=field<2?cache.directions[field]:point.clone().normalize().multiplyScalar(field===2?1:-1);
          const length=range(point,direction,source.uniforms.uRout.value,source.uniforms.uGroundR.value);
          u.uOrigin.value.copy(point);u.uRay.value.copy(direction);u.uLength.value=length;
          const values=[];
          for(const count of [2048,4096]) {
            u.uCount.value=count;referenceTarget.setSize(count,1);mesh.material=reference;
            renderer.setRenderTarget(referenceTarget);renderer.render(scene,camera);
            const pixels=new Float32Array(count*4);renderer.readRenderTargetPixels(referenceTarget,0,0,count,1,pixels);
            let od=0;for(let j=0;j<count;j++) {
              if(pixels[j*4+3]!==1 || !Number.isFinite(pixels[j*4]))throw Error('Invalid production reference');
              od+=pixels[j*4]*length/count;
            }
            values.push({count,transmission:Math.exp(-od),opticalDepth:od});
          }
          const uvw=point.clone().applyMatrix4(cache.transforms[field]);
          const margin=cache.interiorMargins[field];
          if(uvw.x<margin || uvw.x>1-margin || uvw.y<margin || uvw.y>1-margin
            || uvw.z<.5/96 || uvw.z>1-.5/96)throw Error('Fixed case is outside valid cache support');
          sampleUniforms.uCoordinate.value.set((field+uvw.x)/4,uvw.y,uvw.z);
          mesh.material=sample;renderer.setRenderTarget(pointTarget);renderer.render(scene,camera);
          const pixel=new Float32Array(4);renderer.readRenderTargetPixels(pointTarget,0,0,1,1,pixel);
          if(pixel[3]!==1 || !Number.isFinite(pixel[0]))throw Error('Invalid production cache sample');
          records.push({index,column,field,sample:i,point:point.toArray(),values,transmission:pixel[0]});
        }
        sample.dispose();cache.dispose();
      }
      scene.remove(mesh);reference.dispose();
    }
    renderer.setRenderTarget(saved);geometry.dispose();referenceTarget.dispose();pointTarget.dispose();
    if(renderer.getContext().getError()!==0)throw Error('WebGL error');return records;
  },encoded).catch(error=>{console.error(errors);throw error;});
  const metrics={cases:records.length,attenuated:records.filter(r=>r.values[1].transmission<.9).length,
    maximumReferenceError:Math.max(...records.map(r=>Math.abs(r.values[1].transmission-r.values[0].transmission))),
    maximumError:Math.max(...records.map(r=>Math.abs(r.transmission-r.values[1].transmission)))};
  await mkdir('test-results/b4-sun-cache-production',{recursive:true});
  await writeFile(`test-results/b4-sun-cache-production/${encoded?'r8-optical-depth':'report'}.json`,JSON.stringify({encoded,fingerprint:await evidenceFingerprint('tools/b4suncacheproductiontest.js'),metrics,records,errors},null,2));
  console.log(JSON.stringify({metrics,errors},null,2));assert.deepEqual(errors,[]);assert.ok(metrics.attenuated>24);
  assert.ok(metrics.maximumReferenceError<.01,'Independent reference must converge');
  assert.ok(metrics.maximumError<.05,'Transport cache must preserve actual cloud sunlight');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
