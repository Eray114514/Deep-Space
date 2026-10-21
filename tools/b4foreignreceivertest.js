// Actual surface GLSL: foreign depth must elide only an occluded body's light
// work, not its own water bed; repeated PBR consumers must reuse each star.
import assert from 'node:assert/strict';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
const {server,port}=await startServer(0);let browser;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/__receiver',r=>r.fulfill({contentType:'text/html',body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/__receiver`);
  const records=await page.evaluate(async()=>{
    const T=await import('three');
    const {surfaceCloudGLSL,surfaceCloudLightingGLSL,surfaceCloudUniforms}=await import('/src/cloud/surface-clouds.js');
    const {cloudLightCacheUniforms}=await import('/src/cloud/cloud-light-cache-glsl.js');
    const {weatherAtlasGLSL}=await import('/src/cloud/weather-atlas.js');
    const r=new T.WebGLRenderer({logarithmicDepthBuffer:true});r.setSize(1,1);
    const texture=new T.DataTexture(new Float32Array([1,0,0,1]),1,1,T.RGBAFormat,T.FloatType);
    texture.needsUpdate=true;
    const source={...cloudLightCacheUniforms(texture),uCameraLocal:{value:new T.Vector3(0,0,20)},
      uCameraFar:{value:1e12},uSunDir:{value:new T.Vector3(0,0,1)},uSecondarySunDir:{value:new T.Vector3(1,0,0)}};
    const uniforms={...surfaceCloudUniforms({R:10,hAmp:0,volCloudMat:{uniforms:source}}),
      uTestLocal:{value:new T.Vector3(0,0,10)},uTestDepth:{value:0},uTestInitialize:{value:0},
      uLocalStarCount:{value:2},uLocalStars:{value:[new T.Vector4(0,0,1e12,1),new T.Vector4(1e12,0,0,1)]}};
    // Controlled beam, independent of cloud shape. Count full integrations to
    // distinguish a correct result from work still happening on hidden pixels.
    const start=surfaceCloudGLSL.indexOf('float cloudSunOpticalDepth(');
    if(start<0)throw Error('Missing physical beam');
    // The shared beam wrapper delegates to cloudSunOpticalDepthLimit now.
    // Match its function body, not the obsolete literal "return od".
    const open=surfaceCloudGLSL.indexOf('{',start);let end=open+1,nesting=1;
    while(nesting&&end<surfaceCloudGLSL.length) {
      if(surfaceCloudGLSL[end]==='{')nesting++;
      if(surfaceCloudGLSL[end++]==='}')nesting--;
    }
    if(open<0||nesting!==0)throw Error('Incomplete physical beam wrapper');
    const controlled=surfaceCloudGLSL.slice(0,start)+
      'float cloudSunOpticalDepth(vec3 local,vec3 direction,float sigma){testCalls+=1.0;return 1.6094379124341;}'+surfaceCloudGLSL.slice(end);
    const material=new T.ShaderMaterial({defines:{SURFACE_CLOUD_MEDIUM:1},uniforms,
      vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',depthTest:false,depthWrite:false,
      fragmentShader:`float testCalls=0.0;${weatherAtlasGLSL}\n${controlled}
        uniform int uLocalStarCount;uniform vec4 uLocalStars[2];
        ${surfaceCloudLightingGLSL}
        uniform vec3 uTestLocal;uniform float uTestDepth,uTestInitialize;
        void main(){gl_FragDepth=uTestDepth;float transmission;
          if(uTestInitialize>.5){initializeSurfaceCloudLighting(uTestLocal);transmission=0.0;
            for(int i=0;i<6;i++)transmission+=surfaceCloudLighting(i%2==0?vec3(0,0,1):vec3(1,0,0))/6.0;}
          else transmission=surfaceCloudTransmission(uTestLocal,vec3(0,0,1));
          gl_FragColor=vec4(transmission,testCalls,uTestDepth,1);}`});
    const geometry=new T.PlaneGeometry(2,2),scene=new T.Scene(),camera=new T.Camera();
    scene.add(new T.Mesh(geometry,material));
    const target=new T.WebGLRenderTarget(1,1,{type:T.FloatType,depthBuffer:false});
    const depth=d=>Math.log2(1+d)/Math.log2(1+1e12);
    const cases=[
      {name:'foreign foreground',front:8,expected:1,calls:0},
      {name:'own underwater receiver',front:9.5,expected:.2,calls:1},
      {name:'same receiver',front:10,expected:.2,calls:1},
      {name:'receiver behind fragment',front:12,expected:.2,calls:1},
      {name:'sky',front:1e12,expected:.2,calls:1},
      {name:'foreign gate disabled',front:8,foreign:0,expected:.2,calls:1},
      {name:'preparation has no cloud lighting',front:8,enabled:0,expected:1,calls:0},
      {name:'two stars reused by six consumers',front:9.5,initialize:1,expected:.2,calls:2},
      {name:'hidden two-star consumers',front:8,initialize:1,expected:1,calls:0},
    ];
    const records=[];
    try {
      for(const c of cases) {
        uniforms.uCloudBodyBoundRadius.value=11;uniforms.uCloudForeignReceiver.value=c.foreign??1;
        uniforms.uSurfaceCloudEnabled.value=c.enabled??1;uniforms.uTestInitialize.value=c.initialize??0;
        uniforms.uTestDepth.value=depth(10);texture.image.data[0]=depth(c.front);texture.needsUpdate=true;
        r.setRenderTarget(target);r.render(scene,camera);
        const pixels=new Float32Array(4);r.readRenderTargetPixels(target,0,0,1,1,pixels);
        const g=r.getContext(),program=r.properties.get(material).currentProgram;
        if(!program||!g.getProgramParameter(program.program,g.LINK_STATUS)||g.getError()!==0||pixels[3]!==1)
          throw Error('Invalid receiver readback: '+(program?g.getShaderInfoLog(program.fragmentShader):'no program'));
        records.push({...c,transmission:pixels[0],integrations:pixels[1]});
      }
      // Compile the real receiver-only program too. A neighbour belonging to
      // another body must not darken this body's PBR, even at identical depth.
      material.defines.SURFACE_CLOUD_SCREEN=1;material.needsUpdate=true;
      uniforms.cloud_uSunCacheReady.value=-1;
      uniforms.uCloudShadowViewport.value.set(1,1);
      uniforms.uSurfaceCloudEnabled.value=1;
      for(const c of [
        {name:'matching screen receiver',id:2,alpha:2,expected:.25},
        {name:'foreign screen receiver',id:1,alpha:2,expected:1},
        {name:'missing screen receiver',id:2,alpha:0,expected:1},
        {name:'hidden own bed retains receiver',id:2,alpha:2,depth:.8,expected:.25},
        {name:'screen two-star consumers',id:2,alpha:2,initialize:1,expected:.475},
      ]) {
        uniforms.uCloudReceiverId.value=c.id;
        uniforms.uTestInitialize.value=c.initialize??0;
        uniforms.uTestDepth.value=c.depth??.5;
        texture.image.data.set([.25,.7,.5,c.alpha]);texture.needsUpdate=true;
        r.setRenderTarget(target);r.render(scene,camera);
        const pixels=new Float32Array(4);r.readRenderTargetPixels(target,0,0,1,1,pixels);
        const g=r.getContext(),program=r.properties.get(material).currentProgram;
        if(!program||!g.getProgramParameter(program.program,g.LINK_STATUS)||g.getError()!==0||pixels[3]!==1)
          throw Error('Invalid screen receiver readback: '+(program?g.getShaderInfoLog(program.fragmentShader):'no program'));
        records.push({...c,calls:0,transmission:pixels[0],integrations:pixels[1]});
      }
      const mixed=new T.DataTexture(new Float32Array([
        .25,.7,1.0,2, .9,.9,.5,1, .9,.9,.5,1, .9,.9,.5,1,
      ]),2,2,T.RGBAFormat,T.FloatType);mixed.needsUpdate=true;
      uniforms.cloud_uSunTransport.value=mixed;uniforms.uCloudReceiverId.value=2;
      uniforms.uTestDepth.value=.5;uniforms.uTestInitialize.value=0;
      r.setRenderTarget(target);r.render(scene,camera);
      const pixel=new Float32Array(4);r.readRenderTargetPixels(target,0,0,1,1,pixel);
      records.push({name:'mixed bodies cannot produce zero times infinity',expected:.25,calls:0,
        transmission:pixel[0],integrations:pixel[1]});mixed.dispose();
    } finally {geometry.dispose();material.dispose();texture.dispose();target.dispose();r.dispose();}
    return records;
  });
  assert.deepEqual(errors,[]);
  for(const r of records) {
    assert.ok(Math.abs(r.transmission-r.expected)<1e-6,`${r.name}: ${r.transmission}`);
    assert.equal(r.integrations,r.calls,r.name);
  }
  console.log('PASS surface receiver ownership and single stellar evaluation',records);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
