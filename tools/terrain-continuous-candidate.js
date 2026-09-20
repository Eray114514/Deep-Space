// Diagnostic-only generated unroll of the proven 14-point support stencil.
// This module is served to the browser attribution tool; runtime never imports it.
const gradients = new Float32Array([1,1,0,-1,1,0,1,-1,0,-1,-1,0,1,0,1,-1,0,1,1,0,-1,-1,0,-1,0,1,1,0,-1,1,0,1,-1,0,-1,-1]);
const offsets = [[-1,0,0],[0,-1,0],[0,0,-1],[0,0,0],[0,0,1],[0,1,0],[0,1,1],
  [1,0,0],[1,0,1],[1,1,0],[1,1,1],[1,1,2],[1,2,1],[2,1,1]];
let source = `return function continuousTerrainNoise(x,y,z) {
  const s=(x+y+z)/3, i=Math.floor(x+s),j=Math.floor(y+s),k=Math.floor(z+s);
  const t=(i+j+k)/6, x0=x-i+t,y0=y-j+t,z0=z-k+t;
  const perm=this.perm,mod=this.permMod12;
  let sum=0,dx,dy,dz,a,g;
`;
for (const [i,j,k] of offsets) {
  const t=(i+j+k)/6;
  source += `dx=x0-(${i-t});dy=y0-(${j-t});dz=z0-(${k-t});
  a=.6-dx*dx-dy*dy-dz*dz;
  if(a>0){g=mod[((i+(${i}))&255)+perm[((j+(${j}))&255)+perm[(k+(${k}))&255]]]*3;
    a*=a;sum+=a*a*(GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz);}
`;
}
source += 'return 32*sum;}';
export const continuousTerrainNoise = new Function('GRAD', source)(gradients);
export const continuousTerrainNoiseSource = source;
