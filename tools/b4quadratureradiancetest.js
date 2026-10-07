// Production cloud main() with prescribed variable density/source. Independent
// double-precision integration tests the quadrature, not physical illumination.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
const cases=[];
const bins=Number(process.argv.find(arg=>arg.startsWith('--samples='))?.split('=')[1]||16);
for(const sigma of [.00002,.0002,.002])for(const length of [400,2000,8000])for(const kind of [0,1,2])cases.push({sigma,length,kind});
const source=(d,length,kind)=>kind===0?.2+.6*d/length:kind===1
  ?.2+.6/(1+Math.exp(-(d/length-.35)*16)):.2+.6*Math.exp(-(((d/length-.35)/.15)**2));
function reference(row,count) {
  let T=1,C=0;const step=row.length/count;
  for(let i=0;i<count;i++) {
    const d=(i+.5)*step,sigma=row.sigma*(.75+.25*Math.sin(d/480)),next=T*Math.exp(-sigma*step);
    C+=(T-next)*source(d,row.length,row.kind);T=next;
  }
  return {C,opacity:1-T};
}
const {server,port}=await startServer(0);let browser;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/__quadrature',r=>r.fulfill({contentType:'text/html',body:'<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/__quadrature`);
  const records=await page.evaluate(async({cases,bins})=>{
    const THREE=await import('three'),{makeCloudVolumeMaterial,disposeCloudNoiseTexture}=await import('/src/clouds-webgl.js');
    const r=new THREE.WebGLRenderer(),target=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,depthBuffer:false});
    const texture=new THREE.DataTexture(new Uint8Array([255,255,255,255]),1,1);texture.needsUpdate=true;
    const material=makeCloudVolumeMaterial({R:100000},{rIn:100001,rOut:108001,localWeather:true,ox:0,oy:0,oz:0},texture);
    function body(shader,signature,replacement) {
      const start=shader.indexOf(signature);if(start<0)throw Error(signature);
      const open=shader.indexOf('{',start);let end=open+1,n=1;
      while(n){if(shader[end]==='{')n++;if(shader[end++]==='}')n--;}
      return shader.slice(0,open+1)+replacement+shader.slice(end-1);
    }
    material.fragmentShader='uniform float uTestSigma,uTestLength,uTestKind;\n'+body(body(material.fragmentShader,
      'float cloudExtinctionAt(','float d=local.y-100001.0;return uTestSigma*(.75+.25*sin(d/480.0));'),
      'vec3 cloudCombinedSource(',`float x=(local.y-100001.0)/uTestLength;
        float value=uTestKind<.5?.2+.6*x:uTestKind<1.5?.2+.6/(1.0+exp(-(x-.35)*16.0)):.2+.6*exp(-pow((x-.35)/.15,2.0));return vec3(value);`);
    material.vertexShader='varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}';
    material.side=THREE.FrontSide;material.blending=THREE.NoBlending;material.depthTest=false;material.depthWrite=false;
    const u=material.uniforms;Object.assign(u,{uTestSigma:{value:0},uTestLength:{value:0},uTestKind:{value:0}});
    u.uCameraLocal.value.set(0,100000,0);u.uDepthReady.value=0;u.uBandsReady.value=0;u.uEngage.value=1;
    u.air_uEnabled.value=0;u.uLightQuadratureSteps.value=bins;u.uFrame.value=0;
    const geometry=new THREE.PlaneGeometry(2,2),scene=new THREE.Scene();scene.add(new THREE.Mesh(geometry,material));
    const records=[],pixels=new Float32Array(4);
    {
      for(const row of cases) {
        u.uTestSigma.value=row.sigma;u.uTestLength.value=row.length;u.uTestKind.value=row.kind;u.uRout.value=100001+row.length;
        r.setRenderTarget(target);r.clear();r.render(scene,new THREE.Camera());r.readRenderTargetPixels(target,0,0,1,1,pixels);
        const program=r.info.programs.at(-1);if(!program || program.diagnostics?.runnable===false)throw Error('Unlinked quadrature shader');
        records.push({...row,C:pixels[0],opacity:pixels[3]});
      }
    }
    if(r.getContext().getError())throw Error('Quadrature GL error');
    material.dispose();geometry.dispose();target.dispose();texture.dispose();disposeCloudNoiseTexture();r.dispose();return records;
  },{cases,bins});
  for(const row of records) {
    const a=reference(row,16384),b=reference(row,32768);row.reference=b;
    row.referenceError=Math.max(Math.abs(a.C-b.C),Math.abs(a.opacity-b.opacity));
    row.radianceError=Math.abs(row.C-b.C);row.opacityError=Math.abs(row.opacity-b.opacity);
  }
  await mkdir('test-results/b4-quadrature-radiance',{recursive:true});
  await writeFile(`test-results/b4-quadrature-radiance/${bins}-samples.json`,JSON.stringify({bins,fingerprint:await evidenceFingerprint('tools/b4quadratureradiancetest.js'),records,errors},null,2));
  assert.deepEqual(errors,[]);assert.ok(records.every(row=>row.referenceError<.0001));
  assert.ok(records.every(row=>row.opacityError<.003),'production view opacity');
  console.log(JSON.stringify({bins,cases:records.length,maxRadianceError:Math.max(...records.map(row=>row.radianceError)),maxOpacityError:Math.max(...records.map(row=>row.opacityError))}));
  assert.ok(records.every(row=>row.radianceError<.005),'variable-source absolute radiance error');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
