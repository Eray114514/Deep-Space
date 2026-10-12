// Attribution only. Preserve actual occupied rays/quantiles and air control
// flow; replace radiance with counters. No diagnostic shader ships in src.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const out='test-results/cloud-air-paths',before=await evidenceFingerprint('tools/cloudairpathdiag.js');
const {server,port}=await startServer(0);let browser;
await mkdir(out,{recursive:true});const errors=[];
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:720}});
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=lowflight&alt=400&planet=0&bias=meadow&quality=balanced&vclouds=1&post=1`);
  await page.waitForFunction(()=>NMS?.booted,null,{timeout:180000});
  await page.evaluate(()=>NMS.setAdaptiveQualityLocked(true));
  await page.waitForFunction(()=>NMS._pipeline.volumePass.frame>4,null,{timeout:180000});
  await page.screenshot({path:`${out}/player.png`});
  console.log('Normal lowflight composed; counting actual air branches at fixed jitter.');
  const result=await page.evaluate(async()=>{
    const T=NMS._THREE,r=NMS._renderer,vp=NMS._pipeline.volumePass,p=vp.activePlanet;
    const original=p.volCloudMat,probe=original.clone();
    probe.uniforms={...original.uniforms,uAirCounterField:{value:0}};
    const replace=(from,to)=>{
      if(!probe.fragmentShader.includes(from))throw Error('Air diagnostic drift: '+from);
      probe.fragmentShader=probe.fragmentShader.replace(from,to);
    };
    probe.fragmentShader='uniform int uAirCounterField;float diagnosticGaps=0.,diagnosticAdvances=0.,diagnosticFallbacks=0.,diagnosticSamples=0.,diagnosticHorizons=0.,diagnosticPartial=0.,diagnosticHiddenPartial=0.,diagnosticRemainders=0.;\n'+probe.fragmentShader;
    replace('float framePhase = mod(uFrame, 16.0);','float framePhase = 0.0;');
    const start=probe.fragmentShader.indexOf('vec3 cloudCombinedSource('),brace=probe.fragmentShader.indexOf('{',start);
    let end=brace+1,depth=1;
    while(depth){const c=probe.fragmentShader[end++];if(c==='{')depth++;if(c==='}')depth--;}
    probe.fragmentShader=probe.fragmentShader.slice(0,brace)+'{return local/uBodyR;}'+probe.fragmentShader.slice(end);
    const unified=probe.fragmentShader.includes('void cloudAirTransport(');
    if(unified){
      replace('if(air_uEnabled<0.5 || b<=a)return;', 'if(air_uEnabled<0.5 || b<=a)return;if(reuseCells)diagnosticAdvances+=1.;');
      replace('if(!gapReady) {','if(!gapReady) {diagnosticGaps+=1.;');
    } else {
      replace('if (air_uEnabled < 0.5 || b <= a) return;', 'if (air_uEnabled < 0.5 || b <= a) return;diagnosticGaps+=1.;');
      replace('if(air_uEnabled<0.5 || b<=a)return;', 'if(air_uEnabled<0.5 || b<=a)return;diagnosticAdvances+=1.;');
    }
    replace('if (air_uEnabled < 0.5 || altitude < 0.0 || altitude > air_uTopAltitude) return;',
      'if (air_uEnabled < 0.5 || altitude < 0.0 || altitude > air_uTopAltitude) return;diagnosticSamples+=1.;');
    const horizon=/crossing=crossing \|\| air_solarHorizonClearance\(start,sun\)\s*\*air_solarHorizonClearance\(end,sun\)<=0\.0;/;
    if(!horizon.test(probe.fragmentShader))throw Error('Horizon predicate changed');
    probe.fragmentShader=probe.fragmentShader.replace(horizon,
      'float h0=air_solarHorizonClearance(start,sun),h1=air_solarHorizonClearance(end,sun);bool horizon=h0*h1<=0.;if(horizon)diagnosticHorizons+=1.;crossing=crossing||horizon;');
    replace('crossing=crossing || min(v0,v1)<0.999 && max(v0,v1)>0.001;',
      'bool partial=min(v0,v1)<0.999 && max(v0,v1)>0.001;if(partial){diagnosticPartial+=1.;if(h0<0. && h1<0.)diagnosticHiddenPartial+=1.;}crossing=crossing||partial;');
    replace('if(crossing) {','if(crossing) {diagnosticFallbacks+=1.;');
    if(unified)replace('if(advanced>=64) {','if(advanced>=64) {diagnosticRemainders+=1.;');
    else replace('if(cursor<b) {','if(cursor<b) {diagnosticRemainders+=1.;');
    replace('void main() {','void diagnosticOriginalMain() {');
    probe.fragmentShader+='\nvoid main(){diagnosticOriginalMain();gl_FragColor=uAirCounterField==0?vec4(diagnosticGaps,diagnosticAdvances,diagnosticFallbacks,diagnosticSamples):vec4(diagnosticHorizons,diagnosticPartial,diagnosticHiddenPartial,diagnosticRemainders);}';
    probe.blending=T.NoBlending;probe.needsUpdate=true;
    const target=new T.WebGLRenderTarget(vp.width,vp.height,{type:T.FloatType,depthBuffer:false});
    const geometry=new T.PlaneGeometry(2,2),scene=new T.Scene(),camera=new T.Camera();
    const material=new T.ShaderMaterial({uniforms:{tInput:{value:vp.current.texture}},
      vertexShader:'varying vec2 vUV;void main(){vUV=uv;gl_Position=vec4(position.xy,0,1);}',
      fragmentShader:'uniform sampler2D tInput;varying vec2 vUV;void main(){gl_FragColor=texture2D(tInput,vUV);}',depthTest:false,depthWrite:false});
    scene.add(new T.Mesh(geometry,material));const records=[];
    p.volCloudMat=probe;vp.historyValid=false;
    try {
      for(const field of [0,1,0]) {
        probe.uniforms.uAirCounterField.value=field;
        const frame=vp.frame;
        while(vp.frame<frame+3)await new Promise(resolve=>requestAnimationFrame(resolve));
        const record=await new Promise((resolve,reject)=>requestAnimationFrame(()=>{
          const saved=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel();
          try {
            r.setRenderTarget(target);r.render(scene,camera);
            const data=new Float32Array(vp.width*vp.height*4);r.readRenderTargetPixels(target,0,0,vp.width,vp.height,data);
            const sum=[0,0,0,0],maximum=[0,0,0,0];let nonzero=0;
            for(let i=0;i<data.length;i+=4){let occupied=false;for(let c=0;c<4;c++){
              if(!Number.isFinite(data[i+c])||data[i+c]<0)throw Error('Invalid air counters');
              sum[c]+=data[i+c];maximum[c]=Math.max(maximum[c],data[i+c]);occupied ||= data[i+c]>0;
            }if(occupied)nonzero++;}
            const gl=r.getContext(),program=r.properties.get(probe).currentProgram.program;
            resolve({field,sum,maximum,nonzero,uploaded:gl.getUniform(program,gl.getUniformLocation(program,'uAirCounterField'))});
          } catch(error) {reject(error);} finally {r.setRenderTarget(saved,face,mip);}
        }));
        records.push(record);console.log('Air paths: '+JSON.stringify(record));
      }
      return {records,width:vp.width,height:vp.height,pose:NMS.referenceState(),gpu:NMS.stats().gpu,gl:r.getContext().getError(),
        uniforms:Object.fromEntries(['air_uViewSteps','air_uLocalStarCount','air_uLocalOccluderCount','air_uMieScaleHeight','air_uSunDirection0','air_uSunDirection1','air_uLocalStars','air_uLocalOccluders']
          .map(name=>[name,probe.uniforms[name].value])),
        scope:'Actual visible cloud rays and quantiles at fixed jitter. Field 0: positive gap calls, positive advance calls, shadow fallbacks, active air samples. Field 1: horizon-sign tests, partial endpoint eclipse tests, those partial tests with both endpoints below planetary horizon, 64-cell remainder fallbacks. Counters replace radiance; no timing or quality acceptance. Predicate classifications count active stars per candidate cell, not only short-circuit evaluations. Half-float counters must remain <=2048 for exact integer representation.'};
    } finally {
      p.volCloudMat=original;p.volCloudMesh.material=original;vp.historyValid=false;
      probe.dispose();target.dispose();geometry.dispose();material.dispose();
    }
  });
  const after=await evidenceFingerprint('tools/cloudairpathdiag.js');
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,result,errors},null,2));
  assert.equal(before.sourceDigest,after.sourceDigest);assert.deepEqual(errors,[]);assert.equal(result.gl,0);
  for(const record of result.records){assert.equal(record.field,record.uploaded);assert.ok(record.maximum.every(v=>v<=2048));}
  assert.deepEqual(result.records[0],result.records[2],'Repeated fixed-jitter counters must agree');
  assert.ok(result.records[0].nonzero>1000 && result.records[0].sum[1]>10000);
  console.log(`PASS air branch attribution health; ${out}`);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
