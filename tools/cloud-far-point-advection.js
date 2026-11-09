// The per-species phase depends only on the current body's weather epoch
// and the immutable parameter table. Keep all spatial sampling on the GPU.
export function farPointAdvectionShader(source) {
  const body=`    float phase=(speciesStructureAt(species).y-1.0)*uCloudAdvectionPhase;
    float c=cos(phase),s=sin(phase);`;
  if (source.split(body).length!==2) throw Error('Expected one production species rotation');
  return 'uniform int uPointAdvectionMode;\nuniform vec2 uPointAdvectionRotation[16];\n'+source.replace(body,`    float c,s;
    if(uPointAdvectionMode==0) {
`+body.replace('float c=cos(phase),s=sin(phase);','c=cos(phase);s=sin(phase);')+`
    } else {
      vec2 rotation=uPointAdvectionRotation[species];
      c=rotation.x;s=rotation.y;
    }`);
}

export function pointAdvectionRotation(parameters, phase, output) {
  const {data,width,height}=parameters.image;
  if (width!==16 || height<3 || !(data instanceof Float32Array) || !Number.isFinite(phase))
    throw Error('Unexpected production species rotation inputs');
  const hoursPhase=Math.fround(phase);
  for (let species=0;species<width;species++) {
    const scale=data[(2*width+species)*4+1];
    const angle=Math.fround(Math.fround(scale-1)*hoursPhase);
    output[species*2]=Math.cos(angle);
    output[species*2+1]=Math.sin(angle);
  }
}
