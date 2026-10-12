// Dense hardware old/new interval comparison. Physical reference gates remain
// in b4airgaptest; this tool checks state and accumulated transfer per quantile.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { atmosphereRenderProfile } from '../src/atmosphere-pass-webgl.js';
import { referenceAir } from './atmosphere-radiance-reference.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const bodies = [
  { R: 6000000, type: 'lush', atmosphere: { pressureBar: 1 }, weatherProfile: { temperatureK: 286 } },
  { R: 300000, type: 'ice', atmosphere: { pressureBar: .15 }, weatherProfile: { temperatureK: 190 } },
  { R: 7000000, type: 'desert', atmosphere: { pressureBar: 2.7 }, weatherProfile: { temperatureK: 410 } },
];
const fixtures = [];
for (const body of bodies) for (const altitude of [1000, 8000]) for (const degrees of [-7, -1, 55]) {
  const { profile, densityScale } = atmosphereRenderProfile(body);
  const mu = altitude === 1000 ? -.1 : .25, angle = degrees * Math.PI / 180;
  const state = { origin: [0, body.R + altitude, 0], direction: [Math.sqrt(1 - mu * mu), mu, 0],
    sun: [Math.cos(angle), Math.sin(angle), 0], distance: 8000, densityScale };
  const coarse = referenceAir(profile, { ...state, steps: 2048 });
  const reference = referenceAir(profile, { ...state, steps: 4096 });
  fixtures.push({ name: `${body.type}/${altitude}/${degrees}`, body, state, coarse, reference });
}
const cacheControl=process.argv.includes('--cache-control');
const oldControl=process.argv.includes('--old-control');
const stateControl=process.argv.includes('--state-control');
const oldSource=execFileSync('git',['show','8092cdf:src/clouds-webgl.js'],{encoding:'utf8'});
const oldStart=oldSource.indexOf('      void cloudAirGap(vec3 origin, vec3 dir, float a, float b,'),oldEnd=oldSource.indexOf('      // Pixel columns retain',oldStart);
if(oldStart<0||oldEnd<0)throw Error('Reference interval helpers changed');
const oldKernel=oldSource.slice(oldStart,oldEnd).replace(/\bcloudAirGap\b|\bcloudAirAdvance\b/g,name=>'reference_'+name);
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath(), headless: true });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/__air-gap', r => r.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>' }));
  await page.goto(`http://127.0.0.1:${port}/__air-gap`);
  const result = await page.evaluate(async ({fixtures,oldKernel,stateControl,oldControl,cacheControl}) => {
    const THREE = await import('three');
    const { AtmospherePass, atmosphereRenderProfile } = await import('/src/atmosphere-pass-webgl.js');
    const { makeCloudVolumeMaterial, disposeCloudNoiseTexture } = await import('/src/clouds-webgl.js');
    const { FullScreenQuad } = await import('/vendor/jsm/postprocessing/Pass.js');
    const renderer=new THREE.WebGLRenderer();renderer.setSize(128,16);
    const gl=renderer.getContext(),debug=gl.getExtension('WEBGL_debug_shaders');let translated=null;
    const deleteShader=gl.deleteShader.bind(gl);
    gl.deleteShader=shader=>{if(debug && gl.getShaderParameter(shader,gl.SHADER_TYPE)===gl.FRAGMENT_SHADER && gl.getShaderParameter(shader,gl.COMPILE_STATUS))translated=debug.getTranslatedShaderSource(shader);deleteShader(shader);};
    const target = new THREE.WebGLRenderTarget(128, 16, { type: THREE.FloatType, depthBuffer: false });
    const air = new AtmospherePass(new THREE.PerspectiveCamera());
    const cloud = makeCloudVolumeMaterial({ R: 6000000 }, { rIn: 6000000, rOut: 6030000,
      ox: 0, oy: 0, oz: 0, cov0: .3, cov1: .7 });
    const uniforms = { ...cloud.uniforms, testDirection: { value: new THREE.Vector3() },
      testDistance: { value: 8000 }, testMode: { value: 0 } };
    for (const [name, uniform] of Object.entries(air.material.uniforms)) uniforms['air_' + name] = uniform;
    const prefix = cloud.fragmentShader.slice(0, cloud.fragmentShader.lastIndexOf('void main()'));
    const material = new THREE.ShaderMaterial({ uniforms, defines: cloud.defines,
      vertexShader: 'varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}',
      fragmentShader: prefix+oldKernel+`uniform vec3 testDirection;uniform float testDistance,testMode;
        void main(){vec2 uv=gl_FragCoord.xy/vec2(128,16);
          vec3 origin=air_uCameraLocal+vec3(0,(uv.y-.5)*2000.,0);
          vec3 light=vec3(0),transmission=vec3(1),cellExt=vec3(0),cellSource=vec3(0);
          vec3 referenceLight=vec3(0),referenceTransmission=vec3(1),referenceExt=vec3(0),referenceSource=vec3(0);
          float previous=0.,cellEnd=-1.,referenceEnd=-1.,maximumRadiance=0.,maximumTransmission=0.,maximumState=0.,maximumRelative=0.;
          float distance=testDistance*(.01+uv.x*1.99);
          for(int i=0;i<16;i++){
            float next=distance*pow(float(i+1)/16.,3.);
            if(uv.x<.02 && i<2)next=0.;
            vec3 l,t,rl,rt;
            cloudAirTransport(origin,testDirection,previous,next,i>0,cellEnd,cellExt,cellSource,l,t);
            if(i==0)reference_cloudAirGap(origin,testDirection,previous,next,rl,rt);
            else reference_cloudAirAdvance(origin,testDirection,previous,next,referenceEnd,referenceExt,referenceSource,rl,rt);
            light+=transmission*l;transmission*=t;
            referenceLight+=referenceTransmission*rl;referenceTransmission*=rt;
            float error=max(max(abs(light.x-referenceLight.x),abs(light.y-referenceLight.y)),abs(light.z-referenceLight.z));
            float scale=max(max(abs(referenceLight.x),abs(referenceLight.y)),abs(referenceLight.z));
            maximumRadiance=max(maximumRadiance,error);maximumRelative=max(maximumRelative,error/max(scale,1e-8));
            maximumTransmission=max(maximumTransmission,max(max(abs(transmission.x-referenceTransmission.x),abs(transmission.y-referenceTransmission.y)),abs(transmission.z-referenceTransmission.z)));
            maximumState=max(maximumState,abs(cellEnd-referenceEnd));previous=next;
          }
          gl_FragColor=testMode>.5?vec4(cellEnd,referenceEnd,transmission.x,referenceTransmission.x):vec4(maximumRadiance,maximumTransmission,maximumState,maximumRelative);
        }`, depthTest: false, depthWrite: false });
    if(oldControl)material.fragmentShader=material.fragmentShader.replace('cloudAirTransport(origin,testDirection,previous,next,i>0,cellEnd,cellExt,cellSource,l,t);','if(i==0)reference_cloudAirGap(origin,testDirection,previous,next,l,t);else reference_cloudAirAdvance(origin,testDirection,previous,next,cellEnd,cellExt,cellSource,l,t);');
    uniforms.testMode.value=stateControl?1:0;
    const quad = new FullScreenQuad(material), rows = [];
    for (const { body, state, name } of fixtures) {
      air.setActivePlanet({ ...body, atmoMesh: { visible: true }, posUniv: new THREE.Vector3(),
        _invFrame: new THREE.Quaternion(), sunDirLocal: new THREE.Vector3(...state.sun),
        worldOffsetToLocal: (v, out) => out.copy(v) }, new THREE.Vector3(...state.origin));
      air.material.uniforms.uMultipleEnabled.value=0;
      if(cacheControl){air.material.uniforms.uSunEnergy0.value=0;air.material.uniforms.uSunEnergy1.value=0;}
      uniforms.testDirection.value.fromArray(state.direction);
      const outputs = [];
      for (const distance of cacheControl?[80]:[80,8000,250000]) {
        uniforms.testDistance.value = distance; renderer.setRenderTarget(target); quad.render(renderer);
        const pixels=new Float32Array(128*16*4);renderer.readRenderTargetPixels(target,0,0,128,16,pixels);
        const maximum=[0,0,0,0];for(let i=0;i<pixels.length;i++){
          if(!Number.isFinite(pixels[i]))throw Error('Nonfinite transfer comparison');maximum[i%4]=Math.max(maximum[i%4],pixels[i]);}
        let cacheError=0;
        if(cacheControl){
          const {profile}=atmosphereRenderProfile(body);
          const limit=Math.max(25,Math.min(profile.rayleighScaleHeightMeters,profile.mieScaleHeightMeters)*.1);
          for(let x=0;x<128;x++){
            const span=distance*(.01+(x+.5)/128*1.99);let cursor=0,end=-1;
            for(let bin=0;bin<16;bin++){
              const next=x<3 && bin<2?0:span*((bin+1)/16)**3;
              if(bin>0 && next>cursor){let at=cursor;
                for(let cell=0;cell<64 && at<next;cell++){if(end<=at)end=at+limit;at=Math.min(next,end);}
                if(at<next)end=next;
              }
              cursor=next;
            }
            for(let y=0;y<16;y++)cacheError=Math.max(cacheError,Math.abs(pixels[(y*128+x)*4]-end));
          }
        }
        outputs.push({distance,cacheError,maximum,samples:128*16,center:Array.from(pixels.slice((8*128+64)*4,(8*128+64)*4+4))});
      }
      rows.push({name,outputs});
    }
    const gpu=gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
    const glError = gl.getError();
    quad.dispose(); material.dispose(); cloud.dispose(); air.dispose(); target.dispose();
    disposeCloudNoiseTexture(); renderer.dispose();
    return {rows,glError,gpu,translated,translationStatus:debug?(translated?'captured':'empty'):'unavailable'};
  }, {fixtures,oldKernel,stateControl,oldControl,cacheControl});
  await mkdir('test-results/cloud-air-transport',{recursive:true});
  if(result.translated)await writeFile('test-results/cloud-air-transport/translated-shader.txt',result.translated);
  delete result.translated;
  await writeFile(`test-results/cloud-air-transport/${cacheControl?'cache-':''}${oldControl?'old-':''}${stateControl?'state-control':'report'}.json`,JSON.stringify({reference:'8092cdf',fingerprint:await evidenceFingerprint('tools/cloudairtransportdiag.js'),result,errors},null,2));
  const maximum=[0,0,0,0];for(const row of result.rows)for(const item of row.outputs)for(let c=0;c<4;c++)maximum[c]=Math.max(maximum[c],item.maximum[c]);
  console.log({cases:result.rows.reduce((n,r)=>n+r.outputs.length,0),samples:result.rows.reduce((n,r)=>n+r.outputs.length*128*16,0),maximum,errors});
  assert.deepEqual(errors,[]);assert.equal(result.glError,0);
  if(cacheControl){const error=Math.max(...result.rows.flatMap(r=>r.outputs.map(o=>o.cacheError)));console.log({cacheStateError:error});assert.ok(error<.001,'GPU cache must match independent CPU state');}
  if(stateControl)process.exitCode=0;
  // Old/new compiled cache behavior intentionally differs; independent physical
  // gates live in b4airgaptest/B5, and CPU cache ownership in cloudaircachetest.

} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
