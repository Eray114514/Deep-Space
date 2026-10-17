// Early passive context lifecycle evidence. Keep this function closure-free:
// the runner installs its serialized body with page.addInitScript().
export function installFoundationContextProbe() {
  const host=window;
  host.__foundationContextProbe?.dispose?.();
  const prototype=host.HTMLCanvasElement?.prototype;
  if(!prototype||typeof prototype.getContext!=='function')throw Error('Canvas getContext is unavailable');
  const original=prototype.getContext,descriptor=Object.getOwnPropertyDescriptor(prototype,'getContext');
  const limits={contexts:16,events:64,faults:8};
  const contexts=[],events=[],faults=[],listeners=[];
  const seen=new WeakSet(),ids=new WeakMap();
  const dropped={contexts:0,events:0,faults:0};
  let disposed=false,wrapped=false,wrapperRestored=false,lostEvents=0,restoredEvents=0;
  const fault=error=>{
    if(faults.length<limits.faults){
      let message;try {message=String(error);}catch{message='Unprintable observation error';}
      faults.push(message.slice(0,2048));
    }else dropped.faults++;
  };
  const observe=(canvas,type)=>{
    if(seen.has(canvas))return;
    seen.add(canvas);
    if(contexts.length>=limits.contexts){dropped.contexts++;return;}
    const id=canvas.id;
    const row={contextId:contexts.length+1,type,canvasId:typeof id==='string'?id.slice(0,256):'',
      acquiredAtMs:performance.now(),lostEvents:0,restoredEvents:0};
    const receive=event=>{
      if(disposed)return;
      try {
        if(event.type==='webglcontextlost'){row.lostEvents++;lostEvents++;}
        else {row.restoredEvents++;restoredEvents++;}
        if(events.length>=limits.events){dropped.events++;return;}
        const status=event.statusMessage;
        const currentId=canvas.id;
        events.push({contextId:row.contextId,type:row.type,
          canvasId:typeof currentId==='string'?currentId.slice(0,256):row.canvasId,
          event:event.type,atMs:performance.now(),timeStamp:event.timeStamp,
          statusMessage:typeof status==='string'?status.slice(0,2048):''});
      } catch(error){fault(error);}
    };
    // Register immediately after the first successful native acquisition,
    // before game initialization can attach its recovery handlers.
    canvas.addEventListener('webglcontextlost',receive);
    try {canvas.addEventListener('webglcontextrestored',receive);}
    catch(error){canvas.removeEventListener('webglcontextlost',receive);throw error;}
    contexts.push(row);ids.set(canvas,row.contextId);listeners.push({canvas,receive});
  };
  const wrapper=function(...args){
    // Preserve the exact native receiver, arguments, return value and thrown
    // exception. Observation failures must never change getContext semantics.
    const result=original.apply(this,args);
    if(!disposed&&result&&(args[0]==='webgl'||args[0]==='webgl2'||args[0]==='experimental-webgl')){
      try {observe(this,args[0]);}catch(error){fault(error);}
    }
    return result;
  };
  try {
    Object.defineProperty(prototype,'getContext',descriptor?{...descriptor,value:wrapper}
      :{configurable:true,writable:true,value:wrapper});wrapped=true;
  } catch(error){fault(error);}
  const api={
    idForCanvas(canvas){
      return canvas&&(typeof canvas==='object'||typeof canvas==='function')?ids.get(canvas)??null:null;
    },
    snapshot(){
      return {installed:wrapped,disposed,wrapperRestored,lostEvents,restoredEvents,
        contexts:contexts.map(row=>({...row})),events:events.map(row=>({...row})),
        faults:[...faults],dropped:{...dropped},limits:{...limits},
        boundary:'Passive canvas events only; no GL validity, error, reset-status or performance queries.'};
    },
    dispose(){
      if(disposed)return;
      disposed=true;
      for(const {canvas,receive} of listeners){
        for(const name of ['webglcontextlost','webglcontextrestored'])
          try {canvas.removeEventListener(name,receive);}catch(error){fault(error);}
      }
      // Retain only bounded primitive evidence after detaching. Canvas refs
      // live only in this capped listener list, never in the report metadata.
      listeners.length=0;
      if(prototype.getContext===wrapper){
        try {
          if(descriptor)Object.defineProperty(prototype,'getContext',descriptor);
          else delete prototype.getContext;
          wrapperRestored=true;
        }catch(error){fault(error);}
      }
    },
  };
  host.__foundationContextProbe=api;
  return {installed:wrapped,limits:{...limits}};
}
