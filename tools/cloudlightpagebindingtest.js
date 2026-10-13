import assert from 'node:assert/strict';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
const badDiscardControl=process.argv.includes('--bad-discard-control');
const {server,port}=await startServer(0);let browser;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  const page=await browser.newPage();
  await page.route('**/page-binding.html',route=>route.fulfill({contentType:'text/html',body:
    '<script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/page-binding.html`);
  const result=await page.evaluate(async badDiscardControl=>{
    const T=await import('three'),{makeCloudVolumeMaterial}=await import('/src/clouds-webgl.js');
    const {cloudLightPageShaders}=await import('/tools/cloud-light-page-shaders.js');
    const base=makeCloudVolumeMaterial({R:6000000},{rIn:6000000,rOut:6040000,localWeather:true,ox:0,oy:0,oz:0},null,null,null);
    const shaders=cloudLightPageShaders(base.fragmentShader),r=new T.WebGLRenderer(),gl=r.getContext();
    const info=gl.getExtension('WEBGL_debug_renderer_info');
    const gpu=info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):null;
    if(badDiscardControl)shaders.compose=shaders.compose.replace(
      'int slot=int(texelFetch(tPageLightMap,pageTile(pixel),0)[field])-1;',
      'int slot=int(texelFetch(tPageLightMap,pageTile(pixel),0)[field])-1;if(slot<0)discard;');
    const float=new T.DataTexture(new Float32Array(4),1,1,T.RGBAFormat,T.FloatType);float.needsUpdate=true;
    const uint=new T.DataTexture(new Uint32Array(4),1,1,T.RGBAIntegerFormat,T.UnsignedIntType);uint.internalFormat='RGBA32UI';uint.needsUpdate=true;
    const uniforms={...base.uniforms,uPageSize:{value:new T.Vector2(1,1)},uPageTilesX:{value:1},uPageMetaColumns:{value:1},uPageLightColumns:{value:1}};
    for(const key of ['tPageRay','tPageCached','tPageMask','tPageOpacity','tPage0','tPage1','tPage2','tPage3','tPageLight'])uniforms[key]={value:float};
    for(const key of ['tPageMetaJobs','tPageLightJobs','tPageMetaMap','tPageLightMap'])uniforms[key]={value:uint};
    const material=new T.ShaderMaterial({uniforms,defines:base.defines,fragmentShader:shaders.compose,
      vertexShader:'varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}',
      side:T.DoubleSide,depthTest:false,depthWrite:false});
    const scene=new T.Scene(),camera=new T.Camera(),geometry=new T.PlaneGeometry(2,2);scene.add(new T.Mesh(geometry,material));
    const calls=[],rawUniform=gl.uniform1i,rawDraw=gl.drawElements;
    gl.uniform1i=function(location,value){rawUniform.call(this,location,value);calls.push({kind:'uniform',value,read:gl.getUniform(gl.getParameter(gl.CURRENT_PROGRAM),location),error:gl.getError()});};
    gl.drawElements=function(...args){rawDraw.apply(this,args);calls.push({kind:'draw',args,error:gl.getError()});};
    const target=new T.WebGLRenderTarget(1,1,{type:T.HalfFloatType,depthBuffer:false});r.setRenderTarget(target);r.render(scene,camera);
    const program=r.properties.get(material).currentProgram.program,samplers=[];
    for(let i=0;i<gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);i++){
      const u=gl.getActiveUniform(program,i);if([gl.SAMPLER_2D,gl.SAMPLER_3D,gl.UNSIGNED_INT_SAMPLER_2D].includes(u.type))
        samplers.push({name:u.name,unit:gl.getUniform(program,gl.getUniformLocation(program,u.name))});
    }
    const result={gl:gl.getError(),linked:gl.getProgramParameter(program,gl.LINK_STATUS),samplers,calls,info:r.info.render,badDiscardControl,
      gpu,contextLost:gl.isContextLost(),programLog:gl.getProgramInfoLog(program),userAgent:navigator.userAgent};gl.uniform1i=rawUniform;gl.drawElements=rawDraw;
    r.dispose();target.dispose();material.dispose();base.dispose();geometry.dispose();float.dispose();uint.dispose();return result;
  },badDiscardControl);
  console.log(JSON.stringify(result,null,2));assert.equal(result.linked,true);assert.equal(result.contextLost,false);
  assert.equal(result.gl,0);assert.equal(result.info.calls,1);
  for(const call of result.calls)assert.equal(call.error,0,'Linked shaders must bind and draw, not merely compile');
  assert.equal(new Set(result.samplers.map(s=>s.unit)).size,result.samplers.length,'Mixed sampler types need distinct bindings');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
