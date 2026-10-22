// Pure Node construction contract. Execute the independently frozen pre-work
// class, with the same real dependencies, against the current default API.
// This creates no renderer, canvas or GPU context; DPR is a draw-time contract.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import * as THREE from 'three';
import {CloudColumnMap} from '../src/cloud/cloud-column-map.js';
import {OwnedScreenTriangle} from '../src/owned-screen-triangle.js';
import {productionCloudGLSL} from '../src/cloud/production-medium-glsl.js';
import {productionColumnCondensateGLSL} from '../src/cloud/production-shape.js';
import {weatherAtlasGLSL} from '../src/cloud/weather-atlas.js';
import {captureWeatherSources} from '../src/cloud/weather-sources.js';
import {PlanetWeatherStream} from '../src/cloud/planet-weather-stream.js';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

const snapshotKeys=['uWeatherMap','uWeatherMapHi','uSpeciesMap','uBandBounds'];
const replacedKeys=new Set([...snapshotKeys,'uSpin','uSpeciesMask','uCloudAdvectionPhase',
  'uColumnSize','uColumnSamples','uFootprintSamples']);
const nativeBytes=view=>Buffer.from(new Uint8Array(view.buffer,view.byteOffset,view.byteLength));
const fieldSummary=view=>({constructor:view.constructor.name,bytes:view.byteLength,hex:nativeBytes(view).toString('hex')});
function textureSummary(texture) {
  const image=texture.image;
  return {dataTexture:Boolean(texture.isDataTexture),arrayTexture:Boolean(texture.isDataArrayTexture),
    width:image.width,height:image.height,depth:image.depth??1,data:image.data?fieldSummary(image.data):null,
    type:texture.type,format:texture.format,internalFormat:texture.internalFormat,
    minFilter:texture.minFilter,magFilter:texture.magFilter,wrapS:texture.wrapS,wrapT:texture.wrapT,wrapR:texture.wrapR??null,
    colorSpace:texture.colorSpace,generateMipmaps:texture.generateMipmaps,flipY:texture.flipY,
    premultiplyAlpha:texture.premultiplyAlpha,unpackAlignment:texture.unpackAlignment,
    version:texture.version,sourceVersion:texture.source.version,
    offset:texture.offset.toArray(),repeat:texture.repeat.toArray(),rotation:texture.rotation,
    center:texture.center.toArray()};
}
function valueSummary(value) {
  if(value?.isTexture)return {kind:'texture',...textureSummary(value)};
  if(value?.isMatrix3||value?.isMatrix4)return {kind:value.constructor.name,elements:Array.from(value.elements)};
  if(value?.toArray)return {kind:value.constructor.name,values:Array.from(value.toArray())};
  if(ArrayBuffer.isView(value))return fieldSummary(value);
  if(Array.isArray(value))return Array.from(value,valueSummary);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,valueSummary(item)]));
  return value;
}
function materialSummary(material) {
  return {defines:Object.fromEntries(Object.entries(material.defines)),glslVersion:material.glslVersion,
    depthTest:material.depthTest,depthWrite:material.depthWrite,blending:material.blending,side:material.side,
    transparent:material.transparent,premultipliedAlpha:material.premultipliedAlpha,colorWrite:material.colorWrite,
    toneMapped:material.toneMapped,dithering:material.dithering,precision:material.precision,
    uniforms:Object.fromEntries(Object.keys(material.uniforms).sort().map(key=>[key,valueSummary(material.uniforms[key].value)]))};
}
function targetSummary(target) {
  return {width:target.width,height:target.height,depth:target.depth,samples:target.samples,
    depthBuffer:target.depthBuffer,stencilBuffer:target.stencilBuffer,depthTexture:target.depthTexture,
    resolveDepthBuffer:target.resolveDepthBuffer,resolveStencilBuffer:target.resolveStencilBuffer,
    viewport:target.viewport.toArray(),scissor:target.scissor.toArray(),scissorTest:target.scissorTest,
    textures:target.textures.map(textureSummary)};
}
function exactString(actual,expected,label) {
  if(actual===expected)return;
  let index=0;while(index<actual.length&&index<expected.length&&actual[index]===expected[index])index++;
  assert.fail(`${label}: shader text differs at ${index}, old/new bytes ${Buffer.byteLength(expected)}/${Buffer.byteLength(actual)}, `
    +`old/new sha256 ${sha256(expected)}/${sha256(actual)}`);
}
function compare(oldMap,newMap,label) {
  exactString(newMap.material.vertexShader,oldMap.material.vertexShader,`${label} vertex`);
  exactString(newMap.material.fragmentShader,oldMap.material.fragmentShader,`${label} fragment`);
  assert.deepEqual(materialSummary(newMap.material),materialSummary(oldMap.material),`${label} material/uniforms`);
  assert.deepEqual(targetSummary(newMap.target),targetSummary(oldMap.target),`${label} canonical target`);
  assert.deepEqual(newMap.snapshots.map(textureSummary),Array.from(oldMap.snapshots,textureSummary),`${label} snapshots`);
  for(const key of ['width','height','samples','footprintSamples','row','ready','disposed','generation'])
    assert.equal(newMap[key],oldMap[key],`${label} ${key}`);
  assert.deepEqual(Array.from(newMap.uploadMs),Array.from(oldMap.uploadMs),`${label} initial upload samples`);
  const sources=map=>map.weatherSources?Array.from(map.weatherSources.frames,frame=>({hours:frame.hours,revision:frame.revision})):null;
  assert.deepEqual(sources(newMap),sources(oldMap),`${label} source revisions`);
}

