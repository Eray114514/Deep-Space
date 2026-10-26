// Diagnostic only: replay complete captured native cloud programs without a
// game boot. Separate link completion waiting from the first uniform query.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const input=process.argv.find(a=>a.startsWith('--input='))?.slice(8)
  ||'docs/baselines/foundation-world-publication-2026-10-25/cloud-page/report.json.gz';
const direct=process.argv.includes('--direct');
const bindPosition=process.argv.includes('--bind-position');
const farOnly=process.argv.includes('--far-only');
const reportBytes=await readFile(input),source=JSON.parse(input.endsWith('.gz')?gunzipSync(reportBytes):reportBytes);
const probe=source.finalState?.probe||source.state?.probe;
const shaders=new Map(probe.shaders.map(s=>[s.id,s]));
const programs=probe.programs.map(p=>({...p,shaders:p.shaderIds.map(id=>shaders.get(id))}));
const selected=[1,0].map(far=>programs.find(p=>p.shaders.some(s=>s.type===35632
  &&s.source?.includes('uViewCapacity')&&s.source.includes(`#define CLOUD_FAR_VIEW ${far}`)
  &&s.source.includes('#define CLOUD_FAR_CACHE 0'))));
assert.ok(selected.every(Boolean),'Both real non-cache-only cloud programs required');
assert.ok(selected.every(p=>p.shaders.every(s=>!s.truncated&&s.source.length===s.sourceLength)));
const hash=b=>createHash('sha256').update(b).digest('hex');
const before=await evidenceFingerprint('tools/cloudprogramreadinessdiag.js');
const out=`test-results/cloud-program-readiness/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
await writeFile(`${out}/native-inputs.json.gz`,gzipSync(Buffer.from(JSON.stringify(selected)),{level:9}));
await writeFile(`${out}/verifier.js`,await readFile('tools/cloudprogramreadinessdiag.js'));
let browser;const errors=[],cases=[];
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  for(const input of (farOnly?selected.slice(0,1):selected)){
    const page=await browser.newPage({viewport:{width:1000,height:500}});
    page.on('pageerror',e=>errors.push(String(e)));
    await page.setContent('<canvas width="64" height="64"></canvas><pre>Compiling captured cloud program; timer remains active.</pre>');
    const result=await page.evaluate(async({input,direct,bindPosition})=>{
      const gl=document.querySelector('canvas').getContext('webgl2');
      if(!gl)throw Error('WebGL2 required');
      const ext=gl.getExtension('KHR_parallel_shader_compile');
      if(!ext)throw Error('Parallel compile extension required');
      const debug=gl.getExtension('WEBGL_debug_renderer_info');
      const gpu=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
      const started=performance.now(),gaps=[];let last=started,ticks=0,polls=0;
      const timer=setInterval(()=>{const now=performance.now();gaps.push(now-last);last=now;ticks++;
        document.querySelector('pre').textContent=`Pending ${Math.round(now-started)} ms; ${ticks} timer callbacks`;
      },20);
      const program=gl.createProgram(),shaderObjects=[];
      const submissionStart=performance.now();
      try {
        for(const s of input.shaders){const shader=gl.createShader(s.type);shaderObjects.push(shader);
          gl.shaderSource(shader,s.source);gl.compileShader(shader);gl.attachShader(program,shader);}
        if(bindPosition)gl.bindAttribLocation(program,0,'position');
        gl.linkProgram(program);
        const submissionMs=performance.now()-submissionStart;
        if(!direct)while(!gl.getProgramParameter(program,ext.COMPLETION_STATUS_KHR)){
          if(performance.now()-started>180000)throw Error('Original 180 second diagnostic deadline exceeded');
          polls++;await new Promise(resolve=>setTimeout(resolve,10));
        }
        const readyAtMs=performance.now()-started,reflectionStart=performance.now();
        const uniformCount=gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);
        const reflectionMs=performance.now()-reflectionStart;
        const linked=gl.getProgramParameter(program,gl.LINK_STATUS),log=gl.getProgramInfoLog(program);
        for(let i=0;i<uniformCount;i++)gl.getActiveUniform(program,i);
        await new Promise(resolve=>setTimeout(resolve,30));
        const result={gpu,sourceProgramId:input.id,far:input.shaders.some(s=>s.source.includes('#define CLOUD_FAR_VIEW 1')),
          direct,bindPosition,submissionMs,readyAtMs,reflectionMs,wallMs:performance.now()-started,uniformCount,linked,log,polls,ticks,
          maximumHeartbeatGapMs:Math.max(0,...gaps,performance.now()-last),gl:gl.getError(),lost:gl.isContextLost()};
        document.querySelector('pre').textContent=JSON.stringify(result,null,2);return result;
      }finally{clearInterval(timer);}
    },{input,direct,bindPosition});
    cases.push({...result,shaderHashes:input.shaders.map(s=>({type:s.type,sha256:hash(s.source)}))});
    assert.ok(result.linked&&!result.gl&&!result.lost);
    await page.screenshot({path:`${out}/${result.far?'far':'near'}.png`});
    console.log(JSON.stringify({...result,log:undefined,logChars:result.log.length}));await page.close();
  }
  const after=await evidenceFingerprint('tools/cloudprogramreadinessdiag.js');assert.deepEqual(after,before);assert.deepEqual(errors,[]);
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,input,inputSha256:hash(reportBytes),inputSourceDigest:source.sourceDigest,
    direct,bindPosition,farOnly,cases,errors,boundary:'Unchanged native source, fresh contexts. No draw, game, wall-cost reduction, or cold driver-cache acceptance.',passed:true},null,2));
  console.log(JSON.stringify({out,passed:true}));
}catch(error){await writeFile(`${out}/failure.json`,JSON.stringify({before,input,direct,cases,errors,error:String(error)},null,2));throw error;}
finally{await browser?.close();}
