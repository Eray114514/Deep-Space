import assert from 'node:assert/strict';
import {makeCloudVolumeMaterial} from '../src/clouds-webgl.js';
import {cloudLightBatchShaders,cloudLightBatchVertex} from '../src/cloud/cloud-light-batch-glsl.js';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
const material=makeCloudVolumeMaterial({R:6000000},
  {rIn:6000000,rOut:6040000,localWeather:true,ox:0,oy:0,oz:0},null,null,null);
const shaders=cloudLightBatchShaders(material.fragmentShader);
const {server,port}=await startServer(0);let browser;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  const page=await browser.newPage();
  await page.route('**/page-compile.html',route=>route.fulfill({contentType:'text/html',body:
    '<script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/page-compile.html`);
  const result=await page.evaluate(async({shaders,vertex,defines,tileVertex})=>{
    const T=await import('three'),r=new T.WebGLRenderer(),scene=new T.Scene(),camera=new T.Camera(),logs=[];
    r.debug.onShaderError=(gl,program,vs,fs)=>logs.push({vertex:gl.getShaderInfoLog(vs),fragment:gl.getShaderInfoLog(fs)});
    const gl=r.getContext(),geometry=new T.PlaneGeometry(),records=[];
    const fullscreen='varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}';
    for(const [name,fragment] of Object.entries(shaders)){
      const mode={metadata:0,beams:1,compose:2}[name];
      const m=new T.ShaderMaterial({fragmentShader:fragment,vertexShader:['prepare','badFields'].includes(name)?vertex:mode!==undefined?tileVertex:fullscreen,
        defines:{...defines,...(mode!==undefined?{PAGE_MODE:mode}:{})},glslVersion:['prepare','metadata'].includes(name)?T.GLSL3:null});
      const mesh=new T.Mesh(geometry,m);scene.add(mesh);r.compile(scene,camera);
      const compiled=r.properties.get(m).currentProgram;compiled.getUniforms();
      records.push({name,linked:gl.getProgramParameter(compiled.program,gl.LINK_STATUS)});
      scene.remove(mesh);m.dispose();
    }
    const result={logs,records,gl:gl.getError()};geometry.dispose();r.dispose();return result;
  },{shaders,vertex:material.vertexShader,defines:material.defines,tileVertex:cloudLightBatchVertex});
  console.log(JSON.stringify(result,null,2));assert.deepEqual(result.logs,[]);
  for(const record of result.records)assert.equal(record.linked,true);assert.equal(result.gl,0);
} finally {material.dispose();await browser?.close();await new Promise(resolve=>server.close(resolve));}