function makePlanet({frameMode='none',frameHours=4.5,weatherHours=17.25,mask=-1,production=true,speciesRG=false}) {
  const width=4,height=2,layers=24,textures=[];
  const pattern=(Type,length,offset)=>Type.from({length},(_,index)=>Type===Uint8Array
    ?(index*7+offset)%251:offset+index*.125);
  const dataTexture=(Type,offset,type)=>{
    const texture=new THREE.DataTexture(pattern(Type,width*height*4,offset),width,height,THREE.RGBAFormat,type);
    texture.offset.set(.125,.25);texture.repeat.set(2,3);texture.needsUpdate=true;textures.push(texture);return texture;
  };
  const low=dataTexture(Uint8Array,3,THREE.UnsignedByteType),high=dataTexture(Uint8Array,47,THREE.UnsignedByteType);
  const bounds=dataTexture(Float32Array,101,THREE.FloatType);
  const species=new THREE.DataArrayTexture(pattern(Float32Array,width*height*(speciesRG?2:4)*layers,13),width,height,layers);
  species.format=speciesRG?THREE.RGFormat:THREE.RGBAFormat;
  species.type=THREE.FloatType;species.needsUpdate=true;textures.push(species);
  const noise=new THREE.Data3DTexture(new Uint8Array([17,33]),1,1,1);
  noise.format=THREE.RGFormat;noise.needsUpdate=true;textures.push(noise);
  const sharedObject={marker:'shared wrapper',nested:[1,2,3]};
  const planet={weatherHours,cloudSpinBase:.41,weatherField:{windRadiansPerHour:.073},volCloudMat:{
    defines:{PRODUCTION_CLOUD_MEDIUM:Number(production),CLOUD_FAR_VIEW:0,CLOUD_FAR_CACHE:0,CONTRACT_EXTRA_DEFINE:7},uniforms:{
      uWeatherMap:{value:low},uWeatherMapHi:{value:high},uSpeciesMap:{value:species},uBandBounds:{value:bounds},
      uNoise3:{value:noise},uSpeciesParameters:{value:bounds},uBandCandidates:{value:species},
      uSpeciesPartition:{value:production?1:0},uLocalBands:{value:production?1:0},
      uCameraLocal:{value:new THREE.Vector3(3,-2,7)},uCustomObject:{value:sharedObject},
      uSpin:{value:new THREE.Matrix3().set(1,2,3,4,5,6,7,8,9)},uSpeciesMask:{value:mask},
      uCloudAdvectionPhase:{value:-999},uColumnSize:{value:new THREE.Vector2(3,5)},
      uColumnSamples:{value:-777},uFootprintSamples:{value:-888}}}};
  if(frameMode!=='none') {
    const frame={hours:frameHours,low:pattern(Float32Array,low.image.data.length,203),
      high:pattern(Float32Array,high.image.data.length,407),bands:pattern(Float32Array,species.image.data.length,809),
      bounds:pattern(Float32Array,bounds.image.data.length,1201)};
    if(frameMode==='partial'){delete frame.high;delete frame.bounds;}
    planet.weatherStream={frames:new Map([[frameHours,frame]]),generations:new WeakMap(),generation:0,
      revisionAt:PlanetWeatherStream.prototype.revisionAt,disposed:false};
  }
  return {planet,textures};
}

