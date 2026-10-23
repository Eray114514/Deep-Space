// Real terrain CPU comparison and real cloud program/cache attribution.
// This is local attribution, not normal-player whole-frame acceptance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const reference='f003166';
const original=file=>execFileSync('git',['show',`${reference}:${file}`],{encoding:'utf8'});
const fingerprint=await evidenceFingerprint('tools/foundationstreamperftest.js');
const {server,port}=await startServer(0);let browser;
const out='test-results/foundation-stream';
await mkdir(out,{recursive:true});
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath() || undefined,headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/src/scatter-reference.js',route=>route.fulfill({contentType:'text/javascript',body:original('src/scatter.js')}));
  await page.route('**/src/cloud/cloud-light-bank-reference.js',route=>route.fulfill({contentType:'text/javascript',body:original('src/cloud/cloud-light-bank.js')}));
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&freeze=1&time=9.5&scene=walk&planet=0&bias=meadow&quality=balanced&vclouds=0&nolock=1`);
  await page.waitForFunction(()=>window.NMS?.booted,null,{timeout:150000});
  const near=await page.evaluate(async()=>{
    const {Scatter}=await import('/src/scatter.js'),{Scatter:Reference}=await import('/src/scatter-reference.js');
    const T=NMS._THREE,p=NMS._planet(0),direction=new T.Vector3(...NMS.referenceState().playerLocal).normalize(),Q=p.R/9;
    const fields=[new Reference({grassDensity:.82,grassRadius:45}),new Scatter({grassDensity:.82,grassRadius:45})];
    const previous=NMS._pipeline.submitFrame;NMS._pipeline.submitFrame=()=>false;
    const records=[];
    const snapshot=s=>Object.fromEntries(Object.entries(s.meshes).map(([kind])=>[kind,
      {count:s.job.counts[kind],matrix:Array.from(s.staging[kind].matrix.subarray(0,s.job.counts[kind]*16)),
        color:Array.from(s.staging[kind].color.subarray(0,s.job.counts[kind]*3))}]));
    let expected,exact=true;
    try {
      fields.forEach(s=>s.setPlanet(p));
      for(let run=0;run<14;run++)for(const index of run%2?[1,0]:[0,1]) {
        const s=fields[index];s.beginJob(p,Math.round(direction.x*Q),Math.round(direction.y*Q),Math.round(direction.z*Q),Q,9/p.R);
        const calls=[];let done=false;
        while(!done) {const start=performance.now();done=s.stepJob(start+1.8);calls.push(performance.now()-start);}
        const state=snapshot(s);
        expected ||= JSON.stringify(state);exact &&= JSON.stringify(state)===expected;
        if(run>=2)records.push({run,implementation:index?'current':'reference',calls,
          total:calls.reduce((a,b)=>a+b,0),counts:s.job.counts});
      }
    } finally {fields.forEach(s=>s.clear());NMS._pipeline.submitFrame=previous;}
    return {records,exact,direction:direction.toArray(),budgetMs:1.8};
  });
  assert.equal(near.exact,true,'The real terrain build changed matrices, colours or counts');
  console.log('Near terrain: exact before/after content across 24 measured rings.');
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&freeze=1&time=9.5&quality=low&vclouds=1&nolock=1`);
  await page.waitForFunction(()=>window.NMS?.booted,null,{timeout:150000});
  await page.evaluate(()=>{NMS._pipeline.submitFrame=()=>false;});
  await page.waitForFunction(()=>NMS._planet(0).weatherStream?.ready,null,{timeout:60000});
  const cloud=await page.evaluate(async()=>{
    const {CloudLightBank}=await import('/src/cloud/cloud-light-bank.js');
    const {CloudLightBank:Reference}=await import('/src/cloud/cloud-light-bank-reference.js');
    const T=NMS._THREE,r=NMS._renderer,gl=r.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if(!ext)throw Error('GPU timer required');
    const p=NMS._planet(0),u=p.volCloudMat.uniforms;
    const cameraLocal=u.uSunDir.value.clone().normalize().multiplyScalar(p.R+4000);
    const programsBefore=r.info.programs.length,createProgram=gl.createProgram;
    let created=0;gl.createProgram=function(...args){created++;return createProgram.apply(this,args);};
    const records=[];
    const read=bank=>{
      const target=new T.WebGLRenderTarget(bank.target.width,bank.target.height,{depthBuffer:false});
      const geometry=new T.PlaneGeometry(2,2),scene=new T.Scene(),camera=new T.Camera();
      const material=new T.ShaderMaterial({uniforms:{tCache:{value:bank.target.texture}},
        vertexShader:'varying vec2 vUV;void main(){vUV=uv;gl_Position=vec4(position.xy,0,1);}',
        fragmentShader:'uniform sampler2D tCache;varying vec2 vUV;void main(){gl_FragColor=vec4(texture2D(tCache,vUV).rrr,1);}',
        depthTest:false,depthWrite:false});scene.add(new T.Mesh(geometry,material));
      const saved=r.getRenderTarget();r.setRenderTarget(target);r.render(scene,camera);
      const pixels=new Uint8Array(target.width*target.height*4);r.readRenderTargetPixels(target,0,0,target.width,target.height,pixels);
      r.setRenderTarget(saved);target.dispose();material.dispose();geometry.dispose();return Array.from(pixels);
    };
    let expected,exact=true,maximumByteError=0,changedBytes=0;
    try {
      // Reverse the order for a second pair; separate first-use driver costs
      // from repeat submissions rather than treating the warm path as cold.
      for(const [run,name,Bank] of [[0,'reference',Reference],[0,'current',CloudLightBank],
        [1,'current',CloudLightBank],[1,'reference',Reference]]) {
        // Main-loop camera uniforms continue updating while GPU queries await.
        // Restore the same diagnostic pose for each independent bank.
        u.uCameraLocal.value.copy(cameraLocal);
        const bank=new Bank(p,{size:16,depth:8});
        const hours=p.weatherHours,before=created,q=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,q);
        const drawsBefore=r.info.render.calls,start=performance.now();bank.update(r);
        const submissionMs=performance.now()-start,draws=r.info.render.calls-drawsBefore;
        gl.endQuery(ext.TIME_ELAPSED_EXT);gl.flush();
        while(!gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE))await new Promise(resolve=>setTimeout(resolve,5));
        if(gl.getParameter(ext.GPU_DISJOINT_EXT))throw Error('Disjoint timing');
        const gpuMs=gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6;gl.deleteQuery(q);
        const startupPrograms=created-before;
        const pending=[...bank.maps.values()].find(c=>!c.ready),beforeForecast=created;
        while(!pending.ready)pending.bakeSlice(r,{boundaryRows:16,slices:8});
        const forecastPrograms=created-beforeForecast;
        const bytes=read(bank);
        if(expected)for(let i=0;i<bytes.length;i++) {
          const difference=Math.abs(bytes[i]-expected[i]);maximumByteError=Math.max(maximumByteError,difference);
          if(difference)changedBytes++;
        }
        expected ||= bytes;exact &&= maximumByteError===0;
        records.push({run,implementation:name,submissionMs,gpuMs,draws,startupPrograms,forecastPrograms,
          leases:bank.programs?Object.keys(bank.programs).length:0,ready:u.uSunCacheReady.value,bytes:bytes.length,hours,endHours:p.weatherHours,center:bank.center.toArray()});
        bank.dispose();
        if(r.info.programs.length!==programsBefore)throw Error('Bank program lease leaked after disposal');
      }
      const textures=[p.cloudSpeciesTex,p.cloudShadowTex,p.cloudWeatherHiTex];
      const versions=textures.map(t=>t.version);p.weatherStream.update(p.weatherHours,true);
      const duplicateUpload=textures.some((t,i)=>t.version!==versions[i]);
      return {records,exact,maximumByteError,changedBytes,duplicateUpload,gl:gl.getError(),programsBefore,programsAfter:r.info.programs.length,
        renderer:gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL),
        scope:'16x16x8 physical cache at fixed absolute time; not production 128 cube or whole-player performance'};
    } finally {gl.createProgram=createProgram;}
  });
  await writeFile(`${out}/diagnostic.json`,JSON.stringify({near,cloud,errors},null,2));
  console.log('Cloud diagnostic',JSON.stringify(cloud));
  assert.equal(cloud.exact,true,'Program retention changed the cache pixels');
  assert.equal(cloud.duplicateUpload,false);assert.equal(cloud.gl,0);assert.deepEqual(errors,[]);
  for(const run of [0,1]) {
    const old=cloud.records.find(r=>r.run===run && r.implementation==='reference');
    const current=cloud.records.find(r=>r.run===run && r.implementation==='current');
    assert.ok(current.startupPrograms<old.startupPrograms,'Repeated endpoint program creation persists');
    assert.equal(current.forecastPrograms,0,'Prefetch must reuse the bank program');
  }
  const summarize=implementation=>{
    const rows=near.records.filter(r=>r.implementation===implementation),calls=rows.flatMap(r=>r.calls).sort((a,b)=>a-b);
    const totals=rows.map(r=>r.total).sort((a,b)=>a-b);
    return {p50Ms:calls[Math.floor(calls.length*.5)],p95Ms:calls[Math.floor(calls.length*.95)],maximumMs:calls.at(-1),
      totalMedianMs:totals[Math.floor(totals.length*.5)],rings:rows.length,instanceCounts:rows[0].counts};
  };
  const final=await evidenceFingerprint('tools/foundationstreamperftest.js');
  const report={fingerprint,stableSource:fingerprint.sourceDigest===final.sourceDigest,reference,
    near:{...near,summary:{reference:summarize('reference'),current:summarize('current')}},cloud,errors};
  await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({near:report.near.summary,cloud},null,2));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
