// Complete support for the terrain's .6-radius simplex kernel. Four-corner
// selection loses active contributions across tetrahedron ordering planes.
// This fixed 14-site stencil equals a full neighbouring-lattice sum; it keeps
// the original permutation, gradients, scale and RNG draws. Unrolled offline
// for the height sampler's hot path: no eval, allocations or runtime codegen.
import { Simplex } from './noise.js';

const GRAD = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

export class TerrainSimplex extends Simplex {
  noise(x,y,z) {
    const s=(x+y+z)/3, i=Math.floor(x+s),j=Math.floor(y+s),k=Math.floor(z+s);
    const t=(i+j+k)/6, x0=x-i+t,y0=y-j+t,z0=z-k+t;
    const perm=this.perm,mod=this.permMod12;
    let sum=0,dx,dy,dz,a,g;
  dx=x0-(-0.8333333333333334);dy=y0-(0.16666666666666666);dz=z0-(0.16666666666666666);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(-1))&255)+perm[((j+(0))&255)+perm[(k+(0))&255]]]*3;
      a*=a;sum+=a*a*(GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz);}
  dx=x0-(0.16666666666666666);dy=y0-(-0.8333333333333334);dz=z0-(0.16666666666666666);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(0))&255)+perm[((j+(-1))&255)+perm[(k+(0))&255]]]*3;
      a*=a;sum+=a*a*(GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz);}
  dx=x0-(0.16666666666666666);dy=y0-(0.16666666666666666);dz=z0-(-0.8333333333333334);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(0))&255)+perm[((j+(0))&255)+perm[(k+(-1))&255]]]*3;
      a*=a;sum+=a*a*(GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz);}
  dx=x0-(0);dy=y0-(0);dz=z0-(0);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(0))&255)+perm[((j+(0))&255)+perm[(k+(0))&255]]]*3;
      a*=a;sum+=a*a*(GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz);}
  dx=x0-(-0.16666666666666666);dy=y0-(-0.16666666666666666);dz=z0-(0.8333333333333334);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(0))&255)+perm[((j+(0))&255)+perm[(k+(1))&255]]]*3;
      a*=a;sum+=a*a*(GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz);}
  dx=x0-(-0.16666666666666666);dy=y0-(0.8333333333333334);dz=z0-(-0.16666666666666666);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(0))&255)+perm[((j+(1))&255)+perm[(k+(0))&255]]]*3;
      a*=a;sum+=a*a*(GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz);}
  dx=x0-(-0.3333333333333333);dy=y0-(0.6666666666666667);dz=z0-(0.6666666666666667);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(0))&255)+perm[((j+(1))&255)+perm[(k+(1))&255]]]*3;
      a*=a;sum+=a*a*(GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz);}
  dx=x0-(0.8333333333333334);dy=y0-(-0.16666666666666666);dz=z0-(-0.16666666666666666);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(1))&255)+perm[((j+(0))&255)+perm[(k+(0))&255]]]*3;
      a*=a;sum+=a*a*(GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz);}
  dx=x0-(0.6666666666666667);dy=y0-(-0.3333333333333333);dz=z0-(0.6666666666666667);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(1))&255)+perm[((j+(0))&255)+perm[(k+(1))&255]]]*3;
      a*=a;sum+=a*a*(GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz);}
  dx=x0-(0.6666666666666667);dy=y0-(0.6666666666666667);dz=z0-(-0.3333333333333333);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(1))&255)+perm[((j+(1))&255)+perm[(k+(0))&255]]]*3;
      a*=a;sum+=a*a*(GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz);}
  dx=x0-(0.5);dy=y0-(0.5);dz=z0-(0.5);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(1))&255)+perm[((j+(1))&255)+perm[(k+(1))&255]]]*3;
      a*=a;sum+=a*a*(GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz);}
  dx=x0-(0.33333333333333337);dy=y0-(0.33333333333333337);dz=z0-(1.3333333333333335);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(1))&255)+perm[((j+(1))&255)+perm[(k+(2))&255]]]*3;
      a*=a;sum+=a*a*(GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz);}
  dx=x0-(0.33333333333333337);dy=y0-(1.3333333333333335);dz=z0-(0.33333333333333337);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(1))&255)+perm[((j+(2))&255)+perm[(k+(1))&255]]]*3;
      a*=a;sum+=a*a*(GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz);}
  dx=x0-(1.3333333333333335);dy=y0-(0.33333333333333337);dz=z0-(0.33333333333333337);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(2))&255)+perm[((j+(1))&255)+perm[(k+(1))&255]]]*3;
      a*=a;sum+=a*a*(GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz);}
  return 32*sum;}

  // Value plus analytic gradient of the same 14-site kernel. The gradient is
  // with respect to the (already frequency-scaled) input coordinates; erosion
  // shaping and slope-aware detail read it instead of three extra samples.
  noiseD(x,y,z,out) {
    const s=(x+y+z)/3, i=Math.floor(x+s),j=Math.floor(y+s),k=Math.floor(z+s);
    const t=(i+j+k)/6, x0=x-i+t,y0=y-j+t,z0=z-k+t;
    const perm=this.perm,mod=this.permMod12;
    let sum=0,sx=0,sy=0,sz=0,dx,dy,dz,a,g,a3,gd;
  dx=x0-(-0.8333333333333334);dy=y0-(0.16666666666666666);dz=z0-(0.16666666666666666);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(-1))&255)+perm[((j+(0))&255)+perm[(k+(0))&255]]]*3;
      gd=GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz;a3=a*a*a;sum+=a3*a*gd;gd*=8*a3;a3*=a;
      sx+=a3*GRAD[g]-gd*dx;sy+=a3*GRAD[g+1]-gd*dy;sz+=a3*GRAD[g+2]-gd*dz;}
  dx=x0-(0.16666666666666666);dy=y0-(-0.8333333333333334);dz=z0-(0.16666666666666666);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(0))&255)+perm[((j+(-1))&255)+perm[(k+(0))&255]]]*3;
      gd=GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz;a3=a*a*a;sum+=a3*a*gd;gd*=8*a3;a3*=a;
      sx+=a3*GRAD[g]-gd*dx;sy+=a3*GRAD[g+1]-gd*dy;sz+=a3*GRAD[g+2]-gd*dz;}
  dx=x0-(0.16666666666666666);dy=y0-(0.16666666666666666);dz=z0-(-0.8333333333333334);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(0))&255)+perm[((j+(0))&255)+perm[(k+(-1))&255]]]*3;
      gd=GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz;a3=a*a*a;sum+=a3*a*gd;gd*=8*a3;a3*=a;
      sx+=a3*GRAD[g]-gd*dx;sy+=a3*GRAD[g+1]-gd*dy;sz+=a3*GRAD[g+2]-gd*dz;}
  dx=x0-(0);dy=y0-(0);dz=z0-(0);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(0))&255)+perm[((j+(0))&255)+perm[(k+(0))&255]]]*3;
      gd=GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz;a3=a*a*a;sum+=a3*a*gd;gd*=8*a3;a3*=a;
      sx+=a3*GRAD[g]-gd*dx;sy+=a3*GRAD[g+1]-gd*dy;sz+=a3*GRAD[g+2]-gd*dz;}
  dx=x0-(-0.16666666666666666);dy=y0-(-0.16666666666666666);dz=z0-(0.8333333333333334);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(0))&255)+perm[((j+(0))&255)+perm[(k+(1))&255]]]*3;
      gd=GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz;a3=a*a*a;sum+=a3*a*gd;gd*=8*a3;a3*=a;
      sx+=a3*GRAD[g]-gd*dx;sy+=a3*GRAD[g+1]-gd*dy;sz+=a3*GRAD[g+2]-gd*dz;}
  dx=x0-(-0.16666666666666666);dy=y0-(0.8333333333333334);dz=z0-(-0.16666666666666666);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(0))&255)+perm[((j+(1))&255)+perm[(k+(0))&255]]]*3;
      gd=GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz;a3=a*a*a;sum+=a3*a*gd;gd*=8*a3;a3*=a;
      sx+=a3*GRAD[g]-gd*dx;sy+=a3*GRAD[g+1]-gd*dy;sz+=a3*GRAD[g+2]-gd*dz;}
  dx=x0-(-0.3333333333333333);dy=y0-(0.6666666666666667);dz=z0-(0.6666666666666667);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(0))&255)+perm[((j+(1))&255)+perm[(k+(1))&255]]]*3;
      gd=GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz;a3=a*a*a;sum+=a3*a*gd;gd*=8*a3;a3*=a;
      sx+=a3*GRAD[g]-gd*dx;sy+=a3*GRAD[g+1]-gd*dy;sz+=a3*GRAD[g+2]-gd*dz;}
  dx=x0-(0.8333333333333334);dy=y0-(-0.16666666666666666);dz=z0-(-0.16666666666666666);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(1))&255)+perm[((j+(0))&255)+perm[(k+(0))&255]]]*3;
      gd=GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz;a3=a*a*a;sum+=a3*a*gd;gd*=8*a3;a3*=a;
      sx+=a3*GRAD[g]-gd*dx;sy+=a3*GRAD[g+1]-gd*dy;sz+=a3*GRAD[g+2]-gd*dz;}
  dx=x0-(0.6666666666666667);dy=y0-(-0.3333333333333333);dz=z0-(0.6666666666666667);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(1))&255)+perm[((j+(0))&255)+perm[(k+(1))&255]]]*3;
      gd=GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz;a3=a*a*a;sum+=a3*a*gd;gd*=8*a3;a3*=a;
      sx+=a3*GRAD[g]-gd*dx;sy+=a3*GRAD[g+1]-gd*dy;sz+=a3*GRAD[g+2]-gd*dz;}
  dx=x0-(0.6666666666666667);dy=y0-(0.6666666666666667);dz=z0-(-0.3333333333333333);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(1))&255)+perm[((j+(1))&255)+perm[(k+(0))&255]]]*3;
      gd=GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz;a3=a*a*a;sum+=a3*a*gd;gd*=8*a3;a3*=a;
      sx+=a3*GRAD[g]-gd*dx;sy+=a3*GRAD[g+1]-gd*dy;sz+=a3*GRAD[g+2]-gd*dz;}
  dx=x0-(0.5);dy=y0-(0.5);dz=z0-(0.5);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(1))&255)+perm[((j+(1))&255)+perm[(k+(1))&255]]]*3;
      gd=GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz;a3=a*a*a;sum+=a3*a*gd;gd*=8*a3;a3*=a;
      sx+=a3*GRAD[g]-gd*dx;sy+=a3*GRAD[g+1]-gd*dy;sz+=a3*GRAD[g+2]-gd*dz;}
  dx=x0-(0.33333333333333337);dy=y0-(0.33333333333333337);dz=z0-(1.3333333333333335);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(1))&255)+perm[((j+(1))&255)+perm[(k+(2))&255]]]*3;
      gd=GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz;a3=a*a*a;sum+=a3*a*gd;gd*=8*a3;a3*=a;
      sx+=a3*GRAD[g]-gd*dx;sy+=a3*GRAD[g+1]-gd*dy;sz+=a3*GRAD[g+2]-gd*dz;}
  dx=x0-(0.33333333333333337);dy=y0-(1.3333333333333335);dz=z0-(0.33333333333333337);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(1))&255)+perm[((j+(2))&255)+perm[(k+(1))&255]]]*3;
      gd=GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz;a3=a*a*a;sum+=a3*a*gd;gd*=8*a3;a3*=a;
      sx+=a3*GRAD[g]-gd*dx;sy+=a3*GRAD[g+1]-gd*dy;sz+=a3*GRAD[g+2]-gd*dz;}
  dx=x0-(1.3333333333333335);dy=y0-(0.33333333333333337);dz=z0-(0.33333333333333337);
    a=.6-dx*dx-dy*dy-dz*dz;
    if(a>0){g=mod[((i+(2))&255)+perm[((j+(1))&255)+perm[(k+(1))&255]]]*3;
      gd=GRAD[g]*dx+GRAD[g+1]*dy+GRAD[g+2]*dz;a3=a*a*a;sum+=a3*a*gd;gd*=8*a3;a3*=a;
      sx+=a3*GRAD[g]-gd*dx;sy+=a3*GRAD[g+1]-gd*dy;sz+=a3*GRAD[g+2]-gd*dz;}
  out.x=32*sx;out.y=32*sy;out.z=32*sz;
    return 32*sum;}
}
