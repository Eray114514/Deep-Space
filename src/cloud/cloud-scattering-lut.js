// Plane-parallel closure: anisotropic first collision, isotropic subsequent
// collisions. Solve J=J1+omega*K*J, rather than adding unbounded display gain.
// This is a stated transport approximation, not a full HG path tracer.
export const CLOUD_SCATTERING_ALBEDO=0.999;
const PI=Math.PI;
const hg=(mu,g)=>(1-g*g)/(4*PI*Math.pow(1+g*g-2*g*mu,1.5));
export const cloudPhaseCPU=mu=>.8*hg(mu,.65)+.2*hg(mu,-.25);

function quadrature(n) {
  const result=[];
  for(let i=1;i<=n;i++) {
    let z=Math.cos(PI*(i-.25)/(n+.5)),derivative;
    for(let iteration=0;iteration<12;iteration++) {
      let p=1,previous=0;
      for(let j=1;j<=n;j++) { const next=((2*j-1)*z*p-(j-1)*previous)/j;previous=p;p=next; }
      derivative=n*(z*p-previous)/(z*z-1);
      const next=z-p/derivative;if(Math.abs(next-z)<1e-14){z=next;break;}z=next;
    }
    result.push({mu:(z+1)/2,weight:1/((1-z*z)*derivative*derivative)});
  }
  return result.sort((a,b)=>a.mu-b.mu);
}

// Cell-mean radiance and exact homogeneous-cell outgoing radiance. Both are
// needed: using the outgoing value as J invents energy in optically thick cells.
function sweep(source,delta,mu,reverse,mean,weight) {
  let incoming=0;
  for(let k=0;k<delta.length;k++) {
    const i=reverse?delta.length-1-k:k;
    const optical=delta[i]/mu,transmission=Math.exp(-optical);
    const average=optical<1e-5?1-optical*.5+optical*optical/6:(1-transmission)/optical;
    if(mean) mean[i]+=weight*(incoming*average+source[i]*(1-average));
    incoming=incoming*transmission+source[i]*(1-transmission);
  }
  return incoming;
}
function factor(matrix,n) {
  const a=Float64Array.from(matrix),pivots=new Int32Array(n);
  for(let k=0;k<n;k++) {
    let pivot=k;for(let i=k+1;i<n;i++)if(Math.abs(a[i*n+k])>Math.abs(a[pivot*n+k]))pivot=i;
    pivots[k]=pivot;
    if(pivot!==k)for(let j=0;j<n;j++){const t=a[k*n+j];a[k*n+j]=a[pivot*n+j];a[pivot*n+j]=t;}
    for(let i=k+1;i<n;i++) {
      a[i*n+k]/=a[k*n+k];const f=a[i*n+k];
      for(let j=k+1;j<n;j++)a[i*n+j]-=f*a[k*n+j];
    }
  }
  return {a,pivots};
}
function solve(lu,rhs) {
  const n=rhs.length,x=Float64Array.from(rhs),{a,pivots}=lu;
  for(let k=0;k<n;k++){const p=pivots[k],t=x[k];x[k]=x[p];x[p]=t;for(let i=k+1;i<n;i++)x[i]-=a[i*n+k]*x[k];}
  for(let k=n-1;k>=0;k--){for(let j=k+1;j<n;j++)x[k]-=a[k*n+j]*x[j];x[k]/=a[k*n+k];}
  return x;
}

