// Lower bound for the finite pixel cone of a perspective camera. The extra
// pixel on each edge includes fragment helper invocations outside the viewport.
// Selecting an unresolved-only shader must be safe for every rendered ray.
export function minimumCloudRayCone(projection,width,height) {
  const horizontal=Math.abs(projection[0]),vertical=Math.abs(projection[5]);
  if(!(horizontal>0&&vertical>0&&width>0&&height>0))return 0;
  const cornerSquared=((1+2/width)/horizontal)**2+((1+2/height)/vertical)**2;
  return Math.min(2/(width*horizontal),2/(height*vertical))/(1+cornerSquared);
}
