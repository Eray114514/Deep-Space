// Reprojection against actual absolute-time weather and stellar directions.
// No production binding is authorized by a static cache test alone.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
const {server,port}=await startServer(0);let browser;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&freeze=1&time=9.5&quality=ultra&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted',null,{timeout:180000});
  const records=await page.evaluate(async()=>{
    const {CloudSunCache,cloudSunCacheSamplingGLSL}=await import('/src/cloud/cloud-sun-cache.js');
    const THREE=NMS._THREE,r=NMS._renderer,scene=new THREE.Scene(),camera=new THREE.Camera();
    const geometry=new THREE.PlaneGeometry(2,2),target=new THREE.WebGLRenderTarget(4096,1,{type:THREE.FloatType,depthBuffer:false});
    const one=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,depthBuffer:false});
    const saved=r.getRenderTarget(),records=[];
    const vertex='varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}';
    const setTime=async(p,h)=>{
      NMS.setTime(h);const deadline=performance.now()+60000;
      while(!p.weatherStream?.ready){if(performance.now()>deadline)throw Error('Weather forecast not ready');await new Promise(resolve=>setTimeout(resolve,5));}
      p.weatherStream.update(h,true);
      if(Math.abs(p.cloudSpeciesTex.userData.hours-h)>1e-9)throw Error('Weather transaction did not commit');
      const spin=p.cloudSpinBase+h*p.weatherField.windRadiansPerHour;
      p.volCloudMat.uniforms.uSpin.value.setFromMatrix4(new THREE.Matrix4().makeRotationY(-spin));
    };
    for(const index of [0,2,4]) {
      const p=NMS._planet(index),source=p.volCloudMat;
      await setTime(p,9.5);
      const prefix=source.fragmentShader.slice(0,source.fragmentShader.lastIndexOf('void main()'));
      const u={...source.uniforms,uOrigin:{value:new THREE.Vector3()},uRay:{value:new THREE.Vector3()},uLength:{value:0},uCount:{value:4096}};
      const reference=new THREE.ShaderMaterial({defines:source.defines,uniforms:u,vertexShader:vertex,
        fragmentShader:prefix+'uniform vec3 uOrigin,uRay;uniform float uLength,uCount;void main(){float t=gl_FragCoord.x/uCount*uLength;gl_FragColor=vec4(cloudExtinctionAt(uOrigin+uRay*t,0.0),0,0,1);}',depthTest:false,depthWrite:false});
      const mesh=new THREE.Mesh(geometry,reference);scene.add(mesh);
      for(const solarCosine of [.4,1]) {
        await setTime(p,9.5);
        const sun=source.uniforms.uSunDir.value.clone().normalize();
        const tangent=new THREE.Vector3().crossVectors(sun,new THREE.Vector3(0,1,0)).normalize();
        const radial=sun.clone().multiplyScalar(solarCosine).addScaledVector(tangent,Math.sqrt(1-solarCosine*solarCosine));
        const center=radial.clone().multiplyScalar(p.R+Math.max(0,p.weatherField.surfaceAt(radial))+3000);
        const cache=new CloudSunCache(p,center,{size:96,depth:128});cache.available[1]=false;
        while(!cache.ready)cache.bakeSlice(r,{boundaryRows:32,slices:32});
        const sampleU={uCache:{value:cache.target.texture},uCoordinate:{value:new THREE.Vector3()}};
        const sample=new THREE.ShaderMaterial({uniforms:sampleU,vertexShader:vertex,
          fragmentShader:'uniform sampler2D uCache;uniform vec3 uCoordinate;'+cloudSunCacheSamplingGLSL+
            'void main(){gl_FragColor=vec4(exp(-sampleCloudSunCache(uCache,uCoordinate,128.0)),0,0,1);}',depthTest:false,depthWrite:false});
        for(const delta of [0,.003,.006,.012,.024]) {
          await setTime(p,9.5+delta);
          const advect=new THREE.Matrix4().makeRotationY(delta*p.weatherField.windRadiansPerHour),unadvect=advect.clone().invert();
          for(const field of [0,2,3])for(let i=0;i<8;i++) {
            const oldPoint=new THREE.Vector3(-900+(i%4)*600,i<4?-900:900,-1100+((i*7)%5)*500)
              .applyMatrix3(cache.frames[2]).add(center);
            const point=oldPoint.clone().applyMatrix4(advect);
            if(point.length()<u.uGroundR.value)continue;
            const direction=field===0?source.uniforms.uSunDir.value.clone().normalize():point.clone().normalize().multiplyScalar(field===2?1:-1);
            const mappedDirection=direction.clone().transformDirection(unadvect);
            const angle=field===0?mappedDirection.angleTo(cache.directions[0]):0;
            const b=point.dot(direction),radius=point.length(),R=u.uRout.value;
            let end=Math.max(0,-b+Math.sqrt(Math.max(0,b*b-(radius-R)*(radius+R))));
            const g=u.uGroundR.value,disc=b*b-(radius-g)*(radius+g);
            if(disc>=0){const hit=-b-Math.sqrt(disc);if(hit>0)end=Math.min(end,hit);}
            u.uOrigin.value.copy(point);u.uRay.value.copy(direction);u.uLength.value=end;
            const transmissions=[];
            for(const count of [2048,4096]) {
              u.uCount.value=count;target.setSize(count,1);mesh.material=reference;r.setRenderTarget(target);r.render(scene,camera);
              const pixels=new Float32Array(count*4);r.readRenderTargetPixels(target,0,0,count,1,pixels);
              let tau=0;for(let k=0;k<count;k++){if(pixels[k*4+3]!==1)throw Error('Invalid reference');tau+=pixels[k*4]*end/count;}
              transmissions.push(Math.exp(-tau));
            }
            const uv=point.clone().applyMatrix4(unadvect).applyMatrix4(cache.transforms[field]),margin=cache.interiorMargins[field];
            if(uv.x<margin || uv.x>1-margin || uv.y<margin || uv.y>1-margin || uv.z<.5/128 || uv.z>1-.5/128)throw Error('Test outside valid support');
            sampleU.uCoordinate.value.set((field+uv.x)/4,uv.y,uv.z);
            mesh.material=sample;r.setRenderTarget(one);r.render(scene,camera);
            const pixel=new Float32Array(4);r.readRenderTargetPixels(one,0,0,1,1,pixel);
            if(pixel[3]!==1)throw Error('Invalid cache sample');
            records.push({index,solarCosine,delta,field,i,angle,transmissions,cache:pixel[0],error:Math.abs(pixel[0]-transmissions[1])});
          }
        }
        sample.dispose();cache.dispose();
      }
      reference.dispose();scene.remove(mesh);
    }
    r.setRenderTarget(saved);geometry.dispose();target.dispose();one.dispose();
    if(r.getContext().getError())throw Error('GPU error');return records;
  });
  const groups=[0,.003,.006,.012,.024].map(delta=>{const rows=records.filter(r=>r.delta===delta);return {delta,cases:rows.length,
    attenuated:rows.filter(r=>r.transmissions[1]<.9).length,maximum:Math.max(...rows.map(r=>r.error)),
    maximumAngle:Math.max(...rows.map(r=>r.angle)),referenceError:Math.max(...rows.map(r=>Math.abs(r.transmissions[0]-r.transmissions[1])))};});
  await mkdir('test-results/b4-sun-cache-motion',{recursive:true});
  await writeFile('test-results/b4-sun-cache-motion/report.json',JSON.stringify({fingerprint:await evidenceFingerprint('tools/b4suncachemotiontest.js'),groups,records,errors},null,2));
  console.log(JSON.stringify({groups,errors},null,2));assert.deepEqual(errors,[]);
  assert.ok(groups.every(g=>g.referenceError<.01));
  assert.ok(groups[0].maximum<.05,'Static actual solar directions must pass before motion');
  assert.ok(groups.every(g=>g.maximum<.05),
    'Dynamic cache lookup must preserve actual transport; stale reprojection cannot be bound to production');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
