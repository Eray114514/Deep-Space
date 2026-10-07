// Independent analytic opaque sphere writes real log depth at full resolution.
// The production half-resolution cloud shader must not turn it into grid holes.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
const {server,port}=await startServer(0);let browser;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/__depth',r=>r.fulfill({contentType:'text/html',body:'<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/__depth`);
  const result=await page.evaluate(async()=>{
    const THREE=await import('three'),{makeCloudVolumeMaterial,disposeCloudNoiseTexture}=await import('/src/clouds-webgl.js');
    const {FullScreenQuad}=await import('/vendor/jsm/postprocessing/Pass.js');
    const renderer=new THREE.WebGLRenderer(),R=6000000,far=1.2e11,origin=new THREE.Vector3(0,0,R*2.2),extent=.53;
    const vertex=`varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(position.xy*${extent},-1.0);vViewDirection=vDirection;gl_Position=vec4(position.xy,0,1);}`;
    const depth=new THREE.ShaderMaterial({vertexShader:vertex,depthTest:true,depthWrite:true,
      fragmentShader:`varying vec3 vDirection;void main(){vec3 d=normalize(vDirection);vec3 o=vec3(0,0,${origin.z.toFixed(1)});
        float b=dot(o,d),disc=b*b-dot(o,o)+${R*R}.0;
        if(disc<0.0){gl_FragDepth=1.0;gl_FragColor=vec4(0);return;}
        float t=-b-sqrt(disc);gl_FragDepth=log2(1.0-t*d.z)/log2(${far+1}.0);gl_FragColor=vec4(0,0,0,1);}`});
    const quad=new FullScreenQuad(depth),depthTarget=new THREE.WebGLRenderTarget(128,128,{depthBuffer:true,
      depthTexture:new THREE.DepthTexture(128,128,THREE.UnsignedIntType)});
    renderer.setRenderTarget(depthTarget);renderer.clear();quad.render(renderer);
    const detail=new THREE.DataTexture(new Uint8Array([255,255,255,255]),1,1);detail.needsUpdate=true;
    const mat=makeCloudVolumeMaterial({R,hasLiquid:false},{rIn:R+800,rOut:R+4000,localWeather:true,ox:0,oy:0,oz:0,cov0:.3,cov1:.7},detail,detail,detail);
    mat.vertexShader=vertex;mat.side=THREE.DoubleSide;mat.depthTest=false;mat.blending=THREE.NoBlending;
    const replace=(source,name,body)=>{const start=source.indexOf(name+'('),open=source.indexOf('{',start);let end=open+1,n=1;
      while(n){if(source[end]==='{')n++;if(source[end++]==='}')n--;}return source.slice(0,open+1)+body+source.slice(end-1);};
    mat.fragmentShader=replace(mat.fragmentShader,'cloudExtinctionAt','return 0.001;');
    mat.fragmentShader=replace(mat.fragmentShader,'cloudCombinedSource','return vec3(1);');
    const u=mat.uniforms;u.uEngage.value=1;u.uCameraLocal.value.copy(origin);u.uCameraFar.value=far;
    u.uDepthReady.value=1;u.tSceneDepth.value=depthTarget.depthTexture;u.uVolumeSize.value.set(64,64);
    const projection=new THREE.PerspectiveCamera(2*Math.atan(extent)*180/Math.PI,1,1,far);
    u.uDepthInvProjection.value.copy(projection.projectionMatrixInverse);
    u.uDepthViewToLocal.value.identity();u.uOpaqueMinR.value=R-20000;u.uOpaqueMaxR.value=R+20000;
    u.air_uEnabled.value=0;quad.material=mat;
    const target=new THREE.WebGLRenderTarget(64,64,{type:THREE.FloatType,depthBuffer:false}),pixels=new Float32Array(64*64*4);
    renderer.setClearColor(0,0);renderer.setRenderTarget(target);renderer.clear();quad.render(renderer);renderer.readRenderTargetPixels(target,0,0,64,64,pixels);
    const fixedShader=mat.fragmentShader;
    mat.fragmentShader=replace(fixedShader,'sceneRayLimit',`vec2 uv=gl_FragCoord.xy/uVolumeSize;
      float depth=texture2D(tSceneDepth,uv).r;if(depth>=0.999999)return 1e20;
      return (pow(uCameraFar+1.0,depth)-1.0)/max(-normalize(vViewDirection).z,0.035);`);
    mat.needsUpdate=true;renderer.clear();quad.render(renderer);
    const badPixels=new Float32Array(pixels.length);renderer.readRenderTargetPixels(target,0,0,64,64,badPixels);
    const samples=[];
    const hits=(d,r)=>{const b=origin.dot(d),discriminant=b*b-origin.lengthSq()+r*r;
      return discriminant<0?null:[-b-Math.sqrt(discriminant),-b+Math.sqrt(discriminant)];};
    for(let y=0;y<64;y++)for(let x=0;x<64;x++) {
      const d=new THREE.Vector3(((x+.5)/64*2-1)*extent,((y+.5)/64*2-1)*extent,-1).normalize();
      const ground=hits(d,R);if(!ground)continue;
      const point=origin.clone().addScaledVector(d,ground[0]);
      // Edge depth discontinuities are handled by the existing foreground/
      // silhouette gate; this gate targets a continuous curved interior.
      if(Math.hypot(point.x,point.y)>R*.8)continue;
      const outer=hits(d,R+4000),inner=hits(d,R+800);
      const expected=-Math.expm1(-.001*(inner[0]-outer[0])),actual=pixels[(y*64+x)*4+3];
      const bad=badPixels[(y*64+x)*4+3];
      samples.push({x,y,expected,actual,error:Math.abs(expected-actual),nearestError:Math.abs(expected-bad)});
    }
    const glError=renderer.getContext().getError();renderer.setRenderTarget(null);
    target.dispose();depthTarget.dispose();detail.dispose();quad.dispose();mat.dispose();depth.dispose();disposeCloudNoiseTexture();renderer.dispose();
    return {samples,glError};
  });
  assert.deepEqual(errors,[]);assert.equal(result.glError,0);assert.ok(result.samples.length>100);
  const maximum=Math.max(...result.samples.map(s=>s.error));
  const mean=result.samples.reduce((a,s)=>a+s.error,0)/result.samples.length;
  await mkdir('test-results/b4-depth-footprint',{recursive:true});
  await writeFile('test-results/b4-depth-footprint/report.json',JSON.stringify({fingerprint:await evidenceFingerprint('tools/b4depthfootprinttest.js'),
    maximum,mean,...result,errors},null,2));
  assert.ok(maximum<.025 && mean<.005,`curved opaque depth creates holes: max ${maximum}, mean ${mean}`);
  assert.ok(Math.max(...result.samples.map(s=>s.nearestError))>.1,'regression must expose the old nearest-depth defect');
  console.log('PASS half-resolution curved-depth footprint:',{cases:result.samples.length,maximum,mean});
} finally {await browser?.close();await new Promise(r=>server.close(r));}
