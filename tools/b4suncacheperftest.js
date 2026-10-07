// Measure real GPU submission costs at the proposed production cache size.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
const {server,port}=await startServer(0);let browser;
const options={noCopy:process.env.B4_CACHE_NO_COPY==='1',size:Number(process.env.B4_CACHE_SIZE||128),
  depth:Number(process.env.B4_CACHE_DEPTH||256),index:Number(process.env.B4_CACHE_BODY||0),
  cosine:Number(process.env.B4_CACHE_COSINE||1),shearSolar:process.env.B4_CACHE_SHEAR!=='0',
  encodeOpticalDepth:process.env.B4_CACHE_ENCODED==='1'};
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&freeze=1&time=9.5&quality=ultra&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted',null,{timeout:180000});
  await page.waitForFunction(i=>NMS._planet(i).weatherStream?.ready,options.index,{timeout:60000});
  const result=await page.evaluate(async(options)=>{
    const {CloudSunCache}=await import('/src/cloud/cloud-sun-cache.js');
    const THREE=NMS._THREE,r=NMS._renderer,gl=r.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if(!ext)throw Error('GPU timer required for cost evidence');
    const p=NMS._planet(options.index),u=p.volCloudMat.uniforms,sun=u.uSunDir.value.clone().normalize();
    const tangent=new THREE.Vector3().crossVectors(sun,new THREE.Vector3(0,1,0)).normalize();
    const radial=sun.clone().multiplyScalar(options.cosine).addScaledVector(tangent,Math.sqrt(1-options.cosine**2));
    const center=radial.clone().multiplyScalar(p.R+Math.max(0,p.weatherField.surfaceAt(radial))+3000);
    const cache=new CloudSunCache(p,center,options),batches=[];
    if(options.noCopy)cache.copyPlane=()=>{};
    // Isolate cache work. Other production consumers are measured separately;
    // they must not submit scene renders between diagnostic GPU queries.
    const previousRender=NMS._pipeline.render;NMS._pipeline.render=()=>{};
    let slices=8,rows=4;
    const started=performance.now();
    while(!cache.ready) {
      const field=cache.field,layer=cache.layer,boundary=cache.boundaryRow;
      const q=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,q);
      cache.bakeSlice(r,{boundaryRows:rows,slices});
      gl.endQuery(ext.TIME_ELAPSED_EXT);gl.flush();
      while(!gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE))await new Promise(resolve=>setTimeout(resolve,5));
      if(gl.getParameter(ext.GPU_DISJOINT_EXT))throw Error('Disjoint GPU timing');
      const ms=gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6;gl.deleteQuery(q);
      batches.push({field,layer,boundary,slices,rows,milliseconds:ms});
      // Query delay is diagnostic-only. Production must schedule from past
      // completed timing, never synchronously wait for a GPU result.
      if(ms>0) {
        if(boundary<cache.size && (layer===0 || layer===cache.depth-1))rows=Math.max(1,Math.min(32,Math.floor(rows*2/ms)));
        else slices=Math.max(1,Math.min(32,Math.floor(slices*2/ms)));
      }
    }
    NMS._pipeline.render=previousRender;
    const bytes=cache.target.width*cache.target.height*(cache.encodeOpticalDepth?1:2);
    cache.dispose();
    if(gl.getError())throw Error('Cache GPU error');
    return {options,diagnosticWithoutCopy:options.noCopy,renderer:gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL),
      width:cache.target.width,height:cache.target.height,depth:cache.depth,bytes,batches,elapsed:performance.now()-started,
      maximum:Math.max(...batches.map(b=>b.milliseconds)),total:batches.reduce((s,b)=>s+b.milliseconds,0)};
  },options);
  await mkdir('test-results/b4-sun-cache-perf',{recursive:true});
  const name=`p${options.index}-${options.size}x${options.depth}-${options.cosine}-${options.shearSolar?'shear':'radial'}-${options.noCopy?'render-only':'copy'}${options.encodeOpticalDepth?'-r8':''}`;
  await writeFile(`test-results/b4-sun-cache-perf/${name}.json`,JSON.stringify({fingerprint:await evidenceFingerprint('tools/b4suncacheperftest.js'),result,errors},null,2));
  console.log(JSON.stringify({batches:result.batches.length,maximum:result.maximum,total:result.total,
    elapsed:result.elapsed,renderer:result.renderer,errors}));
  assert.deepEqual(errors,[]);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