export function cloudSlabSolver(tau,{depthCells=64,angleCells=12,albedo=CLOUD_SCATTERING_ALBEDO}={}) {
  const n=depthCells,angles=quadrature(angleCells),boundaries=Float64Array.from({length:n+1},
    (_,i)=>tau*(.5-.5*Math.cos(PI*i/n)));
  const delta=Float64Array.from({length:n},(_,i)=>boundaries[i+1]-boundaries[i]);
  const kernel=new Float64Array(n*n),unit=new Float64Array(n);
  for(let j=0;j<n;j++) {
    unit.fill(0);unit[j]=1;const mean=new Float64Array(n);
    for(const {mu,weight} of angles) {
      sweep(unit,delta,mu,false,mean,weight*.5);sweep(unit,delta,mu,true,mean,weight*.5);
    }
    for(let i=0;i<n;i++)kernel[i*n+j]=(i===j?1:0)-albedo*mean[i];
  }
  const lu=factor(kernel,n);
  return function sunlight(sunMu) {
    const muSun=Math.max(.01,sunMu),first=new Float64Array(n),phase=[],source=new Float64Array(n);
    let norm=0;
    for(const direction of [-1,1])for(const a of angles) {
      let p=0;const mu=direction*a.mu;
      for(let az=0;az<48;az++) p+=cloudPhaseCPU(mu*muSun+
        Math.sqrt((1-mu*mu)*(1-muSun*muSun))*Math.cos((az+.5)*2*PI/48))/48;
      phase.push({mu:a.mu,weight:a.weight,reverse:direction<0,p});norm+=p*a.weight*2*PI;
    }
    for(const a of phase) {
      for(let i=0;i<n;i++)source[i]=albedo*a.p/norm*muSun/delta[i]
        *(Math.exp(-boundaries[i]/muSun)-Math.exp(-boundaries[i+1]/muSun));
      sweep(source,delta,a.mu,a.reverse,first,a.weight*.5);
    }
    const mean=solve(lu,first),multiple=Float64Array.from(mean,j=>albedo*j);
    let reflected=0,transmitted=muSun*Math.exp(-tau/muSun),absorbed=0;
    for(const a of phase) {
      for(let i=0;i<n;i++)source[i]=multiple[i]+albedo*a.p/norm*muSun/delta[i]
        *(Math.exp(-boundaries[i]/muSun)-Math.exp(-boundaries[i+1]/muSun));
      const flux=2*PI*a.weight*a.mu*sweep(source,delta,a.mu,a.reverse,null,0);
      if(a.reverse)reflected+=flux;else transmitted+=flux;
    }
    for(let i=0;i<n;i++)absorbed+=(1-albedo)*(4*PI*mean[i]*delta[i]
      +muSun*(Math.exp(-boundaries[i]/muSun)-Math.exp(-boundaries[i+1]/muSun)));
    return {multiple,boundaries,tau,sunMu:muSun,reflected:reflected/muSun,
      transmitted:transmitted/muSun,absorbed:absorbed/muSun,
      energyError:Math.abs((reflected+transmitted+absorbed)/muSun-1)};
  };
}

export function buildCloudScatteringTable({depthCells=64,sunCells=16,tauCells=32,angleCells=12}={}) {
  const data=new Float32Array(depthCells*sunCells*tauCells*4),records=[];
  for(let t=0;t<tauCells;t++) {
    const tau=Math.expm1(t/(tauCells-1)*Math.log(129))+.0001;
    const solver=cloudSlabSolver(tau,{depthCells,angleCells});
    for(let s=0;s<sunCells;s++) {
      const solution=solver(.01+.99*s/(sunCells-1));
      const delta=Float64Array.from({length:depthCells},(_,i)=>solution.boundaries[i+1]-solution.boundaries[i]);
      for(let d=0;d<depthCells;d++) {
        const muView=.01+.99*d/(depthCells-1),i=((t*sunCells+s)*depthCells+d)*4;
        data[i]=solution.multiple[d];
        data[i+1]=sweep(solution.multiple,delta,muView,true,null,0);
        data[i+2]=sweep(solution.multiple,delta,muView,false,null,0);
        data[i+3]=solution.reflected;
      }
      records.push({tau:solution.tau,sunMu:solution.sunMu,reflected:solution.reflected,
        transmitted:solution.transmitted,absorbed:solution.absorbed,energyError:solution.energyError});
    }
  }
  return {data,depthCells,sunCells,tauCells,records};
}
