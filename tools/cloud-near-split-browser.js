import { cloudNearSplitShaders } from './cloud-near-split-shaders.js';

export async function probeCloudNearSplit(c) {
  const {T,gl,renderer,scene,camera,mesh,planet,u,radial,tangent,union,referenceFirst,targets,materials,result,
    prepare,require,clear,read,difference,image,floatRT,halfRT,width,height,referenceLimitMs}=c;
  require(gl.getParameter(gl.MAX_DRAW_BUFFERS)>=5 && gl.getParameter(gl.MAX_COLOR_ATTACHMENTS)>=5,'Five FP32 outputs required');
  result.boundary='Controlled single real body. Complete production Near kernel with actual air LUTs and controlled lighting-cache fields.';
  const referenceSource=planet.volCloudMat.fragmentShader,shaders=cloudNearSplitShaders(referenceSource);
  result.sources={reference:referenceSource,...shaders};
  const scratch=new T.WebGLRenderTarget(width,height,{type:T.FloatType,count:5,depthBuffer:false,
    minFilter:T.NearestFilter,magFilter:T.NearestFilter});targets.push(scratch);
  scratch.textures[4].format=T.RedFormat;
  const make=(fragmentShader,extra={})=>{
    const material=new T.ShaderMaterial().copy(Object.assign(Object.create(planet.volCloudMat),{uniforms:{}}));
    material.fragmentShader=fragmentShader;material.defines={...material.defines,CLOUD_FAR_VIEW:0,STELLAR_UNION_OCCLUSION:union};
    Object.assign(material.uniforms,u,extra);materials.push(material);return material;
  };
  const original=make(referenceSource),density=make(shaders.density),light=make(shaders.light,
    Object.fromEntries(shaders.names.map((name,i)=>[name,{value:scratch.textures[i]}])));
  density.glslVersion=T.GLSL3;density.blending=T.NoBlending;
  if(referenceFirst)await prepare('reference',original,referenceLimitMs,floatRT);
  await prepare('near-density',density,120000,scratch);await prepare('near-light',light,120000,floatRT);
  if(!referenceFirst)await prepare('reference',original,referenceLimitMs,floatRT);
  function draw(material,target) {
    mesh.material=material;renderer.setRenderTarget(target);material.uniformsNeedUpdate=true;renderer.render(scene,camera);
  }
  function render(target,split,blend) {
    original.blending=light.blending=blend?T.NormalBlending:T.NoBlending;
    if(split){clear(scratch);draw(density,scratch);}
    clear(target,blend?[.08,.13,.21]:[0,0,0],blend?.25:0);
    draw(split?light:original,target);return read(target);
  }
  const cases=[{name:'below-clouds',height:1200,slant:true},{name:'above-clouds',height:90000},
    {name:'in-clouds',height:6500,slant:true},{name:'physical-beams',height:90000,physical:true},
    {name:'temporal-jitter-and-fade',height:90000,frame:7,engage:.37}];
  for(const config of cases){
    window.__cloudFarSplit.status=config.name;
    camera.position.copy(radial).multiplyScalar(planet.R+config.height);
    const aim=radial.clone().multiplyScalar(planet.R+(config.slant?8500:0));
    if(config.slant)aim.addScaledVector(tangent,17000);
    camera.lookAt(aim);camera.updateMatrixWorld(true);u.uCameraLocal.value.copy(camera.position);
    u.uDepthViewToLocal.value.setFromMatrix4(camera.matrixWorld);u.uDepthReady.value=0;
    u.uFrame.value=config.frame??0;u.uEngage.value=config.engage??1;u.uSunCacheReady.value=config.physical?0:1;
    const row={name:config.name,formats:[]};result.records.push(row);
    for(const [format,rt,blend]of [['float32',floatRT,false],['half-over',halfRT,true]]){
      const a=render(rt,false,blend),b=render(rt,true,blend),repeat=render(rt,true,blend);
      const comparison=difference(a.values,b.values),alpha=difference(a.values.filter((_,i)=>i%4===3),b.values.filter((_,i)=>i%4===3));
      const nonzero=a.values.filter((v,i)=>i%4===3&&v>(blend?.254:.004)).length;
      row.formats.push({format,comparison,alpha,nonzero,repeatChanged:difference(b.raw,repeat.raw).changed,
        nativeChanged:difference(a.raw,b.raw).changed,reference:a.raw,candidate:b.raw});
      require(comparison.maximumError<=.002&&alpha.changed===0&&row.formats.at(-1).repeatChanged===0,'Near HDR parity '+config.name+' '+format);
      if(format==='float32'&&config.name==='above-clouds'){image('Near original',a.values);image('Near split',b.values);}
    }
    require(gl.getError()===0,'Near GL health '+config.name);
  }
  require(result.records.every(row=>row.formats.some(f=>f.nonzero>0)),'Nonempty near fixture cases');
  result.scratchBytes=width*height*68;
}
