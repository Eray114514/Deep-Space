// A known varying-height deck: test the production column intersection and
// opaque rejection against an independent analytic root, with the old query
// at the outer envelope as a required failing control.
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
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&freeze=1&time=9.5&quality=ultra&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted',null,{timeout:180000});
  const records=await page.evaluate(()=>{
    const THREE=NMS._THREE,r=NMS._renderer,p=NMS._planet(0),source=p.volCloudFarMat;
    const prefix=source.fragmentShader.slice(0,source.fragmentShader.lastIndexOf('void main()'));
    const width=512,height=256,columns=new Float32Array(width*height*4),heights=new Float32Array(columns.length);
    for(let i=0;i<columns.length;i+=4){columns[i]=.9;columns[i+2]=Math.log(11)/Math.log(129);}
    const make=data=>{const tex=new THREE.DataTexture(data,width,height,THREE.RGBAFormat,THREE.FloatType);
      tex.needsUpdate=true;tex.minFilter=tex.magFilter=THREE.NearestFilter;return tex;};
    const column=make(columns),cloudHeight=make(heights),R=6000000;
    const uniforms={...source.uniforms,uBodyR:{value:R},uGroundR:{value:R},uRout:{value:R+20000},
      uSpin:{value:new THREE.Matrix3()},uColumnMix:{value:0},uOpticalColumns:{value:column},uOpticalColumnsNext:{value:column},
      uColumnHeights:{value:cloudHeight},uColumnHeightsNext:{value:cloudHeight},
      uCameraLocal:{value:new THREE.Vector3()},uRay:{value:new THREE.Vector3(-1,0,0)},uStart:{value:0},uEnd:{value:0},
      uSunEnergy:{value:0},uSecondarySunEnergy:{value:0},air_uEnabled:{value:0}};
    const vertex='varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}';
    const fragment=prefix+'uniform vec3 uRay;uniform float uStart,uEnd;void main(){vec4 c=cloudCachedColumn(uRay,uStart,uEnd);gl_FragColor=vec4(c.a,0,0,1);}';
    const materials=[fragment,fragment.replace('iteration<4','iteration<0')].map(fragmentShader=>new THREE.ShaderMaterial({
      defines:source.defines,uniforms,vertexShader:vertex,fragmentShader,depthTest:false,depthWrite:false}));
    const geometry=new THREE.PlaneGeometry(2,2),mesh=new THREE.Mesh(geometry,materials[0]);
    const scene=new THREE.Scene(),camera=new THREE.Camera();scene.add(mesh);
    const target=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,depthBuffer:false}),saved=r.getRenderTarget(),records=[];
    for(const amplitude of [-40000,-20000,20000,40000]) {
      for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
        const latitude=(.5-(y+.5)/height)*Math.PI,longitude=(x+.5)/width*2*Math.PI;
        heights[(y*width+x)*4]=15000+amplitude*Math.cos(latitude)*Math.cos(longitude);
      }
      cloudHeight.needsUpdate=true;
      for(const altitude of [6000,8000,10000,12000]) {
        const z=R+altitude,originX=450000;
        const residual=x=>Math.hypot(x,z)-R-(15000+amplitude*x/Math.hypot(x,z));
        let low=0,high=originX;
        if(residual(low)>=0 || residual(high)<=0)throw Error('Analytic case lacks near root');
        for(let k=0;k<60;k++){const middle=(low+high)*.5;if(residual(middle)>0)high=middle;else low=middle;}
        const exact=originX-(low+high)*.5;
        const outerX=Math.sqrt((R+20000)**2-z*z),start=originX-outerX;
        const outerH=15000+amplitude*outerX/(R+20000);
        const old=originX-Math.sqrt((R+outerH)**2-z*z),end=(exact+old)*.5;
        const expected=exact<end?.9:0;
        uniforms.uCameraLocal.value.set(originX,0,z);uniforms.uStart.value=start;uniforms.uEnd.value=end;
        const values=[];
        for(const material of materials){mesh.material=material;r.setRenderTarget(target);r.render(scene,camera);
          const pixels=new Float32Array(4);r.readRenderTargetPixels(target,0,0,1,1,pixels);
          if(pixels[3]!==1 || !Number.isFinite(pixels[0]))throw Error('Invalid column output');values.push(pixels[0]);}
        records.push({amplitude,altitude,exact,old,end,expected,current:values[0],control:values[1]});
      }
    }
    r.setRenderTarget(saved);geometry.dispose();target.dispose();column.dispose();cloudHeight.dispose();materials.forEach(m=>m.dispose());
    if(r.getContext().getError())throw Error('GPU error');return records;
  });
  await mkdir('test-results/b4-column-parallax',{recursive:true});
  await writeFile('test-results/b4-column-parallax/report.json',JSON.stringify({fingerprint:await evidenceFingerprint('tools/b4columnparallaxtest.js'),records,errors},null,2));
  const maximum=Math.max(...records.map(r=>Math.abs(r.current-r.expected))),failedControl=records.filter(r=>Math.abs(r.control-r.expected)>.1).length;
  console.log({cases:records.length,maximum,failedControl,errors});assert.deepEqual(errors,[]);
  assert.ok(maximum<.01,'Local deck must use its own radial column for opaque rejection');
  assert.ok(failedControl>=8,'Old envelope query must fail these parallax controls');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
