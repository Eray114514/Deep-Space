// Read-only draw-bound inspection. Diagnostic use only: synchronous GL reads
// perturb scheduling and must never be enabled in runtime/performance probes.
export function inspectCloudDraw(gl) {
  const program=gl.getParameter(gl.CURRENT_PROGRAM),attributes=[];
  const hash=bytes=>{let value=2166136261;for(const byte of bytes)value=Math.imul(value^byte,16777619);return (value>>>0).toString(16);};
  const buffers=new Map(),saved=gl.getParameter(gl.COPY_READ_BUFFER_BINDING);
  const bufferData=buffer=>{
    if(!buffer)return null;
    if(buffers.has(buffer))return buffers.get(buffer);
    gl.bindBuffer(gl.COPY_READ_BUFFER,buffer);
    const bytes=new Uint8Array(gl.getBufferParameter(gl.COPY_READ_BUFFER,gl.BUFFER_SIZE));
    gl.getBufferSubData(gl.COPY_READ_BUFFER,0,bytes);
    const result={bytes:bytes.length,hash:hash(bytes)};buffers.set(buffer,result);return result;
  };
  let index;
  try {
    for(let i=0;i<gl.getProgramParameter(program,gl.ACTIVE_ATTRIBUTES);i++) {
      const info=gl.getActiveAttrib(program,i),location=gl.getAttribLocation(program,info.name);
      attributes.push({name:info.name,location,type:info.type,size:info.size,
        enabled:gl.getVertexAttrib(location,gl.VERTEX_ATTRIB_ARRAY_ENABLED),
        components:gl.getVertexAttrib(location,gl.VERTEX_ATTRIB_ARRAY_SIZE),
        stride:gl.getVertexAttrib(location,gl.VERTEX_ATTRIB_ARRAY_STRIDE),
        scalar:gl.getVertexAttrib(location,gl.VERTEX_ATTRIB_ARRAY_TYPE),
        normalized:gl.getVertexAttrib(location,gl.VERTEX_ATTRIB_ARRAY_NORMALIZED),
        divisor:gl.getVertexAttrib(location,gl.VERTEX_ATTRIB_ARRAY_DIVISOR),
        offset:gl.getVertexAttribOffset(location,gl.VERTEX_ATTRIB_ARRAY_POINTER),
        buffer:bufferData(gl.getVertexAttrib(location,gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING))});
    }
    index=bufferData(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING));
  } finally {gl.bindBuffer(gl.COPY_READ_BUFFER,saved);}
  const parameters={};
  for(const name of ['VIEWPORT','SCISSOR_BOX','SCISSOR_TEST','DEPTH_TEST','DEPTH_WRITEMASK','DEPTH_FUNC',
    'BLEND','BLEND_EQUATION_RGB','BLEND_EQUATION_ALPHA','BLEND_SRC_RGB','BLEND_DST_RGB',
    'BLEND_SRC_ALPHA','BLEND_DST_ALPHA','BLEND_COLOR','COLOR_WRITEMASK','CULL_FACE','CULL_FACE_MODE',
    'FRONT_FACE','DITHER','POLYGON_OFFSET_FILL','SAMPLE_ALPHA_TO_COVERAGE','SAMPLE_COVERAGE','RASTERIZER_DISCARD']) {
    const value=gl.getParameter(gl[name]);parameters[name]=ArrayBuffer.isView(value)?Array.from(value):value;
  }
  return {attributes,index,parameters};
}

