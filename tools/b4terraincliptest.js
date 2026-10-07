// Compare the shader's terrain clipping input with the original regional
// terrain, including a peak that the old weather-image resampling flattened.
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
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&freeze=1&time=9.5&quality=ultra&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted',null,{timeout:180000});
  await page.waitForFunction(()=>[0,2,4].every(i=>NMS._planet(i).weatherStream?.ready),null,{timeout:60000});
  const records=await page.evaluate(async()=>{
    const {sampleWeatherAtlas}=await import('/src/cloud/weather-atlas.js');
    const T=NMS._THREE,r=NMS._renderer,scene=new T.Scene(),camera=new T.Camera();
    const directions=[];
    for(let i=0;i<1024;i++) {
      const y=1-2*(i+.5)/1024,a=i*2.399963229728653;
      directions.push(new T.Vector3(Math.cos(a)*Math.sqrt(1-y*y),y,Math.sin(a)*Math.sqrt(1-y*y)));
    }
    directions.push(new T.Vector3(-.7813211441551724,-.1279296875,.6108774547748546));
    const count=directions.length,data=new Float32Array(count*4);
    directions.forEach((d,i)=>data.set([...d.toArray(),1],i*4));
    const input=new T.DataTexture(data,count,1,T.RGBAFormat,T.FloatType);input.needsUpdate=true;
    const target=new T.WebGLRenderTarget(count,1,{type:T.FloatType,depthBuffer:false});
    const geometry=new T.PlaneGeometry(2,2),mesh=new T.Mesh(geometry);scene.add(mesh);
    const saved=r.getRenderTarget(),records=[];
    for(const index of [0,2,4]) {
      const p=NMS._planet(index),source=p.volCloudMat;
      const prefix=source.fragmentShader.slice(0,source.fragmentShader.lastIndexOf('void main()'));
      mesh.material=new T.ShaderMaterial({defines:source.defines,
        uniforms:{...source.uniforms,tDirections:{value:input}},depthTest:false,depthWrite:false,
        vertexShader:'varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}',
        fragmentShader:prefix+`uniform sampler2D tDirections;void main(){
          vec3 d=texelFetch(tDirections,ivec2(int(gl_FragCoord.x),0),0).xyz;
          float surface=productionSurfaceAt(d);
          vec4 band=productionBandAt(weatherAtlasUV(uSpin*d),1);
          band=speciesAbsoluteBand(band,speciesShapeAt(1),surface);
          gl_FragColor=vec4(surface,band.g-surface,band.b-surface,1);}`});
      r.setRenderTarget(target);r.render(scene,camera);
      const pixels=new Float32Array(count*4);r.readRenderTargetPixels(target,0,0,count,1,pixels);
      for(let i=0;i<count;i++) {
        if(pixels[i*4+3]!==1)throw Error('Invalid clipping readback');
        // Compare precisely the Float32 direction uploaded to the shader.
        const d={x:data[i*4],y:data[i*4+1],z:data[i*4+2]};
        const expected=sampleWeatherAtlas(p.weatherField.streamDescriptor.terrain,d)[0];
        const image=p.cloudSpeciesTex.image,stride=image.width*image.height*4;
        const band=sampleWeatherAtlas({width:image.width,height:image.height,
          data:image.data.subarray(stride,stride*2),scale:1,northFirst:true},d,
          p.cloudSpinBase+p.weatherHours*p.weatherField.windRadiansPerHour);
        const old=(sampleWeatherAtlas({width:p.cloudWeatherHiTex.image.width,
          height:p.cloudWeatherHiTex.image.height,data:p.cloudWeatherHiTex.image.data,
          scale:1,northFirst:true},d)[1]*2-1)*p.weatherField.surfaceRangeMeters;
        records.push({index,i,expected,gpu:pixels[i*4],old,cpu:p.weatherField.surfaceAt(d),
          aglBase:band[1],aglTop:band[2],gpuAGLBase:pixels[i*4+1],gpuAGLTop:pixels[i*4+2]});
      }
      mesh.material.dispose();
    }
    r.setRenderTarget(saved);geometry.dispose();input.dispose();target.dispose();
    if(r.getContext().getError())throw Error('WebGL error');return records;
  });
  const metrics={cases:records.length,gpuError:Math.max(...records.map(x=>Math.abs(x.expected-x.gpu))),
    cpuError:Math.max(...records.map(x=>Math.abs(x.expected-x.cpu))),
    oldError:Math.max(...records.map(x=>Math.abs(x.expected-x.old))),
    heightError:Math.max(...records.flatMap(x=>[Math.abs(x.aglBase-x.gpuAGLBase),Math.abs(x.aglTop-x.gpuAGLTop)]))};
  await mkdir('test-results/b4-terrain-clip',{recursive:true});
  await writeFile('test-results/b4-terrain-clip/report.json',JSON.stringify({fingerprint:await evidenceFingerprint('tools/b4terraincliptest.js'),metrics,records,errors},null,2));
  console.log(JSON.stringify({metrics,errors},null,2));assert.deepEqual(errors,[]);
  assert.ok(metrics.gpuError<.1,'Shader clipping must match original regional terrain within 10 cm');
  assert.ok(metrics.cpuError<1e-9,'CPU clipping must use the original source');
  assert.ok(metrics.oldError>500,'The regression control must expose flattened terrain');
  assert.ok(metrics.heightError<.1,'Spun AGL bands must match CPU within 10 cm');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
