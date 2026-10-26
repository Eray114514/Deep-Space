// Native ABI/first-use proof for the cloud preparation owner. The deliberately
// small shader distinguishes CACHE0/1 exactly; the real cloud page is separate.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const out=`test-results/cloud-program-gpu/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
const before=await evidenceFingerprint('tools/cloudprogrampreparationgputest.js');
await writeFile(`${out}/verifier.js`,await readFile('tools/cloudprogrampreparationgputest.js'));
const {server,port}=await startServer(0);let browser;const errors=[],cases=[];
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  for(const mode of ['reference','candidate']){
    const page=await browser.newPage({viewport:{width:800,height:540}});
    page.on('pageerror',e=>errors.push(String(e)));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.route('**/cloud-program-fixture.html',r=>r.fulfill({contentType:'text/html',body:
      '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script><style>body{background:#14202b;color:white;font:16px sans-serif}canvas{width:384px;height:384px;image-rendering:pixelated}</style><p>Cloud program CACHE families: controlled native HDR fixture</p><canvas></canvas><pre></pre>'}));
    await page.goto(`http://127.0.0.1:${port}/cloud-program-fixture.html`);
    const result=await page.evaluate(async mode=>{
      const T=await import('three'),{CloudProgramPreparation}=await import('/src/cloud-program-preparation.js');
      const {compilePrograms}=await import('/src/program-preparation.js');
      const {installProgramRetirement}=await import('/src/program-retirement.js');
      const renderer=new T.WebGLRenderer({canvas:document.querySelector('canvas')});renderer.setSize(96,96);
      const retirement=installProgramRetirement(renderer);
      const gl=renderer.getContext(),camera=new T.PerspectiveCamera(60,1,.1,20);camera.layers.set(2);
      const scene=new T.Scene(),geometry=new T.PlaneGeometry(2,2);
      const material=new T.ShaderMaterial({defines:{CLOUD_FAR_VIEW:1,CLOUD_FAR_CACHE:0},depthTest:false,depthWrite:false,
        transparent:false,toneMapped:false,uniforms:{uValue:{value:1.25}},
        vertexShader:'varying vec2 vUV;void main(){vUV=uv;gl_Position=vec4(position.xy,0.,1.);}',
        fragmentShader:'varying vec2 vUV;uniform float uValue;void main(){\n#if CLOUD_FAR_CACHE == 1\n gl_FragColor=vec4(2.125,vUV.x,0.375,1.);\n#else\n gl_FragColor=vec4(vUV.y,uValue,0.625,1.);\n#endif\n}'});
      const other=material.clone();other.defines.CLOUD_FAR_VIEW=0;
      const mesh=new T.Mesh(geometry,other);mesh.layers.set(2);mesh.frustumCulled=false;scene.add(mesh);
      const target=new T.WebGLRenderTarget(96,96,{type:T.HalfFloatType,depthBuffer:false});
      const caller=new T.WebGLRenderTarget(8,8,{type:T.HalfFloatType,depthBuffer:false});renderer.setRenderTarget(caller);
      const sources=new Map(),compile=gl.compileShader,shaderSource=gl.shaderSource;
      const links=[],link=gl.linkProgram;
      gl.shaderSource=function(shader,text){sources.set(shader,text);return shaderSource.call(this,shader,text);};
      gl.compileShader=function(...args){return compile.apply(this,args);};
      gl.linkProgram=function(program){links.push(program);return link.call(this,program);};
      let heldResolve,held=new Promise(resolve=>{heldResolve=resolve;}),actualReady=0,scopes=0;
      const owner=new CloudProgramPreparation(renderer,{prepare:async(work,{isCurrent})=>{
        if(!isCurrent())throw Error('Unexpected obsolete fixture');const pending=work();
        if(renderer.getRenderTarget()!==caller||material.defines.CLOUD_FAR_CACHE!==0||mesh.material!==other)throw Error('Live state lease escaped compile');
        scopes++;const result=await pending;actualReady++;await held;return result;
      }});
      const config={scene,camera,target,requests:[{mesh,material,cacheVariants:[0,1]}]};
      let beforeReady;
      if(mode==='candidate'){
        if(owner.ensure(config)!==false)throw Error('Pending programs published');
        while(actualReady<2)await new Promise(resolve=>setTimeout(resolve,5));
        beforeReady=owner.snapshot();if(owner.ensure(config)!==false)throw Error('Held readiness published');
        heldResolve();while(!owner.ensure(config)){if(owner.snapshot().failed)throw Error(JSON.stringify(owner.snapshot()));await new Promise(resolve=>setTimeout(resolve,5));}
      }else{
        // Precompile each actual reference key with the standard adapter.
        mesh.material=material;
        for(const variant of [0,1]){material.defines.CLOUD_FAR_CACHE=variant;material.needsUpdate=true;
          renderer.setRenderTarget(target);await compilePrograms(renderer,mesh,camera,scene);}
        material.defines.CLOUD_FAR_CACHE=0;material.needsUpdate=true;
      }
      const records=[];
      mesh.material=material;
      for(const variant of [0,1,0]){
        material.defines.CLOUD_FAR_CACHE=variant;material.needsUpdate=true;
        renderer.setRenderTarget(target);const before=renderer.info.programs.map(p=>p.id),linkCount=links.length;
        renderer.render(scene,camera);const pixels=new Uint16Array(96*96*4);renderer.readRenderTargetPixels(target,0,0,96,96,pixels);
        const again=new Uint16Array(pixels.length);renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,96,96,again);
        if(pixels.some((x,i)=>x!==again[i]))throw Error('Native repeat mismatch');
        const red=T.DataUtils.fromHalfFloat(pixels[0]),green=T.DataUtils.fromHalfFloat(pixels[1]);
        if(variant===1?red!==2.125:green!==1.25)throw Error('Restored define used another family');
        records.push({variant,pixels:Array.from(pixels),red,green,newPrograms:renderer.info.programs.filter(p=>!before.includes(p.id)).length,newLinks:links.length-linkCount});
      }
      renderer.setRenderTarget(null);renderer.render(scene,camera);
      const debug=gl.getExtension('WEBGL_debug_renderer_info');
      const result={mode,records,scopes,beforeReady,snapshot:owner.snapshot(),gl:gl.getError(),lost:gl.isContextLost(),gpu:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null,
        nativeSources:[...new Set(sources.values())],sourceShaderCount:sources.size,
        boundary:'Small controlled ShaderMaterial. Real full-cloud/game/history and cold waits are checked separately.'};
      document.querySelector('pre').textContent=JSON.stringify({...result,records:records.map(({pixels,...record})=>record)},null,2);
      owner.dispose();renderer.setRenderTarget(null);target.dispose();caller.dispose();material.dispose();other.dispose();geometry.dispose();renderer.dispose();
      for(let i=0;i<100&&retirement.snapshot().pending;i++)await new Promise(resolve=>setTimeout(resolve,10));
      result.retirement=retirement.snapshot();if(result.retirement.pending||result.retirement.faults.length)throw Error('Retirement did not drain');
      return result;
    },mode);
    assert.equal(result.gl,0);assert.equal(result.lost,false);assert.ok(result.records.every(r=>r.newPrograms===0&&r.newLinks===0));
    await page.screenshot({path:`${out}/${mode}.png`});cases.push(result);await page.close();
  }
  for(let i=0;i<3;i++)assert.deepEqual(cases[0].records[i].pixels,cases[1].records[i].pixels);
  const after=await evidenceFingerprint('tools/cloudprogrampreparationgputest.js');assert.deepEqual(before,after);assert.deepEqual(errors,[]);
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,cases,errors,comparisons:3,nativeChanged:0,passed:true},null,2));
  console.log(JSON.stringify({out,passed:true,comparisons:3,nativeChanged:0}));
}catch(error){await writeFile(`${out}/failure.json`,JSON.stringify({before,cases,errors,error:String(error),stack:error.stack},null,2));throw error;}
finally{await browser?.close();server.close();}