export function inspectCloudTextureContents(renderer,material) {
  const gl=renderer.getContext(),savedRead=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),savedUnit=gl.getParameter(gl.ACTIVE_TEXTURE);
  const framebuffer=gl.createFramebuffer(),records={};
  const hash=(bytes,value=2166136261)=>{for(const byte of bytes)value=Math.imul(value^byte,16777619);return value>>>0;};
  try {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,framebuffer);
    const program=renderer.properties.get(material).currentProgram.program;
    for(let i=0;i<gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);i++) {
      const info=gl.getActiveUniform(program,i),texture=material.uniforms[info.name]?.value;
      if(!texture?.isTexture)continue;
      if(texture.isDepthTexture){records[info.name]={skipped:'Depth attachment cannot be read as color'};continue;}
      const image=texture.image,width=image.width,height=image.height,layers=image.depth||1;
      const handle=renderer.properties.get(texture).__webglTexture;let digest=2166136261,bytes=0;
      const layerHashes=[];
      for(let layer=0;layer<layers;layer++) {
        gl.framebufferTexture2D(gl.READ_FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,null,0);
        if(texture.isData3DTexture||texture.isDataArrayTexture)
          gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER,gl.COLOR_ATTACHMENT0,handle,0,layer);
        else gl.framebufferTexture2D(gl.READ_FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,handle,0);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        const status=gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER);
        if(status!==gl.FRAMEBUFFER_COMPLETE)throw Error('Diagnostic input framebuffer incomplete '+info.name+': '+status);
        const format=gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT),type=gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
        const components=[gl.RED,gl.RED_INTEGER].includes(format)?1:[gl.RG,gl.RG_INTEGER].includes(format)?2:4;
        const ArrayType=type===gl.FLOAT?Float32Array:type===gl.UNSIGNED_INT?Uint32Array:type===gl.INT?Int32Array:
          type===gl.UNSIGNED_SHORT||type===gl.HALF_FLOAT?Uint16Array:type===gl.SHORT?Int16Array:Uint8Array;
        const pixels=new ArrayType(width*height*components);
        gl.readPixels(0,0,width,height,format,type,pixels);
        const data=new Uint8Array(pixels.buffer);digest=hash(data,digest);bytes+=data.length;layerHashes.push(hash(data));
      }
      gl.activeTexture(gl.TEXTURE0+gl.getUniform(program,gl.getUniformLocation(program,info.name)));
      const binding=texture.isData3DTexture?gl.TEXTURE_BINDING_3D:texture.isDataArrayTexture?gl.TEXTURE_BINDING_2D_ARRAY:gl.TEXTURE_BINDING_2D;
      records[info.name]={width,height,layers,bytes,hash:digest.toString(16),layerHashes,
        boundOwnerMatches:gl.getParameter(binding)===handle,samplerBound:gl.getParameter(gl.SAMPLER_BINDING)!==null};
    }
  } finally {gl.activeTexture(savedUnit);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,savedRead);gl.deleteFramebuffer(framebuffer);}
  return records;
}

// Force actual GL calls, bypassing Three's equal-value uniform cache. The
// alternate values are immediately restored before the draw, never displayed.
export function reuploadCloudUniforms(gl) {
  const program=gl.getParameter(gl.CURRENT_PROGRAM),types=new Map([
    [gl.FLOAT,['uniform1f',1]],[gl.FLOAT_VEC2,['uniform2fv',2]],[gl.FLOAT_VEC3,['uniform3fv',3]],[gl.FLOAT_VEC4,['uniform4fv',4]],
    [gl.FLOAT_MAT2,['uniformMatrix2fv',4]],[gl.FLOAT_MAT3,['uniformMatrix3fv',9]],[gl.FLOAT_MAT4,['uniformMatrix4fv',16]],
    [gl.INT_VEC2,['uniform2iv',2]],[gl.INT_VEC3,['uniform3iv',3]],[gl.INT_VEC4,['uniform4iv',4]],
    [gl.BOOL_VEC2,['uniform2iv',2]],[gl.BOOL_VEC3,['uniform3iv',3]],[gl.BOOL_VEC4,['uniform4iv',4]],
    [gl.UNSIGNED_INT,['uniform1ui',1]]]);
  let uploads=0;
  for(let i=0;i<gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);i++) {
    const info=gl.getActiveUniform(program,i),[method,count]=types.get(info.type)||['uniform1i',1];
    for(let element=0;element<info.size;element++) {
      const name=info.size>1?info.name.replace('[0]',`[${element}]`):info.name,location=gl.getUniformLocation(program,name);
      const value=gl.getUniform(program,location),alternate=count===1?Number(value)+1:Array.from(value,(v,index)=>index?Number(v):Number(v)+1);
      for(const input of [alternate,value]) {
        if(method.startsWith('uniformMatrix'))gl[method](location,false,input);
        else gl[method](location,input);
      }
      uploads++;
    }
  }
  return uploads;
}
