// GPU_DISJOINT_EXT is consumed by a read. All runtime timer owners share its
// generation so one observer cannot hide invalid measurements from another.
const states=new WeakMap();

export function currentGpuDisjointEpoch(gl) {
  return states.get(gl)||0;
}

export function readGpuDisjointEpoch(gl,ext) {
  let epoch=currentGpuDisjointEpoch(gl);
  if(ext&&!gl.isContextLost()&&gl.getParameter(ext.GPU_DISJOINT_EXT)) {
    epoch++;states.set(gl,epoch);
  }
  return epoch;
}
