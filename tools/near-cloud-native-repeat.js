// Native snapshots are confined to the diagnostic draw boundary. Three's
// texture-unit cache remains valid because the actual active unit is restored.
function drawSnapshot(gl,ids) {
  const id=value=>{
    if(value===null)return null;
    if(!ids.has(value))ids.set(value,ids.size+1);
    return ids.get(value);
  };
  const program=gl.getParameter(gl.CURRENT_PROGRAM),uniforms={},textures={};
  const targets=new Map([[gl.SAMPLER_2D,gl.TEXTURE_BINDING_2D],[gl.SAMPLER_3D,gl.TEXTURE_BINDING_3D],
    [gl.SAMPLER_2D_ARRAY,gl.TEXTURE_BINDING_2D_ARRAY],[gl.UNSIGNED_INT_SAMPLER_2D_ARRAY,gl.TEXTURE_BINDING_2D_ARRAY]]);
  const unit=gl.getParameter(gl.ACTIVE_TEXTURE);
  try {
    for(let i=0;i<gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);i++) {
      const {name,size,type}=gl.getActiveUniform(program,i),target=targets.get(type);
      for(let index=0;index<size;index++) {
        const key=size===1?name:name.replace('[0]',`[${index}]`);
        const location=gl.getUniformLocation(program,key);
        if(location===null)continue;
        const value=gl.getUniform(program,location);
        uniforms[key]=ArrayBuffer.isView(value)?Array.from(value):value;
        if(target) {
          gl.activeTexture(gl.TEXTURE0+value);
          textures[key]=id(gl.getParameter(target));
        }
      }
    }
  } finally {gl.activeTexture(unit);}
  return {program:id(program),vao:id(gl.getParameter(gl.VERTEX_ARRAY_BINDING)),
    framebuffer:id(gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)),viewport:Array.from(gl.getParameter(gl.VIEWPORT)),
    scissor:gl.isEnabled(gl.SCISSOR_TEST),blend:gl.isEnabled(gl.BLEND),depth:gl.isEnabled(gl.DEPTH_TEST),
    mask:gl.getParameter(gl.COLOR_WRITEMASK),uniforms,textures};
}

function changedFields(a,b) {
  return Object.fromEntries(Object.keys({...a,...b}).filter(key=>JSON.stringify(a[key])!==JSON.stringify(b[key]))
    .map(key=>[key,[a[key],b[key]]]));
}

function snapshotDelta(a,b) {
  const {uniforms:au,textures:at,...as}=a,{uniforms:bu,textures:bt,...bs}=b;
  return {state:changedFields(as,bs),uniforms:changedFields(au,bu),textures:changedFields(at,bt)};
}

export function timeNearIndexedDraw(renderer,target,time,render) {
  const gl=renderer.getContext(),draw=gl.drawElements;
  const framebuffer=renderer.properties.get(target).__webglFramebuffer;
  let query,draws=0;
  gl.drawElements=function(...args) {
    if(gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)!==framebuffer)return draw.apply(this,args);
    draws++;
    query=time(()=>draw.apply(this,args));
  };
  try {render();}
  finally {gl.drawElements=draw;}
  if(draws!==1||!query)throw Error('Near timing needs one indexed draw in the production framebuffer');
  return query;
}

export function compareNearNativeDraw({renderer,current,backup,blit,read,compare,render,time,cacheOrder}) {
  const gl=renderer.getContext(),draw=gl.drawElements,ids=new Map();
  const framebuffer=renderer.properties.get(current).__webglFramebuffer;
  let published,initial,nativeDelta,nativeState,rebuilt,drawCount=0,rebuiltCount=0;
  const cacheSamples=[];
  function insideTarget() {return gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)===framebuffer;}
  gl.drawElements=function(...args) {
    if(!insideTarget())return draw.apply(this,args);
    drawCount++;
    initial=drawSnapshot(gl,ids);
    draw.apply(this,args);
    published=read(current);
    blit(current,backup);
    if(compare(published,read(backup)).changed)throw Error('Near native repeat could not save its published target');
    try {
      renderer.clear(true,false,false);
      nativeState=drawSnapshot(gl,ids);
      draw.apply(this,args);
      nativeDelta=compare(published,read(current));
      if(cacheOrder) {
        const program=gl.getParameter(gl.CURRENT_PROGRAM);
        const ready=gl.getUniformLocation(program,'uSunCacheReady');
        if(!ready||gl.getUniform(program,ready)!==1)throw Error('Near native cache toggle needs the bound cache uniform');
        try {
          for(const value of cacheOrder) {
            gl.uniform1f(ready,value);
            renderer.clear(true,false,false);
            const query=time(()=>draw.apply(this,args));
            cacheSamples.push({ready:value,query,error:compare(published,read(current))});
          }
        } finally {if(!gl.isContextLost())gl.uniform1f(ready,1);}
      }
    } finally {if(!gl.isContextLost())blit(backup,current);}
  };
  try {render();}
  finally {gl.drawElements=draw;}
  if(drawCount!==1||!nativeDelta||compare(published,read(current)).changed)
    throw Error('Near native repeat needs one indexed draw and exact restoration');
  let rebuiltDelta;
  try {
    renderer.clear(true,false,false);
    gl.drawElements=function(...args) {
      if(insideTarget()){rebuiltCount++;rebuilt=drawSnapshot(gl,ids);}
      return draw.apply(this,args);
    };
    render();
    rebuiltDelta=compare(published,read(current));
  } finally {
    gl.drawElements=draw;
    if(!gl.isContextLost())blit(backup,current);
  }
  const restored=compare(published,read(current));
  if(rebuiltCount!==1||restored.changed)throw Error('Near renderer repeat could not restore its published target');
  return {nativeDelta,rebuiltDelta,restored,nativeState:snapshotDelta(initial,nativeState),
    rebuiltState:snapshotDelta(initial,rebuilt),cacheSamples};
}
