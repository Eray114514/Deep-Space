import assert from 'node:assert/strict';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
const {server,port}=await startServer(0);let browser;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  const page=await browser.newPage();
  await page.route('**/history-resize.html',route=>route.fulfill({contentType:'text/html',body:
    '<script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/history-resize.html`);
  const result=await page.evaluate(async()=>{
    const T=await import('three'),{resizeVolumeHistoryTarget}=await import('/src/volumetric-pass-webgl.js');
    const r=new T.WebGLRenderer(),gl=r.getContext(),allocations=new WeakMap();
    const rawStorage=gl.texStorage2D;
    gl.texStorage2D=function(target,levels,format,width,height){
      allocations.set(gl.getParameter(gl.TEXTURE_BINDING_2D),{width,height});return rawStorage.apply(this,arguments);
    };
    const geometry=new T.PlaneGeometry(2,2),scene=new T.Scene(),camera=new T.Camera();
    const mat=new T.ShaderMaterial({uniforms:{tDepth:{value:null}},depthTest:false,depthWrite:false,
      vertexShader:'varying vec2 vUV;void main(){vUV=uv;gl_Position=vec4(position.xy,0,1);}',
      fragmentShader:'uniform sampler2D tDepth;varying vec2 vUV;void main(){gl_FragColor=vec4(texture2D(tDepth,vUV).r,0,0,1);}'});
    scene.add(new T.Mesh(geometry,mat));const records=[];
    for(const fixed of [false,true]) {
      const make=()=>new T.WebGLRenderTarget(64,64,{type:T.HalfFloatType,depthTexture:new T.DepthTexture(64,64,T.UnsignedIntType)});
      const a=make(),b=make();r.setRenderTarget(a);r.clear();r.setRenderTarget(b);r.clear();
      if(fixed){resizeVolumeHistoryTarget(a,32,32);resizeVolumeHistoryTarget(b,32,32);}
      else {a.setSize(32,32);b.setSize(32,32);}
      const metadataBeforeSampling={...a.depthTexture.image};
      mat.uniforms.tDepth.value=a.depthTexture;r.setRenderTarget(b);r.render(scene,camera);
      const depthTexture=r.properties.get(a.depthTexture).__webglTexture;
      const sampledAllocation=allocations.get(depthTexture),sampleGl=gl.getError();
      r.setRenderTarget(a);const status=gl.checkFramebufferStatus(gl.FRAMEBUFFER);r.clear();const clearGl=gl.getError();
      records.push({fixed,metadataBeforeSampling,sampledAllocation,status,sampleGl,clearGl});
      r.setRenderTarget(null);a.dispose();b.dispose();
    }
    const result={records,gl:gl.getError()};gl.texStorage2D=rawStorage;mat.dispose();geometry.dispose();r.dispose();return result;
  });
  console.log(JSON.stringify(result,null,2));
  const [old,fixed]=result.records;
  assert.deepEqual(old.sampledAllocation,{width:64,height:64});assert.equal(old.clearGl,1286);assert.equal(old.status,36057);
  assert.deepEqual(fixed.sampledAllocation,{width:32,height:32});assert.equal(fixed.sampleGl,0);assert.equal(fixed.clearGl,0);
  assert.equal(fixed.status,36053);assert.equal(result.gl,0);
  console.log('PASS old sampling-before-owner allocation fails; explicit depth dimensions allocate the correct size and keep history FBO complete.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
