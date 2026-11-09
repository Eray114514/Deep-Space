import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const verifier='tools/cloudsunfusedtest.js',before=await evidenceFingerprint(verifier);
const out=`test-results/cloud-sun-fused/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
const {server,port}=await startServer(0);
let browser,page,result,failure;
const errors=[];
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  page=await browser.newPage();
  page.on('pageerror',error=>errors.push(String(error)));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.route('**/cloud-sun-fused.html',route=>route.fulfill({contentType:'text/html',body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/cloud-sun-fused.html`);
  result=await page.evaluate(async()=>{
    const T=await import('three');
    const {Planet,setVolumetricCloudsEnabled}=await import('/src/planet.js');
    const {CloudSunCache}=await import('/src/cloud/cloud-sun-cache.js');
    const {OwnedScreenTriangle}=await import('/src/owned-screen-triangle.js');
    const {installProgramRetirement}=await import('/src/program-retirement.js');
    const r=new T.WebGLRenderer({antialias:false}),gl=r.getContext(),retirement=installProgramRetirement(r);
    const ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if(!ext||!gl.getExtension('EXT_color_buffer_float'))throw Error('Native WebGL2 timing and float targets required');
    setVolumetricCloudsEnabled(true);
    const planet=new Planet({seed:'sun-fused-atlas',name:'Sun cache',type:'lush',radius:6e6,posUniv:new T.Vector3(),
      ringSystem:{present:false},tuning:{cloudCoverage:.8,weatherStyle:'temperate-synoptic'}});
    const results=[];window.__sunFused={results};
    class Fused extends CloudSunCache {
      constructor(...args) {
        super(...args);
        this.planes=this.planes.map(old=>{
          const plane=new T.WebGLRenderTarget(old.width,old.height,{count:2,format:T.RedFormat,
            type:T.HalfFloatType,minFilter:T.LinearFilter,magFilter:T.LinearFilter,depthBuffer:false});
          plane.textures[1].type=T.UnsignedByteType;old.dispose();return plane;
        });
        this.material.uniforms.uPrevious.value=this.planes[0].texture;
        const statement='gl_FragColor=vec4(min(opticalDepth,128.0),0,0,1);';
        if(!this.material.fragmentShader.includes(statement))throw Error('Missing exact sweep output');
        this.material.glslVersion=T.GLSL3;
        this.material.fragmentShader='layout(location=0) out vec4 tauOut;\nlayout(location=1) out vec4 r8Out;\n'+
          this.material.fragmentShader.replace(statement,`float tau=min(opticalDepth,128.0);
            tauOut=vec4(tau,0,0,1);
            float halfTau=unpackHalf2x16(packHalf2x16(vec2(tau,0))).x;
            r8Out=vec4(log(1.0+halfTau)/log(129.0),0,0,1);`);
        this.copyQuad.dispose();this.copyMaterial.dispose();this.copyQuad=this.copyMaterial=null;
      }
      copyPlane(renderer,plane,layer) {
        renderer.initRenderTarget(this.target);
        const tile=this.tileOffset+this.field*this.depth+layer;
        renderer.copyTextureToTexture(plane.textures[1],this.target.texture,null,
          new T.Vector2(tile%32*this.size,Math.floor(tile/32)*this.size));
      }
    }
    const readMaterial=new T.ShaderMaterial({uniforms:{source:{value:null}},
      vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',
      fragmentShader:'uniform sampler2D source;void main(){gl_FragColor=vec4(texelFetch(source,ivec2(gl_FragCoord.xy),0).r,0,0,1);}',
      depthTest:false,depthWrite:false,blending:T.NoBlending});
    const quad=new OwnedScreenTriangle(readMaterial),pools={original:{},fused:{}};
    r.autoClear=false;r.setClearColor(0,0);
    async function run(implementation,options,center,capture) {
      const Bank=implementation==='fused'?Fused:CloudSunCache;
      const cache=new Bank(planet,center,{...options,encodeOpticalDepth:true,programOwner:pools[implementation]});
      const q=gl.createQuery();let begins=false;
      try {
        r.setRenderTarget(cache.target);r.clear(true,false,false);r.setRenderTarget(null);
        gl.beginQuery(ext.TIME_ELAPSED_EXT,q);begins=true;
        const at=performance.now();let slices=0;
        while(!cache.ready && ++slices<=32)cache.bakeSlice(r,{boundaryRows:options.size,slices:options.depth});
        const cpuMs=performance.now()-at;
        gl.endQuery(ext.TIME_ELAPSED_EXT);begins=false;
        if(!cache.ready)throw Error('Incomplete sweep');
        const deadline=performance.now()+30000;
        while(!gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE)) {
          if(performance.now()>deadline)throw Error('Sweep timer expired');
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        if(gl.getParameter(ext.GPU_DISJOINT_EXT))throw Error('Disjoint sweep query');
        const gpuMs=gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6;
        let pixels;
        if(capture) {
          const {width,height}=cache.target,readable=new T.WebGLRenderTarget(width,height,{depthBuffer:false});
          try {
            r.setRenderTarget(readable);readMaterial.uniforms.source.value=cache.target.texture;
            readMaterial.uniformsNeedUpdate=true;quad.render(r);
            pixels=new Uint8Array(width*height*4);r.readRenderTargetPixels(readable,0,0,width,height,pixels);
          } finally { r.setRenderTarget(null);readable.dispose(); }
        }
        const error=gl.getError();if(error)throw Error(`${implementation} sweep GL ${error}`);
        return {cpuMs,gpuMs,pixels};
      } finally { if(begins)gl.endQuery(ext.TIME_ELAPSED_EXT);gl.deleteQuery(q);cache.dispose(); }
    }
    try {
      const radial=new T.Vector3(.35,.1,-.93).normalize(),tangent=new T.Vector3().crossVectors(radial,new T.Vector3(0,1,0)).normalize();
      const center=radial.clone().multiplyScalar(planet.R+4500),u=planet.volCloudMat.uniforms;
      for(const [size,depth,mu]of [[64,64,.4],[128,128,.4],[128,128,.12]]) {
        u.uSunDir.value.copy(radial).multiplyScalar(mu).addScaledVector(tangent,Math.sqrt(1-mu*mu));
        u.uSecondarySunDir.value.copy(radial).multiplyScalar(.6).addScaledVector(tangent,-.8);
        const options={size,depth},row={size,depth,mu,rounds:[]};results.push(row);
        for(let round=0;round<4;round++) {
          const pair={};for(const arm of round%2?['fused','original']:['original','fused'])pair[arm]=await run(arm,options,center,round===0);
          if(round===0) {
            let changed=0,maxByte=0,nonzero=0;
            for(let i=0;i<pair.original.pixels.length;i+=4) {
              const a=pair.original.pixels[i],b=pair.fused.pixels[i];
              if(a!==b)changed++;if(a)nonzero++;
              maxByte=Math.max(maxByte,Math.abs(a-b));
            }
            row.bytes={changed,maxByte,nonzero};
            if(!nonzero)throw Error('Empty reference atlas');
          }
          row.rounds.push(Object.fromEntries(Object.entries(pair).map(([name,{cpuMs,gpuMs}])=>[name,{cpuMs,gpuMs}])));
        }
      }
    } finally {
      readMaterial.dispose();quad.dispose();planet.dispose();
      for(const pool of Object.values(pools))for(const material of Object.values(pool))material.dispose();
      r.dispose();
    }
    return {results,gl:gl.getError(),lost:gl.isContextLost(),retirement:retirement.snapshot()};
  });
  assert.equal(result.gl,0);assert.equal(result.lost,false);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({out,...result}));
} catch(error) {
  failure=String(error);if(page)try {result=await page.evaluate(()=>window.__sunFused);}catch{}
  throw error;
} finally {
  try {
    const after=await evidenceFingerprint(verifier);assert.deepEqual(after,before);
    await writeFile(`${out}/report.json`,JSON.stringify({before,after,result,errors,failure},null,2));
  } finally {await browser?.close();server.close();}
}
