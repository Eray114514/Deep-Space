// Diagnostic ownership trace. Never installed by the game runtime.
export function traceRendererWrites(renderer) {
  const gl=renderer.getContext(),restore=[],groups=new Map();let depth=0;
  const summarize=value=>typeof value==='number'||typeof value==='string'||typeof value==='boolean'?value
    :value?.byteLength!==undefined?{bytes:value.byteLength}:value?.uuid?{uuid:value.uuid,name:value.name}:String(value);
  const wrap=(object,name,prefix)=>{
    const original=object[name];if(typeof original!=='function')return;
    object[name]=function(...args) {
      if(!depth) {
        const stack=new Error().stack.split('\n').slice(2,9).join('\n');
        const key=prefix+name+'\n'+stack;
        const group=groups.get(key)||{method:prefix+name,stack,count:0,firstArgs:args.slice(0,8).map(summarize),cpuMs:0};
        groups.set(key,group);group.count++;
        const started=performance.now();try {return original.apply(this,args);}
        finally {group.cpuMs+=performance.now()-started;}
      }
      return original.apply(this,args);
    };
    restore.push(()=>{object[name]=original;});
  };
  for(const name of ['render','compile','compileAsync','initTexture','setRenderTarget','setSize','setPixelRatio'])wrap(renderer,name,'renderer.');
  const names=new Set();let prototype=Object.getPrototypeOf(gl);
  while(prototype) {Object.getOwnPropertyNames(prototype).forEach(n=>names.add(n));prototype=Object.getPrototypeOf(prototype);}
  for(const name of names)if(/^(tex|compressedTex|copyTex|uniform|useProgram|bind|samplerParameter|activeTexture|viewport|scissor|pixelStore|draw|clear|colorMask|blend|depth|enable|disable)/.test(name))wrap(gl,name,'gl.');
  return {
    own(work) {depth++;try {return work();} finally {depth--; }},
    snapshot() {return [...groups.values()].sort((a,b)=>b.cpuMs-a.cpuMs);},
    dispose() {restore.reverse().forEach(fn=>fn());},
  };
}
