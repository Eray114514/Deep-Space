// Compare the production and surface sunlight consumers against independently
// accumulated density readback. Matching two consumers alone is insufficient.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
const {server,port}=await startServer(0);let browser;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&freeze=1&time=9.5&quality=ultra&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted',null,{timeout:180000});
  await page.waitForFunction(()=>[0,2,4].every(i=>{
    const p=NMS._planet(i);return p.weatherStream?.ready
      && Math.abs(p.cloudSpeciesTex.userData.hours-p.weatherHours)<1/300;
  }),null,{timeout:60000});
  const records=await page.evaluate(async()=>{
    const THREE=NMS._THREE,renderer=NMS._renderer;
    const {surfaceCloudGLSL,surfaceCloudUniforms}=await import('/src/cloud/surface-clouds.js');
    const {weatherAtlasGLSL}=await import('/src/cloud/weather-atlas.js');
    const scene=new THREE.Scene(),camera=new THREE.Camera(),geometry=new THREE.PlaneGeometry(2,2);
    const vertex='varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}';
    const target=new THREE.WebGLRenderTarget(4096,1,{type:THREE.FloatType,depthBuffer:false});
    const one=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,depthBuffer:false});
    const saved=renderer.getRenderTarget(),records=[];
    const sphereEnd=(origin,direction,r,groundR)=>{
      const b=origin.dot(direction),d=b*b-origin.lengthSq()+r*r;
      if(origin.length()<=groundR)return 0;
      let end=d<0?0:Math.max(0,-b+Math.sqrt(d));
      const ground=b*b-origin.lengthSq()+groundR*groundR;
      if(ground>=0) {
        const hit=-b-Math.sqrt(ground);
        if(hit>0)end=Math.min(end,hit);
      }
      return end;
    };
    for(const index of [0,2,4]) {
      const p=NMS._planet(index),source=p.volCloudMat;
      const uniforms={...source.uniforms,uOrigin:{value:new THREE.Vector3()},uDirection:{value:new THREE.Vector3()},
        uLength:{value:0},uCount:{value:4096},uReferenceWidth:{value:4096}};
      const prefix=source.fragmentShader.slice(0,source.fragmentShader.lastIndexOf('void main()'));
      const declarations='uniform vec3 uOrigin,uDirection;uniform float uLength,uCount,uReferenceWidth;';
      const reference=new THREE.ShaderMaterial({defines:{...source.defines},uniforms,vertexShader:vertex,
        fragmentShader:prefix+declarations+`void main(){float i=floor(gl_FragCoord.y)*uReferenceWidth+gl_FragCoord.x;
          float t=i/uCount*uLength;
          gl_FragColor=vec4(cloudExtinctionAt(uOrigin+uDirection*t,0.0),0,0,1);}`});
      const beam=new THREE.ShaderMaterial({defines:{...source.defines},uniforms,vertexShader:vertex,
        fragmentShader:prefix+declarations+'void main(){float transmission=exp(-cloudSunOpticalDepth(uOrigin,uDirection,0.0));gl_FragColor=vec4(transmission,cloudBeamIterations,cloudBeamDensitySamples,1);}'});
      const unaccelerated=beam.clone();unaccelerated.uniforms={...uniforms,uCandidatesReady:{value:0}};
      unaccelerated.fragmentShader=unaccelerated.fragmentShader.replace(
        /vec4 bounds=textureLod\(uBandBounds,[\s\S]*?return uMediumLayer[^;]+;/,
        'return vec2(-uSurfaceRange,uRout-uBodyR);');
      const surface=new THREE.ShaderMaterial({defines:{SURFACE_CLOUD_MEDIUM:1},uniforms:{...surfaceCloudUniforms(p),
        uOrigin:uniforms.uOrigin,uDirection:uniforms.uDirection},vertexShader:vertex,
        fragmentShader:weatherAtlasGLSL+surfaceCloudGLSL+declarations+
          'void main(){gl_FragColor=vec4(surfaceCloudTransmission(uOrigin,uDirection),0,0,1);}'});
      const mesh=new THREE.Mesh(geometry,reference);scene.add(mesh);
      for(let i=0;i<16;i++) {
        const y=1-2*(i+.5)/16,a=i*2.399963229728653;
        const radial=new THREE.Vector3(Math.cos(a)*Math.sqrt(1-y*y),y,Math.sin(a)*Math.sqrt(1-y*y));
        const tangent=new THREE.Vector3().crossVectors(radial,new THREE.Vector3(0,1,0)).normalize();
        const directions=[-1,-.4,0,.08,.4,1].map(mu=>({kind:'controlled',mu,
          direction:tangent.clone().multiplyScalar(Math.sqrt(1-mu*mu)).addScaledVector(radial,mu)}));
        for(const star of p.stellarLightField.sources)directions.push({kind:star.id,
          direction:star.localDirection.clone(),mu:radial.dot(star.localDirection)});
        for(const {mu,direction,kind} of directions) {
          const height=Math.max(0,p.weatherField.surfaceAt(radial))+20;
          const origin=radial.clone().multiplyScalar(p.R+height);
          uniforms.uOrigin.value.copy(origin);uniforms.uDirection.value.copy(direction);
          uniforms.uLength.value=sphereEnd(origin,direction,source.uniforms.uRout.value,source.uniforms.uGroundR.value);
          const values=[];
          // A fixed 4096 samples is not a reference for a million-metre
          // grazing path. Resolve horizontal structure to 80 / 40 metres,
          // with several strips when the texture width limit is reached.
          const baseCount=Math.max(8192,Math.ceil(uniforms.uLength.value/40));
          for(const count of [baseCount,baseCount*2]) {
            const width=Math.min(4096,count),height=Math.ceil(count/width);
            uniforms.uCount.value=count;uniforms.uReferenceWidth.value=width;
            target.setSize(width,height);mesh.material=reference;
            renderer.setRenderTarget(target);renderer.render(scene,camera);
            const pixels=new Float32Array(width*height*4);renderer.readRenderTargetPixels(target,0,0,width,height,pixels);
            let od=0;for(let j=0;j<count;j++) {
              if(pixels[j*4+3]!==1 || !Number.isFinite(pixels[j*4]))throw Error(`Invalid density readback ${index}/${i}/${mu}/${j}: ${Array.from(pixels.slice(j*4,j*4+4))}`);
              od+=pixels[j*4]*uniforms.uLength.value/count;
            }
            values.push({count,transmission:Math.exp(-od),opticalDepth:od});
          }
          const output=[],cost=[];
          for(const material of [beam,surface,unaccelerated]) {
            mesh.material=material;renderer.setRenderTarget(one);renderer.render(scene,camera);
            const pixel=new Float32Array(4);renderer.readRenderTargetPixels(one,0,0,1,1,pixel);
            if(pixel[3]!==1 || !Number.isFinite(pixel[0]))throw Error('Invalid sunlight readback');
            output.push(pixel[0]);cost.push({iterations:pixel[1],densitySamples:pixel[2]});
          }
          records.push({index,column:i,height,mu,kind,steps:source.uniforms.uCloudLightSteps.value,values,
            shell:[source.uniforms.uRin.value-p.R,source.uniforms.uRout.value-p.R],
            volume:output[0],surface:output[1],unaccelerated:output[2],cost});
        }
      }
      scene.remove(mesh);reference.dispose();beam.dispose();surface.dispose();unaccelerated.dispose();
    }
    renderer.setRenderTarget(saved);geometry.dispose();target.dispose();one.dispose();
    if(renderer.getContext().getError()!==0)throw Error('WebGL error');return records;
  }).catch(error=>{console.error(errors);throw error;});
  const maximum=key=>Math.max(...records.map(key));
  const metrics={cases:records.length,
    referenceError:maximum(r=>Math.abs(r.values[1].transmission-r.values[0].transmission)),
    consumerError:maximum(r=>Math.abs(r.volume-r.surface)),
    accelerationError:maximum(r=>Math.abs(r.volume-r.unaccelerated)),
    parameterError:maximum(r=>Math.abs(r.surface-r.unaccelerated)),
    beamError:maximum(r=>Math.abs(r.volume-r.values[1].transmission)),
    attenuated:records.filter(r=>r.values[1].transmission<.9).length,
    acceleratedDensitySamples:records.reduce((sum,r)=>sum+r.cost[0].densitySamples,0),
    unacceleratedDensitySamples:records.reduce((sum,r)=>sum+r.cost[2].densitySamples,0)};
  await mkdir('test-results/b4-sunbeam',{recursive:true});
  await writeFile('test-results/b4-sunbeam/report.json',JSON.stringify({fingerprint:await evidenceFingerprint('tools/b4sunbeamtest.js'),metrics,records,errors},null,2));
  console.log(JSON.stringify({metrics,errors},null,2));
  assert.deepEqual(errors,[]);assert.ok(metrics.attenuated>24);
  assert.ok(metrics.referenceError<.01,'Independent reference must converge');
  assert.ok(metrics.consumerError<.005,'Sunlight consumers disagree');
  assert.ok(metrics.accelerationError<.005,'Empty traversal changed integrated transmission');
  assert.ok(metrics.beamError<.05,'Production sunlight misses actual cloud extinction');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
