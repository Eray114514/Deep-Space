// Compare the installed LUT bake with its frozen predecessor. The optional
// candidate control routes only the same angular-loop uniform change.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const reference='bc340db';
const original=execFileSync('git',['show',`${reference}:src/atmosphere-multiple-scattering.js`],{encoding:'utf8'});
const replacements=[
  ['uEnabled: { value: 1 }, uMultipleEnabled: { value: 0 },','uEnabled: { value: 1 }, uMultipleEnabled: { value: 0 },\n      uMultipleDirections: { value: directions },'],
  ['#define VIEW_STEPS ${steps}','#define VIEW_STEPS ${steps}\n      uniform int uMultipleDirections;'],
  ['for(int j=0;j<${directions};j++)','for(int j=0;j<uMultipleDirections;j++)'],
];
let candidate=original;
for(const [from,to] of replacements) {
  assert.equal(candidate.split(from).length-1,1,`Candidate source match must be unique: ${from}`);
  candidate=candidate.replace(from,to);
}
let reverted=candidate;
for(const [from,to] of [...replacements].reverse())reverted=reverted.replace(to,from);
assert.equal(reverted,original,'Only the declared loop uniform/bound edits are allowed');
const wrong=candidate.replace('uMultipleDirections: { value: directions },','uMultipleDirections: { value: 64 },');
assert.notEqual(wrong,candidate);
const sha=value=>createHash('sha256').update(value).digest('hex');
const current=await readFile('src/atmosphere-multiple-scattering.js');
const candidateControl=process.argv.includes('--candidate-control');
if(!candidateControl) {
  assert.equal(current.toString().replaceAll('\r\n','\n'),candidate.replaceAll('\r\n','\n'),
    'Production module must be exactly the verified angular-loop change');
  candidate=current.toString();
}
const sources={reference,module:'src/atmosphere-multiple-scattering.js',originalSha256:sha(original),
  candidateSha256:sha(candidate),wrongCountSha256:sha(wrong),repositoryModuleSha256:sha(current),
  replacements:replacements.length,wrongCount:64,candidateControl,
  invariant:'Fibonacci direction positions, all angular divisors, VIEW_STEPS, ray segment nodes, ground contribution and closure arithmetic are unchanged.'};
if(process.argv.includes('--check-source')) {
  console.log(JSON.stringify({sourceContract:true,sources}));
  process.exit(0);
}

