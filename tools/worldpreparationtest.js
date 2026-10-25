// Real publication selection/revision contracts, using Three objects and the
// actual compilePrograms adapter. No GLSL compilation, uploads or GPU acceptance.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import * as THREE from 'three';
import {captureWorldPublication} from '../src/world-publication.js';
import {compileWorldPublicationVariant,worldPublicationRevision} from '../src/destination-preparation.js';

const paths=['src/destination-preparation.js','src/world-publication.js','src/program-preparation.js','src/render-prewarm.js','tools/worldpreparationtest.js'];
const frozen=new Map(await Promise.all(paths.map(async path=>[path,await readFile(path)])));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const out=`test-results/world-preparation/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});for(const [path,bytes] of frozen)await writeFile(`${out}/${path.split('/').at(-1)}`,bytes);
const cases=[],observations=[],fixtures=[];
const microtasks=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const renderable=object=>object.isMesh||object.isPoints||object.isLine||object.isSprite;
const names=objects=>objects.map(object=>object.name).sort();
async function test(name,work) {
  const start=fixtures.length;
  try {await work();cases.push({name,passed:true});}
  catch(error){cases.push({name,passed:false,error:String(error),stack:error?.stack});}
  finally {for(const fixture of fixtures.slice(start))fixture.dispose();await microtasks();}
}
function fixture({programs=false}={}) {
  const objects=[],resources=new Set(),records=[],controller=new AbortController();
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(68,1.6,.1,1e8),universeRoot=new THREE.Group();
  const add=(object,name,layer=0)=>{object.name=name;object.layers.set(layer);objects.push(object);return object;};
  const group=name=>add(new THREE.Group(),name);
  const geometry=new THREE.BoxGeometry();resources.add(geometry);
  const material=new THREE.MeshStandardMaterial({side:THREE.DoubleSide,roughness:.25});resources.add(material);
  const shader=new THREE.ShaderMaterial({uniforms:{clock:{value:.5},tint:{value:new THREE.Color(0x8899aa)}},defines:{CITY_MODE:1}});resources.add(shader);
  const mesh=(name,{layer=0,mat=material,instanced=false}={})=>{
    const object=instanced?new THREE.InstancedMesh(geometry,mat,1):new THREE.Mesh(geometry,mat);
    if(instanced)object.count=0;return add(object,name,layer);
  };
  const light=(name,kind='point',layer=0)=>add(kind==='ambient'?new THREE.AmbientLight():kind==='hemi'?new THREE.HemisphereLight():new THREE.PointLight(),name,layer);
  scene.environment=new THREE.Texture();resources.add(scene.environment);scene.environmentIntensity=.6;scene.environmentRotation.set(.1,.2,.3);scene.fog=new THREE.FogExp2(0x223344,.001);
  camera.layers.set(3);camera.position.set(11,12,13);camera.matrixWorldNeedsUpdate=true;
  const activeBody={group:group('active-body')},hiddenBody={group:group('other-hidden-body')};hiddenBody.group.visible=false;
  const activeMesh=mesh('active-world'),activeLamp=light('active-world-lamp'),unselected=mesh('other-hidden-body-mesh'),unselectedLamp=light('other-hidden-body-lamp');
  activeBody.group.add(activeMesh,activeLamp);hiddenBody.group.add(unselected,unselectedLamp);universeRoot.add(activeBody.group,hiddenBody.group);
  const persistent=mesh('persistent-hidden'),persistentZero=mesh('persistent-zero',{instanced:true}),volume=mesh('volume',{layer:2});persistent.visible=false;persistentZero.visible=false;
  const ambient=light('global-ambient','ambient'),nonWorld=light('volume-light','point',2),sunShadow=add(new THREE.DirectionalLight(),'sun-shadow');sunShadow.castShadow=true;sunShadow.visible=false;
  const shipRoot=group('ship-root'),interior=group('ship-interior'),hull=mesh('ship-hull',{layer:3}),cabin=mesh('ship-cabin',{layer:6});interior.add(cabin);shipRoot.add(hull,interior);
  scene.add(universeRoot,persistent,persistentZero,volume,ambient,nonWorld,sunShadow,sunShadow.target,shipRoot);
  const world={planets:[activeBody,hiddenBody],compactObjects:[],artificialSites:[]};
  const city=group('new-city'),cityMesh=mesh('new-city-mesh'),cityLamp=light('new-city-lamp'),cityPoints=add(new THREE.Points(geometry,shader),'new-city-points');city.add(cityMesh,cityLamp);
  const lightGroup=group('new-light-group'),hemi=light('new-light-group-hemi','hemi');lightGroup.add(hemi);
  const newBody={group:group('new-body')},newMesh=mesh('new-body-mesh'),newInstances=mesh('new-body-zero-instances',{instanced:true}),futureLamp=light('new-body-lamp');
  newBody.group.visible=false;newMesh.visible=false;newBody.group.add(newMesh,newInstances,futureLamp);
  const hiddenBranch=group('new-body-hidden-light-branch'),hiddenLamp=light('hidden-descendant-lamp');hiddenBranch.visible=false;hiddenBranch.add(hiddenLamp);newBody.group.add(hiddenBranch);
  const secondBody={group:group('new-compact-body')},secondMaterial=new THREE.MeshPhongMaterial();resources.add(secondMaterial);
  const secondMesh=mesh('new-compact-mesh',{mat:secondMaterial});secondBody.group.add(secondMesh);
  const orphan=group('new-orphan-site'),siteMesh=mesh('new-orphan-mesh'),siteLamp=light('new-orphan-lamp');orphan.add(siteMesh,siteLamp);
  const authoredHidden=group('authored-hidden-site'),authoredMesh=mesh('authored-hidden-site-mesh'),authoredLamp=light('authored-hidden-site-lamp');authoredHidden.visible=false;authoredHidden.add(authoredMesh,authoredLamp);
  const publication=captureWorldPublication(world,{build(){
    activeBody.group.add(city,cityPoints,lightGroup);world.planets.push(newBody);world.compactObjects.push(secondBody);
    universeRoot.add(newBody.group,secondBody.group,orphan,authoredHidden);
    world.artificialSites.push({group:city,parentBody:activeBody},{group:orphan,parentBody:null},{group:orphan,parentBody:null},{group:authoredHidden,parentBody:null});
  }});
  const hdr=new THREE.WebGLRenderTarget(32,32,{type:THREE.HalfFloatType,colorSpace:THREE.LinearSRGBColorSpace});resources.add(hdr);
  const caller={name:'caller-cube'};let target=caller,face=4,mip=2,ready=false,throwCompile=false,compileError,versionNoise=false,events=0;
  const properties=new Map(),program={program:{},isReady:()=>ready};
  const renderer={domElement:new EventTarget(),shadowMap:{enabled:true,type:THREE.PCFShadowMap},toneMapping:THREE.NoToneMapping,outputColorSpace:THREE.SRGBColorSpace,
    getContext:()=>({isContextLost:()=>false}),properties:{has:value=>properties.has(value),get:value=>properties.get(value)},
    getRenderTarget:()=>target,getActiveCubeFace:()=>face,getActiveMipmapLevel:()=>mip,
    setRenderTarget(value,nextFace=0,nextMip=0){target=value;face=nextFace;mip=nextMip;},
    compile(source,compileCamera,lighting){
      const selected=[],sourceLights=[],lights=[],lightingRenderables=[];
      source.traverse(object=>{if(renderable(object))selected.push(object);if(object.isLight)sourceLights.push(object);});
      source.traverseVisible(object=>{if(object.isLight)sourceLights.push(object);});
      lighting.traverseVisible(object=>{if(object.isLight)lights.push(object);if(renderable(object))lightingRenderables.push(object);});
      records.push({source,lighting,compileCamera,selected,sourceLights,lights,lightingRenderables,target,face,mip,live:snapshot(),
        environment:lighting.environment,fog:lighting.fog,environmentIntensity:lighting.environmentIntensity,rotation:lighting.environmentRotation.toArray()});
      if(throwCompile)throw compileError;
      const used=new Set(selected.flatMap(object=>[object.material].flat()));
      if(versionNoise)for(const material of used)for(let i=0;i<3;i++)material.needsUpdate=true;
      if(!programs)return new Set();
      for(const material of used)properties.set(material,{programs:new Map([['actual-family',program]]),currentProgram:program});return used;
    },
  };
  for(const object of objects){
    object.addEventListener('added',()=>events++);object.addEventListener('removed',()=>events++);
    object.updateMatrixWorld=()=>assert.fail(`Updated live world matrix: ${object.name}`);object.updateWorldMatrix=()=>assert.fail(`Updated live matrix: ${object.name}`);
    if(renderable(object))object.clone=()=>assert.fail(`Cloned source renderable: ${object.name}`);
  }
  function snapshot(){return objects.map(object=>({object,parent:object.parent,visible:object.visible,mask:object.layers.mask,frustumCulled:object.frustumCulled,
    matrix:object.matrix.toArray(),worldMatrix:object.matrixWorld.toArray(),dirty:object.matrixWorldNeedsUpdate,
    geometry:object.geometry,material:object.material,count:object.count,instance:object.instanceMatrix?.array,
    instanceData:object.instanceMatrix?Array.from(object.instanceMatrix.array):null,castShadow:object.castShadow,receiveShadow:object.receiveShadow}));}
  const config={scene,camera,universeRoot,ship:{group:shipRoot,int:{group:interior},separateInterior:true},shadowLight:sunShadow,shadows:false,publication,target:hdr};
  const f={scene,camera,universeRoot,world,publication,config,renderer,records,resources,objects,snapshot,material,shader,geometry,activeBody,activeMesh,activeLamp,hiddenBody,
    city,cityMesh,cityLamp,cityPoints,lightGroup,hemi,newBody,newMesh,newInstances,futureLamp,hiddenBranch,hiddenLamp,secondBody,secondMesh,orphan,siteLamp,authoredHidden,
    ambient,sunShadow,persistent,persistentZero,hdr,caller,group,mesh,light,get events(){return events;},set ready(value){ready=value;},set versionNoise(value){versionNoise=value;},
    fail(error){throwCompile=true;compileError=error;},revision(overrides={}){return worldPublicationRevision(renderer,{...config,...overrides});},
    run(overrides={},options={signal:controller.signal}){return compileWorldPublicationVariant(renderer,{...config,...overrides},options);},
    restored(){assert.equal(target,caller);assert.equal(face,4);assert.equal(mip,2);},
    expected:[activeMesh,persistent,persistentZero,hull,cityMesh,cityPoints,newMesh,newInstances,secondMesh,siteMesh],
    expectedLights:[ambient,activeLamp,cityLamp,hemi,futureLamp,siteLamp],
    dispose(){controller.abort();publication.abandon();for(const resource of resources)resource.dispose();},
  };fixtures.push(f);return f;
}

await test('real capture registers all body/site/direct-child products and selection virtually reveals only their intended WORLD families',async()=>{
  const f=fixture();assert.equal(f.publication.visibility.size,7);const before=f.snapshot(),pending=f.run();f.restored();
  const record=f.records[0];assert.deepEqual(new Set(record.selected),new Set(f.expected));assert.equal(record.selected.length,f.expected.length);
  assert.ok(record.selected.includes(f.activeMesh));assert.ok(record.selected.includes(f.newMesh));assert.ok(record.selected.includes(f.cityPoints));assert.ok(record.selected.includes(f.newInstances));
  assert.deepEqual(record.live,before);assert.deepEqual(f.snapshot(),before);assert.equal(f.events,0);
  for(const root of f.publication.visibility.keys())assert.equal(root.visible,false);await pending;assert.deepEqual(f.snapshot(),before);
});
await test('current and future ordinary/instanced objects sharing material are not collapsed into one renderable',async()=>{
  const f=fixture();await f.run();const selected=f.records[0].selected;
  assert.equal(f.activeMesh.material,f.newMesh.material);assert.equal(f.activeMesh.material,f.newInstances.material);
  for(const object of [f.activeMesh,f.newMesh,f.newInstances,f.persistentZero])assert.equal(selected.filter(value=>value===object).length,1);
  assert.equal(f.newInstances.count,0);assert.equal(f.persistentZero.count,0);
});
await test('one private light domain includes active and future lamps exactly once while excluding hidden branches/layers',async()=>{
  const f=fixture();await f.run();const record=f.records[0];assert.deepEqual(names(record.lights),names(f.expectedLights));
  assert.equal(new Set(record.lights.map(light=>light.name)).size,f.expectedLights.length);assert.deepEqual(record.sourceLights,[]);assert.deepEqual(record.lightingRenderables,[]);
  for(const light of record.lights){assert.equal(light.visible,true);assert.equal(light.layers.mask,1);assert.ok(!f.expectedLights.includes(light));}
  assert.equal(record.environment,f.scene.environment);assert.equal(record.fog,f.scene.fog);assert.equal(record.environmentIntensity,f.scene.environmentIntensity);
  assert.deepEqual(record.rotation,f.scene.environmentRotation.toArray());
});
await test('both sun shadow variants preserve the same source revision while compiling their distinct light domains',async()=>{
  const f=fixture(),before=f.revision();const off=await f.run(),on=await f.run({shadows:true});
  assert.equal(off,before);assert.equal(on,before);assert.equal(f.revision({shadows:true}),before);
  assert.equal(f.records[0].lights.some(light=>light.name===f.sunShadow.name),false);
  assert.equal(f.records[1].lights.filter(light=>light.name===f.sunShadow.name).length,1);assert.equal(f.sunShadow.visible,false);
});
await test('HDR target is selected only synchronously and the complete caller cube face/mip tuple is restored before readiness',async()=>{
  const f=fixture({programs:true}),before=f.snapshot(),pending=f.run();f.restored();assert.equal(f.records[0].target,f.hdr);assert.equal(f.records[0].face,0);assert.equal(f.records[0].mip,0);
  let settled=false;pending.then(()=>{settled=true;},()=>{settled=true;});await microtasks();assert.equal(settled,false);assert.deepEqual(f.snapshot(),before);
  f.ready=true;await pending;f.restored();assert.deepEqual(f.snapshot(),before);
});
await test('compile throw preserves falsy failure and restores the full target tuple without mutating the source',async()=>{
  const f=fixture(),before=f.snapshot();f.fail(false);let threw=false,error;try {f.run();} catch(cause){threw=true;error=cause;}
  assert.equal(threw,true);assert.equal(error,false);f.restored();assert.deepEqual(f.snapshot(),before);assert.equal(f.events,0);
});
await test('the compile camera excludes attached camera rigs and preserves the live camera layer/matrices',async()=>{
  const f=fixture(),rig=f.group('attached-rig');rig.clone=()=>assert.fail('Cloned attached camera rig');f.camera.add(rig);
  const mask=f.camera.layers.mask,matrix=f.camera.matrixWorld.toArray();await f.run();assert.equal(f.records[0].compileCamera.children.length,0);
  assert.equal(f.records[0].compileCamera.layers.mask,1);assert.equal(f.camera.layers.mask,mask);assert.deepEqual(f.camera.matrixWorld.toArray(),matrix);
});
await test('normal material version increments during preparation do not make the captured revision stale immediately',async()=>{
  const f=fixture(),before=f.revision(),version=f.material.version;f.versionNoise=true;
  const captured=await f.run();assert.ok(f.material.version>version);assert.equal(f.material.side,THREE.DoubleSide);assert.equal(captured,before);assert.equal(captured,f.revision());
});

const stable=[
  ['ShaderMaterial uniform scalar/color values',f=>{f.shader.uniforms.clock.value=123.25;f.shader.uniforms.tint.value.setRGB(.2,.3,.4);}],
  ['streamed vertex contents and attribute version',f=>{f.geometry.attributes.position.array[0]+=17;f.geometry.attributes.position.needsUpdate=true;}],
  ['instance array contents/count without changing its compile family',f=>{f.newInstances.instanceMatrix.array[0]=12;f.newInstances.instanceMatrix.needsUpdate=true;f.newInstances.count=1;}],
  ['raw material.version increments',f=>{for(let i=0;i<5;i++){f.material.needsUpdate=true;f.shader.needsUpdate=true;}}],
  ['positive fractional material magnitudes',f=>{f.material.roughness=.73;}],
  ['lamp intensity/color/transform values',f=>{f.cityLamp.intensity=4.5;f.cityLamp.color.setRGB(.1,.2,.3);f.cityLamp.position.set(123,45,67);} ],
  ['live world transforms',f=>{f.activeBody.group.position.set(20,30,40);f.newBody.group.scale.setScalar(3.5);} ],
  ['vertex buffer count with unchanged attribute layout',f=>{f.geometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(144),3));}],
  ['non-program metadata',f=>{f.material.name='renamed';f.material.userData.runtimeCounter=123;f.cityMesh.name='renamed-city';}],
];
for(const [name,mutate] of stable)await test(`revision remains stable for ${name}`,async()=>{
  const f=fixture(),before=f.revision();mutate(f);assert.equal(f.revision(),before);
});

const invalidates=[
  ['lamp identity even with the same type',f=>{const replacement=f.light('new-city-lamp');f.city.remove(f.cityLamp);f.city.add(replacement);} ],
  ['lamp type',f=>{f.cityLamp.type='SpotLight';}],
  ['lamp castShadow flag',f=>{f.cityLamp.castShadow=true;}],
  ['lamp visibility',f=>{f.cityLamp.visible=false;}],
  ['hidden descendant lamp reveal',f=>{f.hiddenBranch.visible=true;}],
  ['lamp WORLD layer membership',f=>{f.cityLamp.layers.set(2);} ],
  ['previously hidden non-batch world reveal',f=>{f.hiddenBody.group.visible=true;}],
  ['authored future-root visibility contract',f=>{f.publication.visibility.set(f.authoredHidden,true);} ],
  ['material customProgramCacheKey value',f=>{f.material.customProgramCacheKey=()=>'future-structural-variant';}],
  ['material defines',f=>{f.shader.defines.CITY_MODE=2;}],
  ['shader source structure',f=>{f.shader.vertexShader+='\n// structural change';}],
  ['material primitive compile flags',f=>{f.material.vertexColors=true;}],
  ['material integer enum',f=>{f.material.normalMapType=THREE.ObjectSpaceNormalMap;}],
  ['material zero/sign boundary',f=>{f.material.alphaTest=.5;}],
  ['material replacement despite matching parameters',f=>{const next=f.material.clone();f.resources.add(next);f.activeMesh.material=next;}],
  ['attribute addition',f=>{f.geometry.setAttribute('tangent',new THREE.Float32BufferAttribute(new Float32Array(96),4));}],
  ['attribute itemSize',f=>{f.geometry.attributes.uv.itemSize=3;}],
  ['attribute normalized layout',f=>{f.geometry.attributes.uv.normalized=true;}],
  ['attribute storage type',f=>{f.geometry.setAttribute('uv',new THREE.Uint16BufferAttribute(new Uint16Array(48),2));}],
  ['HDR target component type',f=>{f.hdr.texture.type=THREE.FloatType;}],
  ['HDR target output color space',f=>{f.hdr.texture.colorSpace=THREE.SRGBColorSpace;}],
  ['HDR target pixel format',f=>{f.hdr.texture.format=THREE.RedFormat;}],
  ['HDR target internalFormat',f=>{f.hdr.texture.internalFormat='RGBA16F';}],
  ['HDR target multisampling structure',f=>{f.hdr.samples=4;}],
  ['HDR cube target kind even with the same explicit sampling fields',f=>{
    const target=new THREE.WebGLCubeRenderTarget(32);f.resources.add(target);for(const key of ['type','colorSpace','mapping','format','internalFormat'])target.texture[key]=f.hdr.texture[key];f.config.target=target;
  }],
  ['batch root ownership/reparent',f=>{const next=f.group('different-owner');f.scene.add(next);next.add(f.newBody.group);} ],
];
for(const [name,mutate] of invalidates)await test(`revision invalidates for ${name}`,async()=>{
  const f=fixture(),before=f.revision();mutate(f);assert.notEqual(f.revision(),before);
});
for(const [name,mutate] of [
  ['map introduction',texture=>{}],['sampler mapping',texture=>{texture.mapping=THREE.CubeReflectionMapping;}],
  ['sampler component type',texture=>{texture.type=THREE.FloatType;}],['sampler format',texture=>{texture.format=THREE.RedFormat;}],
  ['sampler channel',texture=>{texture.channel=1;}],['sampler color space',texture=>{texture.colorSpace=THREE.SRGBColorSpace;}],
])await test(`revision invalidates for material ${name}`,async()=>{
  const f=fixture(),texture=new THREE.Texture();f.resources.add(texture);
  if(name!=='map introduction')f.material.map=texture;const before=f.revision();mutate(texture);f.material.map=texture;assert.notEqual(f.revision(),before);
});
await test('same-shape texture replacements and image/UV content changes retain their existing sampler obligation',async()=>{
  const f=fixture(),first=new THREE.Texture(),second=new THREE.Texture();f.resources.add(first);f.resources.add(second);f.material.map=first;const before=f.revision();
  f.material.map=second;second.image={data:new Uint8Array(16),width:2,height:2};second.repeat.set(3,4);second.needsUpdate=true;assert.equal(f.revision(),before);
});
await test('conservative integer-boundary material changes are observed without claiming to mirror Three program keys',async()=>{
  const f=fixture();f.material.roughness=1;const before=f.revision();f.material.roughness=.8;
  observations.push({name:'integer-to-fraction roughness',conservativeRetry:f.revision()!==before,contract:'Allowed conservative retry; only positive fractional magnitude changes must stay stable'});
});

const sources=[];for(const [path,bytes] of frozen)sources.push({path,bytes:bytes.length,sha256:sha(bytes),stable:sha(bytes)===sha(await readFile(path))});
const report={kind:'cpu-contracts',scope:'Actual world-publication capture and compiler-only selection/revision; fake compile adapter; no native program/GPU/performance claims',
  passed:cases.filter(item=>item.passed).length,total:cases.length,sources,observations,cases};
await writeFile(`${out}/report.json`,`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify({out,passed:report.passed,total:report.total,failures:cases.filter(item=>!item.passed)},null,2));
assert.ok(sources.every(source=>source.stable),'Preparation inputs changed during CPU execution');assert.equal(report.passed,report.total);