function constructorContract(map,planet,options,label) {
  const hours=options.hours??planet.weatherHours,width=options.width??1024;
  const source=planet.volCloudMat,u=map.material.uniforms,frame=planet.weatherStream?.frames.get(hours);
  assert.equal(map.planet,planet,`${label}: planet identity`);
  assert.equal(map.programOwner,options.programOwner??null,`${label}: program lease identity`);
  assert.equal(map.quad.material,map.material,`${label}: quad material owner`);
  assert.equal(map.target.texture,map.target.textures[0],`${label}: first target attachment alias`);
  assert.notEqual(map.material.defines,source.defines,`${label}: independent defines dictionary`);
  assert.notEqual(u,source.uniforms,`${label}: independent uniform dictionary`);
  assert.deepEqual(Object.keys(u).sort(),Object.keys(source.uniforms).sort(),`${label}: default uniform keys`);
  for(const key of Object.keys(source.uniforms)) {
    if(replacedKeys.has(key))assert.notEqual(u[key],source.uniforms[key],`${label}: fresh ${key} wrapper`);
    else assert.equal(u[key],source.uniforms[key],`${label}: shallow shared ${key} wrapper`);
  }
  assert.deepEqual(Array.from(u.uSpin.value.elements),new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4()
    .makeRotationY(-(planet.cloudSpinBase+hours*planet.weatherField.windRadiansPerHour))).elements,`${label}: spin`);
  assert.equal(u.uCloudAdvectionPhase.value,hours*planet.weatherField.windRadiansPerHour,`${label}: absolute advection`);
  assert.equal(u.uSpeciesMask.value,source.uniforms.uSpeciesMask.value,`${label}: species mask`);
  assert.deepEqual(u.uColumnSize.value.toArray(),[width,width/2],`${label}: column dimensions`);
  assert.equal(u.uColumnSamples.value,options.samples??128,`${label}: height samples`);
  assert.equal(u.uFootprintSamples.value,options.footprintSamples??64,`${label}: footprint samples`);
  assert.equal(map.generation,hours,`${label}: generation hours`);
  assert.equal(map.snapshots.length,4,`${label}: exactly four snapshots`);
  for(let index=0;index<snapshotKeys.length;index++) {
    const key=snapshotKeys[index],texture=u[key].value,original=source.uniforms[key].value;
    const field={uWeatherMap:'low',uWeatherMapHi:'high',uSpeciesMap:'bands',uBandBounds:'bounds'}[key];
    const bytes=frame?.[field]??original.image.data;
    let expected=bytes.slice();
    if(frame&&(key==='uWeatherMap'||key==='uWeatherMapHi')) {
      expected=new Float32Array(bytes.length);
      for(let row=0;row<original.image.height;row++)expected.set(bytes.subarray(row*original.image.width*4,(row+1)*original.image.width*4),
        (original.image.height-1-row)*original.image.width*4);
    }
    assert.equal(map.snapshots[index],texture,`${label}: snapshot order/alias ${key}`);
    assert.notEqual(texture,original,`${label}: immutable texture ${key}`);
    assert.notEqual(texture.image.data,bytes,`${label}: immutable bytes ${key}`);
    assert.notEqual(texture.image.data.buffer,bytes.buffer,`${label}: independent buffer ${key}`);
    assert.equal(texture.type,frame?THREE.FloatType:original.type,`${label}: source/forecast type ${key}`);
    assert.equal(texture.version,1,`${label}: snapshot upload version ${key}`);
    assert.equal(texture.source.version,1,`${label}: snapshot source upload version ${key}`);
    assert.deepEqual(nativeBytes(texture.image.data),nativeBytes(expected),`${label}: exact snapshot bytes/row orientation ${key}`);
  }
  if(planet.weatherStream) {
    assert.equal(map.weatherSources.stream,planet.weatherStream,`${label}: stream identity`);
    assert.equal(map.weatherSources.frames[0].hours,hours,`${label}: selected frame hours`);
  } else assert.equal(map.weatherSources,null,`${label}: published source has no stream`);
}

