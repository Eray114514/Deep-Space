import * as THREE from 'three';
import {CloudsEffect,CloudShape,CloudShapeDetail,LocalWeather,AtmosphereParameters,PrecomputedTexturesGenerator,
  AerialPerspectiveEffect,Ellipsoid,EffectComposer,RenderPass,EffectPass,ToneMappingEffect,ToneMappingMode} from './bundle.js';
const radius=6000000,renderer=new THREE.WebGLRenderer({antialias:false});
renderer.setSize(1280,720);renderer.setPixelRatio(1);renderer.toneMapping=THREE.NoToneMapping;
renderer.toneMappingExposure=10;document.body.appendChild(renderer.domElement);
const camera=new THREE.PerspectiveCamera(62,1280/720,1,1e8),scene=new THREE.Scene();
const atmosphere=new AtmosphereParameters({bottomRadius:radius,topRadius:radius+60000});
const ellipsoid=new Ellipsoid(radius,radius,radius),sunDirection=new THREE.Vector3(Math.cos(55*Math.PI/180),Math.sin(55*Math.PI/180),0);
const clouds=new CloudsEffect(camera,{resolutionScale:.5},atmosphere);
clouds.ellipsoid=ellipsoid;clouds.correctAltitude=false;clouds.sunDirection.copy(sunDirection);clouds.qualityPreset='high';
clouds.lightShafts=false;clouds.haze=false;clouds.turbulence=false;clouds.skipRendering=true;
clouds.clouds.maxRayDistance=4e7;
clouds.clouds.perspectiveStepScale=1;
// The pinned upstream camera-height scratch uses WGS84 even when the effect
// ellipsoid is replaced. Explicit spherical height is required in this probe.
const originalCopy=clouds.cloudsPass.currentMaterial.copyCameraSettings;
clouds.cloudsPass.currentMaterial.copyCameraSettings=function(camera){
  originalCopy.call(this,camera);this.uniforms.cameraHeight.value=camera.position.length()-radius;
};
clouds.localWeatherTexture=new LocalWeather();clouds.shapeTexture=new CloudShape();clouds.shapeDetailTexture=new CloudShapeDetail();
clouds.cloudLayers.set([{channel:'r',altitude:1000,height:2000,densityScale:.01,shapeAmount:1,shapeDetailAmount:1,
  shapeAlteringBias:.35,coverageFilterWidth:.6,shadow:true},{channel:'g',height:0},{channel:'b',height:0},{channel:'a',height:0}]);
clouds.coverage=.4;
clouds.localWeatherRepeat.setScalar(4);
const bytes=new Uint8Array(16*16*64);let seed=3817;
for(let i=0;i<bytes.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;bytes[i]=seed>>>24;}
const jitter=new THREE.Data3DTexture(bytes,16,16,64);jitter.format=THREE.RedFormat;jitter.needsUpdate=true;clouds.stbnTexture=jitter;
const air=new AerialPerspectiveEffect(camera,{ellipsoid,correctAltitude:false,sunDirection,sky:true,sunLight:false,skyLight:false},atmosphere);
const planet=new THREE.Mesh(new THREE.SphereGeometry(radius,128,64),new THREE.MeshBasicMaterial({color:0x18445b}));scene.add(planet);
const generator=new PrecomputedTexturesGenerator(renderer);
await generator.update(atmosphere);Object.assign(clouds,generator.textures);Object.assign(air,generator.textures);
clouds.events.addEventListener('change',()=>{air.overlay=clouds.atmosphereOverlay;air.shadow=clouds.atmosphereShadow;});
const composer=new EffectComposer(renderer,{frameBufferType:THREE.HalfFloatType,multisampling:0});
composer.addPass(new RenderPass(scene,camera));composer.addPass(new EffectPass(camera,clouds));
clouds.skipRendering=false;
composer.addPass(new EffectPass(camera,new ToneMappingEffect({mode:ToneMappingMode.AGX})));
window.reference={renderer,camera,scene,clouds,air,composer,frames:0,pose(name){
  camera.near=name==='orbit'?10000:10;camera.far=name==='orbit'?4e7:4e5;camera.updateProjectionMatrix();
  camera.up.set(0,name==='orbit'?0:1,name==='orbit'?-1:0);camera.position.set(0,radius+(name==='orbit'?radius*1.2:name==='above'?4500:500),0);
  camera.lookAt(name==='orbit'?new THREE.Vector3(0,0,0):name==='above'
    ?new THREE.Vector3(0,radius+2000,-4500):new THREE.Vector3(0,radius+1000,-5000));
  camera.updateMatrixWorld();
}};
reference.pose('below');renderer.setAnimationLoop(()=>{composer.render(0);reference.frames++;});
