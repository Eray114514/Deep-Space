// Compile attribution only. No visual or performance acceptance is inferred.
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
const variant=process.argv[2] || 'full';
const {server,port}=await startServer(0);
const browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
try {
  const page=await browser.newPage();
  page.on('console',m=>console.log(m.text()));page.on('pageerror',e=>console.error(String(e)));
  await page.route('**/__compile-probe',r=>r.fulfill({contentType:'text/html',body:'<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/__compile-probe`);
  const result=await page.evaluate(async variant=>{
    const THREE=await import('/vendor/three.module.js');
    const {makeCloudVolumeMaterial}=await import('/src/clouds-webgl.js');
    const renderer=new THREE.WebGLRenderer();
    const p={R:6000000,stellarOccluders:[],hasLiquid:true,seaRadius:6000000};
    const mat=makeCloudVolumeMaterial(p,{rIn:6000250,rOut:6020000,localWeather:true,ox:1,oy:2,oz:3,cov0:.3,cov1:.7});
    if(variant==='far')mat.defines.CLOUD_FAR_VIEW=1;
    function replaceFunction(source,name,body){
      const start=source.indexOf(name+'('),open=source.indexOf('{',start);let close=open+1,depth=1;
      for(;depth && close<source.length;close++){if(source[close]==='{')depth++;else if(source[close]==='}')depth--;}
      return source.slice(0,open+1)+body+source.slice(close-1);
    }
    if(variant==='no-source')mat.fragmentShader=replaceFunction(mat.fragmentShader,'cloudSource','return vec3(1);');
    if(variant==='simple-density')mat.fragmentShader=replaceFunction(mat.fragmentShader,'productionSpeciesAt','return vec2(0.01,0);');
    if(variant==='no-sun-march')mat.fragmentShader=replaceFunction(mat.fragmentShader,'cloudSunOpticalDepth','return 1.0;');
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();scene.add(new THREE.Mesh(new THREE.SphereGeometry(1),mat));
    const started=performance.now();
    const compiled=await Promise.race([renderer.compileAsync(scene,camera).then(()=>true),new Promise(r=>setTimeout(()=>r(false),60000))]);
    const result={variant,compiled,ms:performance.now()-started,programs:renderer.info.programs.map(p=>({ready:p.isReady(),diagnostics:p.diagnostics}))};
    console.log(JSON.stringify(result));return result;
  },variant);
  console.log(JSON.stringify(result));
} finally {await browser.close();await new Promise(r=>server.close(r));}