const cases=[
  {name:'default-1024-published',input:{},options:{}},
  {name:'small-explicit-zero',input:{mask:5,production:false},options:{width:8,samples:17,footprintSamples:3,hours:0}},
  {name:'small-forecast',input:{frameMode:'complete',frameHours:4.5},options:{width:16,hours:4.5}},
  {name:'formal-forecast-default-hours',input:{frameMode:'complete',frameHours:.03125,weatherHours:.03125},options:{},lease:true},
  {name:'stream-missing-requested-hour',input:{frameMode:'complete',frameHours:4.5},options:{width:4,hours:-1.125}},
  {name:'partial-frame-source-fallback',input:{frameMode:'partial',frameHours:4.5},options:{width:8,hours:4.5}},
  // RG float array storage is legal Three/WebGL2 input. Only compare the
  // frozen constructor's format-copy behavior; no physical medium is drawn.
  {name:'small-rg-array-format',input:{speciesRG:true},options:{width:8,hours:2.75}},
];
export function verifyColumnShaderContract() {
  const fixtureBytes=readFileSync(new URL('./fixtures/cloud-column-work-original.json',import.meta.url));
  const fixture=JSON.parse(fixtureBytes.toString('utf8'));
  assert.equal(fixture.revision,'fa9ce1c');
  assert.equal(fixture.path,'src/cloud/cloud-column-map.js');
  assert.equal(fixture.sha256,'38b5eafb41c3cd859a955c956e86e87389690e72d49701a45cd684242ecb7ef6');
  assert.equal(sha256(fixture.source),fixture.sha256,'Frozen class source changed');
  assert.equal(Buffer.byteLength(fixture.source),fixture.bytes,'Frozen class byte count changed');
  const imports=fixture.source.match(/^import [^\n]*;\r?$/gm);
  assert.equal(imports?.length,6,'Review dependency injection if the frozen imports change');
  const executable=fixture.source.replace(/^import [^\n]*;\r?\n/gm,'').replace('export class CloudColumnMap','class CloudColumnMap');
  assert.doesNotMatch(executable,/^\s*(?:import|export)\b/m);
  const OriginalCloudColumnMap=vm.runInNewContext(`${executable}\nCloudColumnMap;`,{
    THREE,FullScreenQuad:OwnedScreenTriangle,productionCloudGLSL,productionColumnCondensateGLSL,
    weatherAtlasGLSL,captureWeatherSources,performance,
  },{timeout:1000,filename:'frozen-fa9ce1c-cloud-column-map.js'});
  let negativeControls=0,defaultShaders;
  for(const test of cases) {
    const {planet,textures}=makePlanet(test.input),oldOptions={...test.options},newOptions={...test.options};
    if(test.lease){oldOptions.programOwner={};newOptions.programOwner={};}
    const source=planet.volCloudMat,beforeSource=materialSummary(source);
    const sourceUniforms=source.uniforms,sourceDefines=source.defines;
    const beforeInputs=textures.map(texture=>fieldSummary(texture.image.data));
    let oldMap,newMap;
    try {
      oldMap=new OriginalCloudColumnMap(planet,oldOptions);newMap=new CloudColumnMap(planet,newOptions);
      assert.equal(planet.volCloudMat,source,`${test.name}: source material identity`);
      assert.equal(source.uniforms,sourceUniforms,`${test.name}: source uniform dictionary identity`);
      assert.equal(source.defines,sourceDefines,`${test.name}: source defines dictionary identity`);
      assert.deepEqual(materialSummary(source),beforeSource,`${test.name}: constructors must not mutate shared source`);
      constructorContract(oldMap,planet,oldOptions,`${test.name} frozen`);
      constructorContract(newMap,planet,newOptions,`${test.name} current`);
      compare(oldMap,newMap,test.name);
      if(test.name==='default-1024-published')defaultShaders={vertexSha256:sha256(newMap.material.vertexShader),
        fragmentSha256:sha256(newMap.material.fragmentShader),vertexBytes:Buffer.byteLength(newMap.material.vertexShader),
        fragmentBytes:Buffer.byteLength(newMap.material.fragmentShader)};
      if(test.name==='small-forecast') {
        const fragment=newMap.material.fragmentShader;
        newMap.material.fragmentShader+='\n// deliberate native-contract failure';
        assert.throws(()=>compare(oldMap,newMap,'wrong shader control'),/shader text differs/);negativeControls++;
        newMap.material.fragmentShader=fragment;
        const bytes=new Uint8Array(newMap.snapshots[0].image.data.buffer),saved=bytes[0];
        bytes[0]^=1;
        assert.throws(()=>compare(oldMap,newMap,'wrong snapshot control'));negativeControls++;
        bytes[0]=saved;
        compare(oldMap,newMap,`${test.name} controls restored`);
      }
    } finally {
      oldMap?.dispose();newMap?.dispose();
      oldOptions.programOwner?.columns?.dispose();newOptions.programOwner?.columns?.dispose();
      assert.deepEqual(textures.map(texture=>fieldSummary(texture.image.data)),beforeInputs,`${test.name}: source bytes survive disposal`);
      assert.deepEqual(materialSummary(source),beforeSource,`${test.name}: source values/versions survive disposal`);
      assert.ok(Object.keys(planet.volCloudMat.uniforms).length>0,`${test.name}: source uniform dictionary survives disposal`);
      for(const texture of textures)texture.dispose();
    }
  }
  assert.equal(negativeControls,2);
  return {fixture:{path:'tools/fixtures/cloud-column-work-original.json',revision:fixture.revision,
    sourceSha256:fixture.sha256,sourceBytes:fixture.bytes,rawSha256:sha256(fixtureBytes)},
    helperRawSha256:sha256(readFileSync(new URL('./columnshadercontracttest.js',import.meta.url))),
    defaultShaders,cases:cases.length,rejectingControls:negativeControls};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const result=verifyColumnShaderContract();
  console.log(`PASS ${result.cases} executed frozen/current default column constructors: exact shaders, defines, uniforms/aliases, `
    +`snapshot bytes/upload versions and dual-MRT formats; ${result.rejectingControls} rejecting controls; no GPU.`);
}