const out=`test-results/atmosphere-multiple-loop/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
await Promise.all([
  writeFile(`${out}/original-source.js`,original),writeFile(`${out}/candidate-source.js`,candidate),
  writeFile(`${out}/wrong-count-source.js`,wrong),
]);
const before=await evidenceFingerprint('tools/atmospheremultiplelooptest.js');
const {server,port}=await startServer(0);
const errors=[],warnings=[];let browser,result;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined,headless:true});
  const page=await browser.newPage();
  page.on('pageerror',error=>errors.push(String(error)));
  page.on('console',message=>{
    if(message.type()==='error')errors.push(message.text());
    if(message.type()==='warning'&&warnings.length<50)warnings.push(message.text());
  });
  for(const [name,body] of [['original',original],['candidate',candidate],['wrong-count',wrong]]) {
    await page.route(`**/src/atmosphere-multiple-${name}-experiment.js`,route=>route.fulfill({contentType:'text/javascript',body}));
  }
  await page.route('**/__atmosphere-multiple-loop',route=>route.fulfill({contentType:'text/html',body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/__atmosphere-multiple-loop`);
  result=await page.evaluate(async()=>{
    const T=await import('three');
    const {atmosphereUniforms}=await import('/src/atmosphere-uniforms.js');
    const {atmosphereRenderProfile,createAtmosphereOpticalDepthLut}=await import('/src/atmosphere-pass-webgl.js');
    const original=(await import('/src/atmosphere-multiple-original-experiment.js')).createMultipleScatteringLut;
    const candidate=(await import('/src/atmosphere-multiple-candidate-experiment.js')).createMultipleScatteringLut;
    const wrong=(await import('/src/atmosphere-multiple-wrong-count-experiment.js')).createMultipleScatteringLut;
    const renderer=new T.WebGLRenderer();renderer.setSize(32,32);
    const gl=renderer.getContext();
    const debug=gl.getExtension('WEBGL_debug_renderer_info');
    const gpu=gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:gl.RENDERER);
    const ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if(!ext)throw new Error('GPU timer query extension is required for warm-cost evidence');
    if(!gl.getExtension('EXT_color_buffer_float'))throw new Error('Floating-point render targets are required');
    let lostEvents=0;
    renderer.domElement.addEventListener('webglcontextlost',()=>lostEvents++);
    const preexisting=gl.getError();
    const leases=[];
    const render=renderer.render;
    // The production function disposes its transient material. Suppress that
    // event on this isolated renderer so original and candidate program leases
    // coexist across old/new/old/new. No shader source or bake arithmetic changes.
    renderer.render=function(object,camera) {
      const material=object.material;
      if(material?.fragmentShader?.includes('vec3 meanL=vec3(0), meanReturn=vec3(0);')&&!material.userData.loopTestLease) {
        const dispose=material.dispose;
        material.userData.loopTestLease=true;
        material.dispose=()=>{};
        leases.push({material,dispose});
      }
      return render.call(this,object,camera);
    };
    const nativeReads=[];
    const timings=[];
    const cases=[];
    const controls=[];
    const sleep=()=>new Promise(resolve=>setTimeout(resolve,1));
    const run=async(fn,uniforms,options,label,warm)=>{
      const query=warm?gl.createQuery():null;
      if(query)gl.beginQuery(ext.TIME_ELAPSED_EXT,query);
      const started=performance.now();
      let target;
      const usesDefaultOptions=options.directions===128&&options.steps===48;
      try {target=fn(renderer,uniforms,usesDefaultOptions?undefined:options);}
      finally {if(query)gl.endQuery(ext.TIME_ELAPSED_EXT);}
      const cpuSubmitMs=performance.now()-started;
      const native=new Uint16Array(32*32*4);
      try {
        renderer.readRenderTargetPixels(target,0,0,32,32,native);
        const readCompleteMs=performance.now()-started;
        const error=gl.getError(),lost=gl.isContextLost();
        const values=Array.from(native,value=>T.DataUtils.fromHalfFloat(value));
        let maxAlphaError=0,maximum=0,occupied=0;
        for(let index=0;index<values.length;index+=4) {
          maxAlphaError=Math.max(maxAlphaError,Math.abs(values[index+3]-1));
          for(let channel=0;channel<3;channel++)maximum=Math.max(maximum,Math.abs(values[index+channel]));
          if(values[index]>0||values[index+1]>0||values[index+2]>0)occupied++;
        }
        let gpuMs=null;
        if(query) {
          const deadline=performance.now()+30000;
          while(!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)) {
            if(performance.now()>deadline)throw new Error(`GPU query timed out: ${label}`);
            if(gl.isContextLost())throw new Error(`Context lost while polling: ${label}`);
            await sleep();
          }
          if(gl.getParameter(ext.GPU_DISJOINT_EXT))throw new Error(`Disjoint GPU timing: ${label}`);
          gpuMs=gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6;
        }
        const entry={label,warm,options,usesDefaultOptions,cpuSubmitMs,readCompleteMs,fullCompletionMs:performance.now()-started,gpuMs,
          type:target.texture.type,expectedHalfType:T.HalfFloatType,error,lost,finite:values.every(Number.isFinite),
          maxAlphaError,maximum,occupied,programs:renderer.info.programs.length,leases:leases.length};
        timings.push(entry);
        nativeReads.push({label,format:'RGBA16F Uint16 native bits; values converted with THREE.DataUtils.fromHalfFloat',native:Array.from(native),values});
        return {label,native:Array.from(native),values,...entry};
      } finally {if(query)gl.deleteQuery(query);target.dispose();}
    };
    const bodies=[
      {name:'lush',body:{R:6000000,type:'lush',atmosphere:{pressureBar:1},weatherProfile:{temperatureK:286}},albedo:[.18,.2,.16]},
      {name:'ice',body:{R:900000,type:'ice',atmosphere:{pressureBar:.15},weatherProfile:{temperatureK:190}},albedo:[.5,.56,.6]},
      {name:'desert',body:{R:7000000,type:'desert',atmosphere:{pressureBar:2.7},weatherProfile:{temperatureK:410}},albedo:[.24,.17,.08]},
    ];
    const difference=(a,b)=>{
      let rgbMax=0,alphaMax=0,nativeMismatches=0;
      for(let index=0;index<a.values.length;index++) {
        const error=Math.abs(a.values[index]-b.values[index]);
        if(index%4===3)alphaMax=Math.max(alphaMax,error);else rgbMax=Math.max(rgbMax,error);
        if(a.native[index]!==b.native[index])nativeMismatches++;
      }
      return {rgbMax,alphaMax,nativeMismatches};
    };
    try {
      // Warm renderer setup outside the LUT cold-program measurements.
      const material=new T.ShaderMaterial({vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',
        fragmentShader:'void main(){gl_FragColor=vec4(0,0,0,1);}',depthTest:false,depthWrite:false});
      const geometry=new T.PlaneGeometry(2,2),scene=new T.Scene();scene.add(new T.Mesh(geometry,material));
      renderer.render(scene,new T.Camera());gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));
      material.dispose();geometry.dispose();
      for(const {name,body,albedo} of bodies) {
        const {profile,densityScale}=atmosphereRenderProfile(body);
        const lut=createAtmosphereOpticalDepthLut(profile);
        const texture=new T.DataTexture(lut.data,lut.width,lut.height,T.RGBAFormat,T.FloatType);
        texture.minFilter=texture.magFilter=T.NearestFilter;texture.needsUpdate=true;
        const uniforms=atmosphereUniforms();
        uniforms.tOpticalDepth.value=texture;
        for(const [key,value] of Object.entries({uGroundR:profile.groundRadiusMeters,uTopR:profile.topRadiusMeters,
          uTopAltitude:profile.topAltitudeMeters,uRayleighScaleHeight:profile.rayleighScaleHeightMeters,
          uMieScaleHeight:profile.mieScaleHeightMeters,uOzoneCenter:profile.ozoneCenterMeters,
          uOzoneHalfWidth:profile.ozoneHalfWidthMeters,uDensityScale:densityScale}))uniforms[key].value=value;
        uniforms.uBetaRayleigh.value.fromArray(profile.rayleigh);
        uniforms.uBetaMieScatter.value.fromArray(profile.mie.scattering);
        uniforms.uBetaMieExtinction.value.fromArray(profile.mie.extinction);
        uniforms.uBetaOzone.value.fromArray(profile.ozoneAbsorption);
        uniforms.uGroundAlbedo.value.setRGB(...albedo);
        renderer.initTexture(texture);
        try {
          for(const options of [{directions:128,steps:48},{directions:32,steps:24}]) {
            const rows=[];
            for(const [index,variant] of ['original','candidate','original','candidate'].entries()) {
              rows.push(await run(variant==='original'?original:candidate,uniforms,options,
                `${name}/${options.directions}x${options.steps}/${index}-${variant}`,index>=2));
            }
            cases.push({name,body,profile,densityScale,albedo,options,labels:rows.map(row=>row.label),
              parity:difference(rows[0],rows[1]),parityRepeat:difference(rows[2],rows[3]),
              originalRepeat:difference(rows[0],rows[2]),candidateRepeat:difference(rows[1],rows[3])});
            if(options.directions===128) {
              const bad=await run(wrong,uniforms,options,`${name}/128x48/wrong-uniform-64`,false);
              controls.push({name,label:bad.label,difference:difference(rows[0],bad)});
            }
          }
        } finally {texture.dispose();}
      }
      return {gpu,preexisting,cases,controls,timings,nativeReads,lostEvents,finalError:gl.getError(),lost:gl.isContextLost(),
        programLeases:leases.length,programs:renderer.info.programs.map(program=>({id:program.id,usedTimes:program.usedTimes})),
        timingBoundary:'Same renderer and retained production-material program leases. First original/candidate call per option compiles its program; later profiles reuse it. Warm GPU query spans complete LUT bake and target setup. Full completion includes native readback and query polling. Explicit readback/polling is diagnostic, not player FPS acceptance.'};
    } finally {
      renderer.render=render;
      for(const {material,dispose} of leases) {material.dispose=dispose;dispose.call(material);}
      renderer.dispose();
    }
  });
  const after=await evidenceFingerprint('tools/atmospheremultiplelooptest.js');
  const stable=before.sourceDigest===after.sourceDigest&&before.verifierDigest===after.verifierDigest;
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,stable,sources,result,errors,warnings,
    boundary:`Independent empty browser page using the actual LUT bake from bc340db and ${candidateControl?'route-only candidate':'installed production module'}. Kernel equivalence/cold preparation evidence; no normal-player scene or art acceptance.`},null,2));
  assert.equal(stable,true);assert.deepEqual(errors,[]);
  assert.equal(result.preexisting,0);assert.equal(result.finalError,0);assert.equal(result.lost,false);assert.equal(result.lostEvents,0);
  for(const row of result.timings) {
    assert.equal(row.type,row.expectedHalfType);assert.equal(row.error,0);assert.equal(row.lost,false);
    assert.equal(row.finite,true);assert.equal(row.maxAlphaError,0);assert.ok(row.occupied>0);
  }
  for(const entry of result.cases) {
    for(const name of ['parity','parityRepeat']) {
      assert.ok(entry[name].rgbMax<.002,`${entry.name} ${name} RGB exceeded unchanged .002 gate`);
      assert.equal(entry[name].alphaMax,0);
    }
    for(const name of ['originalRepeat','candidateRepeat']) {
      assert.equal(entry[name].rgbMax,0);assert.equal(entry[name].alphaMax,0);assert.equal(entry[name].nativeMismatches,0);
    }
  }
  assert.ok(result.controls.every(entry=>entry.difference.rgbMax>=.002),'Wrong direction-count control must fail parity');
  assert.equal(result.programLeases,result.timings.length,'Every bake must retain a program lease');
  console.log(JSON.stringify({out,stable,gpu:result.gpu,cases:result.cases.map(({name,options,parity,originalRepeat,candidateRepeat})=>
    ({name,options,parity,originalRepeat,candidateRepeat})),controls:result.controls,timings:result.timings,
    programLeases:result.programLeases,errors,warnings:warnings.length}));
  console.log(`PASS: native RGBA16F multiple-scattering outer-loop parity; ${out}`);
} catch(error) {
  await writeFile(`${out}/failure.json`,JSON.stringify({before,sources,result,errors,warnings,error:String(error)},null,2));
  throw error;
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
