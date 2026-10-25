// Register a synchronous world-build delta before any of its roots can enter a
// player view. Program readiness alone is not publication: owner, revision and
// the current presentation gate must still agree in the committing turn.
const problem=(code,message)=>Object.assign(new Error(message),{code});
const bodies=system=>[...(system.planets||[]),...(system.compactObjects||[])];
const sites=system=>(system.artificialSites||[]).map(site=>site?.group).filter(Boolean);
const groupOf=body=>body?.group||null;
const scalar=(value,type,message)=>{
  if(typeof value===type)return value;
  // A mistakenly async proof must fail synchronously as a contract error while
  // still owning the rejected promise it already started.
  if(value&&(typeof value==='object'||typeof value==='function'))Promise.resolve(value).catch(()=>{});
  throw new TypeError(message);
};
const summary=error=>{
  const type=error===null?'null':typeof error;
  if(error===null||!['object','function'].includes(type))return {type,
    value:type==='bigint'||type==='symbol'||(type==='number'&&!Number.isFinite(error))?String(error):error};
  const result={type};
  for(const key of ['name','message','code'])try {
    const descriptor=Object.getOwnPropertyDescriptor(error,key);
    if(descriptor&&typeof descriptor.value==='string')result[key]=descriptor.value;
  } catch { /* Diagnostics cannot replace the original failure. */ }
  return result;
};

export class WorldPublication {
  constructor(system,visibility,{buildFailed=false,error}={}) {
    this.system=system;this.visibility=new Map(visibility);this.state='pending';this.attempts=0;this.lastError=undefined;
    this.buildFailed=buildFailed;this.hasError=false;this.error=null;this.rollbackFailed=false;this.operation=null;
    this.initialRootCount=this.visibility.size;
    if(buildFailed)this.remember(error);
    const hidden=this.hide();
    if(hidden.failed) {
      if(!buildFailed)this.remember(hidden.error);
      this.buildFailed=true;this.rollbackFailed=true;
    }
    if(this.buildFailed)this.state='build-failed';
  }

  remember(error) {this.lastError=error;this.hasError=true;this.error=summary(error);}

  hide(roots=this.visibility.keys()) {
    let failed=false,error;
    for(const root of roots)try {root.visible=false;}
    catch(cause){if(!failed){failed=true;error=cause;}}
    return {failed,error};
  }

  release() {
    this.system=null;this.visibility.clear();this.lastError=undefined;
  }

  abandon() {
    if(this.state==='committed'||this.state==='obsolete')return false;
    this.state='obsolete';this.release();this.operation?.cancel();return true;
  }

  async publish(prepare,{isCurrent,canPublish=()=>true,getRevision}={}) {
    if(['committed','obsolete','build-failed'].includes(this.state))return false;
    if(this.operation)throw problem('publication-busy','World publication is already preparing');
    if(typeof prepare!=='function'||typeof isCurrent!=='function'||typeof canPublish!=='function'||typeof getRevision!=='function') {
      throw new TypeError('World publication requires preparation, owner, gate and revision functions');
    }
    let ownerFailed=false;
    const owner=()=>{
      try {
        return scalar(isCurrent(),'boolean','World publication owner validity must be boolean');
      } catch(error){ownerFailed=true;throw error;}
    };
    const gate=()=>{
      return scalar(canPublish(),'boolean','World publication gate must be boolean');
    };
    this.attempts++;this.state='preparing';
    let cancel;
    const cancelled=new Promise(resolve=>{cancel=()=>resolve({cancelled:true});});
    const operation={cancel};this.operation=operation;
    let committing=null;
    const live=()=>this.operation===operation&&this.state!=='obsolete';
    const cancelCommit=()=>{
      const hidden=this.hide(committing.map(([root])=>root));if(hidden.failed)throw hidden.error;return false;
    };
    try {
      if(!owner()){this.abandon();return false;}
      if(!live())return false;
      // Both handlers are installed before yielding. Abandon resolves our own
      // wait immediately; the compiler may still settle later and is consumed.
      const prepared=Promise.resolve(prepare()).then(revision=>({revision}),error=>({failed:true,error}));
      const result=await Promise.race([prepared,cancelled]);
      if(result.cancelled||!live())return false;
      if(result.failed)throw result.error;
      if(!owner()){this.abandon();return false;}
      if(!live())return false;
      scalar(result.revision,'string','World preparation must return its captured revision string');
      const allowed=gate();if(!live())return false;
      if(!allowed){this.state='pending';return false;}
      const revision=getRevision();
      if(!live())return false;
      scalar(revision,'string','World publication revision must be a string');
      if(revision!==result.revision){this.state='pending';return false;}
      if(!owner()){this.abandon();return false;}
      if(!live())return false;
      committing=[...this.visibility];
      for(const [root,visible] of committing) {
        if(!live())return cancelCommit();
        const current=owner();
        if(!live()||!current) {
          if(live())this.abandon();return cancelCommit();
        }
        root.visible=visible;
      }
      if(!live())return cancelCommit();
      const current=owner();
      if(!live()||!current) {
        if(live())this.abandon();return cancelCommit();
      }
      this.state='committed';this.hasError=false;this.error=null;this.release();return true;
    } catch(error) {
      // Abandon owns cancellation even if a still-running prepare rejects.
      if(this.state==='obsolete'&&!committing)return false;
      let rollback={failed:false};
      if(committing)rollback=this.hide(committing.map(([root])=>root));
      if(!ownerFailed&&this.state!=='obsolete')try {
        if(!owner()){this.abandon();if(!committing)return false;}
      } catch { /* Keep the original preparation/commit error. */ }
      this.remember(error);
      if(rollback.failed){this.rollbackFailed=true;this.buildFailed=true;}
      if(this.state==='obsolete')this.release();
      else this.state=rollback.failed?'build-failed':'pending';
      throw error;
    } finally {
      if(this.operation===operation)this.operation=null;
    }
  }

  snapshot() {
    return {state:this.state,attempts:this.attempts,rootCount:this.visibility.size,initialRootCount:this.initialRootCount,
      inFlight:!!this.operation,buildFailed:this.buildFailed,rollbackFailed:this.rollbackFailed,
      hasError:this.hasError,error:this.error?{...this.error}:null};
  }
}

export function captureWorldPublication(system,{build=null,body=null}={}) {
  if(!system||(typeof system!=='object'&&typeof system!=='function'))throw new TypeError('World publication requires a system');
  if(build!==null&&typeof build!=='function')throw new TypeError('World publication build must be synchronous');
  const previousBodies=new Set(bodies(system).map(groupOf).filter(Boolean));
  const previousSites=new Set(sites(system));
  const previousChildren=new Map([...previousBodies].map(root=>[root,new Set(root.children||[])]));
  let buildFailed=false,error;
  try {
    const result=build?.();
    if(result&&typeof result.then==='function') {
      Promise.resolve(result).catch(()=>{});
      throw problem('asynchronous-build','World publication cannot capture an asynchronous build');
    }
  } catch(cause){buildFailed=true;error=cause;}
  const visibility=new Map();
  const add=(root,visible,force=false)=>{
    if(root&&(!visibility.has(root)||force))visibility.set(root,visible);
  };
  for(const root of bodies(system).map(groupOf))if(root&&!previousBodies.has(root))add(root,true,true);
  for(const root of sites(system))if(!previousSites.has(root))add(root,root.visible);
  for(const [root,children] of previousChildren)for(const child of root.children||[])if(!children.has(child))add(child,child.visible);
  add(groupOf(body),true,true);
  return new WorldPublication(system,visibility,{buildFailed,error});
}
