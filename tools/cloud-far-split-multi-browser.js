import { planCloudSplitFrame } from './cloud-far-split-frame.js';

// Two independently bound cloud owners using the real production kernel. The
// second is a controlled clone, not a second curated planet or player scene.
export async function probeCloudSplitOwners(c) {
  const {T,renderer,scene,camera,mesh,planet,u,make,split,reference,point,cached,combine,pointDirect,cachedDirect,
    prepare,tracker,pointRT,cachedRT,floatRT,halfRT,depthRT,columns,heights,allocate,clear,difference,require,image}=c;
  const originalCamera=camera.position.clone(),originalAspect=camera.aspect;
  const clone=value=>value?.isTexture?value:Array.isArray(value)?value.map(clone):value?.clone?value.clone():value;
  const secondUniforms=Object.fromEntries(Object.entries(u).map(([name,binding])=>[name,{value:clone(binding.value)}]));
  secondUniforms.air_uEnabled.value=0;secondUniforms.uSunC.value.setRGB(.2,.45,1);
  const first={reference,programs:{reference,point,cached,combine,pointDirect,cachedDirect},outerRadius:planet.volCloudBand.rOut};
  const second={programs:{},outerRadius:first.outerRadius};
  for(const [name,source]of Object.entries({reference:reference.fragmentShader,point:split.point,cached:split.cached,
    combine:split.combine,pointDirect:split.pointDirect,cachedDirect:split.cachedDirect})){
    const material=make(source);material.uniforms={...material.uniforms,...secondUniforms};second.programs[name]=material;
    material.blending=['point','cached'].includes(name)?T.NoBlending:T.NormalBlending;
    await prepare('second-owner-'+name,material);
  }
  second.reference=second.programs.reference;
  for(const [name,material]of Object.entries(first.programs))material.blending=['point','cached'].includes(name)?T.NoBlending:T.NormalBlending;
  mesh.material=reference;
  const other=new T.Mesh(mesh.geometry,second.reference);other.frustumCulled=false;
  const groupA=new T.Group(),groupB=new T.Group();scene.remove(mesh);scene.add(groupA,groupB);groupA.add(mesh);groupB.add(other);
  const owners=new Map([[mesh,first],[other,second]]),prepared=new Set([...Object.values(first.programs),...Object.values(second.programs)]);
  const meshes=[mesh,other],groups=[groupA,groupB],radial=originalCamera.clone().normalize();
  const nativeOrder=[];mesh.onBeforeRender=()=>nativeOrder.push('A');other.onBeforeRender=()=>nativeOrder.push('B');
  const records=[];
  window.__cloudFarSplit.result.multiOwner={records,status:'testing'};
  const configs=[
    {name:'depth-order'},
    {name:'group-order',groupOrder:-1},
    {name:'mesh-order',renderOrder:-1},
    {name:'id-tie',tie:true},
    {name:'ready-switch',readyA:0},
    {name:'all-cached',fov:10},
    {name:'fading-depth',readyB:0,fade:true,depth:true},
    {name:'camera-motion',move:true},
    {name:'hidden-owner',hidden:true},
    {name:'layer-filter',layer:true},
    {name:'resized-volume',width:24,height:16},
  ];
  let width=32,height=24;
  const read=rt=>{const raw=rt.texture.type===T.FloatType?new Float32Array(width*height*4):new Uint16Array(width*height*4);
    renderer.readRenderTargetPixels(rt,0,0,width,height,raw);
    const values=raw instanceof Float32Array?Array.from(raw):Array.from(raw,T.DataUtils.fromHalfFloat);
    require(values.every(Number.isFinite),'Finite multi-owner pixels');return {raw:Array.from(raw),values};};
  const options=rt=>({scene,camera,owners,tracker,prepared,targets:[rt,pointRT,cachedRT,depthRT],width,height,scratchBytes:width*height*32});
  function drawStage(entry,stage,output){
    const object=entry.object,visibility=meshes.map(m=>m.visible),material=object.material;
    try {
      for(const m of meshes)m.visible=m===object;
      object.material=entry.owner.programs[stage];
      const target=stage==='point'?pointRT:stage==='cached'?cachedRT:output;
      if(stage==='point'||stage==='cached')clear(target);else renderer.setRenderTarget(target);
      renderer.render(scene,camera);
    } finally {object.material=material;meshes.forEach((m,i)=>{m.visible=visibility[i];});}
  }
  function render(mode,rt){
    const plan=mode==='split'?planCloudSplitFrame(options(rt)):null;
    clear(rt,[.08,.13,.21],.25);nativeOrder.length=0;
    const before=renderer.info.render.calls;
    if(mode==='reference')renderer.render(scene,camera);
    else if(mode==='reverse'){
      const reverse=planCloudSplitFrame(options(rt));
      try {for(const entry of [...reverse.entries].reverse())for(const stage of entry.stages)drawStage(entry,stage,rt);}finally{reverse.cancel();}
    }else plan.execute({draw:(entry,stage)=>drawStage(entry,stage,rt),publish:()=>true});
    const calls=renderer.info.render.calls-before,order=nativeOrder.slice();
    if(plan)require(calls===plan.entries.reduce((n,e)=>n+e.stages.length,0),'Actual multi-owner draw count');
    return {...read(rt),calls,order,planned:plan?.entries.map(e=>e.object===mesh?'A':'B')};
  }
  try {
    for(const config of configs){
      window.__cloudFarSplit.status='multi-owner '+config.name;
      width=config.width||32;height=config.height||24;
      for(const rt of [pointRT,cachedRT,floatRT,halfRT])rt.setSize(width,height);
      camera.aspect=width/height;camera.fov=config.fov||3;camera.position.copy(originalCamera);
      if(config.move)camera.position.x+=1500;
      camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
      mesh.position.set(0,0,0);other.position.copy(radial).multiplyScalar(config.tie?0:-35000);
      groupA.renderOrder=config.groupOrder||0;mesh.renderOrder=config.renderOrder||0;
      groupB.visible=!config.hidden;other.layers.set(config.layer?2:0);
      scene.updateMatrixWorld(true);
      for(const [i,object]of meshes.entries()){
        const uniforms=i?secondUniforms:u,ready=i?(config.readyB??1):(config.readyA??1);
        uniforms.uColumnsReady.value=ready;uniforms.uColumnsJointReady.value=1;uniforms.uColumnMix.value=.375;
        uniforms.uOpticalColumns.value=uniforms.uOpticalColumnsNext.value=ready?columns:null;
        uniforms.uColumnHeights.value=uniforms.uColumnHeightsNext.value=ready?heights:null;
        uniforms.uEngage.value=config.fade?(i?.61:.37):i?.56:.72;
        uniforms.uDepthReady.value=Number(!!config.depth);uniforms.uVolumeSize.value.set(width,height);
        const local=new T.Matrix4().copy(object.matrixWorld).invert().multiply(camera.matrixWorld);
        uniforms.uCameraLocal.value.setFromMatrixPosition(local);uniforms.uDepthViewToLocal.value.setFromMatrix4(local);
        uniforms.uDepthInvProjection.value.copy(camera.projectionMatrixInverse);
      }
      const row={name:config.name,width,height,formats:[]};
      records.push(row);
      for(const [format,rt]of [['float32',floatRT],['half-over',halfRT]]){
        const a=render('reference',rt),a2=render('reference',rt),b=render('split',rt),b2=render('split',rt);
        require(difference(a.raw,a2.raw).changed===0&&difference(b.raw,b2.raw).changed===0,'Multi-owner native repeats '+config.name);
        require(JSON.stringify(a.order)===JSON.stringify(b.planned),'Default Three order matches planned order '+config.name);
        const comparison=difference(a.values,b.values);
        row.formats.push({format,comparison,reference:a.raw,candidate:b.raw,repeatChanged:0,referenceOrder:a.order,plannedOrder:b.planned,draws:b.calls});
        require(comparison.maximumError<=.002,'Multi-owner HDR '+config.name);
        if(config.name==='depth-order'&&format==='float32'){
          const negative=render('reverse',rt);row.reverseOrder=difference(a.values,negative.values);
          require(row.reverseOrder.maximumError>.002,'Reversed owner order must fail HDR gate');
          image('Two cloud owners reference',a.values);image('Two cloud owners split',b.values);image('Reversed owner order negative',negative.values);
        }
      }
    }
    // Real draws into private staging, then cancellation: the previous output
    // remains untouched and the publish callback must not run.
    const staging=allocate();staging.setSize(width,height);
    const before=read(floatRT),plan=planCloudSplitFrame(options(staging));let published=false,submitted=0;
    clear(staging);let rejected=false;
    try {plan.execute({draw(entry,stage){drawStage(entry,stage,staging);submitted++;plan.cancel();},publish(){published=true;}});}catch{rejected=true;}
    require(rejected&&!published&&submitted===1,'Mid-draw cancellation suppresses publication');
    require(difference(before.raw,read(floatRT).raw).changed===0,'Cancelled staging preserves previous output');
    const stale=planCloudSplitFrame(options(staging));u.uDepthInvProjection.value.elements[0]+=.01;
    const callsBefore=renderer.info.render.calls;let staleRejected=false;
    try {stale.execute({draw:(entry,stage)=>drawStage(entry,stage,staging),publish(){published=true;}});}catch{staleRejected=true;}
    require(staleRejected&&!published&&renderer.info.render.calls===callsBefore,'Stale depth rejected before GPU draw');
    return {records,controls:{submitted,published,rejected,staleRejected,previousOutputChanged:0},
      boundary:'Two independently bound copies of one production Planet kernel; controlled transforms, lighting and inactive-owner air disabled. Default Three scalar transparent mesh sort only. No temporal resolve, normal player or throughput acceptance.'};
  } finally {
    scene.remove(groupA,groupB);groupA.remove(mesh);scene.add(mesh);mesh.material=reference;mesh.renderOrder=0;mesh.position.set(0,0,0);mesh.onBeforeRender=()=>{};
    camera.position.copy(originalCamera);camera.aspect=originalAspect;
  }
}
