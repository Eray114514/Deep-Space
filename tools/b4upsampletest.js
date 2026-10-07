// Production reconstruction against an analytic linear signal, plus a thin
// foreground that has no low-resolution support. Never infer quality from a
// generated screenshot or from matching the implementation's own arithmetic.
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
  await page.route('**/__upsample',r=>r.fulfill({contentType:'text/html',body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/__upsample`);
  const result=await page.evaluate(async()=>{
    const T=await import('three'),{VolumetricPass}=await import('/src/volumetric-pass-webgl.js');
    const r=new T.WebGLRenderer(),pass=new VolumetricPass(new T.Scene(),new T.PerspectiveCamera());
    const width=64,height=32,far=1e8,field=new Float32Array(16*8*4),depth=new Float32Array(width*height*4);
    for(let y=0;y<8;y++)for(let x=0;x<16;x++)field.set(
      [2*(x+.5)/16,3*(y+.5)/8,.7,.2+.5*(x+.5)/16],(y*16+x)*4);
    const make=(data,w,h)=>{const t=new T.DataTexture(data,w,h,T.RGBAFormat,T.FloatType);
      t.needsUpdate=true;t.minFilter=t.magFilter=T.NearestFilter;return t;};
    const volume=make(field,16,8),opaque=make(depth,width,height),base=make(new Float32Array([0,0,0,1]),1,1);
    const target=new T.WebGLRenderTarget(width,height,{type:T.FloatType,depthBuffer:false});
    const u=pass.compositeMaterial.uniforms;
    u.tVolume.value=volume;u.tBase.value=base;u.tSceneDepth.value=opaque;
    u.uTexel.value.set(1/16,1/8);u.uDepthReady.value=1;u.uCameraFar.value=far;
    const correct=pass.compositeMaterial.fragmentShader;
    const start=correct.indexOf('vec4 volumeSample('),open=correct.indexOf('{',start);
    let end=open+1,nesting=1;
    while(nesting){if(correct[end]==='{')nesting++;if(correct[end++]==='}')nesting--;}
    const bad=correct.slice(0,open+1)+
      'return texture2D(tVolume,(floor(uv/uTexel)+.5)*uTexel);'+correct.slice(end-1);
    const records=[];
    try {
      for(const dpr of [1,1.25])for(const foreground of [false,true])for(const control of [false,true]) {
        r.setPixelRatio(dpr);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++)depth[(y*width+x)*4]=
          Math.log2(1+(foreground&&(x===31||x===32)?25:10000))/Math.log2(1+far);
        opaque.needsUpdate=true;
        pass.compositeMaterial.fragmentShader=control?bad:correct;pass.compositeMaterial.needsUpdate=true;
        r.setRenderTarget(target);pass.compositeQuad.render(r);
        const pixels=new Float32Array(width*height*4);r.readRenderTargetPixels(target,0,0,width,height,pixels);
        const gl=r.getContext(),program=r.properties.get(pass.compositeMaterial).currentProgram;
        if(!program||!gl.getProgramParameter(program.program,gl.LINK_STATUS)||gl.getError())throw Error('Upsample program failed');
        let maximum=0,foregroundMaximum=0,checked=0;
        for(let y=2;y<height-2;y++)for(let x=2;x<width-2;x++) {
          const i=(y*width+x)*4;
          if(pixels[i+3]!==1||!pixels.slice(i,i+4).every(Number.isFinite))throw Error('Invalid reconstructed pixel');
          if(foreground&&(x===31||x===32)) {
            foregroundMaximum=Math.max(foregroundMaximum,...pixels.slice(i,i+3));continue;
          }
          const reference=[2*(x+.5)/width,3*(y+.5)/height,.7];
          maximum=Math.max(maximum,...reference.map((v,c)=>Math.abs(v-pixels[i+c])));checked++;
        }
        records.push({dpr,foreground,control,maximum,foregroundMaximum,checked});
      }
    } finally {
      r.setRenderTarget(null);volume.dispose();opaque.dispose();base.dispose();target.dispose();pass.dispose();r.dispose();
    }
    return records;
  });
  assert.deepEqual(errors,[]);
  for(const row of result) {
    assert.ok(row.checked>1000);
    if(row.control)assert.ok(row.maximum>.05,'Nearest reconstruction must fail the analytic signal');
    else {
      assert.ok(row.maximum<1e-5,`Linear signal changed: ${row.maximum}`);
      assert.ok(row.foregroundMaximum<1e-7,'Clouds leaked onto an unsupported foreground');
    }
    if(row.control&&row.foreground)assert.ok(row.foregroundMaximum>.5,'Control must expose foreground contamination');
  }
  await mkdir('test-results/b4-upsampling',{recursive:true});
  await writeFile('test-results/b4-upsampling/report.json',JSON.stringify({
    fingerprint:await evidenceFingerprint('tools/b4upsampletest.js'),result,errors},null,2));
  console.log('PASS cloud reconstruction and thin foreground:',result);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
